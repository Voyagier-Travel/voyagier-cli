import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();
const mockLoadSearchState = jest.fn();
const mockSaveSearchState = jest.fn();
const mockClearSearchState = jest.fn();
const mockIsSearchStateStale = jest.fn().mockReturnValue(false);
const mockWarn = jest.fn();
const mockProgress = jest.fn();
const mockFatal = jest.fn().mockImplementation((msg: unknown) => {
  throw new Error(String(msg));
});
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});
const mockJsonOutputWithPlan = jest.fn().mockImplementation((data: unknown, planId: string, planTitle?: string) => {
  process.stdout.write(JSON.stringify({ ...(data as object), planContext: { planId, title: planTitle } }) + "\n");
});

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AuthError";
    }
  },
}));

jest.unstable_mockModule("../state.js", () => ({
  loadSearchState: mockLoadSearchState,
  saveSearchState: mockSaveSearchState,
  clearSearchState: mockClearSearchState,
  isSearchStateStale: mockIsSearchStateStale,
}));

jest.unstable_mockModule("../plan-footer.js", () => ({
  printPlanFooter: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://api.test.voyagier.com/graphql"),
  CONFIG_DIR: "/tmp/test-config",
}));

jest.unstable_mockModule("../formatters.js", () => ({
  formatFlights: jest.fn().mockReturnValue(""),
}));

jest.unstable_mockModule("../hints.js", () => ({
  hintFlightSelected: jest.fn().mockReturnValue(""),
  hintHotelSelected: jest.fn().mockReturnValue(""),
}));

jest.unstable_mockModule("../utils.js", () => ({
  extractFlightToken: jest.fn().mockReturnValue("tok-return"),
  buildFlightSummary: jest.fn().mockReturnValue("NRT→LAX · AA · $900.00 · 11h 00m"),
  deriveBaseUrl: jest.fn().mockReturnValue("https://app.voyagier.com"),
  formatPrice: jest.fn().mockImplementation((p: unknown) => `$${p}`),
  shellArg: jest.fn().mockImplementation((v: unknown) => String(v ?? "")),
  // Mirrors the real validateId contract (utils.ts) so direct-mode id
  // validation is exercised end-to-end here; unit-tested exhaustively in
  // utils.spec.ts.
  validateId: jest.fn().mockImplementation((value: unknown, flagName: string) => {
    const trimmed = String(value).trim();
    const lowered = trimmed.toLowerCase();
    if (trimmed === "" || lowered === "null" || lowered === "undefined") {
      throw new CliError(CliErrorCode.VALIDATION, `Invalid ${flagName}: "${value}".`);
    }
    return trimmed;
  }),
  // Mirrors the real validateOptionId contract (utils.ts): validateId's garbage
  // check first, then the full-uuid shape. Unit-tested exhaustively in
  // utils.spec.ts; exercised end-to-end through `select` here.
  validateOptionId: jest.fn().mockImplementation((value: unknown, flagName: string) => {
    const trimmed = String(value).trim();
    const lowered = trimmed.toLowerCase();
    if (trimmed === "" || lowered === "null" || lowered === "undefined") {
      throw new CliError(CliErrorCode.VALIDATION, `Invalid ${flagName}: "${value}".`);
    }
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `Option id must be the full id shown in search results (a 36-character UUID). Received: ${value}`,
      );
    }
    return trimmed;
  }),
  // resolvePlanArg is not mocked: it lives in resolve-plan-arg.ts (own
  // module) so the real contract is always in play here.
}));

jest.unstable_mockModule("../output.js", () => ({
  progress: mockProgress,
  warn: mockWarn,
  fatal: mockFatal,
  jsonOutput: mockJsonOutput,
  jsonOutputWithPlan: mockJsonOutputWithPlan,
}));

// ── Dynamic imports after mocks ────────────────────────────────────────────

let registerSelectCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./select.js");
  registerSelectCommands = mod.registerSelectCommands;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

// Option ids are full 36-character uuids (VOY-2044): direct mode rejects
// anything shorter before it reaches the API. Index mode is exempt — its ids
// come from cached search state — but the fixtures use real shapes throughout.
const OPT_UUID = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607";
const OPT_UUID_2 = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const FOREIGN_OPT_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const MOCK_ONEWAY_STATE = {
  type: "flights" as const,
  tripPlanId: "plan-123",
  selectionId: "sel-456",
  isRoundTrip: false,
  awaitingReturn: false,
  origin: "LAX",
  destination: "NRT",
  results: [
    { index: 1, optionId: OPT_UUID, flightToken: "tok-f1", summary: "LAX→NRT · AA · $1,200" },
    { index: 2, optionId: OPT_UUID_2, flightToken: "tok-f2", summary: "LAX→NRT · UA · $1,500" },
  ],
  timestamp: new Date().toISOString(),
};

