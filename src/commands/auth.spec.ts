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
  // openBrowser is stubbed so no browser launches; maskLoyaltyValue keeps its
  // real behaviour so the masked-output assertions exercise the shipping logic.
  openBrowser: mockOpenBrowser,
  maskLoyaltyValue: (value: string) => (value.length > 4 ? `••••${value.slice(-4)}` : "••••"),
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
    // Frequent-flyer membership numbers are masked to last-4 in terminal output.
    expect(text).toMatch(/DL ••••7890/);
    expect(text).not.toContain("1234567890");
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
    // Frequent-flyer numbers are imported and stored in full (used to credit miles).
    expect(ctx?.frequentFlyerPrograms).toEqual([{ airlineCode: "BA", membershipNumber: "9998887" }]);
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

  it("interactive: walks airports/cabin/passport/FF/hotel, syncs, and stores only the masked passport", async () => {
    saveCredentials(TEST_TOKEN);
    setInteractive(true);
    // Call #1: profile fetch. Call #2: updateMyUser — returns the masked
    // passport shape + full FF list (the only things ever persisted for those).
    mockGraphql
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce({
        updateMyUser: {
          passport: { last4: "4567", issueCountry: "US", nationalityCountry: "US", expirationDate: "2030-05" },
          frequentFlyerPrograms: [{ airlineCode: "DL", membershipNumber: "1234567890" }],
        },
      });
    // airports (invalid XX dropped), cabin=3(Business), passport number (muted,
    // 6–9 alnum), issue=US, nationality(default), expiration, one FF + Enter,
    // one hotel + Enter.
    scriptedAnswers = [
      "BWI, XX, DCA", "3",
      "X1234567", "US", "", "2030-05",
      "DL 1234567890", "",
      "HI 12345678", "",
    ];

    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);

    const ctx = getUserContext();
    expect(ctx?.homeAirports).toEqual(["BWI", "DCA"]); // XX dropped as invalid
    expect(ctx?.preferredCabin).toBe("business");
    // Only the masked shape from the mutation response is stored.
    expect(ctx?.passport).toEqual({
      last4: "4567",
      issueCountry: "US",
      nationalityCountry: "US",
      expirationDate: "2030-05",
    });
    // FF stored in full (from the response); hotel loyalty stored in full locally.
    expect(ctx?.frequentFlyerPrograms).toEqual([{ airlineCode: "DL", membershipNumber: "1234567890" }]);
    expect(ctx?.hotelLoyaltyPrograms).toEqual([{ chainCode: "HI", membershipNumber: "12345678" }]);

    // updateMyUser (call #2) carries the FULL passport number + FF; hotel loyalty is never sent.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, vars] = mockGraphql.mock.calls[1] as [string, any];
    expect(vars.input.passport).toEqual({
      passportNumber: "X1234567",
      issueCountry: "US",
      nationalityCountry: "US",
      expirationDate: "2030-05",
    });
    expect(vars.input.frequentFlyerPrograms).toEqual([{ airlineCode: "DL", membershipNumber: "1234567890" }]);
    expect(vars.input).not.toHaveProperty("hotelLoyaltyPrograms");

    // The full passport number must never reach stdout or credentials.json.
    expect(out()).not.toContain("X1234567");
    expect(JSON.stringify(loadCredentials())).not.toContain("X1234567");
    // Loyalty numbers are masked to last-4 in terminal output (but stored/synced in full).
    expect(out()).toMatch(/DL ••••7890/);
    expect(out()).not.toContain("1234567890");
    expect(out()).not.toContain("12345678");
    expect(out()).toMatch(/Setup complete/);
  });

  it("interactive: a profile-sync failure never echoes the raw upstream error", async () => {
    saveCredentials(TEST_TOKEN);
    setInteractive(true);
    // Call #1: profile fetch (no FF on file). Call #2: updateMyUser rejects with
    // an error whose text mimics a leaked request variable (the passport number).
    mockGraphql
      .mockResolvedValueOnce(meResponse())
      .mockRejectedValueOnce(new Error('Bad request: passportNumber="X1234567" rejected'));
    // airports=Enter (keep BOS), cabin=Enter, passport=Enter (skip),
    // one FF + Enter (so there is something to sync), hotel=Enter.
    scriptedAnswers = ["", "", "", "DL 1234567890", "", ""];

    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);

    const text = out();
    // Generic, reassuring message — never the raw GraphQL error or its variables.
    expect(text).toMatch(/Profile sync failed/);
    expect(text).not.toContain("X1234567");
    expect(text).not.toContain("Bad request");
    expect(text).not.toContain("rejected");
    // The sync was attempted (profile fetch + updateMyUser).
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("interactive: invalid passport re-prompts with an explanation, then skips without syncing", async () => {
    saveCredentials(TEST_TOKEN);
    setInteractive(true);
    mockGraphql.mockResolvedValueOnce(meResponse());
    // airports=Enter (keep BOS), cabin=Enter (economy), passport "12" then "abc"
    // (both invalid → skip), FF "X 1"/"oneword" rejected then Enter, hotel Enter.
    scriptedAnswers = ["", "", "12", "abc", "X 1", "oneword", "", ""];

    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);

    const ctx = getUserContext();
    expect(ctx?.homeAirports).toEqual(["BOS"]);
    expect(ctx?.preferredCabin).toBe("economy");
    expect(ctx?.passport).toBeUndefined(); // invalid → not saved
    expect(ctx?.frequentFlyerPrograms).toBeUndefined();
    // Explains the format and re-prompts (never a silent skip).
    expect(out()).toMatch(/6–9 letters or digits/);
    expect(out()).toMatch(/Invalid airline code "X"/);
    // Nothing new entered → no updateMyUser sync.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it("interactive: Enter keeps an on-file passport without revealing it and without a sync call", async () => {
    saveCredentials(TEST_TOKEN);
    setInteractive(true);
    mockGraphql.mockResolvedValueOnce(
      meResponse({
        passport: { last4: "6789", issueCountry: "US", nationalityCountry: "US", expirationDate: "2031-05" },
        frequentFlyerPrograms: [{ airlineCode: "DL", membershipNumber: "1234567890" }],
      }),
    );
    // airports=Enter (keep BOS), cabin=Enter, passport=Enter (keep), hotel=Enter.
    scriptedAnswers = ["", "", "", ""];

    await buildProgram().parseAsync(["node", "v", "auth", "setup"]);

    const ctx = getUserContext();
    expect(ctx?.passport?.last4).toBe("6789");
    expect(ctx?.frequentFlyerPrograms).toEqual([{ airlineCode: "DL", membershipNumber: "1234567890" }]);
    expect(out()).toMatch(/Keeping the passport on file/);
    expect(out()).toMatch(/••••6789/);
    // Nothing changed → no updateMyUser call.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });
});
