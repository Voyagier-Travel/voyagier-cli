/**
 * voyagier plan-status <planId> — ONE call answering "what's left before this
 * plan can book?" (VOY-1704).
 *
 * Replaces the 5–8 call stitch (plans goals + N× selection-options +
 * travellers list + cart) that every agent loop had to hand-assemble.
 *
 * Contract (documented for consumers in AGENT.md § "Plan Status"; design
 * history on VOY-1704 / PR #68):
 * - `readiness` is the ONE enum agents switch on:
 *     BOOKED         all goals booked
 *     READY_TO_BOOK  no blockers, no waits, cart has ≥1 bookable item
 *     BLOCKED        system is waiting on the AGENT/USER — act
 *     IN_PROGRESS    system is waiting on ITSELF — poll, don't act
 * - `blockers[]` = the agent's to-do list (ordered: traveller data → inputs →
 *   picks → requirements), each { kind, message, refs }. Blockers whose server
 *   requirement carries no selection ref get `unverified: true` — they may be
 *   stale phantoms (VOY-1715); `book --dry-run` is the checkout truth and wins
 *   on contradiction.
 * - `waiting[]` = self-resolving waits, kept SEPARATE from blockers because
 *   acting on them won't help.
 * - `nextSteps[]` = runnable commands mapping onto blockers/waits, ending with
 *   the terminal command when ready.
 * - Divergent picks are VALID: if every traveller picked, the pick is complete even when picks differ.
 *   `consensus: false` is informational; PICK_PENDING fires only when someone hasn't picked.
 * - Dead-branch suppression (VOY-1718): the goal graph pre-creates a decision
 *   chain for EVERY candidate parent option (pick a hotel → per-hotel room
 *   list → room → rate). After a pick, the sibling chains are alternates. We
 *   group Single-mode selections by type within a goal; once one member is
 *   complete (or a bookable cart item joins to it), the incomplete siblings
 *   are alternates and their PICK_PENDING is suppressed (`branch`:
 *   "alternate" | "deadBranch", counted in `alternateBranchCount`). When a
 *   parent hasn't been picked at all, a group of ≥2 pending siblings collapses
 *   into ONE aggregated PICK_PENDING carrying `candidateSelectionIds`.
 * - STABILITY PROMISE: additive-only. Keys are never renamed/removed; new
 *   blocker/waiting kinds may appear — consumers must tolerate unknown kinds.
 *   Additive since v2.6.0 (VOY-1718): selection `branch`, goal + summary
 *   `alternateBranchCount`, blocker `candidateSelectionIds`.
 *   Additive since VOY-1724: summary `bookableNow`; `--verify` appends a
 *   `verify` block ({ bookable, blockers, chargeableSubtotal } | { error }).
 *   Room chains are mapped to the chosen hotel by supplier `hotelCode` (a
 *   targeted secondary read) so a code-mismatched chain is a dead branch
 *   immediately — upgrading the VOY-1718 completion-evidence rule (kept as
 *   fallback when a code is missing on either side).
 *
 * Reuses (never re-derives): deriveChosen + deriveBlockedOn (choices.js),
 * classifySelection status vocabulary (selection-status.js).
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { getApiUrl } from "../config.js";
import { deriveBaseUrl, formatPrice, shellArg } from "../utils.js";
import { planUrls } from "../plan-urls.js";
import { resolvePlanArg } from "../resolve-plan-arg.js";
import { GET_PLAN_STATUS, GET_HOTEL_OPTION_DATA } from "../queries.js";
import { classifySelection } from "../selection-status.js";
import {
  deriveChosen,
  deriveBlockedOn,
  type RawTravellerChoice,
  type RawSelectionInput,
} from "../choices.js";
import { loadCheckoutPreview } from "./checkout-preview.js";

// ── Raw query shapes ────────────────────────────────────────────────────────

interface RawTraveller {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  passport?: { last4?: string | null } | null;
}

interface RawCartItem {
  selectionId?: string | null;
  optionId?: string | null;
  /** Flight items: itinerary is international — passports required. Fails closed (true) server-side. */
  requiresPassport?: boolean | null;
}

interface RawStatusSelection {
  id: string;
  type?: string | null;
  /** SelectionMode: "Single" picks one option; "List" exposes all items (never picked directly). */
  mode?: string | null;
  /** Server-side completion truth for the selection. */
  isComplete?: boolean | null;
  isLocked?: boolean | null;
  blueprintMonitorId?: string | null;
  parentOptionId?: string | null;
  /**
   * VOY-1718: the *List selection this Single decision mirrors its options
   * from (populated on mirror selections; null on lists/rates/leaves). Used to
   * classify a suppressed pick as a same-list `alternate` vs a `deadBranch`
   * under a parent option that was not chosen.
   */
  mirrorListSelectionId?: string | null;
  travellerOptionChoices?: RawTravellerChoice[] | null;
  inputs?: RawSelectionInput[] | null;
  options?: { id: string; name?: string | null; isBookable?: boolean | null }[] | null;
}

interface RawRequirement {
  label?: string | null;
  isFulfilled: boolean;
  isRequired: boolean;
  selectionId?: string | null;
  type?: string | null;
  missingTravellerIds?: string[] | null;
}

interface RawGoal {
  id: string;
  name?: string | null;
  type?: string | null;
  sortOrder?: number | null;
  isDecided?: boolean | null;
  isBooked?: boolean | null;
  checkoutReadiness?: { isReady: boolean; requirements?: RawRequirement[] | null } | null;
  items?: { id: string; title?: string | null; selections?: RawStatusSelection[] | null }[] | null;
}

export interface PlanStatusQueryResult {
  tripPlan: {
    id: string;
    title?: string | null;
    travellers?: RawTraveller[] | null;
    cart?: {
      itemCount?: number | null;
      total?: number | null;
      currency?: string | null;
      items?: RawCartItem[] | null;
    } | null;
  } | null;
  tripPlanGoals?: RawGoal[] | null;
}

// ── Output contract shapes ──────────────────────────────────────────────────

export type Readiness = "BOOKED" | "READY_TO_BOOK" | "BLOCKED" | "IN_PROGRESS";

export type BlockerKind =
  | "TRAVELLER_DATA"
  | "SELECTION_INPUT"
  | "PICK_PENDING"
  | "REQUIREMENT_UNMET";

