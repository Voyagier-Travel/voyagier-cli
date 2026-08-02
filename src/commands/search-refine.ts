/**
 * Client-side search refinement (VOY-1784).
 *
 * Refinement flags, factual result callouts, and facets all operate on the
 * option set the backend ALREADY returned — this is a pure presentation layer,
 * never a re-ranking or a new server call. The Intelligence Layering rule holds:
 * booking-api scores and orders (`sortOrder`), the CLI only filters/summarises
 * what came back. Factual extremes (cheapest/fastest/earliest/highest-rated) are
 * facts, not scores, so surfacing them is permitted.
 *
 * Time handling reuses the VOY-1783 wall-clock leg extraction verbatim — the
 * stored times are already local wall-clock, so we compare minutes-since-midnight
 * with NO timezone math (see flight-format.wallClockTime).
 *
 * Missing-data policy (documented once, applied consistently): an option that
 * lacks the datum a given filter needs is excluded by THAT filter only, and only
 * while that filter is active. A depart-after filter drops options with no
 * departure time; it does not drop them for an unrelated max-price filter.
 *
 * Boundary policy (also consistent): `--depart-after`/`--return-depart-after`,
 * `--arrive-by`, `--max-*`, `--min-rating` are INCLUSIVE (at-or-…); only
 * `--depart-before`/`--return-depart-before` are exclusive (strictly before), so
 * that `--depart-after T` and `--depart-before T` partition cleanly at T.
 */
import { deriveFlightDetail } from "../flight-format.js";
import { deriveHotelFacts } from "../hotel-format.js";
import { formatPrice } from "../format.js";

/** Minimal option shape the refinement layer reads (subset of SelectOption). */
export interface RefineOption {
  id: string;
  name?: string;
  price?: number;
  duration?: string;
  airline?: string;
  bookingData?: Record<string, unknown>;
}

// ── time + money helpers ────────────────────────────────────────────────────

/**
 * Parse an "HH:MM" clock string to minutes-since-midnight, or null when it is
 * not a valid 24-hour time. Accepts a single-digit hour ("7:15"). Used for both
 * user-supplied flag values and the already-normalised stored leg times.
 */
export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutes-since-midnight → "HH:MM" (zero-padded). */
export function minutesToClock(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Compact money label for callouts/facets: "$312" for whole dollars, "$312.50"
 * when there are cents. The full formatPrice (always 2dp) is used everywhere a
 * fare is quoted; callouts favour the terse form the ticket shows.
 */
export function compactMoney(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : formatPrice(n);
}

// ── flight facts ────────────────────────────────────────────────────────────

/** Parse "5h 30m" / "5h30m" / "45m" to minutes; Infinity when unparseable. */
export function parseDurationMinutes(duration?: string): number {
  if (!duration) return Infinity;
  const match = duration.match(/(\d+)h\s*(\d+)?m?/);
  if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2] ?? "0", 10);
  const minOnly = duration.match(/(\d+)\s*m/);
  if (minOnly) return parseInt(minOnly[1], 10);
  return Infinity;
}

/**
 * Number of stops for an option, or null when the payload carries no usable stop
 * signal. Prefers an explicit `stops`, then `segments[]`, then derived legs —
 * the same precedence search's sort uses, but null (not Infinity) for "unknown".
 */
export function stopCount(bookingData?: Record<string, unknown>): number | null {
  if (!bookingData) return null;
  if (typeof bookingData.stops === "number") return bookingData.stops;
  const segments = bookingData.segments as unknown[] | undefined;
  if (Array.isArray(segments)) return Math.max(0, segments.length - 1);
  const derived = deriveFlightDetail(bookingData)?.stopCount;
  return typeof derived === "number" ? derived : null;
}

/** Derived, filter-ready facts for one flight option. */
export interface FlightFacts {
  price: number | null;
  durationMin: number;
  durationLabel: string | null;
  stops: number | null;
  departMin: number | null;
  departLabel: string | null;
  arriveMin: number | null;
  arriveLabel: string | null;
  returnDepartMin: number | null;
  returnDepartLabel: string | null;
  airlines: string[];
}

