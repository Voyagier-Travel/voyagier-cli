/**
 * Flight leg-detail helpers (VOY-1783).
 *
 * A flight search option's raw `bookingData` carries the actual itinerary in
 * `flights[].flightLegs[]` (each leg: origin, destination, departureTime,
 * arrivalTime, carrier, flightNumber). The formatting layer historically
 * discarded all of it and rendered only `airline · duration · price`. These
 * helpers surface decision-grade detail — flight number, first→last route with
 * wall-clock times, and stop count/connections — as short display labels.
 *
 * Everything here is DERIVED and optional-safe: when the leg data isn't present
 * (older payloads, partial data) `deriveFlightDetail` returns null and callers
 * fall back to today's output. Never emits `undefined` into a line.
 *
 * Times are rendered as the LOCAL WALL-CLOCK exactly as stored — no Date
 * parsing, no timezone conversion, no offset arithmetic (see wallClockTime).
 */

/** Structured leg-level detail for a flight search option. */
export interface FlightDetail {
  /** Carrier + number of the first leg, e.g. "DL 1043"; null unless both present. */
  flightNumber: string | null;
  /** Origin airport of the first leg. */
  origin: string | null;
  /** Destination airport of the last leg. */
  destination: string | null;
  /** Departure wall-clock (HH:MM) of the first leg. */
  departureTime: string | null;
  /** Arrival wall-clock (HH:MM) of the last leg. */
  arrivalTime: string | null;
  /** Number of stops (legs - 1); null only when no legs were found. */
  stopCount: number | null;
  /** Intermediate (connection) airport codes, in order. */
  connections: string[];
}

/** Non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Extract an HH:MM wall-clock label from a stored time string WITHOUT any
 * timezone math — the stored value is already local wall-clock, so we read the
 * digits verbatim rather than round-tripping through Date (which would apply the
 * host offset and shift the displayed time).
 *
 * Handles ISO-ish "2026-06-15T07:15:00[...]" and bare "7:15"/"07:15[:00]".
 * Returns null for anything else.
 */
export function wallClockTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iso = value.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const bare = value.match(/^(\d{1,2}):(\d{2})/);
  if (bare) return `${bare[1].padStart(2, "0")}:${bare[2]}`;
  return null;
}

/** Pull the legs array from either flights[0].flightLegs or a top-level flightLegs. */
function legsOf(bookingData: Record<string, unknown>): Record<string, unknown>[] {
  // flights[0] holds the current selection's journey — matches the flights[0]
  // convention extractFlightToken already uses. Round trips use SEPARATE
  // selections (each with its own option/bookingData), so per-selection
  // flights[0] is the right leg set; no cross-segment projection needed here.
  const flights = Array.isArray(bookingData.flights) ? bookingData.flights : null;
  const first =
    flights && flights[0] && typeof flights[0] === "object"
      ? (flights[0] as Record<string, unknown>)
      : null;
  const raw = first && Array.isArray(first.flightLegs)
    ? first.flightLegs
    : Array.isArray(bookingData.flightLegs)
      ? bookingData.flightLegs
      : [];
  return raw.filter((l): l is Record<string, unknown> => !!l && typeof l === "object");
}

/**
 * Derive leg-level flight detail from a raw booking-data blob, or null when no
 * usable leg data is present (caller then falls back to today's output).
 */
export function deriveFlightDetail(bookingData?: unknown): FlightDetail | null {
  if (!bookingData || typeof bookingData !== "object") return null;
  const legs = legsOf(bookingData as Record<string, unknown>);
  if (legs.length === 0) return null;

  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];

  const carrier = str(firstLeg.carrier);
  const numberValue =
    str(firstLeg.flightNumber) ??
    (typeof firstLeg.flightNumber === "number" ? String(firstLeg.flightNumber) : null);
  // Only compose a flight number when both parts are known — a bare "1043" with
  // no carrier reads worse than falling back to the airline name.
  const flightNumber = carrier && numberValue ? `${carrier} ${numberValue}` : null;

  // Connections = the destination of every leg except the last (each arrival
  // hop the traveller passes through).
  const connections: string[] = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const code = str(legs[i].destination);
    if (code) connections.push(code);
  }

  return {
    flightNumber,
    origin: str(firstLeg.origin),
    destination: str(lastLeg.destination),
    departureTime: wallClockTime(firstLeg.departureTime),
    arrivalTime: wallClockTime(lastLeg.arrivalTime),
    stopCount: legs.length - 1,
    connections,
  };
}

/**
 * Stops annotation for a flight, e.g. "nonstop", "1 stop, ATL", "2 stops,
 * ATL, ORD". Empty string when the stop count is unknown.
 */
export function flightStopsLabel(detail: FlightDetail): string {
  if (detail.stopCount == null) return "";
  if (detail.stopCount <= 0) return "nonstop";
  const base = `${detail.stopCount} stop${detail.stopCount === 1 ? "" : "s"}`;
  return detail.connections.length ? `${base}, ${detail.connections.join(", ")}` : base;
}

/**
 * Route + times + stops label, e.g. "BWI 07:15 → AUS 10:05 (1 stop, ATL)".
 * Degrades gracefully: drops times when missing ("BWI → AUS"), drops a side
 * when only one airport is known, and omits the stops paren when there's no
 * route to attach it to. Returns "" when nothing is renderable.
 */
export function flightRouteLabel(detail: FlightDetail): string {
  const from = [detail.origin, detail.departureTime].filter(Boolean).join(" ");
  const to = [detail.destination, detail.arrivalTime].filter(Boolean).join(" ");
  const route = from && to ? `${from} → ${to}` : from || to;
  if (!route) return "";
  const stops = flightStopsLabel(detail);
  return stops ? `${route} (${stops})` : route;
}

/**
 * Additive structured fields for the compact `--json` top-options projection.
 * Only includes keys that are actually known — keeps the projection compact and
 * never emits nulls/undefined. Returns {} when there's no leg detail.
 */
export function flightProjectionFields(bookingData?: unknown): Record<string, unknown> {
  const detail = deriveFlightDetail(bookingData);
  if (!detail) return {};
  const out: Record<string, unknown> = {};
  if (detail.flightNumber) out.flightNumber = detail.flightNumber;
  if (detail.origin) out.origin = detail.origin;
  if (detail.destination) out.destination = detail.destination;
  if (detail.departureTime) out.departureTime = detail.departureTime;
  if (detail.arrivalTime) out.arrivalTime = detail.arrivalTime;
  if (detail.stopCount != null) out.stops = detail.stopCount;
  if (detail.connections.length) out.connections = detail.connections;
  return out;
}
