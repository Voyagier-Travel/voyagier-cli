import { describe, it, expect } from "@jest/globals";
import {
  parseClockMinutes,
  minutesToClock,
  compactMoney,
  parseDurationMinutes,
  stopCount,
  flightFacts,
  filterFlights,
  filterHotels,
  flightCallouts,
  flightCalloutLine,
  flightFacets,
  hotelCallouts,
  hotelCalloutLine,
  hotelFacets,
  type RefineOption,
} from "./search-refine.js";

/**
 * Client-side refinement (VOY-1784): filters, factual callouts, facets. Pure
 * functions over the ALREADY-fetched option set — no scoring, no re-ranking.
 */

// ── option builders ──────────────────────────────────────────────────────────

/** One-segment flight option with leg times/carrier. */
function flight(
  id: string,
  opts: {
    price?: number;
    duration?: string;
    sortOrder?: number;
    depart?: string;
    arrive?: string;
    carrier?: string;
    stopsLeg?: number; // number of connections to synthesise (legs = stopsLeg + 1)
    returnDepart?: string;
    returnCarrier?: string;
    stops?: number; // explicit bookingData.stops
    airlineField?: string;
  } = {},
): RefineOption {
  const legs: Record<string, unknown>[] = [];
  const nLegs = (opts.stopsLeg ?? 0) + 1;
  for (let i = 0; i < nLegs; i++) {
    legs.push({
      origin: i === 0 ? "AAA" : `H${i}`,
      destination: i === nLegs - 1 ? "ZZZ" : `H${i + 1}`,
      ...(i === 0 && opts.depart ? { departureTime: `2026-08-01T${opts.depart}:00` } : {}),
      ...(i === nLegs - 1 && opts.arrive ? { arrivalTime: `2026-08-01T${opts.arrive}:00` } : {}),
      ...(opts.carrier ? { carrier: opts.carrier, flightNumber: `${100 + i}` } : {}),
    });
  }
  const flights: Record<string, unknown>[] = [{ flightLegs: legs }];
  if (opts.returnDepart) {
    flights.push({
      flightLegs: [{
        origin: "ZZZ", destination: "AAA",
        departureTime: `2026-08-10T${opts.returnDepart}:00`,
        ...(opts.returnCarrier ? { carrier: opts.returnCarrier, flightNumber: "900" } : {}),
      }],
    });
  }
  return {
    id,
    name: id,
    ...(opts.price != null ? { price: opts.price } : {}),
    ...(opts.duration ? { duration: opts.duration } : {}),
    ...(opts.airlineField ? { airline: opts.airlineField } : {}),
    bookingData: {
      flightToken: `TK-${id}`,
      ...(opts.stops != null ? { stops: opts.stops } : {}),
      flights,
    },
  };
}

function hotel(id: string, opts: { price?: number; rating?: number; amenities?: string[] } = {}): RefineOption {
  return {
    id,
    name: id,
    ...(opts.price != null ? { price: opts.price } : {}),
    bookingData: {
      ...(opts.rating != null ? { rating: opts.rating } : {}),
      ...(opts.amenities ? { amenities: opts.amenities } : {}),
    },
  };
}

// ── time / money helpers ─────────────────────────────────────────────────────

describe("parseClockMinutes", () => {
  it("parses HH:MM and single-digit hours", () => {
    expect(parseClockMinutes("07:15")).toBe(7 * 60 + 15);
    expect(parseClockMinutes("7:15")).toBe(7 * 60 + 15);
    expect(parseClockMinutes("00:00")).toBe(0);
    expect(parseClockMinutes("23:59")).toBe(23 * 60 + 59);
  });
  it("rejects out-of-range and malformed values", () => {
    expect(parseClockMinutes("24:00")).toBeNull();
    expect(parseClockMinutes("12:60")).toBeNull();
    expect(parseClockMinutes("nope")).toBeNull();
    expect(parseClockMinutes("1230")).toBeNull();
    expect(parseClockMinutes(1230)).toBeNull();
  });
  it("round-trips through minutesToClock (zero-padded)", () => {
    expect(minutesToClock(parseClockMinutes("6:05")!)).toBe("06:05");
    expect(minutesToClock(18 * 60)).toBe("18:00");
  });
});

