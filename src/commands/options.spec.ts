import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();
const mockSaveOptionsState = jest.fn();
const mockLoadOptionsState = jest.fn();
const mockClearOptionsState = jest.fn();
const mockProgress = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});
const mockJsonOutputWithPlan = jest.fn().mockImplementation((data: unknown, planId: string, planTitle?: string) => {
  process.stdout.write(JSON.stringify({ ...(data as object), planContext: { planId, title: planTitle } }) + "\n");
});

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../state.js", () => ({
  saveOptionsState: mockSaveOptionsState,
  loadOptionsState: mockLoadOptionsState,
  clearOptionsState: mockClearOptionsState,
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://api.test.voyagier.com/graphql"),
  CONFIG_DIR: "/tmp/test-config",
}));

jest.unstable_mockModule("../utils.js", () => ({
  formatPrice: jest.fn().mockImplementation((p: unknown) => `$${p}`),
  subSelectionLabel: jest.fn().mockReturnValue("cabin class"),
  deriveBaseUrl: jest.fn().mockReturnValue("https://app.voyagier.com"),
}));

jest.unstable_mockModule("../hints.js", () => ({
  hintCabinClass: jest.fn().mockReturnValue(""),
  hintHotelRoom: jest.fn().mockReturnValue(""),
}));

jest.unstable_mockModule("../output.js", () => ({
  progress: mockProgress,
  jsonOutput: mockJsonOutput,
  jsonOutputWithPlan: mockJsonOutputWithPlan,
}));

// ── Dynamic imports after mocks ────────────────────────────────────────────

let registerOptionsCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./options.js");
  registerOptionsCommands = mod.registerOptionsCommands;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

