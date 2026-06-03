import { describe, it, expect } from "@jest/globals";
import {
  classifySelection,
  isTerminal,
  TERMINAL_STATUSES,
  type SelectionState,
} from "./selection-status.js";

const base = (over: Partial<SelectionState> = {}): SelectionState => ({
  id: "sel-1",
  type: "FlightJourney",
  blueprintMonitorId: null,
  optionCount: 0,
  monitor: null,
  ...over,
});

describe("classifySelection — the silent-empty killer (VOY-1415)", () => {
  it("READY when options are present", () => {
    const r = classifySelection(base({ optionCount: 39, blueprintMonitorId: "m1", monitor: { id: "m1" } }));
    expect(r.status).toBe("READY");
    expect(r.optionCount).toBe(39);
    expect(r.staleWarning).toBeUndefined();
  });

  it("READY + staleWarning when options exist but the latest refresh errored", () => {
    const r = classifySelection(
      base({
        optionCount: 39,
        blueprintMonitorId: "m1",
        monitor: {
          id: "m1",
          fetchedAt: "2026-05-22T15:41:43Z", // older success
          lastFetchAttempt: "2026-06-03T02:00:02Z", // newer attempt
          lastFetchError: "Request failed with status code 404",
        },
      }),
    );
    expect(r.status).toBe("READY");
    expect(r.staleWarning).toBe(true);
    expect(r.fetchError).toMatch(/404/);
  });

  it("AWAITING_INPUT when empty and there is no monitor at all", () => {
    const r = classifySelection(base({ optionCount: 0, blueprintMonitorId: null, monitor: null }));
    expect(r.status).toBe("AWAITING_INPUT");
    expect(r.optionCount).toBe(0);
  });

  it("FETCH_ERROR when empty and the latest attempt errored (newer than last success)", () => {
    const r = classifySelection(
      base({
        optionCount: 0,
        blueprintMonitorId: "m1",
        monitor: {
          id: "m1",
          fetchedAt: "2026-06-01T00:00:00Z",
          lastFetchAttempt: "2026-06-03T00:00:00Z",
          lastFetchError: "Request failed with status code 500",
        },
      }),
    );
    expect(r.status).toBe("FETCH_ERROR");
    expect(r.fetchError).toMatch(/500/);
  });

  it("FETCHING when empty and a fetch looks in flight (attempt, never succeeded, no error)", () => {
    const r = classifySelection(
      base({
        optionCount: 0,
        blueprintMonitorId: "m1",
        monitor: { id: "m1", fetchedAt: null, lastFetchAttempt: "2026-06-03T00:00:00Z", lastFetchError: null },
      }),
      { retryAfterMs: 2500 },
    );
    expect(r.status).toBe("FETCHING");
    expect(r.retryAfterMs).toBe(2500);
  });

  it("NO_RESULTS when empty and a successful fetch has completed (no newer attempt, no error)", () => {
    const r = classifySelection(
      base({
        optionCount: 0,
        blueprintMonitorId: "m1",
        monitor: { id: "m1", fetchedAt: "2026-06-03T00:00:00Z", lastFetchAttempt: "2026-06-03T00:00:00Z", lastFetchError: null },
      }),
    );
    expect(r.status).toBe("NO_RESULTS");
  });

  it("never returns a bare empty result without a status (the whole point)", () => {
    // Exhaustive: every empty-options shape resolves to a defined, non-READY status.
    for (const monitor of [
      null,
      { id: "m", fetchedAt: null, lastFetchAttempt: null, lastFetchError: null },
      { id: "m", fetchedAt: "2026-06-03T00:00:00Z", lastFetchAttempt: "2026-06-03T00:00:00Z", lastFetchError: null },
      { id: "m", fetchedAt: null, lastFetchAttempt: "2026-06-03T00:00:00Z", lastFetchError: "boom" },
    ]) {
      const r = classifySelection(base({ optionCount: 0, blueprintMonitorId: monitor ? "m" : null, monitor }));
      expect(["AWAITING_INPUT", "FETCHING", "NO_RESULTS", "FETCH_ERROR"]).toContain(r.status);
      expect(r.status).not.toBe("READY");
    }
  });
});

describe("terminal status set (controls --wait stop condition)", () => {
  it("READY / NO_RESULTS / AWAITING_INPUT / FETCH_ERROR are terminal; FETCHING is not", () => {
    expect(isTerminal("READY")).toBe(true);
    expect(isTerminal("NO_RESULTS")).toBe(true);
    expect(isTerminal("AWAITING_INPUT")).toBe(true);
    expect(isTerminal("FETCH_ERROR")).toBe(true);
    expect(isTerminal("FETCHING")).toBe(false);
    expect(TERMINAL_STATUSES.has("FETCHING")).toBe(false);
  });
});
