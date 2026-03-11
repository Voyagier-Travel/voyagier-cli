import chalk from "chalk";

/**
 * Extract a flight token from a booking data JSONB blob.
 * Checks multiple paths since Sabre data structure varies.
 */
export function extractFlightToken(bookingData?: Record<string, unknown>): string | undefined {
  if (!bookingData) return undefined;
  // Check nested flights array first
  const flights = bookingData.flights as Array<Record<string, unknown>> | undefined;
  if (flights?.[0]?.flightToken) return flights[0].flightToken as string;
  // Check top-level flightToken
  if (typeof bookingData.flightToken === "string") return bookingData.flightToken;
  // Check priceToken as alternative key
  if (typeof bookingData.priceToken === "string") return bookingData.priceToken;
  return undefined;
}

/**
 * Build a human-readable one-line flight summary.
 */
export function buildFlightSummary(
  opt: { name: string; price?: number; airline?: string; duration?: string },
  origin?: string,
  destination?: string
): string {
  const parts: string[] = [];
  if (origin && destination) parts.push(`${origin}→${destination}`);
  else parts.push(opt.name);
  if (opt.airline) parts.push(opt.airline);
  if (opt.price != null) parts.push(formatPrice(opt.price));
  if (opt.duration) parts.push(opt.duration);
  return parts.join(" · ");
}

/**
 * Build a human-readable one-line hotel summary.
 */
export function buildHotelSummary(opt: { name: string; price?: number }): string {
  const parts = [opt.name];
  if (opt.price != null) parts.push(`${formatPrice(opt.price)}/night`);
  return parts.join(" · ");
}

/**
 * Format a price with commas and 2 decimal places.
 * e.g. 1234.5 → "$1,234.50"
 */
export function formatPrice(price: number): string {
  return "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Validate a YYYY-MM-DD date string.
 * Exits with a helpful error if invalid.
 */
export function validateDate(value: string, flagName: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    process.stderr.write(chalk.red(`Invalid date for ${flagName}: "${value}". Expected format: YYYY-MM-DD\n`));
    process.exit(1);
  }
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) {
    process.stderr.write(chalk.red(`Invalid date for ${flagName}: "${value}". Month must be 1-12, day must be 1-31.\n`));
    process.exit(1);
  }
}

/**
 * Validate a 3-letter IATA airport code.
 * Exits with a helpful error if invalid.
 */
export function validateIata(value: string, flagName: string): void {
  const upper = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    process.stderr.write(chalk.red(`Invalid IATA code for ${flagName}: "${value}". Expected 3-letter code (e.g., LAX, NRT).\n`));
    process.exit(1);
  }
}
