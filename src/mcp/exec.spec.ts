/**
 * exec.ts seam — unit tests with an injected spawn fn (no real children).
 *
 * Covers runCli's spawn/timeout behaviour AND toToolResult's normalisation of
 * BOTH CLI payload styles into the one canonical `{ok,data}` / `{ok:false,error}`
 * MCP envelope (Style A passthrough, Style B wrap, error mapping, TIMEOUT,
 * non-JSON success/failure, isError correlation).
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

describe("toToolResult — canonical envelope normalisation", () => {
  interface OkText {
    ok: boolean;
    data?: unknown;
    planContext?: unknown;
    error?: { code: string; message: string; details?: unknown };
  }
  const parse = (r: { text: string }) => JSON.parse(r.text) as OkText;

  // ── Style A: already-canonical `{ok,data,planContext}` → field-for-field ──
  it("Style A passthrough: preserves ok/data/planContext, isError false", () => {
    const cli = { ok: true, data: { overall: "PASS" }, planContext: { planId: "P1", title: "Rome" } };
    const r = toToolResult({ stdout: JSON.stringify(cli, null, 2) + "\n", stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(parse(r)).toEqual(cli);
  });

  // ── Style B flat → lossless `{ok:true, data:<parsed>}` wrap ──
  it("Style B wrap: clients-list flat shape nested under data, nothing stripped", () => {
    const cli = { clients: [{ id: "c1", name: "Al" }], total: 12 };
    const r = toToolResult({ stdout: JSON.stringify(cli), stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    const env = parse(r);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual(cli);
  });

  it("Style B wrap: select flat-with-ok (no data key) is wrapped WHOLE, inner ok preserved", () => {
    const cli = { ok: true, success: true, type: "option_selected", selectionId: "s1" };
    const r = toToolResult({ stdout: JSON.stringify(cli), stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    const env = parse(r);
    expect(env.ok).toBe(true);
    // The CLI's own `ok:true` is nested, never mistaken for the canonical wrapper.
    expect(env.data).toEqual(cli);
  });

  // ── CLI error envelope → canonical failure ──
  it("error mapping without details: {error,code,message} → {ok:false,error:{code,message}}", () => {
    const cli = { error: true, code: "PRICE_CHANGED", message: "drifted" };
    const r = toToolResult({ stdout: JSON.stringify(cli, null, 2) + "\n", stderr: "", exitCode: 1 });
    expect(r.isError).toBe(true);
    const env = parse(r);
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({ code: "PRICE_CHANGED", message: "drifted" });
    expect(env.error && "details" in env.error).toBe(false);
  });

  it("error mapping with details: details carried through only when present", () => {
    const cli = { error: true, code: "BOOKING_BLOCKED", message: "blocked", details: { blockers: ["passport"] } };
    const r = toToolResult({ stdout: JSON.stringify(cli), stderr: "", exitCode: 1 });
    expect(r.isError).toBe(true);
    const env = parse(r);
    expect(env.error).toEqual({ code: "BOOKING_BLOCKED", message: "blocked", details: { blockers: ["passport"] } });
  });

  it("TIMEOUT envelope (synthetic, from runCli) maps to canonical failure", () => {
    const cli = { error: true, code: "TIMEOUT", message: "voyagier search flights timed out after 300000ms" };
    const r = toToolResult({ stdout: JSON.stringify(cli), stderr: "", exitCode: 124 });
    expect(r.isError).toBe(true);
    const env = parse(r);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("TIMEOUT");
  });

  // ── Non-JSON stdout ──
  it("non-JSON success (agent-docs markdown): wrapped as data.content, isError false", () => {
    const md = "# Voyagier CLI — Agent Reference\n\nhello\n";
    const r = toToolResult({ stdout: md, stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    const env = parse(r);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ content: md });
  });

  it("non-JSON failure: {ok:false,error:{code:UNKNOWN,message:<stdout>}}, isError true", () => {
    const r = toToolResult({ stdout: "boom not json\n", stderr: "at foo (x.js:1)\n", exitCode: 2 });
    expect(r.isError).toBe(true);
    const env = parse(r);
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({ code: "UNKNOWN", message: "boom not json", details: { stderr: "at foo (x.js:1)" } });
  });

  it("non-JSON failure with empty stdout falls back to stderr, then to 'command failed'", () => {
    const onStderr = toToolResult({ stdout: "", stderr: "stack trace\n", exitCode: 2 });
    expect(parse(onStderr).error?.message).toBe("stack trace");
    const empty = toToolResult({ stdout: "", stderr: "", exitCode: 2 });
    expect(parse(empty).error?.message).toBe("command failed");
  });

  // ── isError correlation: true exactly when ok:false ──
  // ── Style A with ok:false (doctor overall-FAIL) → the ONE failure shape ──
  it("Style A ok:false (doctor FAIL): folded into {ok:false,error} — report lossless in details, isError TRUE", () => {
    const report = { overall: "FAIL", checks: [{ name: "auth", status: "FAIL" }] };
    const r = toToolResult({ stdout: JSON.stringify({ ok: false, data: report }), stderr: "", exitCode: 1 });
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({
      ok: false,
      error: { code: "COMMAND_FAILED", message: "Command reported failure.", details: report },
    });
  });

  it("empty stdout with exit 0 → {ok:true, data:{content:\"\"}}", () => {
    const r = toToolResult({ stdout: "", stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(parse(r)).toEqual({ ok: true, data: { content: "" } });
  });

  it("empty stdout with exit 0 but stderr present → stderr becomes the content (diagnostics kept)", () => {
    const r = toToolResult({ stdout: "", stderr: "wrote 3 warnings\n", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(parse(r)).toEqual({ ok: true, data: { content: "wrote 3 warnings\n" } });
  });

  it("JSON array stdout → lossless wrap under data", () => {
    const r = toToolResult({ stdout: '[{"id":1},{"id":2}]', stderr: "", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(parse(r)).toEqual({ ok: true, data: [{ id: 1 }, { id: 2 }] });
  });

  it("JSON scalar stdout (null / number / string) → treated as text content", () => {
    for (const raw of ["null", "42", '"hi"']) {
      const r = toToolResult({ stdout: raw, stderr: "", exitCode: 0 });
      expect(r.isError).toBe(false);
      expect(parse(r)).toEqual({ ok: true, data: { content: raw } });
    }
  });

  it("non-JSON failure keeps stderr as error.details.stderr when message came from stdout", () => {
    const r = toToolResult({ stdout: "boom", stderr: "stack trace here", exitCode: 2 });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toEqual({ code: "UNKNOWN", message: "boom", details: { stderr: "stack trace here" } });
  });

  it("isError is true exactly when the envelope is ok:false", () => {
    const cases: CliResult[] = [
      { stdout: '{"ok":true,"data":{}}', stderr: "", exitCode: 0 },
      { stdout: '{"ok":false,"data":{"overall":"FAIL"}}', stderr: "", exitCode: 1 }, // folded → ok:false error shape
      { stdout: '{"clients":[]}', stderr: "", exitCode: 0 },
      { stdout: "plain markdown", stderr: "", exitCode: 0 },
      { stdout: '{"error":true,"code":"X","message":"y"}', stderr: "", exitCode: 1 },
      { stdout: "boom", stderr: "", exitCode: 2 },
    ];
    for (const c of cases) {
      const r = toToolResult(c);
      expect(r.isError).toBe(!parse(r).ok);
    }
  });

  it("output text is compact (no pretty-print newlines/indentation)", () => {
    const r = toToolResult({ stdout: JSON.stringify({ ok: true, data: { a: 1 } }, null, 2), stderr: "", exitCode: 0 });
    expect(r.text).toBe('{"ok":true,"data":{"a":1}}');
  });
});
