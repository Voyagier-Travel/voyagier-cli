import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CliError } from "../errors.js";

/**
 * `voyagier mcp install` spec (VOY-2043)
 * -------------------------------------
 * These configs belong to the user and usually contain other MCP servers, so
 * the merge behavior is the contract worth pinning: never clobber, never
 * overwrite something unparseable, never print the token. Every test runs
 * against a temp dir injected through the command's env provider — no spec may
 * resolve a real ~/.claude.json or ~/.cursor/mcp.json.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetToken = jest.fn<() => string>();
const mockJsonOutput = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getToken: mockGetToken,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

type ClientId = "claude-code" | "cursor" | "claude-desktop";
type Scope = "project" | "global";
interface InstallEnv {
  home: string;
  cwd: string;
  platform: string;
  appData?: string;
}

let mod: typeof import("./mcp-install.js");

beforeAll(async () => {
  mod = await import("./mcp-install.js");
});

// ── Harness ────────────────────────────────────────────────────────────────

const TOKEN = "voy_pat_abcdefghijkl9876";
const MASKED = "voy_…9876";

const tempDirs: string[] = [];
let env: InstallEnv;
let stdout: string[];
let stdoutSpy: jest.SpiedFunction<typeof console.log>;

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vgy-mcp-install-"));
  tempDirs.push(dir);
  return dir;
}

/** A program exposing only `mcp install`, rooted in the temp environment. */
function buildTestProgram(): Command {
  const program = new Command();
  program.exitOverride();
  const mcp = program.command("mcp");
  mcp.exitOverride();
  mod.registerMcpInstallCommand(mcp, () => env);
  program.commands.forEach((c) => c.commands.forEach((s) => s.exitOverride()));
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildTestProgram().parseAsync(["node", "voyagier", "mcp", "install", ...args]);
}

