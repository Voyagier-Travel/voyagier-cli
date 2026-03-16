import { describe, it, expect } from "@jest/globals";
import { findMetroArea } from "./data/metro-areas.js";

describe("findMetroArea", () => {
  it("should find exact alias match", () => {
    const result = findMetroArea("washington");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Washington, DC Metro");
    expect(result!.airports).toContain("DCA");
    expect(result!.airports).toContain("IAD");
    expect(result!.airports).toContain("BWI");
  });

  it("should be case-insensitive", () => {
    const result = findMetroArea("NEW YORK");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("New York Metro");
    expect(result!.airports).toContain("JFK");
  });

  it("should match multi-word aliases", () => {
    const result = findMetroArea("washington dc");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Washington, DC Metro");
  });

  it("should match partial aliases", () => {
    const result = findMetroArea("san fran");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("San Francisco Bay Area");
    expect(result!.airports).toContain("SFO");
  });

  it("should return null for unknown metro", () => {
    const result = findMetroArea("timbuktu");
    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = findMetroArea("");
    expect(result).toBeNull();
  });

  it("should match DMV alias for DC", () => {
    const result = findMetroArea("dmv");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Washington, DC Metro");
  });

  it("should find international metros", () => {
    const result = findMetroArea("tokyo");
    expect(result).not.toBeNull();
    expect(result!.airports).toContain("NRT");
    expect(result!.airports).toContain("HND");
  });

  it("should match london", () => {
    const result = findMetroArea("london");
    expect(result).not.toBeNull();
    expect(result!.airports).toEqual(["LHR", "LGW", "STN", "LCY", "LTN"]);
  });
});
