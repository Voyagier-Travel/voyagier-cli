/**
 * Goals command surface (v2.0.0 — Section 4).
 *
 * Backed by the TripPlanGoal entity introduced in Mark's PR #371 architectural
 * shift. Mark confirmed 2026-05-04 (Slack DM ts 1777910418): "TripPlanGoal
 * mutations are frozen along with ParticipantChoice and BlueprintSync."
 * Promoted from UNSTABLE → LOCKED-STABLE in PHASE2-DESIGN-FREEZE.md.
 *
 * Surface:
 *   voyagier plans goals <planId> [--tree] [--json]
 *   voyagier plans goal <goalId> [--json]
 *   voyagier plans goal-add <planId> --type <SelectionType> [--name] [--relative-day] [--sort-order] [--date] [--scope] [--travellers] [--idempotency-key] [--json]
 *   voyagier plans goal-add-with-selection <planId> --type <SelectionType> [--name] [--scope] [--include-all-travellers] [--initial-search] [--question-template] [--place-before] [--place-after] [--idempotency-key] [--json]
 *   voyagier plans goal-update <goalId> [--name] [--sort-order] [--relative-day] [--date] [--idempotency-key] [--json]
 *   voyagier plans goal-remove <goalId> --force [--idempotency-key] [--json]
 *   voyagier plans goal-assign-travellers <goalId> --travellers <id1,id2> [--idempotency-key] [--json]
 *   voyagier plans goal-add-item <goalId> --item <itemId> [--idempotency-key] [--json]
 *   voyagier plans goal-add-item-with-selection <goalId> --plan <planId> --type <SelectionType> [--idempotency-key] [--json]
 *   voyagier plans goal-reorder <planId> --order <id1,id2,...> [--idempotency-key] [--json]
 *
 * Schema corrections caught during planning (vs. PHASE2-DESIGN-FREEZE.md draft):
 *   1. No `goalReorder` mutation; CLI synthesizes via parallel updateTripPlanGoal.
 *      Non-atomic; --json output always carries `atomic: false` + a `failedGoalIds[]` list.
 *   2. createTripPlanGoalWithSelection uses placeBeforeGoalId/placeAfterGoalId for
 *      positional inserts, NOT sortOrder. Two distinct positioning models.
 *   3. assignTravellersToGoal is a separate post-create mutation — best-effort
 *      after createTripPlanGoal; partial failures surface as warnings with
 *      a `travellersAssigned: []` field.
 *   4. addConstraintToGoal exists but is web-UI-only for v2.0.0-alpha (deferred).
 *   5. addItemWithSelectionToGoal returns { item, selection }, not Boolean.
 *   6. `name` is required on CreateTripPlanGoalInput but optional on
 *      CreateGoalWithSelectionInput.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { shellArg } from "../../utils.js";
import {
  LIST_TRIP_PLAN_GOALS,
  LIST_TRIP_PLAN_GOALS_DEEP,
  GET_TRIP_PLAN_GOAL,
  CREATE_TRIP_PLAN_GOAL,
  CREATE_TRIP_PLAN_GOAL_WITH_SELECTION,
  UPDATE_TRIP_PLAN_GOAL,
  DELETE_TRIP_PLAN_GOAL,
  ADD_ITEM_TO_GOAL,
  ADD_ITEM_WITH_SELECTION_TO_GOAL,
  ASSIGN_TRAVELLERS_TO_GOAL,
} from "../../queries.js";
import {
  SELECTION_TYPES,
  SELECTION_SCOPES,
  SelectionType,
  SelectionScope,
  TripPlanGoalSummary,
  TripPlanGoalDeep,
  CreateGoalResult,
  CheckoutRequirementStatus,
} from "./types.js";

// ---------- Pure helpers (exported for reuse / tests) ----------

/**
 * Normalize a CLI flag value (case-insensitive) to the GraphQL SelectionType
 * enum (PascalCase). Throws VALIDATION error with allowed values listed.
 *
 * Accepts e.g. "hotel", "Hotel", "HOTEL", "hotelroom" → "HotelRoom" via a
 * lowercase-to-canonical lookup.
 */