const MOCK_ROUNDTRIP_DEPARTURE_STATE = {
  type: "flights" as const,
  tripPlanId: "plan-123",
  selectionId: "sel-456",
  isRoundTrip: true,
  awaitingReturn: false,
  origin: "LAX",
  destination: "NRT",
  results: [
    { index: 1, optionId: OPT_UUID, flightToken: "tok-f1", summary: "LAX→NRT · AA · $1,200" },
  ],
  timestamp: new Date().toISOString(),
};

const MOCK_ROUNDTRIP_RETURN_STATE = {
  type: "flights" as const,
  tripPlanId: "plan-123",
  selectionId: "sel-456",
  isRoundTrip: true,
  awaitingReturn: true,
  origin: "NRT",
  destination: "LAX",
  results: [
    { index: 1, optionId: "r1", flightToken: "tok-r1", summary: "NRT→LAX · AA · $900" },
  ],
  timestamp: new Date().toISOString(),
};

const MOCK_HOTEL_STATE = {
  type: "hotels" as const,
  tripPlanId: "plan-123",
  selectionId: "sel-hotel",
  isRoundTrip: false,
  results: [
    { index: 1, optionId: "hotel-1", summary: "Grand Hotel · $200/night" },
  ],
  timestamp: new Date().toISOString(),
};

const MOCK_DEPARTURE_RESULT = {
  selectDepartureFlight: {
    id: "sel-456",
    options: [
      { id: "r1", name: "Return AA", price: 900, duration: "11h", airline: "AA", bookingData: { flightToken: "tok-r1" } },
    ],
  },
};

const MOCK_RETURN_RESULT = {
  selectReturnFlight: {
    id: "sel-456",
    options: [
      { id: "final-1", name: "Combined AA", price: 2100 },
    ],
  },
};

const MOCK_SET_SELECTED = {
  setTripPlanSelectedOption: {
    id: "sel-456",
    parentOptionId: OPT_UUID,
    parentOption: { id: OPT_UUID, name: "AA Flight", price: 1200 },
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function runSelect(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSelectCommands(program);
  await program.parseAsync(["node", "voyagier", "select", ...args]);
}

// ── Tests: --clear flag ────────────────────────────────────────────────────

describe("select --clear", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockClearSearchState.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls clearSearchState when --clear is passed", async () => {
    await runSelect(["--clear"]);
    expect(mockClearSearchState).toHaveBeenCalledTimes(1);
  });

  it("outputs cleared JSON when --clear --json", async () => {
    await runSelect(["--clear", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.cleared).toBe(true);
  });
});

// ── Tests: --info flag ────────────────────────────────────────────────────

describe("select --info", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue(MOCK_ONEWAY_STATE);
    mockIsSearchStateStale.mockReturnValue(false);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("outputs option details as JSON when --info --json", async () => {
    await runSelect(["--info", "1", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.optionId).toBe(OPT_UUID);
  });

  it("does not call API for --info mode", async () => {
    await runSelect(["--info", "1"]);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when info index is out of range", async () => {
    let err: unknown;
    try {
      await runSelect(["--info", "99"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.NOT_FOUND);
  });
});

// ── Tests: no cached state ────────────────────────────────────────────────

describe("select: no cached state", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue(null);
    mockFatal.mockReset();
    mockFatal.mockImplementation((msg: unknown) => { throw new Error(String(msg)); });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls fatal when no search state", async () => {
    let err: unknown;
    try {
      await runSelect(["1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(mockFatal).toHaveBeenCalled();
  });
});

// ── Tests: stale state warning ────────────────────────────────────────────

describe("select: stale state warning", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue(MOCK_ONEWAY_STATE);
    mockIsSearchStateStale.mockReturnValue(true);
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
    mockWarn.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls warn when state is stale", async () => {
    await runSelect(["1"]);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("2 hours"));
  });
});

// ── Tests: invalid number ─────────────────────────────────────────────────

