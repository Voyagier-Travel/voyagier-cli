import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../../errors.js";

const mockGraphql = jest.fn();

jest.unstable_mockModule("../../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

let registerGoalCommands: (plans: Command) => void;
let normalizeSelectionType: (v: string) => string;
let normalizeSelectionScope: (v: string) => string;
let parseTravellerIds: (csv: string) => string[];
let parseCsvIds: (csv: string, flag: string, opts?: { dedupe?: boolean }) => string[];
let parseInitialQuery: (json: string) => Record<string, unknown>;
let parseGoalDate: (iso: string) => string;
let computeReorderUpdates: (
  goals: Array<{ id: string; sortOrder: number }>,
  orderIds: string[],
) => Array<{ id: string; sortOrder: number }>;

beforeAll(async () => {
  const mod = await import("./goals.js");
  registerGoalCommands = mod.registerGoalCommands;
  normalizeSelectionType = mod.normalizeSelectionType;
  normalizeSelectionScope = mod.normalizeSelectionScope;
  parseTravellerIds = mod.parseTravellerIds;
  parseCsvIds = mod.parseCsvIds;
  parseInitialQuery = mod.parseInitialQuery;
  parseGoalDate = mod.parseGoalDate;
  computeReorderUpdates = mod.computeReorderUpdates;
});

beforeEach(() => {
  mockGraphql.mockReset();
});

// Stub stdout so log spam doesn't pollute test output but jsonOutput can be inspected.
let logSpy: jest.SpiedFunction<typeof console.log>;
let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let writes: string[];
beforeEach(() => {
  writes = [];
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
});
afterEach(() => {
  logSpy.mockRestore();
  writeSpy.mockRestore();
});

function lastJsonOutput(): any {
  // jsonOutput in src/output.ts uses process.stdout.write with pretty-printed JSON.
  const joined = writes.join("");
  // Find the last balanced JSON object in the stream.
  const trimmed = joined.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

async function runGoals(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerGoalCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", ...args]);
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

describe("normalizeSelectionType", () => {
  it("accepts canonical PascalCase", () => {
    expect(normalizeSelectionType("Hotel")).toBe("Hotel");
    expect(normalizeSelectionType("HotelRoom")).toBe("HotelRoom");
    expect(normalizeSelectionType("FlightJourneyList")).toBe("FlightJourneyList");
  });
  it("accepts lowercase and uppercase", () => {
    expect(normalizeSelectionType("hotel")).toBe("Hotel");
    expect(normalizeSelectionType("HOTEL")).toBe("Hotel");
    expect(normalizeSelectionType("hotelroom")).toBe("HotelRoom");
  });
  it("accepts mixed case with whitespace", () => {
    expect(normalizeSelectionType("  Activity  ")).toBe("Activity");
  });
  it("rejects unknown types with the full allow-list", () => {
    try {
      normalizeSelectionType("nonsense");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      expect((err as CliError).message).toContain("Hotel");
      expect((err as CliError).message).toContain("Activity");
    }
  });
  it("rejects empty / non-string", () => {
    expect(() => normalizeSelectionType("")).toThrow(CliError);
    expect(() => normalizeSelectionType("   ")).toThrow(CliError);
    // @ts-expect-error testing non-string input
    expect(() => normalizeSelectionType(undefined)).toThrow(CliError);
  });
});

describe("normalizeSelectionScope", () => {
  it("accepts canonical PascalCase", () => {
    expect(normalizeSelectionScope("Group")).toBe("Group");
    expect(normalizeSelectionScope("Traveller")).toBe("Traveller");
    expect(normalizeSelectionScope("Trip")).toBe("Trip");
  });
  it("accepts lowercase", () => {
    expect(normalizeSelectionScope("trip")).toBe("Trip");
    expect(normalizeSelectionScope("group")).toBe("Group");
  });
  it("rejects unknown scopes", () => {
    try {
      normalizeSelectionScope("Plan");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("Group, Traveller, Trip");
    }
  });
  it("rejects empty", () => {
    expect(() => normalizeSelectionScope("")).toThrow(CliError);
  });
});

describe("parseCsvIds", () => {
  it("splits, trims, dedupes by default", () => {
    expect(parseCsvIds("a, b , c", "--x")).toEqual(["a", "b", "c"]);
    expect(parseCsvIds("a,a,b", "--x")).toEqual(["a", "b"]);
  });
  it("preserves duplicates when dedupe=false", () => {
    expect(parseCsvIds("a,a,b", "--x", { dedupe: false })).toEqual(["a", "a", "b"]);
  });
  it("rejects empty CSV with the flag name in the error", () => {
    try {
      parseCsvIds("", "--travellers");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("--travellers");
    }
  });
  it("rejects non-string input", () => {
    // @ts-expect-error testing non-string input
    expect(() => parseCsvIds(123, "--x")).toThrow(CliError);
  });
});

describe("parseTravellerIds", () => {
  it("delegates to parseCsvIds with --travellers label", () => {
    expect(parseTravellerIds("t-1, t-2 , t-1")).toEqual(["t-1", "t-2"]);
  });
  it("error message references --travellers", () => {
    try {
      parseTravellerIds(",  ,  ");
      fail("expected throw");
    } catch (err) {
      expect((err as CliError).message).toContain("--travellers");
    }
  });
});

describe("parseInitialQuery", () => {
  it("parses a JSON object", () => {
    expect(parseInitialQuery('{"query":"hotel"}')).toEqual({ query: "hotel" });
  });
  it("rejects invalid JSON", () => {
    try {
      parseInitialQuery("{not json");
      fail("expected throw");
    } catch (err) {
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    }
  });
  it("rejects non-objects (arrays, primitives)", () => {
    expect(() => parseInitialQuery("[1,2]")).toThrow(CliError);
    expect(() => parseInitialQuery('"plain"')).toThrow(CliError);
    expect(() => parseInitialQuery("123")).toThrow(CliError);
  });
  it("rejects empty input", () => {
    expect(() => parseInitialQuery("")).toThrow(CliError);
    expect(() => parseInitialQuery("   ")).toThrow(CliError);
  });
});

describe("parseGoalDate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(parseGoalDate("2026-05-04")).toBe("2026-05-04");
  });
  it("accepts ISO datetime with Z", () => {
    expect(parseGoalDate("2026-05-04T13:30:00Z")).toBe("2026-05-04T13:30:00Z");
  });
  it("accepts ISO datetime with numeric offset (colon)", () => {
    expect(parseGoalDate("2026-05-04T13:30:00-04:00")).toBe("2026-05-04T13:30:00-04:00");
  });
  it("accepts ISO datetime with numeric offset (no colon)", () => {
    expect(parseGoalDate("2026-05-04T13:30:00-0400")).toBe("2026-05-04T13:30:00-0400");
  });
  it("accepts ISO datetime with milliseconds", () => {
    expect(parseGoalDate("2026-05-04T13:30:00.123Z")).toBe("2026-05-04T13:30:00.123Z");
  });
  it("accepts ISO datetime without seconds", () => {
    expect(parseGoalDate("2026-05-04T13:30Z")).toBe("2026-05-04T13:30Z");
  });
  it("rejects garbage strings", () => {
    expect(() => parseGoalDate("yesterday")).toThrow(CliError);
  });
  it("rejects locale-style strings like 'May 4 2026' (Date.parse would accept these)", () => {
    expect(() => parseGoalDate("May 4 2026")).toThrow(CliError);
    expect(() => parseGoalDate("5/4/2026")).toThrow(CliError);
    expect(() => parseGoalDate("2026/05/04")).toThrow(CliError);
    expect(() => parseGoalDate("2026-5-4")).toThrow(CliError);
  });
  it("rejects ISO-shaped but out-of-range months", () => {
    expect(() => parseGoalDate("2026-13-01")).toThrow(CliError);
    expect(() => parseGoalDate("2026-99-99")).toThrow(CliError);
    // Note: Node's Date.parse rolls 2026-02-30 forward to March 2 rather
    // than rejecting. We accept that quirk — the server is the final
    // authority on calendar correctness.
  });
  it("rejects empty", () => {
    expect(() => parseGoalDate("")).toThrow(CliError);
  });
});

