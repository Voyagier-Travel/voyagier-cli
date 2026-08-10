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
import { cents } from "./format.js";

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
  /** Distinct carrier codes across the segment's legs, in first-seen order. */
  carriers: string[];
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

/**
 * Pull the legs array for a segment from `flights[segmentIndex].flightLegs`
 * (or a top-level `flightLegs` for segment 0 only).
 *
 * `flights[0]` holds the outbound journey — matches the flights[0] convention
 * extractFlightToken already uses. Round trips can arrive one of two ways: as
 * SEPARATE selections (each option's own flights[0] is that leg's set), or as a
 * single option carrying both legs (flights[0] = outbound, flights[1] = return).
 * Passing `segmentIndex` lets the return-leg refinement filters read flights[1]
 * when a provider bundles both legs into one option; when it doesn't, legsOf
 * returns [] for segment 1 and the return filters treat the option as
 * data-absent (excluded only while a return filter is active).
 */
function legsOf(bookingData: Record<string, unknown>, segmentIndex = 0): Record<string, unknown>[] {
  const flights = Array.isArray(bookingData.flights) ? bookingData.flights : null;
  const seg =
    flights && flights[segmentIndex] && typeof flights[segmentIndex] === "object"
      ? (flights[segmentIndex] as Record<string, unknown>)
      : null;
  const raw = seg && Array.isArray(seg.flightLegs)
    ? seg.flightLegs
    : segmentIndex === 0 && Array.isArray(bookingData.flightLegs)
      ? bookingData.flightLegs
      : [];
  return raw.filter((l): l is Record<string, unknown> => !!l && typeof l === "object");
}

/**
 * Derive leg-level flight detail from a raw booking-data blob, or null when no
 * usable leg data is present (caller then falls back to today's output).
 *
 * `segmentIndex` selects which journey to read — 0 (default) for the outbound,
 * 1 for the return leg when a single option bundles both (round-trip refinement).
 */
