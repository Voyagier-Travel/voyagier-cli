/**
 * exec.ts seam — unit tests with an injected spawn fn (no real children).
 *
 * Covers the four outcomes the MCP layer relies on:
 *   1. success passthrough (exit 0, JSON stdout)
 *   2. non-zero exit → CLI error envelope passed through, isError:true
 *   3. timeout → SIGTERM (then SIGKILL) + synthetic TIMEOUT envelope
 *   4. non-JSON stdout on failure → synthetic API_ERROR wrap preserving raw text
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { runCli, toToolResult, type ExecFileFn, type CliResult } from "./exec.js";

/**
 * Build an injectable execFile stub. `behaviour` decides what the stub does
 * with the captured callback; the returned `kill` spy records signals.
 */
function makeExec(behaviour: {
  /** Invoke the callback immediately with these values (synchronous exit). */
  immediate?: { error: NodeJS.ErrnoException | null; stdout: string; stderr: string };
  /** If set, DON'T invoke the callback — capture it for later (timeout tests). */
  capture?: (cb: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void, kill: jest.Mock) => void;
}): { fn: ExecFileFn; kill: jest.Mock } {
  const kill = jest.fn(() => true);
  const fn: ExecFileFn = (_file, _args, _opts, cb) => {
    if (behaviour.immediate) {
      cb(behaviour.immediate.error, behaviour.immediate.stdout, behaviour.immediate.stderr);
    } else if (behaviour.capture) {
      behaviour.capture(cb, kill);
    }
    return { kill: kill as unknown as (signal?: NodeJS.Signals | number) => boolean };
  };
  return { fn, kill };
}

describe("runCli", () => {
  it("passes execPath + [cliEntry, ...args] to the spawn fn", async () => {
    const seen: { file: string; args: string[] } = { file: "", args: [] };
    const fn: ExecFileFn = (file, args, _opts, cb) => {
      seen.file = file;
      seen.args = args;
      cb(null, "{}", "");
      return { kill: () => true };
    };
    await runCli(["doctor", "--json"], 1000, { execFileFn: fn, cliEntry: "/x/index.js", execPath: "/usr/bin/node" });
    expect(seen.file).toBe("/usr/bin/node");
    expect(seen.args).toEqual(["/x/index.js", "doctor", "--json"]);
  });

  it("success: resolves stdout/stderr with exitCode 0", async () => {
    const { fn } = makeExec({ immediate: { error: null, stdout: '{"ok":true}', stderr: "" } });
    const res = await runCli(["doctor", "--json"], 1000, { execFileFn: fn, cliEntry: "e", execPath: "n" });
    expect(res).toEqual<CliResult>({ stdout: '{"ok":true}', stderr: "", exitCode: 0 });
  });

  it("non-zero exit: surfaces the numeric exit code", async () => {
    const err = Object.assign(new Error("Command failed"), { code: 1 });
    const { fn } = makeExec({ immediate: { error: err, stdout: '{"error":true,"code":"AUTH_FAILED","message":"nope"}', stderr: "" } });
    const res = await runCli(["whoami", "--json"], 1000, { execFileFn: fn, cliEntry: "e", execPath: "n" });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("AUTH_FAILED");
  });

  it("spawn failure with a string code (ENOENT) → generic exit 1", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { fn } = makeExec({ immediate: { error: err, stdout: "", stderr: "" } });
    const res = await runCli(["doctor"], 1000, { execFileFn: fn, cliEntry: "e", execPath: "n" });
    expect(res.exitCode).toBe(1);
  });
});

describe("runCli timeout", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("SIGTERM at timeout, SIGKILL after grace, resolves synthetic TIMEOUT envelope", async () => {
    let captured!: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;
    let killSpy!: jest.Mock;
    const { fn } = makeExec({
      capture: (cb, kill) => {
        captured = cb;
        killSpy = kill;
      },
    });

    const promise = runCli(["search", "flights", "--json"], 300_000, { execFileFn: fn, cliEntry: "e", execPath: "n" });

    // Trip the timeout → SIGTERM.
    jest.advanceTimersByTime(300_000);
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");

    // Child ignores SIGTERM → SIGKILL after 5s grace.
    jest.advanceTimersByTime(5000);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");

    // The child finally dies; the spawn fn fires its callback.
    captured(Object.assign(new Error("killed"), { signal: "SIGKILL", code: null }), "", "");

    const res = await promise;
    const parsed = JSON.parse(res.stdout) as { error: boolean; code: string; message: string };
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("TIMEOUT");
    expect(parsed.message).toContain("timed out after 300000ms");
    expect(res.exitCode).toBe(124);
  });
});

describe("toToolResult", () => {
  it("success passthrough: JSON stdout verbatim, isError false", () => {
    const r = toToolResult({ stdout: '{"ok":true}\n', stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('{"ok":true}\n');
  });

  it("success passthrough: plain-text (agent-docs markdown) verbatim", () => {
    const md = "# Voyagier CLI — Agent Reference\n\nhello\n";
    const r = toToolResult({ stdout: md, stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(md);
  });

  it("success with empty stdout falls back to stderr", () => {
    const r = toToolResult({ stdout: "", stderr: "note\n", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("note\n");
  });

  it("non-zero exit with JSON envelope: passed through verbatim, isError true", () => {
    const envelope = '{\n  "error": true,\n  "code": "PRICE_CHANGED",\n  "message": "drifted"\n}\n';
    const r = toToolResult({ stdout: envelope, stderr: "", exitCode: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(envelope);
  });

  it("non-zero exit with NON-JSON stdout: wrapped as synthetic API_ERROR preserving raw text", () => {
    const r = toToolResult({ stdout: "boom not json", stderr: "at foo (x.js:1)\n", exitCode: 2 });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.text) as { error: boolean; code: string; details: { exitCode: number; raw: string } };
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe("API_ERROR");
    expect(parsed.details.exitCode).toBe(2);
    expect(parsed.details.raw).toContain("boom not json");
    expect(parsed.details.raw).toContain("at foo");
  });

  it("timeout envelope (from runCli) round-trips through toToolResult as isError", () => {
    const timeoutStdout = JSON.stringify({ error: true, code: "TIMEOUT", message: "x timed out" });
    const r = toToolResult({ stdout: timeoutStdout, stderr: "", exitCode: 124 });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).code).toBe("TIMEOUT");
  });
});
