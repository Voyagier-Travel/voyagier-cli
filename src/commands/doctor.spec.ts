import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockCredentialsExist = jest.fn();
const mockGetUserContext = jest.fn();
const mockGetApiUrl = jest.fn().mockReturnValue("https://dev.voyagier.com/api");
const mockJsonOutput = jest.fn();
const mockFetch = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "AuthError";
    }
  },
}));

jest.unstable_mockModule("../config.js", () => ({
  credentialsExist: mockCredentialsExist,
  getApiUrl: mockGetApiUrl,
  getUserContext: mockGetUserContext,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerDoctorCommand: (program: Command, version: string) => void;
let rollUpStatus: (checks: { status: "PASS" | "WARN" | "FAIL" }[]) => "PASS" | "WARN" | "FAIL";

beforeAll(async () => {
  const mod = await import("./doctor.js");
  registerDoctorCommand = mod.registerDoctorCommand;
  rollUpStatus = mod.rollUpStatus;
});

// ── Helpers ────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerDoctorCommand(p, "1.8.1");
  return p;
}

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let exitSpy: jest.SpiedFunction<typeof process.exit>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockGraphql.mockReset();
  mockCredentialsExist.mockReset();
  mockGetUserContext.mockReset();
  mockJsonOutput.mockReset();
  mockFetch.mockReset();
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = jest.spyOn(process, "exit").mockImplementation(((_code?: number) => {
    return undefined as never;
  }) as typeof process.exit);
  // Stub the state dir to an empty temp dir so checkStateFiles() never reads the real ~/.voyagier/.
  // Individual tests that exercise state-files behavior override this via `setStateDir(...)`.
  setStateDir(mkdtempSync(join(tmpdir(), "vd-empty-")));
  // Default: fetch returns a basic OK for reachability + a recent-version response.
  // Each test that needs different fetch behavior calls mockFetch.mockImplementation directly.
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "1.8.1" }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: { __typename: "Query" } }),
    } as unknown as Response;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
  globalThis.fetch = originalFetch;
  // Cleanup temp state dirs created during the test.
  for (const dir of stateDirsCreated) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  stateDirsCreated.length = 0;
  delete process.env.VOYAGIER_STATE_DIR;
});

// ── State-dir helpers ──────────────────────────────────────────────────────

const stateDirsCreated: string[] = [];
function setStateDir(dir: string): string {
  process.env.VOYAGIER_STATE_DIR = dir;
  stateDirsCreated.push(dir);
  return dir;
}
function makeStateDir(payloads: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "vd-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(payloads)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return setStateDir(dir);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("rollUpStatus", () => {
  it("returns PASS when all checks pass", () => {
    expect(rollUpStatus([{ status: "PASS" }, { status: "PASS" }])).toBe("PASS");
  });
  it("returns WARN when any check warns and none fail", () => {
    expect(rollUpStatus([{ status: "PASS" }, { status: "WARN" }])).toBe("WARN");
  });
  it("returns FAIL when any check fails (overrides WARN)", () => {
    expect(rollUpStatus([{ status: "WARN" }, { status: "FAIL" }])).toBe("FAIL");
  });
});

describe("voyagier doctor", () => {
  it("reports PASS when everything is healthy", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    mockGraphql.mockResolvedValue({ __schema: { queryType: { name: "Query" } } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledTimes(1);
    const reported = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { overall: string; checks: Array<{ name: string; status: string }> };
    };
    expect(reported.ok).toBe(true);
    expect(reported.data.overall).toBe("PASS");
    expect(reported.data.checks.find((c) => c.name === "auth")?.status).toBe("PASS");
    expect(reported.data.checks.find((c) => c.name === "version")?.status).toBe("PASS");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports FAIL when no credentials exist", async () => {
    mockCredentialsExist.mockReturnValue(false);

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    const reported = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { overall: string; checks: Array<{ name: string; status: string; message: string }> };
    };
    expect(reported.ok).toBe(false);
    expect(reported.data.overall).toBe("FAIL");
    const auth = reported.data.checks.find((c) => c.name === "auth");
    expect(auth?.status).toBe("FAIL");
    expect(auth?.message).toMatch(/auth login|set-token/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports FAIL when token is rejected", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGraphql.mockRejectedValue(new CliError(CliErrorCode.AUTH_FAILED, "401 Unauthorized"));

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    const reported = mockJsonOutput.mock.calls[0][0] as {
      data: { overall: string; checks: Array<{ name: string; status: string }> };
    };
    expect(reported.data.overall).toBe("FAIL");
    expect(reported.data.checks.find((c) => c.name === "auth")?.status).toBe("FAIL");
  });

  it("reports WARN when version is outdated", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    mockGraphql.mockResolvedValue({ __schema: { queryType: { name: "Query" } } });
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: "2.0.0" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: {} }),
      } as unknown as Response;
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    const reported = mockJsonOutput.mock.calls[0][0] as {
      data: { overall: string; checks: Array<{ name: string; status: string; message: string }> };
    };
    expect(reported.data.overall).toBe("WARN");
    const version = reported.data.checks.find((c) => c.name === "version");
    expect(version?.status).toBe("WARN");
    expect(version?.message).toMatch(/2\.0\.0/);
  });

  it("flags schema drift when a probe query reports an unknown field", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    // First call: doctor ping (auth check). Subsequent: schema probes.
    mockGraphql
      .mockResolvedValueOnce({ __schema: { queryType: { name: "Query" } } }) // auth ping
      .mockRejectedValueOnce(new Error("Cannot query field \"tripPlanClients\" on type \"Query\".")) // probe 1
      .mockResolvedValueOnce({ tripPlans: { count: 0 } }); // probe 2

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    const reported = mockJsonOutput.mock.calls[0][0] as {
      data: { overall: string; checks: Array<{ name: string; status: string; details?: unknown }> };
    };
    const schema = reported.data.checks.find((c) => c.name === "schema");
    expect(schema?.status).toBe("FAIL");
    expect(reported.data.overall).toBe("FAIL");
  });

  it("warns but doesn't fail when version registry is unreachable", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    mockGraphql.mockResolvedValue({ __schema: { queryType: { name: "Query" } } });
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org")) {
        throw new Error("network timeout");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: {} }),
      } as unknown as Response;
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    const reported = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { overall: string };
    };
    // Version warn shouldn't fail the report
    expect(reported.ok).toBe(true);
    expect(reported.data.overall).toBe("WARN");
  });
});