describe("computeReorderUpdates", () => {
  const G = (id: string, sortOrder: number) => ({ id, sortOrder });

  it("returns the minimal change set on a full reverse", () => {
    const goals = [G("a", 1), G("b", 2), G("c", 3)];
    const updates = computeReorderUpdates(goals, ["c", "b", "a"]);
    expect(updates).toEqual([
      { id: "c", sortOrder: 1 },
      { id: "a", sortOrder: 3 },
    ]);
    // 'b' is unchanged (was 2, stays 2) so it's skipped.
  });

  it("returns empty list on no-op (already sorted)", () => {
    const goals = [G("a", 1), G("b", 2), G("c", 3)];
    expect(computeReorderUpdates(goals, ["a", "b", "c"])).toEqual([]);
  });

  it("rejects when --order length mismatches goals length", () => {
    const goals = [G("a", 1), G("b", 2), G("c", 3)];
    try {
      computeReorderUpdates(goals, ["a", "b"]);
      fail("expected throw");
    } catch (err) {
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      expect((err as CliError).message).toContain("3");
    }
  });

  it("rejects unknown ids in --order", () => {
    const goals = [G("a", 1), G("b", 2)];
    expect(() => computeReorderUpdates(goals, ["a", "z"])).toThrow(CliError);
  });

  it("rejects missing ids (goal absent from --order)", () => {
    const goals = [G("a", 1), G("b", 2)];
    // Length matches, but b is missing — must include b
    expect(() => computeReorderUpdates(goals, ["a", "a"])).toThrow(CliError);
  });

  it("rejects duplicates in --order", () => {
    const goals = [G("a", 1), G("b", 2)];
    try {
      computeReorderUpdates(goals, ["a", "a"]);
      fail("expected throw");
    } catch (err) {
      // Either "missing b" or "duplicates" — both are correct VALIDATION reasons.
      // The "missing b" check fires first; that's fine.
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    }
  });

  it("handles single-goal plans", () => {
    expect(computeReorderUpdates([G("solo", 1)], ["solo"])).toEqual([]);
  });

  it("handles empty plans (empty --order)", () => {
    expect(computeReorderUpdates([], [])).toEqual([]);
  });

  it("normalizes sortOrder to 1-indexed even when current values are sparse", () => {
    const goals = [G("a", 5), G("b", 10), G("c", 15)];
    const updates = computeReorderUpdates(goals, ["a", "b", "c"]);
    expect(updates).toEqual([
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
      { id: "c", sortOrder: 3 },
    ]);
  });
});

