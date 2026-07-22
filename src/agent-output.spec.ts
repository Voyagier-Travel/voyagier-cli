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
