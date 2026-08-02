import { describe, it, expect } from "@jest/globals";
import { formatFlights, formatHotels, formatActivities } from "./formatters.js";

// Strip ANSI color codes for assertion clarity
const stripAnsi = (str: string) => str.replace(/\u001b\[[0-9;]*m/g, "");

describe("formatFlights", () => {
  it("should format a single flight option", () => {
    const output = stripAnsi(formatFlights([
      { name: "AA100 JFK→LAX", price: 350, airline: "American Airlines", duration: "5h 30m" },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("American Airlines");
    expect(output).toContain("$350.00");
    expect(output).toContain("5h 30m");
  });

  it("should format multiple options with sequential indices", () => {
    const output = stripAnsi(formatFlights([
      { name: "Flight A", price: 100 },
      { name: "Flight B", price: 200 },
      { name: "Flight C", price: 300 },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("[2]");
    expect(output).toContain("[3]");
  });

  it("should show time on a separate line", () => {
    const output = stripAnsi(formatFlights([
      { name: "UA200", time: "08:30 AM - 11:00 AM" },
    ]));
    expect(output).toContain("08:30 AM - 11:00 AM");
  });

  it("should handle missing optional fields gracefully", () => {
    const output = stripAnsi(formatFlights([
      { name: "Basic Flight" },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("Basic Flight");
    expect(output).not.toContain("$");
    expect(output).not.toContain("undefined");
  });

  it("should return empty string for empty array", () => {
    expect(formatFlights([])).toBe("");
  });

  describe("VOY-1783 leg detail", () => {
    const legged = {
      name: "flight",
      price: 412,
      airline: "Delta",
      duration: "5h50m",
      bookingData: {
        flights: [{ flightLegs: [
          { origin: "BWI", destination: "ATL", departureTime: "2026-06-15T07:15:00", carrier: "DL", flightNumber: "1043" },
          { origin: "ATL", destination: "AUS", arrivalTime: "2026-06-15T10:05:00", carrier: "DL", flightNumber: "2201" },
        ] }],
      },
    };

    it("renders flight number, timed route, and stops with connection", () => {
      const out = stripAnsi(formatFlights([legged]));
      expect(out).toContain("DL 1043");
      expect(out).toContain("BWI 07:15 → AUS 10:05 (1 stop, ATL)");
      expect(out).toContain("$412.00");
      expect(out).toContain("5h50m");
      expect(out).not.toContain("undefined");
    });

    it("suppresses the legacy time line when leg detail carries times", () => {
      const out = stripAnsi(formatFlights([{ ...legged, time: "7:15 AM" }]));
      expect(out).toContain("BWI 07:15");
      expect(out).not.toContain("7:15 AM");
    });

    it("keeps the legacy time line when leg detail has no times", () => {
      const out = stripAnsi(formatFlights([{
        name: "x", price: 200, airline: "WN", time: "7:15 AM",
        bookingData: { flights: [{ flightLegs: [
          { origin: "SFO", destination: "JFK", carrier: "WN", flightNumber: "442" },
        ] }] },
      }]));
      expect(out).toContain("7:15 AM");
    });

    it("says nonstop for a direct leg", () => {
      const out = stripAnsi(formatFlights([{
        name: "x", price: 200, airline: "WN",
        bookingData: { flights: [{ flightLegs: [
          { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T10:05:00", carrier: "WN", flightNumber: "442" },
        ] }] },
      }]));
      expect(out).toContain("WN 442");
      expect(out).toContain("BWI 07:15 → AUS 10:05 (nonstop)");
    });
  });
});

describe("formatHotels", () => {
  it("renders price as a STAY TOTAL, not per-night (VOY-1724)", () => {
    const output = stripAnsi(formatHotels([
      { name: "W Punta Cana", price: 450 },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("W Punta Cana");
    expect(output).toContain("from $450.00 total");
    expect(output).not.toContain("/night");
  });

  it("adds nights + per-night when dates are present (VOY-1724)", () => {
    const output = stripAnsi(formatHotels([
      {
        name: "W Punta Cana",
        price: 450,
        bookingData: { searchQuery: { checkInDate: "2026-09-10", checkOutDate: "2026-09-13" } },
      },
    ]));
    // 3 nights, 450/3 = 150 → ~$150/nt
    expect(output).toContain("from $450.00 total · 3 nights (~$150/nt)");
  });

  it("should format multiple hotels", () => {
    const output = stripAnsi(formatHotels([
      { name: "Budget Inn", price: 89 },
      { name: "Grand Resort", price: 1200 },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("from $89.00 total");
    expect(output).toContain("[2]");
    expect(output).toContain("from $1,200.00 total");
  });

  it("should handle missing price", () => {
    const output = stripAnsi(formatHotels([
      { name: "Mystery Hotel" },
    ]));
    expect(output).toContain("Mystery Hotel");
    expect(output).not.toContain("$");
    expect(output).not.toContain("undefined");
  });

  it("should return empty string for empty array", () => {
    expect(formatHotels([])).toBe("");
  });

  it("shows rating + amenities alongside the stay total (VOY-1783)", () => {
    const output = stripAnsi(formatHotels([
      {
        name: "Hotel Van Zandt",
        price: 890,
        bookingData: {
          rating: 4.5,
          amenities: ["pool", "spa"],
          searchQuery: { checkInDate: "2026-09-10", checkOutDate: "2026-09-13" },
        },
      },
    ]));
    expect(output).toContain("Hotel Van Zandt");
    expect(output).toContain("⭐4.5");
    expect(output).toContain("pool, spa");
    expect(output).toContain("from $890.00 total · 3 nights");
    expect(output).not.toContain("undefined");
  });

  describe("flight route extraction", () => {
    it("shows route from bookingData.searchQuery", () => {
      const result = formatFlights([{
        name: "BWI to BWI",
        price: 500,
        airline: "DL",
        bookingData: { searchQuery: { origin: "BWI", destination: "SJU" } },
      }]);
      expect(result).toContain("BWI to SJU");
      expect(result).not.toContain("BWI to BWI");
    });

    it("falls back to name when no searchQuery", () => {
      const result = formatFlights([{
        name: "LAX to NRT",
        price: 1200,
        airline: "AA",
      }]);
      expect(result).toContain("LAX to NRT");
    });

    it("falls back to name when searchQuery is malformed", () => {
      const result = formatFlights([{
        name: "JFK to LHR",
        price: 800,
        bookingData: { searchQuery: "not an object" },
      }]);
      expect(result).toContain("JFK to LHR");
    });
  });

});

describe("formatActivities", () => {
  const stripAnsi = (str: string) => str.replace(/\u001b\[[0-9;]*m/g, "");

  it("should format activity with price and duration", () => {
    const result = stripAnsi(formatActivities([{ name: "Snorkel Tour", price: 89.99, duration: "3h" }]));
    expect(result).toContain("[1]");
    expect(result).toContain("Snorkel Tour");
    expect(result).toContain("$89.99");
    expect(result).toContain("3h");
    expect(result).toContain("🎯");
  });

  it("should handle missing price", () => {
    const result = stripAnsi(formatActivities([{ name: "Walking Tour", duration: "2h" }]));
    expect(result).toContain("Walking Tour");
    expect(result).toContain("2h");
  });

  it("should handle missing duration", () => {
    const result = stripAnsi(formatActivities([{ name: "Kayak Rental", price: 45 }]));
    expect(result).toContain("Kayak Rental");
    expect(result).toContain("$45.00");
  });

  it("should return empty string for empty array", () => {
    expect(formatActivities([])).toBe("");
  });
});
