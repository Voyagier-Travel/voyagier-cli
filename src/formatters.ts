import chalk from "chalk";
import { formatPrice } from "./utils.js";

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

export function formatFlights(options: FlightOption[]): string {
  return options
    .map((opt, i) => {
      const idx = chalk.bold.cyan(`[${i + 1}]`);
      const airline = opt.airline ? chalk.white(opt.airline) : "";
      const route = chalk.white(extractRoute(opt));
      const price = opt.price != null ? chalk.green(formatPrice(opt.price)) : "";
      const duration = opt.duration ? chalk.dim(opt.duration) : "";
      const time = opt.time ? chalk.dim(opt.time) : "";

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
      const price = opt.price != null ? chalk.green(`${formatPrice(opt.price)}/night`) : "";

      let line = `  🏨  ${idx}  ${name}`;
      if (price) line += `  ·  ${price}`;
      return line;
    })
    .join("\n\n");
}