export type WaitingKind = "OPTIONS_PENDING" | "CART_PENDING";

export interface Blocker {
  kind: BlockerKind;
  message: string;
  refs: { travellerId?: string; selectionId?: string; goalId?: string };
  /**
   * true when the server reported this requirement without referencing any
   * selection (refs.selectionId absent), so the CLI cannot verify it or point
   * at a fixing command (VOY-1714/VOY-1715: goal-level checkoutReadiness refs
   * are unstable — e.g. "Cabin class" stays unfulfilled with a null ref even
   * after the FlightClass selection in the shared Flight Booking Details goal
   * is complete). Unverified blockers may be phantoms: `voyagier book <planId>
   * --dry-run` is the checkout truth — when it reports no blockers, trust it
   * over these.
   */
  unverified?: true;
  /**
   * VOY-1718: for an aggregated PICK_PENDING (one blocker standing in for a
   * whole group of sibling candidate selections whose parent hasn't been
   * picked yet), the ids of the candidate selections it rolls up. Absent on
   * ordinary single-selection blockers. Pick the PARENT decision first, then
   * re-run plan-status — the aggregate collapses once a branch is chosen.
   */
  candidateSelectionIds?: string[];
}

export interface Waiting {
  kind: WaitingKind;
  message: string;
  refs: { selectionId?: string; goalId?: string };
}

export interface PlanStatusData {
  planId: string;
  title: string | null;
  url: string;
  readiness: Readiness;
  summary: {
    goalsTotal: number;
    goalsDecided: number;
    goalsBooked: number;
    blockerCount: number;
    /**
     * VOY-1718: total Single-mode selections suppressed as alternate branches
     * across all goals — incomplete picks under a decision whose type already
     * has a complete/booked sibling chain. Informational; never a blocker.
     */
    alternateBranchCount: number;
    /**
     * VOY-1724: true when the cart holds ≥1 bookable item AND every remaining
     * blocker is `unverified` (i.e. the only things standing between this plan
     * and checkout are unverifiable server refs — see the `unverified` blocker
     * note). When readiness is BLOCKED but `bookableNow` is true, an agent
     * should trust `book --dry-run` (the checkout truth) over the blockers.
     * Additive; the readiness enum is unchanged.
     */
    bookableNow: boolean;
  };
  goals: {
    goalId: string;
    name: string | null;
    type: string | null;
    isDecided: boolean;
    isBooked: boolean;
    isReady: boolean;
    /** VOY-1718: suppressed alternate-branch selections in this goal. */
    alternateBranchCount: number;
    selections: {
      selectionId: string;
      type: string | null;
      mode: string | null;
      /** Server-side completion truth. */
      isComplete: boolean;
      status: string;
      chosenOptionId: string | null;
      chosenOptionName: string | null;
      /**
       * VOY-1718 branch classification:
       *   "active"     — a live decision surface (or a complete sibling).
       *   "alternate"  — an incomplete pick suppressed because a sibling of the
       *                  same type is already complete AND it mirrors the same
       *                  list (a legit extra mirror of the chosen branch).
       *   "deadBranch" — an incomplete pick under a parent option that was NOT
       *                  chosen (mirrors a different list than the completed
       *                  sibling). Its pick never surfaces as a blocker.
       */
      branch: "active" | "alternate" | "deadBranch";
      consensus: boolean;
      /** Every traveller with a choice row has picked (picks may differ — that's valid). */
      allPicked: boolean;
      travellersPending: string[];
      blockedOn: { fieldName: string; fieldLabel: string | null }[];
      blockedOnUnavailable: boolean;
    }[];
    unmetRequirements: {
      label: string | null;
      selectionId: string | null;
      type: string | null;
      missingTravellerIds: string[];
    }[];
  }[];
  travellers: { travellerId: string; name: string; missing: string[] }[];
  cart: { itemCount: number; bookableCount: number; total: number; currency: string };
  blockers: Blocker[];
  waiting: Waiting[];
  nextSteps: string[];
}

// ── Pure builder (unit-testable without any I/O) ────────────────────────────

function travellerName(t: { firstName?: string | null; lastName?: string | null }): string {
  return [t.firstName, t.lastName].filter(Boolean).join(" ") || "(unnamed)";
}

