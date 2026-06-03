/**
 * Selection option-fetch status taxonomy (VOY-1415).
 *
 * The single biggest agentic landmine on this backend: an agent resolves
 * inputs, asks for options, and gets a SILENTLY EMPTY array — then concludes
 * "no inventory exists" when really the async BlueprintMonitor just hasn't
 * fetched yet, or the query isn't sufficient, or the provider errored. This
 * module turns that ambiguity into an explicit, machine-readable status so an
 * agent always knows whether to wait, fix an input, or give up.
 *
 * SHAPE-AGNOSTIC + BACKEND-OWNED: classification reads only what the backend
 * exposes (the selection's options + its monitor's fetch-state). The CLI never
 * recomputes sufficiency and never assumes plan/goal shape.
 */

export type SelectionStatus =
  | "READY" // options present — act on them
  | "FETCHING" // monitor exists, a fetch is in flight; options not in yet — wait
  | "AWAITING_INPUT" // no monitor / not auto-fetchable yet — a required input is missing
  | "NO_RESULTS" // fetch completed, genuinely zero inventory — distinct from FETCHING
  | "FETCH_ERROR"; // monitor's last fetch attempt errored and we have no usable options

export interface MonitorState {
  id: string;
  fetchedAt?: string | null; // last SUCCESSFUL fetch
  lastFetchAttempt?: string | null; // last attempt (success or fail)
  lastFetchError?: string | null;
}

export interface SelectionState {
  id: string;
  type?: string | null;
  blueprintMonitorId?: string | null;
  optionCount: number;
  monitor?: MonitorState | null;
}

export interface SelectionStatusResult {
  status: SelectionStatus;
  optionCount: number;
  /** Present for FETCH_ERROR, or as a non-fatal warning when options are stale. */
  fetchError?: string;
  /** True when options exist but the monitor's most recent attempt errored. */
  staleWarning?: boolean;
  /** Hint for pollers (ms). Only meaningful for FETCHING. */
  retryAfterMs?: number;
}

/**
 * A fetch attempt is considered "in flight / recent" if the monitor has
 * attempted more recently than it last succeeded (or has never succeeded but
 * has attempted). We do NOT treat this as fatal on its own — only combined
 * with empty options + an error does it become FETCH_ERROR.
 */
function attemptIsNewerThanSuccess(m: MonitorState): boolean {
  if (!m.lastFetchAttempt) return false;
  if (!m.fetchedAt) return true; // attempted but never succeeded
  return new Date(m.lastFetchAttempt).getTime() > new Date(m.fetchedAt).getTime();
}

/**
 * Classify a selection's option-fetch state. Pure: same inputs → same output.
 *
 * Decision order (most-actionable first):
 *  1. Options present → READY (but surface a staleWarning if the latest attempt errored).
 *  2. No monitor at all → AWAITING_INPUT (nothing can fetch yet; an input is missing).
 *  3. Monitor present, empty options, last attempt errored → FETCH_ERROR.
 *  4. Monitor present, empty options, a fetch looks in flight → FETCHING.
 *  5. Monitor present, empty options, a successful fetch has completed → NO_RESULTS.
 */
export function classifySelection(
  state: SelectionState,
  opts: { retryAfterMs?: number } = {},
): SelectionStatusResult {
  const optionCount = state.optionCount;
  const monitor = state.monitor ?? null;
  const retryAfterMs = opts.retryAfterMs ?? 2000;

  if (optionCount > 0) {
    const result: SelectionStatusResult = { status: "READY", optionCount };
    if (monitor?.lastFetchError && monitor && attemptIsNewerThanSuccess(monitor)) {
      // Options exist (from an earlier success) but the latest refresh errored.
      result.staleWarning = true;
      result.fetchError = monitor.lastFetchError;
    }
    return result;
  }

  // No options from here down.
  if (!state.blueprintMonitorId) {
    // No monitor exists and none can fetch — a required input is missing.
    // The specific "what's missing" is the OWNING GOAL's checkoutReadiness
    // (surfaced by the caller / VOY-1416), not recomputed here.
    return { status: "AWAITING_INPUT", optionCount: 0 };
  }

  if (!monitor) {
    // A monitor id IS set but we couldn't read its state (best-effort read
    // failed). The selection is auto-fetchable, so this is "fetchable, state
    // unknown" — FETCHING, NOT "you forgot an input" (AWAITING_INPUT).
    return { status: "FETCHING", optionCount: 0, retryAfterMs };
  }

  if (monitor.lastFetchError && attemptIsNewerThanSuccess(monitor)) {
    return { status: "FETCH_ERROR", optionCount: 0, fetchError: monitor.lastFetchError };
  }

  if (attemptIsNewerThanSuccess(monitor) || !monitor.fetchedAt) {
    return { status: "FETCHING", optionCount: 0, retryAfterMs };
  }

  // A fetch has successfully completed and there are still no options.
  return { status: "NO_RESULTS", optionCount: 0 };
}

/** Terminal statuses — `--wait` stops polling on these. */
export const TERMINAL_STATUSES: ReadonlySet<SelectionStatus> = new Set<SelectionStatus>([
  "READY",
  "NO_RESULTS",
  "AWAITING_INPUT",
  "FETCH_ERROR",
]);

export function isTerminal(status: SelectionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
