import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl, getHomeAirports } from "../config.js";
import {
  GET_TRAVELLERS_BRIEF,
  CREATE_FLIGHT_SELECTION,
  GET_TRIP_PLAN_ITEM_TYPES,
  DELETE_TRIP_PLAN_ITEM,
  CREATE_HOTEL_SELECTION,
  CREATE_ACTIVITY_SELECTION,
  GET_DECISION_SELECTION_OPTIONS,
} from "../queries.js";
import {
  loadGoals,
  resolveGoal,
  resolveMirrorList,
  resolveDecisionSelection,
  setAirport,
  addDateOption,
  resolveDateRange,
  requireAirports,
  resolveReturnFlightGoal,
  requireDateSelection,
  setDestination,
} from "./search-helpers.js";
import { saveSearchState, loadSearchState } from "../state.js";
import { formatFlights, formatHotels, formatActivities } from "../formatters.js";
import { extractFlightToken, buildFlightSummary, buildHotelSummary, buildActivitySummary, validateDate, warnPastDate, validateIata, deriveBaseUrl, looksLikeAirportCode, shellArg } from "../utils.js";
import { agentFlightOptions, agentHotelOptions, agentActivityOptions } from "../agent-output.js";
import { deriveHotelStay } from "../hotel-format.js";
import { searchAirports } from "../data/airports.js";
import { findMetroArea } from "../data/metro-areas.js";
import { CliError, CliErrorCode } from "../errors.js";
import { startSpinner } from "../spinner.js";
import { isInteractive, promptText } from "../prompt.js";
import { scaffoldPlan, generateTripTitle } from "./scaffold.js";
import type { ShapeFlags } from "./scaffold.js";

/**
 * Resolve a date flag that used to be a commander `requiredOption` (VOY-1762):
 * return it if present, prompt for it at an interactive TTY, otherwise reproduce
 * commander's original missing-required-option failure BYTE-FOR-BYTE. Agents /
 * CI / --json / --agent / --no-input all fall through to that failure.
 *
 * Byte-identity matters: a missing `--date` used to be caught by commander's
 * parser (`.requiredOption`), which writes `error: required option '--date
 * <date>' not specified` to stderr, leaves stdout empty (even under --json — the
 * parser never reaches our JSON error envelope), and exits 1. We reproduce that
 * exactly via `command.error(...)` so agents/CI parsing the old string, and
 * pipelines relying on an empty stdout, keep working. In production (no
 * exitOverride) commander's own `_exit` terminates the process; under test
 * (exitOverride) it throws a CommanderError — same path commander always used.
 */
async function resolveDateOpt(
  current: string | undefined,
  opts: { json?: boolean; agent?: boolean; input?: boolean; noInput?: boolean },
  question: string,
  command: Command,
): Promise<string> {
  if (current) return current;
  if (isInteractive(opts)) {
    const answer = await promptText(question);
    if (answer) return answer;
  }
  command.error("error: required option '--date <date>' not specified", {
    exitCode: 1,
    code: "commander.missingMandatoryOptionValue",
  });
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

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
}

type SortField = "price" | "duration" | "stops" | "default";

/**
 * Reuse the goal's existing decision selection when present; create one only
 * when the goal has none (VOY-1692).
 *
 * Why reuse is mandatory: the backend validates picks (and resolves options)
 * exactly ONE mirror hop from a selection. The skeleton decision selection is
 * wired 1 hop from the monitor-owned option rows (flights: re-mirrored onto
 * the FlightJourney by createJourneyForLegs). A freshly-created selection
 * mirroring the goal's *List is 2 hops away for flights: its options read
 * empty and every pick fails "Option not found". Creating duplicates also
 * detaches checkout readiness from the selection the agent is operating on.
 */
// Exported for unit testing the reuse/fail-fast contract (VOY-1692).
export async function resolveOrCreateDecisionSelection(
  kind: "flights" | "hotels" | "activities",
  goal: { id: string; name: string; items: { selections: { id: string; type: string | null }[] }[] },
  tripPlanId: string,
  createMutation: string,
  createResultKey: string,
  input: Record<string, unknown>,
  quiet: boolean,
  progress?: (line: string) => void,
): Promise<{ selectionId: string; options: SelectOption[]; reused: boolean }> {
  const existingId = resolveDecisionSelection(goal as never, kind);
  if (existingId) {
    if (!quiet) {
      // When a spinner is live (progress provided), route through it — a raw
      // stderr write mid-animation garbles the current frame in scrollback.
      const line = `Using the goal's existing ${KIND_LABEL[kind]} selection.`;
      if (progress) progress(line);
      else process.stderr.write(chalk.dim(`${line}\n`));
    }
    const data = await graphql<{ getTripPlanSelection: { id?: string; options?: SelectOption[] } | null }>(
      GET_DECISION_SELECTION_OPTIONS,
      { tripPlanSelectionId: existingId },
    );
    if (!data.getTripPlanSelection) {
      // Fail fast: an empty-options response would read as "still fetching"
      // and send the caller off to poll a selection that no longer exists.
      throw new CliError(
        CliErrorCode.API_ERROR,
        `The goal's ${KIND_LABEL[kind]} selection ${existingId} could not be loaded (stale goal graph or deleted selection). ` +
          `Re-check the plan structure with: voyagier plans goals ${shellArg(tripPlanId)}`,
      );
    }
    return { selectionId: existingId, options: data.getTripPlanSelection.options ?? [], reused: true };
  }
  // Goal has no decision selection (custom / non-skeleton goal) — create one
  // linked to the goal's mirror list, the pre-VOY-1692 behaviour.
  const data = await graphql<Record<string, SelectionResult>>(createMutation, { tripPlanId, input });
  const result = data[createResultKey];
  return { selectionId: result.selection.id, options: result.options, reused: false };
}

