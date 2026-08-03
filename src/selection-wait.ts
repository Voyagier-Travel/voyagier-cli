/**
 * Shared async-option wait core (VOY-1780).
 *
 * The one place that knows how to turn a freshly-created (or reused) selection
 * whose options are still being fetched by the backend BlueprintMonitor into a
 * settled result: load the selection + its monitor, classify the fetch status,
 * and — while not terminal — kick a refresh and poll with capped exponential
 * backoff until the options land or a terminal status is reached.
 *
 * Extracted from `selection-options.ts` so `search flights` / `search hotels`
 * can wait inline for their inventory instead of handing the user a poll
 * command. The `deps` seam (gql / now / sleepFn / heartbeat) keeps the loop
 * unit-testable without real timers; the defaults reproduce the exact behaviour
 * `selection-options --wait` had before this extraction.
 */

import { graphql } from "./api.js";
import {
  GET_SELECTION_WITH_MONITOR,
  GET_BLUEPRINT_MONITOR,
  REFRESH_SELECTION_OPTIONS,
} from "./queries.js";
import {
  classifySelection,
  isTerminal,
  type SelectionState,
  type SelectionStatus,
  type SelectionStatusResult,
} from "./selection-status.js";
import type { RawTravellerChoice, RawSelectionInput } from "./choices.js";
import { CliError, CliErrorCode } from "./errors.js";

export interface RawOption {
  id: string;
  name: string;
  price?: number | null;
  time?: string | null;
  airline?: string | null;
  duration?: string | null;
  sortOrder?: number | null;
  // Raw provider blob (`optionData`, aliased to `bookingData` on the queries
  // that fetch it). Present only when a query actually selects it; the lean
  // monitor read (GET_SELECTION_WITH_MONITOR) omits it. Kept optional so
  // display-only derivations (e.g. VOY-1824 rankScore) can read it when it is
  // present and degrade gracefully when it is not.
  bookingData?: unknown;
  optionData?: unknown;
}

export interface RawSelection {
  __typename: string;
  id: string;
  type?: string | null;
  blueprintMonitorId?: string | null;
  parentOptionId?: string | null;
  travellerOptionChoices?: RawTravellerChoice[] | null;
  inputs?: RawSelectionInput[] | null;
  options?: RawOption[] | null;
}

interface RawMonitor {
  id: string;
  type?: string | null;
  queryVersion?: number | null;
  fetchedAt?: string | null;
  lastFetchAttempt?: string | null;
  lastFetchError?: string | null;
}

/** A selection read + its classified fetch status. */
export interface SelectionSnapshot {
  raw: RawSelection;
  result: SelectionStatusResult;
}

/** Default hint the backend gives pollers between attempts. */
export const DEFAULT_RETRY_AFTER_MS = 2000;
const MAX_DELAY_MS = 8000;
const BACKOFF_FACTOR = 1.5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fetch a selection + (if it has one) its monitor, then classify. Pure I/O + classify. */
export async function loadSelectionState(
  selectionId: string,
  retryAfterMs: number,
  gql: typeof graphql = graphql,
): Promise<SelectionSnapshot> {
  const data = await gql<{ getTripPlanSelection: RawSelection | null }>(
    GET_SELECTION_WITH_MONITOR,
    { tripPlanSelectionId: selectionId },
  );
  const raw = data.getTripPlanSelection;
  if (!raw || !raw.id) {
    throw new CliError(CliErrorCode.NOT_FOUND, `Selection ${selectionId} not found.`);
  }

  let monitor: RawMonitor | null = null;
  if (raw.blueprintMonitorId) {
    try {
      const m = await gql<{ blueprintMonitor: RawMonitor | null }>(GET_BLUEPRINT_MONITOR, {
        id: raw.blueprintMonitorId,
      });
      monitor = m.blueprintMonitor;
    } catch {
      // Monitor read is best-effort; absence just means we can't refine FETCHING vs NO_RESULTS.
      monitor = null;
    }
  }

  const state: SelectionState = {
    id: raw.id,
    type: raw.type,
    blueprintMonitorId: raw.blueprintMonitorId,
    optionCount: (raw.options ?? []).length,
    monitor: monitor
      ? {
          id: monitor.id,
          fetchedAt: monitor.fetchedAt,
          lastFetchAttempt: monitor.lastFetchAttempt,
          lastFetchError: monitor.lastFetchError,
        }
      : null,
  };

  return { raw, result: classifySelection(state, { retryAfterMs }) };
}

/** Per-poll progress, surfaced to the caller's heartbeat sink (never stdout). */
export interface OptionsHeartbeat {
  attempt: number;
  status: SelectionStatus;
  optionCount: number;
  elapsedMs: number;
}

export interface WaitOptionsDeps {
  /** Injectable for tests; defaults to the real graphql client. */
  gql?: typeof graphql;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  /** Called after each poll with progress; the caller owns rendering. */
  heartbeat?: (h: OptionsHeartbeat) => void;
}

export interface WaitOptionsOpts {
  /** Hard cap on total wait time. */
  timeoutMs: number;
  retryAfterMs?: number;
}

/**
 * Kick a refresh, then poll `initial`'s selection with capped exponential
 * backoff until a terminal status is reached or the deadline passes. Assumes the
 * caller has already confirmed `initial.result.status` is non-terminal. On
 * timeout the status is coerced to FETCHING — never hang, never lie-empty.
 */
export async function pollSelectionOptions(
  selectionId: string,
  initial: SelectionSnapshot,
  opts: WaitOptionsOpts,
  deps: WaitOptionsDeps = {},
): Promise<SelectionSnapshot> {
  const gql = deps.gql ?? graphql;
  const now = deps.now ?? Date.now;
  const sleepFn = deps.sleepFn ?? sleep;
  const retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;

  let snap = initial;

  // Kick a refresh (no-op server-side if not auto-fetchable), then poll.
  try {
    await gql(REFRESH_SELECTION_OPTIONS, { selectionId });
  } catch {
    // Refresh failure isn't fatal — polling will reflect real monitor state.
  }

  const startedAt = now();
  const deadline = startedAt + opts.timeoutMs;
  let delay = retryAfterMs;
  let attempt = 0;
  while (!isTerminal(snap.result.status) && now() < deadline) {
    const remaining = deadline - now();
    await sleepFn(Math.min(delay, Math.max(0, remaining)));
    snap = await loadSelectionState(selectionId, retryAfterMs, gql);
    attempt++;
    deps.heartbeat?.({
      attempt,
      status: snap.result.status,
      optionCount: snap.result.optionCount,
      elapsedMs: now() - startedAt,
    });
    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS); // exponential backoff, capped
  }

  if (!isTerminal(snap.result.status)) {
    // Ran out of time still FETCHING — report honestly, never hang or lie-empty.
    return { ...snap, result: { ...snap.result, status: "FETCHING", retryAfterMs } };
  }
  return snap;
}

/**
 * Load a selection's state and, if it isn't already terminal, refresh + poll to
 * completion. The one-call entry point for callers (like `search`) that don't
 * already hold an initial snapshot.
 */
export async function waitForSelectionOptions(
  selectionId: string,
  opts: WaitOptionsOpts,
  deps: WaitOptionsDeps = {},
): Promise<SelectionSnapshot> {
  const gql = deps.gql ?? graphql;
  const retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const initial = await loadSelectionState(selectionId, retryAfterMs, gql);
  if (isTerminal(initial.result.status)) return initial;
  return pollSelectionOptions(selectionId, initial, opts, deps);
}
