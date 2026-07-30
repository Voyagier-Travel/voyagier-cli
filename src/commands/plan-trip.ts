import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import {
  GET_TRIP_PLAN_BASIC,
  GET_TRAVELLERS_BRIEF,
} from "../queries.js";
import { validateDate, warnPastDate, validateIata, deriveBaseUrl, shellArg } from "../utils.js";
import { clientPlanUrl, planUrls } from "../plan-urls.js";
import { progress, warn, fatal, jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { scaffoldPlan, addTravellers, validateShapeFlags, selectGoalsToPrune, generateTripTitle } from "./scaffold.js";
import { isInteractive, promptText } from "../prompt.js";
import type { PrunableGoal, ShapeFlags } from "./scaffold.js";

// Re-exported so existing specs (which import them from ./plan-trip) keep
// working after these pruning/shape helpers moved to scaffold.ts.
export { validateShapeFlags, selectGoalsToPrune };
export type { PrunableGoal, ShapeFlags };

interface TripPlan {
  id: string;
  title: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Assemble the flags the user already typed into a copy-pasteable snippet, so
 * the MULTIPLE_CLIENTS retry hint carries them forward instead of dropping them
 * (VOY-1762). Values are shell-quoted; boolean shape flags are emitted bare.
 */
export function buildClientHintFlags(opts: {
  title?: string;
  from?: string;
  to?: string;
  depart?: string;
  return?: string;
  hotel?: string;
  travellers?: string;
  oneWay?: boolean;
  flightOnly?: boolean;
  hotelOnly?: boolean;
}): string {
  const parts: string[] = [];
  if (opts.title) parts.push(`--title ${shellArg(opts.title)}`);
  if (opts.from) parts.push(`--from ${shellArg(opts.from)}`);
  if (opts.to) parts.push(`--to ${shellArg(opts.to)}`);
  if (opts.depart) parts.push(`--depart ${shellArg(opts.depart)}`);
  if (opts.return) parts.push(`--return ${shellArg(opts.return)}`);
  if (opts.hotel) parts.push(`--hotel ${shellArg(opts.hotel)}`);
  if (opts.travellers) parts.push(`--travellers ${shellArg(opts.travellers)}`);
  if (opts.oneWay) parts.push("--one-way");
  if (opts.flightOnly) parts.push("--flight-only");
  if (opts.hotelOnly) parts.push("--hotel-only");
  return parts.join(" ");
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
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts) => {
      const json = !!opts.json;
      const agent = !!opts.agent;

      try {
        // Validate --plan / --title. When creating a new plan and no title was
        // given, ask for one at an interactive TTY with a generated default
        // (VOY-1762); non-interactively keep the exact hard failure.
        if (!opts.plan && !opts.title) {
          if (isInteractive(opts)) {
            opts.title = await promptText("Trip title: ", { default: generateTripTitle(opts) });
          }
          if (!opts.title) {
            fatal("--title is required when --plan is not provided.");
          }
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

        // ── Trip shape (VOY-1727) ───────────────────────────────────────
        // The scaffold's default goal graph is a round-trip + hotel TEMPLATE.
        // Un-pruned goals the brief doesn't need are not inert: an unpruned
        // Return Flights goal blocks one-way inventory fetch AND fare carting;
        // unpruned hotel/flight goals pin `plan-status` readiness at BLOCKED
        // forever. Shape flags prune at scaffold time so partial-scope plans
        // can genuinely reach READY_TO_BOOK.
        const shape: ShapeFlags = {
          oneWay: !!opts.oneWay,
          flightOnly: !!opts.flightOnly,
          hotelOnly: !!opts.hotelOnly,
        };

        // Step 1: Create (via the shared scaffold) or fetch an existing plan.
        let plan: TripPlan;
        let travellerIds: string[] = [];
        let prunedGoals: { id: string; name?: string; type: string }[] = [];
        let addedGoals: { id: string; name?: string; type: string }[] = [];
        let pruneWarnings: string[] = [];
        if (opts.plan) {
          if (!json && !agent) progress("Fetching existing trip plan...");
          const planData = await graphql<{ tripPlan: TripPlan }>(
            GET_TRIP_PLAN_BASIC,
            { id: opts.plan }
          );
          plan = planData.tripPlan;
          // Adding to an existing plan can still bring travellers along.
          if (opts.travellers) {
            travellerIds = await addTravellers(plan.id, opts.travellers, { quiet: json || agent });
          }
        } else {
          // The create path — client resolve → createTripPlan → add travellers
          // → shape pruning — lives in scaffoldPlan, shared with `plans create`
          // (and search's auto-draft, VOY-1761). Progress + the auto-resolved
          // note are suppressed for --json/--agent consumers via `quiet`.
          const scaffolded = await scaffoldPlan({
            client: opts.client,
            title: opts.title as string,
            travellers: opts.travellers,
            shape,
            // Always converge the goal graph: prunes the template's extras (as
            // before) AND — on a post-1513 blank plan — adds the flight/hotel
            // goal that plan-trip's own "next step: search" hint depends on.
            ensureGoals: true,
            quiet: json || agent,
            interactive: isInteractive(opts),
            clientHintFlags: buildClientHintFlags(opts),
          });
          plan = scaffolded.plan;
          travellerIds = scaffolded.travellerIds;
          prunedGoals = scaffolded.prunedGoals;
          addedGoals = scaffolded.addedGoals;
          pruneWarnings = scaffolded.pruneWarnings;
        }

        // Resolve traveller IDs for existing plans, and for new plans created
        // without --travellers (scaffold only returns the IDs it added).
        if (travellerIds.length === 0) {
          const tData = await graphql<{ tripPlanTravellers: Traveller[] }>(
            GET_TRAVELLERS_BRIEF,
            { tripPlanId: plan.id }
          );
          travellerIds = tData.tripPlanTravellers.map(t => t.id);
        }

        if (travellerIds.length === 0 && (opts.to || opts.hotel)) {
          warn("No travellers on plan — searches may fail without traveller IDs.");
        }

        // ── Demoted to scaffold (VOY-1414) ──────────────────────────────
        // plan-trip no longer auto-searches/auto-selects through the deleted
        // flight/sub-selection mutations. In the Goals/Blueprint model the
        // plan is created with a default goal graph; the agent then composes
        // the trip with the shape-agnostic primitives. plan-trip just gives a
        // starting point and hands off — it is NOT the only door and must not
        // push agents down a fixed shape.
        const baseUrl2 = deriveBaseUrl(getApiUrl());
        const planUrl = clientPlanUrl(plan.id, baseUrl2);

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
          ...planUrls(plan.id, baseUrl2),
          ...(shapeLabels.length > 0
            ? {
                shape: shapeLabels,
                prunedGoals: prunedGoals.map(g => ({ id: g.id, name: g.name ?? null, type: g.type })),
              }
            : {}),
          // Additive (absent in the template world, so back-compat holds): on a
          // blank plan (VOY-1513) the ensure step ADDS goals — never be silent
          // about that mutation, and surface any ensure warnings too.
          ...(addedGoals.length > 0
            ? { addedGoals: addedGoals.map(g => ({ id: g.id, name: g.name ?? null, type: g.type })) }
            : {}),
          ...(pruneWarnings.length > 0 ? { pruneWarnings } : {}),
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
