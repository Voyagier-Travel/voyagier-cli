import { describe, it, expect } from "@jest/globals";
import { agentFlightOptions, agentHotelOptions } from "./agent-output.js";

describe("agentFlightOptions", () => {
  it("should return numbered list with all fields", () => {
    const output = agentFlightOptions([
      { airline: "United", duration: "5h 30m", price: 423 },
      { airline: "Delta", duration: "6h 15m", price: 389 },
    ]);
    expect(output).toContain("1. United · 5h 30m · $423.00/pp");
    expect(output).toContain("2. Delta · 6h 15m · $389.00/pp");
  });

  it("should handle missing fields gracefully", () => {
    const output = agentFlightOptions([{ price: 200 }]);
    expect(output).toContain("1. $200.00/pp");
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
  it("should return numbered list with names and prices", () => {
    const output = agentHotelOptions([
      { name: "Marriott Monterey", price: 2362.45 },
      { name: "Hilton Garden Inn", price: 189.99 },
    ]);
    expect(output).toContain("1. Marriott Monterey · $2,362.45/night");
    expect(output).toContain("2. Hilton Garden Inn · $189.99/night");
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
