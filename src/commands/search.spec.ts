import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { CliErrorCode } from "../errors.js";
import type { SearchState } from "../state.js";

/**
 * resolvePlanId --plan contract (VOY-1437)
 * ----------------------------------------
 * The agent-facing rule, made explicit and regression-locked:
 *   - --plan with a real value  -> use it (trimmed).
 *   - --plan passed but empty/whitespace -> VALIDATION error (NEVER silently
 *     fall back to the last-search plan; that would run against a different
 *     plan than the caller named).
 *   - --plan omitted entirely + last-search state present -> fall back, with a
 *     loud stderr notice.
 *   - --plan omitted entirely + no state -> VALIDATION error.
 */

const mockLoadSearchState = jest.fn<() => SearchState | null>();
const mockGraphql = jest.fn<(query: string, vars?: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../state.js", () => ({
  loadSearchState: mockLoadSearchState,
  saveSearchState: jest.fn(),
  clearSearchState: jest.fn(),
  isSearchStateStale: jest.fn(() => false),
  saveOptionsState: jest.fn(),
  loadOptionsState: jest.fn(),
  clearOptionsState: jest.fn(),
}));

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

let resolvePlanId: (opts: { plan?: string }) => string;
let resolveOrCreateDecisionSelection: typeof import("./search.js").resolveOrCreateDecisionSelection;

beforeAll(async () => {
  ({ resolvePlanId, resolveOrCreateDecisionSelection } = await import("./search.js"));
});

let stderrSpy: ReturnType<typeof jest.spyOn>;
let stderrWrites: string[];

beforeEach(() => {
  mockLoadSearchState.mockReset();
  stderrWrites = [];
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function state(tripPlanId: string): SearchState {
  return { tripPlanId } as SearchState;
}

describe("resolvePlanId --plan contract", () => {
  it("uses an explicit --plan value (trimmed)", () => {
    expect(resolvePlanId({ plan: "plan-123" })).toBe("plan-123");
    expect(resolvePlanId({ plan: "  plan-123  " })).toBe("plan-123");
    expect(mockLoadSearchState).not.toHaveBeenCalled();
  });

  it("hard-errors on an empty --plan (does NOT fall back to last-search)", () => {
    mockLoadSearchState.mockReturnValue(state("last-search-plan"));
    expect.assertions(3);
    try {
      resolvePlanId({ plan: "" });
    } catch (err) {
      expect(err).toMatchObject({ code: CliErrorCode.VALIDATION });
      expect((err as Error).message).toMatch(/empty value/i);
    }
    // Critically: it must not have consulted (or returned) the last-search plan.
    expect(mockLoadSearchState).not.toHaveBeenCalled();
  });

  it("hard-errors on a whitespace-only --plan", () => {
    mockLoadSearchState.mockReturnValue(state("last-search-plan"));
    expect(() => resolvePlanId({ plan: "   " })).toThrow(
      expect.objectContaining({ code: CliErrorCode.VALIDATION }),
    );
  });

  it("falls back to last-search plan when --plan is omitted, with a stderr notice", () => {
    mockLoadSearchState.mockReturnValue(state("last-search-plan"));
    expect(resolvePlanId({})).toBe("last-search-plan");
    expect(stderrWrites.join("")).toMatch(/last search.*last-search-plan/i);
  });

  it("hard-errors when --plan is omitted and there is no last-search state", () => {
    mockLoadSearchState.mockReturnValue(null);
    expect(() => resolvePlanId({})).toThrow(
      expect.objectContaining({ code: CliErrorCode.VALIDATION }),
    );
  });
});

/**
 * resolveOrCreateDecisionSelection fail-fast contract (VOY-1692 review).
 * When the goal graph names a decision selection but getTripPlanSelection
 * returns null (stale graph / deleted selection), the reuse path must throw
 * — an empty options array would read as "still fetching" and send the
 * caller off to poll a selection that does not exist.
 */
describe("resolveOrCreateDecisionSelection reuse path", () => {
  const goalWithSelection = {
    id: "goal-1",
    name: "Flights",
    items: [{ selections: [{ id: "sel-decision", type: "Flight" }] }],
  };

  beforeEach(() => {
    mockGraphql.mockReset();
  });

  it("fails fast with API_ERROR when the reused selection cannot be loaded", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: null });
    let err: unknown;
    try {
      await resolveOrCreateDecisionSelection(
        "flights", goalWithSelection as never, "plan-1", "mutation X", "x", {}, true,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe(CliErrorCode.API_ERROR);
    expect((err as Error).message).toContain("sel-decision");
    expect((err as Error).message).toContain("plans goals plan-1");
  });

  it("returns the reused selection's options when it loads", async () => {
    mockGraphql.mockResolvedValueOnce({
      getTripPlanSelection: { id: "sel-decision", options: [{ id: "opt-1" }] },
    });
    const result = await resolveOrCreateDecisionSelection(
      "flights", goalWithSelection as never, "plan-1", "mutation X", "x", {}, true,
    );
    expect(result).toEqual({ selectionId: "sel-decision", options: [{ id: "opt-1" }], reused: true });
  });

  it("still treats a loaded selection with empty options as fetching (no throw)", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: { id: "sel-decision", options: [] } });
    const result = await resolveOrCreateDecisionSelection(
      "flights", goalWithSelection as never, "plan-1", "mutation X", "x", {}, true,
    );
    expect(result.options).toEqual([]);
    expect(result.reused).toBe(true);
  });
});