/** Collect distinct uppercase carrier codes from both segments + the option's airline field. */
function collectAirlines(opt: RefineOption): string[] {
  const out: string[] = [];
  const add = (code: string | null | undefined) => {
    if (!code) return;
    const up = code.toUpperCase();
    if (!out.includes(up)) out.push(up);
  };
  const outbound = deriveFlightDetail(opt.bookingData, 0);
  const ret = deriveFlightDetail(opt.bookingData, 1);
  outbound?.carriers.forEach(add);
  ret?.carriers.forEach(add);
  // A bare 2-letter airline field (IATA code) is a usable fallback when the
  // payload had no leg carriers; a longer marketing name ("Delta") is not.
  if (opt.airline && /^[A-Za-z0-9]{2}$/.test(opt.airline.trim())) add(opt.airline.trim());
  return out;
}

export function flightFacts(opt: RefineOption): FlightFacts {
  const outbound = deriveFlightDetail(opt.bookingData, 0);
  const ret = deriveFlightDetail(opt.bookingData, 1);
  return {
    price: typeof opt.price === "number" ? opt.price : null,
    durationMin: parseDurationMinutes(opt.duration),
    durationLabel: opt.duration ?? null,
    stops: stopCount(opt.bookingData),
    departMin: parseClockMinutes(outbound?.departureTime),
    departLabel: outbound?.departureTime ?? null,
    arriveMin: parseClockMinutes(outbound?.arrivalTime),
    arriveLabel: outbound?.arrivalTime ?? null,
    returnDepartMin: parseClockMinutes(ret?.departureTime),
    returnDepartLabel: ret?.departureTime ?? null,
    airlines: collectAirlines(opt),
  };
}

// ── flight filters ──────────────────────────────────────────────────────────

/** Refinement filters for flights; times are minutes-since-midnight, prices dollars. */
export interface FlightFilters {
  departAfter?: number;
  departBefore?: number;
  arriveBy?: number;
  returnDepartAfter?: number;
  returnDepartBefore?: number;
  airlines?: string[];
  maxStops?: number;
  maxPrice?: number;
}

/** One filter's contribution to a filtered-to-zero explanation. */
export interface FilterAttribution {
  /** Stable machine token, e.g. "depart-after". */
  filter: string;
  /** Human "no options depart after 18:00; latest departure is 16:45". */
  message: string;
}

/** Structured filtered-to-zero result (present only when filters drop everything). */
export interface FilteredToZero {
  eliminatedBy: string[];
  detail: FilterAttribution[];
  inputCount: number;
  /** True when no single filter zeroed the set — only the combination did. */
  combination: boolean;
}

export interface FilterResult<T> {
  kept: T[];
  zero: FilteredToZero | null;
}

interface ActiveFilter<F> {
  key: string;
  pred: (f: F) => boolean;
  describe: (all: F[]) => string;
}

/** Latest/earliest of a nullable numeric field across facts, or null when none set. */
function extremum<F>(all: F[], pick: (f: F) => number | null, dir: "max" | "min"): number | null {
  const vals = all.map(pick).filter((v): v is number => v != null);
  if (!vals.length) return null;
  return dir === "max" ? Math.max(...vals) : Math.min(...vals);
}

