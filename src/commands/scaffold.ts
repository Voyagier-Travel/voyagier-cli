import chalk from "chalk";
import { graphql } from "../api.js";
import {
  CREATE_TRIP_PLAN,
  CREATE_TRAVELLER_BRIEF,
  LIST_TRIP_PLAN_GOALS,
  DELETE_TRIP_PLAN_GOAL,
  CREATE_TRIP_PLAN_GOAL,
} from "../queries.js";
import { shellArg } from "../utils.js";
import { progress, warn } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { resolveClient } from "./clients.js";

/** Minimal goal shape needed for shape-flag pruning. */
export interface PrunableGoal {
  id: string;
  name?: string | null;
  type: string;
}

export interface ShapeFlags {
  oneWay: boolean;
  flightOnly: boolean;
  hotelOnly: boolean;
}

/**
 * Given the default scaffold goal graph and the requested trip shape, compute
 * which goals to prune. Pure function for testability.
 *
 * Rules:
 *  - --one-way    → the return-leg Flight goal (type Flight, name matching
 *                   /return/i). The scaffold names it "Return Flights".
 *  - --flight-only   → every Hotel-type goal (scaffold: "Secure Lodging").
 *  - --hotel-only → every Flight-type AND FlightJourney-type goal
 *                   (scaffold: "Outbound Flights", "Return Flights",
 *                   "Flight Booking Details") — plus nothing else.
 *
 * Returns the goals to delete and any warnings (e.g. a shape flag that
 * matched nothing — server scaffold may have changed; agent should inspect
 * `plans goals` and prune manually with `plans goal-remove`).
 */
export function selectGoalsToPrune(
  goals: PrunableGoal[],
  shape: ShapeFlags,
): { prune: PrunableGoal[]; warnings: string[] } {
  const prune = new Map<string, PrunableGoal>();
  const warnings: string[] = [];

  if (shape.oneWay) {
    const returnGoals = goals.filter(
      g => g.type === "Flight" && /return/i.test(g.name ?? ""),
    );
    if (returnGoals.length === 0) {
      warnings.push(
        "--one-way: no return-flight goal found to prune (scaffold may have changed). Inspect `plans goals <planId>` and remove it with `plans goal-remove <goalId> --force`.",
      );
    }
    for (const g of returnGoals) prune.set(g.id, g);
  }

  if (shape.flightOnly) {
    const hotelGoals = goals.filter(g => g.type === "Hotel");
    if (hotelGoals.length === 0) {
      warnings.push(
        "--flight-only: no Hotel goal found to prune (scaffold may have changed). Inspect `plans goals <planId>`.",
      );
    }
    for (const g of hotelGoals) prune.set(g.id, g);
  }

  if (shape.hotelOnly) {
    const flightish = goals.filter(g => g.type === "Flight" || g.type === "FlightJourney");
    if (flightish.length === 0) {
      warnings.push(
        "--hotel-only: no Flight/FlightJourney goals found to prune (scaffold may have changed). Inspect `plans goals <planId>`.",
      );
    }
    for (const g of flightish) prune.set(g.id, g);
  }

  return { prune: [...prune.values()], warnings };
}

/**
 * The desired goal graph a trip shape should converge to, expressed as how many
 * Flight and Hotel goals the plan must END UP with. This is the additive twin of
 * {@link selectGoalsToPrune}: prune declares what to REMOVE from the server
 * template; this declares the TARGET, so the ensure step can also ADD goals a
 * blank plan is missing (VOY-1513: new plans will default to NO goals). Pure for
 * testability.
 *
 * Same rules, viewed from the target side:
 *  - Flights: an outbound Flight goal unless --hotel-only; a return Flight goal
 *    unless --one-way (or --hotel-only).
 *  - Hotel: one Hotel goal unless --flight-only.
 */
export function desiredGoalShape(shape: ShapeFlags): { flights: number; hotels: number } {
  const wantOutbound = !shape.hotelOnly;
  const wantReturn = !shape.hotelOnly && !shape.oneWay;
  const wantHotel = !shape.flightOnly;
  return { flights: (wantOutbound ? 1 : 0) + (wantReturn ? 1 : 0), hotels: wantHotel ? 1 : 0 };
}

// Template-parity names for goals the ensure step adds on a blank plan, so a
// later prune (which matches the return leg by /return/i) still behaves and the
// graph reads the same as the server template.
const ADDED_FLIGHT_NAMES = ["Outbound Flights", "Return Flights"];
const ADDED_HOTEL_NAME = "Accommodation";