// --------------------------------------------------------------------------
// Command tests (mocked graphql)
// --------------------------------------------------------------------------

const GOAL_FIXTURE = {
  id: "g-1",
  name: "Paris hotel",
  type: "Hotel",
  scope: "Trip",
  sortOrder: 1,
  relativeDay: 0,
  date: null,
  isFulfilled: false,
  includeAllTravellers: true,
  groupName: null,
  primaryItemId: null,
  tripPlanId: "plan-1",
};

describe("plans goals <planId>", () => {
  it("returns sorted goals in --json mode", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanGoals: [
        { ...GOAL_FIXTURE, id: "g-2", sortOrder: 2, name: "Activity day 1" },
        { ...GOAL_FIXTURE, id: "g-1", sortOrder: 1, name: "Paris hotel" },
      ],
    });
    await runGoals(["goals", "plan-1", "--json"]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.goals.map((g: any) => g.id)).toEqual(["g-1", "g-2"]);
    expect(out.data.count).toBe(2);
  });

  it("returns empty list cleanly", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanGoals: [] });
    await runGoals(["goals", "plan-x", "--json"]);
    const out = lastJsonOutput();
    expect(out.data.goals).toEqual([]);
    expect(out.data.count).toBe(0);
  });

  it("--tree uses the deep query", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanGoals: [{ ...GOAL_FIXTURE, items: [], travellers: [] }],
    });
    await runGoals(["goals", "plan-1", "--tree", "--json"]);
    const call = mockGraphql.mock.calls[0];
    expect((call[0] as string)).toContain("TripPlanGoalsDeep");
  });
});

