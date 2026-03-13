import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { extractFlightToken, buildFlightSummary, buildHotelSummary, formatPrice, validateDate, validateIata, findPendingSubSelections, subSelectionLabel, deriveBaseUrl, openBrowser, warnPastDate, looksLikeAirportCode } from "./utils.js";

describe("extractFlightToken", () => {
  it("should return undefined when bookingData is undefined", () => {
    expect(extractFlightToken(undefined)).toBeUndefined();
  });

  it("should return undefined when bookingData is empty", () => {
    expect(extractFlightToken({})).toBeUndefined();
  });

  it("should extract flightToken from nested flights array", () => {
    const bookingData = { flights: [{ flightToken: "tok_abc123" }] };
    expect(extractFlightToken(bookingData)).toBe("tok_abc123");
  });

  it("should extract flightToken from top-level", () => {
    expect(extractFlightToken({ flightToken: "tok_top" })).toBe("tok_top");
  });

  it("should fall back to priceToken", () => {
    expect(extractFlightToken({ priceToken: "price_456" })).toBe("price_456");
  });

  it("should prefer nested flights array over top-level", () => {
    const data = { flights: [{ flightToken: "nested" }], flightToken: "top" };
    expect(extractFlightToken(data)).toBe("nested");
  });

  it("should skip flights array when flightToken missing in first element", () => {
    const data = { flights: [{ other: "value" }], flightToken: "fallback" };
    expect(extractFlightToken(data)).toBe("fallback");
  });

  it("should skip non-string flightToken values", () => {
    expect(extractFlightToken({ flightToken: 12345 })).toBeUndefined();
  });

  it("should handle empty flights array", () => {
    expect(extractFlightToken({ flights: [] })).toBeUndefined();
  });
});

describe("buildFlightSummary", () => {
  it("should build summary with origin and destination", () => {
    const result = buildFlightSummary(
      { name: "AA100", price: 450, airline: "American Airlines", duration: "5h 30m" },
      "LAX", "NRT"
    );
    expect(result).toBe("LAX→NRT · American Airlines · $450.00 · 5h 30m");
  });

  it("should fall back to name when no origin/destination", () => {
    expect(buildFlightSummary({ name: "AA100" })).toBe("AA100");
  });

  it("should format price correctly", () => {
    expect(buildFlightSummary({ name: "DL200", price: 1234.5 })).toBe("DL200 · $1,234.50");
  });

  it("should handle zero price", () => {
    expect(buildFlightSummary({ name: "Test", price: 0 })).toBe("Test · $0.00");
  });
});

describe("buildHotelSummary", () => {
  it("should build summary with name and price", () => {
    expect(buildHotelSummary({ name: "W Punta Cana", price: 350 })).toBe("W Punta Cana · $350.00/night");
  });

  it("should return just name when no price", () => {
    expect(buildHotelSummary({ name: "Hostel X" })).toBe("Hostel X");
  });
});

describe("formatPrice", () => {
  it("should format whole numbers", () => {
    expect(formatPrice(100)).toBe("$100.00");
  });

  it("should format with commas for thousands", () => {
    expect(formatPrice(1234)).toBe("$1,234.00");
  });

  it("should format with two decimal places", () => {
    expect(formatPrice(1234.5)).toBe("$1,234.50");
  });

  it("should round to two decimal places", () => {
    expect(formatPrice(99.999)).toBe("$100.00");
  });

  it("should handle zero", () => {
    expect(formatPrice(0)).toBe("$0.00");
  });

  it("should handle large numbers", () => {
    expect(formatPrice(1000000)).toBe("$1,000,000.00");
  });
});