export function deriveFlightDetail(bookingData?: unknown, segmentIndex = 0): FlightDetail | null {
  if (!bookingData || typeof bookingData !== "object") return null;
  const legs = legsOf(bookingData as Record<string, unknown>, segmentIndex);
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

  // Distinct carriers across the segment's legs (for airline filtering/facets).
  const carriers: string[] = [];
  for (const leg of legs) {
    const c = str(leg.carrier);
    if (c && !carriers.includes(c)) carriers.push(c);
  }

  return {
    flightNumber,
    origin: str(firstLeg.origin),
    destination: str(lastLeg.destination),
    departureTime: wallClockTime(firstLeg.departureTime),
    arrivalTime: wallClockTime(lastLeg.arrivalTime),
    stopCount: legs.length - 1,
    connections,
    carriers,
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
 * Extract the platform value score (`rankScore`) from a flight option's raw
 * provider blob. The blob is the server's `optionData` — aliased to
 * `bookingData` by the queries that fetch it — and the score is read directly
 * off whichever blob the caller passes. Display-only (VOY-1824): the score is
 * surfaced as a factual field, never used to re-order options.
 *
 * Returns the score verbatim when it is a finite number, or undefined when
 * absent / non-numeric. It is NOT clamped or reshaped: a value slightly
 * outside 0-1 is passed through as-is (the caller only displays it). The
 * ranking formula's internal breakdown is deliberately never read here.
 */
export function extractRankScore(bookingData?: unknown): number | undefined {
  if (!bookingData || typeof bookingData !== "object") return undefined;
  const raw = (bookingData as Record<string, unknown>).rankScore;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Compact display token for a rank score, e.g. "rank 0.82" (2 decimals). */
export function rankScoreLabel(score: number): string {
  return `rank ${score.toFixed(2)}`;
}

/**
 * Candidate keys carrying a fare / product descriptor in provider bookingData.
 * The fare product (brand/cabin/booking class) is what distinguishes two
 * option rows that share an identical displayed schedule + price. Names vary by
 * GDS, so we probe a small, ordered set and take the first non-empty string.
 */
const FARE_KEYS = [
  "fareBrand",
  "fareBrandName",
  "brandName",
  "fareName",
  "fareFamily",
  "fareType",
  "fareBasis",
  "cabin",
  "cabinClass",
  "cabinName",
  "bookingClass",
  "fareClass",
  "fareCode",
];

function scanFareKeys(o: Record<string, unknown>): string | null {
  for (const k of FARE_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Best-effort fare / product label for a flight option, or null when none is
 * detectable. Probes the top-level blob, then flights[0], then its first leg —
 * the same nesting `deriveFlightDetail` walks. Display-only: used to decide
 * whether two identical-schedule rows are actually distinguishable (annotate)
 * or truly indistinguishable (collapse).
 */
export function extractFareLabel(bookingData?: unknown): string | null {
  if (!bookingData || typeof bookingData !== "object") return null;
  const bd = bookingData as Record<string, unknown>;
  const top = scanFareKeys(bd);
  if (top) return top;
  const flights = Array.isArray(bd.flights) ? bd.flights : null;
  const f0 = flights && flights[0] && typeof flights[0] === "object" ? (flights[0] as Record<string, unknown>) : null;
  if (f0) {
    const s = scanFareKeys(f0);
    if (s) return s;
    const legs = Array.isArray(f0.flightLegs) ? f0.flightLegs : null;
    const l0 = legs && legs[0] && typeof legs[0] === "object" ? (legs[0] as Record<string, unknown>) : null;
    if (l0) {
      const sl = scanFareKeys(l0);
      if (sl) return sl;
    }
  }
  return null;
}

/** Minimal option shape the duplicate analysis reads (a subset of SelectOption). */
export interface DuplicableFlightOption {
  id?: string;
  price?: number;
  airline?: string;
  duration?: string;
  bookingData?: Record<string, unknown> | null;
}

/**
 * Per-option role in the display-duplicate analysis (aligned to the input
 * order). All fields are optional; a plain `{}` means "unique / render as-is".
 *
 * `duplicateOfOptionId` is the JSON marker: set on every option that is
 * display-identical to an EARLIER one, whether it is annotated or collapsed —
 * the machine surface keeps all options, only flagging the relationship.
 */
export interface FlightDupRole {
  /** JSON marker: id of the earlier, display-identical option this duplicates. */
  duplicateOfOptionId?: string;
  /** Human/agent: omit this row entirely (folded into its primary). */
  collapsed?: boolean;
  /** Human/agent: fare/product label to show on this row (annotate mode). */
  annotate?: string;
  /** On a primary: ids of the identical options folded into it (collapse mode). */
  collapsedAlternates?: string[];
}

/**
 * Signature of what a compact flight row actually SHOWS: leading carrier/flight
 * number (or airline), timed route + stops, price, duration. Two options with
 * the same signature are indistinguishable at the display layer. Returns null
 * when there isn't enough shown content to safely claim a duplicate (e.g. no
 * price and no schedule), so sparse rows are never collapsed.
 */
function displaySignature(opt: DuplicableFlightOption): string | null {
  if (opt.price == null) return null;
  const detail = deriveFlightDetail(opt.bookingData);
  const lead = detail?.flightNumber ?? opt.airline ?? "";
  const route = detail ? flightRouteLabel(detail) : "";
  if (!lead && !route) return null;
  // Normalise price through the shared cents rounding so a float artifact can
  // never split two otherwise-identical rows into different signatures.
  const priceKey = String(cents(opt.price));
  return [lead, route, priceKey, opt.duration ?? ""].join("¦");
}

/**
 * Label noting the identical options folded into a collapsed row, e.g.
 * "+1 identical option: opt-2" / "+2 identical options: opt-2, opt-3".
 */
export function collapsedAlternatesLabel(ids: string[]): string {
  return `+${ids.length} identical option${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`;
}

/**
 * Classify a list of flight options for display-duplicate handling (VOY-1877).
 *
 * Options sharing an identical DISPLAYED schedule + price are grouped. Within a
 * group the first (earliest) option is the primary; the rest are duplicates:
 *   - when a fare/product difference IS detectable (distinct `extractFareLabel`
 *     across the group) every member is ANNOTATED with its own fare and kept —
 *     the rows are distinguishable, so we don't hide anything;
 *   - otherwise the duplicates are COLLAPSED into the primary, which notes the
 *     folded ids.
 * Either way, each duplicate carries `duplicateOfOptionId` for the JSON marker.
 *
 * Pure and deterministic (input order only): callers on the human, agent, and
 * JSON paths run it over the same option list and cannot disagree.
 */
export function analyzeFlightDuplicates(options: DuplicableFlightOption[]): FlightDupRole[] {
  const roles: FlightDupRole[] = options.map(() => ({}));
  const groups = new Map<string, number[]>();
  options.forEach((opt, i) => {
    const sig = displaySignature(opt);
    if (sig == null) return;
    const arr = groups.get(sig);
    if (arr) arr.push(i);
    else groups.set(sig, [i]);
  });

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const primary = idxs[0];
    const primaryId = options[primary].id;
    // Without a stable id for the primary we can neither emit a marker nor name
    // the alternates — leave the group as separate rows rather than lose info.
    if (!primaryId) continue;

    const labels = idxs.map((i) => extractFareLabel(options[i].bookingData));
    // More than one distinct fare label (null folded to "") ⇒ the rows are
    // actually distinguishable ⇒ annotate rather than collapse.
    const annotateMode = new Set(labels.map((l) => l ?? "")).size > 1;

    if (annotateMode) {
      idxs.forEach((i, k) => {
        const label = labels[k];
        if (label) roles[i].annotate = label;
        if (k > 0) roles[i].duplicateOfOptionId = primaryId;
      });
    } else {
      const alternates: string[] = [];
      idxs.forEach((i, k) => {
        if (k === 0) return;
        roles[i].duplicateOfOptionId = primaryId;
        // Only fold rows we can NAME as alternates: an id-less duplicate would
        // vanish from the render without a trace, so it stays visible instead.
        const dupId = options[i].id;
        if (!dupId) return;
        roles[i].collapsed = true;
        alternates.push(dupId);
      });
      if (alternates.length > 0) roles[primary].collapsedAlternates = alternates;
    }
  }

  return roles;
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