describe("plans goal <goalId>", () => {
  it("returns the goal in --json mode", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanGoal: { ...GOAL_FIXTURE, items: [{ id: "i-1", title: "Bristol", goalId: "g-1", selections: [] }] },
    });
    await runGoals(["goal", "g-1", "--json"]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.goal.id).toBe("g-1");
    expect(out.data.goal.items).toHaveLength(1);
  });

  it("throws GOAL_NOT_FOUND on null", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanGoal: null });
    await expect(runGoals(["goal", "g-x", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.GOAL_NOT_FOUND,
    });
  });
});

describe("plans goal-add <planId>", () => {
  it("creates with minimum flags (--type only; auto-defaults name)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } });
    await runGoals(["goal-add", "plan-1", "--type", "Hotel", "--json"]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.goal.id).toBe("g-1");
    expect(out.data.travellersAssigned).toEqual([]);

    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).input).toMatchObject({
      tripPlanId: "plan-1",
      type: "Hotel",
      name: "Hotel goal",
    });
  });

  it("passes through optional fields and normalizes scope", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } });
    await runGoals([
      "goal-add", "plan-1",
      "--type", "Hotel",
      "--name", "Paris hotel",
      "--relative-day", "3",
      "--sort-order", "2",
      "--scope", "trip",
      "--date", "2026-05-04",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).input).toEqual({
      tripPlanId: "plan-1",
      type: "Hotel",
      name: "Paris hotel",
      relativeDay: 3,
      sortOrder: 2,
      scope: "Trip",
      date: "2026-05-04",
    });
  });

  it("rejects bad --type with the full allow-list", async () => {
    await expect(
      runGoals(["goal-add", "plan-1", "--type", "Spaceship", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects non-integer --sort-order", async () => {
    await expect(
      runGoals(["goal-add", "plan-1", "--type", "Hotel", "--sort-order", "1.5", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("calls assignTravellersToGoal after a successful create when --travellers given", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } })
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockResolvedValueOnce({ tripPlanGoal: { ...GOAL_FIXTURE, travellers: [{ id: "t-1" }, { id: "t-2" }] } });
    await runGoals([
      "goal-add", "plan-1", "--type", "Hotel",
      "--travellers", "t-1, t-2 , t-1",
      "--json",
    ]);
    expect(mockGraphql).toHaveBeenCalledTimes(3);
    const [, assignVars] = mockGraphql.mock.calls[1];
    expect(assignVars).toEqual({ goalId: "g-1", travellerIds: ["t-1", "t-2"] });
    const out = lastJsonOutput();
    expect(out.data.travellersAssigned).toEqual(["t-1", "t-2"]);
    expect(out.data.warning).toBeUndefined();
  });

  it("reports server-verified subset when server drops unknown ids after create+assign", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } })
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockResolvedValueOnce({ tripPlanGoal: { ...GOAL_FIXTURE, travellers: [{ id: "t-1" }] } });
    await runGoals([
      "goal-add", "plan-1", "--type", "Hotel",
      "--travellers", "t-1, t-99",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.travellersAssigned).toEqual(["t-1"]);
    expect(out.data.warning).toBeUndefined();
  });

  it("falls back to requested ids with travellersWarning when re-fetch fails after create+assign", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } })
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockRejectedValueOnce(new Error("re-fetch network error"));
    await runGoals([
      "goal-add", "plan-1", "--type", "Hotel",
      "--travellers", "t-1, t-2",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.travellersAssigned).toEqual(["t-1", "t-2"]);
    expect(out.data.warning).toContain("re-fetch failed");
    expect(out.data.goal.id).toBe("g-1");
  });

  it("surfaces traveller-assign failure as a non-fatal warning", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } })
      .mockRejectedValueOnce(new Error("traveller t-99 not on plan"));
    await runGoals([
      "goal-add", "plan-1", "--type", "Hotel",
      "--travellers", "t-99",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.travellersAssigned).toEqual([]);
    expect(out.data.warning).toContain("traveller t-99 not on plan");
    expect(out.data.goal.id).toBe("g-1");
  });

  it("sets travellersAssigned:[] and surfaces warning when server returns false for assignment", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } })
      .mockResolvedValueOnce({ assignTravellersToGoal: false });
    await runGoals([
      "goal-add", "plan-1", "--type", "Hotel",
      "--travellers", "t-1",
      "--json",
    ]);
    expect(mockGraphql).toHaveBeenCalledTimes(2); // no re-fetch when assign returns false
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.travellersAssigned).toEqual([]);
    expect(out.data.warning).toContain("server rejected traveller assignment");
    expect(out.data.goal.id).toBe("g-1");
  });

  it("sets travellersAssigned:null and surfaces warning when re-fetch returns null goal after create+assign", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlanGoal: { ...GOAL_FIXTURE } })
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockResolvedValueOnce({ tripPlanGoal: null });
    await runGoals([
      "goal-add", "plan-1", "--type", "Hotel",
      "--travellers", "t-1, t-2",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.travellersAssigned).toBeNull();
    expect(out.data.warning).toContain("not found in re-fetch");
    expect(out.data.goal.id).toBe("g-1");
  });
});

