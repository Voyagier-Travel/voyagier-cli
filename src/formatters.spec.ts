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
