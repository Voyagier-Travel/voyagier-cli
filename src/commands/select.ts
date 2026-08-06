import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import {
  SET_TRIP_PLAN_SELECTED_OPTION,
  SET_TRAVELLER_CHOICE_FOR_SUBSET,
  SET_TRAVELLER_CHOICE_FOR_GROUP,
  SET_SELECTION_TRAVELLER_CHOICE,
  GET_SELECTION_WITH_MONITOR,
  LIST_TRIP_PLAN_GOALS_DEEP,
} from "../queries.js";
import { loadSearchState, clearSearchState, isSearchStateStale } from "../state.js";
import { deriveBaseUrl, shellArg, validateId } from "../utils.js";
import { clientPlanUrl, planUrls } from "../plan-urls.js";
import { GET_PLAN_STATUS } from "../queries.js";
import { resolveHotelCodes, buildPlanStatus, type PlanStatusQueryResult } from "./plan-status.js";
import { hintFlightSelected, hintHotelSelected } from "../hints.js";
import { progress, warn, fatal, jsonOutput, jsonOutputWithPlan } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { waitForPickSettle, type PickWaitOutcome, type PickScope } from "./select-wait.js";

/**
 * `select` — choose an option on a selection.
 *
 * ONE verb (VOY-1414), now scope-aware (VOY-1692). Since the participant-choice
 * migration the backend records picks as per-traveller choices:
 *   - default            -> setTripPlanSelectedOption (alias for "for ALL travellers")
 *   - --travellers a,b   -> setTripPlanTravellerChoiceForSubset (replaceExisting)
 *   - --group <id>       -> setTripPlanTravellerChoiceForGroup
 *   - --traveller <id>   -> setTripPlanSelectionTravellerChoice (one traveller)
 *
 * Picks land on a goal's SINGLE decision selection (list-mode selections are
 * rejected server-side), and the option must come from that selection's own
 * options (which resolve from its direct mirrored list) — use
 * `selection-options <selectionId>` to list them.
 */

interface SelectionResponse {
  id: string;
  parentOptionId?: string | null;
  parentOption?: { id: string; name: string; price?: number } | null;
}

interface ChoiceScopeOpts {
  traveller?: string;
  travellers?: string;
  group?: string;
}

/**
 * Normalize scope flags: a flag that was PASSED but empty/whitespace is a
 * hard error, never a silent fall-through to the for-all default — that
 * would overwrite every traveller's choice when the caller named one
 * traveller with a bad value. Same contract as resolvePlanArg's --plan
 * handling (empty ≠ omitted). Mutual exclusion is computed on "was the flag
 * provided" (!== undefined), not truthiness, for the same reason.
 */
function normalizeChoiceScope(scope: ChoiceScopeOpts): ChoiceScopeOpts {
  const out: ChoiceScopeOpts = {};
  for (const key of ["traveller", "travellers", "group"] as const) {
    const raw = scope[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === "") {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `--${key} was given an empty value. Pass a real ${key === "group" ? "group id" : "traveller id"}, or omit --${key} to select for all travellers.`,
      );
    }
    out[key] = trimmed;
  }
  const provided = (["traveller", "travellers", "group"] as const).filter((k) => scope[k] !== undefined);
  if (provided.length > 1) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "Use at most ONE of --traveller, --travellers, --group (they are mutually exclusive scopes).",
    );
  }
  return out;
}

/** Human label for the scope a pick applies to (used in success output). */
function scopeLabel(scope: ChoiceScopeOpts): string {
  if (scope.traveller) return `for traveller ${scope.traveller}`;
  if (scope.travellers) return `for ${scope.travellers.split(",").filter((s) => s.trim()).length} traveller(s)`;
  if (scope.group) return `for group ${scope.group}`;
  return "for all travellers";
}

/** Result of a pick, plus routing metadata when a fork-template rejection was
 * auto-routed to the goal's non-template sibling selection (VOY-1872). */
