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

jest.unstable_mockModule("../state.js", () => ({
  loadSearchState: mockLoadSearchState,
  saveSearchState: jest.fn(),
  clearSearchState: jest.fn(),
  isSearchStateStale: jest.fn(() => false),
  saveOptionsState: jest.fn(),
  loadOptionsState: jest.fn(),
  clearOptionsState: jest.fn(),
}));

let resolvePlanId: (opts: { plan?: string }) => string;

beforeAll(async () => {
  ({ resolvePlanId } = await import("./search.js"));
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