function buildFlightFilters(filters: FlightFilters): ActiveFilter<FlightFacts>[] {
  const active: ActiveFilter<FlightFacts>[] = [];

  if (filters.departAfter != null) {
    const t = filters.departAfter;
    active.push({
      key: "depart-after",
      pred: (f) => f.departMin != null && f.departMin >= t,
      describe: (all) => {
        const latest = extremum(all, (f) => f.departMin, "max");
        return latest == null
          ? `no options carry a departure time to filter with --depart-after ${minutesToClock(t)}`
          : `no options depart after ${minutesToClock(t)}; latest departure is ${minutesToClock(latest)}`;
      },
    });
  }
  if (filters.departBefore != null) {
    const t = filters.departBefore;
    active.push({
      key: "depart-before",
      pred: (f) => f.departMin != null && f.departMin < t,
      describe: (all) => {
        const earliest = extremum(all, (f) => f.departMin, "min");
        return earliest == null
          ? `no options carry a departure time to filter with --depart-before ${minutesToClock(t)}`
          : `no options depart before ${minutesToClock(t)}; earliest departure is ${minutesToClock(earliest)}`;
      },
    });
  }
  if (filters.arriveBy != null) {
    const t = filters.arriveBy;
    active.push({
      key: "arrive-by",
      pred: (f) => f.arriveMin != null && f.arriveMin <= t,
      describe: (all) => {
        const earliest = extremum(all, (f) => f.arriveMin, "min");
        return earliest == null
          ? `no options carry an arrival time to filter with --arrive-by ${minutesToClock(t)}`
          : `no options arrive by ${minutesToClock(t)}; earliest arrival is ${minutesToClock(earliest)}`;
      },
    });
  }
  if (filters.returnDepartAfter != null) {
    const t = filters.returnDepartAfter;
    active.push({
      key: "return-depart-after",
      pred: (f) => f.returnDepartMin != null && f.returnDepartMin >= t,
      describe: (all) => {
        const latest = extremum(all, (f) => f.returnDepartMin, "max");
        return latest == null
          ? `no options carry return-leg times to filter with --return-depart-after ${minutesToClock(t)}`
          : `no return legs depart after ${minutesToClock(t)}; latest return departure is ${minutesToClock(latest)}`;
      },
    });
  }
  if (filters.returnDepartBefore != null) {
    const t = filters.returnDepartBefore;
    active.push({
      key: "return-depart-before",
      pred: (f) => f.returnDepartMin != null && f.returnDepartMin < t,
      describe: (all) => {
        const earliest = extremum(all, (f) => f.returnDepartMin, "min");
        return earliest == null
          ? `no options carry return-leg times to filter with --return-depart-before ${minutesToClock(t)}`
          : `no return legs depart before ${minutesToClock(t)}; earliest return departure is ${minutesToClock(earliest)}`;
      },
    });
  }
  if (filters.airlines && filters.airlines.length) {
    const want = filters.airlines.map((a) => a.toUpperCase());
    active.push({
      key: "airline",
      pred: (f) => f.airlines.some((a) => want.includes(a)),
      describe: (all) => {
        const present = [...new Set(all.flatMap((f) => f.airlines))].sort();
        return present.length
          ? `no options on ${want.join(", ")}; airlines available: ${present.join(", ")}`
          : `no options on ${want.join(", ")}; no airline data available to filter on`;
      },
    });
  }
  if (filters.maxStops != null) {
    const max = filters.maxStops;
    active.push({
      key: "max-stops",
      pred: (f) => f.stops != null && f.stops <= max,
      describe: (all) => {
        const fewest = extremum(all, (f) => f.stops, "min");
        if (max === 0) {
          return fewest == null
            ? `no options carry stop data to filter with --nonstop`
            : `no nonstop options; fewest stops is ${fewest}`;
        }
        return fewest == null
          ? `no options carry stop data to filter with --max-stops ${max}`
          : `no options with ${max} stop${max === 1 ? "" : "s"} or fewer; fewest is ${fewest}`;
      },
    });
  }
  if (filters.maxPrice != null) {
    const max = filters.maxPrice;
    active.push({
      key: "max-price",
      pred: (f) => f.price != null && f.price <= max,
      describe: (all) => {
        const cheapest = extremum(all, (f) => f.price, "min");
        return cheapest == null
          ? `no options carry a price to filter with --max-price ${compactMoney(max)}`
          : `no options at or below ${compactMoney(max)}; cheapest is ${compactMoney(cheapest)}`;
      },
    });
  }

  return active;
}

/** Generic apply-filters-with-zero-attribution over pre-derived facts. */
function applyFilters<T, F>(
  items: { opt: T; f: F }[],
  active: ActiveFilter<F>[],
): FilterResult<T> {
  let kept = items;
  for (const af of active) kept = kept.filter((k) => af.pred(k.f));
  const keptOpts = kept.map((k) => k.opt);
  if (keptOpts.length > 0 || items.length === 0 || active.length === 0) {
    return { kept: keptOpts, zero: null };
  }
  // Attribute the wipe-out. A filter that ALONE passes zero options over the
  // full input is a sole culprit; when no single filter does, the combination
  // is responsible and we report every active filter's nearest miss.
  const allFacts = items.map((k) => k.f);
  const sole = active.filter((af) => allFacts.filter((f) => af.pred(f)).length === 0);
  const combination = sole.length === 0;
  const culprits = combination ? active : sole;
  return {
    kept: keptOpts,
    zero: {
      eliminatedBy: culprits.map((c) => c.key),
      detail: culprits.map((c) => ({ filter: c.key, message: c.describe(allFacts) })),
      inputCount: items.length,
      combination,
    },
  };
}

