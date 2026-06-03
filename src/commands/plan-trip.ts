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

type SortField = "price" | "duration" | "stops";
export type AutoSelectStrategy = "navigator" | "cheapest" | "fastest" | "fewest-stops";

export interface Alternative {
  rank: number;
  summary: string;
  price?: number;
  reason: string;
}

interface AutoSelectResult {
  departure?: { summary: string; airline?: string; duration?: string; price?: number };
  returnFlight?: { summary: string; airline?: string; duration?: string; price?: number };
  cabin?: { name: string; price?: number };
  hotel?: { name: string; price?: number; perNight: boolean };
  strategy: AutoSelectStrategy;
  rank: number;
  rankReason: string;
  error?: string;
}

export function parseDurationMinutes(duration?: string): number {
  if (!duration) return Infinity;
  const match = duration.match(/(\d+)h\s*(\d+)?m?/);
  if (match) return parseInt(match[1], 10) * 60 + (parseInt(match[2] ?? "0", 10));
  const minOnly = duration.match(/(\d+)\s*m/);
  if (minOnly) return parseInt(minOnly[1], 10);
  return Infinity;
}

export function parseStops(bookingData?: Record<string, unknown>): number {
  if (!bookingData) return Infinity;
  if (typeof bookingData.stops === "number") return bookingData.stops;
  const segments = bookingData.segments as unknown[] | undefined;
  if (segments) return Math.max(0, segments.length - 1);
  return Infinity;
}

export function sortOptions(options: SelectOption[], sortBy: SortField): SelectOption[] {
  return [...options].sort((a, b) => {
    switch (sortBy) {
      case "price":
        return (a.price ?? Infinity) - (b.price ?? Infinity);
      case "duration":
        return parseDurationMinutes(a.duration) - parseDurationMinutes(b.duration);
      case "stops":
        return parseStops(a.bookingData) - parseStops(b.bookingData);
      default:
        return 0;
    }
  });
}

// TODO: Replace with booking-api ranking service call
export function rankByNavigator(options: SelectOption[]): SelectOption[] {
  if (options.length === 0) return [];

  const byPrice = sortOptions(options, "price");
  const byDuration = sortOptions(options, "duration");
  const byStops = sortOptions(options, "stops");

  const priceRank = new Map<string, number>();
  const durationRank = new Map<string, number>();
  const stopsRank = new Map<string, number>();

  byPrice.forEach((o, i) => priceRank.set(o.id, i + 1));
  byDuration.forEach((o, i) => durationRank.set(o.id, i + 1));
  byStops.forEach((o, i) => stopsRank.set(o.id, i + 1));

  return [...options].sort((a, b) => {
    const scoreA = (priceRank.get(a.id)! * 0.5) + (durationRank.get(a.id)! * 0.3) + (stopsRank.get(a.id)! * 0.2);
    const scoreB = (priceRank.get(b.id)! * 0.5) + (durationRank.get(b.id)! * 0.3) + (stopsRank.get(b.id)! * 0.2);
    return scoreA - scoreB;
  });
}

export function applyStrategy(options: SelectOption[], strategy: AutoSelectStrategy): SelectOption[] {
  switch (strategy) {
    case "navigator": return rankByNavigator(options);
    case "cheapest": return sortOptions(options, "price");
    case "fastest": return sortOptions(options, "duration");
    case "fewest-stops":
      return [...options].sort((a, b) => {
        const stopsA = parseStops(a.bookingData);
        const stopsB = parseStops(b.bookingData);
        if (stopsA !== stopsB) return stopsA - stopsB;
        return (a.price ?? Infinity) - (b.price ?? Infinity);
      });
  }
}

export function getRankReason(strategy: AutoSelectStrategy): string {
  switch (strategy) {
    case "navigator": return "Best overall value based on price, duration, and stops";
    case "cheapest": return "Lowest price";
    case "fastest": return "Shortest flight duration";
    case "fewest-stops": return "Fewest layovers, then price";
  }
}

function strategyTitle(strategy: AutoSelectStrategy): string {
  switch (strategy) {
    case "navigator": return "🧭 Navigator's Pick";
    case "cheapest": return "💰 Cheapest Pick";
    case "fastest": return "⚡ Fastest Pick";
    case "fewest-stops": return "🛬 Fewest Stops Pick";
  }
}