describe("plans goal-add-with-selection <planId>", () => {
  it("creates with --place-before", async () => {
    mockGraphql.mockResolvedValueOnce({
      createTripPlanGoalWithSelection: {
        goal: { ...GOAL_FIXTURE, id: "g-9" },
        item: { id: "i-9", goalId: "g-9" },
        selection: { id: "sel-9", type: "Hotel", isLocked: false },
      },
    });
    await runGoals([
      "goal-add-with-selection", "plan-1",
      "--type", "Hotel",
      "--name", "Paris hotel",
      "--place-before", "g-anchor",
      "--initial-query", '{"query":"hotel in Paris"}',
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).input).toMatchObject({
      tripPlanId: "plan-1",
      type: "Hotel",
      name: "Paris hotel",
      placeBeforeGoalId: "g-anchor",
      initialQuery: { query: "hotel in Paris" },
    });
    expect(lastJsonOutput().data.selection.id).toBe("sel-9");
  });

  it("rejects --place-before + --place-after as mutually exclusive", async () => {
    await expect(
      runGoals([
        "goal-add-with-selection", "plan-1",
        "--type", "Hotel",
        "--place-before", "g-1",
        "--place-after", "g-2",
        "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("rejects --place-before + --sort-order as mutually exclusive", async () => {
    await expect(
      runGoals([
        "goal-add-with-selection", "plan-1",
        "--type", "Hotel",
        "--place-before", "g-1",
        "--sort-order", "3",
        "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("rejects --place-after + --sort-order as mutually exclusive", async () => {
    await expect(
      runGoals([
        "goal-add-with-selection", "plan-1",
        "--type", "Hotel",
        "--place-after", "g-1",
        "--sort-order", "3",
        "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("rejects all three positioning flags at once", async () => {
    await expect(
      runGoals([
        "goal-add-with-selection", "plan-1",
        "--type", "Hotel",
        "--place-before", "g-1",
        "--place-after", "g-2",
        "--sort-order", "3",
        "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("accepts --sort-order alone", async () => {
    mockGraphql.mockResolvedValueOnce({
      createTripPlanGoalWithSelection: {
        goal: { ...GOAL_FIXTURE, sortOrder: 3 },
        item: null,
        selection: null,
      },
    });
    await runGoals([
      "goal-add-with-selection", "plan-1",
      "--type", "Hotel",
      "--sort-order", "3",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).input.sortOrder).toBe(3);
    expect((vars as any).input.placeBeforeGoalId).toBeUndefined();
    expect((vars as any).input.placeAfterGoalId).toBeUndefined();
  });

  it("does not require --name (server may auto-name)", async () => {
    mockGraphql.mockResolvedValueOnce({
      createTripPlanGoalWithSelection: {
        goal: { ...GOAL_FIXTURE },
        item: null,
        selection: null,
      },
    });
    await runGoals(["goal-add-with-selection", "plan-1", "--type", "Hotel", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).input.name).toBeUndefined();
  });
});

describe("plans goal-update <goalId>", () => {
  it("updates a single field", async () => {
    mockGraphql.mockResolvedValueOnce({
      updateTripPlanGoal: { ...GOAL_FIXTURE, name: "New name" },
    });
    await runGoals(["goal-update", "g-1", "--name", "New name", "--json"]);
    const out = lastJsonOutput();
    expect(out.data.goal.name).toBe("New name");
    expect(out.data.updatedFields).toEqual(["name"]);
  });

  it("updates multiple fields", async () => {
    mockGraphql.mockResolvedValueOnce({
      updateTripPlanGoal: { ...GOAL_FIXTURE, sortOrder: 5, relativeDay: 7 },
    });
    await runGoals([
      "goal-update", "g-1",
      "--sort-order", "5",
      "--relative-day", "7",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).input).toEqual({ sortOrder: 5, relativeDay: 7 });
  });

  it("rejects update with no fields", async () => {
    await expect(
      runGoals(["goal-update", "g-1", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("throws GOAL_NOT_FOUND on null response", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanGoal: null });
    await expect(
      runGoals(["goal-update", "g-x", "--name", "x", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.GOAL_NOT_FOUND });
  });
});

describe("plans goal-remove <goalId>", () => {
  it("requires --force", async () => {
    await expect(
      runGoals(["goal-remove", "g-1", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("calls deleteTripPlanGoal with --force", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanGoal: true });
    await runGoals(["goal-remove", "g-1", "--force", "--json"]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.deleted).toBe(true);
  });

  it("surfaces server false as ok=false", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanGoal: false });
    await runGoals(["goal-remove", "g-1", "--force", "--json"]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(false);
    expect(out.data.deleted).toBe(false);
  });
});

describe("plans goal-assign-travellers <goalId>", () => {
  it("dedupes traveller ids, calls the mutation, and re-fetches for verified ids", async () => {
    mockGraphql
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockResolvedValueOnce({ tripPlanGoal: { ...GOAL_FIXTURE, travellers: [{ id: "t-1" }, { id: "t-2" }] } });
    await runGoals([
      "goal-assign-travellers", "g-1",
      "--travellers", "t-1, t-2, t-1",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect(vars).toEqual({ goalId: "g-1", travellerIds: ["t-1", "t-2"] });
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.assignedTravellerIds).toEqual(["t-1", "t-2"]);
    expect(out.data.warning).toBeUndefined();
  });

  it("reports server-verified subset when server drops unknown ids", async () => {
    mockGraphql
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockResolvedValueOnce({ tripPlanGoal: { ...GOAL_FIXTURE, travellers: [{ id: "t-1" }] } });
    await runGoals([
      "goal-assign-travellers", "g-1",
      "--travellers", "t-1, t-99",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.assignedTravellerIds).toEqual(["t-1"]);
    expect(out.data.warning).toBeUndefined();
  });

  it("returns ok:true with warning when re-fetch fails after assignment", async () => {
    mockGraphql
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockRejectedValueOnce(new Error("network timeout"));
    await runGoals([
      "goal-assign-travellers", "g-1",
      "--travellers", "t-1, t-2",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.assignedTravellerIds).toEqual(["t-1", "t-2"]);
    expect(out.data.warning).toContain("re-fetch failed");
  });

  it("returns ok:false with assignedTravellerIds:null when server returns false (unified schema)", async () => {
    mockGraphql.mockResolvedValueOnce({ assignTravellersToGoal: false });
    await runGoals([
      "goal-assign-travellers", "g-1",
      "--travellers", "t-1",
      "--json",
    ]);
    expect(mockGraphql).toHaveBeenCalledTimes(1); // no re-fetch on false
    const out = lastJsonOutput();
    expect(out.ok).toBe(false);
    expect(out.data.assignedTravellerIds).toBeNull();
    expect(out.data.travellerIds).toBeUndefined(); // legacy field must not appear
  });

  it("returns ok:true with assignedTravellerIds:null and verificationWarning when re-fetch returns null goal", async () => {
    mockGraphql
      .mockResolvedValueOnce({ assignTravellersToGoal: true })
      .mockResolvedValueOnce({ tripPlanGoal: null });
    await runGoals([
      "goal-assign-travellers", "g-1",
      "--travellers", "t-1, t-2",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.assignedTravellerIds).toBeNull();
    expect(out.data.warning).toContain("goal not found in re-fetch");
  });

  it("rejects empty --travellers", async () => {
    await expect(
      runGoals(["goal-assign-travellers", "g-1", "--travellers", ",,,", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });
});

describe("plans goal-add-item <goalId>", () => {
  it("attaches an existing item", async () => {
    mockGraphql.mockResolvedValueOnce({ addItemToGoal: true });
    await runGoals(["goal-add-item", "g-1", "--item", "i-99", "--json"]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.itemId).toBe("i-99");
  });
});

describe("plans goal-add-item-with-selection <goalId>", () => {
  it("creates a new item + selection", async () => {
    mockGraphql.mockResolvedValueOnce({
      addItemWithSelectionToGoal: {
        item: { id: "i-1", goalId: "g-1" },
        selection: { id: "sel-1", type: "Activity", isLocked: false },
      },
    });
    await runGoals([
      "goal-add-item-with-selection", "g-1",
      "--plan", "plan-1",
      "--type", "Activity",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect(vars).toEqual({ goalId: "g-1", tripPlanId: "plan-1", type: "Activity" });
    const out = lastJsonOutput();
    expect(out.data.selection.id).toBe("sel-1");
  });

  it("normalizes --type", async () => {
    mockGraphql.mockResolvedValueOnce({
      addItemWithSelectionToGoal: {
        item: { id: "i-1", goalId: "g-1" },
        selection: { id: "sel-1", type: "Hotel" },
      },
    });
    await runGoals([
      "goal-add-item-with-selection", "g-1",
      "--plan", "plan-1",
      "--type", "hotel",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0];
    expect((vars as any).type).toBe("Hotel");
  });
});

describe("plans goal-reorder <planId>", () => {
  it("issues parallel updates and reports succeededGoalIds", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        tripPlanGoals: [
          { ...GOAL_FIXTURE, id: "g-1", sortOrder: 1 },
          { ...GOAL_FIXTURE, id: "g-2", sortOrder: 2 },
          { ...GOAL_FIXTURE, id: "g-3", sortOrder: 3 },
        ],
      })
      .mockResolvedValueOnce({ updateTripPlanGoal: { ...GOAL_FIXTURE, id: "g-3", sortOrder: 1 } })
      .mockResolvedValueOnce({ updateTripPlanGoal: { ...GOAL_FIXTURE, id: "g-1", sortOrder: 3 } });
    await runGoals([
      "goal-reorder", "plan-1",
      "--order", "g-3, g-2, g-1",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.atomic).toBe(false);
    expect(out.data.succeededGoalIds.sort()).toEqual(["g-1", "g-3"]);
    expect(out.data.failedGoalIds).toEqual([]);
    expect(out.data.noopCount).toBe(1); // g-2 was unchanged (sortOrder 2 → 2)
  });

  it("reports partial failure when one update throws", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        tripPlanGoals: [
          { ...GOAL_FIXTURE, id: "g-1", sortOrder: 1 },
          { ...GOAL_FIXTURE, id: "g-2", sortOrder: 2 },
        ],
      })
      .mockResolvedValueOnce({ updateTripPlanGoal: { ...GOAL_FIXTURE, id: "g-2", sortOrder: 1 } })
      .mockRejectedValueOnce(new Error("server boom"));
    await runGoals([
      "goal-reorder", "plan-1",
      "--order", "g-2, g-1",
      "--json",
    ]);
    const out = lastJsonOutput();
    expect(out.ok).toBe(false);
    expect(out.data.succeededGoalIds).toContain("g-2");
    expect(out.data.failedGoalIds).toContain("g-1");
    expect(out.data.errors).toEqual([{ goalId: "g-1", message: "server boom" }]);
  });

  it("rejects --order missing a goal id", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanGoals: [
        { ...GOAL_FIXTURE, id: "g-1", sortOrder: 1 },
        { ...GOAL_FIXTURE, id: "g-2", sortOrder: 2 },
      ],
    });
    await expect(
      runGoals(["goal-reorder", "plan-1", "--order", "g-1", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("treats already-sorted as a clean no-op (zero updates)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanGoals: [
        { ...GOAL_FIXTURE, id: "g-1", sortOrder: 1 },
        { ...GOAL_FIXTURE, id: "g-2", sortOrder: 2 },
      ],
    });
    await runGoals(["goal-reorder", "plan-1", "--order", "g-1, g-2", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1); // only the list query
    const out = lastJsonOutput();
    expect(out.ok).toBe(true);
    expect(out.data.succeededGoalIds).toEqual([]);
    expect(out.data.noopCount).toBe(2);
  });
});