export function filterFlights<T extends RefineOption>(
  options: T[],
  filters: FlightFilters,
): FilterResult<T> {
  const items = options.map((opt) => ({ opt, f: flightFacts(opt) }));
  return applyFilters(items, buildFlightFilters(filters));
}

// ── hotel facts + filters ───────────────────────────────────────────────────

export interface HotelFilters {
  minRating?: number;
  maxTotal?: number;
}

interface HotelFactsRow {
  price: number | null;
  rating: number | null;
  amenities: string[];
}

function hotelFactsRow(opt: RefineOption): HotelFactsRow {
  const facts = deriveHotelFacts(opt.bookingData);
  return {
    price: typeof opt.price === "number" ? opt.price : null,
    rating: facts?.rating ?? null,
    amenities: facts?.amenities ?? [],
  };
}

function buildHotelFilters(filters: HotelFilters): ActiveFilter<HotelFactsRow>[] {
  const active: ActiveFilter<HotelFactsRow>[] = [];
  if (filters.minRating != null) {
    const min = filters.minRating;
    active.push({
      key: "min-rating",
      pred: (f) => f.rating != null && f.rating >= min,
      describe: (all) => {
        const highest = extremum(all, (f) => f.rating, "max");
        return highest == null
          ? `no hotels carry a rating to filter with --min-rating ${min}`
          : `no hotels rated ${min} or higher; highest rating is ${highest}`;
      },
    });
  }
  if (filters.maxTotal != null) {
    const max = filters.maxTotal;
    active.push({
      key: "max-total",
      pred: (f) => f.price != null && f.price <= max,
      describe: (all) => {
        const cheapest = extremum(all, (f) => f.price, "min");
        return cheapest == null
          ? `no hotels carry a total to filter with --max-total ${compactMoney(max)}`
          : `no hotels at or below ${compactMoney(max)} total; cheapest is ${compactMoney(cheapest)}`;
      },
    });
  }
  return active;
}

export function filterHotels<T extends RefineOption>(
  options: T[],
  filters: HotelFilters,
): FilterResult<T> {
  const items = options.map((opt) => ({ opt, f: hotelFactsRow(opt) }));
  return applyFilters(items, buildHotelFilters(filters));
}

// ── callouts (factual extremes over the displayed, post-filter/sort list) ────

export interface FlightCallouts {
  cheapest?: { index: number; price: number };
  fastest?: { index: number; durationLabel: string | null };
  earliest?: { index: number; departLabel: string };
}

/**
 * Cheapest / fastest / earliest of the DISPLAYED list. Indexes are 1-based
 * positions in the passed (already filtered + sorted) array. Ties go to the
 * first in display order (strict `<` keeps the earlier winner).
 */
export function flightCallouts(options: RefineOption[]): FlightCallouts {
  const out: FlightCallouts = {};
  let bestPrice = Infinity;
  let bestDuration = Infinity;
  let bestDepart = Infinity;
  options.forEach((opt, i) => {
    const f = flightFacts(opt);
    if (f.price != null && f.price < bestPrice) {
      bestPrice = f.price;
      out.cheapest = { index: i + 1, price: f.price };
    }
    if (f.durationMin < bestDuration) {
      bestDuration = f.durationMin;
      out.fastest = { index: i + 1, durationLabel: f.durationLabel };
    }
    if (f.departMin != null && f.departMin < bestDepart) {
      bestDepart = f.departMin;
      out.earliest = { index: i + 1, departLabel: f.departLabel! };
    }
  });
  return out;
}

/** One-line factual callout header, or "" when no datum supports any callout. */
export function flightCalloutLine(options: RefineOption[]): string {
  const c = flightCallouts(options);
  const parts: string[] = [];
  if (c.cheapest) parts.push(`Cheapest: #${c.cheapest.index} (${compactMoney(c.cheapest.price)})`);
  if (c.fastest && c.fastest.durationLabel) parts.push(`Fastest: #${c.fastest.index} (${c.fastest.durationLabel})`);
  if (c.earliest) parts.push(`Earliest: #${c.earliest.index} (${c.earliest.departLabel})`);
  return parts.join(" · ");
}

