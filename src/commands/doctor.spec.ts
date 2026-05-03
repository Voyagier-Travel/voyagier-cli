import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
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
});

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
