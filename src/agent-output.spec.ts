import { describe, it, expect } from "@jest/globals";
import { agentFlightOptions, agentHotelOptions, agentActivityOptions } from "./agent-output.js";

describe("agentFlightOptions", () => {
  it("shows the fare without a misleading /pp per-person suffix (VOY-1724)", () => {
    const output = agentFlightOptions([
      { airline: "United", duration: "5h 30m", price: 423 },
      { airline: "Delta", duration: "6h 15m", price: 389 },
    ]);
    expect(output).toContain("1. United · 5h 30m · $423.00");
    expect(output).toContain("2. Delta · 6h 15m · $389.00");
    expect(output).not.toContain("/pp");
  });

  it("should handle missing fields gracefully", () => {
    const output = agentFlightOptions([{ price: 200 }]);
    expect(output).toContain("1. $200.00");
    expect(output).not.toContain("undefined");
  });

  it("should handle missing price", () => {
    const output = agentFlightOptions([{ airline: "AA", duration: "3h" }]);
    expect(output).toContain("1. AA · 3h");
    expect(output).not.toContain("/pp");
  });

  it("should return placeholder for empty list", () => {
    const output = agentFlightOptions([]);
    expect(output).toContain("No flights found");
  });

  it("renders decision-grade leg detail when present (VOY-1783)", () => {
    const output = agentFlightOptions([{
      airline: "Delta", duration: "5h50m", price: 412,
      bookingData: { flights: [{ flightLegs: [
        { origin: "BWI", destination: "ATL", departureTime: "2026-06-15T07:15:00", carrier: "DL", flightNumber: "1043" },
        { origin: "ATL", destination: "AUS", arrivalTime: "2026-06-15T10:05:00", carrier: "DL", flightNumber: "2201" },
      ] }] },
    }]);
    expect(output).toBe("1. DL 1043 · BWI 07:15 → AUS 10:05 (1 stop, ATL) · 5h50m · $412.00");
  });

  it("falls back to airline · duration · price without leg data (VOY-1783)", () => {
    const output = agentFlightOptions([{ airline: "United", duration: "5h 30m", price: 423 }]);
    expect(output).toBe("1. United · 5h 30m · $423.00");
  });

  it("appends a plain rank token when rankScore is present (VOY-1824)", () => {
    const output = agentFlightOptions([
      { airline: "United", duration: "5h 30m", price: 423, bookingData: { rankScore: 0.82 } },
    ]);
    expect(output).toBe("1. United · 5h 30m · $423.00 · rank 0.82");
  });

  it("renders nothing extra when rankScore is absent (VOY-1824)", () => {
    const output = agentFlightOptions([{ airline: "United", duration: "5h 30m", price: 423 }]);
    expect(output).not.toContain("· rank");
  });

  it("collapses an indistinguishable duplicate and notes the alternate (VOY-1877)", () => {
    const legs = { flights: [{ flightLegs: [
      { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T10:05:00", carrier: "DL", flightNumber: "1043" },
    ] }] };
    const output = agentFlightOptions([
      { id: "opt-a", airline: "DL", duration: "2h50m", price: 412, bookingData: legs },
      { id: "opt-b", airline: "DL", duration: "2h50m", price: 412, bookingData: legs },
    ]);
    // Second row folded away; the first notes the identical alternate.
    expect(output).toContain("1.");
    expect(output).not.toMatch(/^2\./m);
    expect(output).toContain("+1 identical option: opt-b");
  });

  it("annotates fares instead of collapsing when a difference is detectable (VOY-1877)", () => {
    const legs = { flights: [{ flightLegs: [
      { origin: "BWI", destination: "AUS", departureTime: "2026-06-15T07:15:00", arrivalTime: "2026-06-15T10:05:00", carrier: "DL", flightNumber: "1043" },
    ] }] };
    const output = agentFlightOptions([
      { id: "opt-a", airline: "DL", duration: "2h50m", price: 412, bookingData: { ...legs, fareBrand: "Main Cabin" } },
      { id: "opt-b", airline: "DL", duration: "2h50m", price: 412, bookingData: { ...legs, fareBrand: "Basic Economy" } },
    ]);
    expect(output).toMatch(/^2\./m);
    expect(output).toContain("fare: Main Cabin");
    expect(output).toContain("fare: Basic Economy");
  });
});

describe("agentHotelOptions", () => {
  it("renders prices as STAY TOTALS, not per-night (VOY-1724)", () => {
    const output = agentHotelOptions([
      { name: "Marriott Monterey", price: 2362.45 },
      { name: "Hilton Garden Inn", price: 189.99 },
    ]);
    expect(output).toContain("1. Marriott Monterey · from $2,362.45 total");
    expect(output).toContain("2. Hilton Garden Inn · from $189.99 total");
    expect(output).not.toContain("/night");
  });

  it("adds nights + per-night when the option carries check-in/out dates (VOY-1724)", () => {
    const output = agentHotelOptions([
      {
        name: "Holiday Inn",
        price: 531.1,
        bookingData: { searchQuery: { checkInDate: "2026-09-10", checkOutDate: "2026-09-14" } },
      },
    ]);
    // 4 nights, 531.10/4 = 132.775 → ~$133/nt
    expect(output).toContain("1. Holiday Inn · from $531.10 total · 4 nights (~$133/nt)");
  });

  it("should handle missing price", () => {
    const output = agentHotelOptions([{ name: "Mystery Hotel" }]);
    expect(output).toContain("1. Mystery Hotel");
    expect(output).not.toContain("/night");
  });

  it("shows rating + amenities between name and stay total (VOY-1783)", () => {
    const output = agentHotelOptions([{
      name: "Hotel Van Zandt",
      price: 890,
      bookingData: {
        rating: 4.5,
        amenities: ["pool", "spa"],
        searchQuery: { checkInDate: "2026-09-10", checkOutDate: "2026-09-13" },
      },
    }]);
    expect(output).toBe("1. Hotel Van Zandt · ⭐4.5 · pool, spa · from $890.00 total · 3 nights (~$297/nt)");
  });

  it("should return placeholder for empty list", () => {
    const output = agentHotelOptions([]);
    expect(output).toContain("No hotels found");
  });
});

describe("agentActivityOptions", () => {
  it("should return numbered list with name, price, and duration", () => {
    const output = agentActivityOptions([
      { name: "Snorkel Tour", price: 89.99, duration: "3h" },
      { name: "Helicopter Ride", price: 299, duration: "1h" },
    ]);
    expect(output).toContain("1. Snorkel Tour");
    expect(output).toContain("$89.99");
    expect(output).toContain("3h");
    expect(output).toContain("2. Helicopter Ride");
  });

  it("should handle missing price", () => {
    const output = agentActivityOptions([{ name: "Walking Tour", duration: "2h" }]);
    expect(output).toContain("1. Walking Tour");
    expect(output).toContain("2h");
  });

  it("should handle missing duration", () => {
    const output = agentActivityOptions([{ name: "Kayak Rental", price: 45 }]);
    expect(output).toContain("1. Kayak Rental");
    expect(output).toContain("$45.00");
  });

  it("should return placeholder for empty list", () => {
    const output = agentActivityOptions([]);
    expect(output).toContain("No activities found");
  });
});