const KIND_LABEL: Record<string, string> = { flights: "Flight", hotels: "Hotel", activities: "Activity" };

async function resolveTravellerIds(tripPlanId: string): Promise<string[]> {
  const data = await graphql<{ tripPlanTravellers: Traveller[] }>(
    GET_TRAVELLERS_BRIEF,
    { tripPlanId }
  );
  return data.tripPlanTravellers.map((t) => t.id);
}

// Exported for unit testing the --plan validation contract (VOY-1437).
export function resolvePlanId(opts: { plan?: string }): string {
  // A passed-but-empty/whitespace --plan is an error, NOT a cue to silently
  // fall back to the last-search plan. Falling back here would run the search
  // against a DIFFERENT plan than the caller named — silent cross-plan
  // contamination. Only a fully OMITTED --plan uses the last-search fallback.
  if (opts.plan !== undefined) {
    const trimmed = opts.plan.trim();
    if (trimmed === "") {
      throw new CliError(
        CliErrorCode.VALIDATION,
        "--plan was given an empty value. Pass a real plan id, or omit --plan to reuse the last-search plan.",
      );
    }
    return trimmed;
  }
  const state = loadSearchState();
  if (state?.tripPlanId) {
    process.stderr.write(
      chalk.yellow(`No --plan given; using plan from last search: ${state.tripPlanId}\n`),
    );
    return state.tripPlanId;
  }
  throw new CliError(CliErrorCode.VALIDATION, '--plan <id> is required. Create one first:\n  voyagier plan-trip --client <id|name|email> --title "My Trip"');
}

/**
 * Resolve the plan a search runs against — OR auto-scaffold a draft one when the
 * user gave neither `--plan` nor has a last-search fallback (VOY-1761).
 *
 * The first two branches are the exact pre-1761 behavior, owned by resolvePlanId
 * (VOY-1437): an explicit `--plan` (empty → error) or a last-search fallback.
 * Only when BOTH are absent — the "first command a new user types" case that used
 * to hard-error `--plan is required` — do we create a draft plan from the search
 * args and proceed as if it had been passed. `--dry-run` must not mutate, so it
 * keeps the old error there. Agents (--json/--agent/--no-input/non-TTY) never
 * prompt but DO still scaffold once the client resolves non-interactively — they
 * are the primary beneficiaries of this ticket.
 */
async function resolvePlanForSearch(
  opts: { plan?: string; client?: string; json?: boolean; agent?: boolean; noInput?: boolean; input?: boolean; dryRun?: boolean },
  scaffold: { title: string; shape: ShapeFlags },
  quiet: boolean,
): Promise<{ tripPlanId: string; scaffolded: boolean }> {
  if (opts.plan !== undefined || loadSearchState()?.tripPlanId) {
    return { tripPlanId: resolvePlanId(opts), scaffolded: false };
  }
  if (opts.dryRun) {
    // Preserve the pre-1761 hard error under --dry-run (scaffolding would create
    // a real plan, violating dry-run's no-mutation contract).
    return { tripPlanId: resolvePlanId(opts), scaffolded: false };
  }
  const result = await scaffoldPlan({
    client: opts.client,
    title: scaffold.title,
    shape: scaffold.shape,
    ensureGoals: true,
    quiet,
    interactive: isInteractive(opts),
  });
  if (!quiet) {
    process.stderr.write(chalk.cyan(`No plan given — created draft plan ${result.plan.title} (${result.plan.id})\n`));
  }
  return { tripPlanId: result.plan.id, scaffolded: true };
}



function parseDurationMinutes(duration?: string): number {
  if (!duration) return Infinity;
  const match = duration.match(/(\d+)h\s*(\d+)?m?/);
  if (match) return parseInt(match[1], 10) * 60 + (parseInt(match[2] ?? "0", 10));
  const minOnly = duration.match(/(\d+)\s*m/);
  if (minOnly) return parseInt(minOnly[1], 10);
  return Infinity;
}

function parseStops(bookingData?: Record<string, unknown>): number {
  if (!bookingData) return Infinity;
  if (typeof bookingData.stops === "number") return bookingData.stops;
  const segments = bookingData.segments as unknown[] | undefined;
  if (segments) return Math.max(0, segments.length - 1);
  return Infinity;
}

