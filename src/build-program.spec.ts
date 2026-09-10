import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { argvRequestsJson, buildProgram } from "./build-program.js";
import type { McpToolDescriptor } from "./mcp-client/client.js";
import { REMOVED_COMMANDS } from "./removed-commands.js";

/**
 * Argument-parse error contract (VOY-1829)
 * ----------------------------------------
 * Commander's own parse failures (unknown option, missing required
 * option/argument, invalid argument value) used to always print a bare
 * `error: ...` line to stderr and exit 1 — even under --json, breaking the
 * uniform JSON error envelope that agents parse off stdout.
 *
 * buildProgram routes those failures through { error, code: "VALIDATION",
 * message } on stdout WHEN --json is in argv, while leaving the non-json path,
 * help, and version output byte-identical. These tests pin all four cases on
 * the GENERATED command surface (one command per MCP tool, built from the
 * checked-in tools/list fixture).
 *
 * The real program has no exitOverride (production lets Commander call
 * process.exit). Here we recursively apply exitOverride so parse errors throw a
 * CommanderError instead of exiting the jest worker — that also asserts the
 * exit-code intent (err.exitCode) and that CommanderError propagation still
 * works after the outputError override.
 */

const FIXTURE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("./mcp/fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as McpToolDescriptor[];

let stdout: string[];
let stderr: string[];
let stdoutSpy: jest.SpiedFunction<typeof process.stdout.write>;
let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

/** Give the whole command tree exitOverride so nothing calls process.exit. */
function withExitOverride(cmd: Command): Command {
  cmd.exitOverride();
  cmd.commands.forEach((sub) => withExitOverride(sub));
  return cmd;
}

async function parse(args: string[]): Promise<{ code?: string; exitCode?: number; message?: string }> {
  const program = withExitOverride(buildProgram("0.0.0-test", FIXTURE_TOOLS));
  // --json is detected by scanning process.argv (options aren't parsed yet when
  // the parser errors), so the harness must reflect the real argv here, exactly
  // as the production entrypoint sees it.
  const savedArgv = process.argv;
  process.argv = ["node", "voyagier", ...args];
  try {
    await program.parseAsync(process.argv);
    return {};
  } catch (err) {
    const e = err as { code?: string; exitCode?: number; message?: string };
    return { code: e.code, exitCode: e.exitCode, message: e.message };
  } finally {
    process.argv = savedArgv;
  }
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe("command surface", () => {
  it("registers one visible command per fixture tool plus the local commands", () => {
    const program = buildProgram("0.0.0-test", FIXTURE_TOOLS);
    const visible = program.commands
      .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
      .map((c) => c.name());
    for (const tool of FIXTURE_TOOLS) expect(visible).toContain(tool.name);
    for (const local of ["auth", "doctor", "agent-docs", "telemetry", "mcp"]) expect(visible).toContain(local);
    // No generated command shadows a local one.
    expect(new Set(visible).size).toBe(visible.length);
  });

  it("registers a hidden stub for every removed 3.x top-level command word that is not a live tool", () => {
    const program = buildProgram("0.0.0-test", FIXTURE_TOOLS);
    const live = new Set(FIXTURE_TOOLS.map((t) => t.name));
    const hidden = new Set(
      program.commands.filter((c) => (c as unknown as { _hidden?: boolean })._hidden).map((c) => c.name()),
    );
    for (const entry of REMOVED_COMMANDS) {
      const word = entry.command.split(" ")[0];
      if (live.has(word)) continue; // e.g. `quote`, `book`, `itinerary` — same name, now a tool
      expect(hidden.has(word)).toBe(true);
    }
  });

  it("uses the tool's title as the command summary and its description as the help body", () => {
    const program = buildProgram("0.0.0-test", FIXTURE_TOOLS);
    const cmd = program.commands.find((c) => c.name() === "plans_list")!;
    expect(cmd.summary()).toBe("List trip plans");
    expect(cmd.description()).toContain("plan-discovery entry point");
  });
});

describe("argument-parse errors under --json", () => {
  it("emits a VALIDATION envelope on stdout and exits 1 for an unknown option", async () => {
    const { code, exitCode } = await parse(["plan_status", "--plan_id", "p1", "--nope", "--json"]);

    // CommanderError still propagates (exitOverride path), exit code 1.
    expect(code).toBe("commander.unknownOption");
    expect(exitCode).toBe(1);

    // JSON envelope on stdout, nothing on stderr.
    expect(stderr.join("")).toBe("");
    const payload = JSON.parse(stdout.join(""));
    expect(payload).toMatchObject({ error: true, code: "VALIDATION" });
    expect(payload.message).toContain("unknown option");
    expect(payload.message).toContain("--nope");
  });

  it("emits a VALIDATION envelope for a missing required option", async () => {
    // `plan_status` requires --plan_id (from the tool's inputSchema.required).
    const { exitCode } = await parse(["plan_status", "--json"]);
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toBe("");
    const payload = JSON.parse(stdout.join(""));
    expect(payload).toMatchObject({ error: true, code: "VALIDATION" });
    expect(payload.message).toMatch(/required option/i);
    expect(payload.message).toContain("--plan_id");
  });

  it("emits a VALIDATION envelope for an invalid typed value", async () => {
    const { code, exitCode } = await parse(["plans_list", "--limit", "abc", "--json"]);
    expect(code).toBe("commander.invalidArgument");
    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdout.join(""));
    expect(payload).toMatchObject({ error: true, code: "VALIDATION" });
    expect(payload.message).toMatch(/integer/);
  });
});

describe("argument-parse errors without --json (byte-identical to before)", () => {
  it("writes bare error text to stderr and no JSON to stdout", async () => {
    const { code, exitCode } = await parse(["plan_status", "--plan_id", "p1", "--nope"]);

    expect(code).toBe("commander.unknownOption");
    expect(exitCode).toBe(1);

    // Bare commander text on stderr; stdout untouched (no JSON envelope).
    expect(stderr.join("")).toContain("unknown option");
    expect(stderr.join("")).toContain("--nope");
    expect(stdout.join("")).toBe("");
  });

  it("treats `--json` after a bare `--` as a positional, not the output flag", async () => {
    // Everything after the lone `--` is a positional value, so this `--json`
    // is data — the parse failure must take the TEXT path (stderr), NOT emit a
    // JSON envelope. Guards the argv scan against matching past the terminator.
    const { code, exitCode } = await parse(["plan_status", "--plan_id", "p1", "--nope", "--", "--json"]);

    expect(code).toBe("commander.unknownOption");
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("unknown option");
    expect(stdout.join("")).toBe("");
  });
});

describe("removed 3.x commands", () => {
  it("exit non-zero with the replacement tool (COMMAND_REMOVED)", async () => {
    const { code, message } = await parse(["plans", "list", "--active", "--json"]);
    expect(code).toBe("COMMAND_REMOVED");
    expect(message).toContain("This command was removed in 4.0.");
    expect(message).toContain("voyagier plans_list [flags]");
  });

  it("name the planned tool when the server does not publish it yet", async () => {
    const { code, message } = await parse(["whoami"]);
    expect(code).toBe("COMMAND_REMOVED");
    expect(message).toContain("voyagier whoami");
    expect(message).toMatch(/not yet published/);
  });

  it("say so when there is no replacement tool", async () => {
    const { code, message } = await parse(["places", "search", "--query", "x"]);
    expect(code).toBe("COMMAND_REMOVED");
    expect(message).toContain("There is no MCP tool for it.");
  });
});

describe("help and version are unaffected", () => {
  it("--help renders usage to stdout, exit 0, no error envelope", async () => {
    const { exitCode } = await parse(["--help"]);
    expect(exitCode).toBe(0);
    const all = stdout.join("") + stderr.join("");
    expect(all).toContain("Usage:");
    expect(all).toContain("plans_list");
    expect(all).not.toContain('"error": true');
  });

  it("--help with --json in argv is still help, not a JSON error", async () => {
    const { exitCode } = await parse(["search_hotels", "--help", "--json"]);
    expect(exitCode).toBe(0);
    const all = stdout.join("") + stderr.join("");
    expect(all).toContain("--checkin");
    expect(all).not.toContain('"error": true');
    expect(all).not.toContain('"code": "VALIDATION"');
  });

  it("--version writes the version and exits 0, even alongside --json", async () => {
    const { exitCode } = await parse(["--version", "--json"]);
    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("0.0.0-test");
    expect(stdout.join("")).not.toContain('"error": true');
  });
});

describe("argvRequestsJson (shared by parse-error and CliError paths)", () => {
  // src/index.ts uses this same helper for its top-level CliError handler, so
  // these cases pin JSON-mode detection for ALL error paths at once.
  it("detects --json as an option token", () => {
    expect(argvRequestsJson(["node", "voyagier", "plans_list", "--json"])).toBe(true);
  });

  it("ignores --json after a bare -- terminator (positional data)", () => {
    expect(argvRequestsJson(["node", "voyagier", "share_plan", "--", "--json"])).toBe(false);
  });

  it("detects --json before a terminator even when more args follow it", () => {
    expect(argvRequestsJson(["node", "voyagier", "share_plan", "--json", "--", "--json"])).toBe(true);
  });

  it("is false when --json is absent", () => {
    expect(argvRequestsJson(["node", "voyagier", "plans_list"])).toBe(false);
  });
});
