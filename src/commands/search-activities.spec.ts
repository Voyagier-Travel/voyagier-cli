import { jest, describe, it, expect } from "@jest/globals";
import { buildActivitySummary } from "../utils.js";

// Pure function tests — no chalk dependency

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