describe("compactMoney", () => {
  it("drops cents for whole dollars, keeps them otherwise", () => {
    expect(compactMoney(312)).toBe("$312");
    expect(compactMoney(1200)).toBe("$1,200");
    expect(compactMoney(312.5)).toBe("$312.50");
  });
});

describe("parseDurationMinutes / stopCount", () => {
  it("parses assorted duration strings", () => {
    expect(parseDurationMinutes("5h 30m")).toBe(330);
    expect(parseDurationMinutes("5h30m")).toBe(330);
    expect(parseDurationMinutes("45m")).toBe(45);
    expect(parseDurationMinutes(undefined)).toBe(Infinity);
  });
  it("prefers explicit stops, then segments, then legs, else null", () => {
    expect(stopCount({ stops: 2 })).toBe(2);
    expect(stopCount({ segments: [{}, {}, {}] })).toBe(2);
    expect(stopCount({ flights: [{ flightLegs: [{ origin: "A", destination: "B" }, { origin: "B", destination: "C" }] }] })).toBe(1);
    expect(stopCount({ flightToken: "x" })).toBeNull();
    expect(stopCount(undefined)).toBeNull();
  });
});

describe("flightFacts", () => {
  it("derives outbound + return times, carriers, stops from legs", () => {
    const f = flightFacts(flight("a", { depart: "07:15", arrive: "10:05", carrier: "DL", stopsLeg: 1, returnDepart: "19:40", returnCarrier: "AA", price: 412, duration: "5h50m" }));
    expect(f.departLabel).toBe("07:15");
    expect(f.arriveLabel).toBe("10:05");
    expect(f.returnDepartLabel).toBe("19:40");
    expect(f.stops).toBe(1);
    expect(f.airlines).toEqual(["DL", "AA"]);
    expect(f.price).toBe(412);
    expect(f.durationMin).toBe(350);
  });
  it("uses a 2-letter airline field as a carrier fallback but not a full name", () => {
    expect(flightFacts({ id: "x", airline: "B6", bookingData: {} }).airlines).toEqual(["B6"]);
    expect(flightFacts({ id: "x", airline: "JetBlue", bookingData: {} }).airlines).toEqual([]);
  });
});

// ── flight filters: boundaries ───────────────────────────────────────────────

describe("filterFlights time boundaries", () => {
  const opts = [
    flight("early", { depart: "06:00", arrive: "09:00" }),
    flight("mid", { depart: "12:00", arrive: "15:00" }),
    flight("late", { depart: "18:00", arrive: "21:00" }),
  ];

  it("--depart-after is inclusive (at or after)", () => {
    const { kept } = filterFlights(opts, { departAfter: 12 * 60 });
    expect(kept.map((o) => o.id)).toEqual(["mid", "late"]); // 12:00 kept
  });
  it("--depart-before is exclusive (strictly before)", () => {
    const { kept } = filterFlights(opts, { departBefore: 12 * 60 });
    expect(kept.map((o) => o.id)).toEqual(["early"]); // 12:00 dropped
  });
  it("--depart-after T and --depart-before T partition cleanly at T", () => {
    expect(filterFlights(opts, { departAfter: 12 * 60 }).kept.map((o) => o.id)).toEqual(["mid", "late"]);
    expect(filterFlights(opts, { departBefore: 12 * 60 }).kept.map((o) => o.id)).toEqual(["early"]);
  });
  it("--arrive-by is inclusive (at or before)", () => {
    const { kept } = filterFlights(opts, { arriveBy: 15 * 60 });
    expect(kept.map((o) => o.id)).toEqual(["early", "mid"]); // 15:00 kept
  });
});

