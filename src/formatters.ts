import chalk from "chalk";
import { formatPrice } from "./utils.js";
import { hotelStayLabel, deriveHotelFacts } from "./hotel-format.js";
import { deriveFlightDetail, flightRouteLabel } from "./flight-format.js";

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

export function formatFlights(options: FlightOption[], overrideRoute?: { origin: string; destination: string }): string {
  return options
    .map((opt, i) => {
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
      // Suppress the legacy time line when leg detail already carries times —
      // otherwise the two can disagree (leg data wins as the richer source).
      const time = opt.time && !detail?.departureTime ? chalk.dim(opt.time) : "";

      const parts = [airline, route].filter(Boolean);
      const details = [price, duration].filter(Boolean).join("  ·  ");

      let line = `  ✈️  ${idx}  ${parts.join("  ")}`;
      if (details) line += `  ·  ${details}`;
      if (time) line += `\n       ${time}`;
      return line;
    })
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
