import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSchema, introspectionFromSchema, buildClientSchema, getIntrospectionQuery } from "graphql";
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
  // doctor.ts falls back to CONFIG_DIR for its state-dir; specs set
  // VOYAGIER_STATE_DIR explicitly, so this value is never dereferenced.
  CONFIG_DIR: "/tmp/voyagier-doctor-spec-config",
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerDoctorCommand: (program: Command, version: string) => void;
let rollUpStatus: (checks: { status: "PASS" | "WARN" | "FAIL" }[]) => "PASS" | "WARN" | "FAIL";
let collectCliOperations: () => Array<{ name: string; operation: string }>;
let validateOperationsAgainstSchema: (
  schema: any,
  ops: Array<{ name: string; operation: string }>,
) => Array<{ name: string; errors: string[] }>;
let buildSchemaDriftCheck: (
  opsCount: number,
  drifted: Array<{ name: string; errors: string[] }>,
) => { name: string; status: "PASS" | "WARN" | "FAIL"; message: string; details?: Record<string, unknown> };

beforeAll(async () => {
  const mod = await import("./doctor.js");
  registerDoctorCommand = mod.registerDoctorCommand;
  rollUpStatus = mod.rollUpStatus;
  collectCliOperations = mod.collectCliOperations;
  validateOperationsAgainstSchema = mod.validateOperationsAgainstSchema;
  buildSchemaDriftCheck = mod.buildSchemaDriftCheck;
});

