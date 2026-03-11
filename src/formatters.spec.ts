import { describe, it, expect } from "@jest/globals";
import { formatFlights, formatHotels } from "./formatters.js";

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
});

describe("formatHotels", () => {
  it("should format a single hotel option", () => {
    const output = stripAnsi(formatHotels([
      { name: "W Punta Cana", price: 450 },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("W Punta Cana");
    expect(output).toContain("$450.00/night");
  });

  it("should format multiple hotels", () => {
    const output = stripAnsi(formatHotels([
      { name: "Budget Inn", price: 89 },
      { name: "Grand Resort", price: 1200 },
    ]));
    expect(output).toContain("[1]");
    expect(output).toContain("$89.00/night");
    expect(output).toContain("[2]");
    expect(output).toContain("$1,200.00/night");
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
});
