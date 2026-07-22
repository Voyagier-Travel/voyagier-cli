/**
 * Hotel / room price-derivation helpers (VOY-1724).
 *
 * Two honesty fixes live here:
 *  - Hotel SEARCH summaries render the supplier's `minRate` as the STAY TOTAL
 *    ("from $X total · N nights (~$Y/nt)"), not the old "$X/night" — minRate is
 *    the whole-stay price, so the per-night figure was wildly wrong on
 *    multi-night stays.
 *  - Room / rate options carry a nightly rate breakdown + check-in/out dates in
 *    `optionData`; we surface a derived "N nights · $total (~$/nt incl. tax)"
 *    line so an agent quoting a client sees the real stay length and total.
 *
 * Everything here is DERIVED and shown as a short label — raw `optionData` is
 * never emitted (payload discipline).
 */
import { formatPrice } from "./format.js";

/**
 * Count nights between two YYYY-MM-DD (or ISO) dates. Returns null when either
 * is missing/unparseable or the range is non-positive.
 */
export function nightsBetween(checkIn?: string | null, checkOut?: string | null): number | null {
  // Values come from raw optionData/API payloads — guard the type, not just
  // truthiness (a numeric/object date would throw on .slice and take down
  // every derived stay label).
  if (typeof checkIn !== "string" || typeof checkOut !== "string") return null;
  const a = Date.parse(`${checkIn.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${checkOut.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const nights = Math.round((b - a) / 86_400_000);
  return nights > 0 ? nights : null;
}

/** Structured stay derivation for a hotel SEARCH option (minRate = stay total). */
export interface HotelStay {
  stayTotal: number;
  nights: number | null;
  perNight: number | null;
  checkIn: string | null;
  checkOut: string | null;
}

function searchQueryOf(bookingData: unknown): Record<string, unknown> | null {
  if (!bookingData || typeof bookingData !== "object") return null;
  const sq = (bookingData as Record<string, unknown>).searchQuery;
  return sq && typeof sq === "object" ? (sq as Record<string, unknown>) : null;
}

/** Derive stay total + nights for a hotel search option, or null when unknown. */
export function deriveHotelStay(
  price: number | null | undefined,
  bookingData?: unknown,
): HotelStay | null {
  if (typeof price !== "number") return null;
  const sq = searchQueryOf(bookingData);
  const checkIn = typeof sq?.checkInDate === "string" ? (sq.checkInDate as string) : null;
  const checkOut = typeof sq?.checkOutDate === "string" ? (sq.checkOutDate as string) : null;
  const nights = nightsBetween(checkIn, checkOut);
  return {
    stayTotal: price,
    nights,
    perNight: nights ? Math.round(price / nights) : null,
    checkIn,
    checkOut,
  };
}

/**
 * Human/agent label for a hotel search option's price. minRate is a STAY TOTAL,
 * so we say so; when the dates resolve we add nights + a per-night estimate.
 * "from" flags that this is the cheapest available rate for the property.
 */
export function hotelStayLabel(price: number | null | undefined, bookingData?: unknown): string {
  const stay = deriveHotelStay(price, bookingData);
  if (!stay) return "";
  if (stay.nights == null) return `from ${formatPrice(stay.stayTotal)} total`;
  return `from ${formatPrice(stay.stayTotal)} total · ${stay.nights} night${stay.nights === 1 ? "" : "s"} (~$${stay.perNight}/nt)`;
}

/** Structured nights × rate derivation for a room / rate option. */
export interface RoomStay {
  nights: number;
  total: number;
  perNight: number;
  label: string;
}

/**
 * Derive nights + total for a room/rate `optionData` that carries a nightly
 * rate breakdown and check-in/out dates. Returns null (skip silently) when the
 * shape isn't present.
 */
export function deriveRoomStay(optionData: unknown): RoomStay | null {
  if (!optionData || typeof optionData !== "object") return null;
  const od = optionData as Record<string, unknown>;
  const rate = od.rate && typeof od.rate === "object" ? (od.rate as Record<string, unknown>) : null;
  const taxes = rate?.taxes && typeof rate.taxes === "object" ? (rate.taxes as Record<string, unknown>) : null;
  const breakdown = taxes?.breakdown;
  // Gate on the breakdown + dates the task specifies; absent → skip.
  if (!Array.isArray(breakdown) || breakdown.length === 0) return null;
  const nights = nightsBetween(od.checkInDate as string, od.checkOutDate as string);
  if (nights == null) return null;
  const total =
    typeof rate?.totalAmount === "number"
      ? (rate.totalAmount as number)
      : typeof od.totalAmount === "number"
        ? (od.totalAmount as number)
        : null;
  if (total == null) return null;
  const perNight = Math.round(total / nights);
  return {
    nights,
    total,
    perNight,
    label: `${nights} night${nights === 1 ? "" : "s"} · ${formatPrice(total)} total (~$${perNight}/nt incl. tax)`,
  };
}
