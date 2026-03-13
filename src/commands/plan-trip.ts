import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl, getHomeAirports } from "../config.js";
import { validateDate, warnPastDate, validateIata, extractFlightToken, buildFlightSummary, buildHotelSummary, deriveBaseUrl, formatPrice } from "../utils.js";
import { progress, warn, fatal, jsonOutput } from "../output.js";

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

type SortField = "price" | "duration" | "stops";

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
  return [...options].sort((a, b) => {
    switch (sortBy) {
      case "price":
        return (a.price ?? Infinity) - (b.price ?? Infinity);
      case "duration":
        return parseDurationMinutes(a.duration) - parseDurationMinutes(b.duration);
      case "stops":
        return parseStops(a.bookingData) - parseStops(b.bookingData);
    }
  });
}

function formatDateDisplay(start?: string, end?: string): string {
  if (!start) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [sy, sm, sd] = start.split("-").map(Number);
  if (!end) return `${months[sm - 1]} ${sd}, ${sy}`;
  const [ey, em, ed] = end.split("-").map(Number);
  if (sy === ey && sm === em) return `${months[sm - 1]} ${sd}-${ed}, ${sy}`;
  return `${months[sm - 1]} ${sd} – ${months[em - 1]} ${ed}, ${ey}`;
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
    .description("Create a full trip plan: plan + travellers + flights + hotels in one command")
    .requiredOption("--title <title>", "Trip plan title")
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
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const json = !!opts.json;

      try {
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
        if (opts.to) {
          validateIata(opts.to, "--to");
        }
        if (opts.from) {
          validateIata(opts.from, "--from");
        }

        const sortBy = (opts.sort ?? "price") as SortField;
        const maxResults = parseInt(opts.maxResults ?? "10", 10);
        const baseUrl = deriveBaseUrl(getApiUrl());

        // Step 1: Create plan
        if (!json) progress("Creating trip plan...");
        const planInput: Record<string, unknown> = { title: opts.title };
        if (opts.depart) planInput.startDate = opts.depart;
        const endDate = opts.return ?? opts.checkout;
        if (endDate) planInput.endDate = endDate;

        const planData = await graphql<{ createTripPlan: TripPlan }>(
          `mutation CreateTripPlan($input: CreateTripPlanInput!) {
            createTripPlan(input: $input) { id title startDate endDate }
          }`,
          { input: planInput }
        );
        const plan = planData.createTripPlan;

        // Step 2: Add travellers
        const travellers: Traveller[] = [];
        if (opts.travellers) {
          if (!json) progress("Adding travellers...");
          const parsed = parseTravellers(opts.travellers);
          for (const t of parsed) {
            const tData = await graphql<{ createTripPlanTraveller: Traveller }>(
              `mutation CreateTraveller($tripPlanId: String!, $input: CreateTravellerInput!) {
                createTripPlanTraveller(tripPlanId: $tripPlanId, input: $input) {
                  id firstName lastName
                }
              }`,
              { tripPlanId: plan.id, input: { firstName: t.firstName, lastName: t.lastName, declaredTravellerType: "Adult" } }
            );
            travellers.push(tData.createTripPlanTraveller);
          }
        }

        // Resolve traveller IDs (from newly added or existing)
        let travellerIds = travellers.map(t => t.id);
        if (travellerIds.length === 0) {
          // Fetch existing travellers
          const tData = await graphql<{ tripPlanTravellers: Traveller[] }>(
            `query Travellers($tripPlanId: String!) {
              tripPlanTravellers(tripPlanId: $tripPlanId) { id firstName lastName }
            }`,
            { tripPlanId: plan.id }
          );
          travellerIds = tData.tripPlanTravellers.map(t => t.id);
        }

        if (travellerIds.length === 0 && (opts.to || opts.hotel)) {
          warn("No travellers on plan — searches may fail without traveller IDs.");
        }

        // Step 3: Search flights (if --to and --depart)
        let flightResult: null | {
          selectionId: string;
          isRoundTrip: boolean;
          optionCount: number;
          options: Array<{ id: string; flightToken?: string; summary: string; price?: number; duration?: string; airline?: string }>;
        } = null;

        let origin: string | null = null;
        let destination: string | null = null;

        if (opts.to && opts.depart) {
          // Resolve origin
          if (opts.from) {
            origin = opts.from.toUpperCase();
          } else {
            const homeAirports = getHomeAirports();
            if (homeAirports.length > 0) {
              origin = homeAirports[0].toUpperCase();
              if (!json) progress(`Using home airport: ${origin}`);
            } else {
              fatal("No origin specified and no home airport configured. Use --from <code> or run: voyagier auth setup");
            }
          }
          destination = opts.to.toUpperCase();
          const isRoundTrip = !!opts.return;

          if (!json) progress(`Searching flights (${origin} → ${destination})...`);

          const flightInput: Record<string, unknown> = {
            origin,
            destination,
            departureDate: opts.depart,
            travellerIds,
            title: `Flight: ${origin} → ${destination}`,
          };
          if (opts.return) flightInput.returnDate = opts.return;

          const fData = await graphql<{ createTripPlanFlightSelection: SelectionResult }>(
            `mutation CreateFlightSelection($tripPlanId: String!, $input: CreateFlightSelectionInput!) {
              createTripPlanFlightSelection(tripPlanId: $tripPlanId, input: $input) {
                item { id title tripPlanId }
                selection { id }
                options { id name price time airline duration bookingData sortOrder }
              }
            }`,
            { tripPlanId: plan.id, input: flightInput }
          );

          const fResult = fData.createTripPlanFlightSelection;
          const sorted = sortOptions(
            fResult.options.sort((a, b) => a.sortOrder - b.sortOrder),
            sortBy
          ).slice(0, maxResults);

          flightResult = {
            selectionId: fResult.selection.id,
            isRoundTrip,
            optionCount: fResult.options.length,
            options: sorted.map(opt => ({
              id: opt.id,
              flightToken: extractFlightToken(opt.bookingData),
              summary: buildFlightSummary(opt, origin!, destination!),
              price: opt.price,
              duration: opt.duration,
              airline: opt.airline,
            })),
          };
        }

        // Step 4: Search hotels (if --hotel)
        let hotelResult: null | {
          selectionId: string;
          optionCount: number;
          options: Array<{ id: string; name: string; price?: number; summary: string }>;
        } = null;

        if (opts.hotel) {
          const checkin = opts.checkin ?? opts.depart;
          const checkout = opts.checkout ?? opts.return ?? (opts.depart
            ? (() => {
                const d = new Date(opts.depart + "T00:00:00");
                d.setDate(d.getDate() + 1);
                return d.toISOString().slice(0, 10);
              })()
            : undefined);

          if (!checkin || !checkout) {
            warn("--hotel requires --checkin and --checkout (or --depart/--return). Skipping hotel search.");
          } else {
            if (!json) progress(`Searching hotels (${opts.hotel})...`);

            const adults = opts.guests ? parseInt(opts.guests, 10) : Math.max(1, travellerIds.length);
            const hotelInput: Record<string, unknown> = {
              location: opts.hotel,
              checkInDate: checkin,
              checkOutDate: checkout,
              currency: "USD",
              travellerIds,
              guests: { adults },
              title: `Hotel: ${opts.hotel}`,
            };

            const hData = await graphql<{ createTripPlanHotelSelection: SelectionResult }>(
              `mutation CreateHotelSelection($tripPlanId: String!, $input: CreateHotelSelectionInput!) {
                createTripPlanHotelSelection(tripPlanId: $tripPlanId, input: $input) {
                  item { id title tripPlanId }
                  selection { id }
                  options { id name price time duration bookingData sortOrder }
                }
              }`,
              { tripPlanId: plan.id, input: hotelInput }
            );

            const hResult = hData.createTripPlanHotelSelection;
            const sortedHotels = (sortBy === "price"
              ? [...hResult.options].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
              : hResult.options.sort((a, b) => a.sortOrder - b.sortOrder)
            ).slice(0, maxResults);

            hotelResult = {
              selectionId: hResult.selection.id,
              optionCount: hResult.options.length,
              options: sortedHotels.map(opt => ({
                id: opt.id,
                name: opt.name,
                price: opt.price,
                summary: buildHotelSummary(opt),
              })),
            };
          }
        }

        // Build next-step commands
        const nextSteps: Record<string, string> = {};
        if (flightResult) {
          const firstFlight = flightResult.options[0];
          if (firstFlight?.flightToken) {
            nextSteps.selectFlight = `voyagier select --selection-id ${flightResult.selectionId} --flight-token ${firstFlight.flightToken} --phase departure`;
          }
        }
        if (hotelResult) {
          const firstHotel = hotelResult.options[0];
          if (firstHotel) {
            nextSteps.selectHotel = `voyagier select --selection-id ${hotelResult.selectionId} --option-id ${firstHotel.id}`;
          }
        }
        nextSteps.viewPlan = `voyagier plans get ${plan.id}`;

        // JSON output
        if (json) {
          jsonOutput({
            plan: { id: plan.id, title: plan.title, url: `${baseUrl}/plans/${plan.id}` },
            travellers: travellers.map(t => ({ id: t.id, firstName: t.firstName, lastName: t.lastName })),
            flights: flightResult,
            hotels: hotelResult,
            nextSteps,
          });
          return;
        }

        // Human output
        const dateStr = formatDateDisplay(plan.startDate, plan.endDate);
        console.log(chalk.green(`\n✓ Created: ${plan.title}${dateStr ? ` (${dateStr})` : ""}`));
        if (travellers.length > 0) {
          console.log(`  ${travellers.length} traveller${travellers.length !== 1 ? "s" : ""} added`);
        }

        if (flightResult) {
          console.log(chalk.bold(`\n✈️  Top ${flightResult.options.length} flight${flightResult.options.length !== 1 ? "s" : ""} (${origin} → ${destination}, sorted by ${sortBy}):`));
          flightResult.options.forEach((opt, i) => {
            const price = opt.price != null ? chalk.green(` $${opt.price}`) : "";
            const dur = opt.duration ? `  ${opt.duration}` : "";
            const airline = opt.airline ? `  ${opt.airline}` : "";
            console.log(`  [${i + 1}]${airline}${price}  ${opt.summary}${dur}`);
          });
          if (flightResult.optionCount > flightResult.options.length) {
            console.log(chalk.dim(`  ... and ${flightResult.optionCount - flightResult.options.length} more`));
          }
        }

        if (hotelResult) {
          console.log(chalk.bold(`\n🏨  Top ${hotelResult.options.length} hotel${hotelResult.options.length !== 1 ? "s" : ""} (${opts.hotel}):`));
          hotelResult.options.forEach((opt, i) => {
            const price = opt.price != null ? chalk.green(`  $${formatPrice(opt.price)}/night`) : "";
            console.log(`  [${i + 1}] ${opt.name}${price}`);
          });
          if (hotelResult.optionCount > hotelResult.options.length) {
            console.log(chalk.dim(`  ... and ${hotelResult.optionCount - hotelResult.options.length} more`));
          }
        }

        if (Object.keys(nextSteps).length > 1) {
          console.log(chalk.bold("\nNext:"));
          if (nextSteps.selectFlight) console.log(`  ${chalk.cyan(nextSteps.selectFlight)}`);
          if (nextSteps.selectHotel) console.log(`  ${chalk.cyan(nextSteps.selectHotel)}`);
          console.log(chalk.dim(`  Full plan: ${baseUrl}/plans/${plan.id}`));
        } else {
          console.log(chalk.dim(`\n  Plan: ${baseUrl}/plans/${plan.id}`));
        }
        console.log();

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (json) {
          process.stdout.write(JSON.stringify({ error: true, message }, null, 2) + "\n");
          process.exit(1);
        } else {
          process.stderr.write(chalk.red(`plan-trip failed: ${message}\n`));
          process.exit(1);
        }
      }
    });
}
