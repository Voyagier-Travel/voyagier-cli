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

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
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
  jest.spyOn(console, "log").mockImplementation(() => {});
});

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