describe("validateDate", () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("should accept valid dates", () => {
    validateDate("2026-04-15", "--date");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should accept boundary dates", () => {
    validateDate("2026-01-01", "--date");
    validateDate("2026-12-31", "--date");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should reject non-date strings", () => {
    validateDate("banana", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = String((stderrSpy.mock.calls[0] as any[])[0]);
    expect(output).toContain("banana");
    expect(output).toContain("--date");
  });

  it("should reject invalid format (slashes)", () => {
    validateDate("2026/04/15", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject month 13", () => {
    validateDate("2026-13-01", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject month 0", () => {
    validateDate("2026-00-15", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject day 0", () => {
    validateDate("2026-01-00", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject day 32", () => {
    validateDate("2026-01-32", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject Feb 30", () => {
    validateDate("2026-02-30", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject Feb 29 in non-leap year", () => {
    validateDate("2025-02-29", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should accept Feb 29 in leap year", () => {
    validateDate("2024-02-29", "--date");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should reject Apr 31", () => {
    validateDate("2026-04-31", "--date");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("validateIata", () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("should accept valid uppercase IATA codes", () => {
    validateIata("LAX", "--from");
    validateIata("NRT", "--to");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should accept lowercase (case-insensitive)", () => {
    validateIata("lax", "--from");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("should reject codes that are too short", () => {
    validateIata("LA", "--from");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject codes that are too long", () => {
    validateIata("LAXXX", "--from");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject codes with numbers", () => {
    validateIata("L4X", "--from");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should reject empty string", () => {
    validateIata("", "--from");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("should include flag name in error message", () => {
    validateIata("X", "--to");
    const output = String((stderrSpy.mock.calls[0] as any[])[0]);
    expect(output).toContain("--to");
  });
});

describe("findPendingSubSelections", () => {

  it("returns empty array when no items", () => {
    expect(findPendingSubSelections([])).toEqual([]);
  });

  it("returns empty array when no sub-selections exist", () => {
    const items = [{
      id: "item1",
      title: "Flight",
      selection: { selectedOption: { subSelections: [] } },
    }];
    expect(findPendingSubSelections(items as any)).toEqual([]);
  });

  it("returns pending sub-selections (no selectedOptionId)", () => {
    const items = [{
      id: "item1",
      title: "Flight JFK→NRT",
      selection: {
        id: "sel1",
        isLocked: false,
        selectedOption: {
          id: "opt1",
          name: "AA175",
          price: 500,
          status: "ACTIVE",
          subSelections: [{
            id: "sub1",
            type: "FLIGHT_CLASS",
            options: [{ id: "opt1" }],
          }],
        },
      },
    }];
    const result = findPendingSubSelections(items as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      itemTitle: "Flight JFK→NRT",
      parentOptionName: "AA175",
      subSelectionType: "FLIGHT_CLASS",
      subSelectionId: "sub1",
      optionCount: 1,
    });
  });

  it("skips sub-selections that already have a selectedOptionId", () => {
    const items = [{
      id: "item1",
      title: "Hotel",
      selection: {
        id: "sel1",
        isLocked: false,
        selectedOption: {
          id: "opt1",
          name: "Park Hyatt",
          price: 300,
          status: "ACTIVE",
          subSelections: [{
            id: "sub1",
            type: "HOTEL_ROOM",
            selectedOptionId: "opt1",
            options: [{ id: "opt1" }, { id: "opt2" }],
          }],
        },
      },
    }];
    expect(findPendingSubSelections(items as any)).toEqual([]);
  });

  it("handles items with no selection", () => {
    const items = [{ id: "item1", title: "Tour", selection: null }];
    expect(findPendingSubSelections(items as any)).toEqual([]);
  });
});

describe("subSelectionLabel", () => {

  it("returns human-readable label for FLIGHT_CLASS", () => {
    expect(subSelectionLabel("FLIGHT_CLASS")).toBe("cabin class");
  });

  it("returns human-readable label for HOTEL_ROOM", () => {
    expect(subSelectionLabel("HOTEL_ROOM")).toBe("room type");
  });

  it("lowercases and formats unknown types", () => {
    expect(subSelectionLabel("ACTIVITY_BOOKABLE_ITEM")).toBe("activity option");
  });
});

describe("deriveBaseUrl", () => {

  it("strips /graphql suffix", () => {
    expect(deriveBaseUrl("https://voyagier.com/graphql")).toBe("https://voyagier.com");
  });

  it("strips /api suffix", () => {
    expect(deriveBaseUrl("https://dev.voyagier.com/api")).toBe("https://dev.voyagier.com");
  });

  it("strips trailing slash", () => {
    expect(deriveBaseUrl("https://voyagier.com/")).toBe("https://voyagier.com");
  });

  it("passes through clean URLs", () => {
    expect(deriveBaseUrl("https://voyagier.com")).toBe("https://voyagier.com");
  });

  it("handles dev URLs", () => {
    expect(deriveBaseUrl("https://dev.voyagier.com")).toBe("https://dev.voyagier.com");
  });

  it("handles malformed URLs gracefully", () => {
    expect(deriveBaseUrl("not-a-url")).toBe("https://voyagier.com");
  });
});

describe("looksLikeAirportCode", () => {
  it("returns true for 3-letter uppercase codes", () => {
    expect(looksLikeAirportCode("BKI")).toBe(true);
    expect(looksLikeAirportCode("KUL")).toBe(true);
    expect(looksLikeAirportCode("LAX")).toBe(true);
  });

  it("returns true for 3-letter lowercase codes", () => {
    expect(looksLikeAirportCode("bki")).toBe(true);
    expect(looksLikeAirportCode("lax")).toBe(true);
  });

  it("returns true for 3-letter mixed-case codes", () => {
    expect(looksLikeAirportCode("Bki")).toBe(true);
  });

  it("returns false for city names", () => {
    expect(looksLikeAirportCode("Kota Kinabalu")).toBe(false);
    expect(looksLikeAirportCode("Sabah")).toBe(false);
    expect(looksLikeAirportCode("Kuala Lumpur")).toBe(false);
  });

  it("returns false for strings longer than 3 letters", () => {
    expect(looksLikeAirportCode("LAXXX")).toBe(false);
    expect(looksLikeAirportCode("Bali")).toBe(false);
  });

  it("returns false for strings shorter than 3 letters", () => {
    expect(looksLikeAirportCode("LA")).toBe(false);
    expect(looksLikeAirportCode("")).toBe(false);
  });

  it("returns false for codes containing digits", () => {
    expect(looksLikeAirportCode("B1I")).toBe(false);
  });

  it("ignores surrounding whitespace", () => {
    expect(looksLikeAirportCode("  BKI  ")).toBe(true);
  });
});

describe("openBrowser", () => {

  it("does not throw on any platform", () => {
    // openBrowser swallows errors — just verify it doesn't throw
    expect(() => openBrowser("https://example.com")).not.toThrow();
  });

  describe("warnPastDate", () => {
    let stderrSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("warns on past date", () => {
      warnPastDate("2020-01-01", "--date");
      expect(stderrSpy).toHaveBeenCalled();
    });

    it("does not warn on future date", () => {
      warnPastDate("2099-12-31", "--date");
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

});
