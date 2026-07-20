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
 *   picks → requirements), each { kind, message, refs }.
 * - `waiting[]` = self-resolving waits, kept SEPARATE from blockers because
 *   acting on them won't help.
 * - `nextSteps[]` = runnable commands mapping onto blockers/waits, ending with
 *   the terminal command when ready.
 * - Divergent picks are VALID (demmersong 2026-07-20): if every traveller
 *   picked, the pick is complete even when picks differ. `consensus: false`
 *   is informational; PICK_PENDING fires only when someone hasn't picked.
 * - STABILITY PROMISE: additive-only. Keys are never renamed/removed; new
 *   blocker/waiting kinds may appear — consumers must tolerate unknown kinds.
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
import { deriveBaseUrl, formatPrice } from "../utils.js";
import { GET_PLAN_STATUS } from "../queries.js";
import { classifySelection } from "../selection-status.js";
import {
  deriveChosen,
  deriveBlockedOn,
  type RawTravellerChoice,
  type RawSelectionInput,
} from "../choices.js";

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
  };
  goals: {
    goalId: string;
    name: string | null;
    type: string | null;
    isDecided: boolean;
    isBooked: boolean;
    isReady: boolean;
    selections: {
      selectionId: string;
      type: string | null;
      mode: string | null;
      /** Server-side completion truth. */
      isComplete: boolean;
      status: string;
      chosenOptionId: string | null;
      chosenOptionName: string | null;
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

export function buildPlanStatus(data: PlanStatusQueryResult, planUrlBase: string): PlanStatusData {
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
  const bookableCount = cartItems.filter(
    (i) => i.selectionId && i.optionId && bookableOptionKeys.has(`${i.selectionId}:${i.optionId}`),
  ).length;
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
  const goalsOut = goals.map((g) => {
    const selections = (g.items ?? []).flatMap((i) => i.selections ?? []);
    const selectionsOut = selections.map((sel) => {
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

      if (status === "AWAITING_INPUT" && !sel.isLocked && blockedOn.length > 0) {
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
      } else if (
        status === "READY" &&
        !allPicked &&
        !chosenOptionId &&
        !sel.isLocked &&
        // Only Single-mode selections are decision surfaces an agent picks;
        // List-mode selections (FlightList, HotelList, FlightJourney, …)
        // expose items for OTHER selections to mirror — never picked directly.
        sel.mode !== "List" &&
        // Server-side completion wins: if the backend says complete, no pick
        // is pending regardless of how the choice rows look from here.
        sel.isComplete !== true
      ) {
        coveredSelectionIds.add(sel.id);
        blockers.push({
          kind: "PICK_PENDING",
          message:
            travellersPending.length > 0 && choices.length > travellersPending.length
              ? `${g.name ?? sel.type ?? "Selection"}: ${travellersPending.length} traveller(s) still need to pick`
              : `${g.name ?? sel.type ?? "Selection"} has ${options.length} option(s) ready — none picked yet`,
          refs: { selectionId: sel.id, goalId: g.id },
        });
      } else if (status === "FETCHING") {
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
        selectionId: sel.id,
        type: sel.type ?? null,
        mode: sel.mode ?? null,
        isComplete: sel.isComplete === true,
        status,
        chosenOptionId,
        chosenOptionName,
        consensus,
        allPicked,
        travellersPending,
        blockedOn,
        blockedOnUnavailable,
      };
    });

    const unmetRequirements = (g.checkoutReadiness?.requirements ?? [])
      .filter((r) => r.isRequired && !r.isFulfilled)
      .map((r) => ({
        label: r.label ?? null,
        selectionId: r.selectionId ?? null,
        type: r.type ?? null,
        missingTravellerIds: r.missingTravellerIds ?? [],
      }));

    return {
      goalId: g.id,
      name: g.name ?? null,
      type: g.type ?? null,
      isDecided: g.isBooked === true || g.isDecided === true,
      isBooked: g.isBooked === true,
      isReady: g.checkoutReadiness?.isReady === true,
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
      if (r.selectionId && coveredSelectionIds.has(r.selectionId)) continue;
      if (
        r.missingTravellerIds.length > 0 &&
        r.missingTravellerIds.every((id) => blockedTravellerIds.has(id))
      ) {
        continue; // root cause already listed as TRAVELLER_DATA
      }
      blockers.push({
        kind: "REQUIREMENT_UNMET",
        message: r.label
          ? `${g.name ?? "Goal"}: ${r.label}`
          : `${g.name ?? "Goal"} has an unmet checkout requirement`,
        refs: {
          goalId: g.goalId,
          ...(r.selectionId ? { selectionId: r.selectionId } : {}),
        },
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
        push(`voyagier travellers update ${b.refs.travellerId} ${flags.join(" ")}`);
        break;
      }
      case "SELECTION_INPUT":
        push(`voyagier plans goal ${b.refs.goalId} --json   # inspect the blocking requirements`);
        break;
      case "PICK_PENDING":
        push(`voyagier selection-options ${b.refs.selectionId} --json   # list options`);
        push(`voyagier select --selection-id ${b.refs.selectionId} --option-id <optionId>`);
        break;
      case "REQUIREMENT_UNMET":
        push(`voyagier plans goal ${b.refs.goalId} --json   # inspect the blocking requirements`);
        break;
    }
  }
  for (const w of waiting) {
    if (w.kind === "OPTIONS_PENDING" && w.refs.selectionId) {
      push(`voyagier selection-options ${w.refs.selectionId} --wait --json`);
    } else if (w.kind === "CART_PENDING") {
      push(`voyagier cart ${plan.id} --json   # re-check the cart`);
    }
  }
  if (readiness === "READY_TO_BOOK") {
    push(`voyagier book ${plan.id} --dry-run`);
  }

  return {
    planId: plan.id,
    title: plan.title ?? null,
    url: `${planUrlBase}/plans/${plan.id}`,
    readiness,
    summary: {
      goalsTotal: goalsOut.length,
      goalsDecided: goalsOut.filter((g) => g.isDecided).length,
      goalsBooked,
      blockerCount: blockers.length,
    },
    goals: goalsOut,
    travellers: travellerOut,
    cart,
    blockers,
    waiting,
    nextSteps,
  };
}

// ── Rendering (human/agent output is strictly a rendering of the JSON) ─────

const READINESS_BADGE: Record<Readiness, string> = {
  BOOKED: "✅ BOOKED",
  READY_TO_BOOK: "🟢 READY TO BOOK",
  BLOCKED: "🔴 BLOCKED — action needed",
  IN_PROGRESS: "🟡 IN PROGRESS — waiting on the system",
};

function renderHuman(s: PlanStatusData): void {
  console.log();
  console.log(`${chalk.bold(s.title ?? s.planId)}  ${READINESS_BADGE[s.readiness]}`);
  console.log(chalk.dim(s.url));
  console.log(
    chalk.dim(
      `Goals: ${s.summary.goalsDecided}/${s.summary.goalsTotal} decided · ${s.summary.goalsBooked} booked · Cart: ${s.cart.itemCount} item(s) ${s.cart.total > 0 ? formatPrice(s.cart.total) : ""}`,
    ),
  );

  if (s.blockers.length > 0) {
    console.log();
    console.log(chalk.bold("Blockers (in order):"));
    for (const b of s.blockers) {
      console.log(`  ${chalk.red("●")} [${b.kind}] ${b.message}`);
    }
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
  console.log();
}

function renderAgent(s: PlanStatusData): void {
  const lines: string[] = [];
  lines.push(`# Plan status: ${s.title ?? s.planId}`);
  lines.push("");
  lines.push(`- readiness: **${s.readiness}**`);
  lines.push(
    `- goals: ${s.summary.goalsDecided}/${s.summary.goalsTotal} decided, ${s.summary.goalsBooked} booked`,
  );
  lines.push(`- cart: ${s.cart.itemCount} item(s), ${s.cart.total} ${s.cart.currency}`);
  if (s.blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers (act on these, in order)");
    for (const b of s.blockers) lines.push(`- [${b.kind}] ${b.message}`);
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
  console.log(lines.join("\n"));
}

// ── Command registration ────────────────────────────────────────────────────

export function registerPlanStatusCommand(program: Command): void {
  program
    .command("plan-status <planId>")
    .description(
      "One-shot readiness: what's left before this plan can book (goals, picks, blockers, next steps)",
    )
    .option("--json", "Output structured JSON envelope")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (planId: string, opts: { json?: boolean; agent?: boolean }) => {
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

      const status = buildPlanStatus(data, deriveBaseUrl(getApiUrl()));

      if (opts.json) {
        jsonOutput({ ok: true, data: status });
      } else if (opts.agent) {
        renderAgent(status);
      } else {
        renderHuman(status);
      }
    });
}