/**
 * Create a single bare goal via the shared `createTripPlanGoal` mutation (the
 * one behind `plans goal-add`). Reused by the ensure step so blank plans get the
 * Flight/Hotel goal their trip shape needs — without duplicating the mutation.
 */
async function createGoal(
  tripPlanId: string,
  type: string,
  name: string,
  dryRun?: boolean,
): Promise<{ id: string; name?: string; type: string }> {
  const data = await graphql<{ createTripPlanGoal: { id: string; name?: string | null; type?: string | null } }>(
    CREATE_TRIP_PLAN_GOAL,
    { input: { tripPlanId, name, type } },
    { dryRun },
  );
  const g = data.createTripPlanGoal;
  return { id: g.id, name: g.name ?? name, type: g.type ?? type };
}

/**
 * Validate shape-flag combinations against the other plan-trip options.
 * Throws VALIDATION on conflicts. Pure for testability.
 */
export function validateShapeFlags(opts: {
  oneWay?: boolean;
  flightOnly?: boolean;
  hotelOnly?: boolean;
  plan?: string;
  return?: string;
  hotel?: string;
  checkin?: string;
  checkout?: string;
  to?: string;
  from?: string;
  depart?: string;
}): void {
  const anyShape = !!(opts.oneWay || opts.flightOnly || opts.hotelOnly);
  if (!anyShape) return;
  if (opts.plan) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "Shape flags (--one-way/--flight-only/--hotel-only) only apply when scaffolding a NEW plan. For an existing plan, prune goals directly: `voyagier plans goals <planId>` then `voyagier plans goal-remove <goalId> --force`.",
    );
  }
  if (opts.oneWay && opts.return) {
    throw new CliError(CliErrorCode.VALIDATION, "--one-way conflicts with --return. Drop one.");
  }
  if (opts.hotelOnly && opts.flightOnly) {
    throw new CliError(CliErrorCode.VALIDATION, "--hotel-only conflicts with --flight-only. Pick one.");
  }
  if (opts.hotelOnly && opts.oneWay) {
    throw new CliError(CliErrorCode.VALIDATION, "--hotel-only conflicts with --one-way (a hotel-only plan has no flights).");
  }
  if (opts.hotelOnly && (opts.to || opts.from || opts.depart || opts.return)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "--hotel-only conflicts with flight flags (--from/--to/--depart/--return). A hotel-only plan has no flights.",
    );
  }
  if (opts.flightOnly && (opts.hotel || opts.checkin || opts.checkout)) {
    throw new CliError(CliErrorCode.VALIDATION, "--flight-only conflicts with hotel flags (--hotel/--checkin/--checkout). Drop one.");
  }
}

/**
 * Parse a comma-separated traveller-name list into { firstName, lastName }
 * pairs. A single-token name uses that token for both fields (matching the
 * historical plan-trip behavior).
 */
export function parseTravellers(names: string): Array<{ firstName: string; lastName: string }> {
  return names.split(",")
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => {
      const parts = name.split(/\s+/);
      if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
      return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
    });
}

/**
 * Add a comma-separated list of traveller names to a plan and return their
 * new ids. Shared by scaffoldPlan (the create path) and plan-trip's existing
 * `--plan` path so both add travellers identically. Emits an "Adding
 * travellers..." progress line unless `quiet` or `progress:false`.
 */
export async function addTravellers(
  tripPlanId: string,
  names: string,
  opts?: { quiet?: boolean; progress?: boolean },
): Promise<string[]> {
  const parsed = parseTravellers(names);
  if (parsed.length === 0) return [];
  if (!opts?.quiet && opts?.progress !== false) progress("Adding travellers...");
  const ids: string[] = [];
  for (const t of parsed) {
    const tData = await graphql<{ createTripPlanTraveller: { id: string } }>(
      CREATE_TRAVELLER_BRIEF,
      { tripPlanId, input: { firstName: t.firstName, lastName: t.lastName, declaredTravellerType: "Adult" } },
    );
    ids.push(tData.createTripPlanTraveller.id);
  }
  return ids;
}

