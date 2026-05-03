import chalk from "chalk";
import { spawn } from "child_process";
import { CliError, CliErrorCode } from "./errors.js";

/**
 * Extract a flight token from a booking data JSONB blob.
 * Checks multiple paths since GDS data structure varies.
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
 * Build a human-readable one-line activity summary.
 */
export function buildActivitySummary(opt: { name: string; price?: number; duration?: string }): string {
  const parts = [opt.name];
  if (opt.price != null) parts.push(formatPrice(opt.price));
  if (opt.duration) parts.push(opt.duration);
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
    throw new CliError(CliErrorCode.VALIDATION, `Invalid date for ${flagName}: "${value}". Expected format: YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  // Round-trip through Date to catch impossible dates (Feb 31, etc.)
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new CliError(CliErrorCode.VALIDATION, `Invalid date for ${flagName}: "${value}". Date does not exist.`);
  }
}

/**
 * Warn (non-blocking) when a date is in the past.
 * Compares YYYY-MM-DD strings to avoid timezone issues.
 */
export function warnPastDate(date: string, label: string): void {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  if (date < today) {
    process.stderr.write(chalk.yellow(`⚠ ${label} (${date}) is in the past.\n`));
  }
}

/**
 * Validate a 3-letter IATA airport code.
 * Exits with a helpful error if invalid.
 */
export function validateIata(value: string, flagName: string): void {
  const upper = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new CliError(CliErrorCode.VALIDATION, `Invalid IATA code for ${flagName}: "${value}". Expected 3-letter code (e.g., LAX, NRT).`);
  }
}

// --- Shared types for sub-selection checking ---

export interface SelectionTraveller {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null;
  gender?: string | null;
}

export interface PlanItemForSubCheck {
  id: string;
  title: string;
  selection?: {
    id: string;
    type?: string;
    isLocked: boolean;
    assignedTravellers?: SelectionTraveller[];
    selectedOption?: {
      id: string;
      name: string;
      price?: number;
      status: string;
      subSelections?: Array<{
        id: string;
        type: string;
        selectedOptionId?: string;
        options: Array<{ id: string }>;
      }>;
    };
  };
}

export interface PendingSubSelection {
  itemTitle: string;
  parentOptionName: string;
  subSelectionType: string;
  subSelectionId: string;
  optionCount: number;
}

/**
 * Find items that have sub-selections needing a choice (no selectedOptionId).
 * Skips locked selections (already paid/booked).
 */
export function findPendingSubSelections(items: PlanItemForSubCheck[]): PendingSubSelection[] {
  const pending: PendingSubSelection[] = [];
  for (const item of items) {
    if (!item.selection?.selectedOption?.subSelections) continue;
    if (item.selection.isLocked) continue;
    for (const sub of item.selection.selectedOption.subSelections) {
      if (!sub.selectedOptionId && sub.options.length > 0) {
        pending.push({
          itemTitle: item.title,
          parentOptionName: item.selection.selectedOption.name,
          subSelectionType: sub.type,
          subSelectionId: sub.id,
          optionCount: sub.options.length,
        });
      }
    }
  }
  return pending;
}

/**
 * Human-readable label for a sub-selection type.
 */
export function subSelectionLabel(type: string): string {
  switch (type) {
    case "FLIGHT_CLASS": return "cabin class";
    case "HOTEL_ROOM": return "room type";
    case "ACTIVITY_BOOKABLE_ITEM": return "activity option";
    default: return type.toLowerCase().replace(/_/g, " ");
  }
}

/**
 * Returns true when a location string looks like a 3-letter airport code (e.g. "BKI", "KUL").
 * The hotel search API expects a city name, not an airport code.
 */
export function looksLikeAirportCode(location: string): boolean {
  return /^[A-Za-z]{3}$/.test(location.trim());
}

/**
 * Open a URL in the user's default browser. Fails silently.
 */
export function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (platform === "win32") {
      spawn("powershell", ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`],
        { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // User can open URL manually
  }
}

/**
 * Derive a web base URL from the API URL.
 * Strips /graphql, /api, or trailing slashes from the configured API endpoint.
 */
export function deriveBaseUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    // Strip /graphql or similar API paths
    url.pathname = "";
    return url.origin;
  } catch {
    return "https://travel.voyagier.com";
  }
}

// ----- Strict numeric validators for CLI flags (Group A fixes) -----

/**
 * Parse a positive integer from a CLI flag. Rejects non-numeric, negative, zero (unless allowZero), NaN.
 * Returns undefined if value is undefined (flag not provided).
 * @throws CliError with VALIDATION code if value is invalid.
 */
