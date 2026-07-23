import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockGetUserContext = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});
const mockFatal = jest.fn().mockImplementation((msg: string) => {
  throw new CliError(CliErrorCode.VALIDATION, msg);
});
const mockWarn = jest.fn();
const mockPrintPlanFooter = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  getUserContext: mockGetUserContext,
  CONFIG_DIR: "/tmp/test-config",
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
  fatal: mockFatal,
  warn: mockWarn,
}));

jest.unstable_mockModule("../plan-footer.js", () => ({
  printPlanFooter: mockPrintPlanFooter,
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerTravellerCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./travellers.js");
  registerTravellerCommands = mod.registerTravellerCommands;
});

// ── Fixtures & helpers ────────────────────────────────────────────────────────

const sampleTraveller = {
  id: "trv_01",
  firstName: "John",
  lastName: "Doe",
  email: "john@example.com",
  dateOfBirth: "1990-05-01",
  gender: "Male",
  declaredTravellerType: "Adult",
};

let writes: string[];
let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
let logSpy: jest.SpiedFunction<typeof console.log>;

const logJoined = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  mockFatal.mockClear();
  mockWarn.mockClear();
  mockGetUserContext.mockReset();
  mockPrintPlanFooter.mockClear();
  writes = [];
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  writeSpy.mockRestore();
  stderrSpy.mockRestore();
  logSpy.mockRestore();
});

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTravellerCommands(program);
  await program.parseAsync(["node", "voyagier", "travellers", ...args]);
}

// ── travellers add ───────────────────────────────────────────────────────────

