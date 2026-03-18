import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl, getHomeAirports } from "../config.js";
import {
  GET_TRIP_PLAN_BASIC,
  CREATE_TRIP_PLAN_BASIC,
  CREATE_TRAVELLER_BRIEF,
  GET_TRAVELLERS_BRIEF,
  CREATE_FLIGHT_SELECTION,
  CREATE_HOTEL_SELECTION,
  SELECT_DEPARTURE_FLIGHT,
  SELECT_RETURN_FLIGHT,
  SET_TRIP_PLAN_SELECTED_OPTION,
  GET_PLAN_DEEP,
  SET_SUB_SELECTION,
} from "../queries.js";
import { validateDate, warnPastDate, validateIata, extractFlightToken, buildFlightSummary, buildHotelSummary, deriveBaseUrl, formatPrice, formatDateRange } from "../utils.js";
import { progress, warn, fatal, jsonOutput, jsonOutputWithPlan } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { agentFlightOptions, agentHotelOptions } from "../agent-output.js";
import { searchAirports } from "../data/airports.js";
import { findMetroArea } from "../data/metro-areas.js";

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


function resolvePlanAirport(value: string, flagName: string, quiet: boolean): string {
  if (/^[A-Za-z]{3}$/.test(value.trim())) {
    return value.toUpperCase();
  }
  // Check metro areas first
  const metro = findMetroArea(value);
  if (metro) {
    if (!quiet && metro.airports.length > 1) {
      progress(`${metro.name} airports: ${metro.airports.join(", ")}. Using ${metro.airports[0]} (primary) for ${flagName}`);
    } else if (!quiet) {
      progress(`Using ${metro.airports[0]} (${metro.name}) for ${flagName}`);
    }
    return metro.airports[0];
  }
  const matches = searchAirports(value);
  if (matches.length === 0) {
    fatal(`No airports found for ${flagName}: "${value}". Use a 3-letter IATA code or run: voyagier search airports "${value}"`);
  }
  if (matches.length === 1) {
    if (!quiet) {
      progress(`Using ${matches[0].code} (${matches[0].name}) for ${flagName}`);
    }
    return matches[0].code;
  }
  const codes = matches.slice(0, 10).map((m) => m.code).join(", ");
  fatal(`Multiple airports found for ${flagName}: "${value}". Specify a code: ${codes}`);
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
    .description("Create a full trip plan: plan + travellers + flights + hotels in one command")
    .addHelpText("after", `
Examples:
  # Book a round-trip flight + hotel (two commands total):
  voyagier plan-trip --title "Paris Trip" --from DCA --to Paris \\
    --depart 2026-03-23 --return 2026-03-25 --hotel Paris \\
    --travellers "John Doe" --auto-select navigator --json
  voyagier book <PLAN_ID> --json

  # One-way, cheapest option:
  voyagier plan-trip --title "London" --from JFK --to London \\
    --depart 2026-04-10 --travellers "Jane Smith" --auto-select cheapest --json

  Full agent reference: voyagier agent-docs
`)
    .option("--plan <id>", "Add to an existing trip plan instead of creating a new one")
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
          if (!json && !agent) progress("Creating trip plan...");
          const planInput: Record<string, unknown> = { title: opts.title };
          if (opts.depart) planInput.startDate = opts.depart;
          const endDate = opts.return ?? opts.checkout;
          if (endDate) planInput.endDate = endDate;

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

        // Step 3: Search flights (if --to and --depart)
        let flightResult: null | {
          selectionId: string;
          isRoundTrip: boolean;
          optionCount: number;
          options: Array<{ id: string; flightToken?: string; summary: string; price?: number; duration?: string; airline?: string }>;
        } = null;

        let allFlightOptions: SelectOption[] = [];
        let origin: string | null = null;
        let destination: string | null = null;

        if (opts.to && opts.depart) {
          // Resolve destination
          destination = resolvePlanAirport(opts.to, "--to", json || agent);
          // Resolve origin
          if (opts.from) {
            origin = resolvePlanAirport(opts.from, "--from", json || agent);
          } else {
            const homeAirports = getHomeAirports();
            if (homeAirports.length > 0) {
              origin = homeAirports[0].toUpperCase();
              if (!json && !agent) progress(`Using home airport: ${origin}`);
            } else {
              fatal("No origin specified and no home airport configured. Use --from <code> or run: voyagier auth setup");
            }
          }
          const isRoundTrip = !!opts.return;

          if (!json && !agent) progress(`Searching flights (${origin} → ${destination})...`);

          const flightInput: Record<string, unknown> = {
            origin,
            destination,
            departureDate: opts.depart,
            travellerIds,
            title: `Flight: ${origin} → ${destination}`,
          };
          if (opts.return) flightInput.returnDate = opts.return;

          const fData = await graphql<{ createTripPlanFlightSelection: SelectionResult }>(
            CREATE_FLIGHT_SELECTION,
            { tripPlanId: plan.id, input: flightInput }
          );

          const fResult = fData.createTripPlanFlightSelection;
          // Keep all options (by API sort order) for strategy ranking
          const byApiOrder = [...fResult.options].sort((a, b) => a.sortOrder - b.sortOrder);
          allFlightOptions = byApiOrder;

          const sorted = sortOptions(byApiOrder, sortBy).slice(0, maxResults);

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
        let allHotelOptions: Array<{ id: string; name: string; price?: number }> = [];

        if (opts.hotel) {
          const checkin = opts.checkin ?? opts.depart;
          const checkout = opts.checkout ?? opts.return ?? (opts.depart
            ? (() => {
                const [y, m, d2] = opts.depart.split("-").map(Number);
                const utc = new Date(Date.UTC(y, m - 1, d2 + 1));
                return utc.toISOString().slice(0, 10);
              })()
            : undefined);

          if (!checkin || !checkout) {
            warn("--hotel requires --checkin and --checkout (or --depart/--return). Skipping hotel search.");
          } else {
            if (!json && !agent) progress(`Searching hotels (${opts.hotel})...`);

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
              CREATE_HOTEL_SELECTION,
              { tripPlanId: plan.id, input: hotelInput }
            );

            const hResult = hData.createTripPlanHotelSelection;
            // Keep all hotel options for auto-select (always sorted by price)
            allHotelOptions = [...hResult.options];

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

        // Step 5: Auto-select (if --auto-select)
        let autoSelectResult: AutoSelectResult | null = null;
        let alternatives: Alternative[] = [];

        if (opts.autoSelect) {
          const strategy = opts.autoSelect as AutoSelectStrategy;

          try {
            // Auto-select flights
            if (flightResult && allFlightOptions.length > 0) {
              const strategyRanked = applyStrategy(allFlightOptions, strategy);
              const topFlight = strategyRanked[0];

              if (flightResult.isRoundTrip) {
                const topToken = extractFlightToken(topFlight.bookingData);
                if (!topToken) throw new Error("No flight token found for top-ranked departure flight.");

                if (!json && !agent) progress("Auto-selecting departure flight...");
                const depData = await graphql<{ selectDepartureFlight: { id: string; options: RawFlightOption[] } }>(
                  SELECT_DEPARTURE_FLIGHT,
                  { selectionId: flightResult.selectionId, flightToken: topToken }
                );

                const returnRaw = depData.selectDepartureFlight.options;
                const returnSelectOpts: SelectOption[] = returnRaw.map((o, i) => ({
                  id: o.id,
                  name: o.name,
                  price: o.price,
                  time: o.time,
                  airline: o.airline,
                  duration: o.duration,
                  bookingData: o.bookingData,
                  sortOrder: i,
                }));

                const returnRanked = applyStrategy(returnSelectOpts, strategy);
                const topReturn = returnRanked[0];
                const returnToken = extractFlightToken(topReturn.bookingData);
                if (!returnToken) throw new Error("No flight token found for top-ranked return flight.");

                if (!json && !agent) progress("Auto-selecting return flight...");
                const retData = await graphql<{ selectReturnFlight: { id: string; options: RawFlightOption[] } }>(
                  SELECT_RETURN_FLIGHT,
                  { selectionId: flightResult.selectionId, flightToken: returnToken }
                );

                const finalOptions = retData.selectReturnFlight.options;
                if (finalOptions.length > 0) {
                  await graphql<{ setTripPlanSelectedOption: unknown }>(
                    SET_TRIP_PLAN_SELECTED_OPTION,
                    { selectionId: flightResult.selectionId, optionId: finalOptions[0].id }
                  );
                }

                autoSelectResult = {
                  departure: {
                    summary: buildFlightSummary(topFlight, origin!, destination!),
                    airline: topFlight.airline,
                    duration: topFlight.duration,
                    price: topFlight.price,
                  },
                  returnFlight: {
                    summary: buildFlightSummary(topReturn, destination!, origin!),
                    airline: topReturn.airline,
                    duration: topReturn.duration,
                    price: topReturn.price,
                  },
                  strategy,
                  rank: 1,
                  rankReason: getRankReason(strategy),
                };

                alternatives = strategyRanked.slice(1, 4).map((opt, i) => ({
                  rank: i + 2,
                  summary: buildFlightSummary(opt, origin!, destination!),
                  price: opt.price,
                  reason: generateAlternativeReason(opt, topFlight),
                }));

              } else {
                // One-way flight
                if (!json && !agent) progress("Auto-selecting flight...");
                await graphql<{ setTripPlanSelectedOption: unknown }>(
                  SET_TRIP_PLAN_SELECTED_OPTION,
                  { selectionId: flightResult.selectionId, optionId: topFlight.id }
                );

                autoSelectResult = {
                  departure: {
                    summary: buildFlightSummary(topFlight, origin!, destination!),
                    airline: topFlight.airline,
                    duration: topFlight.duration,
                    price: topFlight.price,
                  },
                  strategy,
                  rank: 1,
                  rankReason: getRankReason(strategy),
                };

                alternatives = strategyRanked.slice(1, 4).map((opt, i) => ({
                  rank: i + 2,
                  summary: buildFlightSummary(opt, origin!, destination!),
                  price: opt.price,
                  reason: generateAlternativeReason(opt, topFlight),
                }));
              }
            }

            // Auto-select hotel (cheapest regardless of strategy)
            if (hotelResult && allHotelOptions.length > 0) {
              const cheapest = [...allHotelOptions].sort(
                (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)
              )[0];

              if (!json && !agent) progress("Auto-selecting hotel...");
              await graphql<{ setTripPlanSelectedOption: unknown }>(
                SET_TRIP_PLAN_SELECTED_OPTION,
                { selectionId: hotelResult.selectionId, optionId: cheapest.id }
              );

              if (!autoSelectResult) {
                autoSelectResult = { strategy, rank: 1, rankReason: getRankReason(strategy) };
              }
              autoSelectResult.hotel = { name: cheapest.name, price: cheapest.price, perNight: true };
            }

            // Auto-pick sub-selections (cabin class, room type) — pick cheapest
            if (autoSelectResult) {
              try {
                if (!json && !agent) progress("Auto-selecting sub-options...");
                const deepData = await graphql<{
                  tripPlan: {
                    id: string;
                    title: string;
                    items: Array<{
                      id: string;
                      title: string;
                      selection?: {
                        id: string;
                        isLocked: boolean;
                        selectedOption?: {
                          id: string;
                          name: string;
                          price?: number;
                          status: string;
                          subSelections?: Array<{
                            id: string;
                            type: string;
                            selectedOptionId?: string;
                            options: Array<{
                              id: string;
                              name: string;
                              price?: number;
                              sortOrder: number;
                            }>;
                          }>;
                        };
                      };
                    }>;
                  };
                }>(GET_PLAN_DEEP, { id: plan.id });

                for (const item of deepData.tripPlan.items) {
                  if (!item.selection?.selectedOption?.subSelections) continue;
                  if (item.selection.isLocked) continue;

                  for (const sub of item.selection.selectedOption.subSelections) {
                    if (sub.options.length === 0) continue;
                    const cheapestOpt = [...sub.options].sort(
                      (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)
                    )[0];

                    try {
                      const subResult = await graphql<{
                        setTripPlanSubSelectionOption: {
                          id: string;
                          selectedOptionId: string;
                          selectedOption: { id: string; name: string; price?: number };
                        };
                      }>(SET_SUB_SELECTION, {
                        subSelectionId: sub.id,
                        optionId: cheapestOpt.id,
                      });
                      const picked = subResult.setTripPlanSubSelectionOption.selectedOption;
                      if (sub.type === "FLIGHT_CLASS") {
                        autoSelectResult.cabin = { name: picked.name, price: picked.price };
                      }
                    } catch (subErr) {
                      const msg = subErr instanceof Error ? subErr.message : String(subErr);
                      warn(`Could not auto-pick ${sub.type}: ${msg}`);
                    }
                  }
                }
              } catch (deepErr) {
                const msg = deepErr instanceof Error ? deepErr.message : String(deepErr);
                warn(`Could not fetch sub-selections: ${msg}`);
              }
            }

          } catch (autoErr) {
            const msg = autoErr instanceof Error ? autoErr.message : String(autoErr);
            if (autoSelectResult) {
              autoSelectResult.error = `Auto-select partially failed: ${msg}`;
            } else {
              autoSelectResult = { strategy, rank: 0, rankReason: "", error: `Auto-select failed: ${msg}` };
              if (!json && !agent) warn(`Auto-select failed: ${msg}`);
            }
          }
        }

        // Build next-step commands (used in non-auto-select paths)
        const nextSteps: Record<string, string> = {};
        if (!opts.autoSelect) {
          if (flightResult) {
            const firstFlight = flightResult.options[0];
            if (firstFlight?.flightToken) {
              nextSteps.selectFlight = `voyagier select --selection-id ${flightResult.selectionId} --flight-token ${firstFlight.flightToken} --phase departure`;
            } else if (firstFlight) {
              nextSteps.selectFlight = `voyagier select --selection-id ${flightResult.selectionId} --option-id ${firstFlight.id}`;
            }
          }
          if (hotelResult) {
            const firstHotel = hotelResult.options[0];
            if (firstHotel) {
              nextSteps.selectHotel = `voyagier select --selection-id ${hotelResult.selectionId} --option-id ${firstHotel.id}`;
            }
          }
        }
        nextSteps.viewPlan = `voyagier plans get ${plan.id}`;

        // JSON output
        if (json) {
          if (opts.autoSelect && autoSelectResult) {
            jsonOutputWithPlan({
              plan: { id: plan.id, title: plan.title, url: `${baseUrl}/plans/${plan.id}` },
              travellers: travellers.map(t => ({ id: t.id, firstName: t.firstName, lastName: t.lastName })),
              selected: {
                ...(autoSelectResult.departure ? { departure: autoSelectResult.departure } : {}),
                ...(autoSelectResult.returnFlight ? { return: autoSelectResult.returnFlight } : {}),
                ...(autoSelectResult.cabin ? { cabin: autoSelectResult.cabin } : {}),
                ...(autoSelectResult.hotel ? { hotel: autoSelectResult.hotel } : {}),
                strategy: autoSelectResult.strategy,
                rank: autoSelectResult.rank,
                rankReason: autoSelectResult.rankReason,
                ...(autoSelectResult.error ? { error: autoSelectResult.error } : {}),
              },
              alternatives,
              cart: { command: `voyagier cart ${plan.id}` },
              nextSteps: {
                review: `voyagier cart ${plan.id} --json`,
                book: `voyagier book ${plan.id} --json`,
                bookDryRun: `voyagier book ${plan.id} --dry-run --json`,
              },
            }, plan.id, plan.title);
          } else {
            jsonOutputWithPlan({
              plan: { id: plan.id, title: plan.title, url: `${baseUrl}/plans/${plan.id}` },
              travellers: travellers.map(t => ({ id: t.id, firstName: t.firstName, lastName: t.lastName })),
              flights: flightResult,
              hotels: hotelResult,
              nextSteps,
            }, plan.id, plan.title);
          }
          return;
        }

        // Agent output
        if (agent) {
          const planUrl = `${baseUrl}/plans/${plan.id}`;
          const dateStr = formatDateRange(plan.startDate, plan.endDate);
          const lines: string[] = [];
          lines.push(`## ✈️ ${plan.title}`);
          const subParts: string[] = [];
          if (dateStr) subParts.push(`**${dateStr}**`);
          if (travellers.length > 0) subParts.push(`${travellers.length} traveller${travellers.length !== 1 ? "s" : ""}`);
          if (subParts.length > 0) lines.push(subParts.join(" · "));
          lines.push("");

          if (opts.autoSelect && autoSelectResult) {
            lines.push(`${strategyTitle(autoSelectResult.strategy as AutoSelectStrategy)}:`);
            lines.push("");
            if (autoSelectResult.departure) {
              lines.push(`**Departure:** ${autoSelectResult.departure.summary}`);
            }
            if (autoSelectResult.returnFlight) {
              lines.push(`**Return:** ${autoSelectResult.returnFlight.summary}`);
            }
            if (autoSelectResult.cabin) {
              const cabinPrice = autoSelectResult.cabin.price != null ? ` · ${formatPrice(autoSelectResult.cabin.price)}` : "";
              lines.push(`**Cabin:** ${autoSelectResult.cabin.name}${cabinPrice}`);
            }
            if (autoSelectResult.hotel) {
              const hotelPrice = autoSelectResult.hotel.price != null ? ` · ${formatPrice(autoSelectResult.hotel.price)}/night` : "";
              lines.push(`**Hotel:** ${autoSelectResult.hotel.name}${hotelPrice}`);
            }
            if (autoSelectResult.error) {
              lines.push("");
              lines.push(`⚠ ${autoSelectResult.error}`);
            }
            if (alternatives.length > 0) {
              lines.push("");
              lines.push("**Also considered:**");
              for (const alt of alternatives) {
                const price = alt.price != null ? ` · ${formatPrice(alt.price)}` : "";
                lines.push(`${alt.rank}. ${alt.summary}${price} — ${alt.reason}`);
              }
            }
            lines.push("");
            lines.push(`👉 **View & edit:** ${planUrl}`);
            lines.push("");
            lines.push("**Next steps:**");
            lines.push(`- Review cart: \`voyagier cart ${plan.id} --json\``);
            lines.push(`- Book: \`voyagier book ${plan.id} --json\``);
            lines.push(`- Dry run: \`voyagier book ${plan.id} --dry-run --json\``);
          } else {
            if (flightResult && origin && destination) {
              lines.push(`### Flights (${origin} → ${destination})`);
              lines.push(agentFlightOptions(flightResult.options));
              lines.push("");
            }

            if (hotelResult && opts.hotel) {
              lines.push(`### Hotels (${opts.hotel})`);
              lines.push(agentHotelOptions(hotelResult.options));
              lines.push("");
            }

            if (travellers.length > 0) {
              lines.push(`👤 ${travellers.map(t => `${t.firstName} ${t.lastName}`).join(", ")}`);
              lines.push("");
            }

            lines.push(`👉 **View & edit:** ${planUrl}`);

            const steps: string[] = [];
            if (nextSteps.selectFlight) steps.push(`- Select flight: \`${nextSteps.selectFlight}\``);
            if (nextSteps.selectHotel) steps.push(`- Select hotel: \`${nextSteps.selectHotel}\``);
            if (steps.length > 0) {
              lines.push("");
              lines.push("**Next steps:**");
              lines.push(...steps);
            }
          }

          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        // Human output
        const dateStr = formatDateRange(plan.startDate, plan.endDate);
        const planVerb = opts.plan ? "Using" : "Created";
        console.log(chalk.green(`\n✓ ${planVerb}: ${plan.title}${dateStr ? ` (${dateStr})` : ""}`));
        if (travellers.length > 0) {
          console.log(`  ${travellers.length} traveller${travellers.length !== 1 ? "s" : ""} added`);
        }

        if (opts.autoSelect && autoSelectResult) {
          const title = strategyTitle(autoSelectResult.strategy as AutoSelectStrategy);
          console.log(chalk.bold(`\n${title}:\n`));

          if (autoSelectResult.departure) {
            console.log(`  ✈️  Departure: ${autoSelectResult.departure.summary}`);
          }
          if (autoSelectResult.returnFlight) {
            console.log(`  ✈️  Return:    ${autoSelectResult.returnFlight.summary}`);
          }
          if (autoSelectResult.cabin) {
            const price = autoSelectResult.cabin.price != null ? ` · ${formatPrice(autoSelectResult.cabin.price)}` : "";
            console.log(`  💺 Cabin:     ${autoSelectResult.cabin.name}${price}`);
          }
          if (autoSelectResult.hotel) {
            const price = autoSelectResult.hotel.price != null ? ` · ${formatPrice(autoSelectResult.hotel.price)}/night` : "";
            console.log(`  🏨 Hotel:     ${autoSelectResult.hotel.name}${price}`);
          }

          if (autoSelectResult.error) {
            console.log(chalk.yellow(`\n  ⚠ ${autoSelectResult.error}`));
          }

          if (alternatives.length > 0) {
            console.log(chalk.dim("\n  Also considered:"));
            for (const alt of alternatives) {
              const price = alt.price != null ? ` · ${formatPrice(alt.price)}` : "";
              console.log(chalk.dim(`  [${alt.rank}] ${alt.summary}${price} — ${alt.reason}`));
            }
          }

          console.log(chalk.bold("\n  Next:"));
          console.log(`  ${chalk.cyan(`voyagier cart ${plan.id}`)}`);
          console.log(`  ${chalk.cyan(`voyagier book ${plan.id}`)}`);
          console.log();
          return;
        }

        if (flightResult) {
          console.log(chalk.bold(`\n✈️  Top ${flightResult.options.length} flight${flightResult.options.length !== 1 ? "s" : ""} (${origin} → ${destination}, sorted by ${sortBy}):`));
          flightResult.options.forEach((opt, i) => {
            console.log(`  [${i + 1}]  ${opt.summary}`);
          });
          if (flightResult.optionCount > flightResult.options.length) {
            console.log(chalk.dim(`  ... and ${flightResult.optionCount - flightResult.options.length} more`));
          }
        }

        if (hotelResult) {
          console.log(chalk.bold(`\n🏨  Top ${hotelResult.options.length} hotel${hotelResult.options.length !== 1 ? "s" : ""} (${opts.hotel}):`));
          hotelResult.options.forEach((opt, i) => {
            const price = opt.price != null ? chalk.green(`  ${formatPrice(opt.price)}/night`) : "";
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
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `plan-trip failed: ${message}`);
      }
    });
}
