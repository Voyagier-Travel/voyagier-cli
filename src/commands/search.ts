import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl, getHomeAirports } from "../config.js";
import { saveSearchState, loadSearchState } from "../state.js";
import { formatFlights, formatHotels } from "../formatters.js";
import { extractFlightToken, buildFlightSummary, buildHotelSummary, validateDate, warnPastDate, validateIata, deriveBaseUrl, looksLikeAirportCode } from "../utils.js";

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
    `query Travellers($tripPlanId: String!) {
      tripPlanTravellers(tripPlanId: $tripPlanId) { id firstName lastName }
    }`,
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
  process.stderr.write(chalk.red("--plan <id> is required. Create one first:\n"));
  process.stderr.write(chalk.dim('  voyagier plans create --title "My Trip"\n'));
  process.exit(1);
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

export function registerSearchCommands(program: Command): void {
  const search = program.command("search").description("Search flights and hotels");

  search
    .command("flights")
    .description("Search for flights")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--from <code>", "Origin airport code (e.g., LAX)")
    .requiredOption("--to <code>", "Destination airport code (e.g., NRT)")
    .requiredOption("--date <date>", "Departure date (YYYY-MM-DD)")
    .option("--return <date>", "Return date (YYYY-MM-DD) for round-trip")
    .option("--max-stops <n>", "Maximum number of stops")
    .option("--sort <field>", "Sort by: price, duration, stops, default", "default")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL query without executing")
    .action(async (opts) => {
      try {
        // Resolve origin: explicit --from, or home airport default
        let origin: string;
        if (opts.from) {
          validateIata(opts.from, "--from");
          origin = opts.from.toUpperCase();
        } else {
          const homeAirports = getHomeAirports();
          if (homeAirports.length > 0) {
            origin = homeAirports[0].toUpperCase();
            validateIata(origin, "--from (home airport)");
            process.stderr.write(chalk.dim(`Using home airport: ${origin} (from profile)\n`));
          } else {
            process.stderr.write(chalk.red("No origin specified. Run: voyagier auth setup (or use --from <code>)\n"));
            process.exit(1);
          }
        }

        validateIata(opts.to, "--to");
        validateDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");
        if (opts.return) {
          validateDate(opts.return, "--return");
          warnPastDate(opts.return, "--return");
        }

        const tripPlanId = resolvePlanId(opts);
        const dryRun = !!opts.dryRun;

        if (!dryRun && !opts.json) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        if (!dryRun && travellerIds.length === 0) {
          process.stderr.write(chalk.red("No travellers on this plan. Add one first:\n"));
          process.stderr.write(chalk.dim(`  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT\n`));
          process.exit(1);
        }

        if (!dryRun && !opts.json) process.stderr.write(chalk.dim("Searching flights...\n"));
        const destination = opts.to.toUpperCase();
        const isRoundTrip = !!opts.return;

        const input: Record<string, unknown> = {
          origin,
          destination,
          departureDate: opts.date,
          travellerIds,
          title: `Flight: ${origin} → ${destination}`,
        };
        if (opts.return) input.returnDate = opts.return;
        if (opts.maxStops) {
          const maxStops = parseInt(opts.maxStops, 10);
          if (!Number.isFinite(maxStops) || maxStops < 0) {
            process.stderr.write(chalk.red("--max-stops must be a non-negative integer.\n"));
            process.exit(1);
          }
          input.maxStops = maxStops;
        }

        const query = `mutation CreateFlightSelection($tripPlanId: String!, $input: CreateFlightSelectionInput!) {
            createTripPlanFlightSelection(tripPlanId: $tripPlanId, input: $input) {
              item { id title tripPlanId }
              selection { id }
              options { id name price time airline duration bookingData sortOrder }
            }
          }`;

        const data = await graphql<{ createTripPlanFlightSelection: SelectionResult }>(
          query,
          { tripPlanId, input },
          { dryRun }
        );

        const result = data.createTripPlanFlightSelection;
        const sortBy = (opts.sort ?? "default") as SortField;
        const options = sortOptions(
          result.options.sort((a, b) => a.sortOrder - b.sortOrder),
          sortBy
        );

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

        if (options.length === 0) {
          process.stderr.write(chalk.dim("No flights found for this route and date.\n"));
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
    .requiredOption("--location <place>", "Destination (city name)")
    .requiredOption("--checkin <date>", "Check-in date (YYYY-MM-DD)")
    .requiredOption("--checkout <date>", "Check-out date (YYYY-MM-DD)")
    .option("--currency <code>", "Currency code", "USD")
    .option("--guests <n>", "Number of adult guests", "1")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--replace", "Replace existing hotel items for this location (removes old selections)")
    .option("--json", "Output raw JSON")
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

        if (!dryRun && !opts.json) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        if (!dryRun && travellerIds.length === 0) {
          process.stderr.write(chalk.red("No travellers on this plan. Add one first:\n"));
          process.stderr.write(chalk.dim(`  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT\n`));
          process.exit(1);
        }

        // Check for existing hotel items and handle --replace
        if (!dryRun && opts.replace) {
          try {
            const planData = await graphql<{ tripPlan: { items: Array<{ id: string; title: string }> } }>(
              `query GetPlan($id: String!) { tripPlan(id: $id) { items { id title } } }`,
              { id: tripPlanId }
            );
            const hotelItems = planData.tripPlan.items.filter(
              (item) => item.title.toLowerCase().includes("hotel")
            );
            if (hotelItems.length > 0) {
              for (const item of hotelItems) {
                await graphql<{ deleteTripPlanItem: boolean }>(
                  `mutation DeleteItem($id: String!) { deleteTripPlanItem(id: $id) }`,
                  { id: item.id }
                );
              }
              if (!opts.json) {
                process.stderr.write(chalk.dim(`Replaced ${hotelItems.length} existing hotel item${hotelItems.length > 1 ? "s" : ""}.\n`));
              }
            }
          } catch {
            // Non-fatal — continue with search even if cleanup fails
          }
        } else if (!dryRun) {
          // Warn if there are already hotel items (without --replace)
          try {
            const planData = await graphql<{ tripPlan: { items: Array<{ id: string; title: string }> } }>(
              `query GetPlan($id: String!) { tripPlan(id: $id) { items { id title } } }`,
              { id: tripPlanId }
            );
            const hotelItems = planData.tripPlan.items.filter(
              (item) => item.title.toLowerCase().includes("hotel")
            );
            if (hotelItems.length > 0 && !opts.json) {
              process.stderr.write(chalk.yellow(`⚠ This plan already has ${hotelItems.length} hotel item${hotelItems.length > 1 ? "s" : ""}. Use --replace to remove them first.\n`));
            }
          } catch {
            // Non-fatal
          }
        }

        if (!dryRun && !opts.json) process.stderr.write(chalk.dim("Searching hotels...\n"));
        if (!dryRun && opts.verbose) {
          process.stderr.write(chalk.dim(`API request — location: "${opts.location}", check-in: ${opts.checkin}, check-out: ${opts.checkout}\n`));
        }

        const adults = parseInt(opts.guests, 10);
        if (!Number.isFinite(adults) || adults < 1) {
          process.stderr.write(chalk.red("--guests must be an integer ≥ 1.\n"));
          process.exit(1);
        }
        const input: Record<string, unknown> = {
          location: opts.location,
          checkInDate: opts.checkin,
          checkOutDate: opts.checkout,
          currency: opts.currency,
          travellerIds,
          guests: { adults },
          title: `Hotel: ${opts.location}`,
        };

        const query = `mutation CreateHotelSelection($tripPlanId: String!, $input: CreateHotelSelectionInput!) {
            createTripPlanHotelSelection(tripPlanId: $tripPlanId, input: $input) {
              item { id title tripPlanId }
              selection { id }
              options { id name price time duration bookingData sortOrder }
            }
          }`;

        const data = await graphql<{ createTripPlanHotelSelection: SelectionResult }>(
          query,
          { tripPlanId, input },
          { dryRun }
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

        if (options.length === 0) {
          const loc = opts.location as string;
          process.stderr.write(chalk.yellow(`No hotels found for "${loc}" on these dates.\n\n`));
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
}





function handleSearchError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("401") || message.includes("Unauthorized")) {
    process.stderr.write(chalk.red("Authentication failed. Run: voyagier auth setup\n"));
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    process.stderr.write(chalk.red("Could not connect to API. Run: voyagier auth status\n"));
  } else {
    process.stderr.write(chalk.red(`Search error: ${message}\n`));
  }
  process.exit(1);
}