describe("filterFlights leg-aware outbound vs return", () => {
  const rt = [
    flight("a", { depart: "08:00", returnDepart: "10:00" }),
    flight("b", { depart: "08:00", returnDepart: "20:00" }),
  ];
  it("--return-depart-after filters the RETURN segment, not the outbound", () => {
    const { kept } = filterFlights(rt, { returnDepartAfter: 18 * 60 });
    expect(kept.map((o) => o.id)).toEqual(["b"]);
  });
  it("--return-depart-before filters the return segment", () => {
    const { kept } = filterFlights(rt, { returnDepartBefore: 18 * 60 });
    expect(kept.map((o) => o.id)).toEqual(["a"]);
  });
  it("outbound time filter does not consult the return leg", () => {
    // Both depart 08:00 outbound; a depart-after 09:00 drops BOTH regardless of return.
    const { kept } = filterFlights(rt, { departAfter: 9 * 60 });
    expect(kept).toHaveLength(0);
  });
});

describe("filterFlights airline / stops / price", () => {
  const opts = [
    flight("dl", { carrier: "DL", price: 500, stopsLeg: 1 }),
    flight("ua", { carrier: "UA", price: 300, stopsLeg: 0 }),
    flight("aa", { carrier: "AA", price: 700, stopsLeg: 2 }),
  ];
  it("--airline matches carrier IATA codes (repeatable = union)", () => {
    expect(filterFlights(opts, { airlines: ["DL"] }).kept.map((o) => o.id)).toEqual(["dl"]);
    expect(filterFlights(opts, { airlines: ["DL", "UA"] }).kept.map((o) => o.id)).toEqual(["dl", "ua"]);
  });
  it("--max-stops keeps options at or below the cap", () => {
    expect(filterFlights(opts, { maxStops: 0 }).kept.map((o) => o.id)).toEqual(["ua"]);
    expect(filterFlights(opts, { maxStops: 1 }).kept.map((o) => o.id)).toEqual(["dl", "ua"]);
  });
  it("--max-price is inclusive", () => {
    expect(filterFlights(opts, { maxPrice: 500 }).kept.map((o) => o.id)).toEqual(["dl", "ua"]);
  });
  it("composes multiple filters (AND)", () => {
    const { kept } = filterFlights(opts, { maxStops: 1, maxPrice: 400 });
    expect(kept.map((o) => o.id)).toEqual(["ua"]);
  });
});

describe("filterFlights missing-data policy", () => {
  it("excludes options lacking the datum ONLY while that filter is active", () => {
    const opts = [
      flight("timed", { depart: "07:00", price: 200 }),
      { id: "notime", name: "notime", price: 150, bookingData: { flightToken: "x" } } as RefineOption,
    ];
    // depart-after active → the timeless option is dropped by THAT filter.
    expect(filterFlights(opts, { departAfter: 6 * 60 }).kept.map((o) => o.id)).toEqual(["timed"]);
    // max-price only → the timeless option is kept (its missing time is irrelevant).
    expect(filterFlights(opts, { maxPrice: 1000 }).kept.map((o) => o.id)).toEqual(["timed", "notime"]);
  });
});

// ── filtered-to-zero attribution + nearest miss ──────────────────────────────