// New model: item.selections[] where the chosen option (parentOptionId === options[].id)
// carries childSelections[] (the "sub-selections" — cabin class, room type, etc.).
const MOCK_PLAN_WITH_SUBS = {
  tripPlan: {
    id: "plan-123",
    title: "Paris Trip",
    items: [
      {
        id: "item-1",
        title: "Flight DCA→CDG",
        type: "Selection",
        selections: [
          {
            id: "sel-1",
            type: "Flight",
            isLocked: false,
            parentOptionId: "opt-1",
            options: [
              {
                id: "opt-1",
                name: "AA 100",
                price: 600,
                status: "ACTIVE",
                isBookable: true,
                sortOrder: 0,
                childSelections: [
                  {
                    id: "sub-1",
                    type: "FLIGHT_CLASS",
                    isLocked: false,
                    parentOptionId: null,
                    options: [
                      { id: "eco-1", name: "Economy", price: 0, optionType: "CABIN", status: "ACTIVE", isBookable: true, sortOrder: 0 },
                      { id: "biz-1", name: "Business", price: 500, optionType: "CABIN", status: "ACTIVE", isBookable: true, sortOrder: 1 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const MOCK_PLAN_NO_SUBS = {
  tripPlan: {
    id: "plan-123",
    title: "Paris Trip",
    items: [
      {
        id: "item-1",
        title: "Flight DCA→CDG",
        type: "Selection",
        selections: [
          {
            id: "sel-1",
            type: "Flight",
            isLocked: false,
            parentOptionId: "opt-1",
            options: [
              { id: "opt-1", name: "AA 100", price: 600, status: "ACTIVE", isBookable: true, sortOrder: 0, childSelections: [] },
            ],
          },
        ],
      },
    ],
  },
};

const MOCK_SET_SUB_SELECTION = {
  setTripPlanSubSelectionOption: {
    id: "sub-1",
    selectedOptionId: "eco-1",
    selectedOption: { id: "eco-1", name: "Economy", price: 0 },
  },
};

const MOCK_OPTIONS_STATE = {
  tripPlanId: "plan-123",
  results: [
    { index: 1, subSelectionId: "sub-1", optionId: "eco-1", summary: "Economy · $0" },
    { index: 2, subSelectionId: "sub-1", optionId: "biz-1", summary: "Business · $500" },
  ],
  timestamp: new Date().toISOString(),
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function runOptions(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerOptionsCommands(program);
  await program.parseAsync(["node", "voyagier", "options", ...args]);
}

async function runPick(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerOptionsCommands(program);
  await program.parseAsync(["node", "voyagier", "pick", ...args]);
}

// ── Tests: options command (human output) ─────────────────────────────────

describe("options: list sub-selections (human output)", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockResolvedValue(MOCK_PLAN_WITH_SUBS);
    mockSaveOptionsState.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("fetches plan via GET_PLAN_DEEP and saves options state", async () => {
    await runOptions(["plan-123"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("TripPlanDeep"),
      expect.objectContaining({ id: "plan-123" })
    );
    expect(mockSaveOptionsState).toHaveBeenCalledWith(
      expect.objectContaining({ tripPlanId: "plan-123" })
    );
  });

  it("saves state with correct number of option results (Economy + Business)", async () => {
    await runOptions(["plan-123"]);
    const call = mockSaveOptionsState.mock.calls[0][0] as { results: unknown[] };
    expect(call.results).toHaveLength(2);
  });
});

// ── Tests: options --json ─────────────────────────────────────────────────

describe("options: --json output", () => {
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
    mockGraphql.mockResolvedValue(MOCK_PLAN_WITH_SUBS);
    mockSaveOptionsState.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("outputs valid JSON with planId and subSelections array", async () => {
    await runOptions(["plan-123", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.planId).toBe("plan-123");
    expect(parsed.subSelections).toBeInstanceOf(Array);
    expect(parsed.subSelections).toHaveLength(1);
    expect(parsed.subSelections[0].type).toBe("FLIGHT_CLASS");
  });

  it("JSON options have index, name, and id fields", async () => {
    await runOptions(["plan-123", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    const opt = parsed.subSelections[0].options[0];
    expect(opt.index).toBe(1);
    expect(opt.name).toBe("Economy");
    expect(opt.id).toBe("eco-1");
  });

  it("JSON options are sorted by sortOrder", async () => {
    await runOptions(["plan-123", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    const opts = parsed.subSelections[0].options;
    expect(opts[0].name).toBe("Economy");
    expect(opts[1].name).toBe("Business");
  });
});

// ── Tests: options --agent ────────────────────────────────────────────────

describe("options: --agent output", () => {
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
    mockGraphql.mockResolvedValue(MOCK_PLAN_WITH_SUBS);
    mockSaveOptionsState.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("outputs markdown header with plan title", async () => {
    await runOptions(["plan-123", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("## Sub-options");
    expect(output).toContain("Paris Trip");
  });

  it("includes numbered options in agent output", async () => {
    await runOptions(["plan-123", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("1.");
    expect(output).toContain("Economy");
    expect(output).toContain("2.");
    expect(output).toContain("Business");
  });

  it("includes pick command hint in agent output", async () => {
    await runOptions(["plan-123", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("voyagier pick");
  });
});

// ── Tests: options with no sub-selections ────────────────────────────────

describe("options: no sub-selections", () => {
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
    mockGraphql.mockResolvedValue(MOCK_PLAN_NO_SUBS);
    mockSaveOptionsState.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("saves empty results state when no sub-selections", async () => {
    await runOptions(["plan-123"]);
    expect(mockSaveOptionsState).toHaveBeenCalledWith(
      expect.objectContaining({ results: [] })
    );
  });

  it("agent output says no choices needed", async () => {
    await runOptions(["plan-123", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("No sub-selection choices needed");
  });

  it("JSON has empty subSelections array", async () => {
    await runOptions(["plan-123", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.subSelections).toHaveLength(0);
  });
});

// ── Tests: options --refresh ──────────────────────────────────────────────

describe("options: --refresh", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockSaveOptionsState.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls REFRESH_SUB_SELECTION for each sub-selection when --refresh", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_WITH_SUBS);
      if (query.includes("refreshTripPlanSubSelectionOptions")) return Promise.resolve({
        refreshTripPlanSubSelectionOptions: [
          { id: "eco-1", name: "Economy", price: 0, optionType: "CABIN", status: "ACTIVE", isBookable: true, sortOrder: 0 },
        ],
      });
      return Promise.reject(new Error(`Unexpected: ${query.slice(0, 40)}`));
    });

    await runOptions(["plan-123", "--refresh"]);
    const calls = mockGraphql.mock.calls as [string][];
    expect(calls.some(([q]) => q.includes("refreshTripPlanSubSelectionOptions"))).toBe(true);
  });
});

// ── Tests: pick command (indexed mode) ───────────────────────────────────

describe("pick: indexed mode", () => {
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
    mockLoadOptionsState.mockReturnValue(MOCK_OPTIONS_STATE);
    mockClearOptionsState.mockReset();
    mockGraphql.mockResolvedValue(MOCK_SET_SUB_SELECTION);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls SET_SUB_SELECTION with correct IDs from state", async () => {
    await runPick(["1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSubSelectionOption"),
      expect.objectContaining({ subSelectionId: "sub-1", optionId: "eco-1" })
    );
  });

  it("clears options state after pick", async () => {
    await runPick(["1"]);
    expect(mockClearOptionsState).toHaveBeenCalledTimes(1);
  });

  it("JSON output has planContext with planId", async () => {
    await runPick(["1", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.planContext?.planId).toBe("plan-123");
    expect(parsed.selected?.name).toBe("Economy");
  });

  it("agent output contains selected name and next step", async () => {
    await runPick(["1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("Economy");
    expect(output).toContain("✅");
    expect(output).toContain("voyagier cart");
  });
});

// ── Tests: pick with no state ─────────────────────────────────────────────

describe("pick: no options state", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadOptionsState.mockReturnValue(null);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("throws VALIDATION with helpful message when no options state", async () => {
    let err: unknown;
    try {
      await runPick(["1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("No options context");
  });
});

// ── Tests: pick with invalid number ──────────────────────────────────────

describe("pick: invalid number", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockLoadOptionsState.mockReturnValue(MOCK_OPTIONS_STATE);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("throws VALIDATION for non-numeric input", async () => {
    let err: unknown;
    try {
      await runPick(["abc"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
  });

  it("throws NOT_FOUND for out-of-range number", async () => {
    let err: unknown;
    try {
      await runPick(["99"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.NOT_FOUND);
  });
});

// ── Tests: pick direct mode ───────────────────────────────────────────────

describe("pick: direct mode (--sub-selection-id + --option-id)", () => {
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
    mockGraphql.mockResolvedValue(MOCK_SET_SUB_SELECTION);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls SET_SUB_SELECTION in direct mode", async () => {
    await runPick(["1", "--sub-selection-id", "sub-1", "--option-id", "eco-1"]);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("setTripPlanSubSelectionOption"),
      expect.objectContaining({ subSelectionId: "sub-1", optionId: "eco-1" })
    );
  });

  it("JSON output in direct mode has selected.name", async () => {
    await runPick(["1", "--sub-selection-id", "sub-1", "--option-id", "eco-1", "--json"]);
    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.selected?.name).toBe("Economy");
  });

  it("agent output in direct mode shows selected name with checkmark", async () => {
    await runPick(["1", "--sub-selection-id", "sub-1", "--option-id", "eco-1", "--agent"]);
    const output = stdoutOutput.join("");
    expect(output).toContain("Economy");
    expect(output).toContain("✅");
  });

  it("throws VALIDATION when only --sub-selection-id provided without --option-id", async () => {
    let err: unknown;
    try {
      await runPick(["1", "--sub-selection-id", "sub-1"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
  });
});