export function generateAlternativeReason(alt: SelectOption, selected: SelectOption): string {
  const altPrice = alt.price;
  const selPrice = selected.price;
  const hasPrices = altPrice != null && selPrice != null && selPrice > 0;
  const altDuration = parseDurationMinutes(alt.duration);
  const selDuration = parseDurationMinutes(selected.duration);
  const altStops = parseStops(alt.bookingData);
  const selStops = parseStops(selected.bookingData);

  if (altStops < selStops && altStops === 0) {
    if (!hasPrices) return "Direct flight";
    return altPrice! > selPrice!
      ? `Direct flight, $${(altPrice! - selPrice!).toFixed(0)} more`
      : `Direct flight, saves $${(selPrice! - altPrice!).toFixed(0)}`;
  }

  if (altDuration < selDuration && altDuration !== Infinity && selDuration !== Infinity) {
    const mins = selDuration - altDuration;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const timeStr = h > 0 && m > 0 ? `${h}h${m}m` : h > 0 ? `${h}h` : `${m}m`;

    if (hasPrices) {
      const ratio = altPrice! / selPrice!;
      if (ratio >= 1.5) return `${timeStr} faster but ${ratio.toFixed(1)}x price`;
      const diff = altPrice! - selPrice!;
      return diff > 0
        ? `${timeStr} faster but $${diff.toFixed(0)} more`
        : `${timeStr} faster, saves $${Math.abs(diff).toFixed(0)}`;
    }
    return `${timeStr} faster`;
  }

  if (hasPrices && altPrice! < selPrice!) {
    const diff = selPrice! - altPrice!;
    if (altDuration > selDuration && altDuration !== Infinity && selDuration !== Infinity) {
      const mins = altDuration - selDuration;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const timeStr = h > 0 && m > 0 ? `${h}h${m}m` : h > 0 ? `${h}h` : `${m}m`;
      return `Saves $${diff.toFixed(0)} but ${timeStr} longer`;
    }
    return `Saves $${diff.toFixed(0)}`;
  }

  return alt.airline ? `${alt.airline} service` : "Option";
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

const VALID_STRATEGIES: AutoSelectStrategy[] = ["navigator", "cheapest", "fastest", "fewest-stops"];

export function registerPlanTripCommand(program: Command): void {
  program
    .command("plan-trip")
    .description("Create or extend a trip plan (flights + hotels). Use --plan <id> to add legs. Activities: voyagier search activities")
    .addHelpText("after", `
Examples:
  # Book a round-trip flight + hotel (two commands total):
  voyagier plan-trip --client "Smith Family" --title "Paris Trip" \\
    --from DCA --to Paris --depart <YYYY-MM-DD> --return <YYYY-MM-DD> \\
    --hotel Paris --travellers "John Doe" --auto-select navigator --json
  voyagier book <PLAN_ID> --json

  # One-way, cheapest option (omit --client to auto-pick if you have exactly one):
  voyagier plan-trip --title "London" --from JFK --to London \\
    --depart <YYYY-MM-DD> --travellers "Jane Smith" --auto-select cheapest --json

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
    .option("--sort <field>", "Sort options by: price, duration, stops", "price")
    .option("--max-results <n>", "Max options to show per category", "10")
    .option("--auto-select <strategy>", "Auto-select best options: navigator, cheapest, fastest, fewest-stops")
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

        // Validate --auto-select
        if (opts.autoSelect && !VALID_STRATEGIES.includes(opts.autoSelect as AutoSelectStrategy)) {
          fatal(`Invalid --auto-select value "${opts.autoSelect}". Valid: navigator, cheapest, fastest, fewest-stops`);
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

        const sortBy = (opts.sort ?? "price") as SortField;
        if (!["price", "duration", "stops"].includes(sortBy)) {
          fatal(`Invalid --sort value "${sortBy}". Valid: price, duration, stops`);
        }
        const maxResults = parseInt(opts.maxResults ?? "10", 10);
        if (!Number.isFinite(maxResults) || maxResults < 1) {
          fatal("--max-results must be a positive integer.");
        }
        const baseUrl = deriveBaseUrl(getApiUrl());

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
          const checkin = opts.checkin || opts.depart;
          const checkout = opts.checkout || opts.return;
          const datePart = checkin && checkout ? ` --checkin ${shellArg(checkin)} --checkout ${shellArg(checkout)}` : "";
          nextSteps.push(`voyagier search hotels --plan ${plan.id} --location ${shellArg(opts.hotel)}${datePart} --json`);
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
