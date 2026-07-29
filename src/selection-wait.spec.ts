/**
 * selection-wait (VOY-1780) — poll-core contract tests.
 *
 * The poll loop is exercised with injected gql / now / sleepFn so backoff,
 * refresh-kick, terminal short-circuit, and timeout coercion are all asserted
 * without real timers. The behaviour is the exact core `selection-options
 * --wait` used before extraction, now shared with `search flights`/`hotels`.
 */
import { describe, it, expect } from "@jest/globals";
import { CliError } from "./errors.js";
import {
  loadSelectionState,
  pollSelectionOptions,
  waitForSelectionOptions,
  DEFAULT_RETRY_AFTER_MS,
  type OptionsHeartbeat,
} from "./selection-wait.js";

const SEL_ID = "sel-1";
const MON_ID = "mon-1";

function selectionResult(over: Partial<{ blueprintMonitorId: string | null; options: unknown[] }> = {}) {
  return {
    getTripPlanSelection: {
      __typename: "TripPlanFlightJourneySelection",
      id: SEL_ID,
      type: "FlightJourney",
      blueprintMonitorId: over.blueprintMonitorId === undefined ? MON_ID : over.blueprintMonitorId,
      parentOptionId: null,
      options: over.options ?? [],
    },
  };
}

function monitorResult(
  over: Partial<{ fetchedAt: string | null; lastFetchAttempt: string | null; lastFetchError: string | null }> = {},
) {
  return {
    blueprintMonitor: {
      id: MON_ID,
      type: "FlightJourney",
      queryVersion: 1,
      fetchedAt: over.fetchedAt === undefined ? "2026-06-03T00:00:00Z" : over.fetchedAt,
      lastFetchAttempt: over.lastFetchAttempt === undefined ? "2026-06-03T00:00:00Z" : over.lastFetchAttempt,
      lastFetchError: over.lastFetchError ?? null,
    },
  };
}

const OPTION = { id: "opt-1", name: "BWI → MCO", price: 317, sortOrder: 0 };

/**
 * Scripted gql routed by query type: selection reads (TripPlanSelectionWithMonitor)
 * and monitor reads (BlueprintMonitor) each shift through their queue and then
 * repeat the last entry, so a perpetual-FETCHING poll never runs off the end.
 * Refresh mutations are tallied, never counted as reads.
 */
function scriptedGql(selectionReads: unknown[], monitorReads: unknown[] = []) {
  const calls: Array<{ query: string; vars: unknown }> = [];
  let refreshes = 0;
  const nextFrom = (q: unknown[]) => (q.length > 1 ? q.shift() : q[0]);
  const gql = (async (query: string, vars: unknown) => {
    calls.push({ query, vars });
    if (query.includes("RefreshTripPlanSelectionOptions") || query.includes("refreshTripPlanSelectionOptions")) {
      refreshes++;
      return { refreshTripPlanSelectionOptions: true };
    }
    if (query.includes("BlueprintMonitor")) return nextFrom(monitorReads);
    return nextFrom(selectionReads);
  }) as never;
  return { gql, calls, refreshCount: () => refreshes };
}