interface PickOutcome {
  result: SelectionResponse;
  /** Original (fork-template) selection id the pick was routed away from. */
  routedFrom?: string;
}

/**
 * Send the pick to the backend for the resolved scope. No error mapping here —
 * the caller owns the catch so a single mapper/router covers both the initial
 * attempt and the fork-template retry (VOY-1872), keeping the scope identical
 * across both (the retry must honor the same --traveller/--travellers/--group).
 */
async function performPick(
  selectionId: string,
  optionId: string,
  scope: ChoiceScopeOpts,
): Promise<SelectionResponse> {
  if (scope.traveller) {
    const data = await graphql<{ setTripPlanSelectionTravellerChoice: SelectionResponse }>(
      SET_SELECTION_TRAVELLER_CHOICE,
      { selectionId, travellerId: scope.traveller, optionId },
    );
    return data.setTripPlanSelectionTravellerChoice;
  }
  if (scope.travellers) {
    const travellerIds = scope.travellers.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (travellerIds.length === 0) {
      throw new CliError(CliErrorCode.VALIDATION, "--travellers requires a comma-separated list of traveller IDs.");
    }
    const data = await graphql<{ setTripPlanTravellerChoiceForSubset: SelectionResponse }>(
      SET_TRAVELLER_CHOICE_FOR_SUBSET,
      { selectionId, travellerIds, optionId, replaceExisting: true },
    );
    return data.setTripPlanTravellerChoiceForSubset;
  }
  if (scope.group) {
    const data = await graphql<{ setTripPlanTravellerChoiceForGroup: SelectionResponse }>(
      SET_TRAVELLER_CHOICE_FOR_GROUP,
      { selectionId, groupId: scope.group, optionId },
    );
    return data.setTripPlanTravellerChoiceForGroup;
  }
  const data = await graphql<{ setTripPlanSelectedOption: SelectionResponse }>(
    SET_TRIP_PLAN_SELECTED_OPTION,
    { selectionId, optionId },
  );
  return data.setTripPlanSelectedOption;
}

async function setSelectedOption(
  selectionId: string,
  optionId: string,
  rawScope: ChoiceScopeOpts = {},
): Promise<PickOutcome> {
  const scope = normalizeChoiceScope(rawScope);
  try {
    return { result: await performPick(selectionId, optionId, scope) };
  } catch (err) {
    // Fork-template rejection: the pick can never land on this selection. Try
    // to auto-route it to the goal's single non-template sibling (VOY-1872);
    // that helper either returns the routed outcome or throws a FORK_TEMPLATE
    // CliError with recovery guidance. Other errors go through the plain mapper.
    if (isForkTemplateRejection(err)) {
      return handleForkTemplate(selectionId, optionId, scope);
    }
    throw mapChoiceError(err, selectionId);
  }
}

/**
 * Translate the backend's two participant-choice signature errors into
 * actionable guidance instead of leaking raw GraphQL messages (VOY-1692).
 */
function mapChoiceError(err: unknown, selectionId: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("list-mode selection")) {
    return new CliError(
      CliErrorCode.API_ERROR,
      `Selection ${selectionId} is a LIST selection (inventory source) — picks are rejected there.\n` +
        `  Choose on the goal's single DECISION selection instead:\n` +
        `    voyagier plans goals <planId> --tree   # find the decision selection (e.g. type Flight, not FlightList/FlightJourney)\n` +
        `    voyagier selection-options <decisionSelectionId>   # its options\n` +
        `    voyagier select --selection-id <decisionSelectionId> --option-id <id>`,
    );
  }
  if (message.includes("Option not found or does not belong")) {
    return new CliError(
      CliErrorCode.API_ERROR,
      `That option does not belong to selection ${selectionId} (the backend only accepts options from the selection itself or its direct mirrored list).\n` +
        `  List THIS selection's options and pick one of those IDs:\n` +
        `    voyagier selection-options ${shellArg(selectionId)} --wait --json`,
    );
  }
  return err;
}

