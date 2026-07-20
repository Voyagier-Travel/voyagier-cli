import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();
const mockLoadSearchState = jest.fn();
const mockSaveSearchState = jest.fn();
const mockClearSearchState = jest.fn();
const mockIsSearchStateStale = jest.fn().mockReturnValue(false);
const mockLoadOptionsState = jest.fn();
const mockClearOptionsState = jest.fn();

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
  loadOptionsState: mockLoadOptionsState,
  saveOptionsState: jest.fn(),
  clearOptionsState: mockClearOptionsState,
}));

jest.unstable_mockModule("../plan-footer.js", () => ({
  printPlanFooter: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://api.test.voyagier.com/graphql"),
  CONFIG_DIR: "/tmp/test-voyagier-config",
}));

jest.unstable_mockModule("../formatters.js", () => ({
  formatFlights: jest.fn().mockReturnValue(""),
}));

jest.unstable_mockModule("../hints.js", () => ({
  hintFlightSelected: jest.fn().mockReturnValue(""),
  hintHotelSelected: jest.fn().mockReturnValue(""),
  hintCabinClass: jest.fn().mockReturnValue(""),
  hintHotelRoom: jest.fn().mockReturnValue(""),
}));

jest.unstable_mockModule("../utils.js", () => ({
  extractFlightToken: jest.fn().mockReturnValue("tok-return"),
  buildFlightSummary: jest.fn().mockReturnValue("NRT→LAX · AA · $900.00 · 11h 00m"),
  deriveBaseUrl: jest.fn().mockReturnValue("https://app.voyagier.com"),
  formatPrice: jest.fn().mockImplementation((p: unknown) => `$${p}`),
  shellArg: jest.fn().mockImplementation((v: unknown) => String(v ?? "")),
  subSelectionLabel: jest.fn().mockReturnValue("cabin class"),
}));

// ── Dynamic imports after mocks ────────────────────────────────────────────

let registerSelectCommands: (program: Command) => void;

beforeAll(async () => {
  const selectMod = await import("./select.js");
  registerSelectCommands = selectMod.registerSelectCommands;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const MOCK_SEARCH_STATE = {
  type: "flights" as const,
  tripPlanId: "plan-123",
  selectionId: "sel-456",
  isRoundTrip: false,
  awaitingReturn: false,
  results: [
    { index: 1, optionId: "opt-1", summary: "LAX→NRT · AA · $1,200.00 · 11h 30m" },
  ],
  timestamp: new Date().toISOString(),
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function runSelect(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSelectCommands(program);
  await program.parseAsync(["node", "voyagier", "select", ...args]);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("select --plan safety rail", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
    mockLoadSearchState.mockReset();
    mockSaveSearchState.mockReset();
    mockClearSearchState.mockReset();
    mockIsSearchStateStale.mockReturnValue(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  it("throws VALIDATION when --plan does not match cached state tripPlanId", async () => {
    mockLoadSearchState.mockReturnValue({ ...MOCK_SEARCH_STATE, tripPlanId: "plan-123" });

    let err: unknown;
    try {
      await runSelect(["1", "--plan", "plan-WRONG"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("Plan mismatch");
    expect((err as CliError).message).toContain("plan-123");
    expect((err as CliError).message).toContain("plan-WRONG");
  });

  it("mismatch error includes re-run hint with requested plan", async () => {
    mockLoadSearchState.mockReturnValue({ ...MOCK_SEARCH_STATE, tripPlanId: "plan-ABC" });

    let err: unknown;
    try {
      await runSelect(["1", "--plan", "plan-XYZ"]);
    } catch (e) {
      err = e;
    }

    expect((err as CliError).message).toContain("Re-run your search with --plan plan-XYZ");
  });

  it("proceeds without error when --plan matches cached tripPlanId", async () => {
    mockLoadSearchState.mockReturnValue({ ...MOCK_SEARCH_STATE, tripPlanId: "plan-123" });
    mockGraphql.mockResolvedValue({
      setTripPlanSelectedOption: { id: "sel-456", selectedOption: { id: "opt-1", name: "AA Flight" } },
    });

    await expect(runSelect(["1", "--plan", "plan-123"])).resolves.toBeUndefined();
  });

  it("proceeds without error when --plan is omitted (backward compat)", async () => {
    mockLoadSearchState.mockReturnValue({ ...MOCK_SEARCH_STATE });
    mockGraphql.mockResolvedValue({
      setTripPlanSelectedOption: { id: "sel-456", selectedOption: { id: "opt-1", name: "AA Flight" } },
    });

    await expect(runSelect(["1"])).resolves.toBeUndefined();
  });

  it("does not make API calls before throwing the plan mismatch error", async () => {
    mockLoadSearchState.mockReturnValue({ ...MOCK_SEARCH_STATE, tripPlanId: "plan-123" });

    try {
      await runSelect(["1", "--plan", "plan-OTHER"]);
    } catch {
      // expected
    }

    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

describe("jsonOutputWithPlan", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stdoutOutput: string[];

  beforeEach(() => {
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("injects planContext with planId into JSON output", async () => {
    const { jsonOutputWithPlan } = await import("../output.js");
    jsonOutputWithPlan({ success: true, type: "flight_selected" }, "plan-999");

    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.planContext).toBeDefined();
    expect(parsed.planContext.planId).toBe("plan-999");
  });

  it("preserves original data fields alongside planContext", async () => {
    const { jsonOutputWithPlan } = await import("../output.js");
    jsonOutputWithPlan({ success: true, selected: "AA175" }, "plan-42");

    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toBe("AA175");
    expect(parsed.planContext.planId).toBe("plan-42");
  });

  it("includes title in planContext when provided", async () => {
    const { jsonOutputWithPlan } = await import("../output.js");
    jsonOutputWithPlan({ foo: "bar" }, "plan-1", "Tokyo Trip");

    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.planContext.planId).toBe("plan-1");
    expect(parsed.planContext.title).toBe("Tokyo Trip");
  });

  it("title is undefined in planContext when omitted", async () => {
    const { jsonOutputWithPlan } = await import("../output.js");
    jsonOutputWithPlan({ foo: "bar" }, "plan-1");

    const parsed = JSON.parse(stdoutOutput.join(""));
    expect(parsed.planContext.planId).toBe("plan-1");
    expect(parsed.planContext.title).toBeUndefined();
  });
});