export function normalizeSelectionType(value: string): SelectionType {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(CliErrorCode.VALIDATION, "Invalid --type: value is empty.");
  }
  const lower = value.trim().toLowerCase();
  const found = SELECTION_TYPES.find(t => t.toLowerCase() === lower);
  if (!found) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid --type "${value}". Must be one of: ${SELECTION_TYPES.join(", ")}`,
    );
  }
  return found;
}

/**
 * Normalize a CLI flag value (case-insensitive) to the GraphQL SelectionScope
 * enum (PascalCase). Throws VALIDATION error with allowed values listed.
 */
export function normalizeSelectionScope(value: string): SelectionScope {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(CliErrorCode.VALIDATION, "Invalid --scope: value is empty.");
  }
  const lower = value.trim().toLowerCase();
  const found = SELECTION_SCOPES.find(s => s.toLowerCase() === lower);
  if (!found) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid --scope "${value}". Must be one of: ${SELECTION_SCOPES.join(", ")}`,
    );
  }
  return found;
}

/**
 * Parse a comma-separated list of ids. Trims, dedupes, drops empties.
 * Throws VALIDATION if the resulting list is empty.
 *
 * `flagName` is used in error messages (e.g., "--travellers", "--order").
 * `dedupe` controls whether duplicates collapse (default true) — set to
 * false when call sites want to detect duplicates explicitly.
 */
export function parseCsvIds(
  csv: string,
  flagName: string,
  options?: { dedupe?: boolean },
): string[] {
  if (typeof csv !== "string") {
    throw new CliError(CliErrorCode.VALIDATION, `${flagName} must be a comma-separated string.`);
  }
  const ids = csv
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const result = options?.dedupe === false ? ids : Array.from(new Set(ids));
  if (result.length === 0) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `${flagName} cannot be empty. Provide at least one id.`,
    );
  }
  return result;
}

/**
 * Parse a comma-separated list of traveller ids. Convenience wrapper around
 * parseCsvIds with the --travellers flag name. Dedupes by default.
 */
export function parseTravellerIds(csv: string): string[] {
  return parseCsvIds(csv, "--travellers");
}

/**
 * Parse an --initial-search JSON blob into an object. Wraps JSON.parse with a
 * friendly error message.
 */