// ── state-files branch coverage (Copilot review on PR #44) ──────────────────────────────
//
// All tests in this block run against an isolated tmp dir via VOYAGIER_STATE_DIR —
// no test should ever read the real ~/.voyagier/ directory.

describe("voyagier doctor — state-files", () => {
  beforeEach(() => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    mockGraphql.mockResolvedValue({ __schema: { queryType: { name: "Query" } } });
  });

  it("reports PASS when no state dir exists (clean install)", async () => {
    // Use a path that doesn't exist
    process.env.VOYAGIER_STATE_DIR = join(tmpdir(), "vd-nonexistent-" + Date.now());
    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const reported = mockJsonOutput.mock.calls[0][0] as { data: { checks: Array<{ name: string; status: string; message: string }> } };
    const stateCheck = reported.data.checks.find((c) => c.name === "state-files");
    expect(stateCheck?.status).toBe("PASS");
    expect(stateCheck?.message).toContain("clean install");
  });

  it("reports PASS when state dir is empty", async () => {
    makeStateDir({});
    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const reported = mockJsonOutput.mock.calls[0][0] as { data: { checks: Array<{ name: string; status: string; message: string }> } };
    const stateCheck = reported.data.checks.find((c) => c.name === "state-files");
    expect(stateCheck?.status).toBe("PASS");
  });

  it("reports PASS for fresh JSON with embedded ISO timestamp (just now)", async () => {
    makeStateDir({
      "last-search.json": { timestamp: new Date().toISOString(), data: {} },
    });
    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const reported = mockJsonOutput.mock.calls[0][0] as { data: { checks: Array<{ name: string; status: string; message: string }> } };
    const stateCheck = reported.data.checks.find((c) => c.name === "state-files");
    expect(stateCheck?.status).toBe("PASS");
  });

  it("reports WARN when embedded timestamp is older than 24h (even if file mtime is fresh)", async () => {
    const ancient = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // 48h ago
    makeStateDir({
      "last-search.json": { timestamp: ancient, data: {} },
    });
    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const reported = mockJsonOutput.mock.calls[0][0] as { data: { overall: string; checks: Array<{ name: string; status: string; message: string }> } };
    const stateCheck = reported.data.checks.find((c) => c.name === "state-files");
    expect(stateCheck?.status).toBe("WARN");
    expect(stateCheck?.message).toMatch(/older than 24h|stale/i);
    expect(reported.data.overall).toBe("WARN");
  });

  it("reports WARN when a state file is corrupt JSON (recoverable; user can clear state)", async () => {
    makeStateDir({
      "last-search.json": "{ this is not json",
    });
    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const reported = mockJsonOutput.mock.calls[0][0] as { data: { overall: string; checks: Array<{ name: string; status: string; message: string; details?: { corrupt?: string[] } }> } };
    const stateCheck = reported.data.checks.find((c) => c.name === "state-files");
    expect(stateCheck?.status).toBe("WARN");
    expect(stateCheck?.details?.corrupt).toEqual(["last-search.json"]);
  });

  it("falls back to mtime when payload omits timestamp (legacy file)", async () => {
    makeStateDir({
      "last-search.json": { data: { foo: "bar" } }, // no timestamp
    });
    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const reported = mockJsonOutput.mock.calls[0][0] as { data: { checks: Array<{ name: string; status: string; message: string }> } };
    const stateCheck = reported.data.checks.find((c) => c.name === "state-files");
    // File was just written, mtime is fresh → PASS
    expect(stateCheck?.status).toBe("PASS");
  });
});

// ── compareSemver ───────────────────────────────────────────────────────────────────

describe("compareSemver", () => {
  let compareSemver: (a: string, b: string) => number;
  beforeAll(async () => {
    const mod = await import("./doctor.js");
    compareSemver = (mod as unknown as { compareSemver: typeof compareSemver }).compareSemver;
  });

  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.8.1", "1.8.1")).toBe(0);
  });
  it("returns -1 when current < latest", () => {
    expect(compareSemver("1.8.0", "1.8.1")).toBe(-1);
    expect(compareSemver("1.8.1", "1.9.0")).toBe(-1);
    expect(compareSemver("1.8.1", "2.0.0")).toBe(-1);
  });
  it("returns 1 when current > latest (dev/prerelease ahead of npm)", () => {
    expect(compareSemver("2.0.1", "2.0.0")).toBe(1);
    expect(compareSemver("2.1.0", "2.0.5")).toBe(1);
  });
  it("treats prerelease versions as < their release counterpart per semver spec", () => {
    expect(compareSemver("2.0.0-next.0", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "2.0.0-next.0")).toBe(1);
  });
  it("is the key fix from Copilot #3178799142: 2.0.1-next.0 is ahead of 2.0.0", () => {
    expect(compareSemver("2.0.1-next.0", "2.0.0")).toBe(1);
  });
  it("returns 0 (no false positive) when either input is unparseable", () => {
    expect(compareSemver("not-a-version", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "")).toBe(0);
  });
});
