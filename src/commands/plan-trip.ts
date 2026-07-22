import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import {
  GET_TRIP_PLAN_BASIC,
  CREATE_TRIP_PLAN_BASIC,
  CREATE_TRAVELLER_BRIEF,
  GET_TRAVELLERS_BRIEF,
  LIST_TRIP_PLAN_GOALS,
  DELETE_TRIP_PLAN_GOAL,
} from "../queries.js";
import { validateDate, warnPastDate, validateIata, deriveBaseUrl, shellArg } from "../utils.js";
import { progress, warn, fatal, jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { resolveClient } from "./clients.js";

interface TripPlan {
  id: string;
  title: string;
  startDate?: string;
  endDate?: string;
}

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
}

export function parseDurationMinutes(duration?: string): number {
  if (!duration) return Infinity;
  const match = duration.match(/(\d+)h\s*(\d+)?m?/);
  if (match) return parseInt(match[1], 10) * 60 + (parseInt(match[2] ?? "0", 10));
  const minOnly = duration.match(/(\d+)\s*m/);
  if (minOnly) return parseInt(minOnly[1], 10);
  return Infinity;
}

/**
 * Given a YYYY-MM-DD date string, return the next calendar day in the same
 * format (UTC-safe). Returns undefined for anything that isn't a clean date,
 * so callers can fall back to a placeholder.
 */
export function nextDay(date?: string): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function parseStops(bookingData?: Record<string, unknown>): number {
  if (!bookingData) return Infinity;
  if (typeof bookingData.stops === "number") return bookingData.stops;
  const segments = bookingData.segments as unknown[] | undefined;
  if (segments) return Math.max(0, segments.length - 1);
  return Infinity;
}

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

function parseTravellers(names: string): Array<{ firstName: string; lastName: string }> {
  return names.split(",")
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => {
      const parts = name.split(/\s+/);
      if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
      return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
    });
}