/** Run and return the CliError the action threw. */
async function runExpectingError(...args: string[]): Promise<CliError> {
  try {
    await run(...args);
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error("expected the command to throw a CliError");
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => {
  mockGetToken.mockReset();
  mockGetToken.mockReturnValue(TOKEN);
  mockJsonOutput.mockReset();
  const root = tempRoot();
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  env = { home, cwd, platform: "linux" };
  stdout = [];
  stdoutSpy = jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tempDirs.length = 0;
});

// ── Path resolution (pure) ─────────────────────────────────────────────────

describe("resolveConfigPath", () => {
  const base: InstallEnv = { home: "/h", cwd: "/w", platform: "linux" };

  it("resolves the claude-code scopes", () => {
    expect(mod.resolveConfigPath("claude-code", "project", base)).toBe("/w/.mcp.json");
    expect(mod.resolveConfigPath("claude-code", "global", base)).toBe("/h/.claude.json");
  });

  it("resolves the cursor scopes", () => {
    expect(mod.resolveConfigPath("cursor", "global", base)).toBe("/h/.cursor/mcp.json");
    expect(mod.resolveConfigPath("cursor", "project", base)).toBe("/w/.cursor/mcp.json");
  });

  it("resolves claude-desktop per platform", () => {
    expect(mod.resolveConfigPath("claude-desktop", "global", { ...base, platform: "darwin" })).toBe(
      "/h/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(mod.resolveConfigPath("claude-desktop", "global", base)).toBe(
      "/h/.config/Claude/claude_desktop_config.json",
    );
  });

  it("prefers %APPDATA% on Windows and falls back to the roaming default", () => {
    const withAppData = { ...base, platform: "win32", appData: "C:\\Users\\x\\AppData\\Roaming" };
    expect(mod.resolveConfigPath("claude-desktop", "global", withAppData)).toContain(
      "C:\\Users\\x\\AppData\\Roaming",
    );
    expect(mod.resolveConfigPath("claude-desktop", "global", { ...base, platform: "win32" })).toBe(
      "/h/AppData/Roaming/Claude/claude_desktop_config.json",
    );
  });

  it("defaults claude-code to project scope and the others to global", () => {
    expect(mod.defaultScope("claude-code")).toBe<Scope>("project");
    expect(mod.defaultScope("cursor")).toBe<Scope>("global");
    expect(mod.defaultScope("claude-desktop")).toBe<Scope>("global");
  });
});

// ── Entry shapes ───────────────────────────────────────────────────────────

describe("buildServerEntry", () => {
  it("gives claude-code an http entry with the type label", () => {
    expect(mod.buildServerEntry("claude-code", "T")).toEqual({
      type: "http",
      url: "https://mcp.voyagier.com/api/mcp",
      headers: { Authorization: "Bearer T" },
    });
  });

  it("gives cursor the same http entry without the type field", () => {
    expect(mod.buildServerEntry("cursor", "T")).toEqual({
      url: "https://mcp.voyagier.com/api/mcp",
      headers: { Authorization: "Bearer T" },
    });
  });

  it("gives claude-desktop the stdio bridge, since its config format has no http transport", () => {
    expect(mod.buildServerEntry("claude-desktop", "T")).toEqual({
      command: "npx",
      args: ["-y", "@voyagier/cli", "mcp"],
      env: { VOYAGIER_TOKEN: "T" },
    });
  });
});

describe("maskToken", () => {
  it("keeps the prefix and last four characters", () => {
    expect(mod.maskToken(TOKEN)).toBe(MASKED);
  });

  it("reveals nothing about a token too short to mask usefully", () => {
    expect(mod.maskToken("short")).toBe("…");
  });
});

// ── Merge semantics (pure) ─────────────────────────────────────────────────

describe("mergeServerEntry", () => {
  it("creates the mcpServers map when the file does not exist", () => {
    const { config, replaced } = mod.mergeServerEntry(null, { url: "u" }, "/p");
    expect(config).toEqual({ mcpServers: { voyagier: { url: "u" } } });
    expect(replaced).toBe(false);
  });

  it("treats an empty file as an empty document rather than corruption", () => {
    expect(mod.mergeServerEntry("   \n", { url: "u" }, "/p").config).toEqual({
      mcpServers: { voyagier: { url: "u" } },
    });
  });

  it("reports replaced=true when a voyagier entry was already present", () => {
    const raw = JSON.stringify({ mcpServers: { voyagier: { url: "old" } } });
    const { config, replaced } = mod.mergeServerEntry(raw, { url: "new" }, "/p");
    expect(replaced).toBe(true);
    expect(config.mcpServers).toEqual({ voyagier: { url: "new" } });
  });

  it("aborts on unparseable JSON instead of overwriting it", () => {
    expect(() => mod.mergeServerEntry("{ not json", { url: "u" }, "/p")).toThrow(CliError);
    try {
      mod.mergeServerEntry("{ not json", { url: "u" }, "/p");
    } catch (err) {
      expect((err as CliError).code).toBe("STATE_CORRUPT");
      expect((err as CliError).message).toContain("Nothing was written");
    }
  });

  it("aborts when the document is not an object", () => {
    expect(() => mod.mergeServerEntry("[1,2]", { url: "u" }, "/p")).toThrow(/top level/);
  });

  it("aborts when mcpServers is the wrong type", () => {
    expect(() => mod.mergeServerEntry('{"mcpServers": "nope"}', { url: "u" }, "/p")).toThrow(
      /not a JSON object/,
    );
  });
});

describe("detectIndent", () => {
  it("defaults to two spaces for a new file", () => {
    expect(mod.detectIndent(null)).toBe(2);
  });

  it("reuses the existing indentation so a merge does not reformat the file", () => {
    expect(mod.detectIndent('{\n    "a": 1\n}')).toBe("    ");
    expect(mod.detectIndent('{\n\t"a": 1\n}')).toBe("\t");
  });

  it("keeps a compact document compact", () => {
    // ~/.claude.json is normally one long line; pretty-printing it would
    // rewrite a large file for no semantic gain.
    expect(mod.detectIndent('{"mcpServers":{}}')).toBe(0);
  });
});

// ── End-to-end writes ──────────────────────────────────────────────────────

describe("mcp install — fresh file creation", () => {
  it("creates ./.mcp.json for claude-code by default", async () => {
    await run("claude-code");
    const path = join(env.cwd, ".mcp.json");
    expect(readJson(path)).toEqual({
      mcpServers: {
        voyagier: {
          type: "http",
          url: "https://mcp.voyagier.com/api/mcp",
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
  });

  it("creates ~/.claude.json for claude-code --global", async () => {
    await run("claude-code", "--global");
    expect(existsSync(join(env.home, ".claude.json"))).toBe(true);
    expect(existsSync(join(env.cwd, ".mcp.json"))).toBe(false);
  });

  it("creates ~/.cursor/mcp.json for cursor by default, making the directory", async () => {
    await run("cursor");
    const config = readJson(join(env.home, ".cursor", "mcp.json"));
    expect(config.mcpServers.voyagier).toEqual({
      url: "https://mcp.voyagier.com/api/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it("creates ./.cursor/mcp.json for cursor --project", async () => {
    await run("cursor", "--project");
    expect(existsSync(join(env.cwd, ".cursor", "mcp.json"))).toBe(true);
  });

  it("creates the platform config for claude-desktop with the token in env", async () => {
    await run("claude-desktop");
    const config = readJson(join(env.home, ".config", "Claude", "claude_desktop_config.json"));
    expect(config.mcpServers.voyagier).toEqual({
      command: "npx",
      args: ["-y", "@voyagier/cli", "mcp"],
      env: { VOYAGIER_TOKEN: TOKEN },
    });
  });

  it("mentions the in-app remote connector route for claude-desktop", async () => {
    await run("claude-desktop");
    expect(stdout.join("\n")).toMatch(/remote connectors/i);
  });
});

describe("mcp install — merging into an existing config", () => {
  it("preserves other servers and unrelated top-level keys", async () => {
    const path = join(env.cwd, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          someOtherKey: { keep: "me" },
          mcpServers: {
            other: { command: "node", args: ["other.js"] },
          },
        },
        null,
        2,
      ),
    );

    await run("claude-code");

    const config = readJson(path);
    expect(config.someOtherKey).toEqual({ keep: "me" });
    expect(config.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(config.mcpServers.voyagier.url).toBe("https://mcp.voyagier.com/api/mcp");
  });

  it("updates an existing voyagier entry in place and says so", async () => {
    const path = join(env.home, ".cursor", "mcp.json");
    mkdirSync(join(env.home, ".cursor"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { voyagier: { url: "https://old" } } }));

    await run("cursor");

    expect(readJson(path).mcpServers.voyagier.url).toBe("https://mcp.voyagier.com/api/mcp");
    expect(stdout.join("\n")).toContain("Updated");
  });

  it("aborts without touching a corrupt file", async () => {
    const path = join(env.cwd, ".mcp.json");
    const corrupt = '{ "mcpServers": { "other": ';
    writeFileSync(path, corrupt);

    const err = await runExpectingError("claude-code");

    expect(err.code).toBe("STATE_CORRUPT");
    expect(err.message).toContain(path);
    // The original bytes survive — we never overwrite what we could not read.
    expect(readFileSync(path, "utf-8")).toBe(corrupt);
  });
});

describe("mcp install — dry run", () => {
  it("writes nothing and prints the path plus the masked entry", async () => {
    await run("claude-code", "--dry-run");

    expect(existsSync(join(env.cwd, ".mcp.json"))).toBe(false);
    const out = stdout.join("\n");
    expect(out).toContain(join(env.cwd, ".mcp.json"));
    expect(out).toContain("https://mcp.voyagier.com/api/mcp");
    expect(out).toContain(MASKED);
    expect(out).not.toContain(TOKEN);
  });

  it("leaves an existing file byte-identical", async () => {
    const path = join(env.cwd, ".mcp.json");
    const before = JSON.stringify({ mcpServers: { other: { url: "https://x" } } }, null, 4);
    writeFileSync(path, before);

    await run("claude-code", "--dry-run");

    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("reports action \"none\" under --json", async () => {
    await run("cursor", "--dry-run", "--json");
    const payload = mockJsonOutput.mock.calls[0]![0] as any;
    expect(payload.data.dryRun).toBe(true);
    expect(payload.data.action).toBe("none");
    expect(existsSync(join(env.home, ".cursor", "mcp.json"))).toBe(false);
  });
});

describe("mcp install — token handling", () => {
  it("uses --token in preference to the stored credential", async () => {
    await run("claude-code", "--token", "voy_pat_overridden0000");
    const config = readJson(join(env.cwd, ".mcp.json"));
    expect(config.mcpServers.voyagier.headers.Authorization).toBe("Bearer voy_pat_overridden0000");
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("points at the auth commands when no token is available", async () => {
    mockGetToken.mockImplementation(() => {
      throw new CliError("AUTH_FAILED" as any, "Not authenticated.");
    });

    const err = await runExpectingError("claude-code");

    expect(err.code).toBe("AUTH_FAILED");
    expect(err.message).toMatch(/voyagier login/);
    expect(err.message).toMatch(/auth set-token/);
    expect(existsSync(join(env.cwd, ".mcp.json"))).toBe(false);
  });

  it("rejects an empty --token", async () => {
    const err = await runExpectingError("claude-code", "--token", "   ");
    expect(err.code).toBe("VALIDATION");
  });

  it("never prints the token on the success path", async () => {
    await run("claude-code");
    const out = stdout.join("\n");
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(MASKED);
  });

  it("masks the token in the --json envelope while writing the real one to disk", async () => {
    await run("claude-code", "--json");

    const payload = mockJsonOutput.mock.calls[0]![0] as any;
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({
      client: "claude-code",
      scope: "project",
      serverKey: "voyagier",
      action: "added",
      dryRun: false,
    });
    expect(payload.data.token).toBe(MASKED);
    expect(payload.data.entry.headers.Authorization).toBe(`Bearer ${MASKED}`);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(payload.data.restart).toMatch(/Restart Claude Code/);

    // The real token still landed in the file.
    const config = readJson(join(env.cwd, ".mcp.json"));
    expect(config.mcpServers.voyagier.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("mcp install — argument validation", () => {
  it("rejects an unknown client", async () => {
    const err = await runExpectingError("emacs");
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toContain("claude-code");
  });

  it("accepts a client name in mixed case", async () => {
    await run("Cursor");
    expect(existsSync(join(env.home, ".cursor", "mcp.json"))).toBe(true);
  });

  it("rejects --global together with --project", async () => {
    const err = await runExpectingError("cursor", "--global", "--project");
    expect(err.code).toBe("VALIDATION");
  });

  it("rejects --project for claude-desktop, which has one config file", async () => {
    const err = await runExpectingError("claude-desktop", "--project");
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toMatch(/--project does not apply/);
  });

  it("resolveScope honors the per-client defaults", () => {
    expect(mod.resolveScope("claude-code", {})).toBe<Scope>("project");
    expect(mod.resolveScope("claude-code", { global: true })).toBe<Scope>("global");
    expect(mod.resolveScope("cursor", {})).toBe<Scope>("global");
    expect(mod.resolveScope("cursor", { project: true })).toBe<Scope>("project");
  });

  it("parseClientId normalizes and validates", () => {
    expect(mod.parseClientId("  CLAUDE-DESKTOP ")).toBe<ClientId>("claude-desktop");
    expect(() => mod.parseClientId("vim")).toThrow(CliError);
  });
});

describe("mcp install — file handling details", () => {
  it("creates new files owner-readable only, since they carry a token", async () => {
    await run("cursor");
    const { statSync } = await import("fs");
    const mode = statSync(join(env.home, ".cursor", "mcp.json")).mode & 0o777;
    // Windows does not model POSIX permission bits; assert only where it does.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("does not pretty-print a compact existing file", async () => {
    const path = join(env.home, ".claude.json");
    writeFileSync(path, '{"numStartups":7,"mcpServers":{"other":{"url":"https://x"}}}');

    await run("claude-code", "--global");

    const raw = readFileSync(path, "utf-8");
    expect(raw.trimEnd().includes("\n")).toBe(false);
    const config = readJson(path);
    expect(config.numStartups).toBe(7);
    expect(config.mcpServers.other).toEqual({ url: "https://x" });
    expect(config.mcpServers.voyagier.type).toBe("http");
  });

  it("keeps the indentation of an existing file", async () => {
    const path = join(env.cwd, ".mcp.json");
    writeFileSync(path, '{\n    "mcpServers": {}\n}\n');
    await run("claude-code");
    expect(readFileSync(path, "utf-8")).toContain('\n    "mcpServers"');
  });

  it("warns that a project-scope file carries a token", async () => {
    await run("claude-code");
    expect(stdout.join("\n")).toMatch(/out of version control/i);
  });
});