/** now/sleepFn that advance a virtual clock — no real timers. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleepFn: async (ms: number) => {
      t += ms;
    },
  };
}

describe("loadSelectionState", () => {
  it("classifies READY when options are present", async () => {
    const { gql } = scriptedGql([selectionResult({ options: [OPTION] })], [monitorResult()]);
    const { raw, result } = await loadSelectionState(SEL_ID, DEFAULT_RETRY_AFTER_MS, gql);
    expect(result.status).toBe("READY");
    expect(result.optionCount).toBe(1);
    expect(raw.id).toBe(SEL_ID);
  });

  it("throws NOT_FOUND when the selection is null", async () => {
    const { gql } = scriptedGql([{ getTripPlanSelection: null }]);
    await expect(loadSelectionState(SEL_ID, DEFAULT_RETRY_AFTER_MS, gql)).rejects.toBeInstanceOf(CliError);
  });

  it("skips the monitor read when there is no blueprintMonitorId (AWAITING_INPUT)", async () => {
    const { gql, calls } = scriptedGql([selectionResult({ blueprintMonitorId: null, options: [] })]);
    const { result } = await loadSelectionState(SEL_ID, DEFAULT_RETRY_AFTER_MS, gql);
    expect(result.status).toBe("AWAITING_INPUT");
    expect(calls).toHaveLength(1); // selection read only
  });
});

describe("waitForSelectionOptions", () => {
  it("returns immediately on a terminal status without kicking a refresh", async () => {
    const s = scriptedGql([selectionResult({ options: [OPTION] })], [monitorResult()]);
    const { result } = await waitForSelectionOptions(SEL_ID, { timeoutMs: 90_000 }, { gql: s.gql, ...fakeClock() });
    expect(result.status).toBe("READY");
    expect(s.refreshCount()).toBe(0);
    // selection + monitor read only; no refresh, no extra polls.
    expect(s.calls).toHaveLength(2);
  });

  it("kicks a refresh then polls until options arrive on the Nth poll", async () => {
    // read#1 FETCHING (attempted, never succeeded) -> refresh -> read#2 FETCHING
    // -> read#3 READY.
    const s = scriptedGql(
      [selectionResult({ options: [] }), selectionResult({ options: [] }), selectionResult({ options: [OPTION] })],
      [monitorResult({ fetchedAt: null }), monitorResult({ fetchedAt: null }), monitorResult()],
    );
    const beats: OptionsHeartbeat[] = [];
    const { result } = await waitForSelectionOptions(
      SEL_ID,
      { timeoutMs: 90_000 },
      { gql: s.gql, ...fakeClock(), heartbeat: (h) => beats.push(h) },
    );
    expect(result.status).toBe("READY");
    expect(result.optionCount).toBe(1);
    expect(s.refreshCount()).toBe(1);
    // Two polls before READY -> two heartbeats, attempts numbered 1,2.
    expect(beats.map((b) => b.attempt)).toEqual([1, 2]);
    expect(beats[beats.length - 1].status).toBe("READY");
  });

  it("applies capped exponential backoff between polls", async () => {
    const slept: number[] = [];
    const clock = fakeClock();
    const s = scriptedGql(
      [selectionResult({ options: [] }), selectionResult({ options: [OPTION] })],
      [monitorResult({ fetchedAt: null }), monitorResult()],
    );
    await waitForSelectionOptions(
      SEL_ID,
      { timeoutMs: 90_000 },
      {
        gql: s.gql,
        now: clock.now,
        sleepFn: async (ms) => {
          slept.push(ms);
          await clock.sleepFn(ms);
        },
      },
    );
    // First sleep is the retry-after floor.
    expect(slept[0]).toBe(DEFAULT_RETRY_AFTER_MS);
  });

  it("coerces to FETCHING on timeout — never hangs, never lies empty", async () => {
    // Perpetually FETCHING; a tiny timeout forces the deadline to pass.
    const s = scriptedGql([selectionResult({ options: [] })], [monitorResult({ fetchedAt: null })]);
    const { result } = await waitForSelectionOptions(SEL_ID, { timeoutMs: 1 }, { gql: s.gql, ...fakeClock() });
    expect(result.status).toBe("FETCHING");
    expect(result.optionCount).toBe(0);
  });

  it("stops at NO_RESULTS (fetch completed, genuinely empty)", async () => {
    const s = scriptedGql(
      [selectionResult({ options: [] })],
      // attempted == succeeded, no error -> NO_RESULTS
      [monitorResult({ fetchedAt: "2026-06-03T00:00:00Z", lastFetchAttempt: "2026-06-03T00:00:00Z" })],
    );
    const { result } = await waitForSelectionOptions(SEL_ID, { timeoutMs: 90_000 }, { gql: s.gql, ...fakeClock() });
    expect(result.status).toBe("NO_RESULTS");
  });

  it("stops at FETCH_ERROR and surfaces the error", async () => {
    const s = scriptedGql(
      [selectionResult({ options: [] })],
      [monitorResult({ fetchedAt: null, lastFetchAttempt: "2026-06-03T00:00:00Z", lastFetchError: "provider 500" })],
    );
    const { result } = await waitForSelectionOptions(SEL_ID, { timeoutMs: 90_000 }, { gql: s.gql, ...fakeClock() });
    expect(result.status).toBe("FETCH_ERROR");
    expect(result.fetchError).toMatch(/provider 500/);
  });

  it("stops at AWAITING_INPUT (no monitor) without polling", async () => {
    const s = scriptedGql([selectionResult({ blueprintMonitorId: null, options: [] })]);
    const { result } = await waitForSelectionOptions(SEL_ID, { timeoutMs: 90_000 }, { gql: s.gql, ...fakeClock() });
    expect(result.status).toBe("AWAITING_INPUT");
    expect(s.refreshCount()).toBe(0);
  });
});

describe("pollSelectionOptions", () => {
  it("swallows a refresh failure and keeps polling", async () => {
    const clock = fakeClock();
    let refreshTried = false;
    const reads = [
      selectionResult({ options: [OPTION] }),
      monitorResult(),
    ];
    let i = 0;
    const gql = (async (query: string) => {
      if (query.includes("RefreshTripPlanSelectionOptions")) {
        refreshTried = true;
        throw new Error("refresh boom");
      }
      return reads[Math.min(i++, reads.length - 1)];
    }) as never;
    const initial = {
      raw: { __typename: "X", id: SEL_ID, options: [] },
      result: { status: "FETCHING" as const, optionCount: 0, retryAfterMs: DEFAULT_RETRY_AFTER_MS },
    };
    const { result } = await pollSelectionOptions(SEL_ID, initial, { timeoutMs: 90_000 }, { gql, ...clock });
    expect(refreshTried).toBe(true);
    expect(result.status).toBe("READY");
  });
});