export function buildPlanStatus(
  data: PlanStatusQueryResult,
  planUrlBase: string,
  /**
   * VOY-1724: selectionId → resolved supplier hotelCode, for the chosen Hotel
   * selection and each room-chain sibling. When present, a HotelRoom/
   * HotelRoomRate whose code ≠ the chosen hotel's code is a dead branch
   * IMMEDIATELY (even pre-room-pick); a matching one stays active. Absent (or a
   * code missing on either side) → the VOY-1718 completion-evidence rule applies
   * as fallback. Populated by `resolveHotelCodes` before this pure builder runs.
   */
  hotelCodeBySelection?: Map<string, string>,
): PlanStatusData {
  if (!data.tripPlan) {
    throw new Error("buildPlanStatus: tripPlan is null — caller must verify the plan exists first");
  }
  const plan = data.tripPlan;
  const goals = [...(data.tripPlanGoals ?? [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  const travellers = plan.travellers ?? [];
  const cartItems = plan.cart?.items ?? [];

  // Bookability join: cart items reference selectionId+optionId; the goals
  // walk below carries options[].isBookable. Same key scheme as cart-helpers'
  // buildBookabilityIndex — unknown resolves conservatively to not-bookable.
  const bookableOptionKeys = new Set<string>();
  for (const g of data.tripPlanGoals ?? []) {
    for (const item of g.items ?? []) {
      for (const sel of item.selections ?? []) {
        for (const opt of sel.options ?? []) {
          if (opt.isBookable === true) bookableOptionKeys.add(`${sel.id}:${opt.id}`);
        }
      }
    }
  }
  const bookableCartItems = cartItems.filter(
    (i) => i.selectionId && i.optionId && bookableOptionKeys.has(`${i.selectionId}:${i.optionId}`),
  );
  const bookableCount = bookableCartItems.length;
  // VOY-1718: which selections have a bookable item in the cart — counts as
  // completion evidence for that selection's type even if `isComplete` lags.
  const bookableCartSelectionIds = new Set(
    bookableCartItems.map((i) => i.selectionId as string),
  );
  const cart = {
    itemCount: plan.cart?.itemCount ?? 0,
    bookableCount,
    total: plan.cart?.total ?? 0,
    currency: plan.cart?.currency ?? "USD",
  };

  const blockers: Blocker[] = [];
  const waiting: Waiting[] = [];

  // 1. TRAVELLER_DATA — blockers fire only on SERVER-DRIVEN demand: either
  //    an unmet required TravellerField checkout requirement references the
  //    traveller, or the itinerary is international (cart requiresPassport,
  //    fails closed) and the traveller has no passport. `travellers[].missing`
  //    stays informational for every traveller regardless, but a hotel-only
  //    plan with a DOB-less traveller is NOT blocked when the server doesn't
  //    require the field.
  const passportRequired = cartItems.some((i) => i.requiresPassport === true);
  const travellerFieldDemand = new Set<string>();
  for (const g of goals) {
    for (const r of g.checkoutReadiness?.requirements ?? []) {
      if (r.isRequired && !r.isFulfilled && r.type === "TravellerField") {
        for (const id of r.missingTravellerIds ?? []) travellerFieldDemand.add(id);
      }
    }
  }
  const travellerOut = travellers.map((t) => {
    const missing: string[] = [];
    if (!t.gender) missing.push("gender");
    if (!t.dateOfBirth) missing.push("dateOfBirth");
    if (passportRequired && !t.passport?.last4) missing.push("passport");
    return { travellerId: t.id, name: travellerName(t), missing };
  });
  for (const t of travellerOut) {
    const demanded =
      travellerFieldDemand.has(t.travellerId) ||
      (passportRequired && t.missing.includes("passport"));
    if (t.missing.length > 0 && demanded) {
      blockers.push({
        kind: "TRAVELLER_DATA",
        message: `${t.name} is missing ${t.missing.join(" and ")} (required for checkout)`,
        refs: { travellerId: t.travellerId },
      });
    }
  }

  // 2–3. Walk goal selections: SELECTION_INPUT / PICK_PENDING blockers,
  //      OPTIONS_PENDING waits.
  const coveredSelectionIds = new Set<string>();
  // VOY-1718: selections suppressed as alternate branches (across all goals),
  // read by the REQUIREMENT_UNMET pass to downgrade requirements that point at
  // a dead branch instead of hiding them via coveredSelectionIds dedupe.
  const suppressedSelectionIds = new Set<string>();
  const goalsOut = goals.map((g) => {
    const selections = (g.items ?? []).flatMap((i) => i.selections ?? []);

    // Enrich each selection once (status + chosen/allPicked derivation) so the
    // dead-branch pre-pass and the output walk share one computation.
    const enriched = selections.map((sel) => {
      const options = sel.options ?? [];
      // classifySelection with monitor:null — monitor detail isn't fetched
      // here (one-round-trip budget); its "monitor id set, state unknown" arm
      // is exactly our semantics: fetchable → FETCHING, not AWAITING_INPUT.
      const { status } = classifySelection({
        id: sel.id,
        type: sel.type,
        blueprintMonitorId: sel.blueprintMonitorId,
        optionCount: options.length,
        monitor: null,
      });
      const { chosenOptionId, consensus } = deriveChosen(sel);
      const choices = sel.travellerOptionChoices ?? [];
      const travellersPending = choices
        .filter((c) => !c.selectedOption?.id)
        .map((c) => c.traveller?.id ?? "(unknown)");
      const allPicked = choices.length > 0 && travellersPending.length === 0;
      const blockedOn = status === "AWAITING_INPUT" ? deriveBlockedOn(sel) : [];
      const blockedOnUnavailable = status === "AWAITING_INPUT" && blockedOn.length === 0;
      // Would this selection emit an ordinary PICK_PENDING (before any
      // dead-branch suppression)? Single-mode decision surface, options ready,
      // nobody has picked, not locked, backend doesn't call it complete.
      const wouldPickPend =
        status === "READY" &&
        !allPicked &&
        !chosenOptionId &&
        !sel.isLocked &&
        sel.mode !== "List" &&
        sel.isComplete !== true;
      return {
        sel,
        options,
        status,
        chosenOptionId,
        consensus,
        choices,
        travellersPending,
        allPicked,
        blockedOn,
        blockedOnUnavailable,
        wouldPickPend,
      };
    });

    // ── VOY-1718 + VOY-1724 branch classification pre-pass ─────────────────
    // Group Single-mode selections by type WITHIN this goal (the goal graph
    // pre-creates a full decision chain per candidate parent option). Two
    // signals settle which branch is live:
    //   VOY-1724 (preferred): the supplier `hotelCode`. Hotel options AND room
    //     options both carry it, so once a hotel is picked we can map every
    //     HotelRoom/HotelRoomRate chain to its parent hotel by code — a
    //     code-mismatched chain is a dead branch IMMEDIATELY, even before any
    //     room is picked.
    //   VOY-1718 (fallback, when a code is missing on either side): completion
    //     evidence — once a same-type sibling is complete/carted, the incomplete
    //     ones are alternates; with no settled member and ≥2 pending, aggregate.
    const branchOf = new Map<string, "active" | "alternate" | "deadBranch">();
    const aggregatedIds = new Set<string>();
    const aggregateBlockers: Blocker[] = [];
    let alternateBranchCount = 0;

    type Enriched = (typeof enriched)[number];
    // Settled = backend-complete OR joined to a bookable cart item (cart truth
    // beats a lagging isComplete flag). A cart-settled selection is evidence,
    // never a suppression target.
    const isSettledSel = (m: Enriched) =>
      m.sel.isComplete === true || bookableCartSelectionIds.has(m.sel.id);
    const suppress = (m: Enriched, branch: "alternate" | "deadBranch") => {
      branchOf.set(m.sel.id, branch);
      suppressedSelectionIds.add(m.sel.id);
      alternateBranchCount += 1;
    };

    // The chosen hotel's supplier code (when a Hotel selection in this goal is
    // settled/picked and we resolved its code).
    const chosenHotelCode = (() => {
      if (!hotelCodeBySelection) return undefined;
      const hotelSel = enriched.find(
        (e) =>
          e.sel.type === "Hotel" &&
          e.sel.mode !== "List" &&
          (e.sel.isComplete === true || bookableCartSelectionIds.has(e.sel.id) || !!e.chosenOptionId),
      );
      return hotelSel ? hotelCodeBySelection.get(hotelSel.sel.id) : undefined;
    })();
    const isRoomChainType = (t: string) => t === "HotelRoom" || t === "HotelRoomRate";

    // Legacy VOY-1718 rule for a type-group (or a code-unresolved subset).
    const classifyGroupLegacy = (members: Enriched[]) => {
      const settled = members.filter(isSettledSel);
      const settledIds = new Set(settled.map((m) => m.sel.id));
      const incomplete = members.filter((m) => !settledIds.has(m.sel.id));
      const typeLabel = members[0]?.sel.type || "Selection";
      if (settled.length > 0) {
        const settledMirrors = new Set(settled.map((m) => m.sel.mirrorListSelectionId ?? null));
        for (const m of incomplete) {
          const mir = m.sel.mirrorListSelectionId ?? null;
          suppress(m, settledMirrors.has(mir) ? "alternate" : "deadBranch");
        }
      } else {
        const candidates = incomplete.filter((m) => m.wouldPickPend);
        if (candidates.length >= 2) {
          for (const c of candidates) aggregatedIds.add(c.sel.id);
          // Distinct mirrored lists = sibling branches. A candidate with no
          // mirrorListSelectionId counts as its OWN branch (unknown list) so
          // mixed null/non-null groups don't undercount.
          const branches = new Set(candidates.map((c) => c.sel.mirrorListSelectionId ?? c.sel.id));
          aggregateBlockers.push({
            kind: "PICK_PENDING",
            message:
              `${g.name ?? typeLabel}: ${typeLabel} pick pending ` +
              `(${candidates.length} candidate selection(s) across ${branches.size} sibling ` +
              `branch(es) — pick the parent decision first, then re-run plan-status)`,
            refs: { goalId: g.id },
            candidateSelectionIds: candidates.map((c) => c.sel.id),
          });
        }
      }
    };

    const singleByType = new Map<string, Enriched[]>();
    for (const e of enriched) {
      // Skip List-mode mirror sources, and skip selections with no `type` —
      // grouping is BY type, so untyped selections can't be meaningfully
      // bucketed together (they'd suppress/aggregate unrelated decisions).
      // (Mode stays `!== "List"`, matching the PICK_PENDING predicate: real
      // decision surfaces may carry a null mode.)
      if (e.sel.mode === "List" || !e.sel.type) continue;
      const bucket = singleByType.get(e.sel.type);
      if (bucket) bucket.push(e);
      else singleByType.set(e.sel.type, [e]);
    }

    for (const [t, members] of singleByType) {
      // VOY-1724 hotelCode path — only for room chains when the chosen hotel's
      // code is known. Coded members are classified directly; any member whose
      // code we couldn't resolve falls back to the VOY-1718 legacy rule.
      if (isRoomChainType(t) && chosenHotelCode) {
        const matching: Enriched[] = [];
        const legacy: Enriched[] = [];
        for (const m of members) {
          const code = hotelCodeBySelection?.get(m.sel.id);
          if (!code) {
            legacy.push(m);
          } else if (code !== chosenHotelCode) {
            // Code-mismatched chain: dead branch immediately (even pre-room-pick).
            if (!isSettledSel(m)) suppress(m, "deadBranch");
          } else {
            matching.push(m); // same hotel — the live chain
          }
        }
        const matchingSettled = matching.filter(isSettledSel);
        const matchingIncomplete = matching.filter((m) => !isSettledSel(m));
        if (matchingSettled.length > 0) {
          // Chosen hotel's room is decided — its incomplete same-hotel mirrors
          // are alternates.
          for (const m of matchingIncomplete) suppress(m, "alternate");
        } else {
          // Collapse the pending same-hotel candidate(s) into ONE blocker that
          // names the chosen hotel (VOY-1724 step 2) — not "N across M branches".
          const live = matchingIncomplete.filter((m) => m.wouldPickPend);
          if (live.length > 0) {
            for (const c of live) aggregatedIds.add(c.sel.id);
            aggregateBlockers.push({
              kind: "PICK_PENDING",
              message:
                `${g.name ?? t}: room pick pending in your chosen hotel — ` +
                `${live.length} candidate selection(s) (pick a room; the baseline rate auto-carts)`,
              refs: { goalId: g.id },
              candidateSelectionIds: live.map((c) => c.sel.id),
            });
          }
        }
        if (legacy.length > 0) classifyGroupLegacy(legacy);
        continue;
      }
      classifyGroupLegacy(members);
    }

    // VOY-1724: List-mode HotelRoomList sources sit outside the pick machinery
    // (they emit no picks — their Single-mode mirrors do), but their `branch`
    // label still reads "active" to an agent browsing selections. When the
    // chosen hotel's code is known, label wrong-hotel list sources deadBranch
    // so agents don't waste reads on selection-options for a lost chain.
    if (chosenHotelCode) {
      for (const e of enriched) {
        if (e.sel.type !== "HotelRoomList" || e.sel.mode !== "List") continue;
        const code = hotelCodeBySelection?.get(e.sel.id);
        if (code && code !== chosenHotelCode && !isSettledSel(e)) {
          suppress(e, "deadBranch");
        }
      }
    }

    const selectionsOut = enriched.map((e) => {
      const { sel, options, status, chosenOptionId, consensus } = e;
      const { travellersPending, allPicked, blockedOn, blockedOnUnavailable } = e;
      const branch = branchOf.get(sel.id) ?? "active";
      const suppressed = branch !== "active";

      // VOY-1718: a suppressed alternate/dead branch emits NO blocker and NO
      // wait — not just no PICK_PENDING. A dead-branch selection awaiting an
      // input, or still fetching options, is as irrelevant as its pending pick
      // (its whole chain lost). Its state stays visible in the selection
      // detail (status/blockedOnUnavailable) for anyone inspecting goals.
      if (!suppressed && status === "AWAITING_INPUT" && !sel.isLocked && blockedOn.length > 0) {
        // Only NAMED inputs become blockers — an AWAITING_INPUT selection with
        // no unbound required inputs is dependency-pending (its inputs flow
        // from upstream outputs); the actionable root cause surfaces via
        // TRAVELLER_DATA / upstream blockers / REQUIREMENT_UNMET instead.
        // It stays visible in the selection detail (blockedOnUnavailable).
        coveredSelectionIds.add(sel.id);
        const named = blockedOn.map((b) => b.fieldLabel ?? b.fieldName).join(", ");
        blockers.push({
          kind: "SELECTION_INPUT",
          message: `${g.name ?? sel.type ?? "Selection"} is blocked on: ${named}`,
          refs: { selectionId: sel.id, goalId: g.id },
        });
      } else if (e.wouldPickPend && !suppressed && !aggregatedIds.has(sel.id)) {
        // A live pick: not a suppressed alternate, not rolled into an aggregate.
        coveredSelectionIds.add(sel.id);
        blockers.push({
          kind: "PICK_PENDING",
          message:
            travellersPending.length > 0 && e.choices.length > travellersPending.length
              ? `${g.name ?? sel.type ?? "Selection"}: ${travellersPending.length} traveller(s) still need to pick`
              : `${g.name ?? sel.type ?? "Selection"} has ${options.length} option(s) ready — none picked yet`,
          refs: { selectionId: sel.id, goalId: g.id },
        });
      } else if (aggregatedIds.has(sel.id)) {
        // Covered by the group's aggregated PICK_PENDING — a requirement that
        // points here dedupes onto the aggregate rather than firing twice.
        coveredSelectionIds.add(sel.id);
      } else if (!suppressed && status === "FETCHING") {
        coveredSelectionIds.add(sel.id);
        waiting.push({
          kind: "OPTIONS_PENDING",
          message: `Options generating for ${g.name ?? sel.type ?? "selection"}`,
          refs: { selectionId: sel.id, goalId: g.id },
        });
      }

      const chosenOptionName =
        (chosenOptionId && options.find((o) => o.id === chosenOptionId)?.name) || null;

      return {
        // VOY-1875: `selectionId` is canonical; `id` is an additive alias so
        // consumers keyed on either name (goal view / selection-options use `id`)
        // can read this selection object generically.
        id: sel.id,
        selectionId: sel.id,
        type: sel.type ?? null,
        mode: sel.mode ?? null,
        isComplete: sel.isComplete === true,
        status,
        chosenOptionId,
        chosenOptionName,
        branch,
        consensus,
        allPicked,
        travellersPending,
        blockedOn,
        blockedOnUnavailable,
      };
    });

    // Aggregated group blockers sit alongside the per-selection ones; the
    // final kind-sort orders all PICK_PENDING together.
    blockers.push(...aggregateBlockers);

    const unmetRequirements = (g.checkoutReadiness?.requirements ?? [])
      .filter((r) => r.isRequired && !r.isFulfilled)
      .map((r) => ({
        label: r.label ?? null,
        selectionId: r.selectionId ?? null,
        type: r.type ?? null,
        missingTravellerIds: r.missingTravellerIds ?? [],
      }));

    return {
      // VOY-1875: `goalId` is canonical; `id` is an additive alias so consumers
      // keyed on either name (goal view uses `id`) can read this goal generically.
      id: g.id,
      goalId: g.id,
      name: g.name ?? null,
      type: g.type ?? null,
      isDecided: g.isBooked === true || g.isDecided === true,
      isBooked: g.isBooked === true,
      isReady: g.checkoutReadiness?.isReady === true,
      alternateBranchCount,
      selections: selectionsOut,
      unmetRequirements,
    };
  });

  // 4. REQUIREMENT_UNMET — server-side readiness requirements not already
  //    covered by a selection-level blocker (dedupe on selectionId) and not
  //    rooted in missing traveller data already reported as TRAVELLER_DATA
  //    (a plan with N goals would otherwise repeat "Gender"/"Date of birth"
  //    N times — the fix is the one travellers-update command either way).
  const blockedTravellerIds = new Set(
    blockers.filter((b) => b.kind === "TRAVELLER_DATA").map((b) => b.refs.travellerId),
  );
  for (const g of goalsOut) {
    for (const r of g.unmetRequirements) {
      // VOY-1718: a requirement pointing at a suppressed alternate/dead branch
      // must NOT be silently deduped by coveredSelectionIds — a sibling chain
      // is complete, so it's very likely a stale ref, but we keep it visible
      // and mark it unverified (checkout truth wins) rather than dropping it.
      const refersSuppressedBranch = !!r.selectionId && suppressedSelectionIds.has(r.selectionId);
      if (r.selectionId && coveredSelectionIds.has(r.selectionId) && !refersSuppressedBranch) continue;
      if (
        r.missingTravellerIds.length > 0 &&
        r.missingTravellerIds.every((id) => blockedTravellerIds.has(id))
      ) {
        continue; // root cause already listed as TRAVELLER_DATA
      }
      // Requirements without a selection ref cannot be verified from goal
      // data (VOY-1715: the fulfilling selection may live in another goal and
      // isFulfilled may never flip). Label them honestly instead of sending
      // the agent into a `plans goal` dead-loop that shows the same null ref.
      const unverified = !r.selectionId || refersSuppressedBranch;
      const suffix = refersSuppressedBranch
        ? " (references an alternate branch — a sibling chain is already complete; verify with book --dry-run)"
        : !r.selectionId
          ? " (server reports this unmet but references no selection — may be stale; verify with book --dry-run)"
          : "";
      blockers.push({
        kind: "REQUIREMENT_UNMET",
        message:
          (r.label
            ? `${g.name ?? "Goal"}: ${r.label}`
            : `${g.name ?? "Goal"} has an unmet checkout requirement`) + suffix,
        refs: {
          goalId: g.goalId,
          ...(r.selectionId ? { selectionId: r.selectionId } : {}),
        },
        ...(unverified ? { unverified: true as const } : {}),
      });
    }
  }

  // Contract: blockers[] is ordered by kind (traveller data → inputs → picks
  // → requirements). Selection walks interleave kinds across goals, so enforce
  // the order explicitly — stable sort keeps goal order within a kind.
  const KIND_RANK: Record<BlockerKind, number> = {
    TRAVELLER_DATA: 0,
    SELECTION_INPUT: 1,
    PICK_PENDING: 2,
    REQUIREMENT_UNMET: 3,
  };
  blockers.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  // Readiness precedence: BOOKED > BLOCKED > IN_PROGRESS > READY_TO_BOOK.
  const goalsBooked = goalsOut.filter((g) => g.isBooked).length;
  const allBooked = goalsOut.length > 0 && goalsBooked === goalsOut.length;
  let readiness: Readiness;
  if (allBooked) {
    // Terminal: nothing left to do — suppress blockers/waits/next steps so an
    // agent switching on BOOKED never sees contradictory advice.
    blockers.length = 0;
    waiting.length = 0;
    readiness = "BOOKED";
  } else if (blockers.length > 0) {
    readiness = "BLOCKED";
  } else if (waiting.length > 0) {
    readiness = "IN_PROGRESS";
  } else if (cart.bookableCount > 0) {
    readiness = "READY_TO_BOOK";
  } else {
    // Nothing blocks, nothing waits, but the cart hasn't materialized
    // BOOKABLE items yet (e.g. FlightClass defaults still propagating —
    // the VOY-1701 cart finding). Self-resolving → wait.
    waiting.push({
      kind: "CART_PENDING",
      message:
        cart.itemCount > 0
          ? `Cart has ${cart.itemCount} item(s) but none report bookable yet (usually resolves within seconds)`
          : "Cart is empty — bookable items not yet generated (usually resolves within seconds)",
      refs: {},
    });
    readiness = "IN_PROGRESS";
  }

  // nextSteps: one runnable command per blocker/wait (deduped), then terminal.
  // SECURITY (VOY-1709): every server-provided id interpolated here goes
  // through shellArg() — nextSteps are documented as directly runnable, so a
  // hostile/corrupted id must never smuggle shell metacharacters into them.
  const nextSteps: string[] = [];
  const push = (cmd: string) => {
    if (!nextSteps.includes(cmd)) nextSteps.push(cmd);
  };
  for (const b of blockers) {
    switch (b.kind) {
      case "TRAVELLER_DATA": {
        // Tailor the flags to what's actually missing — a passport-only gap
        // must not suggest gender/DOB flags that won't unblock anything.
        const missing =
          travellerOut.find((t) => t.travellerId === b.refs.travellerId)?.missing ?? [];
        const flags = [
          missing.includes("gender") ? "--gender <M|F|X>" : null,
          missing.includes("dateOfBirth") ? "--dob <YYYY-MM-DD>" : null,
          missing.includes("passport")
            ? "--passport-number <number> --passport-country <code> --passport-expiry <YYYY-MM>"
            : null,
        ].filter(Boolean);
        push(`voyagier travellers update ${shellArg(b.refs.travellerId)} ${flags.join(" ")}`);
        break;
      }
      case "SELECTION_INPUT":
        push(`voyagier plans goal ${shellArg(b.refs.goalId)} --json   # inspect the blocking requirements`);
        break;
      case "PICK_PENDING":
        if (b.candidateSelectionIds && b.candidateSelectionIds.length === 1) {
          // VOY-1724: hotelCode matching collapsed the group to ONE live chain
          // (the chosen hotel's room) — we know the exact selection, so route
          // straight to the pick instead of a goal inspection.
          const only = b.candidateSelectionIds[0];
          push(`voyagier selection-options ${shellArg(only)} --json   # list options`);
          push(`voyagier select --selection-id ${shellArg(only)} --option-id <optionId>`);
        } else if (b.candidateSelectionIds && b.candidateSelectionIds.length > 0) {
          // Aggregated group blocker — no single selection to pick yet; the
          // agent inspects the candidates and picks the parent decision first.
          push(`voyagier plans goal ${shellArg(b.refs.goalId)} --json   # inspect candidate selections`);
        } else {
          push(`voyagier selection-options ${shellArg(b.refs.selectionId)} --json   # list options`);
          push(`voyagier select --selection-id ${shellArg(b.refs.selectionId)} --option-id <optionId>`);
        }
        break;
      case "REQUIREMENT_UNMET":
        if (b.unverified) {
          // No selection ref to inspect — `plans goal` would just show the
          // same null ref. Route to the checkout truth instead.
          push(`voyagier book ${shellArg(plan.id)} --dry-run --json   # checkout truth — if blockers are [], this requirement is a stale server ref`);
        } else {
          push(`voyagier plans goal ${shellArg(b.refs.goalId)} --json   # inspect the blocking requirements`);
        }
        break;
    }
  }
  for (const w of waiting) {
    if (w.kind === "OPTIONS_PENDING" && w.refs.selectionId) {
      push(`voyagier selection-options ${shellArg(w.refs.selectionId)} --wait --json`);
    } else if (w.kind === "CART_PENDING") {
      push(`voyagier cart ${shellArg(plan.id)} --json   # re-check the cart`);
    }
  }
  if (readiness === "READY_TO_BOOK") {
    push(`voyagier book ${shellArg(plan.id)} --dry-run`);
  }

  // VOY-1724: the cart holds bookable items and nothing left is a VERIFIABLE
  // blocker (all remaining are unverified server refs). An agent seeing BLOCKED
  // here should trust `book --dry-run`. `every` over an empty array is true, so
  // this also reads true on a clean READY_TO_BOOK — harmless and additive.
  const bookableNow = cart.bookableCount > 0 && blockers.every((b) => b.unverified === true);

  return {
    planId: plan.id,
    title: plan.title ?? null,
    ...planUrls(plan.id, planUrlBase),
    readiness,
    summary: {
      goalsTotal: goalsOut.length,
      goalsDecided: goalsOut.filter((g) => g.isDecided).length,
      goalsBooked,
      blockerCount: blockers.length,
      alternateBranchCount: goalsOut.reduce((n, g) => n + g.alternateBranchCount, 0),
      bookableNow,
    },
    goals: goalsOut,
    travellers: travellerOut,
    cart,
    blockers,
    waiting,
    nextSteps,
  };
}

// ── VOY-1724 hotelCode resolution (async, targeted, payload-disciplined) ────

interface HotelOptionDataResult {
  getTripPlanSelection: {
    __typename?: string;
    id?: string;
    options?: { id: string; optionData?: { hotelCode?: unknown } | null }[] | null;
  } | null;
}

/**
 * For every goal that has a COMPLETE Hotel selection with sibling HotelRoom /
 * HotelRoomRate chains, resolve the supplier `hotelCode` of the chosen hotel
 * and of each sibling chain (via its mirrored HotelRoomList). Returns a map
 * selectionId → hotelCode consumed by buildPlanStatus.
 *
 * Payload discipline: we fetch ONLY `id optionData`, pull the one `hotelCode`
 * string out, and discard the payload. Every fetch is best-effort — a failure
 * just leaves that selection uncoded, so buildPlanStatus falls back to the
 * VOY-1718 completion-evidence rule. This never throws.
 */
export async function resolveHotelCodes(
  data: PlanStatusQueryResult,
): Promise<Map<string, string>> {
  const codeBySelection = new Map<string, string>();
  const goals = data.tripPlanGoals ?? [];

  const hotelSelIds = new Set<string>(); // chosen Hotel selections to fetch
  const roomToFetchId = new Map<string, string>(); // roomSelId → id to fetch (its mirror list, or itself)
  const fetchIds = new Set<string>();

  for (const g of goals) {
    const sels = (g.items ?? []).flatMap((i) => i.selections ?? []);
    const hotelSel = sels.find(
      (s) =>
        s.type === "Hotel" &&
        s.mode !== "List" &&
        (s.isComplete === true || !!deriveChosen(s).chosenOptionId),
    );
    const roomSibs = sels.filter(
      (s) => (s.type === "HotelRoom" || s.type === "HotelRoomRate") && s.mode !== "List",
    );
    if (!hotelSel || roomSibs.length === 0) continue;
    hotelSelIds.add(hotelSel.id);
    fetchIds.add(hotelSel.id);
    for (const r of roomSibs) {
      const listId = r.mirrorListSelectionId ?? r.id;
      roomToFetchId.set(r.id, listId);
      fetchIds.add(listId);
    }
  }
  if (fetchIds.size === 0) return codeBySelection;

  // Fetch each id once; keep only { chosen-option code, first code }.
  const fetched = new Map<string, { codeByOption: Map<string, string>; firstCode?: string }>();
  await Promise.all(
    [...fetchIds].map(async (sid) => {
      try {
        const res = await graphql<HotelOptionDataResult>(GET_HOTEL_OPTION_DATA, {
          tripPlanSelectionId: sid,
        });
        const opts = res.getTripPlanSelection?.options ?? [];
        const codeByOption = new Map<string, string>();
        let firstCode: string | undefined;
        for (const o of opts) {
          const code = o.optionData?.hotelCode;
          if (typeof code === "string" && code) {
            codeByOption.set(o.id, code);
            if (!firstCode) firstCode = code;
          }
        }
        fetched.set(sid, { codeByOption, firstCode });
      } catch {
        // Best-effort — leave uncoded, VOY-1718 fallback handles it.
      }
    }),
  );

  // Chosen Hotel selections → the chosen option's code (fallback: first code).
  for (const g of goals) {
    const sels = (g.items ?? []).flatMap((i) => i.selections ?? []);
    for (const s of sels) {
      if (!hotelSelIds.has(s.id)) continue;
      const f = fetched.get(s.id);
      if (!f) continue;
      const chosenId = deriveChosen(s).chosenOptionId;
      const code = (chosenId && f.codeByOption.get(chosenId)) || f.firstCode;
      if (code) codeBySelection.set(s.id, code);
    }
  }
  // Room-chain siblings → the code of their mirrored HotelRoomList (or self).
  // The mirrored list itself was fetched as the room's proxy — map its code
  // too, so List-mode HotelRoomList sources can be branch-labelled as well.
  for (const [roomId, fetchId] of roomToFetchId) {
    const code = fetched.get(fetchId)?.firstCode;
    if (code) {
      codeBySelection.set(roomId, code);
      codeBySelection.set(fetchId, code);
    }
  }
  return codeBySelection;
}

// ── VOY-1724 checkout verification (--verify) ───────────────────────────────

interface VerifyResult {
  bookable: boolean;
  blockers: { itemName: string; reason: string; fix: string }[];
  chargeableSubtotal: number;
  currency: string;
}

/**
 * Run the same checkout dry-run `book --dry-run` uses (shared helper — no logic
 * duplication) and reduce it to the verify payload. Degrades to `{ error }` on
 * any failure — a verify problem must NEVER fail the whole plan-status command.
 */
export async function runVerify(planId: string): Promise<VerifyResult | { error: string }> {
  try {
    const preview = await loadCheckoutPreview(planId);
    return {
      bookable: preview.bookable,
      blockers: preview.blockers.map((b) => ({ itemName: b.itemName, reason: b.reason, fix: b.fix })),
      chargeableSubtotal: preview.chargeableSubtotal,
      currency: preview.currency,
    };
  } catch (err) {
    const code = err instanceof CliError ? err.code : CliErrorCode.API_ERROR;
    return { error: code };
  }
}

function isVerifyError(v: VerifyResult | { error: string }): v is { error: string } {
  return (v as { error?: string }).error !== undefined;
}

// ── Rendering (human/agent output is strictly a rendering of the JSON) ─────

const READINESS_BADGE: Record<Readiness, string> = {
  BOOKED: "✅ BOOKED",
  READY_TO_BOOK: "🟢 READY TO BOOK",
  BLOCKED: "🔴 BLOCKED — action needed",
  IN_PROGRESS: "🟡 IN PROGRESS — waiting on the system",
};

function renderHuman(s: PlanStatusData, verify?: VerifyResult | { error: string }): void {
  console.log();
  console.log(`${chalk.bold(s.title ?? s.planId)}  ${READINESS_BADGE[s.readiness]}`);
  console.log(chalk.dim(s.url));
  console.log(
    chalk.dim(
      `Goals: ${s.summary.goalsDecided}/${s.summary.goalsTotal} decided · ${s.summary.goalsBooked} booked · Cart: ${s.cart.itemCount} item(s) ${s.cart.total > 0 ? formatPrice(s.cart.total) : ""}`,
    ),
  );

  // VOY-1724: BLOCKED but every blocker is unverified and the cart is bookable —
  // say so, and point at the checkout truth. Don't let the red badge alone tell
  // the agent to keep grinding on phantom blockers.
  if (s.readiness === "BLOCKED" && s.summary.bookableNow) {
    console.log(
      chalk.yellow(
        `  ⚠ all remaining blockers are unverified — the cart holds ${s.cart.bookableCount} bookable item(s); verify with book --dry-run`,
      ),
    );
  }

  if (s.blockers.length > 0) {
    console.log();
    console.log(chalk.bold("Blockers (in order):"));
    for (const b of s.blockers) {
      console.log(`  ${chalk.red("●")} [${b.kind}] ${b.message}`);
    }
  }
  if (s.summary.alternateBranchCount > 0) {
    console.log(
      chalk.dim(
        `  (${s.summary.alternateBranchCount} alternate-branch selection(s) suppressed — sibling chains superseded by a settled pick of the same type; see goals detail)`,
      ),
    );
  }
  if (s.waiting.length > 0) {
    console.log();
    console.log(chalk.bold("Waiting on the system (no action needed):"));
    for (const w of s.waiting) {
      console.log(`  ${chalk.yellow("◌")} ${w.message}`);
    }
  }

  console.log();
  console.log(chalk.bold("Goals:"));
  for (const g of s.goals) {
    const badge = g.isBooked ? "✅" : g.isReady ? "🟢" : "⏳";
    console.log(`  ${badge} ${g.name ?? g.type ?? g.goalId}`);
    for (const sel of g.selections) {
      if (sel.branch !== "active") {
        // Suppressed alternate/dead branch — dim, marked (alt), never a to-do.
        console.log(chalk.dim(`      ${sel.type ?? "?"} · ${sel.status} (alt)`));
        continue;
      }
      // Divergent-complete picks are VALID: everyone picked, picks differ.
      const chosen = sel.chosenOptionName
        ? chalk.green(sel.chosenOptionName)
        : sel.allPicked && !sel.consensus
          ? chalk.green("picked") + chalk.dim(" (differs per traveller)")
          : chalk.dim(sel.status);
      console.log(`      ${sel.type ?? "?"} · ${chosen}`);
    }
  }

  if (s.nextSteps.length > 0) {
    console.log();
    console.log(chalk.bold("Next steps:"));
    for (const cmd of s.nextSteps) console.log(`  ${chalk.cyan("$")} ${cmd}`);
  }

  if (verify) {
    console.log();
    console.log(chalk.bold("Checkout verification (book --dry-run):"));
    if (isVerifyError(verify)) {
      console.log(chalk.yellow(`  ⚠ could not verify (${verify.error}) — run: voyagier book ${shellArg(s.planId)} --dry-run`));
    } else {
      console.log(
        `  ${verify.bookable ? chalk.green("✓ bookable") : chalk.red("✗ nothing bookable")} · chargeable ${formatPrice(verify.chargeableSubtotal)} ${verify.currency}`,
      );
      for (const b of verify.blockers) console.log(chalk.yellow(`    • ${b.itemName} — ${b.reason}`));
    }
  }
  console.log();
}

function renderAgent(s: PlanStatusData, verify?: VerifyResult | { error: string }): void {
  const lines: string[] = [];
  lines.push(`# Plan status: ${s.title ?? s.planId}`);
  lines.push("");
  lines.push(`- readiness: **${s.readiness}**`);
  lines.push(
    `- goals: ${s.summary.goalsDecided}/${s.summary.goalsTotal} decided, ${s.summary.goalsBooked} booked`,
  );
  lines.push(`- cart: ${s.cart.itemCount} item(s), ${formatPrice(s.cart.total)} ${s.cart.currency}`);
  if (s.readiness === "BLOCKED" && s.summary.bookableNow) {
    lines.push(
      `- ⚠️ all remaining blockers are unverified — the cart holds ${s.cart.bookableCount} bookable item(s); verify with \`voyagier book ${shellArg(s.planId)} --dry-run\``,
    );
  }
  if (s.blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers (act on these, in order)");
    for (const b of s.blockers) lines.push(`- [${b.kind}] ${b.message}`);
  }
  if (s.summary.alternateBranchCount > 0) {
    lines.push("");
    lines.push(
      `_${s.summary.alternateBranchCount} alternate-branch selection(s) suppressed — sibling chains superseded by a settled pick of the same type; not blockers._`,
    );
  }
  if (s.waiting.length > 0) {
    lines.push("");
    lines.push("## Waiting (self-resolving — poll, don't act)");
    for (const w of s.waiting) lines.push(`- [${w.kind}] ${w.message}`);
  }
  if (s.nextSteps.length > 0) {
    lines.push("");
    lines.push("## Next steps");
    for (const cmd of s.nextSteps) lines.push(`\`${cmd}\``);
  }
  if (verify) {
    lines.push("");
    lines.push("## Checkout verification (book --dry-run)");
    if (isVerifyError(verify)) {
      lines.push(`- ⚠️ could not verify (${verify.error}) — run \`voyagier book ${shellArg(s.planId)} --dry-run\``);
    } else {
      lines.push(
        `- ${verify.bookable ? "bookable" : "nothing bookable"} — chargeable ${formatPrice(verify.chargeableSubtotal)} ${verify.currency}`,
      );
      for (const b of verify.blockers) lines.push(`- blocker: ${b.itemName} — ${b.reason}`);
    }
  }
  console.log(lines.join("\n"));
}

// ── Command registration ────────────────────────────────────────────────────

export function registerPlanStatusCommand(program: Command): void {
  program
    .command("plan-status [planId]")
    .description(
      "One-shot readiness: what's left before this plan can book (goals, picks, blockers, next steps)",
    )
    .option("--json", "Output structured JSON envelope")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .option("--verify", "Also run the book --dry-run checkout truth and append a verify section")
    .action(async (planIdInput: string | undefined, opts: { json?: boolean; agent?: boolean; verify?: boolean; plan?: string }) => {
      const planId = resolvePlanArg(planIdInput, opts, "plan-status");
      let data: PlanStatusQueryResult;
      try {
        data = await graphql<PlanStatusQueryResult>(GET_PLAN_STATUS, { id: planId });
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load plan status: ${message}`);
      }
      if (!data.tripPlan) {
        throw new CliError(CliErrorCode.NOT_FOUND, `Trip plan ${planId} not found.`);
      }

      // VOY-1724: resolve supplier hotelCodes (best-effort) so room chains map
      // to the chosen hotel deterministically. Never throws.
      const hotelCodes = await resolveHotelCodes(data);
      const status = buildPlanStatus(data, deriveBaseUrl(getApiUrl()), hotelCodes);

      // --verify: append the checkout truth. Degrades gracefully; never fails
      // the whole command.
      const verify = opts.verify ? await runVerify(planId) : undefined;

      if (opts.json) {
        jsonOutput({ ok: true, data: verify ? { ...status, verify } : status });
      } else if (opts.agent) {
        renderAgent(status, verify);
      } else {
        renderHuman(status, verify);
      }
    });
}
