import { describe, it, expect } from "@jest/globals";
import {
  deriveFlightDetail,
  flightRouteLabel,
  flightStopsLabel,
  flightProjectionFields,
  wallClockTime,
  extractRankScore,
  rankScoreLabel,
  analyzeFlightDuplicates,
  extractFareLabel,
  collapsedAlternatesLabel,
} from "./flight-format.js";

// A realistic (anonymised) booking-data shape: flights[0].flightLegs[].
const twoLeg = {
  flights: [
    {
      flightToken: "TK1",
      flightLegs: [
        { origin: "BWI", destination: "ATL", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T09:20:00", carrier: "DL", flightNumber: "1043" },
        { origin: "ATL", destination: "AUS", departureTime: "2026-06-15T10:10:00", arrivalTime: "2026-06-15T11:05:00", carrier: "DL", flightNumber: "2201" },
      ],
    },
  ],
};

const nonstop = {
  flights: [
    {
      flightLegs: [
        { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T10:05:00", carrier: "WN", flightNumber: 442 },
      ],
    },
  ],
};

describe("wallClockTime", () => {
  it("reads HH:MM straight from an ISO-ish stamp with no timezone math", () => {
    // A +00:00 vs local shift would change the hour — we must NOT convert.
    expect(wallClockTime("2026-06-15T07:15:00")).toBe("07:15");
    expect(wallClockTime("2026-06-15T23:59:00.000Z")).toBe("23:59");
  });

  it("accepts bare clock strings and zero-pads the hour", () => {
    expect(wallClockTime("7:15")).toBe("07:15");
    expect(wallClockTime("07:15:00")).toBe("07:15");
  });

  it("returns null for non-strings and unparseable values", () => {
    expect(wallClockTime(undefined)).toBeNull();
    expect(wallClockTime(715)).toBeNull();
    expect(wallClockTime("morning")).toBeNull();
  });
});

describe("deriveFlightDetail", () => {
  it("projects first-departure → last-arrival across multiple legs", () => {
    const d = deriveFlightDetail(twoLeg)!;
    expect(d.flightNumber).toBe("DL 1043");
    expect(d.origin).toBe("BWI");
    expect(d.destination).toBe("AUS");
    expect(d.departureTime).toBe("07:15");
    expect(d.arrivalTime).toBe("11:05");
    expect(d.stopCount).toBe(1);
    expect(d.connections).toEqual(["ATL"]);
  });

  it("handles a nonstop single leg (numeric flight number)", () => {
    const d = deriveFlightDetail(nonstop)!;
    expect(d.flightNumber).toBe("WN 442");
    expect(d.stopCount).toBe(0);
    expect(d.connections).toEqual([]);
  });

  it("returns null when there is no leg data (older payloads)", () => {
    expect(deriveFlightDetail({ stops: 1, flightToken: "TK" })).toBeNull();
    expect(deriveFlightDetail({ flights: [] })).toBeNull();
    expect(deriveFlightDetail(undefined)).toBeNull();
    expect(deriveFlightDetail("nope")).toBeNull();
  });

  it("degrades field-by-field on partial legs (no times, no flight number)", () => {
    const d = deriveFlightDetail({ flights: [{ flightLegs: [{ origin: "SFO", destination: "JFK" }] }] })!;
    expect(d.origin).toBe("SFO");
    expect(d.destination).toBe("JFK");
    expect(d.departureTime).toBeNull();
    expect(d.arrivalTime).toBeNull();
    expect(d.flightNumber).toBeNull(); // carrier absent → no bare number
    expect(d.stopCount).toBe(0);
  });

  it("reads legs from a top-level flightLegs fallback", () => {
    const d = deriveFlightDetail({ flightLegs: [{ origin: "LAX", destination: "SEA", carrier: "AS", flightNumber: "12" }] })!;
    expect(d.origin).toBe("LAX");
    expect(d.flightNumber).toBe("AS 12");
  });

  // VOY-1784: distinct carriers per segment + return-leg (segmentIndex 1) reads.
  it("collects distinct carriers across a segment's legs", () => {
    expect(deriveFlightDetail(twoLeg)!.carriers).toEqual(["DL"]);
    const mixed = { flights: [{ flightLegs: [
      { origin: "A", destination: "B", carrier: "DL" },
      { origin: "B", destination: "C", carrier: "AA" },
    ] }] };
    expect(deriveFlightDetail(mixed)!.carriers).toEqual(["DL", "AA"]);
  });

  it("reads the return segment from flights[1] via segmentIndex", () => {
    const rt = {
      flights: [
        { flightLegs: [{ origin: "LAX", destination: "NRT", departureTime: "2026-08-01T08:00:00", carrier: "UA" }] },
        { flightLegs: [{ origin: "NRT", destination: "LAX", departureTime: "2026-08-10T20:00:00", carrier: "NH" }] },
      ],
    };
    expect(deriveFlightDetail(rt, 0)!.departureTime).toBe("08:00");
    const ret = deriveFlightDetail(rt, 1)!;
    expect(ret.departureTime).toBe("20:00");
    expect(ret.carriers).toEqual(["NH"]);
    // No flights[1] → null for segment 1 (single-selection round trips).
    expect(deriveFlightDetail(nonstop, 1)).toBeNull();
    // The top-level flightLegs fallback applies to segment 0 only.
    expect(deriveFlightDetail({ flightLegs: [{ origin: "A", destination: "B" }] }, 1)).toBeNull();
  });
});

describe("flightStopsLabel", () => {
  it("says nonstop when direct", () => {
    expect(flightStopsLabel(deriveFlightDetail(nonstop)!)).toBe("nonstop");
  });
  it("lists stop count + connection codes", () => {
    expect(flightStopsLabel(deriveFlightDetail(twoLeg)!)).toBe("1 stop, ATL");
  });
  it("pluralises multiple stops", () => {
    const three = { flights: [{ flightLegs: [
      { origin: "A", destination: "B" }, { origin: "B", destination: "C" }, { origin: "C", destination: "D" },
    ] }] };
    expect(flightStopsLabel(deriveFlightDetail(three)!)).toBe("2 stops, B, C");
  });
});

describe("flightRouteLabel", () => {
  it("renders airports + times + stops", () => {
    expect(flightRouteLabel(deriveFlightDetail(twoLeg)!)).toBe("BWI 07:15 → AUS 11:05 (1 stop, ATL)");
  });
  it("renders nonstop", () => {
    expect(flightRouteLabel(deriveFlightDetail(nonstop)!)).toBe("BWI 07:15 → AUS 10:05 (nonstop)");
  });
  it("drops times when absent but keeps route + stops", () => {
    const d = deriveFlightDetail({ flights: [{ flightLegs: [
      { origin: "SFO", destination: "ORD" }, { origin: "ORD", destination: "JFK" },
    ] }] })!;
    expect(flightRouteLabel(d)).toBe("SFO → JFK (1 stop, ORD)");
  });
});

describe("flightProjectionFields", () => {
  it("emits additive structured fields, compact (only known keys)", () => {
    expect(flightProjectionFields(twoLeg)).toEqual({
      flightNumber: "DL 1043",
      origin: "BWI",
      destination: "AUS",
      departureTime: "07:15",
      arrivalTime: "11:05",
      stops: 1,
      connections: ["ATL"],
    });
  });

  it("omits connections for a nonstop and keeps stops: 0", () => {
    const fields = flightProjectionFields(nonstop);
    expect(fields.stops).toBe(0);
    expect(fields.connections).toBeUndefined();
  });

  it("returns {} when there's no leg detail", () => {
    expect(flightProjectionFields({ stops: 2 })).toEqual({});
  });
});

describe("extractRankScore (VOY-1824, display-only)", () => {
  it("returns the score for a valid finite number", () => {
    expect(extractRankScore({ rankScore: 0.82 })).toBe(0.82);
    expect(extractRankScore({ rankScore: 0 })).toBe(0);
    expect(extractRankScore({ rankScore: 1 })).toBe(1);
  });

  it("passes a value slightly outside 0-1 through as-is (no clamp/reshape)", () => {
    expect(extractRankScore({ rankScore: 1.04 })).toBe(1.04);
    expect(extractRankScore({ rankScore: -0.02 })).toBe(-0.02);
  });

  it("returns undefined for a missing score", () => {
    expect(extractRankScore({})).toBeUndefined();
    expect(extractRankScore({ flights: [] })).toBeUndefined();
  });

  it("returns undefined for a non-finite or non-number score", () => {
    expect(extractRankScore({ rankScore: NaN })).toBeUndefined();
    expect(extractRankScore({ rankScore: Infinity })).toBeUndefined();
    expect(extractRankScore({ rankScore: "0.82" })).toBeUndefined();
    expect(extractRankScore({ rankScore: null })).toBeUndefined();
  });

  it("returns undefined for a null/undefined/non-object blob", () => {
    expect(extractRankScore(undefined)).toBeUndefined();
    expect(extractRankScore(null)).toBeUndefined();
    expect(extractRankScore("nope")).toBeUndefined();
  });

  it("never reads the internal ranking breakdown", () => {
    // rankBreakdown / _rankBreakdown / _rankScore are stripped server-side and
    // must never be surfaced. The helper only ever reads the clean rankScore.
    expect(extractRankScore({ rankBreakdown: { price: 0.4 } })).toBeUndefined();
    expect(extractRankScore({ _rankScore: 0.9 })).toBeUndefined();
  });
});

describe("rankScoreLabel (VOY-1824)", () => {
  it("formats a compact 2-decimal token", () => {
    expect(rankScoreLabel(0.82)).toBe("rank 0.82");
    expect(rankScoreLabel(0.8)).toBe("rank 0.80");
    expect(rankScoreLabel(1)).toBe("rank 1.00");
  });
});

// A flight option shaped like search.ts's SelectOption subset the duplicate
// analysis reads. Same schedule + price across the group unless overridden.
function flightOpt(
  id: string | undefined,
  over: Partial<{ price: number; airline: string; duration: string; bookingData: Record<string, unknown> }> = {},
) {
  return {
    id,
    price: 412,
    airline: "DL",
    duration: "5h50m",
    bookingData: {
      flights: [
        {
          flightLegs: [
            { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T10:05:00", carrier: "DL", flightNumber: "1043" },
          ],
        },
      ],
    },
    ...over,
  };
}

describe("extractFareLabel (VOY-1877)", () => {
  it("reads a fare/product descriptor from the top-level blob", () => {
    expect(extractFareLabel({ fareBrand: "Main Cabin" })).toBe("Main Cabin");
    expect(extractFareLabel({ cabinClass: "Economy" })).toBe("Economy");
  });

  it("falls back to flights[0] and its first leg", () => {
    expect(extractFareLabel({ flights: [{ brandName: "Basic" }] })).toBe("Basic");
    expect(extractFareLabel({ flights: [{ flightLegs: [{ bookingClass: "Y" }] }] })).toBe("Y");
  });

  it("returns null when no fare descriptor is present or the blob is unusable", () => {
    expect(extractFareLabel({ flights: [{ flightLegs: [{ carrier: "DL" }] }] })).toBeNull();
    expect(extractFareLabel(undefined)).toBeNull();
    expect(extractFareLabel("nope")).toBeNull();
    expect(extractFareLabel({ fareBrand: "  " })).toBeNull();
  });
});

describe("collapsedAlternatesLabel (VOY-1877)", () => {
  it("singular vs plural", () => {
    expect(collapsedAlternatesLabel(["opt-2"])).toBe("+1 identical option: opt-2");
    expect(collapsedAlternatesLabel(["opt-2", "opt-3"])).toBe("+2 identical options: opt-2, opt-3");
  });
});

describe("analyzeFlightDuplicates (VOY-1877)", () => {
  it("collapses two indistinguishable options: later folds into the earlier, all retained via markers (4a)", () => {
    const roles = analyzeFlightDuplicates([flightOpt("a"), flightOpt("b")]);
    // Primary keeps its row and names the folded alternate.
    expect(roles[0].collapsed).toBeFalsy();
    expect(roles[0].collapsedAlternates).toEqual(["b"]);
    expect(roles[0].duplicateOfOptionId).toBeUndefined();
    // Duplicate is folded from the render but carries the JSON marker.
    expect(roles[1].collapsed).toBe(true);
    expect(roles[1].duplicateOfOptionId).toBe("a");
  });

  it("folds N alternates into a single primary", () => {
    const roles = analyzeFlightDuplicates([flightOpt("a"), flightOpt("b"), flightOpt("c")]);
    expect(roles[0].collapsedAlternates).toEqual(["b", "c"]);
    expect(roles[1].collapsed).toBe(true);
    expect(roles[2].collapsed).toBe(true);
    expect(roles[2].duplicateOfOptionId).toBe("a");
  });

  it("does NOT collapse options that differ only in price (4b)", () => {
    const roles = analyzeFlightDuplicates([flightOpt("a", { price: 412 }), flightOpt("b", { price: 399 })]);
    expect(roles[0]).toEqual({});
    expect(roles[1]).toEqual({});
  });

  it("does NOT collapse options that differ only in departure/arrival time (4b)", () => {
    const later = flightOpt("b", {
      bookingData: {
        flights: [
          {
            flightLegs: [
              { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T09:15:00", arrivalTime: "2026-06-15T12:05:00", carrier: "DL", flightNumber: "1043" },
            ],
          },
        ],
      },
    });
    const roles = analyzeFlightDuplicates([flightOpt("a"), later]);
    expect(roles[1].collapsed).toBeFalsy();
    expect(roles[1].duplicateOfOptionId).toBeUndefined();
  });

  it("does NOT collapse options that differ only in flight number (same times + price) (4b)", () => {
    const otherFlight = flightOpt("b", {
      bookingData: {
        flights: [
          {
            flightLegs: [
              { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T10:05:00", carrier: "UA", flightNumber: "2201" },
            ],
          },
        ],
      },
    });
    const roles = analyzeFlightDuplicates([flightOpt("a"), otherFlight]);
    expect(roles[0]).toEqual({});
    expect(roles[1]).toEqual({});
  });

  it("annotates (does not collapse) when a fare difference IS detectable", () => {
    const a = flightOpt("a", { bookingData: { fareBrand: "Main Cabin", flights: flightOpt("a").bookingData.flights } });
    const b = flightOpt("b", { bookingData: { fareBrand: "Basic Economy", flights: flightOpt("b").bookingData.flights } });
    const roles = analyzeFlightDuplicates([a, b]);
    // Both rows kept and annotated with their own fare.
    expect(roles[0].collapsed).toBeFalsy();
    expect(roles[0].annotate).toBe("Main Cabin");
    expect(roles[1].collapsed).toBeFalsy();
    expect(roles[1].annotate).toBe("Basic Economy");
    // Still flagged as display-identical in the machine surface.
    expect(roles[1].duplicateOfOptionId).toBe("a");
  });

  it("collapses when identical-schedule rows share the same fare (indistinguishable)", () => {
    const a = flightOpt("a", { bookingData: { fareBrand: "Main Cabin", flights: flightOpt("a").bookingData.flights } });
    const b = flightOpt("b", { bookingData: { fareBrand: "Main Cabin", flights: flightOpt("b").bookingData.flights } });
    const roles = analyzeFlightDuplicates([a, b]);
    expect(roles[1].collapsed).toBe(true);
    expect(roles[0].collapsedAlternates).toEqual(["b"]);
  });

  it("never collapses a float-artifact price apart from an exact-cents twin", () => {
    // 412.10 stored as a dirty float must still match a clean 412.10 sibling.
    const roles = analyzeFlightDuplicates([flightOpt("a", { price: 412.1 }), flightOpt("b", { price: 412.10000000000002 })]);
    expect(roles[1].collapsed).toBe(true);
    expect(roles[1].duplicateOfOptionId).toBe("a");
  });

  it("leaves options without an id as separate rows (nothing to reference)", () => {
    const roles = analyzeFlightDuplicates([flightOpt(undefined), flightOpt(undefined)]);
    expect(roles[0]).toEqual({});
    expect(roles[1]).toEqual({});
  });

  it("does not dedup rows too sparse to compare (no price)", () => {
    const roles = analyzeFlightDuplicates([
      { id: "a", airline: "DL", bookingData: {} },
      { id: "b", airline: "DL", bookingData: {} },
    ]);
    expect(roles[0]).toEqual({});
    expect(roles[1]).toEqual({});
  });
});