export function parsePositiveInt(
  value: string | undefined,
  flagName: string,
  opts?: { allowZero?: boolean; max?: number; default?: number }
): number | undefined {
  if (value === undefined) {
    // Validate the default against our own contract so callers can't
    // sneak in invalid defaults (e.g. default: 0 with allowZero: false).
    if (opts?.default !== undefined) {
      const def = opts.default;
      if (!Number.isInteger(def) || def < 0 || (def === 0 && !opts.allowZero) || (opts.max !== undefined && def > opts.max)) {
        throw new Error(
          `parsePositiveInt: invalid default ${def} for ${flagName} (allowZero=${!!opts.allowZero}, max=${opts.max})`
        );
      }
    }
    return opts?.default;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || !/^-?\d+$/.test(value)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Expected a positive integer.\n  Fix: ${flagName} 10`
    );
  }
  if (parsed < 0 || (parsed === 0 && !opts?.allowZero)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Must be ${opts?.allowZero ? "non-negative" : "positive"}.\n  Fix: ${flagName} 10`
    );
  }
  if (opts?.max !== undefined && parsed > opts.max) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Maximum value is ${opts.max}.\n  Fix: ${flagName} ${opts.max}`
    );
  }
  return parsed;
}

/**
 * Parse a non-negative integer from a CLI flag (allows 0).
 * @throws CliError with VALIDATION code if value is invalid.
 */
export function parseNonNegativeInt(
  value: string | undefined,
  flagName: string
): number | undefined {
  return parsePositiveInt(value, flagName, { allowZero: true });
}

/**
 * Parse a float from a CLI flag. Rejects non-numeric, NaN.
 * @throws CliError with VALIDATION code if value is invalid.
 */
export function parseFloatStrict(
  value: string | undefined,
  flagName: string,
  opts?: { min?: number; max?: number; nonNegative?: boolean }
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseFloat(value);
  if (isNaN(parsed) || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Expected a number.\n  Fix: ${flagName} 48.8584`
    );
  }
  if (opts?.nonNegative && parsed < 0) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Must be non-negative.\n  Fix: ${flagName} 0`
    );
  }
  if (opts?.min !== undefined && parsed < opts.min) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Must be >= ${opts.min}.\n  Fix: ${flagName} ${opts.min}`
    );
  }
  if (opts?.max !== undefined && parsed > opts.max) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid ${flagName}: "${value}". Must be <= ${opts.max}.\n  Fix: ${flagName} ${opts.max}`
    );
  }
  return parsed;
}

/**
 * Format an ISO date string (or YYYY-MM-DD) for human display.
 * e.g. "2026-06-15T00:00:00.000Z" → "Jun 15, 2026"
 */
export function formatDateHuman(iso?: string): string | null {
  if (!iso) return null;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return `${months[m - 1]} ${d}, ${y}`;
}

/**
 * Format a date range for human display.
 * e.g. "Jun 15 – Jul 6, 2026" or "Jun 15-19, 2026"
 */
export function formatDateRange(start?: string, end?: string): string {
  if (!start) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [sy, sm, sd] = start.slice(0, 10).split("-").map(Number);
  if (!end) return `${months[sm - 1]} ${sd}, ${sy}`;
  const [ey, em, ed] = end.slice(0, 10).split("-").map(Number);
  if (sy === ey && sm === em) return `${months[sm - 1]} ${sd}-${ed}, ${sy}`;
  if (sy === ey) return `${months[sm - 1]} ${sd} – ${months[em - 1]} ${ed}, ${sy}`;
  return `${months[sm - 1]} ${sd}, ${sy} – ${months[em - 1]} ${ed}, ${ey}`;
}

/**
 * Render a tri-state boolean (true / false / unknown) for human-facing output.
 * Used for nullable schema fields where null carries semantic meaning distinct
 * from false (e.g. BlueprintListing.isAvailable, TripPlanSelectOption.isBookable).
 *
 * @example
 *   formatNullableBool(true)  // "Yes"
 *   formatNullableBool(false) // "No"
 *   formatNullableBool(null)  // "Unknown"
 *   formatNullableBool(undefined) // "Unknown"
 */
export function formatNullableBool(value: boolean | null | undefined): "Yes" | "No" | "Unknown" {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

/**
 * Escape a string for safe inclusion in a Markdown table cell.
 * Handles the characters that would break table structure or trigger
 * unintended formatting: pipes, backticks, and newlines.
 */
export function escapeMdTableCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}
