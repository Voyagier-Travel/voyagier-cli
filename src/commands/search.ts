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
} from "../queries.js";
import {
  loadGoals,
  resolveGoal,
  resolveMirrorList,
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
import { extractFlightToken, buildFlightSummary, buildHotelSummary, buildActivitySummary, validateDate, warnPastDate, validateIata, deriveBaseUrl, looksLikeAirportCode } from "../utils.js";
import { agentFlightOptions, agentHotelOptions, agentActivityOptions } from "../agent-output.js";
import { searchAirports } from "../data/airports.js";
import { findMetroArea } from "../data/metro-areas.js";
import { CliError, CliErrorCode } from "../errors.js";

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

async function resolveTravellerIds(tripPlanId: string): Promise<string[]> {
  const data = await graphql<{ tripPlanTravellers: Traveller[] }>(
    GET_TRAVELLERS_BRIEF,
    { tripPlanId }
  );
  return data.tripPlanTravellers.map((t) => t.id);
}

function resolvePlanId(opts: { plan?: string }): string {
  if (opts.plan) return opts.plan;
  const state = loadSearchState();
  if (state?.tripPlanId) {
    process.stderr.write(chalk.dim(`Using plan from last search: ${state.tripPlanId}\n`));
    return state.tripPlanId;
  }
  throw new CliError(CliErrorCode.VALIDATION, '--plan <id> is required. Create one first:\n  voyagier plans create --title "My Trip"');
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
    throw new CliError(CliErrorCode.VALIDATION, `No airports found for ${flagName}: "${value}"\n  Use a 3-letter IATA code (e.g., LAX) or search: voyagier search airports "${value}"`);
  }
  if (matches.length === 1) {
    if (!quiet) {
      process.stderr.write(chalk.dim(`Using ${matches[0].code} (${matches[0].name}) for ${flagName}\n`));
    }
    return matches[0].code;
  }
  // Multiple matches but not a known metro — show them all
  const codes = matches.slice(0, 10).map((m) => m.code).join(", ");
  throw new CliError(CliErrorCode.VALIDATION, `Multiple airports found for ${flagName}: "${value}". Specify a code: ${codes}\n  Run: voyagier search airports "${value}" for details`);
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
    .option("--goal <goalId>", "Target Flight goal (defaults to the first Flight goal on the plan)")
    .option("--from <code>", "Origin airport code (e.g., LAX)")
    .requiredOption("--to <code>", "Destination airport code (e.g., NRT)")
    .requiredOption("--date <date>", "Departure date (YYYY-MM-DD)")
    .option("--return <date>", "Return date (YYYY-MM-DD) for round-trip")
    .option("--max-stops <n>", "Maximum number of stops")
    .option("--sort <field>", "Sort by: price, duration, stops, default", "default")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .action(async (opts) => {
      try {
        // Resolve origin: explicit --from, or home airport default
        const quiet = !!(opts.json || opts.agent);
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

        const tripPlanId = resolvePlanId(opts);
        const dryRun = !!opts.dryRun;

        if (!dryRun && !opts.json && !opts.agent) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        if (!dryRun && travellerIds.length === 0) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT`);
        }

        if (!dryRun && !opts.json && !opts.agent) process.stderr.write(chalk.dim("Searching flights...\n"));
        const isRoundTrip = !!opts.return;

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list (VOY-1414)",
                steps: [
                  `resolve Flight goal (--goal or first Flight goal) + its FlightList mirror`,
                  `set origin airport -> ${origin}, destination airport -> ${destination}`,
                  `set date -> ${opts.date}${opts.return ? `, return -> ${opts.return}` : ""}`,
                  `createTripPlanFlightSelection({ goalId, mirrorListSelectionId, travellerIds })`,
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
          }
        }
        // Resolve BOTH date outputs so the round-trip monitor query is
        // sufficient (VOY-1421): startDate from --date, endDate via duration
        // when --return is given.
        await resolveDateRange(dateSel, opts.date, opts.return);

        const data = await graphql<{ createTripPlanFlightSelection: SelectionResult }>(
          CREATE_FLIGHT_SELECTION,
          {
            tripPlanId,
            input: { goalId: goal.id, mirrorListSelectionId, travellerIds, title: `Flight: ${origin} → ${destination}` },
          },
        );

        const result = data.createTripPlanFlightSelection;
        const sortBy = (opts.sort ?? "default") as SortField;
        // --max-stops is a client-side presentation filter over the options the
        // backend returned (same layer as --sort), not a goal-input constraint.
        let filtered = result.options.sort((a, b) => a.sortOrder - b.sortOrder);
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
          tripPlanId: result.item.tripPlanId,
          selectionId: result.selection.id,
          isRoundTrip,
          origin,
          destination,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            tripPlanId: result.item.tripPlanId,
            selectionId: result.selection.id,
            isRoundTrip,
            options: options.map((opt, i) => ({ index: i + 1, ...opt })),
            url: `${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}`;
          const lines: string[] = [];
          lines.push(`### Flights (${origin} → ${destination})`);
          if (options.length === 0) {
            // Options are produced asynchronously by the monitor once the goal's
            // inputs are sufficient. Empty here usually means "still fetching",
            // not "no results" — point at the async-aware poll (VOY-1421).
            lines.push("_No options yet — the search is still fetching inventory._");
            lines.push("");
            lines.push(`**Next:** \`voyagier selection-options ${result.selection.id} --wait --json\``);
            if (isRoundTrip) {
              lines.push("");
              lines.push(
                "_Known limitation (VOY-1422): round-trip searches may stay empty because the " +
                  "return leg does not yet trigger the combined flight search on the backend. " +
                  "Outbound + return airports and dates are set correctly; tracked for a backend fix._",
              );
            }
          } else {
            lines.push(agentFlightOptions(options));
            lines.push("");
            if (isRoundTrip) lines.push("_Note: Select departure first, then return._");
            lines.push("**Next:** `voyagier select <number>`");
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (options.length === 0) {
          process.stderr.write(chalk.dim("No options yet — the search is still fetching inventory.\n"));
          process.stderr.write(chalk.dim(`  Poll: voyagier selection-options ${result.selection.id} --wait\n`));
          if (isRoundTrip) {
            process.stderr.write(
              chalk.yellow(
                "  Note: round-trip searches may stay empty (VOY-1422) — the return leg does not\n" +
                "  yet trigger the combined search on the backend. Inputs are set correctly.\n",
              ),
            );
          }
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} flight option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        console.log(formatFlights(options));
        await printPlanFooter(result.item.tripPlanId);
        if (isRoundTrip) {
          console.log(chalk.dim(`  Note: Select departure first, then return.`));
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
    .option("--goal <goalId>", "Target Hotel goal (defaults to the first Hotel goal on the plan)")
    .requiredOption("--location <place>", "Destination (city name)")
    .requiredOption("--checkin <date>", "Check-in date (YYYY-MM-DD)")
    .requiredOption("--checkout <date>", "Check-out date (YYYY-MM-DD)")
    .option("--currency <code>", "Currency code", "USD")
    .option("--guests <n>", "Number of adult guests", "1")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--replace", "Replace existing hotel items for this location (removes old selections)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--verbose", "Show request details sent to the API")
    .action(async (opts) => {
      try {
        validateDate(opts.checkin, "--checkin");
        warnPastDate(opts.checkin, "--checkin");
        warnPastDate(opts.checkin, "--checkin");
        validateDate(opts.checkout, "--checkout");
        warnPastDate(opts.checkout, "--checkout");
        warnPastDate(opts.checkout, "--checkout");

        const tripPlanId = resolvePlanId(opts);
        const dryRun = !!opts.dryRun;

        if (!dryRun && !opts.json && !opts.agent) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        if (!dryRun && travellerIds.length === 0) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT`);
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

        if (!dryRun && !opts.json && !opts.agent) process.stderr.write(chalk.dim("Searching hotels...\n"));
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
                flow: "goal/mirror-list (VOY-1414)",
                steps: [
                  `resolve Hotel goal (--goal or first Hotel goal) + its HotelList mirror`,
                  `set date -> ${opts.checkin} (and ${opts.checkout})`,
                  `createTripPlanHotelSelection({ goalId, mirrorListSelectionId, travellerIds })`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

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

        const data = await graphql<{ createTripPlanHotelSelection: SelectionResult }>(
          CREATE_HOTEL_SELECTION,
          {
            tripPlanId,
            input: { goalId: goal.id, mirrorListSelectionId, travellerIds, title: `Hotel: ${opts.location}` },
          },
        );

        const result = data.createTripPlanHotelSelection;
        const sortBy = (opts.sort ?? "default") as SortField;
        const options = sortBy === "price"
          ? [...result.options].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          : result.options.sort((a, b) => a.sortOrder - b.sortOrder);

        const searchResults = options.map((opt, i) => ({
          index: i + 1,
          optionId: opt.id,
          summary: buildHotelSummary(opt),
        }));

        saveSearchState({
          type: "hotels",
          tripPlanId: result.item.tripPlanId,
          selectionId: result.selection.id,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            tripPlanId: result.item.tripPlanId,
            selectionId: result.selection.id,
            options: options.map((opt, i) => ({ index: i + 1, ...opt })),
            url: `${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}`;
          const lines: string[] = [];
          lines.push(`### Hotels (${opts.location})`);
          if (options.length === 0) {
            // Empty immediately after create usually means the monitor is still
            // fetching, not that there are no hotels — poll first (VOY-1421).
            lines.push("_No options yet — the search is still fetching inventory._");
            lines.push("");
            lines.push(`**Next:** \`voyagier selection-options ${result.selection.id} --wait --json\``);
          } else {
            lines.push(agentHotelOptions(options));
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
          process.stderr.write(chalk.dim(`  Poll: voyagier selection-options ${result.selection.id} --wait\n\n`));
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
          process.stderr.write(chalk.dim(`    ${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}\n`));
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} hotel option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        console.log(formatHotels(options));
        await printPlanFooter(result.item.tripPlanId);
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });

  search
    .command("activities")
    .description("Search for Viator experiences and activities")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--goal <goalId>", "Target Activity goal (defaults to the first Activity goal on the plan)")
    .requiredOption("--destination <place>", "Destination name (city or region)")
    .requiredOption("--date <date>", "Travel date (YYYY-MM-DD)")
    .option("--query <text>", "Free text search (e.g. 'snorkeling')")
    .option("--currency <code>", "Currency code", "USD")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--replace", "Replace existing activity items for this destination (removes old selections)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--verbose", "Show request details sent to the API")
    .action(async (opts) => {
      try {
        validateDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");

        const tripPlanId = resolvePlanId(opts);
        const dryRun = !!opts.dryRun;

        if (!dryRun && !opts.json && !opts.agent) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        if (!dryRun && travellerIds.length === 0) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT`);
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

        if (!dryRun && !opts.json && !opts.agent) process.stderr.write(chalk.dim("Searching activities...\n"));
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
                flow: "goal/mirror-list (VOY-1414)",
                steps: [
                  `resolve Activity goal (--goal or first Activity goal) + its ActivityList mirror`,
                  `set date -> ${opts.date}`,
                  `createTripPlanActivitySelection({ goalId, mirrorListSelectionId, travellerIds })`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        const goals = await loadGoals(tripPlanId);
        const goal = resolveGoal(goals, "activities", opts.goal);
        const mirrorListSelectionId = resolveMirrorList(goal, "activities");
        const dateSel = requireDateSelection(goals);
        // --destination applies to the plan-level Destination selection (Activity
        // goals inherit destination via bindings; no per-Activity location input).
        if (opts.destination) await setDestination(goals, opts.destination);
        await addDateOption(dateSel, opts.date);

        const data = await graphql<{ createTripPlanActivitySelection: SelectionResult }>(
          CREATE_ACTIVITY_SELECTION,
          {
            tripPlanId,
            input: { goalId: goal.id, mirrorListSelectionId, travellerIds, title: titleParts.join(" — ") },
          },
        );

        const result = data.createTripPlanActivitySelection;
        const sortBy = (opts.sort ?? "default") as SortField;
        const options = sortBy === "price"
          ? [...result.options].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          : result.options.sort((a, b) => a.sortOrder - b.sortOrder);

        const searchResults = options.map((opt, i) => ({
          index: i + 1,
          optionId: opt.id,
          summary: buildActivitySummary(opt),
        }));

        saveSearchState({
          type: "activities",
          tripPlanId: result.item.tripPlanId,
          selectionId: result.selection.id,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            tripPlanId: result.item.tripPlanId,
            selectionId: result.selection.id,
            options: options.map((opt, i) => ({ index: i + 1, ...opt })),
            url: `${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${result.item.tripPlanId}`;
          const lines: string[] = [];
          lines.push(`### Activities (${opts.destination})`);
          if (options.length === 0) {
            lines.push("_No activities found for this destination and date._");
          } else {
            lines.push(agentActivityOptions(options));
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
        await printPlanFooter(result.item.tripPlanId);
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