/**
 * Fork-template rejection detector (VOY-1872). The backend rejects picks that
 * target a fork TEMPLATE selection with a message that names it a "fork
 * template"; match on that stable substring only — the surrounding copy and the
 * raw GraphQL operation names it suggests are not a contract and never reach
 * the user.
 */
function isForkTemplateRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("fork template");
}

/** The goal-local context needed to route (or explain) a fork-template pick. */
interface ForkTemplateContext {
  planId: string | null;
  /** Rejected selection's type; routing requires it so siblings match by type. */
  type: string | null;
  /** Same-type sibling selection ids under the same goal (rejected id excluded). */
  candidates: string[];
}

interface SelectionRef {
  id: string;
  type?: string | null;
}

interface GoalDeepItems {
  items?: { selections?: SelectionRef[] | null }[] | null;
}

/**
 * Resolve the rejected selection's plan, type, and same-type sibling selections
 * under its owning goal — reusing only queries the CLI already ships (no new
 * server operations). Best-effort: any failure returns null and the caller
 * emits the plain FORK_TEMPLATE guidance.
 */
async function resolveForkTemplateSiblings(selectionId: string): Promise<ForkTemplateContext | null> {
  try {
    const sel = await graphql<{
      getTripPlanSelection: { id: string; tripPlanId?: string | null; type?: string | null } | null;
    }>(GET_SELECTION_WITH_MONITOR, { tripPlanSelectionId: selectionId });
    const planId = sel.getTripPlanSelection?.tripPlanId ?? null;
    const type = sel.getTripPlanSelection?.type ?? null;
    // Without the plan or the rejected type we cannot match siblings safely.
    if (!planId || !type) return { planId, type, candidates: [] };

    const goalsData = await graphql<{ tripPlanGoals: GoalDeepItems[] }>(
      LIST_TRIP_PLAN_GOALS_DEEP,
      { tripPlanId: planId },
    );
    const goals = goalsData.tripPlanGoals ?? [];
    const owningGoal = goals.find((g) =>
      (g.items ?? []).some((it) => (it.selections ?? []).some((s) => s.id === selectionId)),
    );
    if (!owningGoal) return { planId, type, candidates: [] };

    const candidates = new Set<string>();
    for (const it of owningGoal.items ?? []) {
      for (const s of it.selections ?? []) {
        if (s.id !== selectionId && s.type === type) candidates.add(s.id);
      }
    }
    return { planId, type, candidates: [...candidates] };
  } catch {
    return null;
  }
}

/**
 * Build the FORK_TEMPLATE error with CLI-native recovery steps. The message
 * never echoes the backend's GraphQL operation names; it points at the CLI
 * commands that actually exist (goal tree → sibling select). Known context
 * (plan id, resolved candidates) is surfaced both in the text and in `details`
 * for --json consumers.
 */
function forkTemplateError(selectionId: string, ctx: ForkTemplateContext | null): CliError {
  const planRef = ctx?.planId ? shellArg(ctx.planId) : "<planId>";
  const type = ctx?.type ?? null;
  const candidates = ctx?.candidates ?? [];
  const lines = [
    `Selection ${selectionId} is a fork template — picks are not accepted on it directly.`,
    `  Pick the non-template sibling selection${type ? ` of type ${type}` : ""} under the same goal instead:`,
    `    voyagier plans goals ${planRef} --tree   # list the goal's selections`,
  ];
  if (candidates.length > 1) {
    lines.push(`  Same-type sibling selections found — re-run against the intended one:`);
    for (const c of candidates) {
      lines.push(`    voyagier select --selection-id ${shellArg(c)} --option-id <id>`);
    }
  } else {
    lines.push(`  Then re-run against its id:`);
    lines.push(`    voyagier select --selection-id <siblingId> --option-id <id>`);
  }
  const details: Record<string, unknown> = { forkTemplateSelectionId: selectionId };
  if (ctx?.planId) details.planId = ctx.planId;
  if (type) details.selectionType = type;
  if (candidates.length > 0) details.candidateSelectionIds = candidates;
  return new CliError(CliErrorCode.FORK_TEMPLATE, lines.join("\n"), details);
}