export function parseInitialSearch(json: string): Record<string, unknown> {
  if (typeof json !== "string" || json.trim() === "") {
    throw new CliError(CliErrorCode.VALIDATION, "--initial-search must be a JSON object string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      CliErrorCode.VALIDATION,
      `--initial-search is not valid JSON: ${message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "--initial-search must be a JSON object (e.g., '{\"query\":\"hotel\"}').",
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validate an --date flag. Accepts ISO 8601 date-only (YYYY-MM-DD) or
 * full datetime (YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]). Bad strings throw
 * VALIDATION.
 *
 * Note: this is intentionally stricter than `Date.parse`, which would accept
 * locale strings like "May 4 2026". Agents should always pass canonical ISO
 * forms; loose parsing has historically masked timezone bugs.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseGoalDate(iso: string): string {
  if (typeof iso !== "string" || iso.trim() === "") {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "--date must be an ISO 8601 date or datetime (e.g., 2026-05-04 or 2026-05-04T13:30:00Z).",
    );
  }
  const trimmed = iso.trim();
  const matchesIso = ISO_DATE_RE.test(trimmed) || ISO_DATETIME_RE.test(trimmed);
  if (!matchesIso) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `--date "${iso}" is not a valid ISO 8601 date or datetime (e.g., 2026-05-04 or 2026-05-04T13:30:00Z).`,
    );
  }
  // Belt-and-braces: also reject ISO-shaped but invalid dates like 2026-13-99.
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `--date "${iso}" is not a real calendar date.`,
    );
  }
  return trimmed;
}

/**
 * Compute the set of updateTripPlanGoal({ sortOrder }) calls needed to realize
 * a desired ordering. Pure function for testability.
 *
 * Behavior:
 *   - orderIds is the desired sequence; sortOrder = 1-indexed position.
 *   - Every id in orderIds must exist in goals; otherwise VALIDATION.
 *   - Every goal must be in orderIds; otherwise VALIDATION (no implicit drops).
 *   - Returns only the goals whose sortOrder actually changes (no-op skip).
 */
export function computeReorderUpdates(
  goals: Array<{ id: string; sortOrder: number }>,
  orderIds: string[],
): Array<{ id: string; sortOrder: number }> {
  const goalIds = new Set(goals.map(g => g.id));
  const orderSet = new Set(orderIds);

  if (orderIds.length !== goals.length) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `--order must list every goal exactly once. Plan has ${goals.length} goal(s); --order provided ${orderIds.length}.`,
    );
  }
  for (const id of orderIds) {
    if (!goalIds.has(id)) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `--order contains unknown goal id "${id}". It is not a goal on this plan.`,
      );
    }
  }
  for (const g of goals) {
    if (!orderSet.has(g.id)) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `--order is missing goal id "${g.id}". Pass every goal exactly once.`,
      );
    }
  }
  if (orderSet.size !== orderIds.length) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "--order contains duplicate goal ids.",
    );
  }

  const goalById = new Map(goals.map(g => [g.id, g]));
  const updates: Array<{ id: string; sortOrder: number }> = [];
  for (let i = 0; i < orderIds.length; i++) {
    const id = orderIds[i];
    const desired = i + 1; // 1-indexed
    const current = goalById.get(id)!;
    if (current.sortOrder !== desired) {
      updates.push({ id, sortOrder: desired });
    }
  }
  return updates;
}

// ---------- Output helpers ----------

/**
 * Unfulfilled REQUIRED requirements on a goal — the implicit "blockedOn".
 * Source of truth is the server (checkoutReadiness.requirements); this just
 * filters. Returns [] when readiness is absent (e.g. write-mutation results
 * that don't fetch it).
 */
export function blockingRequirements(g: TripPlanGoalSummary): CheckoutRequirementStatus[] {
  const reqs = g.checkoutReadiness?.requirements ?? [];
  return reqs.filter(r => r.isRequired && !r.isFulfilled);
}

/**
 * Map a blocking requirement to the correct next-step command string.
 *
 * Two requirement shapes exist (CheckoutRequirementType):
 *  - PARTICIPANT_CHOICE  → a missing selection, fixed via `select` DIRECT mode,
 *    which takes FLAGS (`--selection-id` + `--option-id`), NOT positional args.
 *    (Round-trip flights use `--flight-token --phase` instead of `--option-id`.)
 *  - TRAVELLER_FIELD     → a missing traveller attribute (name / DOB); `select`
 *    does NOT fix this — the traveller record must be updated.
 *
 * Returns null when no actionable command applies (e.g. no selectionId).
 */
export function nextStepForRequirement(r: CheckoutRequirementStatus): string | null {
  if (r.type === "TRAVELLER_FIELD") {
    const who = r.missingTravellerIds.length > 0 ? r.missingTravellerIds.join(", ") : "the affected traveller(s)";
    return `set “${r.label ?? "field"}” on ${who} (update the traveller record)`;
  }
  // PARTICIPANT_CHOICE (and any future selection-backed type)
  if (!r.selectionId) return null;
  return `voyagier select --selection-id ${shellArg(r.selectionId)} --option-id <optionId>`;
}

/**
 * One-token goal state for human output: booked > ready > decided > blocked.
 */
function goalStateBadge(g: TripPlanGoalSummary): string {
  if (g.isBooked) return chalk.green(" ✓ booked");
  if (g.checkoutReadiness?.isReady) return chalk.green(" ✓ ready");
  if (g.isDecided) return chalk.yellow(" · decided");
  const blocked = blockingRequirements(g).length;
  if (blocked > 0) return chalk.yellow(` · ${blocked} blocking`);
  return "";
}

function formatGoalLine(g: TripPlanGoalSummary): string {
  const order = chalk.dim(`[${g.sortOrder}]`);
  const name = g.name ? chalk.white(g.name) : chalk.dim("(unnamed)");
  const type = chalk.cyan(g.type);
  const scope = g.scope ? chalk.dim(` · ${g.scope}`) : "";
  const day = typeof g.relativeDay === "number" ? chalk.dim(` · day ${g.relativeDay}`) : "";
  return `  ${order} ${name} (${type}${scope}${day})${goalStateBadge(g)}\n      ID: ${chalk.dim(g.id)}`;
}

// ---------- Command registration ----------

export function registerGoalCommands(plans: Command): void {
  // ---------- LIST ----------
  plans
    .command("goals <planId>")
    .description("List goals for a trip plan, sorted by sortOrder")
    .option("--tree", "Include nested items + selections + travellers")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      try {
        const query = opts.tree ? LIST_TRIP_PLAN_GOALS_DEEP : LIST_TRIP_PLAN_GOALS;
        const data = await graphql<{ tripPlanGoals: TripPlanGoalDeep[] }>(query, { tripPlanId: planId });
        const goals = (data.tripPlanGoals ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              planId,
              goals,
              count: goals.length,
            },
          });
          return;
        }

        console.log(chalk.bold(`\n  Goals — plan ${planId}\n`));
        if (goals.length === 0) {
          console.log(chalk.dim("  No goals yet."));
          console.log();
          return;
        }
        for (const g of goals) {
          console.log(formatGoalLine(g));
          if (opts.tree) {
            const items = g.items ?? [];
            for (const item of items) {
              const selCount = item.selections?.length ?? 0;
              const selLabel = selCount > 0 ? chalk.dim(` · ${selCount} selection${selCount === 1 ? "" : "s"}`) : "";
              console.log(`        ${chalk.dim("·")} ${item.title}${selLabel}`);
            }
            const travs = g.travellers ?? [];
            if (travs.length > 0) {
              const names = travs
                .map(t => [t.firstName, t.lastName].filter(Boolean).join(" ").trim() || t.id)
                .join(", ");
              console.log(`        ${chalk.dim("travellers:")} ${names}`);
            }
          }
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to list goals: ${message}`);
      }
    });

  // ---------- GET ----------
  plans
    .command("goal <goalId>")
    .description("Show details for a single goal (items, selections, travellers)")
    .option("--json", "Output raw JSON")
    .action(async (goalId: string, opts) => {
      try {
        const data = await graphql<{ tripPlanGoal: TripPlanGoalDeep | null }>(GET_TRIP_PLAN_GOAL, { id: goalId });
        const goal = data.tripPlanGoal;
        if (!goal) {
          throw new CliError(CliErrorCode.GOAL_NOT_FOUND, `Goal "${goalId}" not found.`);
        }

        if (opts.json) {
          jsonOutput({ ok: true, data: { goal } });
          return;
        }

        console.log(chalk.bold(`\n  Goal — ${goal.name ?? "(unnamed)"}\n`));
        console.log(`  ID:        ${chalk.dim(goal.id)}`);
        console.log(`  Type:      ${chalk.cyan(goal.type)}`);
        if (goal.scope) console.log(`  Scope:     ${goal.scope}`);
        console.log(`  Order:     ${goal.sortOrder}`);
        if (typeof goal.relativeDay === "number") console.log(`  Day:       ${goal.relativeDay}`);
        if (goal.date) console.log(`  Date:      ${goal.date}`);
        console.log(`  Decided:   ${goal.isDecided ? chalk.green("yes") : chalk.dim("no")}`);
        console.log(`  Booked:    ${goal.isBooked ? chalk.green("yes") : chalk.dim("no")}`);
        console.log(`  Ready:     ${goal.checkoutReadiness?.isReady ? chalk.green("yes") : chalk.dim("no")}`);

        // Readiness requirements = the implicit "blockedOn". Lead with the
        // unfulfilled-required ones and map each to a next-step command.
        const requirements = goal.checkoutReadiness?.requirements ?? [];
        const blocking = blockingRequirements(goal);
        if (blocking.length > 0) {
          console.log(`\n  ${chalk.yellow(`Blocked on (${blocking.length}):`)}`);
          for (const r of blocking) {
            const label = r.label ?? "(unnamed requirement)";
            const where = r.selectionId ? chalk.dim(` → selection ${r.selectionId}`) : "";
            console.log(`    ✗ ${label}${where}`);
            const next = nextStepForRequirement(r);
            if (next) {
              console.log(chalk.dim(`        next: ${next}`));
            }
            if (r.type !== "TRAVELLER_FIELD" && r.missingTravellerIds.length > 0) {
              console.log(chalk.dim(`        missing for travellers: ${r.missingTravellerIds.join(", ")}`));
            }
          }
        } else if (requirements.length > 0) {
          console.log(`\n  ${chalk.green("All required steps fulfilled.")}`);
        }

        const items = goal.items ?? [];
        if (items.length > 0) {
          console.log(`\n  Items (${items.length}):`);
          for (const item of items) {
            const selCount = item.selections?.length ?? 0;
            console.log(`    · ${item.title}${selCount > 0 ? chalk.dim(` (${selCount} selection${selCount === 1 ? "" : "s"})`) : ""}`);
          }
        }
        const travs = goal.travellers ?? [];
        if (travs.length > 0) {
          const names = travs
            .map(t => [t.firstName, t.lastName].filter(Boolean).join(" ").trim() || t.id)
            .join(", ");
          console.log(`\n  Travellers: ${names}`);
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to get goal: ${message}`);
      }
    });

  // ---------- ADD (bare) ----------
  plans
    .command("goal-add <planId>")
    .description("Add a goal to a trip plan (no item/selection)")
    .requiredOption("--type <selectionType>", "Selection type (e.g., Hotel, Flight, Activity)")
    .option("--name <name>", "Goal name (required by API; CLI defaults to '<type> goal' if omitted)")
    .option("--relative-day <n>", "Day offset from trip start (integer)")
    .option("--sort-order <n>", "Initial sort order (integer)")
    .option("--date <iso>", "Goal date (ISO 8601)")
    .option("--scope <scope>", "Selection scope: Group, Traveller, Trip")
    .option("--travellers <ids>", "Comma-separated traveller ids to assign after create")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      try {
        const type = normalizeSelectionType(opts.type);
        // CreateTripPlanGoalInput.name is required by the schema; default if missing.
        const name = opts.name && String(opts.name).trim() !== ""
          ? String(opts.name).trim()
          : `${type} goal`;
        const input: Record<string, unknown> = { tripPlanId: planId, name, type };

        if (opts.relativeDay !== undefined) {
          const n = Number(opts.relativeDay);
          if (!Number.isInteger(n)) {
            throw new CliError(CliErrorCode.VALIDATION, "--relative-day must be an integer.");
          }
          input.relativeDay = n;
        }
        if (opts.sortOrder !== undefined) {
          const n = Number(opts.sortOrder);
          if (!Number.isInteger(n)) {
            throw new CliError(CliErrorCode.VALIDATION, "--sort-order must be an integer.");
          }
          input.sortOrder = n;
        }
        if (opts.date !== undefined) {
          input.date = parseGoalDate(opts.date);
        }
        if (opts.scope !== undefined) {
          input.scope = normalizeSelectionScope(opts.scope);
        }

        const data = await graphql<{ createTripPlanGoal: TripPlanGoalSummary }>(
          CREATE_TRIP_PLAN_GOAL,
          { input },
        );
        const goal = data.createTripPlanGoal;

        // Best-effort post-create traveller assignment.
        let travellersAssigned: string[] | null = [];
        let travellersWarning: string | null = null;
        if (opts.travellers) {
          const travellerIds = parseTravellerIds(opts.travellers);
          try {
            const assignData = await graphql<{ assignTravellersToGoal: boolean }>(
              ASSIGN_TRAVELLERS_TO_GOAL,
              { goalId: goal.id, travellerIds },
            );
            if (assignData.assignTravellersToGoal !== true) {
              travellersAssigned = [];
              travellersWarning = `Goal created but server rejected traveller assignment`;
            } else {
              // Re-fetch to get the server-verified assignment.
              try {
                const refetch = await graphql<{ tripPlanGoal: TripPlanGoalDeep | null }>(
                  GET_TRIP_PLAN_GOAL,
                  { id: goal.id },
                );
                if (refetch.tripPlanGoal) {
                  travellersAssigned = (refetch.tripPlanGoal.travellers ?? []).map(t => t.id);
                } else {
                  travellersAssigned = null;
                  travellersWarning = `Goal created but goal not found in re-fetch; traveller assignment unverified`;
                }
              } catch (refetchErr) {
                const message = refetchErr instanceof Error ? refetchErr.message : String(refetchErr);
                travellersAssigned = travellerIds;
                travellersWarning = `Travellers assigned but re-fetch failed: ${message}`;
              }
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            travellersWarning = `Goal created (id=${goal.id}) but traveller assignment failed: ${message}`;
          }
        }

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              goal,
              travellersAssigned,
              ...(travellersWarning ? { warning: travellersWarning } : {}),
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        console.log(chalk.green(`\n  ✓ Goal created`));
        console.log(formatGoalLine(goal));
        if (travellersAssigned && travellersAssigned.length > 0) {
          console.log(`      ${chalk.dim("travellers:")} ${travellersAssigned.length} assigned`);
        }
        if (travellersWarning) console.log(chalk.yellow(`      ⚠ ${travellersWarning}`));
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to create goal: ${message}`);
      }
    });

  // ---------- ADD WITH SELECTION ----------
  plans
    .command("goal-add-with-selection <planId>")
    .description("Add a goal with an initial item + selection in one call")
    .requiredOption("--type <selectionType>", "Selection type (e.g., Hotel, Flight, Activity)")
    .option("--name <name>", "Goal name (server may auto-name from selection if omitted)")
    .option("--scope <scope>", "Selection scope: Group, Traveller, Trip")
    .option("--include-all-travellers", "Apply this goal to all travellers on the plan", false)
    .option(
      "--initial-search <json>",
      "Agent leverage point: initial search query as a JSON object that seeds this selection (e.g., '{\"query\":\"hotel in Paris\"}'). Pass when the agent has a concrete user intent to anchor with; omit when the goal is exploratory and the user will refine in the web UI. Server uses this as the starting point for the search; selection options will refresh from it.",
    )
    .option(
      "--question-template <s>",
      "Agent leverage point: prompt template the traveller will see in the web UI when answering this goal (e.g., 'Given your luxury preferences and the kids' Paris itinerary, which hotel feels right?'). Pass when the agent has distilled meaningful intent from the user's brief that will improve the downstream traveller UX. Omit when there's nothing concrete to add — the server uses a generic default. Never pass auto-generated boilerplate.",
    )
    .option("--place-before <goalId>", "Insert before this existing goal id (mutually exclusive with --place-after, --sort-order)")
    .option("--place-after <goalId>", "Insert after this existing goal id (mutually exclusive with --place-before, --sort-order)")
    .option("--sort-order <n>", "Explicit sort order (mutually exclusive with --place-before, --place-after)")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      try {
        const type = normalizeSelectionType(opts.type);
        // --place-before, --place-after, and --sort-order are three different
        // positioning models; the server accepts at most one. Enforce here so
        // we never send a mixed payload that produces undefined behavior.
        const positioningFlags = [
          opts.placeBefore ? "--place-before" : null,
          opts.placeAfter ? "--place-after" : null,
          opts.sortOrder !== undefined ? "--sort-order" : null,
        ].filter((v): v is string => v !== null);
        if (positioningFlags.length > 1) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            `${positioningFlags.join(", ")} are mutually exclusive. Pick one positioning model per goal.`,
          );
        }
        const input: Record<string, unknown> = { tripPlanId: planId, type };
        if (opts.name && String(opts.name).trim() !== "") {
          input.name = String(opts.name).trim();
        }
        if (opts.scope !== undefined) {
          input.scope = normalizeSelectionScope(opts.scope);
        }
        if (opts.includeAllTravellers) {
          input.includeAllTravellers = true;
        }
        if (opts.initialSearch !== undefined) {
          input.initialQuery = parseInitialSearch(String(opts.initialSearch));
        }
        if (opts.questionTemplate !== undefined) {
          input.questionTemplate = String(opts.questionTemplate);
        }
        if (opts.placeBefore !== undefined) {
          input.placeBeforeGoalId = String(opts.placeBefore);
        }
        if (opts.placeAfter !== undefined) {
          input.placeAfterGoalId = String(opts.placeAfter);
        }
        if (opts.sortOrder !== undefined) {
          const n = Number(opts.sortOrder);
          if (!Number.isInteger(n)) {
            throw new CliError(CliErrorCode.VALIDATION, "--sort-order must be an integer.");
          }
          input.sortOrder = n;
        }

        const data = await graphql<{ createTripPlanGoalWithSelection: CreateGoalResult }>(
          CREATE_TRIP_PLAN_GOAL_WITH_SELECTION,
          { input },
        );
        const result = data.createTripPlanGoalWithSelection;

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              goal: result.goal,
              item: result.item ?? null,
              selection: result.selection ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        console.log(chalk.green(`\n  ✓ Goal + selection created`));
        console.log(formatGoalLine(result.goal));
        if (result.item) console.log(`      ${chalk.dim("item:")} ${result.item.id}`);
        if (result.selection) console.log(`      ${chalk.dim("selection:")} ${result.selection.id} (${result.selection.type})`);
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to create goal with selection: ${message}`);
      }
    });

  // ---------- UPDATE ----------
  plans
    .command("goal-update <goalId>")
    .description("Update editable fields on a goal")
    .option("--name <name>", "New name")
    .option("--sort-order <n>", "New sort order (integer)")
    .option("--relative-day <n>", "New relative day (integer)")
    .option("--date <iso>", "New date (ISO 8601)")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (goalId: string, opts) => {
      try {
        const input: Record<string, unknown> = {};
        if (opts.name !== undefined && String(opts.name).trim() !== "") {
          input.name = String(opts.name).trim();
        }
        if (opts.sortOrder !== undefined) {
          const n = Number(opts.sortOrder);
          if (!Number.isInteger(n)) {
            throw new CliError(CliErrorCode.VALIDATION, "--sort-order must be an integer.");
          }
          input.sortOrder = n;
        }
        if (opts.relativeDay !== undefined) {
          const n = Number(opts.relativeDay);
          if (!Number.isInteger(n)) {
            throw new CliError(CliErrorCode.VALIDATION, "--relative-day must be an integer.");
          }
          input.relativeDay = n;
        }
        if (opts.date !== undefined) {
          input.date = parseGoalDate(opts.date);
        }

        if (Object.keys(input).length === 0) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            "goal-update requires at least one of --name, --sort-order, --relative-day, --date.",
          );
        }

        const data = await graphql<{ updateTripPlanGoal: TripPlanGoalSummary | null }>(
          UPDATE_TRIP_PLAN_GOAL,
          { id: goalId, input },
        );
        const goal = data.updateTripPlanGoal;
        if (!goal) {
          throw new CliError(CliErrorCode.GOAL_NOT_FOUND, `Goal "${goalId}" not found.`);
        }

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              goal,
              updatedFields: Object.keys(input),
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        console.log(chalk.green(`\n  ✓ Goal updated`));
        console.log(formatGoalLine(goal));
        console.log(chalk.dim(`      updated: ${Object.keys(input).join(", ")}`));
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to update goal: ${message}`);
      }
    });

  // ---------- REMOVE ----------
  plans
    .command("goal-remove <goalId>")
    .description("Delete a goal (use --force to confirm; cascade behavior depends on server)")
    .option("--force", "Required to confirm deletion", false)
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (goalId: string, opts) => {
      try {
        if (!opts.force) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            "goal-remove requires --force. Cascade behavior on items/selections depends on the server; pass --force to confirm.",
          );
        }
        const data = await graphql<{ deleteTripPlanGoal: boolean }>(
          DELETE_TRIP_PLAN_GOAL,
          { id: goalId },
        );
        const ok = data.deleteTripPlanGoal === true;

        if (opts.json) {
          jsonOutput({
            ok,
            data: {
              goalId,
              deleted: ok,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        if (ok) {
          console.log(chalk.green(`\n  ✓ Goal ${goalId} deleted\n`));
        } else {
          console.log(chalk.yellow(`\n  ⚠ Server returned false for delete of ${goalId}\n`));
        }
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to delete goal: ${message}`);
      }
    });

  // ---------- ASSIGN TRAVELLERS ----------
  plans
    .command("goal-assign-travellers <goalId>")
    .description("Assign travellers to an existing goal (replaces current assignment)")
    .requiredOption("--travellers <ids>", "Comma-separated traveller ids")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (goalId: string, opts) => {
      try {
        const travellerIds = parseTravellerIds(opts.travellers);
        const data = await graphql<{ assignTravellersToGoal: boolean }>(
          ASSIGN_TRAVELLERS_TO_GOAL,
          { goalId, travellerIds },
        );
        const ok = data.assignTravellersToGoal === true;

        if (!ok) {
          if (opts.json) {
            jsonOutput({
              ok: false,
              data: {
                goalId,
                assignedTravellerIds: null,
                idempotencyKey: opts.idempotencyKey ?? null,
              },
            });
            return;
          }
          console.log(chalk.yellow(`\n  ⚠ Server returned false for assignTravellersToGoal\n`));
          return;
        }

        // Mutation succeeded — re-fetch to get the server-verified assignment.
        let assignedTravellerIds: string[] | null = travellerIds;
        let goalName: string | null = null;
        let verificationWarning: string | null = null;
        try {
          const refetch = await graphql<{ tripPlanGoal: TripPlanGoalDeep | null }>(
            GET_TRIP_PLAN_GOAL,
            { id: goalId },
          );
          if (refetch.tripPlanGoal) {
            assignedTravellerIds = (refetch.tripPlanGoal.travellers ?? []).map(t => t.id);
            goalName = refetch.tripPlanGoal.name ?? null;
          } else {
            assignedTravellerIds = null;
            verificationWarning = "Could not verify assignment: goal not found in re-fetch (may have been deleted)";
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          verificationWarning = `Assignment succeeded but re-fetch failed: ${message}`;
        }

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              goalId,
              assignedTravellerIds,
              ...(verificationWarning ? { warning: verificationWarning } : {}),
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        const label = goalName ? `goal: ${goalName}` : `goal ${goalId}`;
        const assignedCount = assignedTravellerIds !== null ? assignedTravellerIds.length : "?";
        console.log(chalk.green(`\n  ✓ Assigned ${assignedCount} traveller(s) to ${label}\n`));
        if (verificationWarning) console.log(chalk.yellow(`  ⚠ ${verificationWarning}`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to assign travellers: ${message}`);
      }
    });

  // ---------- ADD ITEM (bare) ----------
  plans
    .command("goal-add-item <goalId>")
    .description("Attach an existing item to a goal")
    .requiredOption("--item <itemId>", "Item id")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (goalId: string, opts) => {
      try {
        const data = await graphql<{ addItemToGoal: boolean }>(
          ADD_ITEM_TO_GOAL,
          { goalId, itemId: opts.item },
        );
        const ok = data.addItemToGoal === true;
        if (opts.json) {
          jsonOutput({
            ok,
            data: {
              goalId,
              itemId: opts.item,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }
        if (ok) {
          console.log(chalk.green(`\n  ✓ Item ${opts.item} attached to goal ${goalId}\n`));
        } else {
          console.log(chalk.yellow(`\n  ⚠ Server returned false for addItemToGoal\n`));
        }
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to add item to goal: ${message}`);
      }
    });

  // ---------- ADD ITEM WITH SELECTION ----------
  plans
    .command("goal-add-item-with-selection <goalId>")
    .description("Create a new item + selection on this goal")
    .requiredOption("--plan <planId>", "Trip plan id")
    .requiredOption("--type <selectionType>", "Selection type")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (goalId: string, opts) => {
      try {
        const type = normalizeSelectionType(opts.type);
        const data = await graphql<{
          addItemWithSelectionToGoal: { item: { id: string; goalId?: string }; selection: { id: string; type: string; isLocked?: boolean } };
        }>(ADD_ITEM_WITH_SELECTION_TO_GOAL, { goalId, tripPlanId: opts.plan, type });
        const result = data.addItemWithSelectionToGoal;

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              goalId,
              item: result.item,
              selection: result.selection,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        console.log(chalk.green(`\n  ✓ Item + selection created on goal ${goalId}`));
        console.log(`      ${chalk.dim("item:")} ${result.item.id}`);
        console.log(`      ${chalk.dim("selection:")} ${result.selection.id} (${result.selection.type})\n`);
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to add item with selection: ${message}`);
      }
    });

  // ---------- REORDER (synthesized, non-atomic) ----------
  plans
    .command("goal-reorder <planId>")
    .description("Reorder goals on a plan (NON-ATOMIC: synthesizes parallel updateTripPlanGoal calls)")
    .requiredOption("--order <ids>", "Comma-separated goal ids in desired order (must be every goal exactly once)")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      try {
        // Order must preserve duplicates so we can detect them in computeReorderUpdates.
        const orderIds = parseCsvIds(opts.order, "--order", { dedupe: false });
        const goalsResp = await graphql<{ tripPlanGoals: TripPlanGoalSummary[] }>(
          LIST_TRIP_PLAN_GOALS,
          { tripPlanId: planId },
        );
        const goals = goalsResp.tripPlanGoals ?? [];
        const updates = computeReorderUpdates(goals, orderIds);

        const succeededGoalIds: string[] = [];
        const failedGoalIds: string[] = [];
        const errors: Array<{ goalId: string; message: string }> = [];

        // Run updates in parallel; capture successes and failures.
        await Promise.all(
          updates.map(async u => {
            try {
              await graphql(UPDATE_TRIP_PLAN_GOAL, {
                id: u.id,
                input: { sortOrder: u.sortOrder },
              });
              succeededGoalIds.push(u.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              failedGoalIds.push(u.id);
              errors.push({ goalId: u.id, message });
            }
          }),
        );

        const newOrder = orderIds.map((id, i) => ({ id, sortOrder: i + 1 }));
        const allOk = failedGoalIds.length === 0;

        if (opts.json) {
          jsonOutput({
            ok: allOk,
            data: {
              planId,
              succeededGoalIds,
              failedGoalIds,
              errors,
              newOrder,
              atomic: false,
              warning: "goal-reorder is not atomic; failed updates leave partial reordering",
              noopCount: orderIds.length - updates.length,
              idempotencyKey: opts.idempotencyKey ?? null,
            },
          });
          return;
        }

        if (allOk) {
          console.log(chalk.green(`\n  ✓ Reordered ${updates.length} goal(s) (${orderIds.length - updates.length} no-op)`));
          console.log(chalk.dim("  Note: goal-reorder is not atomic on the server."));
        } else {
          console.log(chalk.yellow(`\n  ⚠ Partial reorder: ${succeededGoalIds.length} succeeded, ${failedGoalIds.length} failed`));
          for (const e of errors) {
            console.log(chalk.red(`    × ${e.goalId}: ${e.message}`));
          }
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to reorder goals: ${message}`);
      }
    });
}