// A small but real introspection result, used to drive the live-schema check
// without a 900KB fixture. Build SDL -> introspection -> client schema.
function fixtureIntrospection() {
  const sdl = `
    type Query {
      tripPlans(page: Int, limit: Int): PlanPage
      tripPlanClients: ClientPage
    }
    type PlanPage { count: Int }
    type ClientPage { count: Int }
  `;
  return introspectionFromSchema(buildSchema(sdl));
}

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
  // Note: the command-level schema check validates the REAL CLI surface
  // (collectCliOperations) against whatever schema introspection returns.
  // Driving all ~88 ops to PASS would require serving the full live schema as
  // a fixture, so the end-to-end command tests assert the auth/version/state
  // wiring and the schema-check's resilience branches; the field-by-field
  // validation correctness is unit-tested directly against a fixture schema
  // below (validateOperationsAgainstSchema / collectCliOperations).
  it("reports PASS for non-schema checks; schema WARNs inconclusive when introspection can't build", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    // Auth ping ok; introspection returns an unbuildable shape => schema WARN (not FAIL).
    mockGraphql.mockResolvedValue({ __schema: { queryType: { name: "Query" } } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledTimes(1);
    const reported = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { overall: string; checks: Array<{ name: string; status: string }> };
    };
    // WARN rolls up to overall WARN, ok=true (not a hard fail).
    expect(reported.ok).toBe(true);
    expect(reported.data.checks.find((c) => c.name === "auth")?.status).toBe("PASS");
    expect(reported.data.checks.find((c) => c.name === "version")?.status).toBe("PASS");
    const schema = reported.data.checks.find((c) => c.name === "schema");
    expect(schema?.status).toBe("WARN");
    expect(schema?.message).toMatch(/inconclusive/i);
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

  it("flags schema drift when a real shipped operation has an unknown field", async () => {
    mockCredentialsExist.mockReturnValue(true);
    mockGetUserContext.mockReturnValue({ email: "daniel@voyagier.com" });
    // Auth ping ok; introspection returns the tiny fixture schema. The real CLI
    // ops (goals, plans get, etc.) reference types the fixture doesn't define =>
    // genuine drift => schema FAIL. This proves the live-validation path catches
    // exactly the class of break VOY-1411 was about (the old 2-probe check missed).
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("IntrospectionQuery")) return fixtureIntrospection();
      return { __schema: { queryType: { name: "Query" } } };
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "doctor", "--json"]);

    const reported = mockJsonOutput.mock.calls[0][0] as {
      data: { overall: string; checks: Array<{ name: string; status: string; details?: { drifted?: string[] } }> };
    };
    const schema = reported.data.checks.find((c) => c.name === "schema");
    expect(schema?.status).toBe("FAIL");
    expect(schema?.message).toMatch(/drift detected on \d+\/\d+ operation/);
    expect(Array.isArray(schema?.details?.drifted)).toBe(true);
    expect(reported.data.overall).toBe("FAIL");
    expect(exitSpy).toHaveBeenCalledWith(1);
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

// ── live-schema validation (the VOY-1411 fix) ───────────────────────────────
//
// The end-to-end command tests above exercise the wiring + resilience. These
// unit tests pin the field-by-field validation correctness against a fixture
// schema, and — critically — guard against the original bug ever returning:
// doctor must validate the WHOLE queries.ts surface, not a hardcoded subset.

describe("collectCliOperations", () => {
  it("collects every GraphQL operation exported from queries.ts", () => {
    const ops = collectCliOperations();
    // The surface is large; the exact count drifts as queries are added. The
    // invariant that matters: it's the WHOLE surface, not a tiny hardcoded set.
    expect(ops.length).toBeGreaterThan(50);
    // Known ops that were part of the historical drift chain must be present.
    const names = ops.map((o) => o.name);
    expect(names).toContain("LIST_TRIP_PLAN_GOALS");
    expect(names).toContain("GET_PLAN_DEEP");
    // Every collected entry is a non-empty operation document.
    for (const o of ops) {
      expect(typeof o.operation).toBe("string");
      expect(o.operation.length).toBeGreaterThan(0);
      expect(o.operation).toMatch(/^(query|mutation|subscription|fragment|\{)/);
    }
  });
});

describe("buildSchemaDriftCheck — core vs peripheral classification (VOY-1714)", () => {
  const err = (name: string) => ({ name, errors: ["Cannot query field x"] });

  it("PASS when nothing drifted", () => {
    expect(buildSchemaDriftCheck(100, [])).toMatchObject({ status: "PASS" });
  });

  it("WARN with explicit go-ahead when drift is confined to peripheral surfaces", () => {
    const check = buildSchemaDriftCheck(100, [
      err("GET_PLACE_BY_ID"),
      err("SEARCH_PLACES"),
      err("GET_COMMENTS"),
      err("GET_BOOKING_RECORDS_BY_USER"),
    ]);
    expect(check.status).toBe("WARN");
    expect(check.message).toMatch(/core compose\/close loop is unaffected; safe to proceed/);
  });

  it("FAIL naming the core ops when any core-surface op drifted", () => {
    const check = buildSchemaDriftCheck(100, [err("GET_PLACE_BY_ID"), err("GET_QUOTE_DATA")]);
    expect(check.status).toBe("FAIL");
    expect(check.message).toMatch(/1 on CORE surfaces/);
    expect((check.details as { coreDrifted: string[] }).coreDrifted).toEqual(["GET_QUOTE_DATA"]);
  });

  it("unknown op names classify as CORE (fail-closed)", () => {
    expect(buildSchemaDriftCheck(10, [err("SOME_FUTURE_OP")]).status).toBe("FAIL");
  });
});

describe("validateOperationsAgainstSchema", () => {
  const schema = buildClientSchema(
    introspectionFromSchema(
      buildSchema(`
        type Query { tripPlans(page: Int, limit: Int): PlanPage }
        type PlanPage { count: Int name: String }
      `),
    ),
  );

  it("returns [] when all operations are valid", () => {
    const drift = validateOperationsAgainstSchema(schema as any, [
      { name: "GOOD", operation: "{ tripPlans(page:1, limit:1){ count name } }" },
    ]);
    expect(drift).toEqual([]);
  });

  it("reports the field-level error for a drifted operation", () => {
    const drift = validateOperationsAgainstSchema(schema as any, [
      { name: "GOOD", operation: "{ tripPlans { count } }" },
      { name: "DRIFTED", operation: "{ tripPlans { isFulfilled } }" },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0].name).toBe("DRIFTED");
    expect(drift[0].errors.join(" ")).toMatch(/Cannot query field "isFulfilled"/);
  });

  it("treats a malformed operation as drift (parse error), not a crash", () => {
    const drift = validateOperationsAgainstSchema(schema as any, [
      { name: "BROKEN", operation: "{ tripPlans { " },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0].errors[0]).toMatch(/parse error/i);
  });

  it("validates introspection query helper is the canonical graphql one", () => {
    // Guard: checkSchema fetches via getIntrospectionQuery(); ensure it's the real thing.
    expect(getIntrospectionQuery()).toMatch(/IntrospectionQuery/);
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
