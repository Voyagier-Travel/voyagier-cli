import chalk from "chalk";
import { formatPrice } from "./utils.js";
import { hotelStayLabel, deriveHotelFacts } from "./hotel-format.js";
import { deriveFlightDetail, flightRouteLabel, extractRankScore, rankScoreLabel, analyzeFlightDuplicates, collapsedAlternatesLabel } from "./flight-format.js";
import type { FlightDupRole } from "./flight-format.js";

interface FlightOption {
  id?: string;
  name: string;
  price?: number;
  time?: string;
  airline?: string;
  duration?: string;
  bookingData?: Record<string, unknown>;
}

interface HotelOption {
  id?: string;
  name: string;
  price?: number;
  time?: string;
  duration?: string;
  bookingData?: Record<string, unknown>;
}

interface ActivityOption {
  id?: string;
  name: string;
  price?: number;
  time?: string;
  duration?: string;
  bookingData?: Record<string, unknown>;
}

function extractRoute(opt: FlightOption): string {
  // Try to get origin→destination from bookingData.searchQuery
  if (opt.bookingData && typeof opt.bookingData === "object") {
    const sq = opt.bookingData.searchQuery;
    if (sq && typeof sq === "object" && !Array.isArray(sq)) {
      const query = sq as Record<string, unknown>;
      const origin = typeof query.origin === "string" ? query.origin : null;
      const destination = typeof query.destination === "string" ? query.destination : null;
      if (origin && destination) return `${origin} to ${destination}`;
    }
  }
  // Fallback to name
  return opt.name;
}

export function formatFlights(
  options: FlightOption[],
  overrideRoute?: { origin: string; destination: string },
  roles?: FlightDupRole[],
  markers?: Array<string | undefined>,
): string {
  // VOY-1877: fold/annotate display-identical rows. Roles are aligned to the
  // option order; when not supplied we derive them here so the human render
  // matches the JSON/agent surfaces (analyzeFlightDuplicates is deterministic).
  const dupRoles = roles ?? analyzeFlightDuplicates(options);
  return options
    .map((opt, i) => {
      const role = dupRoles[i] ?? {};
      // Collapsed duplicates are folded into their primary — omit the row. The
      // option keeps its number in saved state, so `select <n>` still resolves
      // it (it is identical to the shown primary anyway).
      if (role.collapsed) return null;
      const idx = chalk.bold.cyan(`[${i + 1}]`);
      // VOY-1783: prefer leg detail (flight number + timed route + stops); fall
      // back to airline + searchQuery route when the legs aren't in the payload.
      const detail = deriveFlightDetail(opt.bookingData);
      const lead = detail?.flightNumber ?? opt.airline;
      const airline = lead ? chalk.white(lead) : "";
      const detailRoute = detail ? flightRouteLabel(detail) : "";
      const route = chalk.white(detailRoute || (overrideRoute
        ? `${overrideRoute.origin} to ${overrideRoute.destination}`
        : extractRoute(opt)));
      const price = opt.price != null ? chalk.green(formatPrice(opt.price)) : "";
      const duration = opt.duration ? chalk.dim(opt.duration) : "";
      // Suppress the legacy time line when leg detail already carries a time
      // (either side) — otherwise the two can disagree (leg data wins).
      const hasLegTime = Boolean(detail?.departureTime || detail?.arrivalTime);
      const time = opt.time && !hasLegTime ? chalk.dim(opt.time) : "";

      const parts = [airline, route].filter(Boolean);
      const details = [price, duration].filter(Boolean).join("  ·  ");
      // VOY-1824: append the platform value score when present (display-only,
      // never a sort key). Absent → render nothing extra.
      const rank = extractRankScore(opt.bookingData);

      let line = `  ✈️  ${idx}  ${parts.join("  ")}`;
      if (details) line += `  ·  ${details}`;
      if (rank !== undefined) line += `  ·  ${chalk.dim(rankScoreLabel(rank))}`;
      // VOY-1877: annotate a distinguishable identical-schedule row with its
      // fare, or note the identical options folded into this primary.
      if (role.annotate) line += `  ·  ${chalk.dim(`fare: ${role.annotate}`)}`;
      if (role.collapsedAlternates?.length) {
        line += `  ·  ${chalk.dim(collapsedAlternatesLabel(role.collapsedAlternates))}`;
      }
      // VOY-1874: flag an option departing/arriving a nearby airport instead of
      // the explicitly requested code (only set in --nearby / all-nearby mode).
      const marker = markers?.[i];
      if (marker) line += `  ·  ${chalk.yellow(marker)}`;
      if (time) line += `\n       ${time}`;
      return line;
    })
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export function formatHotels(options: HotelOption[]): string {
  return options
    .map((opt, i) => {
      const idx = chalk.bold.cyan(`[${i + 1}]`);
      const name = chalk.white(opt.name);
      // VOY-1783: rating + salient amenities when present.
      const facts = deriveHotelFacts(opt.bookingData);
      // VOY-1724: minRate is the STAY TOTAL — "from $X total · N nights (~$Y/nt)".
      const label = hotelStayLabel(opt.price, opt.bookingData);

      let line = `  🏨  ${idx}  ${name}`;
      if (facts?.rating != null) line += `  ·  ${chalk.yellow(`⭐${facts.rating}`)}`;
      if (facts?.amenities.length) line += `  ·  ${chalk.dim(facts.amenities.join(", "))}`;
      if (label) line += `  ·  ${chalk.green(label)}`;
      return line;
    })
    .join("\n\n");
}

export function formatActivities(options: ActivityOption[]): string {
  return options
    .map((opt, i) => {
      const idx = chalk.bold.cyan(`[${i + 1}]`);
      const name = chalk.white(opt.name);
      const price = opt.price != null ? chalk.green(formatPrice(opt.price)) : "";
      const duration = opt.duration ? chalk.dim(opt.duration) : "";

      let line = `  🎯  ${idx}  ${name}`;
      const details = [price, duration].filter(Boolean).join("  ·  ");
      if (details) line += `  ·  ${details}`;
      return line;
    })
    .join("\n\n");
}