export interface ScaffoldOptions {
  /** Client id | name | email (resolveClient semantics). */
  client?: string;
  title: string;
  /** Comma-separated traveller names (parseTravellers format). */
  travellers?: string;
  shape?: { oneWay?: boolean; flightOnly?: boolean; hotelOnly?: boolean };
  /**
   * Run the ensure-goals convergence (prune extras + add what a blank plan is
   * missing) so the created plan matches the trip shape in BOTH the template
   * world (server attaches a round-trip + hotel graph today) and the post-1513
   * blank world (new plans default to no goals). `plan-trip` and `search`'s
   * auto-draft set this; `plans create` leaves it off to stay a bare create.
   * A truthy shape flag also implies convergence, for back-compat.
   */
  ensureGoals?: boolean;
  /** Suppress progress output + the auto-resolved-client note (for --json callers). */
  quiet?: boolean;
  /**
   * Set false to suppress progress lines only, keeping the auto-resolved-client
   * note (unless quiet). `plans create` uses this: its pre-VOY-1763 contract
   * always wrote the note to stderr (even under --json) but never progress.
   */
  progress?: boolean;
  /** Print the createTripPlan mutation instead of executing (mirrors --dry-run). */
  dryRun?: boolean;
  /**
   * When true, resolveClient shows an interactive picker on MULTIPLE_CLIENTS
   * instead of throwing (VOY-1762). Callers pass the result of isInteractive()
   * here — never a global guess.
   */
  interactive?: boolean;
  /**
   * Flags the caller already typed, carried forward into the MULTIPLE_CLIENTS
   * retry hint (e.g. `--title 'Paris'`). Surfaces only in the non-interactive
   * error text.
   */
  clientHintFlags?: string;
}

/** Three-letter month abbreviations for generated titles. */
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a `YYYY-MM-DD` string (or, absent/unparseable, `now`) as `Mon YYYY`
 * — e.g. "Aug 2026". `now` is injectable purely so the fallback is testable.
 */
