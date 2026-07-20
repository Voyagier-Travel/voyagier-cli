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

const MOCK_ONEWAY_STATE = {
  type: "flights" as const,
  tripPlanId: "plan-123",
  selectionId: "sel-456",
  isRoundTrip: false,
  awaitingReturn: false,
  origin: "LAX",
  destination: "NRT",
  results: [
    { index: 1, optionId: "opt-1", flightToken: "tok-f1", summary: "LAX→NRT · AA · $1,200" },
    { index: 2, optionId: "opt-2", flightToken: "tok-f2", summary: "LAX→NRT · UA · $1,500" },
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
    { index: 1, optionId: "opt-1", flightToken: "tok-f1", summary: "LAX→NRT · AA · $1,200" },
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
    parentOptionId: "opt-1",
    parentOption: { id: "opt-1", name: "AA Flight", price: 1200 },
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
    expect(parsed.optionId).toBe("opt-1");
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
      expect.objectContaining({ optionId: "opt-1" })
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
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ selectionId: "sel-1", optionId: "opt-1" })
    );
  });

  it("JSON output has success=true and type=option_selected", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.type).toBe("option_selected");
  });

  it("agent output has selected name", async () => {
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1", "--agent"]);
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
});

// ── Tests: participant-choice scopes (VOY-1692) ───────────────────────────

describe("select: participant-choice scope flags (VOY-1692)", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  const CHOICE_RESULT = { id: "sel-1", parentOptionId: "opt-1", parentOption: { id: "opt-1", name: "AA Flight", price: 900 } };

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
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1", "--traveller", "trav-a"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectionTravellerChoice"),
      expect.objectContaining({ selectionId: "sel-1", optionId: "opt-1", travellerId: "trav-a" })
    );
  });

  it("--travellers routes to ForSubset with parsed IDs and replaceExisting=true", async () => {
    mockGraphql.mockResolvedValue({ setTripPlanTravellerChoiceForSubset: CHOICE_RESULT });
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1", "--travellers", "trav-a, trav-b"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanTravellerChoiceForSubset"),
      expect.objectContaining({ travellerIds: ["trav-a", "trav-b"], replaceExisting: true })
    );
  });

  it("--group routes to ForGroup", async () => {
    mockGraphql.mockResolvedValue({ setTripPlanTravellerChoiceForGroup: CHOICE_RESULT });
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1", "--group", "grp-1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanTravellerChoiceForGroup"),
      expect.objectContaining({ groupId: "grp-1", optionId: "opt-1" })
    );
  });

  it("no scope flag defaults to setTripPlanSelectedOption (for-all alias)", async () => {
    mockGraphql.mockResolvedValue(MOCK_SET_SELECTED);
    await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSelectedOption"),
      expect.objectContaining({ selectionId: "sel-1", optionId: "opt-1" })
    );
  });

  it("throws VALIDATION when multiple scope flags are combined", async () => {
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-1", "--option-id", "opt-1", "--traveller", "t1", "--group", "g1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("maps the list-mode rejection to actionable guidance", async () => {
    mockGraphql.mockRejectedValue(new Error("Cannot set traveller choices on a list-mode selection"));
    let err: unknown;
    try {
      await runSelect(["--selection-id", "sel-list", "--option-id", "opt-1"]);
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
      await runSelect(["--selection-id", "sel-1", "--option-id", "opt-foreign"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/selection-options sel-1/);
  });
});

