import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

/**
 * whoami honesty contract (VOY-1703):
 *   - Default = LIVE token verification. A revoked/stale PAT must fail loudly
 *     with the API URL and a fix command — never render cached identity as if
 *     logged in.
 *   - --cached = explicit offline escape hatch (cached identity, no API call).
 */

const mockGraphql = jest.fn<(q: string) => Promise<unknown>>();
const mockCredentialsExist = jest.fn<() => boolean>();
const mockGetUserContext = jest.fn<() => Record<string, unknown> | null>();

// Test double for the compat wrapper (VOY-1748) — delegates to mockGraphql,
// reproducing the enriched→legacy retry on an unknown-field error so whoami's
// role query is exercised through the same fallback as production. The real
// detection is unit-tested in api.spec.ts.
async function fallbackDouble(
  enriched: string,
  legacy: string,
  pattern: RegExp,
): Promise<unknown> {
  try {
    return await mockGraphql(enriched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot query field|Unknown field/i.test(message) && pattern.test(message)) {
      return await mockGraphql(legacy);
    }
    throw err;
  }
}

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  graphqlWithFieldFallback: fallbackDouble,
}));

jest.unstable_mockModule("../config.js", () => ({
  credentialsExist: mockCredentialsExist,
  getUserContext: mockGetUserContext,
  saveUserContext: jest.fn(),
  getApiUrl: jest.fn(() => "https://travel.voyagier.com/api"),
}));

let registerWhoamiCommand: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./whoami.js");
  registerWhoamiCommand = mod.registerWhoamiCommand;
});

const CACHED_CTX = {
  id: "u1",
  name: "Cached User",
  email: "cached@example.com",
  homeAirports: [],
  preferredCabin: "economy",
};

const ME = {
  id: "u1",
  firstName: "Live",
  lastName: "User",
  email: "live@example.com",
  dateOfBirth: null,
  gender: null,
  passport: null,
};

let stdoutSpy: ReturnType<typeof jest.spyOn>;
let consoleLogSpy: ReturnType<typeof jest.spyOn>;

async function runWhoami(args: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerWhoamiCommand(program);
  await program.parseAsync(["node", "test", "whoami", ...args]);
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockCredentialsExist.mockReturnValue(true);
  mockGetUserContext.mockReturnValue({ ...CACHED_CTX });
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

function humanOutput(): string {
  return consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
}

function jsonOutput(): Record<string, unknown> {
  const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
  return JSON.parse(written) as Record<string, unknown>;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("whoami live verification (VOY-1703)", () => {
  it("verifies the token against the API by default", async () => {
    mockGraphql.mockResolvedValue({ me: ME });
    await runWhoami(["--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(mockGraphql.mock.calls[0][0]).toContain("me {");
  });

  it("re-throws graphql()'s normalized CliError(AUTH_FAILED) with whoami-specific context (the real-run path)", async () => {
    // graphql() normalizes 401/UNAUTHENTICATED into CliError(AUTH_FAILED) before
    // whoami's catch ever sees it — the rich message must survive that path.
    mockGraphql.mockRejectedValue(
      new CliError(CliErrorCode.AUTH_FAILED, "Authentication failed. Your token may be invalid or expired."),
    );
    let err: unknown;
    try {
      await runWhoami(["--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.AUTH_FAILED);
    expect((err as CliError).message).toContain("Token rejected by https://travel.voyagier.com/api");
    expect((err as CliError).message).toContain("auth set-token");
    expect((err as CliError).message).toContain("NOT shown");
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain("cached@example.com");
  });

  it("fails loudly with AUTH_FAILED when the token is rejected — never shows cached identity", async () => {
    mockGraphql.mockRejectedValue(new Error("Unauthorized"));
    let err: unknown;
    try {
      await runWhoami(["--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.AUTH_FAILED);
    expect((err as CliError).message).toContain("https://travel.voyagier.com/api");
    expect((err as CliError).message).toContain("auth set-token");
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain("cached@example.com");
  });

  it("distinguishes non-auth API failures and points at --cached for offline use", async () => {
    mockGraphql.mockRejectedValue(new Error("ECONNREFUSED"));
    let err: unknown;
    try {
      await runWhoami(["--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.API_ERROR);
    expect((err as CliError).message).toContain("--cached");
  });

  it("--cached skips the live check and shows cached identity", async () => {
    await runWhoami(["--cached", "--json"]);
    expect(mockGraphql).not.toHaveBeenCalled();
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("cached@example.com");
  });

  it("--cached with no cached context still live-fetches (nothing to show otherwise)", async () => {
    mockGetUserContext.mockReturnValue(null);
    mockGraphql.mockResolvedValue({ me: ME });
    await runWhoami(["--cached", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });
});

// ── VOY-1748: RBAC roles in whoami ───────────────────────────────────────────

describe("whoami roles (VOY-1748)", () => {
  it("includes the raw role flags in --json when the backend returns them", async () => {
    mockGraphql.mockResolvedValue({
      me: { ...ME, isAdmin: true, isTravelAdvisor: true, isTripPlanner: false },
    });
    await runWhoami(["--json"]);
    expect(jsonOutput()).toMatchObject({
      isAdmin: true,
      isTravelAdvisor: true,
      isTripPlanner: false,
    });
  });

  it("renders a single Role line joining multiple roles with ' + '", async () => {
    mockGraphql.mockResolvedValue({
      me: { ...ME, isAdmin: true, isTravelAdvisor: true, isTripPlanner: false },
    });
    await runWhoami([]);
    expect(humanOutput()).toMatch(/Role:.*Admin \+ Travel Advisor/);
  });

  it("renders Trip Planner alone for a trip-planner-only user", async () => {
    mockGraphql.mockResolvedValue({
      me: { ...ME, isAdmin: false, isTravelAdvisor: false, isTripPlanner: true },
    });
    await runWhoami([]);
    const out = humanOutput();
    expect(out).toMatch(/Role:.*Trip Planner/);
    expect(out).not.toMatch(/Admin/);
  });

  it("omits the Role line entirely when every flag is false (regular traveller)", async () => {
    mockGraphql.mockResolvedValue({
      me: { ...ME, isAdmin: false, isTravelAdvisor: false, isTripPlanner: false },
    });
    await runWhoami([]);
    expect(humanOutput()).not.toMatch(/Role:/);
  });

  it("falls back to the legacy me query and omits roles against an old backend", async () => {
    // Enriched query rejected (isTripPlanner unknown) → retry legacy (no roles).
    mockGraphql
      .mockRejectedValueOnce(
        new CliError(
          CliErrorCode.SCHEMA_DRIFT,
          'Schema drift detected: Cannot query field "isTripPlanner" on type "User".',
        ),
      )
      .mockResolvedValueOnce({ me: ME });

    await runWhoami([]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(humanOutput()).not.toMatch(/Role:/);
  });

  it("omits role flags from --json against an old backend (fallback path)", async () => {
    mockGraphql
      .mockRejectedValueOnce(
        new CliError(
          CliErrorCode.SCHEMA_DRIFT,
          'Schema drift detected: Cannot query field "isTripPlanner" on type "User".',
        ),
      )
      .mockResolvedValueOnce({ me: ME });

    await runWhoami(["--json"]);

    const out = jsonOutput();
    expect(out).not.toHaveProperty("isAdmin");
    expect(out).not.toHaveProperty("isTravelAdvisor");
    expect(out).not.toHaveProperty("isTripPlanner");
  });
});
