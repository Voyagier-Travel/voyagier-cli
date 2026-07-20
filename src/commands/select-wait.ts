/**
 * select --wait (VOY-1705): after a pick mutation succeeds, wait until the
 * choice is actually reflected server-side and plan readiness settles, then
 * hand the agent a plan-status snapshot — instead of making every consumer
 * hand-roll a poll loop (or read stale state and mis-conclude, cf. VOY-1701).
 *
 * Two-phase wait:
 *   A. Pick visibility — re-read the selection until travellerOptionChoices
 *      reflect the pick for the requested scope.
 *   B. Readiness settle — poll plan-status until the transient post-pick
 *      CART_PENDING wait clears (cart regeneration). BLOCKED / READY_TO_BOOK /
 *      BOOKED are settled states; IN_PROGRESS is settled too as long as the
 *      only waits are other selections' own fetches (OPTIONS_PENDING), which
 *      this pick neither causes nor unblocks.
 *
 * Timeout semantics match `selection-options --wait`: report the honest
 * partial state (settled:false) and exit 0 — the pick itself SUCCEEDED; a
 * slow settle is not a failure.
 */

import { graphql } from "../api.js";
import { deriveChosen, type RawTravellerChoice } from "../choices.js";
import { GET_SELECTION_WITH_MONITOR, GET_PLAN_STATUS } from "../queries.js";
import {
  buildPlanStatus,
  type PlanStatusData,
  type PlanStatusQueryResult,
} from "./plan-status.js";

export interface PickScope {
  traveller?: string;
  travellers?: string;
  group?: string;
}

interface WaitSelectionRead {
  id: string;
  tripPlanId?: string | null;
  parentOptionId?: string | null;
  travellerOptionChoices?: RawTravellerChoice[] | null;
}

export interface PickWaitOutcome {
  /** The pick is visible in travellerOptionChoices for the requested scope. */
  pickVisible: boolean;
  /** Plan readiness reached a settled (non-transient) state. */
  settled: boolean;
  /** The wait deadline elapsed before both conditions held. */
  timedOut: boolean;
  elapsedMs: number;
  tripPlanId: string | null;
  /** Final plan-status snapshot; null only if the plan read never succeeded. */
  planStatus: PlanStatusData | null;
}

/**
 * Is the pick reflected for the requested scope?
 * - default (all travellers): consensus on exactly this option
 * - --traveller X: X's choice is this option
 * - --travellers A,B: every listed traveller's choice is this option
 * - --group: membership isn't in the selection read, so the honest weakest
 *   check is "at least one traveller chose this option"
 */
export function pickReflected(
  raw: WaitSelectionRead,
  optionId: string,
  scope: PickScope,
): boolean {
  const choices = raw.travellerOptionChoices ?? [];
  const chose = (travellerId: string): boolean =>
    choices.some((c) => c.traveller?.id === travellerId && c.selectedOption?.id === optionId);

  if (scope.traveller) return chose(scope.traveller);
  if (scope.travellers) {
    const ids = scope.travellers.split(",").map((s) => s.trim()).filter(Boolean);
    return ids.length > 0 && ids.every(chose);
  }
  if (scope.group) {
    return choices.some((c) => c.selectedOption?.id === optionId);
  }
  const { chosenOptionId, consensus } = deriveChosen(raw);
  return consensus && chosenOptionId === optionId;
}

/**
 * Settled = nothing about THIS pick is still in flight. The only post-pick
 * transient is CART_PENDING (cart regeneration after decisions change);
 * OPTIONS_PENDING waits belong to other selections' fetch lifecycles and can
 * legitimately run for a long time — they never block a pick from settling.
 */
export function isSettled(status: PlanStatusData): boolean {
  return !status.waiting.some((w) => w.kind === "CART_PENDING");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const INITIAL_DELAY_MS = 1500;
const MAX_DELAY_MS = 8000;
const BACKOFF_FACTOR = 1.5;

export interface WaitDeps {
  /** Injectable for tests; defaults to the real graphql client. */
  gql?: typeof graphql;
  /** Heartbeat sink; defaults to stderr. Never stdout (would corrupt --json). */
  heartbeat?: (line: string) => void;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

export async function waitForPickSettle(
  selectionId: string,
  optionId: string,
  scope: PickScope,
  timeoutMs: number,
  planUrlBase: string,
  deps: WaitDeps = {},
): Promise<PickWaitOutcome> {
  const gql = deps.gql ?? graphql;
  const heartbeat = deps.heartbeat ?? ((line: string) => process.stderr.write(line));
  const now = deps.now ?? Date.now;
  const sleepFn = deps.sleepFn ?? sleep;

  const started = now();
  const deadline = started + timeoutMs;
  let delay = INITIAL_DELAY_MS;

  let pickVisible = false;
  let tripPlanId: string | null = null;
  let planStatus: PlanStatusData | null = null;
  let settled = false;

  // Phase A: pick visibility (also resolves tripPlanId for phase B).
  for (;;) {
    const data = await gql<{ getTripPlanSelection: WaitSelectionRead | null }>(
      GET_SELECTION_WITH_MONITOR,
      { tripPlanSelectionId: selectionId },
    );
    const raw = data.getTripPlanSelection;
    if (raw) {
      tripPlanId = raw.tripPlanId ?? tripPlanId;
      if (pickReflected(raw, optionId, scope)) {
        pickVisible = true;
        break;
      }
    }
    if (now() >= deadline) break;
    const remaining = deadline - now();
    await sleepFn(Math.min(delay, Math.max(0, remaining)));
    heartbeat(`  waiting… pick not yet visible, elapsed=${Math.round((now() - started) / 1000)}s\n`);
    delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
  }

  // Phase B: readiness settle (needs the plan id; selection reads carry it).
  if (tripPlanId) {
    delay = INITIAL_DELAY_MS;
    for (;;) {
      const data = await gql<PlanStatusQueryResult>(GET_PLAN_STATUS, { id: tripPlanId });
      if (data.tripPlan) {
        planStatus = buildPlanStatus(data, planUrlBase);
        if (isSettled(planStatus)) {
          settled = true;
          break;
        }
      }
      if (now() >= deadline) break;
      const remaining = deadline - now();
      await sleepFn(Math.min(delay, Math.max(0, remaining)));
      heartbeat(
        `  waiting… readiness=${planStatus?.readiness ?? "?"} (cart regenerating), elapsed=${Math.round((now() - started) / 1000)}s\n`,
      );
      delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY_MS);
    }
  }

  return {
    pickVisible,
    settled: pickVisible && settled,
    timedOut: !(pickVisible && settled),
    elapsedMs: now() - started,
    tripPlanId,
    planStatus,
  };
}
