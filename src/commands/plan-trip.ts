import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import {
  GET_TRIP_PLAN_BASIC,
  CREATE_TRIP_PLAN_BASIC,
  CREATE_TRAVELLER_BRIEF,
  GET_TRAVELLERS_BRIEF,
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

interface SelectOption {
  id: string;
  name: string;
  price?: number;
  time?: string;
  airline?: string;
  duration?: string;
  bookingData?: Record<string, unknown>;
  sortOrder: number;
}

interface SelectionResult {
  item: { id: string; title: string; tripPlanId: string };
  selection: { id: string };
  options: SelectOption[];
}

interface RawFlightOption {
  id: string;
  name: string;
  price?: number;
  time?: string;
  airline?: string;
  duration?: string;
  bookingData?: Record<string, unknown>;
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
    .description("Create or extend a trip plan (flights + hotels). Use --plan <id> to add legs. Activities: voyagier search activities")
    .addHelpText("after", `
Examples:
  # Scaffold a round-trip flight + hotel plan; prints the compose next-steps:
  voyagier plan-trip --client "Smith Family" --title "Paris Trip" \\
    --from DCA --to Paris --depart <YYYY-MM-DD> --return <YYYY-MM-DD> \\
    --hotel Paris --travellers "John Doe" --json

  # One-way (omit --client to auto-pick if you have exactly one active client):
  voyagier plan-trip --title "London" --from JFK --to London \\
    --depart <YYYY-MM-DD> --travellers "Jane Smith" --json

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
            `voyagier search flights --plan ${plan.id} ${fromPart}--to ${shellArg(opts.to)} --date ${shellArg(opts.depart)}${opts.return ? ` --return ${shellArg(opts.return)}` : ""} --json`,
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
            `voyagier search hotels --plan ${plan.id} --location ${shellArg(opts.hotel)} --checkin ${shellArg(ci)} --checkout ${shellArg(co)} --json`,
          );
        }
        nextSteps.push(`voyagier plans goals ${plan.id} --json   # inspect the goal graph + readiness`);
        nextSteps.push(`voyagier selection-options <selectionId> --wait --json   # poll options for a selection`);
        nextSteps.push(`voyagier select --selection-id <id> --option-id <id>   # choose an option`);

        const result = {
          ok: true,
          tripPlanId: plan.id,
          title: plan.title,
          travellerIds,
          scaffolded: true,
          note: "plan-trip creates a starting plan + default goal graph; compose the trip with the primitives below.",
          url: planUrl,
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
            "",
            "**Compose the trip:**",
            ...nextSteps.map((s) => `- \`${s}\``),
          ];
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        console.log(chalk.green(`\n✓ Plan ready: ${plan.title}`));
        console.log(chalk.dim(`  ${plan.id}`));
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
