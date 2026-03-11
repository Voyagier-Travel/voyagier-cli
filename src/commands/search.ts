import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { saveSearchState, loadSearchState } from "../state.js";
import { formatFlights, formatHotels } from "../formatters.js";

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
  if (state?.tripPlanId) return state.tripPlanId;
  process.stderr.write(chalk.red("--plan <id> is required. Create one first:\n"));
  process.stderr.write(chalk.dim('  voyagier plans create --title "My Trip"\n'));
  process.exit(1);
}

function extractFlightToken(bookingData?: Record<string, unknown>): string | undefined {
  if (!bookingData) return undefined;
  const flights = bookingData.flights as Array<Record<string, unknown>> | undefined;
  if (flights?.[0]?.flightToken) return flights[0].flightToken as string;
  if (typeof bookingData.flightToken === "string") return bookingData.flightToken;
  if (typeof bookingData.priceToken === "string") return bookingData.priceToken;
  return undefined;
}

export function registerSearchCommands(program: Command): void {
  const search = program.command("search").description("Search flights and hotels");

  search
    .command("flights")
    .description("Search for flights")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .requiredOption("--from <code>", "Origin airport code (e.g., LAX)")
    .requiredOption("--to <code>", "Destination airport code (e.g., NRT)")
    .requiredOption("--date <date>", "Departure date (YYYY-MM-DD)")
    .option("--return <date>", "Return date (YYYY-MM-DD) for round-trip")
    .option("--max-stops <n>", "Maximum number of stops")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const tripPlanId = resolvePlanId(opts);
        if (!opts.json) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = await resolveTravellerIds(tripPlanId);
        if (travellerIds.length === 0) {
          process.stderr.write(chalk.red("No travellers on this plan. Add one first:\n"));
          process.stderr.write(chalk.dim(`  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT\n`));
          process.exit(1);
        }

        if (!opts.json) process.stderr.write(chalk.dim("Searching flights...\n"));

        const origin = opts.from.toUpperCase();
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
        if (opts.maxStops) input.maxStops = parseInt(opts.maxStops, 10);

        const data = await graphql<{ createTripPlanFlightSelection: SelectionResult }>(
          `mutation CreateFlightSelection($tripPlanId: String!, $input: CreateFlightSelectionInput!) {
            createTripPlanFlightSelection(tripPlanId: $tripPlanId, input: $input) {
              item { id title tripPlanId }
              selection { id }
              options { id name price time airline duration bookingData sortOrder }
            }
          }`,
          { tripPlanId, input }
        );

        const result = data.createTripPlanFlightSelection;
        const options = result.options.sort((a, b) => a.sortOrder - b.sortOrder);

        // Save state for select command
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
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            tripPlanId: result.item.tripPlanId,
            selectionId: result.selection.id,
            isRoundTrip,
            options: options.map((opt, i) => ({ index: i + 1, ...opt })),
            url: `https://voyagier.com/plans/${result.item.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        if (options.length === 0) {
          process.stderr.write(chalk.dim("No flights found for this route and date.\n"));
          return;
        }

        console.log(chalk.bold(`\n${options.length} flight option${options.length > 1 ? "s" : ""} found:\n`));
        console.log(formatFlights(options));
        console.log(chalk.dim(`\n  Plan: https://voyagier.com/plans/${result.item.tripPlanId}`));
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
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const tripPlanId = resolvePlanId(opts);
        if (!opts.json) process.stderr.write(chalk.dim("Resolving travellers...\n"));

        const travellerIds = await resolveTravellerIds(tripPlanId);
        if (travellerIds.length === 0) {
          process.stderr.write(chalk.red("No travellers on this plan. Add one first:\n"));
          process.stderr.write(chalk.dim(`  voyagier travellers add --plan ${tripPlanId} --first <name> --last <name> --type ADULT\n`));
          process.exit(1);
        }

        if (!opts.json) process.stderr.write(chalk.dim("Searching hotels...\n"));

        const adults = parseInt(opts.guests, 10);
        const input: Record<string, unknown> = {
          location: opts.location,
          checkInDate: opts.checkin,
          checkOutDate: opts.checkout,
          currency: opts.currency,
          travellerIds,
          guests: { adults },
          title: `Hotel: ${opts.location}`,
        };

        const data = await graphql<{ createTripPlanHotelSelection: SelectionResult }>(
          `mutation CreateHotelSelection($tripPlanId: String!, $input: CreateHotelSelectionInput!) {
            createTripPlanHotelSelection(tripPlanId: $tripPlanId, input: $input) {
              item { id title tripPlanId }
              selection { id }
              options { id name price time duration bookingData sortOrder }
            }
          }`,
          { tripPlanId, input }
        );

        const result = data.createTripPlanHotelSelection;
        const options = result.options.sort((a, b) => a.sortOrder - b.sortOrder);

        // Save state for select command
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
            url: `https://voyagier.com/plans/${result.item.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        if (options.length === 0) {
          process.stderr.write(chalk.dim("No hotels found for this location and dates.\n"));
          return;
        }

        console.log(chalk.bold(`\n${options.length} hotel option${options.length > 1 ? "s" : ""} found:\n`));
        console.log(formatHotels(options));
        console.log(chalk.dim(`\n  Plan: https://voyagier.com/plans/${result.item.tripPlanId}`));
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });
}

function buildFlightSummary(
  opt: { name: string; price?: number; airline?: string; duration?: string },
  origin: string,
  destination: string
): string {
  const parts = [`${origin}→${destination}`];
  if (opt.airline) parts.push(opt.airline);
  if (opt.price) parts.push(`$${opt.price}`);
  if (opt.duration) parts.push(opt.duration);
  return parts.join(" · ");
}

function buildHotelSummary(opt: { name: string; price?: number }): string {
  const parts = [opt.name];
  if (opt.price) parts.push(`$${opt.price}/night`);
  return parts.join(" · ");
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