describe("filterFlights filtered-to-zero attribution", () => {
  it("attributes a sole culprit with the nearest miss", () => {
    const opts = [flight("a", { depart: "16:45" }), flight("b", { depart: "10:00" })];
    const { kept, zero } = filterFlights(opts, { departAfter: 18 * 60 });
    expect(kept).toHaveLength(0);
    expect(zero!.eliminatedBy).toEqual(["depart-after"]);
    expect(zero!.combination).toBe(false);
    expect(zero!.detail[0].message).toBe("no options depart after 18:00; latest departure is 16:45");
  });

  it("nearest miss for depart-before is the earliest departure", () => {
    const opts = [flight("a", { depart: "09:30" }), flight("b", { depart: "12:00" })];
    const { zero } = filterFlights(opts, { departBefore: 8 * 60 });
    expect(zero!.detail[0].message).toBe("no options depart before 08:00; earliest departure is 09:30");
  });

  it("nearest miss for max-price is the cheapest", () => {
    const opts = [flight("a", { price: 620 }), flight("b", { price: 540 })];
    const { zero } = filterFlights(opts, { maxPrice: 500 });
    expect(zero!.detail[0].message).toBe("no options at or below $500; cheapest is $540");
  });

  it("nonstop (max-stops 0) reports fewest stops", () => {
    const opts = [flight("a", { stopsLeg: 1 }), flight("b", { stopsLeg: 2 })];
    const { zero } = filterFlights(opts, { maxStops: 0 });
    expect(zero!.detail[0].message).toBe("no nonstop options; fewest stops is 1");
  });

  it("airline miss lists the airlines actually present", () => {
    const opts = [flight("a", { carrier: "DL" }), flight("b", { carrier: "UA" })];
    const { zero } = filterFlights(opts, { airlines: ["AA"] });
    expect(zero!.detail[0].message).toBe("no options on AA; airlines available: DL, UA");
  });

  it("marks a combination when no single filter zeroed the set", () => {
    // Each filter alone keeps something; together they eliminate all.
    const opts = [
      flight("cheap-late", { price: 200, depart: "20:00" }),
      flight("pricey-early", { price: 900, depart: "06:00" }),
    ];
    const { kept, zero } = filterFlights(opts, { maxPrice: 300, departBefore: 8 * 60 });
    expect(kept).toHaveLength(0);
    expect(zero!.combination).toBe(true);
    expect(zero!.eliminatedBy.sort()).toEqual(["depart-before", "max-price"]);
  });

  it("no zero attribution when options survive, or when input was already empty", () => {
    expect(filterFlights([flight("a", { price: 100 })], { maxPrice: 200 }).zero).toBeNull();
    expect(filterFlights([], { maxPrice: 200 }).zero).toBeNull();
    // No active filters → never a filtered-to-zero even with empty input.
    expect(filterFlights([], {}).zero).toBeNull();
  });
});

// ── callouts ─────────────────────────────────────────────────────────────────

describe("flightCallouts", () => {
  it("reports cheapest/fastest/earliest with 1-based display indexes", () => {
    const opts = [
      flight("a", { price: 500, duration: "5h00m", depart: "09:00" }),
      flight("b", { price: 312, duration: "8h00m", depart: "06:15" }),
      flight("c", { price: 400, duration: "4h50m", depart: "07:30" }),
    ];
    const c = flightCallouts(opts);
    expect(c.cheapest).toEqual({ index: 2, price: 312 });
    expect(c.fastest).toMatchObject({ index: 3, durationLabel: "4h50m" });
    expect(c.earliest).toMatchObject({ index: 2, departLabel: "06:15" });
    expect(flightCalloutLine(opts)).toBe("Cheapest: #2 ($312) · Fastest: #3 (4h50m) · Earliest: #2 (06:15)");
  });

  it("ties go to the first in display order", () => {
    const opts = [flight("a", { price: 300 }), flight("b", { price: 300 })];
    expect(flightCallouts(opts).cheapest).toEqual({ index: 1, price: 300 });
  });

  it("omits a callout when its datum is missing entirely", () => {
    const opts = [{ id: "a", name: "a", price: 250, bookingData: { flightToken: "x" } } as RefineOption];
    const c = flightCallouts(opts);
    expect(c.cheapest).toEqual({ index: 1, price: 250 });
    expect(c.fastest).toBeUndefined(); // no duration
    expect(c.earliest).toBeUndefined(); // no leg time
    expect(flightCalloutLine(opts)).toBe("Cheapest: #1 ($250)");
  });

  it("returns an empty line when nothing supports a callout", () => {
    expect(flightCalloutLine([{ id: "a", name: "a", bookingData: {} } as RefineOption])).toBe("");
  });
});