describe("select: invalid number", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue(MOCK_ONEWAY_STATE);
    mockIsSearchStateStale.mockReturnValue(false);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("throws VALIDATION for non-numeric selection", async () => {
    let err: unknown;
    try {
      await runSelect(["abc"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND for out-of-range number", async () => {
    let err: unknown;
    try {
      await runSelect(["99"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.NOT_FOUND);
  });
});

// ── Tests: one-way flight (indexed mode) ──────────────────────────────────

describe("select: one-way flight (indexed mode)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue(MOCK_ONEWAY_STATE);
    mockIsSearchStateStale.mockReturnValue(false);
    mockClearSearchState.mockReset();
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls SET_TRIP_PLAN_SELECTED_OPTION for one-way flight", async () => {
    await runSelect(["1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ optionId: OPT_UUID })
    );
  });

  it("clears search state after selection", async () => {
    await runSelect(["1"]);
    expect(mockClearSearchState).toHaveBeenCalledTimes(1);
  });

  it("outputs JSON with planContext for --json mode", async () => {
    await runSelect(["1", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.planContext).toBeDefined();
    expect(parsed.planContext.planId).toBe("plan-123");
  });

  it("outputs agent markdown with ✅ for --agent mode", async () => {
    await runSelect(["1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("✅");
    expect(output).toContain("Selected");
  });
});

// ── Tests: hotel (indexed mode) ───────────────────────────────────────────

describe("select: hotel (indexed mode)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue(MOCK_HOTEL_STATE);
    mockIsSearchStateStale.mockReturnValue(false);
    mockGraphql.mockResolvedValue({
      setTripPlanSelectedOption: {
        id: "sel-hotel",
        selectedOption: { id: "hotel-1", name: "Grand Hotel", price: 200 },
      },
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls SET_TRIP_PLAN_SELECTED_OPTION for hotel", async () => {
    await runSelect(["1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ optionId: "hotel-1" })
    );
  });

  it("JSON type is hotel_selected", async () => {
    await runSelect(["1", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe("hotel_selected");
  });

  it("agent output includes hotel icon", async () => {
    await runSelect(["1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("🏨");
  });

  it("VOY-1718: JSON carries a chainNote about the room decision coming next", async () => {
    await runSelect(["1", "--json"]);
    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.chainNote).toContain("room decision");
    expect(parsed.chainNote).toContain("baseline rate");
  });

  it("VOY-1718: agent nextSteps tell the agent the room decision comes next", async () => {
    await runSelect(["1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("Room decision comes next");
    expect(output).toContain("plan-status");
  });
});

// ── Tests: VOY-1718 flight chain guidance (round trip) ─────────────────────

describe("select: flight round-trip chain guidance (VOY-1718)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue({
      type: "flights" as const,
      tripPlanId: "plan-123",
      selectionId: "sel-out",
      returnSelectionId: "sel-ret",
      results: [{ index: 1, optionId: OPT_UUID, summary: "LAX→NRT · AA · $1,200" }],
      timestamp: new Date().toISOString(),
    });
    mockIsSearchStateStale.mockReturnValue(false);
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("agent output keeps the return-leg guidance AND adds the Fare & Cabin note", async () => {
    await runSelect(["1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("RETURN leg");
    expect(output).toContain("Fare & Cabin");
    expect(output).toContain("Economy");
  });

  it("JSON carries a chainNote about picking Fare & Cabin in the CLI", async () => {
    await runSelect(["1", "--json"]);
    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.chainNote).toContain("Fare & Cabin");
  });
});

// ── Tests: round-trip departure (indexed mode) ────────────────────────────

describe("select: direct mode (--selection-id + --option-id)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls SET_TRIP_PLAN_SELECTED_OPTION in direct mode", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ selectionId: "sel-1", optionId: OPT_UUID })
    );
  });

  it("JSON output has success=true and type=option_selected", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.type).toBe("option_selected");
  });

  it("agent output has selected name", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("AA Flight");
  });

  it("throws VALIDATION when --selection-id provided without --option-id", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
  });

  // ── VOY-1828: reject garbage ids client-side before any API call ──────────

  it("rejects a literal \"null\" --option-id with VALIDATION and makes no API call", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", "null"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("--option-id");
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects a literal \"undefined\" --selection-id (case-insensitive) with VALIDATION, no API call", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "UNDEFINED", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("--selection-id");
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects an empty --selection-id with VALIDATION and makes no API call", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("lets valid-looking ids pass through to the API", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ selectionId: "sel-1", optionId: OPT_UUID })
    );
  });

  // ── VOY-2044: --option-id must be a FULL uuid, and an empty mutation
  // payload is an error, not a success ─────────────────────────────────────

  it.each([
    ["the first 8 characters of a uuid", OPT_UUID.slice(0, 8)],
    ["a uuid missing its last group", OPT_UUID.slice(0, 23)],
    ["a short opaque id", "opt-1"],
    ["a uuid with a non-hex character", "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f60z"],
  ])("rejects %s as --option-id with VALIDATION and makes no API call", async (_label, value) => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", value]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toBe(
      `Option id must be the full id shown in search results (a 36-character UUID). Received: ${value}`,
    );
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("accepts a full 36-character uuid --option-id and forwards it verbatim", async () => {
    expect(OPT_UUID).toHaveLength(36);
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ optionId: OPT_UUID })
    );
  });

  it("accepts an UPPERCASE uuid --option-id (hex case is not significant)", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID.toUpperCase()]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ optionId: OPT_UUID.toUpperCase() })
    );
  });

  it.each([
    ["a null payload", { setTripPlanSelectedOption: null }],
    ["an empty payload", {}],
    ["a payload with no selection id", { setTripPlanSelectedOption: { parentOptionId: null } }],
  ])("surfaces %s from the pick mutation as an error, not a success", async (_label, payload) => {
    mockGraphql.mockReset();
    mockGraphql.mockResolvedValue(payload);
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.API_ERROR);
    expect((err as CliError).message).toContain("The pick was not recorded");
    expect((err as CliError).message).toContain("selection-options sel-1");
    // Nothing success-shaped was printed.
    expect(stdoutOutput.join("")).toBe("");
  });

  it("surfaces an empty scoped-pick payload as an error too", async () => {
    mockGraphql.mockReset();
    mockGraphql.mockResolvedValue({ setTripPlanSelectionTravellerChoice: null });
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--traveller", "trav-a"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.API_ERROR);
    expect((err as CliError).message).toContain("The pick was not recorded");
  });
});

