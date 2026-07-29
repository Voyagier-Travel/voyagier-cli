import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";
// config.js is NOT mocked — it writes to the sandboxed VOYAGIER_CONFIG_DIR set by
// test/setup-env.ts, so we exercise the real credential/profile persistence and
// assert on it via the same config API auth.ts uses.
import {
  saveCredentials,
  saveUserContext,
  clearCredentials,
  credentialsExist,
  getUserContext,
  getApiUrl,
  loadCredentials,
} from "../config.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockOpenBrowser = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../utils.js", () => ({
  // openBrowser is the only util auth.ts imports; stub it so no browser launches.
  openBrowser: mockOpenBrowser,
}));

// readline/promises drives the interactive prompt flows. The fake createInterface
// hands back a question() that pops scripted answers, so we can walk the whole
// login/setup prompt sequence without a real TTY.
let scriptedAnswers: string[] = [];
const mockClose = jest.fn();
const mockQuestion = jest.fn(async () => scriptedAnswers.shift() ?? "");
jest.unstable_mockModule("readline/promises", () => ({
  createInterface: jest.fn(() => ({ question: mockQuestion, close: mockClose })),
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerAuthCommands: (program: Command) => void;

beforeAll(async () => {
  ({ registerAuthCommands } = await import("./auth.js"));
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const TEST_TOKEN = "voy_pat_test123";

function meResponse(overrides: Record<string, unknown> = {}) {
  return {
    me: {
      id: "u-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@voyagier.com",
      name: "Ada Lovelace",
      dateOfBirth: "1990-12-10",
      gender: "female",
      passport: null,
      frequentFlyerPrograms: [],
      profile: { location: "Beacon Hill", city: { name: "Boston" }, country: { name: "USA" } },
      ...overrides,
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

let logs: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;
let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalCI = process.env.CI;

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerAuthCommands(p);
  return p;
}

function out(): string {
  return logs.join("\n");
}

function setInteractive(on: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  if (on) delete process.env.CI;
}

// `set-token -` reads via `for await (const chunk of stdin)`, where `stdin` is
// the `process.stdin` object captured by auth.ts's `import { stdin } from
// "process"`. Overriding its async iterator lets us feed scripted bytes without
// a real pipe. Returns a restore fn.
function mockStdin(data: string): () => void {
  const prev = Object.getOwnPropertyDescriptor(process.stdin, Symbol.asyncIterator);
  Object.defineProperty(process.stdin, Symbol.asyncIterator, {
    configurable: true,
    value: function () {
      const chunks = [Buffer.from(data, "utf-8")];
      let i = 0;
      return {
        next: async () =>
          i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  });
  return () => {
    if (prev) Object.defineProperty(process.stdin, Symbol.asyncIterator, prev);
    else delete (process.stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator];
  };
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockOpenBrowser.mockReset();
  mockQuestion.mockClear();
  mockClose.mockClear();
  scriptedAnswers = [];
  clearCredentials();
  logs = [];
  logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  // Default non-interactive (matches jest's real environment).
  setInteractive(false);
});

afterEach(() => {
  logSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  clearCredentials();
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
});

// ── set-token ────────────────────────────────────────────────────────────────

describe("auth set-token", () => {
  it("saves the token + custom URL to the sandboxed config", async () => {
    await buildProgram().parseAsync(["node", "v", "auth", "set-token", TEST_TOKEN, "--url", "https://dev.voyagier.com/api"]);
    expect(credentialsExist()).toBe(true);
    expect(getApiUrl()).toBe("https://dev.voyagier.com/api");
    expect(out()).toMatch(/Token saved/);
  });

  it("defaults the URL to the prod API when --url is omitted", async () => {
    await buildProgram().parseAsync(["node", "v", "auth", "set-token", TEST_TOKEN]);
    expect(getApiUrl()).toBe("https://travel.voyagier.com/api");
  });

  it("set-token -: reads the token from stdin, trims it, and saves it (M4)", async () => {
    // Leading/trailing whitespace + trailing newline must be stripped so the
    // saved token matches what was piped.
    const restore = mockStdin("  voy_pat_piped123\n");
    try {
      await buildProgram().parseAsync([
        "node", "v", "auth", "set-token", "-", "--url", "https://dev.voyagier.com/api",
      ]);
    } finally {
      restore();
    }
    expect(credentialsExist()).toBe(true);
    expect(loadCredentials()?.token).toBe("voy_pat_piped123");
    expect(getApiUrl()).toBe("https://dev.voyagier.com/api");
  });

  it("set-token -: rejects empty/whitespace-only stdin with a VALIDATION error (M4)", async () => {
    const restore = mockStdin("   \n");
    let caught: unknown;
    try {
      await buildProgram().parseAsync(["node", "v", "auth", "set-token", "-"]);
    } catch (err) {
      caught = err;
    } finally {
      restore();
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((caught as CliError).message).toMatch(/No token received on stdin/);
    expect(credentialsExist()).toBe(false);
  });
});

// ── logout ─────────────────────────────────────────────────────────────────

describe("auth logout", () => {
  it("clears saved credentials", async () => {
    saveCredentials(TEST_TOKEN);
    expect(credentialsExist()).toBe(true);
    await buildProgram().parseAsync(["node", "v", "auth", "logout"]);
    expect(credentialsExist()).toBe(false);
    expect(out()).toMatch(/Credentials cleared/);
  });
});

// ── status ────────────────────────────────────────────────────────────────

describe("auth status", () => {
  it("reports not-authenticated when no credentials exist", async () => {
    await buildProgram().parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/Not authenticated/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("shows a masked token, connected user, and cached profile", async () => {
    saveCredentials(TEST_TOKEN, "https://dev.voyagier.com/api");
    saveUserContext({
      id: "u-1",
      name: "Ada Lovelace",
      email: "ada@voyagier.com",
      homeAirports: ["BOS", "PVD"],
      preferredCabin: "business",
      location: "Beacon Hill",
      city: "Boston",
      country: "USA",
      passport: { last4: "6789", issueCountry: "US", nationalityCountry: "US", expirationDate: "2030-05" },
      frequentFlyerPrograms: [{ airlineCode: "DL", membershipNumber: "1234567890" }],
    });
    mockGraphql.mockResolvedValueOnce({ me: { email: "ada@voyagier.com", name: "Ada Lovelace" } });

    await buildProgram().parseAsync(["node", "v", "auth", "status"]);
    const text = out();
    expect(text).toMatch(/Ada Lovelace \(ada@voyagier\.com\)/);
    expect(text).toMatch(/GraphQL: connected/);
    expect(text).toMatch(/BOS \(primary\)/);
    expect(text).toMatch(/Business/);
    expect(text).toMatch(/••••6789/);
    expect(text).toMatch(/DL ••••7890/);
    // Token is masked, never printed in full.
    expect(text).not.toContain(TEST_TOKEN);
  });

  it("reports an auth failure when the me query is rejected 401", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockRejectedValueOnce(new Error("Request failed: 401"));
    await buildProgram().parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/GraphQL: authentication failed/);
  });

  it("surfaces a non-auth GraphQL error message", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockRejectedValueOnce(new Error("boom network"));
    await buildProgram().parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/GraphQL: boom network/);
  });

  it("notes when no profile is cached", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockResolvedValueOnce({ me: { email: "ada@voyagier.com" } });
    await buildProgram().parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/No profile cached/);
  });
});

// ── login ────────────────────────────────────────────────────────────────

describe("auth login", () => {
  it("non-interactive: prints PAT instructions and does not save", async () => {
    setInteractive(false);
    await buildProgram().parseAsync(["node", "v", "auth", "login", "--url", "https://dev.voyagier.com/api"]);
    expect(out()).toMatch(/Generate a Personal Access Token/);
    expect(out()).toMatch(/dev\.voyagier\.com\/me\/settings\/tokens/);
    expect(credentialsExist()).toBe(false);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  it("interactive: opens the browser, saves the pasted token, verifies + auto-sets profile", async () => {
    setInteractive(true);
    scriptedAnswers = [TEST_TOKEN];
    mockGraphql.mockResolvedValueOnce(meResponse());

    await buildProgram().parseAsync(["node", "v", "auth", "login", "--url", "https://dev.voyagier.com/api"]);

    expect(mockOpenBrowser).toHaveBeenCalledWith("https://dev.voyagier.com/me/settings/tokens");
    expect(credentialsExist()).toBe(true);
    // fetchAndBuildContext auto-detected BOS from the Boston profile city.
    expect(getUserContext()?.homeAirports).toEqual(["BOS"]);
    expect(out()).toMatch(/Logged in as/);
    expect(out()).toMatch(/Home airport auto-detected/);
  });

  it("interactive: cancels cleanly on an empty token", async () => {
    setInteractive(true);
    scriptedAnswers = [""];
    await buildProgram().parseAsync(["node", "v", "auth", "login"]);
    expect(out()).toMatch(/Cancelled/);
    expect(credentialsExist()).toBe(false);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("interactive: saves the token but warns when verification fails", async () => {
    setInteractive(true);
    scriptedAnswers = [TEST_TOKEN];
    mockGraphql.mockRejectedValueOnce(new Error("verify failed"));
    await buildProgram().parseAsync(["node", "v", "auth", "login"]);
    expect(credentialsExist()).toBe(true);
    expect(out()).toMatch(/Token saved/);
    expect(out()).toMatch(/Could not verify/);
  });
});

// ── setup ────────────────────────────────────────────────────────────────

describe("auth setup", () => {
  it("refuses when not authenticated", async () => {
    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);
    expect(out()).toMatch(/Not authenticated/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("wraps a profile-fetch failure as an API_ERROR", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockRejectedValueOnce(new Error("profile fetch boom"));
    await expect(
      buildProgram().parseAsync(["node", "v", "auth", "setup"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });

  it("non-interactive with --airports and --cabin flags persists them", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockResolvedValueOnce(meResponse());
    await buildProgram().parseAsync([
      "node", "v", "auth", "setup",
      "--airports", "bwi, dca",
      "--cabin", "business",
      "--skip-passport", "--skip-ff",
    ]);
    const ctx = getUserContext();
    expect(ctx?.homeAirports).toEqual(["BWI", "DCA"]);
    expect(ctx?.preferredCabin).toBe("business");
    expect(out()).toMatch(/Setup complete/);
  });

  it("non-interactive rejects invalid --airports codes", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockResolvedValueOnce(meResponse());
    await expect(
      buildProgram().parseAsync([
        "node", "v", "auth", "setup",
        "--airports", "BWI,XX",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("non-interactive warns on an invalid --cabin but continues", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockResolvedValueOnce(meResponse());
    await buildProgram().parseAsync([
      "node", "v", "auth", "setup",
      "--airports", "BOS",
      "--cabin", "spaceship",
      "--skip-passport", "--skip-ff",
    ]);
    // Falls back to the existing/default cabin (economy) rather than the bad value.
    expect(getUserContext()?.preferredCabin).toBe("economy");
    expect(out()).toMatch(/Invalid cabin "spaceship"/);
  });

  it("non-interactive imports passport + frequent-flyer data already on the profile", async () => {
    saveCredentials(TEST_TOKEN);
    mockGraphql.mockResolvedValueOnce(
      meResponse({
        passport: { last4: "4321", issueCountry: "GB", nationalityCountry: "GB", expirationDate: "2031-01" },
        frequentFlyerPrograms: [{ airlineCode: "BA", membershipNumber: "9998887" }],
      }),
    );
    await buildProgram().parseAsync(["node", "v", "auth", "setup", "--airports", "BOS"]);
    const ctx = getUserContext();
    expect(ctx?.passport?.last4).toBe("4321");
    // L3: frequent-flyer numbers are stored masked (last 4), never in full.
    expect(ctx?.frequentFlyerPrograms).toEqual([{ airlineCode: "BA", membershipNumber: "••••8887" }]);
    expect(out()).toMatch(/Imported from profile/);
  });

  it("non-interactive with no flags falls back to hints + economy default", async () => {
    saveCredentials(TEST_TOKEN);
    // City not in the CITY_AIRPORTS map → no auto-detect → non-interactive hint path.
    mockGraphql.mockResolvedValueOnce(
      meResponse({ profile: { location: "Nowhere", city: { name: "Atlantis" }, country: { name: "??" } } }),
    );
    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);
    expect(out()).toMatch(/Non-interactive mode. Use: voyagier auth setup --airports/);
    expect(getUserContext()?.preferredCabin).toBe("economy");
    expect(out()).toMatch(/Skipped \(non-interactive\)/);
  });

  it("interactive: walks the full airports/cabin/passport/FF prompt sequence", async () => {
    saveCredentials(TEST_TOKEN);
    setInteractive(true);
    mockGraphql.mockResolvedValueOnce(meResponse());
    // airports (with an invalid code to skip), cabin=3(Business),
    // passport last4/issue/nationality(default)/expiration, then one FF + Enter.
    scriptedAnswers = ["BWI, XX, DCA", "3", "1234", "US", "", "2030-05", "DL 1234567890", ""];

    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);

    const ctx = getUserContext();
    expect(ctx?.homeAirports).toEqual(["BWI", "DCA"]); // XX dropped as invalid
    expect(ctx?.preferredCabin).toBe("business");
    expect(ctx?.passport).toEqual({
      last4: "1234",
      issueCountry: "US",
      nationalityCountry: "US", // defaulted from issue country on empty input
      expirationDate: "2030-05",
    });
    // L3: stored masked (last 4), never in full.
    expect(ctx?.frequentFlyerPrograms).toEqual([{ airlineCode: "DL", membershipNumber: "••••7890" }]);
    expect(out()).toMatch(/Setup complete/);
  });

  it("interactive: handles skipped passport and malformed FF input gracefully", async () => {
    saveCredentials(TEST_TOKEN);
    setInteractive(true);
    mockGraphql.mockResolvedValueOnce(meResponse());
    // airports=Enter (keep auto-detected BOS), cabin=Enter (economy),
    // passport last4="12" (invalid → skip), FF: "X 1" (bad airline), "oneword" (bad format), Enter.
    scriptedAnswers = ["", "", "12", "X 1", "oneword", ""];

    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);

    const ctx = getUserContext();
    expect(ctx?.homeAirports).toEqual(["BOS"]); // kept auto-detected
    expect(ctx?.preferredCabin).toBe("economy");
    expect(ctx?.passport).toBeUndefined(); // invalid last4 → not saved
    expect(ctx?.frequentFlyerPrograms).toBeUndefined(); // both FF inputs rejected
    expect(out()).toMatch(/Invalid airline code "X"/);
  });
});