function formatMonthYear(dateStr: string | undefined, now: Date): string {
  let d: Date | null = null;
  const m = dateStr ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim()) : null;
  if (m) {
    const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const parsed = new Date(y, mo - 1, day);
    // Reject calendar overflow (e.g. 2026-02-31 silently becomes Mar 2026):
    // only accept dates that round-trip to the same Y/M/D.
    if (parsed.getFullYear() === y && parsed.getMonth() === mo - 1 && parsed.getDate() === day) d = parsed;
  }
  if (!d) d = now;
  return `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Generate a sensible default trip title for the interactive `--title` prompt
 * (VOY-1762): `<destination> · <Mon YYYY>` when a destination/date is derivable
 * from the args the caller already typed, else `Trip · <Mon YYYY>`.
 *
 * `now` is injectable for deterministic tests; production passes the real clock.
 */
export function generateTripTitle(
  args: { to?: string; hotel?: string; depart?: string; checkin?: string },
  now: Date = new Date(),
): string {
  const destination = (args.to || args.hotel)?.trim();
  const monYear = formatMonthYear(args.depart || args.checkin, now);
  return `${destination || "Trip"} · ${monYear}`;
}

export interface ScaffoldResult {
  plan: { id: string; title: string; startDate?: string; endDate?: string; description?: string | null };
  client: { id: string; name: string; autoResolved: boolean; isSelf?: boolean };
  /** IDs of travellers ADDED during scaffold (empty when none were requested). */
  travellerIds: string[];
  /** Goals removed to match the trip shape (server template → requested shape). */
  prunedGoals: { id: string; name?: string; type: string }[];
  /** Goals ADDED to reach the trip shape (non-empty only on a blank plan; VOY-1513). */
  addedGoals: { id: string; name?: string; type: string }[];
  pruneWarnings: string[];
}

/**
 * Create a trip plan and shape it to the caller's brief. This is the single
 * create path shared by `plan-trip` (the canonical creation verb) and the
 * `plans create` alias — and will back `search`'s auto-draft (VOY-1761).
 *
 * Steps: resolve client → createTripPlan → add any requested travellers →
 * ensure the goal graph matches the trip shape (when `ensureGoals` or a shape
 * flag is set): prune extras the server template added, then ADD any goal a
 * blank plan is missing so the shape converges identically in both the template
 * world (today) and the post-1513 blank world.
 *
 * The auto-resolved-client note and progress messages go to stderr and are
 * suppressed when `quiet` is set. Prune warnings are always surfaced via
 * `warn()` and also returned in `pruneWarnings` for JSON consumers.
 */
export async function scaffoldPlan(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const chatty = !opts.quiet;

  // Step 1: Resolve the client.
  const resolved = await resolveClient(opts.client, {
    interactive: opts.interactive,
    carryFlags: opts.clientHintFlags,
  });
  if (resolved.autoResolved && chatty) {
    const note = resolved.isSelf
      ? `auto-resolved client: you (${resolved.name}, self)\n`
      : `auto-resolved client: ${resolved.name} (${resolved.id})\n`;
    process.stderr.write(chalk.dim(note));
  }

  // Step 2: Create the plan (server attaches the default goal graph).
  if (chatty && opts.progress !== false) progress("Creating trip plan...");
  const planInput: Record<string, unknown> = { clientId: resolved.id, title: opts.title };
  const planData = await graphql<{ createTripPlan: ScaffoldResult["plan"] }>(
    CREATE_TRIP_PLAN,
    { input: planInput },
    { dryRun: opts.dryRun },
  );
  const plan = planData.createTripPlan;

  // Step 3: Add any requested travellers.
  const travellerIds = opts.travellers
    ? await addTravellers(plan.id, opts.travellers, { quiet: opts.quiet, progress: opts.progress })
    : [];

  // Step 4: Converge the goal graph to the trip shape (VOY-1727 + VOY-1761).
  // Un-shaped goals are not inert: an unpruned Return Flights goal blocks one-way
  // inventory fetch AND fare carting; unpruned hotel/flight goals pin
  // `plan-status` readiness at BLOCKED forever. Conversely a BLANK plan (VOY-1513:
  // goals become opt-in) has NO flight goal, so a flight search — or plan-trip's
  // own "next step: search" hint — would fail with "No Flight goal on this plan".
  // So this both PRUNES the template's extras AND ADDS what a blank plan lacks;
  // the resulting shape is identical whether the server templated goals or not.
  const prunedGoals: ScaffoldResult["prunedGoals"] = [];
  const addedGoals: ScaffoldResult["addedGoals"] = [];
  const pruneWarnings: string[] = [];
  const shape: ShapeFlags = {
    oneWay: !!opts.shape?.oneWay,
    flightOnly: !!opts.shape?.flightOnly,
    hotelOnly: !!opts.shape?.hotelOnly,
  };
  const converge = opts.ensureGoals === true || shape.oneWay || shape.flightOnly || shape.hotelOnly;
  if (converge) {
    if (chatty && opts.progress !== false) progress("Ensuring goals match trip shape...");
    const goalsData = await graphql<{ tripPlanGoals: PrunableGoal[] }>(
      LIST_TRIP_PLAN_GOALS,
      { tripPlanId: plan.id },
    );
    const goals = goalsData.tripPlanGoals ?? [];

    // 4a. Prune extras the template added that this shape doesn't want.
    const { prune, warnings } = selectGoalsToPrune(goals, shape);
    pruneWarnings.push(...warnings);
    const prunedIds = new Set<string>();
    for (const g of prune) {
      try {
        const del = await graphql<{ deleteTripPlanGoal: boolean }>(
          DELETE_TRIP_PLAN_GOAL,
          { id: g.id },
        );
        if (del.deleteTripPlanGoal === true) {
          prunedGoals.push({ id: g.id, name: g.name ?? undefined, type: g.type });
          prunedIds.add(g.id);
        } else {
          pruneWarnings.push(`Server declined to delete goal "${g.name ?? g.id}" (${g.type}). Remove it manually: voyagier plans goal-remove ${shellArg(g.id)} --force`);
        }
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
        pruneWarnings.push(`Failed to delete goal "${g.name ?? g.id}" (${g.type}): ${message}. Remove it manually: voyagier plans goal-remove ${shellArg(g.id)} --force`);
      }
    }

    // 4b. Add what's still missing to reach the desired shape. On the template
    // world nothing is missing (counts already meet the target), so this is a
    // no-op; on a blank plan it creates the outbound/return Flight and/or Hotel
    // goal the search will target.
    const remaining = goals.filter(g => !prunedIds.has(g.id));
    const desired = desiredGoalShape(shape);
    let flightCount = remaining.filter(g => g.type === "Flight").length;
    let hotelCount = remaining.filter(g => g.type === "Hotel").length;
    for (; flightCount < desired.flights; flightCount++) {
      const name = ADDED_FLIGHT_NAMES[flightCount] ?? `Flight goal ${flightCount + 1}`;
      try {
        addedGoals.push(await createGoal(plan.id, "Flight", name, opts.dryRun));
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
        pruneWarnings.push(`Failed to add a Flight goal to match the trip shape: ${message}. Add it manually: voyagier plans goal-add ${shellArg(plan.id)} --type Flight`);
      }
    }
    for (; hotelCount < desired.hotels; hotelCount++) {
      try {
        addedGoals.push(await createGoal(plan.id, "Hotel", ADDED_HOTEL_NAME, opts.dryRun));
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
        pruneWarnings.push(`Failed to add a Hotel goal to match the trip shape: ${message}. Add it manually: voyagier plans goal-add ${shellArg(plan.id)} --type Hotel`);
      }
    }

    for (const w of pruneWarnings) warn(w);
  }

  return {
    plan,
    client: { id: resolved.id, name: resolved.name, autoResolved: resolved.autoResolved, isSelf: resolved.isSelf },
    travellerIds,
    prunedGoals,
    addedGoals,
    pruneWarnings,
  };
}