// ── Tests: participant-choice scopes (VOY-1692) ───────────────────────────

describe("select: participant-choice scope flags (VOY-1692)", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  const CHOICE_RESULT = { id: "sel-1", parentOptionId: OPT_UUID, parentOption: { id: OPT_UUID, name: "AA Flight", price: 900 } };

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("--traveller routes to setTripPlanSelectionTravellerChoice", async () => {
    mockGraphql.mockResolvedValue({ setTripPlanSelectionTravellerChoice: CHOICE_RESULT });
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--traveller", "trav-a"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectionTravellerChoice"),
      expect.objectContaining({ selectionId: "sel-1", optionId: OPT_UUID, travellerId: "trav-a" })
    );
  });

  it("--travellers routes to ForSubset with parsed IDs and replaceExisting=true", async () => {
    mockGraphql.mockResolvedValue({ setTripPlanTravellerChoiceForSubset: CHOICE_RESULT });
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--travellers", "trav-a, trav-b"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanTravellerChoiceForSubset"),
      expect.objectContaining({ travellerIds: ["trav-a", "trav-b"], replaceExisting: true })
    );
  });

  it("--group routes to ForGroup", async () => {
    mockGraphql.mockResolvedValue({ setTripPlanTravellerChoiceForGroup: CHOICE_RESULT });
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--group", "grp-1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanTravellerChoiceForGroup"),
      expect.objectContaining({ groupId: "grp-1", optionId: OPT_UUID })
    );
  });

  it("no scope flag defaults to setTripPlanSelectedOption (for-all alias)", async () => {
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ selectionId: "sel-1", optionId: OPT_UUID })
    );
  });

  it("throws VALIDATION when multiple scope flags are combined", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--traveller", "t1", "--group", "g1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it.each([
    ["--traveller", ""],
    ["--traveller", "   "],
    ["--travellers", ""],
    ["--group", " "],
  ])("rejects an empty %s value instead of silently selecting for ALL travellers", async (flag, value) => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, flag, value]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("empty value");
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("mutual exclusion fires even when one of the combined flags is empty", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--traveller", "", "--group", "g1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("trims whitespace around a scope flag value before sending", async () => {
    mockGraphql.mockResolvedValue({ setTripPlanSelectionTravellerChoice: CHOICE_RESULT });
    await runSelect(["--selection-id", "sel-1", "--option-id", OPT_UUID, "--traveller", "  trav-a  "]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectionTravellerChoice"),
      expect.objectContaining({ travellerId: "trav-a" })
    );
  });

  it("maps the list-mode rejection to actionable guidance", async () => {
    mockGraphql.mockRejectedValue(new Error("Cannot set traveller choices on a list-mode selection"));
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-list", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/DECISION selection/);
  });

  it("maps the option-not-found rejection to selection-options guidance", async () => {
    mockGraphql.mockRejectedValue(new Error("Option not found or does not belong to this selection"));
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", FOREIGN_OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/selection-options sel-1/);
  });
});

