import { describe, it, expect } from "@jest/globals";
import {
  deriveFlightDetail,
  flightRouteLabel,
  flightStopsLabel,
  flightProjectionFields,
  wallClockTime,
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
