import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  sanitizeExternalText,
  sanitizeExternalData,
  extractFlightToken,
  buildFlightSummary,
  buildHotelSummary,
  buildActivitySummary,
  formatPrice,
  validateDate,
  validateIata,
  subSelectionLabel,
  deriveBaseUrl,
  openBrowser,
  warnPastDate,
  looksLikeAirportCode,
  parsePositiveInt,
  parseFloatStrict,
  formatNullableBool,
  escapeMdTableCell,
} from "./utils.js";
import { CliError } from "./errors.js";

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
  it("should accept valid dates", () => {
    expect(() => validateDate("2026-04-15", "--date")).not.toThrow();
  });

  it("should accept boundary dates", () => {
    expect(() => validateDate("2026-01-01", "--date")).not.toThrow();
    expect(() => validateDate("2026-12-31", "--date")).not.toThrow();
  });

  it("should reject non-date strings", () => {
    expect(() => validateDate("banana", "--date")).toThrow(/banana/);
    expect(() => validateDate("banana", "--date")).toThrow(/--date/);
  });

  it("should reject invalid format (slashes)", () => {
    expect(() => validateDate("2026/04/15", "--date")).toThrow();
  });

  it("should reject month 13", () => {
    expect(() => validateDate("2026-13-01", "--date")).toThrow();
  });

  it("should reject month 0", () => {
    expect(() => validateDate("2026-00-15", "--date")).toThrow();
  });

  it("should reject day 0", () => {
    expect(() => validateDate("2026-01-00", "--date")).toThrow();
  });

  it("should reject day 32", () => {
    expect(() => validateDate("2026-01-32", "--date")).toThrow();
  });

  it("should reject Feb 30", () => {
    expect(() => validateDate("2026-02-30", "--date")).toThrow();
  });

  it("should reject Feb 29 in non-leap year", () => {
    expect(() => validateDate("2025-02-29", "--date")).toThrow();
  });

  it("should accept Feb 29 in leap year", () => {
    expect(() => validateDate("2024-02-29", "--date")).not.toThrow();
  });

  it("should reject Apr 31", () => {
    expect(() => validateDate("2026-04-31", "--date")).toThrow();
  });
});