describe("hotelCallouts", () => {
  it("reports cheapest + highest-rated (factual)", () => {
    const opts = [hotel("a", { price: 900, rating: 4.2 }), hotel("b", { price: 540, rating: 4.7 })];
    const c = hotelCallouts(opts);
    expect(c.cheapest).toEqual({ index: 2, price: 540 });
    expect(c.highestRated).toEqual({ index: 2, rating: 4.7 });
    expect(hotelCalloutLine(opts)).toBe("Cheapest: #2 ($540) · Highest rated: #2 (⭐4.7)");
  });
  it("ties go to the first in display order", () => {
    const opts = [hotel("a", { rating: 4.5 }), hotel("b", { rating: 4.5 })];
    expect(hotelCallouts(opts).highestRated).toEqual({ index: 1, rating: 4.5 });
  });
});

// ── hotel filters ────────────────────────────────────────────────────────────

describe("filterHotels", () => {
  const opts = [hotel("a", { price: 900, rating: 4.8 }), hotel("b", { price: 400, rating: 3.5 }), hotel("c", { price: 650, rating: 4.2 })];
  it("--min-rating is inclusive", () => {
    expect(filterHotels(opts, { minRating: 4.2 }).kept.map((o) => o.id)).toEqual(["a", "c"]);
  });
  it("--max-total is inclusive", () => {
    expect(filterHotels(opts, { maxTotal: 650 }).kept.map((o) => o.id)).toEqual(["b", "c"]);
  });
  it("attributes filtered-to-zero with nearest miss (rating)", () => {
    const { zero } = filterHotels(opts, { minRating: 4.9 });
    expect(zero!.detail[0].message).toBe("no hotels rated 4.9 or higher; highest rating is 4.8");
  });
  it("attributes filtered-to-zero with nearest miss (total)", () => {
    const { zero } = filterHotels(opts, { maxTotal: 300 });
    expect(zero!.detail[0].message).toBe("no hotels at or below $300 total; cheapest is $400");
  });
});

// ── facets ───────────────────────────────────────────────────────────────────

describe("flightFacets", () => {
  it("computes price range, airline + stop distribution, nonstop count, depart window", () => {
    const opts = [
      flight("a", { price: 300, carrier: "DL", stopsLeg: 0, depart: "06:15" }),
      flight("b", { price: 500, carrier: "DL", stopsLeg: 1, depart: "09:00" }),
      flight("c", { price: 700, carrier: "AA", stopsLeg: 2, depart: "21:40" }),
    ];
    const f = flightFacets(opts);
    expect(f.priceRange).toEqual({ min: 300, max: 700 });
    expect(f.airlines).toEqual({ DL: 2, AA: 1 }); // desc by count
    expect(f.nonstop).toBe(1);
    expect(f.stops).toEqual({ "0": 1, "1": 1, "2": 1 });
    expect(f.earliestDeparture).toBe("06:15");
    expect(f.latestDeparture).toBe("21:40");
  });
  it("omits facet keys with no supporting data", () => {
    const f = flightFacets([{ id: "a", name: "a", bookingData: {} } as RefineOption]);
    expect(f.priceRange).toBeUndefined();
    expect(f.airlines).toBeUndefined();
    expect(f.stops).toBeUndefined();
    expect(f.earliestDeparture).toBeUndefined();
  });
});

describe("hotelFacets", () => {
  it("computes price + rating ranges and top amenity counts", () => {
    const opts = [
      hotel("a", { price: 900, rating: 4.8, amenities: ["wifi", "pool", "spa"] }),
      hotel("b", { price: 400, rating: 3.5, amenities: ["wifi", "gym"] }),
      hotel("c", { price: 650, rating: 4.2, amenities: ["wifi", "pool"] }),
    ];
    const f = hotelFacets(opts);
    expect(f.priceRange).toEqual({ min: 400, max: 900 });
    expect(f.ratingRange).toEqual({ min: 3.5, max: 4.8 });
    expect(f.amenities!.wifi).toBe(3);
    expect(f.amenities!.pool).toBe(2);
    // Descending by count → wifi first.
    expect(Object.keys(f.amenities!)[0]).toBe("wifi");
  });
});