// ── Tests: fork-template guidance + auto-route (VOY-1872) ─────────────────

describe("select: fork-template selections (VOY-1872)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  // The backend rejection whose stable substring is "fork template".
  const FORK_TEMPLATE_ERROR = new Error(
    "Selection sel-template is a fork template and cannot take choices directly. " +
      "Target an existing choice row via upsertParticipantChoice(...) — rows come from " +
      "tripPlanChoicesView — or use the non-template fork selection.",
  );

  const PICK_RESULT = {
    setTripPlanSelectedOption: {
      id: "sel-sibling",
      parentOptionId: OPT_UUID,
      parentOption: { id: OPT_UUID, name: "AA Flight", price: 1200 },
    },
  };

  // getTripPlanSelection response used to resolve the rejected selection's
  // plan + type before listing siblings.
  const SELECTION_META = {
    getTripPlanSelection: { id: "sel-template", tripPlanId: "plan-9", type: "Flight" },
  };

  // Goal tree with a fork template (sel-template) and one same-type sibling
  // (sel-sibling), plus a different-type selection that must be ignored.
  function goalTree(siblingIds: string[]) {
    return {
      tripPlanGoals: [
        {
          id: "goal-other",
          items: [{ selections: [{ id: "sel-unrelated", type: "Hotel" }] }],
        },
        {
          id: "goal-flight",
          items: [
            {
              selections: [
                { id: "sel-template", type: "Flight" },
                { id: "sel-decoy", type: "Hotel" },
                ...siblingIds.map((id) => ({ id, type: "Flight" })),
              ],
            },
          ],
        },
      ],
    };
  }

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  // (a) error-mapping shape: zero siblings → FORK_TEMPLATE, no raw op names.
  it("maps the fork-template rejection to a FORK_TEMPLATE error without echoing GraphQL op names", async () => {
    mockGraphql
      .mockRejectedValueOnce(FORK_TEMPLATE_ERROR) // initial pick
      .mockResolvedValueOnce(SELECTION_META) // resolve plan + type
      .mockResolvedValueOnce(goalTree([])); // goal tree: no siblings

    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-template", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.FORK_TEMPLATE);
    expect((err as CliError).message).toContain("fork template");
    expect((err as CliError).message).toContain("voyagier plans goals plan-9 --tree");
    // Never leak the raw backend operation guidance.
    expect((err as CliError).message).not.toContain("upsertParticipantChoice");
    expect((err as CliError).message).not.toContain("tripPlanChoicesView");
    // details carry the resolved context for --json consumers.
    expect((err as CliError).details).toMatchObject({
      forkTemplateSelectionId: "sel-template",
      planId: "plan-9",
      selectionType: "Flight",
    });
  });

  // (b) auto-route success: exactly one sibling → retry lands the pick.
  it("auto-routes to the single same-type sibling and reports routedFrom (--json)", async () => {
    mockGraphql
      .mockRejectedValueOnce(FORK_TEMPLATE_ERROR) // initial pick on template
      .mockResolvedValueOnce(SELECTION_META) // resolve plan + type
      .mockResolvedValueOnce(goalTree(["sel-sibling"])) // exactly one sibling
      .mockResolvedValueOnce(PICK_RESULT); // retry pick succeeds

    await runSelect(["--selection-id", "sel-template", "--option-id", OPT_UUID, "--json"]);
    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.success).toBe(true);
    expect(parsed.selectionId).toBe("sel-sibling");
    expect(parsed.routedFrom).toBe("sel-template");
    // The retry must target the sibling, still on the for-all mutation.
    expect(mockGraphql).toHaveBeenLastCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ selectionId: "sel-sibling", optionId: OPT_UUID }),
    );
  });

  // (b') auto-route honors the original scope flags on the retry.
  it("retries against the sibling with the SAME --traveller scope", async () => {
    mockGraphql
      .mockRejectedValueOnce(FORK_TEMPLATE_ERROR)
      .mockResolvedValueOnce(SELECTION_META)
      .mockResolvedValueOnce(goalTree(["sel-sibling"]))
      .mockResolvedValueOnce({ setTripPlanSelectionTravellerChoice: PICK_RESULT.setTripPlanSelectedOption });

    await runSelect(["--selection-id", "sel-template", "--option-id", OPT_UUID, "--traveller", "trav-a", "--json"]);
    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.routedFrom).toBe("sel-template");
    expect(mockGraphql).toHaveBeenLastCalledWith(
      expect.stringContaining("setTripPlanSelectionTravellerChoice"),
      expect.objectContaining({ selectionId: "sel-sibling", optionId: OPT_UUID, travellerId: "trav-a" }),
    );
  });

  // (c) fallthrough — zero candidates: FORK_TEMPLATE error, no retry pick.
  it("does not route when there are zero same-type siblings", async () => {
    mockGraphql
      .mockRejectedValueOnce(FORK_TEMPLATE_ERROR)
      .mockResolvedValueOnce(SELECTION_META)
      .mockResolvedValueOnce(goalTree([])); // no siblings

    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-template", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.FORK_TEMPLATE);
    // Exactly 3 calls: initial pick + meta + goal tree. No retry pick.
    expect(mockGraphql).toHaveBeenCalledTimes(3);
  });

  // (c) fallthrough — multiple candidates: FORK_TEMPLATE error listing them.
  it("does not route when there are multiple same-type siblings, but lists them", async () => {
    mockGraphql
      .mockRejectedValueOnce(FORK_TEMPLATE_ERROR)
      .mockResolvedValueOnce(SELECTION_META)
      .mockResolvedValueOnce(goalTree(["sel-sibling-a", "sel-sibling-b"]));

    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-template", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.FORK_TEMPLATE);
    expect((err as CliError).message).toContain("sel-sibling-a");
    expect((err as CliError).message).toContain("sel-sibling-b");
    expect((err as CliError).details).toMatchObject({
      candidateSelectionIds: ["sel-sibling-a", "sel-sibling-b"],
    });
    // No retry pick attempted.
    expect(mockGraphql).toHaveBeenCalledTimes(3);
  });

  // Retry that itself fails must not retry again — emits FORK_TEMPLATE.
  it("falls through to FORK_TEMPLATE (no second retry) when the routed pick also fails", async () => {
    mockGraphql
      .mockRejectedValueOnce(FORK_TEMPLATE_ERROR) // initial pick
      .mockResolvedValueOnce(SELECTION_META)
      .mockResolvedValueOnce(goalTree(["sel-sibling"]))
      .mockRejectedValueOnce(new Error("sibling rejected too")); // retry fails

    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-template", "--option-id", OPT_UUID]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.FORK_TEMPLATE);
    // 4 calls total: initial + meta + tree + single retry. No further attempts.
    expect(mockGraphql).toHaveBeenCalledTimes(4);
  });
});


// ── Tests: one-way flight chain guidance (VOY-1718, PR #79 review) ─────────

describe("select: one-way flight — chain guidance has no 'both legs' claim", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "tok";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadSearchState.mockReturnValue({
      type: "flights" as const,
      tripPlanId: "plan-123",
      selectionId: "sel-out",
      // NO returnSelectionId — one-way itinerary.
      results: [{ index: 1, optionId: OPT_UUID, summary: "BWI→SIN · SQ · $900" }],
      timestamp: new Date().toISOString(),
    });
    mockIsSearchStateStale.mockReturnValue(false);
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("JSON chainNote points at Fare & Cabin next WITHOUT claiming a second leg", async () => {
    await runSelect(["1", "--json"]);
    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.chainNote).toContain("Fare & Cabin");
    expect(parsed.chainNote).not.toContain("both legs");
    expect(parsed.returnSelectionId).toBeUndefined();
  });

  it("agent output adds the Fare & Cabin next-pick line with no RETURN-leg guidance", async () => {
    await runSelect(["1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("Fare & Cabin");
    expect(output).not.toContain("RETURN leg");
  });
});