describe("validateIata", () => {
  it("should accept valid uppercase IATA codes", () => {
    expect(() => validateIata("LAX", "--from")).not.toThrow();
    expect(() => validateIata("NRT", "--to")).not.toThrow();
  });

  it("should accept lowercase (case-insensitive)", () => {
    expect(() => validateIata("lax", "--from")).not.toThrow();
  });

  it("should reject codes that are too short", () => {
    expect(() => validateIata("LA", "--from")).toThrow();
  });

  it("should reject codes that are too long", () => {
    expect(() => validateIata("LAXXX", "--from")).toThrow();
  });

  it("should reject codes with numbers", () => {
    expect(() => validateIata("L4X", "--from")).toThrow();
  });

  it("should reject empty string", () => {
    expect(() => validateIata("", "--from")).toThrow();
  });

  it("should include flag name in error message", () => {
    expect(() => validateIata("X", "--to")).toThrow(/--to/);
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
    expect(deriveBaseUrl("not-a-url")).toBe("https://travel.voyagier.com");
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

  describe("buildActivitySummary", () => {
    it("should build summary with name, price, and duration", () => {
      expect(buildActivitySummary({ name: "Snorkel Tour", price: 89.99, duration: "3h" }))
        .toBe("Snorkel Tour · $89.99 · 3h");
    });

    it("should build summary with name only", () => {
      expect(buildActivitySummary({ name: "Walking Tour" }))
        .toBe("Walking Tour");
    });

    it("should build summary with name and price", () => {
      expect(buildActivitySummary({ name: "Kayak Rental", price: 45 }))
        .toBe("Kayak Rental · $45.00");
    });

    it("should build summary with name and duration", () => {
      expect(buildActivitySummary({ name: "Hiking Guide", duration: "5h" }))
        .toBe("Hiking Guide · 5h");
    });

    it("should format large prices correctly", () => {
      expect(buildActivitySummary({ name: "Helicopter Tour", price: 1234.5 }))
        .toBe("Helicopter Tour · $1,234.50");
    });

    it("should not include /night suffix", () => {
      const summary = buildActivitySummary({ name: "Sunset Cruise", price: 150 });
      expect(summary).not.toContain("/night");
    });
  });

});

describe("parsePositiveInt — default contract validation", () => {
  it("returns the default when value is undefined and default is valid", () => {
    expect(parsePositiveInt(undefined, "--limit", { default: 20 })).toBe(20);
  });

  it("throws when default is 0 but allowZero is false", () => {
    expect(() => parsePositiveInt(undefined, "--limit", { default: 0 })).toThrow(
      /invalid default 0/
    );
  });

  it("accepts default 0 when allowZero is true", () => {
    expect(parsePositiveInt(undefined, "--ranking", { default: 0, allowZero: true })).toBe(0);
  });

  it("throws when default is negative", () => {
    expect(() => parsePositiveInt(undefined, "--limit", { default: -5 })).toThrow(
      /invalid default -5/
    );
  });

  it("throws when default exceeds max", () => {
    expect(() => parsePositiveInt(undefined, "--limit", { default: 200, max: 100 })).toThrow(
      /invalid default 200/
    );
  });

  it("throws when default is not an integer", () => {
    expect(() => parsePositiveInt(undefined, "--limit", { default: 3.14 })).toThrow(
      /invalid default 3.14/
    );
  });

  it("returns undefined when value and default are both undefined", () => {
    expect(parsePositiveInt(undefined, "--limit")).toBeUndefined();
  });
});

describe("parseFloatStrict — bounds enforcement", () => {
  it("accepts a value within [min, max]", () => {
    expect(parseFloatStrict("48.85", "--lat", { min: -90, max: 90 })).toBeCloseTo(48.85);
  });

  it("rejects a value below min", () => {
    expect(() => parseFloatStrict("-100", "--lat", { min: -90, max: 90 })).toThrow(CliError);
  });

  it("rejects a value above max", () => {
    expect(() => parseFloatStrict("200", "--lng", { min: -180, max: 180 })).toThrow(CliError);
  });

  it("accepts boundary values", () => {
    expect(parseFloatStrict("-90", "--lat", { min: -90, max: 90 })).toBe(-90);
    expect(parseFloatStrict("90", "--lat", { min: -90, max: 90 })).toBe(90);
  });

  it("rejects negative values when nonNegative is true", () => {
    expect(() => parseFloatStrict("-500", "--radius", { nonNegative: true })).toThrow(CliError);
  });

  it("accepts 0 and positive values when nonNegative is true", () => {
    expect(parseFloatStrict("0", "--radius", { nonNegative: true })).toBe(0);
    expect(parseFloatStrict("500", "--radius", { nonNegative: true })).toBe(500);
  });

  it("returns undefined when value is undefined", () => {
    expect(parseFloatStrict(undefined, "--lat")).toBeUndefined();
  });
});

describe("formatNullableBool — tri-state rendering", () => {
  it("renders true as 'Yes'", () => {
    expect(formatNullableBool(true)).toBe("Yes");
  });

  it("renders false as 'No'", () => {
    expect(formatNullableBool(false)).toBe("No");
  });

  it("renders null as 'Unknown' (not 'No')", () => {
    expect(formatNullableBool(null)).toBe("Unknown");
  });

  it("renders undefined as 'Unknown' (not 'No')", () => {
    expect(formatNullableBool(undefined)).toBe("Unknown");
  });
});

describe("escapeMdTableCell — markdown table safety", () => {
  it("escapes pipe characters", () => {
    expect(escapeMdTableCell("Foo | Bar")).toBe("Foo \\| Bar");
  });

  it("escapes backticks", () => {
    expect(escapeMdTableCell("Foo `Bar`")).toBe("Foo \\`Bar\\`");
  });

  it("collapses newlines to spaces", () => {
    expect(escapeMdTableCell("Foo\nBar\r\nBaz")).toBe("Foo Bar Baz");
  });

  it("escapes backslashes first to avoid double-escape", () => {
    expect(escapeMdTableCell("a\\b")).toBe("a\\\\b");
  });

  it("returns dash for null and undefined", () => {
    expect(escapeMdTableCell(null)).toBe("—");
    expect(escapeMdTableCell(undefined)).toBe("—");
  });

  it("preserves regular content", () => {
    expect(escapeMdTableCell("Eiffel Tower")).toBe("Eiffel Tower");
  });
});

// ── sanitizeExternalText / sanitizeExternalData (VOY-1709) ──

describe("sanitizeExternalText", () => {
  it("strips ANSI CSI sequences (color, cursor movement, screen clear)", () => {
    expect(sanitizeExternalText("\u001b[31mRed Hotel\u001b[0m")).toBe("Red Hotel");
    expect(sanitizeExternalText("\u001b[2J\u001b[HGrand Plaza")).toBe("Grand Plaza");
  });

  it("strips OSC sequences (terminal title spoofing)", () => {
    expect(sanitizeExternalText("\u001b]0;pwned\u0007Hilton")).toBe("Hilton");
    expect(sanitizeExternalText("\u001b]8;;https://evil.example\u001b\\Click\u001b]8;;\u001b\\")).toBe("Click");
  });

  it("strips stray control characters and DEL but keeps newline/tab", () => {
    expect(sanitizeExternalText("a\u0000b\u0007c\u007fd")).toBe("abcd");
    expect(sanitizeExternalText("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it("strips a bare ESC that is not part of a well-formed sequence", () => {
    expect(sanitizeExternalText("safe\u001bhotel")).toBe("safehotel");
  });

  it("leaves legitimate travel data untouched", () => {
    expect(sanitizeExternalText("Fairmont Château Lake Louise — Deluxe, $1,299")).toBe(
      "Fairmont Château Lake Louise — Deluxe, $1,299",
    );
  });
});

describe("sanitizeExternalData", () => {
  it("recursively sanitizes nested objects and arrays", () => {
    const dirty = {
      plan: {
        title: "\u001b[31mTrip\u001b[0m",
        options: [{ name: "Hotel\u0007 A", price: 100 }, { name: "OK", price: null }],
      },
    };
    expect(sanitizeExternalData(dirty)).toEqual({
      plan: {
        title: "Trip",
        options: [{ name: "Hotel A", price: 100 }, { name: "OK", price: null }],
      },
    });
  });

  it("passes through non-string primitives and null untouched", () => {
    expect(sanitizeExternalData(42)).toBe(42);
    expect(sanitizeExternalData(true)).toBe(true);
    expect(sanitizeExternalData(null)).toBe(null);
    expect(sanitizeExternalData([1, "a\u0000b"])).toEqual([1, "ab"]);
  });
});

describe("sanitizeExternalText — C1 controls and prototype safety (verifier findings)", () => {
  it("strips C1 single-codepoint controls (CSI U+009B, OSC U+009D, DCS U+0090)", () => {
    expect(sanitizeExternalText("\u009b2JEvil")).toBe("2JEvil");
    expect(sanitizeExternalText("\u009b31mRed Hotel")).toBe("31mRed Hotel");
    expect(sanitizeExternalText("a\u009db\u0090c\u009fd")).toBe("abcd");
  });
});

describe("sanitizeExternalData — prototype pollution resistance", () => {
  it("drops own __proto__/constructor/prototype keys instead of assigning them", () => {
    const hostile = JSON.parse('{"name":"ok","__proto__":{"polluted":"yes"},"constructor":{"x":1}}');
    const out = sanitizeExternalData(hostile) as Record<string, unknown>;
    expect(out.name).toBe("ok");
    expect(out.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