describe("travellers add", () => {
  it("sends firstName/lastName and a PascalCase traveller type (--json)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.tripPlanId).toBe("plan-1");
    expect(vars.input).toMatchObject({ firstName: "John", lastName: "Doe", declaredTravellerType: "Adult" });
    const out = JSON.parse(writes.join(""));
    expect(out.id).toBe("trv_01");
    expect(out.url).toContain("/plans/plan-1");
  });

  it("normalizes gender, validates DOB, and builds passport + contact inputs", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run([
      "add", "--plan", "plan-1", "--first", "John", "--last", "Doe",
      "--type", "child",
      "--dob", "2015-06-01",
      "--gender", "M",
      "--email", "kid@example.com",
      "--phone", "+1-555-0000",
      "--passport-number", "X1234",
      "--passport-country", "us",
      "--passport-expiry", "2030-01",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({
      declaredTravellerType: "Child",
      dateOfBirth: "2015-06-01",
      gender: "Male",
      email: "kid@example.com",
      contactNumbers: [{ useType: "H", phone: "+1-555-0000" }],
      passport: { passportNumber: "X1234", issueCountry: "US", nationalityCountry: "US", expirationDate: "2030-01" },
    });
  });

  it("rejects an invalid --dob with VALIDATION", async () => {
    await expect(
      run(["add", "--plan", "plan-1", "--first", "J", "--last", "D", "--dob", "notadate", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("prints a human confirmation and calls the plan footer", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe", "--dob", "1990-05-01", "--gender", "M"]);
    expect(logJoined()).toContain("Added traveller: John Doe");
    expect(mockPrintPlanFooter).toHaveBeenCalledWith("plan-1");
  });

  it("--self warns when there is no saved profile", async () => {
    mockGetUserContext.mockReturnValue(null);
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe", "--self", "--json"]);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("No saved profile"));
  });

  it("--self enriches the input from the saved profile", async () => {
    mockGetUserContext.mockReturnValue({
      email: "self@example.com",
      dateOfBirth: "1988-03-03",
      gender: "Female",
      firstName: "Self",
    });
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe", "--self", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({
      email: "self@example.com",
      dateOfBirth: "1988-03-03",
      gender: "Female",
    });
  });

  it("warns about missing booking fields in non-interactive human mode", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe"]);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("Missing fields required for flight booking"));
  });

  it("--self logs which fields were auto-filled in human mode", async () => {
    mockGetUserContext.mockReturnValue({
      email: "self@example.com",
      dateOfBirth: "1988-03-03",
      gender: "Female",
      firstName: "Self",
    });
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe", "--self"]);
    expect(logJoined()).toContain("Auto-filled from profile");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("500"));
    await expect(
      run(["add", "--plan", "plan-1", "--first", "J", "--last", "D", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

// ── travellers list ────────────────────────────────────────────────────────

describe("travellers list", () => {
  it("--json returns travellers plus the plan url", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellers: [sampleTraveller] });
    await run(["list", "--plan", "plan-1", "--json"]);
    const out = JSON.parse(writes.join(""));
    expect(out.travellers).toHaveLength(1);
    expect(out.url).toContain("/plans/plan-1");
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ tripPlanId: "plan-1" });
  });

  it("--agent renders a numbered markdown list", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellers: [sampleTraveller] });
    await run(["list", "--plan", "plan-1", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("### Travellers (1)");
    expect(out).toContain("1. John Doe — Adult");
  });

  it("--agent shows an empty-state line when there are no travellers", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellers: [] });
    await run(["list", "--plan", "plan-1", "--agent"]);
    expect(writes.join("")).toContain("_No travellers on this plan._");
  });

  it("human mode flags missing booking fields", async () => {
    const incomplete = { id: "trv_x", firstName: "Amy", lastName: "Adams", declaredTravellerType: "Adult" };
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellers: [incomplete] });
    await run(["list", "--plan", "plan-1"]);
    const out = logJoined();
    expect(out).toContain("Amy Adams");
    expect(out).toContain("Missing for flight booking");
  });

  it("human mode shows an empty-state hint when there are no travellers", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellers: [] });
    await run(["list", "--plan", "plan-1"]);
    expect(logJoined()).toContain("No travellers on this plan.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("down"));
    await expect(run(["list", "--plan", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── travellers remove ────────────────────────────────────────────────────────

describe("travellers remove", () => {
  it("--json emits { success, id }", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTraveller: true });
    await run(["remove", "trv_01", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ id: "trv_01" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, id: "trv_01" });
  });

  it("human mode prints a confirmation", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTraveller: true });
    await run(["remove", "trv_01"]);
    expect(logJoined()).toContain("Removed traveller trv_01");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("x"));
    await expect(run(["remove", "trv_01", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── travellers update ────────────────────────────────────────────────────────

describe("travellers update", () => {
  it("sends only the changed fields with normalized gender/type", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTraveller: sampleTraveller });
    await run([
      "update", "trv_01",
      "--first", "Johnny",
      "--gender", "F",
      "--type", "infant",
      "--phone", "+1-555-1111",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.id).toBe("trv_01");
    expect(vars.input).toEqual({
      firstName: "Johnny",
      gender: "Female",
      declaredTravellerType: "Infant",
      contactNumbers: [{ useType: "H", phone: "+1-555-1111" }],
    });
    expect(mockJsonOutput).toHaveBeenCalled();
  });

  it("builds a passport input when passport flags are given", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTraveller: sampleTraveller });
    await run(["update", "trv_01", "--passport-number", "Z9", "--passport-nationality", "gb", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input.passport).toEqual({
      passportNumber: "Z9",
      issueCountry: "US",
      nationalityCountry: "GB",
    });
  });

  it("fails with VALIDATION when no fields are provided", async () => {
    await expect(run(["update", "trv_01", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects an invalid --dob with VALIDATION", async () => {
    await expect(run(["update", "trv_01", "--dob", "bad", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
  });

  it("validates and forwards a well-formed --dob", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTraveller: sampleTraveller });
    await run(["update", "trv_01", "--dob", "1990-05-01", "--email", "e@x.com", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toEqual({ dateOfBirth: "1990-05-01", email: "e@x.com" });
  });

  it("human mode prints a confirmation", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTraveller: sampleTraveller });
    await run(["update", "trv_01", "--first", "John"]);
    expect(logJoined()).toContain("Updated traveller: John Doe");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("nope"));
    await expect(run(["update", "trv_01", "--first", "John", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── loyalty programs (flights + hotels) ──────────────────────────────────────

describe("traveller loyalty flags", () => {
  it("add: parses repeatable --loyalty and --hotel-loyalty into the input", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run([
      "add", "--plan", "plan-1", "--first", "John", "--last", "Doe",
      "--loyalty", "DL:1234567", "--loyalty", "b6:987654",
      "--hotel-loyalty", "hi:12345678",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input.loyaltyPrograms).toEqual([
      { airlineCode: "DL", membershipNumber: "1234567" },
      { airlineCode: "B6", membershipNumber: "987654" },
    ]);
    expect(vars.input.hotelLoyaltyPrograms).toEqual([
      { chainCode: "HI", membershipNumber: "12345678" },
    ]);
  });

  it("add: omits loyalty keys entirely when the flags are not used", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "plan-1", "--first", "John", "--last", "Doe", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).not.toHaveProperty("loyaltyPrograms");
    expect(vars.input).not.toHaveProperty("hotelLoyaltyPrograms");
  });

  it("rejects a hotel member number that is not digits-only, with a chain-prefix hint", async () => {
    await expect(
      run(["add", "--plan", "p", "--first", "J", "--last", "D", "--hotel-loyalty", "HI:HI12345678", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects a value without a colon and a bad chain code", async () => {
    await expect(
      run(["add", "--plan", "p", "--first", "J", "--last", "D", "--hotel-loyalty", "HI12345678", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    await expect(
      run(["add", "--plan", "p", "--first", "J", "--last", "D", "--hotel-loyalty", "H1:12345678", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    // air codes may be alphanumeric (B6, 9W) — but not 1-char or 3-char
    await expect(
      run(["add", "--plan", "p", "--first", "J", "--last", "D", "--loyalty", "DLX:123", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("air member numbers are sent verbatim (airlines issue prefixed/alphanumeric ids)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTraveller: sampleTraveller });
    await run(["add", "--plan", "p", "--first", "J", "--last", "D", "--loyalty", "DL:DL1234567", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input.loyaltyPrograms).toEqual([{ airlineCode: "DL", membershipNumber: "DL1234567" }]);
  });

  it("update: --loyalty replaces and --clear-hotel-loyalty sends []", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTraveller: sampleTraveller });
    await run(["update", "trv_01", "--loyalty", "UA:111222", "--clear-hotel-loyalty", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toEqual({
      loyaltyPrograms: [{ airlineCode: "UA", membershipNumber: "111222" }],
      hotelLoyaltyPrograms: [],
    });
  });

  it("update: --clear-loyalty sends [] and conflicts with --loyalty", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTraveller: sampleTraveller });
    await run(["update", "trv_01", "--clear-loyalty", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toEqual({ loyaltyPrograms: [] });

    await expect(
      run(["update", "trv_01", "--loyalty", "DL:123", "--clear-loyalty", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    await expect(
      run(["update", "trv_01", "--hotel-loyalty", "HI:123", "--clear-hotel-loyalty", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("list: renders masked loyalty (code + last4) and never any full number", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellers: [{
        ...sampleTraveller,
        loyaltyPrograms: [{ airlineCode: "DL", last4: "4567" }],
        hotelLoyaltyPrograms: [{ chainCode: "HI", last4: "5678" }],
      }],
    });
    await run(["list", "--plan", "plan-1"]);
    const out = logJoined();
    expect(out).toContain("DL ••••4567");
    expect(out).toContain("HI ••••5678");
  });
});