export function registerPlanTripCommand(program: Command): void {
  program
    .command("plan-trip")
    .description("Scaffold a trip plan (plan + travellers + goal graph), then compose it with search / selection-options / select. Use --plan <id> to add to an existing plan.")
    .addHelpText("after", `
Examples:
  # Scaffold a round-trip flight + hotel plan; prints the compose next-steps:
  voyagier plan-trip --client "Smith Family" --title "Paris Trip" \\
    --from DCA --to Paris --depart <YYYY-MM-DD> --return <YYYY-MM-DD> \\
    --hotel Paris --travellers "John Doe" --json

  # One-way, no hotel: pass --one-way --flight-only so the scaffold's default
  # Return Flights + hotel goals are pruned (otherwise they block readiness
  # and the fare never carts). Omitting --return alone does NOT make the
  # plan one-way — the default goal graph still expects a return leg.
  voyagier plan-trip --title "London" --from JFK --to London \\
    --depart <YYYY-MM-DD> --one-way --flight-only --travellers "Jane Smith" --json

  # Hotel-only (no flights at all):
  voyagier plan-trip --title "Nashville Stay" --hotel Nashville \\
    --checkin <YYYY-MM-DD> --checkout <YYYY-MM-DD> --hotel-only --json

  The default goal graph is a round-trip + hotel TEMPLATE. Prune goals your
  brief doesn't need — via these shape flags at scaffold time, or any time
  with: voyagier plans goals <planId>  →  voyagier plans goal-remove <goalId> --force

  Then follow the printed next-steps: search → selection-options --wait → select.
  Full agent reference: voyagier agent-docs
`)
    .option("--plan <id>", "Add to an existing trip plan instead of creating a new one")
    .option("--client <ref>", "Client ID, email, or name (required when creating a plan; auto-picked if you have exactly one active client)")
    .option("--title <title>", "Trip plan title (required when --plan is not used)")
    .option("--from <code>", "Origin airport code (defaults to home airport)")
    .option("--to <code>", "Destination airport code")
    .option("--depart <date>", "Departure date (YYYY-MM-DD)")
    .option("--return <date>", "Return date (YYYY-MM-DD, makes round-trip)")
    .option("--hotel <location>", "Hotel location (triggers hotel search)")
    .option("--checkin <date>", "Hotel check-in date (defaults to --depart)")
    .option("--checkout <date>", "Hotel check-out date (defaults to --return or --depart + 1 day)")
    .option("--guests <n>", "Number of guests (defaults to traveller count)")
    .option("--travellers <names>", "Comma-separated traveller names, e.g. \"John Doe, Jane Doe\"")
    .option("--one-way", "One-way trip: prune the scaffold's default Return Flights goal (conflicts with --return)")
    .option("--flight-only", "No lodging: prune the scaffold's default hotel goal (conflicts with --hotel)")
    .option("--hotel-only", "Lodging only: prune ALL flight goals from the scaffold (conflicts with flight flags)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (opts) => {
      const json = !!opts.json;
      const agent = !!opts.agent;

      try {
        // Validate --plan / --title
        if (!opts.plan && !opts.title) {
          fatal("--title is required when --plan is not provided.");
        }

        // Validate trip-shape flag combinations early (cheap, no API calls).
        validateShapeFlags(opts);

        // Validate inputs
        if (opts.depart) {
          validateDate(opts.depart, "--depart");
          warnPastDate(opts.depart, "--depart");
        }
        if (opts.return) {
          validateDate(opts.return, "--return");
          warnPastDate(opts.return, "--return");
        }
        if (opts.checkin) {
          validateDate(opts.checkin, "--checkin");
        }
        if (opts.checkout) {
          validateDate(opts.checkout, "--checkout");
        }
        // Validate airport inputs (allow city names — resolution happens later)
        if (opts.to && /^[A-Za-z]{3}$/.test(opts.to.trim())) {
          validateIata(opts.to, "--to");
        }
        if (opts.from && /^[A-Za-z]{3}$/.test(opts.from.trim())) {
          validateIata(opts.from, "--from");
        }

        // Step 1: Create or fetch plan
        let plan: TripPlan;
        if (opts.plan) {
          if (!json && !agent) progress("Fetching existing trip plan...");
          const planData = await graphql<{ tripPlan: TripPlan }>(
            GET_TRIP_PLAN_BASIC,
            { id: opts.plan }
          );
          plan = planData.tripPlan;
        } else {
          const resolved = await resolveClient(opts.client);
          if (resolved.autoResolved) {
            process.stderr.write(`auto-resolved client: ${resolved.name} (${resolved.id})\n`);
          }
          if (!json && !agent) progress("Creating trip plan...");
          const planInput: Record<string, unknown> = { clientId: resolved.id, title: opts.title };

          const planData = await graphql<{ createTripPlan: TripPlan }>(
            CREATE_TRIP_PLAN_BASIC,
            { input: planInput }
          );
          plan = planData.createTripPlan;
        }

        // Step 2: Add travellers
        const travellers: Traveller[] = [];
        if (opts.travellers) {
          if (!json && !agent) progress("Adding travellers...");
          const parsed = parseTravellers(opts.travellers);
          for (const t of parsed) {
            const tData = await graphql<{ createTripPlanTraveller: Traveller }>(
              CREATE_TRAVELLER_BRIEF,
              { tripPlanId: plan.id, input: { firstName: t.firstName, lastName: t.lastName, declaredTravellerType: "Adult" } }
            );
            travellers.push(tData.createTripPlanTraveller);
          }
        }

        // Resolve traveller IDs (from newly added or existing)
        let travellerIds = travellers.map(t => t.id);
        if (travellerIds.length === 0) {
          // Fetch existing travellers (always needed for existing plans; also for new plans with no --travellers)
          const tData = await graphql<{ tripPlanTravellers: Traveller[] }>(
            GET_TRAVELLERS_BRIEF,
            { tripPlanId: plan.id }
          );
          travellerIds = tData.tripPlanTravellers.map(t => t.id);
        }

        if (travellerIds.length === 0 && (opts.to || opts.hotel)) {
          warn("No travellers on plan — searches may fail without traveller IDs.");
        }

        // ── Trip-shape pruning (VOY-1727) ───────────────────────────────
        // The scaffold's default goal graph is a round-trip + hotel TEMPLATE.
        // Un-pruned goals the brief doesn't need are not inert: an unpruned
        // Return Flights goal blocks one-way inventory fetch AND fare carting;
        // unpruned hotel/flight goals pin `plan-status` readiness at BLOCKED
        // forever. Shape flags prune at scaffold time so partial-scope plans
        // can genuinely reach READY_TO_BOOK.
        const prunedGoals: PrunableGoal[] = [];
        const pruneWarnings: string[] = [];
        const shape: ShapeFlags = {
          oneWay: !!opts.oneWay,
          flightOnly: !!opts.flightOnly,
          hotelOnly: !!opts.hotelOnly,
        };
        if (shape.oneWay || shape.flightOnly || shape.hotelOnly) {
          if (!json && !agent) progress("Pruning goals to match trip shape...");
          const goalsData = await graphql<{ tripPlanGoals: PrunableGoal[] }>(
            LIST_TRIP_PLAN_GOALS,
            { tripPlanId: plan.id },
          );
          const { prune, warnings } = selectGoalsToPrune(goalsData.tripPlanGoals ?? [], shape);
          pruneWarnings.push(...warnings);
          for (const g of prune) {
            try {
              const del = await graphql<{ deleteTripPlanGoal: boolean }>(
                DELETE_TRIP_PLAN_GOAL,
                { id: g.id },
              );
              if (del.deleteTripPlanGoal === true) {
                prunedGoals.push(g);
              } else {
                pruneWarnings.push(`Server declined to delete goal "${g.name ?? g.id}" (${g.type}). Remove it manually: voyagier plans goal-remove ${g.id} --force`);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              pruneWarnings.push(`Failed to delete goal "${g.name ?? g.id}" (${g.type}): ${message}. Remove it manually: voyagier plans goal-remove ${g.id} --force`);
            }
          }
          for (const w of pruneWarnings) warn(w);
        }

        // ── Demoted to scaffold (VOY-1414) ──────────────────────────────
        // plan-trip no longer auto-searches/auto-selects through the deleted
        // flight/sub-selection mutations. In the Goals/Blueprint model the
        // plan is created with a default goal graph; the agent then composes
        // the trip with the shape-agnostic primitives. plan-trip just gives a
        // starting point and hands off — it is NOT the only door and must not
        // push agents down a fixed shape.
        const baseUrl2 = deriveBaseUrl(getApiUrl());
        const planUrl = `${baseUrl2}/plans/${plan.id}`;

        const nextSteps: string[] = [];
        if (opts.to && opts.depart) {
          const fromPart = opts.from ? `--from ${shellArg(opts.from)} ` : "";
          nextSteps.push(
            `voyagier search flights --plan ${shellArg(plan.id)} ${fromPart}--to ${shellArg(opts.to)} --date ${shellArg(opts.depart)}${opts.return ? ` --return ${shellArg(opts.return)}` : ""} --json`,
          );
        }
        if (opts.hotel) {
          // `search hotels` requires BOTH dates, so the suggested command must
          // always carry runnable --checkin/--checkout. Derive checkout from
          // checkin + 1 day when it's missing; fall back to a clear placeholder
          // when there's no date context at all.
          const checkin = opts.checkin || opts.depart;
          const checkout = opts.checkout || opts.return || (checkin ? nextDay(checkin) : undefined);
          const ci = checkin || "<checkin YYYY-MM-DD>";
          const co = checkout || "<checkout YYYY-MM-DD>";
          nextSteps.push(
            `voyagier search hotels --plan ${shellArg(plan.id)} --location ${shellArg(opts.hotel)} --checkin ${shellArg(ci)} --checkout ${shellArg(co)} --json`,
          );
        }
        nextSteps.push(`voyagier plans goals ${shellArg(plan.id)} --json   # inspect the goal graph + readiness`);
        nextSteps.push(`voyagier selection-options <selectionId> --wait --json   # poll options for a selection`);
        nextSteps.push(`voyagier select --selection-id <id> --option-id <id>   # choose an option`);

        const shapeLabels = [
          shape.oneWay ? "one-way" : null,
          shape.flightOnly ? "flight-only" : null,
          shape.hotelOnly ? "hotel-only" : null,
        ].filter((s): s is string => s !== null);

        const result = {
          ok: true,
          tripPlanId: plan.id,
          title: plan.title,
          travellerIds,
          scaffolded: true,
          note: "plan-trip creates a starting plan + default goal graph (a round-trip + hotel TEMPLATE); compose the trip with the primitives below. Prune goals your brief doesn't need — shape flags (--one-way/--flight-only/--hotel-only) at scaffold time, or `plans goal-remove <goalId> --force` any time.",
          url: planUrl,
          ...(shapeLabels.length > 0
            ? {
                shape: shapeLabels,
                prunedGoals: prunedGoals.map(g => ({ id: g.id, name: g.name ?? null, type: g.type })),
                ...(pruneWarnings.length > 0 ? { pruneWarnings } : {}),
              }
            : {}),
          nextSteps,
        };

        if (json) {
          jsonOutput(result);
          return;
        }
        if (agent) {
          const lines = [
            `### Plan ready: ${plan.title}`,
            "",
            `Plan ID: \`${plan.id}\``,
            `👉 ${planUrl}`,
            ...(prunedGoals.length > 0
              ? ["", `**Shape:** ${shapeLabels.join(" + ")} — pruned ${prunedGoals.length} default goal(s): ${prunedGoals.map(g => g.name ?? g.id).join(", ")}`]
              : []),
            "",
            "**Compose the trip:**",
            ...nextSteps.map((s) => `- \`${s}\``),
          ];
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        console.log(chalk.green(`\n✓ Plan ready: ${plan.title}`));
        console.log(chalk.dim(`  ${plan.id}`));
        if (prunedGoals.length > 0) {
          console.log(chalk.dim(`  shape: ${shapeLabels.join(" + ")} — pruned ${prunedGoals.map(g => g.name ?? g.id).join(", ")}`));
        }
        console.log(chalk.bold("\nCompose the trip:"));
        for (const s of nextSteps) console.log(`  ${chalk.cyan(s)}`);
        console.log(chalk.dim(`\n  Plan: ${planUrl}`));
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `plan-trip failed: ${message}`);
      }
    });
}