function sortOptions(options: SelectOption[], sortBy: SortField): SelectOption[] {
  if (sortBy === "default") return options;
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

/**
 * Resolve a user-supplied airport value to an IATA code.
 * Priority: exact IATA code → metro area (shows options) → single city match → ambiguous error.
 * Shows a note if city name was resolved. Throws CliError if ambiguous or unknown.
 */
function resolveAirportInput(value: string, flagName: string, quiet: boolean): string {
  // If it's already a valid 3-letter code, validate and return
  if (/^[A-Za-z]{3}$/.test(value.trim())) {
    validateIata(value, flagName);
    return value.toUpperCase();
  }

  // Check metro areas first — "Washington DC" → show BWI, DCA, IAD as options
  const metro = findMetroArea(value);
  if (metro) {
    if (metro.airports.length === 1) {
      if (!quiet) {
        process.stderr.write(chalk.dim(`Using ${metro.airports[0]} (${metro.name}) for ${flagName}\n`));
      }
      return metro.airports[0];
    }
    // Metro with multiple airports — use the primary (first) but show all
    if (!quiet) {
      process.stderr.write(chalk.dim(`${metro.name} airports: ${metro.airports.join(", ")}\n`));
      process.stderr.write(chalk.dim(`Using ${metro.airports[0]} (primary) for ${flagName}. Specify a code to override.\n`));
    }
    return metro.airports[0];
  }

  // Try to resolve as city name
  const matches = searchAirports(value);
  if (matches.length === 0) {
    throw new CliError(CliErrorCode.VALIDATION, `No airports found for ${flagName}: "${value}"\n  Use a 3-letter IATA code (e.g., LAX) or search: voyagier search airports ${shellArg(value)}`);
  }
  if (matches.length === 1) {
    if (!quiet) {
      process.stderr.write(chalk.dim(`Using ${matches[0].code} (${matches[0].name}) for ${flagName}\n`));
    }
    return matches[0].code;
  }
  // Multiple matches but not a known metro — show them all
  const codes = matches.slice(0, 10).map((m) => m.code).join(", ");
  throw new CliError(CliErrorCode.VALIDATION, `Multiple airports found for ${flagName}: "${value}". Specify a code: ${codes}\n  Run: voyagier search airports ${shellArg(value)} for details`);
}

/**
 * Cap on options shown by default (VOY-1714). The full option dump spreads raw
 * provider `bookingData` — a single flight search measured 2.7 MB of JSON —
 * which scrolls the selectionIds off the top of any terminal/agent buffer and
 * is exactly the oversized-payload shape that poisons LLM transcripts. Default
 * output = ids + counts + top summaries (everything an agent needs to pick);
 * the complete dump stays available behind --full.
 */
const TOP_OPTIONS = 10;

/**
 * Compact `--json` search envelope; `full` restores the complete option dump.
 * `refineHint` lists ONLY the refinement flags the calling subcommand actually
 * supports (`--max-stops` is flights-only; hotels/activities have `--sort`).
 */
function searchJsonBody(
  base: Record<string, unknown>,
  options: Array<Record<string, unknown>>,
  topOptions: Array<Record<string, unknown>>,
  full: boolean | undefined,
  refineHint: string,
): Record<string, unknown> {
  if (full) {
    return { ...base, optionCount: options.length, options: options.map((opt, i) => ({ index: i + 1, ...opt })) };
  }
  return {
    ...base,
    optionCount: options.length,
    topOptions: topOptions.slice(0, TOP_OPTIONS),
    ...(options.length > TOP_OPTIONS
      ? { note: `Showing top ${TOP_OPTIONS} of ${options.length} options — re-run with --full for the complete dump (large: includes raw provider bookingData), or refine with ${refineHint}.` }
      : {}),
  };
}

export function registerSearchCommands(program: Command): void {
  const search = program.command("search").description("Search flights, hotels, and activities");

  search
    .command("airports")
    .description("Search airports by city name or code")
    .argument("<query>", "City name or partial airport code")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action((query: string, opts: { json?: boolean; agent?: boolean }) => {
      const results = searchAirports(query);

      if (opts.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + "\n");
        return;
      }

      if (opts.agent) {
        if (results.length === 0) {
          process.stdout.write(`_No airports found matching "${query}"._\n`);
          return;
        }
        const lines = [`### Airports matching "${query}"`, ""];
        for (const r of results) {
          lines.push(`- **${r.code}** — ${r.city} (${r.name})`);
        }
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }

      if (results.length === 0) {
        process.stderr.write(chalk.yellow(`No airports found matching "${query}".\n`));
        return;
      }

      console.log(chalk.bold(`\n${results.length} airport${results.length !== 1 ? "s" : ""} matching "${query}":\n`));
      for (const r of results) {
        console.log(`  ${chalk.cyan(r.code)}  ${r.city.padEnd(20)} ${chalk.dim(r.name)}`);
      }
      console.log();
    });

  search
    .command("flights")
    .description("Search for flights")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--client <ref>", "Client id, email, or name for the auto-created draft plan when no --plan is given (same semantics as plan-trip)")
    .option("--goal <goalId>", "Target Flight goal (defaults to the first Flight goal on the plan)")
    .option("--from <code>", "Origin airport code (e.g., LAX)")
    .requiredOption("--to <code>", "Destination airport code (e.g., NRT)")
    .option("--date <date>", "Departure date (YYYY-MM-DD); prompted when omitted at a TTY")
    .option("--return <date>", "Return date (YYYY-MM-DD) for round-trip")
    .option("--max-stops <n>", "Maximum number of stops")
    .option("--sort <field>", "Sort by: price, duration, stops, default", "default")
    .option("--full", "Include ALL options with raw provider data in the output (large; default shows top summaries)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts, command) => {
      // Resolve --date FIRST (VOY-1762): it used to be a commander
      // `requiredOption`, so a missing --date failed at PARSE time — before any
      // action code, including origin/--from resolution — ran. Keeping the date
      // check ahead of origin resolution preserves that error precedence, so
      // `search flights --to X` (no --date, no origin) still reports the missing
      // --date rather than the "No origin specified" error. It also sits OUTSIDE
      // the try below so the CommanderError `command.error` throws (under
      // exitOverride, in tests) is not swallowed and re-wrapped by
      // handleSearchError — it must surface with commander's exact bytes/code.
      opts.date = await resolveDateOpt(opts.date, opts, "Departure date (YYYY-MM-DD): ", command);
      try {
        const quiet = !!(opts.json || opts.agent);
        // Resolve origin: explicit --from, or home airport default
        let origin: string;
        if (opts.from) {
          origin = resolveAirportInput(opts.from, "--from", quiet);
        } else {
          const homeAirports = getHomeAirports();
          if (homeAirports.length > 0) {
            origin = homeAirports[0].toUpperCase();
            validateIata(origin, "--from (home airport)");
            if (!opts.json && !opts.agent) process.stderr.write(chalk.dim(`Using home airport: ${origin} (from profile)\n`));
          } else {
            throw new CliError(CliErrorCode.VALIDATION, "No origin specified. Run: voyagier auth setup (or use --from <code>)");
          }
        }

        const destination = resolveAirportInput(opts.to, "--to", quiet);
        validateDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");
        if (opts.return) {
          validateDate(opts.return, "--return");
          warnPastDate(opts.return, "--return");
        }

        // Auto-scaffold a draft plan when no --plan/last-search exists (VOY-1761).
        // Shape: flight-only (no hotel), and one-way unless --return is given.
        const { tripPlanId, scaffolded } = await resolvePlanForSearch(
          opts,
          {
            title: generateTripTitle({ to: destination, depart: opts.date }),
            shape: { oneWay: !opts.return, flightOnly: true, hotelOnly: false },
          },
          quiet,
        );
        const dryRun = !!opts.dryRun;
        const showProgress = !dryRun && !opts.json && !opts.agent;

        const travellerSpinner = showProgress ? startSpinner("Resolving travellers...") : null;
        let travellerIds: string[];
        try {
          travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        } finally {
          travellerSpinner?.stop();
        }
        // A freshly auto-scaffolded plan is traveller-less by design (VOY-1761:
        // traveller checkout blockers are out of scope, and the backend accepts a
        // flight search with zero travellers). Only require travellers on a plan
        // the caller pointed us at.
        if (!dryRun && travellerIds.length === 0 && !scaffolded) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${shellArg(tripPlanId)} --first <name> --last <name> --type ADULT`);
        }

        const isRoundTrip = !!opts.return;

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list",
                steps: [
                  `resolve Flight goal (--goal or first Flight goal)`,
                  `set origin airport -> ${origin}, destination airport -> ${destination}`,
                  `set date -> ${opts.date}${opts.return ? `, return -> ${opts.return}` : ""}`,
                  `reuse the goal's existing Flight decision selection (create only if the goal has none)`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        // New goal/mirror-list model: set the goal's inputs, then create a
        // selection mirroring the goal's FlightList. Options are produced
        // asynchronously by the backend monitor (surfaced via selection-options).
        // The whole fetch runs under a spinner (try/finally so a thrown CliError
        // never leaves a dangling animation interval).
        const searchSpinner = showProgress ? startSpinner("Searching flights...") : null;
        let selectionId: string;
        let fetchedOptions: SelectOption[];
        let returnSelectionId: string | null = null;
        try {
          const goals = await loadGoals(tripPlanId);
          const goal = resolveGoal(goals, "flights", opts.goal);
          const mirrorListSelectionId = resolveMirrorList(goal, "flights");
          // Fail fast if the goal graph can't accept the required inputs, rather
          // than create a selection silently stuck AWAITING_INPUT downstream.
          const aps = requireAirports(goal, 2);
          const dateSel = requireDateSelection(goals);
          await setAirport(aps[0], origin);
          await setAirport(aps[1], destination);
          // Round-trip: also wire the RETURN-leg goal's airports (reversed:
          // destination -> origin), or its segment query stays insufficient and
          // no inventory is fetched (VOY-1421). One-way plans have no return goal.
          if (isRoundTrip) {
            const returnGoal = resolveReturnFlightGoal(goals, goal.id);
            if (returnGoal) {
              const returnAps = requireAirports(returnGoal, 2);
              await setAirport(returnAps[0], destination);
              await setAirport(returnAps[1], origin);
              // Surface the return goal's decision selection too: a round trip is
              // complete only when BOTH legs carry a choice (VOY-1692).
              returnSelectionId = resolveDecisionSelection(returnGoal, "flights");
            }
          }
          // Resolve BOTH date outputs so the round-trip monitor query is
          // sufficient (VOY-1421): startDate from --date, endDate via duration
          // when --return is given.
          await resolveDateRange(dateSel, opts.date, opts.return);

          // Reuse the goal's existing Flight (leg) selection — the one wired
          // 1 mirror hop from the FlightJourney's option rows — instead of
          // creating a duplicate 2 hops away (VOY-1692).
          ({ selectionId, options: fetchedOptions } = await resolveOrCreateDecisionSelection(
            "flights",
            goal,
            tripPlanId,
            CREATE_FLIGHT_SELECTION,
            "createTripPlanFlightSelection",
            { goalId: goal.id, mirrorListSelectionId, travellerIds, title: `Flight: ${origin} → ${destination}` },
            quiet,
            searchSpinner ? (l) => searchSpinner.update(l) : undefined,
          ));
        } finally {
          searchSpinner?.stop();
        }

        const sortBy = (opts.sort ?? "default") as SortField;
        // --max-stops is a client-side presentation filter over the options the
        // backend returned (same layer as --sort), not a goal-input constraint.
        let filtered = [...fetchedOptions].sort((a, b) => a.sortOrder - b.sortOrder);
        if (opts.maxStops !== undefined) {
          const maxStops = Number(opts.maxStops);
          if (!Number.isInteger(maxStops) || maxStops < 0) {
            throw new CliError(
              CliErrorCode.VALIDATION,
              `--max-stops must be a non-negative integer (got "${opts.maxStops}").`,
            );
          }
          filtered = filtered.filter((o) => parseStops(o.bookingData) <= maxStops);
        }
        const options = sortOptions(filtered, sortBy);

        const searchResults = options.map((opt, i) => ({
          index: i + 1,
          optionId: opt.id,
          flightToken: extractFlightToken(opt.bookingData),
          summary: buildFlightSummary(opt, origin, destination),
        }));

        saveSearchState({
          type: "flights",
          tripPlanId,
          selectionId,
          ...(returnSelectionId ? { returnSelectionId } : {}),
          isRoundTrip,
          origin,
          destination,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(searchJsonBody(
            {
              tripPlanId,
              ...(scaffolded ? { scaffolded: true } : {}),
              selectionId,
              ...(returnSelectionId ? { returnSelectionId } : {}),
              isRoundTrip,
              url: `${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}`,
            },
            options as unknown as Array<Record<string, unknown>>,
            searchResults,
            opts.full,
            "--sort/--max-stops",
          ), null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}`;
          const lines: string[] = [];
          lines.push(`### Flights (${origin} → ${destination})`);
          if (scaffolded) lines.push(`_No plan given — created draft plan \`${tripPlanId}\`._`);
          if (options.length === 0) {
            // Options are produced asynchronously by the monitor once the goal's
            // inputs are sufficient. Empty here usually means "still fetching",
            // not "no results" — point at the async-aware poll (VOY-1421).
            lines.push("_No options yet — the search is still fetching inventory._");
            lines.push("");
            lines.push(`**Next:** \`voyagier selection-options ${shellArg(selectionId)} --wait --json\``);
          } else {
            const shown = opts.full ? options : options.slice(0, TOP_OPTIONS);
            lines.push(agentFlightOptions(shown));
            if (options.length > shown.length) {
              lines.push(`_…and ${options.length - shown.length} more — \`--full\` lists all, \`--sort price\`/\`--max-stops\` refine._`);
            }
            lines.push("");
            lines.push("**Next:** `voyagier select <number>`");
          }
          if (isRoundTrip && returnSelectionId) {
            lines.push("");
            lines.push(
              `_Round trip: after choosing the outbound, also choose on the return selection — \`voyagier select --selection-id ${shellArg(returnSelectionId)} --option-id <id>\` (options: \`voyagier selection-options ${shellArg(returnSelectionId)} --wait --json\`)._`,
            );
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (options.length === 0) {
          process.stderr.write(chalk.dim("No options yet — the search is still fetching inventory.\n"));
          process.stderr.write(chalk.dim(`  Poll: voyagier selection-options ${shellArg(selectionId)} --wait\n`));
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} flight option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        console.log(formatFlights(options));
        await printPlanFooter(tripPlanId);
        if (isRoundTrip) {
          console.log(chalk.dim(`  Note: Select the outbound leg first, then the return leg${returnSelectionId ? ` (selection ${returnSelectionId})` : ""}.`));
        }
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });

  search
    .command("hotels")
    .description("Search for hotels")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--client <ref>", "Client id, email, or name for the auto-created draft plan when no --plan is given (same semantics as plan-trip)")
    .option("--goal <goalId>", "Target Hotel goal (defaults to the first Hotel goal on the plan)")
    .requiredOption("--location <place>", "Destination (city name)")
    .requiredOption("--checkin <date>", "Check-in date (YYYY-MM-DD)")
    .requiredOption("--checkout <date>", "Check-out date (YYYY-MM-DD)")
    .option("--currency <code>", "Currency code", "USD")
    .option("--guests <n>", "Number of adult guests", "1")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--full", "Include ALL options with raw provider data in the output (large; default shows top summaries)")
    .option("--replace", "Replace existing hotel items for this location (removes old selections)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--verbose", "Show request details sent to the API")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts) => {
      try {
        validateDate(opts.checkin, "--checkin");
        warnPastDate(opts.checkin, "--checkin");
        warnPastDate(opts.checkin, "--checkin");
        validateDate(opts.checkout, "--checkout");
        warnPastDate(opts.checkout, "--checkout");
        warnPastDate(opts.checkout, "--checkout");

        const quietHotel = !!(opts.json || opts.agent);
        // Auto-scaffold a hotel-only draft plan when no --plan/last-search exists.
        const { tripPlanId, scaffolded } = await resolvePlanForSearch(
          opts,
          {
            title: generateTripTitle({ hotel: opts.location, checkin: opts.checkin }),
            shape: { oneWay: false, flightOnly: false, hotelOnly: true },
          },
          quietHotel,
        );
        const dryRun = !!opts.dryRun;
        const showProgress = !dryRun && !opts.json && !opts.agent;

        const travellerSpinner = showProgress ? startSpinner("Resolving travellers...") : null;
        let travellerIds: string[];
        try {
          travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        } finally {
          travellerSpinner?.stop();
        }
        // Auto-scaffolded plans are traveller-less by design (VOY-1761); only
        // require travellers on a plan the caller pointed us at.
        if (!dryRun && travellerIds.length === 0 && !scaffolded) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${shellArg(tripPlanId)} --first <name> --last <name> --type ADULT`);
        }

        // Check for existing hotel items and handle --replace.

        // Filter by selection type (HOTEL) instead of title text to avoid
        // false matches on unrelated items whose titles contain "hotel".
        if (!dryRun) {
          try {
            const planData = await graphql<{
              tripPlan: { items: Array<{ id: string; title: string; selections?: Array<{ type: string }> }> };
            }>(
              GET_TRIP_PLAN_ITEM_TYPES,
              { id: tripPlanId }
            );
            const hotelItems = planData.tripPlan.items.filter(
              (item) => (item.selections ?? []).some((s) => s.type === "HOTEL")
            );
            if (hotelItems.length > 0) {
              if (opts.replace) {
                for (const item of hotelItems) {
                  await graphql<{ deleteTripPlanItem: boolean }>(
                    DELETE_TRIP_PLAN_ITEM,
                    { id: item.id }
                  );
                }
                if (!opts.json) {
                  process.stderr.write(chalk.dim(`Replaced ${hotelItems.length} existing hotel item${hotelItems.length > 1 ? "s" : ""}.\n`));
                }
              } else if (!opts.json) {
                process.stderr.write(chalk.yellow(`⚠ This plan already has ${hotelItems.length} hotel item${hotelItems.length > 1 ? "s" : ""}. Use --replace to remove them first.\n`));
              }
            }
          } catch (err) {
            // Non-fatal — continue with search, but warn if --replace was requested
            // so the user knows cleanup didn't happen.
            if (opts.replace && !opts.json) {
              process.stderr.write(chalk.yellow(`⚠ --replace: failed to clean up existing hotel items. Duplicates may result.\n`));
            }
          }
        }

        if (!dryRun && opts.verbose) {
          process.stderr.write(chalk.dim(`API request — location: "${opts.location}", check-in: ${opts.checkin}, check-out: ${opts.checkout}\n`));
        }

        const adults = parseInt(opts.guests, 10);
        if (!Number.isFinite(adults) || adults < 1) {
          throw new CliError(CliErrorCode.VALIDATION, "--guests must be an integer ≥ 1.");
        }

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list",
                steps: [
                  `resolve Hotel goal (--goal or first Hotel goal)`,
                  `set date -> ${opts.checkin} (and ${opts.checkout})`,
                  `reuse the goal's existing Hotel decision selection (create only if the goal has none)`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        // The whole fetch runs under a spinner (try/finally so a thrown CliError
        // never leaves a dangling animation interval).
        const searchSpinner = showProgress ? startSpinner("Searching hotels...") : null;
        let selectionId: string;
        let fetchedOptions: SelectOption[];
        try {
          const goals = await loadGoals(tripPlanId);
          const goal = resolveGoal(goals, "hotels", opts.goal);
          const mirrorListSelectionId = resolveMirrorList(goal, "hotels");
          const dateSel = requireDateSelection(goals);
          // --location applies to the plan-level Destination selection (Hotel goals
          // inherit destination via bindings; there's no per-Hotel location input).
          // Throws if no Destination selection exists, so the flag never silently no-ops.
          if (opts.location) await setDestination(goals, opts.location);
          // Resolve check-in + check-out so the hotel monitor query is sufficient
          // (VOY-1421): check-out is derived as a duration from check-in.
          await resolveDateRange(dateSel, opts.checkin, opts.checkout);

          ({ selectionId, options: fetchedOptions } = await resolveOrCreateDecisionSelection(
            "hotels",
            goal,
            tripPlanId,
            CREATE_HOTEL_SELECTION,
            "createTripPlanHotelSelection",
            { goalId: goal.id, mirrorListSelectionId, travellerIds, title: `Hotel: ${opts.location}` },
            !!(opts.json || opts.agent),
            searchSpinner ? (l) => searchSpinner.update(l) : undefined,
          ));
        } finally {
          searchSpinner?.stop();
        }

        const sortBy = (opts.sort ?? "default") as SortField;
        const options = sortBy === "price"
          ? [...fetchedOptions].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          : [...fetchedOptions].sort((a, b) => a.sortOrder - b.sortOrder);

        const searchResults = options.map((opt, i) => {
          // VOY-1724: minRate is a STAY TOTAL — expose derived stay fields
          // (additive; existing keys unchanged).
          const stay = deriveHotelStay(opt.price, opt.bookingData);
          return {
            index: i + 1,
            optionId: opt.id,
            summary: buildHotelSummary(opt),
            ...(stay
              ? {
                  stayTotal: stay.stayTotal,
                  nights: stay.nights,
                  perNight: stay.perNight,
                  checkIn: stay.checkIn,
                  checkOut: stay.checkOut,
                }
              : {}),
          };
        });

        saveSearchState({
          type: "hotels",
          tripPlanId: tripPlanId,
          selectionId: selectionId,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(searchJsonBody(
            {
              tripPlanId: tripPlanId,
              ...(scaffolded ? { scaffolded: true } : {}),
              selectionId: selectionId,
              url: `${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}`,
            },
            options as unknown as Array<Record<string, unknown>>,
            searchResults,
            opts.full,
            "--sort",
          ), null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}`;
          const lines: string[] = [];
          lines.push(`### Hotels (${opts.location})`);
          if (scaffolded) lines.push(`_No plan given — created draft plan \`${tripPlanId}\`._`);
          if (options.length === 0) {
            // Empty immediately after create usually means the monitor is still
            // fetching, not that there are no hotels — poll first (VOY-1421).
            lines.push("_No options yet — the search is still fetching inventory._");
            lines.push("");
            lines.push(`**Next:** \`voyagier selection-options ${shellArg(selectionId)} --wait --json\``);
          } else {
            const shown = opts.full ? options : options.slice(0, TOP_OPTIONS);
            lines.push(agentHotelOptions(shown));
            if (options.length > shown.length) {
              lines.push(`_…and ${options.length - shown.length} more — \`--full\` lists all._`);
            }
            lines.push("");
            lines.push("**Next:** `voyagier select <number>`");
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (options.length === 0) {
          const loc = opts.location as string;
          process.stderr.write(chalk.dim(`No options yet — the search may still be fetching inventory.\n`));
          process.stderr.write(chalk.dim(`  Poll: voyagier selection-options ${shellArg(selectionId)} --wait\n\n`));
          process.stderr.write(chalk.yellow(`If it stays empty, no hotels matched "${loc}" on these dates.\n\n`));
          process.stderr.write(chalk.dim("Suggestions:\n"));
          if (looksLikeAirportCode(loc)) {
            process.stderr.write(chalk.dim(`  • "${loc.toUpperCase()}" looks like an airport code — the API needs a city name\n`));
            process.stderr.write(chalk.dim(`    e.g. try "Kota Kinabalu" instead of "BKI", "Kuala Lumpur" instead of "KUL"\n`));
          } else {
            process.stderr.write(chalk.dim(`  • Try a different location format: full city name, region, or country\n`));
          }
          process.stderr.write(chalk.dim(`  • Try a nearby major city with more hotel inventory\n`));
          process.stderr.write(chalk.dim(`  • Use --verbose to see exactly what location was sent to the API\n`));
          process.stderr.write(chalk.dim(`  • Check the web UI for expanded search options:\n`));
          process.stderr.write(chalk.dim(`    ${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}\n`));
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} hotel option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        console.log(formatHotels(options));
        await printPlanFooter(tripPlanId);
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });

  search
    .command("activities")
    .description("Search for bookable experiences and activities")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--goal <goalId>", "Target Activity goal (defaults to the first Activity goal on the plan)")
    .requiredOption("--destination <place>", "Destination name (city or region)")
    .option("--date <date>", "Travel date (YYYY-MM-DD); prompted when omitted at a TTY")
    .option("--query <text>", "Free text search (e.g. 'snorkeling')")
    .option("--currency <code>", "Currency code", "USD")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--full", "Include ALL options with raw provider data in the output (large; default shows top summaries)")
    .option("--replace", "Replace existing activity items for this destination (removes old selections)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--verbose", "Show request details sent to the API")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts, command) => {
      // Resolve --date FIRST and OUTSIDE the try (VOY-1762): a missing --date was
      // a commander `requiredOption` parse failure; reproduce it byte-for-byte
      // without letting the CommanderError get re-wrapped by handleSearchError.
      opts.date = await resolveDateOpt(opts.date, opts, "Travel date (YYYY-MM-DD): ", command);
      try {
        validateDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");

        const tripPlanId = resolvePlanId(opts);
        const dryRun = !!opts.dryRun;
        const showProgress = !dryRun && !opts.json && !opts.agent;

        const travellerSpinner = showProgress ? startSpinner("Resolving travellers...") : null;
        let travellerIds: string[];
        try {
          travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        } finally {
          travellerSpinner?.stop();
        }
        if (!dryRun && travellerIds.length === 0) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${shellArg(tripPlanId)} --first <name> --last <name> --type ADULT`);
        }

        // Check for existing activity items and handle --replace.
        if (!dryRun) {
          try {
            const planData = await graphql<{
              tripPlan: { items: Array<{ id: string; title: string; selections?: Array<{ type: string }> }> };
            }>(
              GET_TRIP_PLAN_ITEM_TYPES,
              { id: tripPlanId }
            );
            const activityItems = planData.tripPlan.items.filter(
              (item) => (item.selections ?? []).some((s) => s.type === "ACTIVITY")
            );
            if (activityItems.length > 0) {
              if (opts.replace) {
                for (const item of activityItems) {
                  await graphql<{ deleteTripPlanItem: boolean }>(
                    DELETE_TRIP_PLAN_ITEM,
                    { id: item.id }
                  );
                }
                if (!opts.json) {
                  process.stderr.write(chalk.dim(`Replaced ${activityItems.length} existing activity item${activityItems.length > 1 ? "s" : ""}.\n`));
                }
              } else if (!opts.json) {
                process.stderr.write(chalk.yellow(`⚠ This plan already has ${activityItems.length} activity item${activityItems.length > 1 ? "s" : ""}. Use --replace to remove them first.\n`));
              }
            }
          } catch (err) {
            if (opts.replace && !opts.json) {
              process.stderr.write(chalk.yellow(`⚠ --replace: failed to clean up existing activity items. Duplicates may result.\n`));
            }
          }
        }

        if (!dryRun && opts.verbose) {
          process.stderr.write(chalk.dim(`API request — destination: "${opts.destination}", date: ${opts.date}${opts.query ? `, query: "${opts.query}"` : ""}\n`));
        }

        const titleParts = [`Activity: ${opts.destination}`];
        if (opts.query) titleParts.push(opts.query);

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list",
                steps: [
                  `resolve Activity goal (--goal or first Activity goal)`,
                  `set date -> ${opts.date}`,
                  `reuse the goal's existing Activity decision selection (create only if the goal has none)`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        // The whole fetch runs under a spinner (try/finally so a thrown CliError
        // never leaves a dangling animation interval).
        const searchSpinner = showProgress ? startSpinner("Searching activities...") : null;
        let selectionId: string;
        let fetchedOptions: SelectOption[];
        try {
          const goals = await loadGoals(tripPlanId);
          const goal = resolveGoal(goals, "activities", opts.goal);
          const mirrorListSelectionId = resolveMirrorList(goal, "activities");
          const dateSel = requireDateSelection(goals);
          // --destination applies to the plan-level Destination selection (Activity
          // goals inherit destination via bindings; no per-Activity location input).
          if (opts.destination) await setDestination(goals, opts.destination);
          await addDateOption(dateSel, opts.date);

          ({ selectionId, options: fetchedOptions } = await resolveOrCreateDecisionSelection(
            "activities",
            goal,
            tripPlanId,
            CREATE_ACTIVITY_SELECTION,
            "createTripPlanActivitySelection",
            { goalId: goal.id, mirrorListSelectionId, travellerIds, title: titleParts.join(" — ") },
            !!(opts.json || opts.agent),
            searchSpinner ? (l) => searchSpinner.update(l) : undefined,
          ));
        } finally {
          searchSpinner?.stop();
        }

        const sortBy = (opts.sort ?? "default") as SortField;
        const options = sortBy === "price"
          ? [...fetchedOptions].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          : [...fetchedOptions].sort((a, b) => a.sortOrder - b.sortOrder);

        const searchResults = options.map((opt, i) => ({
          index: i + 1,
          optionId: opt.id,
          summary: buildActivitySummary(opt),
        }));

        saveSearchState({
          type: "activities",
          tripPlanId: tripPlanId,
          selectionId: selectionId,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(searchJsonBody(
            {
              tripPlanId: tripPlanId,
              selectionId: selectionId,
              url: `${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}`,
            },
            options as unknown as Array<Record<string, unknown>>,
            searchResults,
            opts.full,
            "--sort",
          ), null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${tripPlanId}`;
          const lines: string[] = [];
          lines.push(`### Activities (${opts.destination})`);
          if (options.length === 0) {
            lines.push("_No activities found for this destination and date._");
          } else {
            const shown = opts.full ? options : options.slice(0, TOP_OPTIONS);
            lines.push(agentActivityOptions(shown));
            if (options.length > shown.length) {
              lines.push(`_…and ${options.length - shown.length} more — \`--full\` lists all._`);
            }
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          lines.push("");
          lines.push("**Next:** `voyagier select <number>`");
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (options.length === 0) {
          process.stderr.write(chalk.yellow(`No activities found for "${opts.destination}" on this date.\n`));
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} activity option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        console.log(formatActivities(options));
        await printPlanFooter(tripPlanId);
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });
}





function handleSearchError(err: unknown): never {
  if (err instanceof CliError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("401") || message.includes("Unauthorized") || message.includes("Authentication")) {
    throw new CliError(CliErrorCode.AUTH_FAILED, "Authentication failed. Run: voyagier auth setup");
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("Network error")) {
    throw new CliError(CliErrorCode.NETWORK, "Could not connect to API. Run: voyagier auth status");
  } else {
    throw new CliError(CliErrorCode.API_ERROR, `Search error: ${message}`);
  }
}