/**
 * Handle a fork-template rejection (VOY-1872). Conservative auto-route: when the
 * rejected selection's goal has EXACTLY ONE same-type sibling, retry the pick
 * once against it (honoring the caller's scope) and report the routing. Zero or
 * multiple siblings, or a failed retry, fall through to the FORK_TEMPLATE error
 * (with candidates listed when known). No second retry.
 */
async function handleForkTemplate(
  selectionId: string,
  optionId: string,
  scope: ChoiceScopeOpts,
): Promise<PickOutcome> {
  const ctx = await resolveForkTemplateSiblings(selectionId);
  const candidates = ctx?.candidates ?? [];
  if (candidates.length === 1) {
    try {
      const result = await performPick(candidates[0], optionId, scope);
      return { result, routedFrom: selectionId };
    } catch {
      // The single candidate also rejected the pick — surface guidance, don't
      // retry again.
      throw forkTemplateError(selectionId, ctx);
    }
  }
  throw forkTemplateError(selectionId, ctx);
}

/** Run the --wait phase after a successful pick. Never throws: a wait
 * failure must not mask the fact that the pick itself SUCCEEDED. */
async function runPickWait(
  selectionId: string,
  optionId: string,
  opts: { traveller?: string; travellers?: string; group?: string; timeout?: string; json?: boolean },
): Promise<PickWaitOutcome | null> {
  const timeoutSec = parseInt(opts.timeout ?? "30", 10);
  const timeoutMs = (isNaN(timeoutSec) || timeoutSec <= 0 ? 30 : timeoutSec) * 1000;
  const scope: PickScope = { traveller: opts.traveller, travellers: opts.travellers, group: opts.group };
  try {
    if (!opts.json) progress("Waiting for readiness to settle...");
    return await waitForPickSettle(selectionId, optionId, scope, timeoutMs, deriveBaseUrl(getApiUrl()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  wait aborted (${message}) — the pick itself succeeded. Check: voyagier plan-status <planId>\n`);
    return null;
  }
}

/** Wait outcome as a JSON-payload fragment (additive to the pick payload). */
function waitJsonFragment(outcome: PickWaitOutcome | null): Record<string, unknown> {
  if (!outcome) return { wait: { aborted: true } };
  return {
    wait: {
      pickVisible: outcome.pickVisible,
      settled: outcome.settled,
      ...(outcome.timedOut ? { timedOut: true } : {}),
      elapsedSeconds: Math.round(outcome.elapsedMs / 1000),
      ...(outcome.planStatus
        ? {
            readiness: outcome.planStatus.readiness,
            blockers: outcome.planStatus.blockers,
            waiting: outcome.planStatus.waiting,
            nextSteps: outcome.planStatus.nextSteps,
          }
        : {}),
      ...(outcome.tripPlanId ? { tripPlanId: outcome.tripPlanId } : {}),
    },
  };
}

/** Wait outcome rendered for --agent (markdown) or human (chalk) output. */
function renderWaitOutcome(outcome: PickWaitOutcome | null, agent: boolean): void {
  const out = (line: string) => process.stdout.write(line + "\n");
  if (!outcome) {
    out(agent ? "\n⚠️ **Wait aborted** — the pick succeeded; check `voyagier plan-status <planId>`." : chalk.yellow("  ⚠ Wait aborted — the pick succeeded; check plan-status."));
    return;
  }
  const s = outcome.planStatus;
  if (outcome.timedOut) {
    const what = outcome.pickVisible ? "readiness is still settling" : "the pick is not yet visible server-side";
    const check = outcome.tripPlanId ? `voyagier plan-status ${shellArg(outcome.tripPlanId)}` : "voyagier plan-status <planId>";
    out(
      agent
        ? `\n⏳ **Wait timed out after ${Math.round(outcome.elapsedMs / 1000)}s** — ${what}. The pick itself succeeded. Check: \`${check}\``
        : chalk.yellow(`  ⏳ Wait timed out after ${Math.round(outcome.elapsedMs / 1000)}s — ${what}. The pick succeeded; check: ${check}`),
    );
  }
  if (!s) return;
  if (agent) {
    out(`\n**Readiness:** ${s.readiness}`);
    for (const b of s.blockers) out(`- 🔴 ${b.kind}: ${b.message}`);
    for (const w of s.waiting) out(`- ⏳ ${w.kind}: ${w.message}`);
    if (s.nextSteps.length > 0) {
      out("\n**Next steps:**");
      for (const step of s.nextSteps) out(`- \`${step}\``);
    }
  } else {
    out(chalk.bold(`\n  Readiness: ${s.readiness}`));
    for (const b of s.blockers) out(chalk.red(`    ✗ ${b.kind}: ${b.message}`));
    for (const w of s.waiting) out(chalk.yellow(`    ⏳ ${w.kind}: ${w.message}`));
    if (s.nextSteps.length > 0) {
      out(chalk.dim("  Next steps:"));
      for (const step of s.nextSteps) out(chalk.dim(`    ${step}`));
    }
  }
}

/**
 * VOY-1724: after a hotel pick, resolve the ACTUAL matching room chain via
 * hotelCode matching so next-steps can name its real selection id instead of a
 * generic "the room decision comes next". Best-effort — returns null (caller
 * falls back to the generic text) if the pick hasn't propagated yet or the
 * chain isn't resolvable. Never throws.
 */
async function resolveChosenHotelRoomStep(tripPlanId: string): Promise<string | null> {
  try {
    const data = await graphql<PlanStatusQueryResult>(GET_PLAN_STATUS, { id: tripPlanId });
    if (!data.tripPlan) return null;
    const codes = await resolveHotelCodes(data);
    const status = buildPlanStatus(data, deriveBaseUrl(getApiUrl()), codes);
    // The collapsed matching-chain blocker: a PICK_PENDING with exactly one
    // candidate whose selection is a room chain (HotelRoom / HotelRoomRate).
    // Matched structurally — blocker message text is display copy, not a
    // contract.
    const typeBySelection = new Map<string, string>();
    for (const g of status.goals) {
      for (const s of g.selections) {
        if (s.type) typeBySelection.set(s.selectionId, s.type);
      }
    }
    const match = status.blockers.find((b) => {
      if (b.kind !== "PICK_PENDING" || b.candidateSelectionIds?.length !== 1) return false;
      return (typeBySelection.get(b.candidateSelectionIds[0]) ?? "").startsWith("HotelRoom");
    });
    return match?.candidateSelectionIds?.[0] ?? null;
  } catch {
    return null;
  }
}

export function registerSelectCommands(program: Command): void {
  program
    .command("select [number]")
    .description("Select an option on a selection (by --selection-id + --option-id, or by index from the last search)")
    .option("--info <n>", "Show full details for option N without selecting")
    .option("--clear", "Clear cached search results")
    .option("--selection-id <id>", "Explicit selection ID (direct mode)")
    .option("--option-id <id>", "Explicit option ID (direct mode)")
    .option("--traveller <id>", "Choose for ONE traveller only")
    .option("--travellers <ids>", "Choose for a subset of travellers (comma-separated IDs; replaces their existing choices)")
    .option("--group <groupId>", "Choose for a traveller group")
    .option("--plan <id>", "Assert that cached results belong to this trip plan (safety check for agent mode)")
    .option("--wait", "After the pick succeeds, wait until it is reflected server-side and plan readiness settles, then report a plan-status snapshot")
    .option("--timeout <seconds>", "Max seconds to wait when --wait is set (default 30)", "30")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (number: string | undefined, opts) => {
      if (opts.clear) {
        clearSearchState();
        if (!opts.json) console.log(chalk.green("✓ Search cache cleared."));
        else process.stdout.write(JSON.stringify({ ok: true, cleared: true }) + "\n");
        return;
      }

      // ── Direct mode: --selection-id + --option-id ───────────────────────
      // Entry is decided on "was the flag provided" (!== undefined), not
      // truthiness, so an empty --selection-id="" is caught here as a garbage
      // id below rather than silently falling through to indexed mode. Same
      // contract as normalizeChoiceScope.
      if (opts.selectionId !== undefined || opts.optionId !== undefined) {
        if (opts.selectionId === undefined || opts.optionId === undefined) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            "Direct mode requires BOTH --selection-id and --option-id.",
          );
        }
        // Reject empty/"null"/"undefined" ids client-side (VOY-1828) — index
        // mode is exempt: its ids come from trusted cached search state, never
        // from these user-supplied flags, so there is nothing to duplicate.
        const selectionId = validateId(opts.selectionId, "--selection-id");
        const optionId = validateId(opts.optionId, "--option-id");
        try {
          if (!opts.json) progress("Selecting option...");
          const { result, routedFrom } = await setSelectedOption(selectionId, optionId, opts);
          const name = result.parentOption?.name ?? optionId;
          const forScope = scopeLabel(opts);
          // VOY-1872: when the pick was auto-routed off a fork template, the
          // pick landed on result.id — wait on THAT selection, not the template.
          const waitOutcome = opts.wait ? await runPickWait(result.id, optionId, opts) : undefined;
          if (opts.json) {
            jsonOutput({
              // ok mirrors the error envelope's shape so agents can check one
              // key on every outcome instead of inferring success from the
              // absence of an error (VOY-1714 finding #9).
              ok: true,
              success: true,
              type: "option_selected",
              selectionId: result.id,
              // VOY-1872: fork-template auto-route — the original (template)
              // selection id the pick was routed away from.
              ...(routedFrom ? { routedFrom } : {}),
              scope: forScope,
              selected: result.parentOption ?? null,
              parentOptionId: result.parentOptionId ?? null,
              ...(waitOutcome !== undefined ? waitJsonFragment(waitOutcome) : {}),
            });
          } else if (opts.agent) {
            if (routedFrom) process.stdout.write(`↪️ **Routed:** ${routedFrom} is a fork template — picked on its sibling ${result.id} instead.\n`);
            process.stdout.write(`✅ **Selected (${forScope}):** ${name}\n`);
            if (waitOutcome !== undefined) renderWaitOutcome(waitOutcome, true);
          } else {
            if (routedFrom) console.log(chalk.yellow(`↪ Routed: ${routedFrom} is a fork template — picked on its sibling ${result.id} instead.`));
            console.log(chalk.green(`✓ Selected ${forScope}: ${name}`));
            if (waitOutcome !== undefined) renderWaitOutcome(waitOutcome, false);
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(CliErrorCode.API_ERROR, `Selection failed: ${message}`);
        }
        return;
      }

      // ── Indexed mode: use last-search state ─────────────────────────────
      const state = loadSearchState();
      if (!state) {
        fatal(
          "No search results cached. Run a search first, or use direct mode:\n  voyagier select --selection-id <id> --option-id <id>",
        );
        return;
      }

      if (opts.plan && state.tripPlanId !== opts.plan) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Plan mismatch: cached results belong to plan ${state.tripPlanId}, not ${opts.plan}. Re-run your search with --plan ${opts.plan}.`,
        );
      }

      if (isSearchStateStale(state)) {
        warn("Search results are over 2 hours old and may have expired.");
        progress("  Re-run your search for current pricing.\n");
      }

      // --info mode: show details without selecting
      const infoIdx = opts.info ? parseInt(opts.info, 10) : null;
      if (infoIdx !== null) {
        const result = state.results.find((r) => r.index === infoIdx);
        if (!result) {
          throw new CliError(CliErrorCode.NOT_FOUND, `No option [${infoIdx}]. Valid range: 1-${state.results.length}`);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
        } else {
          console.log(chalk.bold(`\nOption [${infoIdx}]:`));
          console.log(`  ${result.summary}`);
          console.log(chalk.dim(`  Option ID: ${result.optionId}`));
        }
        return;
      }

      if (!number) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Please specify an option number: voyagier select <number>\n  Available: 1-${state.results.length}`,
        );
      }

      const idx = parseInt(number, 10);
      if (isNaN(idx) || idx < 1) {
        throw new CliError(CliErrorCode.VALIDATION, `Invalid selection: "${number}". Please specify a number (1-${state.results.length}).`);
      }
      const selected = state.results.find((r) => r.index === idx);
      if (!selected) {
        const searchType = state.type === "flights" ? "flights" : state.type === "activities" ? "activities" : "hotels";
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `No option [${idx}]. Valid range: 1-${state.results.length}\n  Tip: voyagier search ${searchType} --plan ${shellArg(state.tripPlanId)} ... to refresh results`,
        );
      }

      try {
        if (!opts.json) progress("Selecting option...");
        const { result, routedFrom } = await setSelectedOption(state.selectionId, selected.optionId, opts);
        // VOY-1872: if auto-routed off a fork template, the pick landed on
        // result.id — wait on THAT selection, not the template.
        const waitOutcome = opts.wait ? await runPickWait(result.id, selected.optionId, opts) : undefined;

        // VOY-1724: after a hotel pick, try to name the actual matching room
        // chain (hotelCode matching). Null → fall back to the generic guidance.
        // Only for agent/json (where next-steps are consumed) — the human path
        // already prints a hint and shouldn't pay the extra resolution queries.
        const roomStep =
          state.type === "hotels" && (opts.json || opts.agent)
            ? await resolveChosenHotelRoomStep(state.tripPlanId)
            : null;

        // VOY-1718: every vertical is a decision chain — a pick usually spawns
        // the NEXT decision. Tell the agent where the chain goes next so it
        // doesn't stop at the parent thinking the goal is done.
        const chainNote =
          state.type === "hotels"
            ? "Picking the hotel spawns its room decision; pick a room and the baseline rate auto-selects. Run plan-status to surface the next pick (tip: passing --wait on a pick returns it inline)."
            : state.type === "flights"
              ? state.returnSelectionId
                ? "Once both legs are picked, choose Fare & Cabin (FlightClass) here in the CLI — it defaults to Economy. Run plan-status to surface it (tip: passing --wait on a pick returns it inline)."
                : "Next: choose Fare & Cabin (FlightClass) here in the CLI — it defaults to Economy. Run plan-status to surface it (tip: passing --wait on a pick returns it inline)."
              : undefined;

        if (opts.json) {
          jsonOutputWithPlan(
            {
              ok: true,
              success: true,
              type:
                state.type === "flights"
                  ? "flight_selected"
                  : state.type === "activities"
                    ? "activity_selected"
                    : "hotel_selected",
              selected: selected.summary,
              selectionId: result.id,
              // VOY-1872: fork-template auto-route — original (template) id.
              ...(routedFrom ? { routedFrom } : {}),
              ...(state.type === "flights" && state.returnSelectionId
                ? { returnSelectionId: state.returnSelectionId, note: "Round trip: choose on returnSelectionId too." }
                : {}),
              parentOptionId: result.parentOptionId ?? null,
              ...(chainNote ? { chainNote } : {}),
              // VOY-1724: the resolved matching room chain's real selection id.
              ...(roomStep ? { roomSelectionId: roomStep } : {}),
              ...planUrls(state.tripPlanId),
              ...(waitOutcome !== undefined ? waitJsonFragment(waitOutcome) : {}),
            },
            state.tripPlanId,
          );
        } else if (opts.agent) {
          const planUrl = clientPlanUrl(state.tripPlanId);
          const icon = state.type === "flights" ? "✈️" : state.type === "activities" ? "🎯" : "🏨";
          const nextSteps = [
            ...(state.type === "flights" && state.returnSelectionId
              ? [
                  `- Choose the RETURN leg too: \`voyagier select --selection-id ${shellArg(state.returnSelectionId)} --option-id <id>\` (options: \`voyagier selection-options ${shellArg(state.returnSelectionId)} --json\`)`,
                  // VOY-1718: after BOTH legs, the Fare & Cabin (FlightClass)
                  // decision is next — the fare class is picked here (seat
                  // selection / cabin upgrades stay airline-side after booking).
                  `- Then pick Fare & Cabin (FlightClass) — defaults to Economy. Surface it: \`voyagier plan-status ${shellArg(state.tripPlanId)} --json\` (tip: \`--wait\` on a pick returns it inline)`,
                ]
              : []),
            // VOY-1718: one-way flight — the Fare & Cabin decision is next.
            ...(state.type === "flights" && !state.returnSelectionId
              ? [
                  `- Next pick: Fare & Cabin (FlightClass) — defaults to Economy. Surface it: \`voyagier plan-status ${shellArg(state.tripPlanId)} --json\` (tip: \`--wait\` on a pick returns it inline)`,
                ]
              : []),
            // VOY-1718/1724: picking a hotel opens its room decision — don't
            // stop here. When hotelCode matching resolved the chosen hotel's
            // room chain, name it directly; otherwise fall back to plan-status.
            ...(state.type === "hotels"
              ? roomStep
                ? [
                    `- Pick a room in your chosen hotel (baseline rate auto-carts): \`voyagier selection-options ${shellArg(roomStep)} --json\` then \`voyagier select --selection-id ${shellArg(roomStep)} --option-id <id>\``,
                  ]
                : [
                    `- Room decision comes next (pick a room → baseline rate auto-carts). Surface it: \`voyagier plan-status ${shellArg(state.tripPlanId)} --json\` (tip: \`--wait\` on a pick returns it inline)`,
                  ]
              : []),
            `- View cart: \`voyagier cart ${shellArg(state.tripPlanId)}\``,
          ];
          process.stdout.write(
            [
              ...(routedFrom
                ? [`↪️ **Routed:** ${routedFrom} is a fork template — picked on its sibling ${result.id} instead.`, ""]
                : []),
              `✅ **${icon} Selected:** ${selected.summary}`,
              "",
              `👉 **View & edit:** ${planUrl}`,
              "",
              "**Next steps:**",
              ...nextSteps,
            ].join("\n") + "\n",
          );
          if (waitOutcome !== undefined) renderWaitOutcome(waitOutcome, true);
        } else {
          const icon = state.type === "flights" ? "✈️" : state.type === "activities" ? "🎯" : "🏨";
          if (routedFrom) console.log(chalk.yellow(`↪ Routed: ${routedFrom} is a fork template — picked on its sibling ${result.id} instead.`));
          console.log(chalk.green(`\n✓ ${icon} Selected: ${selected.summary}`));
          if (state.type === "flights" && state.returnSelectionId) {
            console.log(chalk.dim(`  Round trip: also choose the return leg — voyagier select --selection-id ${shellArg(state.returnSelectionId)} --option-id <id>`));
          }
          if (state.type === "flights") {
            console.log(hintFlightSelected());
          } else if (state.type === "activities") {
            console.log(chalk.dim("  💡 Activity details and timing can be adjusted after booking."));
          } else {
            console.log(hintHotelSelected());
          }
          await printPlanFooter(state.tripPlanId);
          console.log(chalk.dim(`  Next: voyagier plans get ${shellArg(state.tripPlanId)}`));
          if (waitOutcome !== undefined) renderWaitOutcome(waitOutcome, false);
        }

        clearSearchState();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Selection failed: ${message}`);
      }
    });
}