export interface HotelCallouts {
  cheapest?: { index: number; price: number };
  highestRated?: { index: number; rating: number };
}

export function hotelCallouts(options: RefineOption[]): HotelCallouts {
  const out: HotelCallouts = {};
  let bestPrice = Infinity;
  let bestRating = -Infinity;
  options.forEach((opt, i) => {
    const f = hotelFactsRow(opt);
    if (f.price != null && f.price < bestPrice) {
      bestPrice = f.price;
      out.cheapest = { index: i + 1, price: f.price };
    }
    if (f.rating != null && f.rating > bestRating) {
      bestRating = f.rating;
      out.highestRated = { index: i + 1, rating: f.rating };
    }
  });
  return out;
}

export function hotelCalloutLine(options: RefineOption[]): string {
  const c = hotelCallouts(options);
  const parts: string[] = [];
  if (c.cheapest) parts.push(`Cheapest: #${c.cheapest.index} (${compactMoney(c.cheapest.price)})`);
  if (c.highestRated) parts.push(`Highest rated: #${c.highestRated.index} (⭐${c.highestRated.rating})`);
  return parts.join(" · ");
}

// ── facets (shape of the option space; over the post-filter set) ─────────────

export interface FlightFacets {
  priceRange?: { min: number; max: number };
  airlines?: Record<string, number>;
  nonstop?: number;
  earliestDeparture?: string;
  latestDeparture?: string;
  stops?: Record<string, number>;
}

export function flightFacets(options: RefineOption[]): FlightFacets {
  const facts = options.map(flightFacts);
  const out: FlightFacets = {};

  const prices = facts.map((f) => f.price).filter((p): p is number => p != null);
  if (prices.length) out.priceRange = { min: Math.min(...prices), max: Math.max(...prices) };

  const airlines: Record<string, number> = {};
  for (const f of facts) for (const a of f.airlines) airlines[a] = (airlines[a] ?? 0) + 1;
  if (Object.keys(airlines).length) out.airlines = sortCounts(airlines);

  const stops: Record<string, number> = {};
  let nonstop = 0;
  for (const f of facts) {
    if (f.stops == null) continue;
    stops[String(f.stops)] = (stops[String(f.stops)] ?? 0) + 1;
    if (f.stops === 0) nonstop++;
  }
  if (Object.keys(stops).length) {
    out.nonstop = nonstop;
    // Ascending numeric key order so the distribution reads 0,1,2,…
    out.stops = Object.fromEntries(
      Object.keys(stops).map(Number).sort((a, b) => a - b).map((k) => [String(k), stops[String(k)]]),
    );
  }

  const departs = facts.map((f) => f.departMin).filter((m): m is number => m != null);
  if (departs.length) {
    out.earliestDeparture = minutesToClock(Math.min(...departs));
    out.latestDeparture = minutesToClock(Math.max(...departs));
  }

  return out;
}

export interface HotelFacets {
  priceRange?: { min: number; max: number };
  ratingRange?: { min: number; max: number };
  amenities?: Record<string, number>;
}

/** How many amenity counts to surface — a top handful, per the ticket. */
const TOP_AMENITIES = 6;

export function hotelFacets(options: RefineOption[]): HotelFacets {
  const facts = options.map(hotelFactsRow);
  const out: HotelFacets = {};

  const prices = facts.map((f) => f.price).filter((p): p is number => p != null);
  if (prices.length) out.priceRange = { min: Math.min(...prices), max: Math.max(...prices) };

  const ratings = facts.map((f) => f.rating).filter((r): r is number => r != null);
  if (ratings.length) out.ratingRange = { min: Math.min(...ratings), max: Math.max(...ratings) };

  const amenities: Record<string, number> = {};
  for (const f of facts) for (const a of f.amenities) amenities[a] = (amenities[a] ?? 0) + 1;
  if (Object.keys(amenities).length) {
    out.amenities = Object.fromEntries(
      Object.entries(amenities)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_AMENITIES),
    );
  }

  return out;
}

/** Sort a count map descending by count, then alphabetically, into a stable object. */
function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}
