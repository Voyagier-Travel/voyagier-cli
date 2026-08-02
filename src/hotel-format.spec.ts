import { describe, it, expect } from "@jest/globals";
import { nightsBetween, deriveHotelStay, hotelStayLabel, deriveRoomStay, deriveHotelFacts, hotelFactsFields } from "./hotel-format.js";

/**
 * VOY-1724 hotel/room price honesty. The supplier's minRate is a STAY TOTAL,
 * and room options carry a per-night rate breakdown — these helpers derive the
 * honest labels shown in search and selection-options output.
 */

describe("nightsBetween", () => {
  it("counts nights inclusive of the range span", () => {
    expect(nightsBetween("2026-09-10", "2026-09-14")).toBe(4);
    expect(nightsBetween("2026-09-10", "2026-09-11")).toBe(1);
  });
  it("tolerates ISO datetimes", () => {
    expect(nightsBetween("2026-09-10T00:00:00.000Z", "2026-09-13T00:00:00.000Z")).toBe(3);
  });
  it("returns null on missing / bad / non-positive ranges", () => {
    expect(nightsBetween(null, "2026-09-14")).toBeNull();
    expect(nightsBetween("2026-09-14", "2026-09-10")).toBeNull();
    expect(nightsBetween("not-a-date", "2026-09-14")).toBeNull();
  });
  it("returns null (not throw) on non-string truthy payload values", () => {
    // optionData is raw API JSONB — dates can arrive as numbers/objects.
    expect(nightsBetween(20260910 as unknown as string, "2026-09-14")).toBeNull();
    expect(nightsBetween("2026-09-10", { d: "2026-09-14" } as unknown as string)).toBeNull();
  });
});

describe("deriveHotelStay + hotelStayLabel (search: minRate = STAY TOTAL)", () => {
  const bookingData = { searchQuery: { checkInDate: "2026-09-10", checkOutDate: "2026-09-14" } };

  it("splits the stay total across the nights", () => {
    const stay = deriveHotelStay(531.1, bookingData);
    expect(stay).toEqual({
      stayTotal: 531.1,
      nights: 4,
      perNight: 133, // 531.10/4 = 132.775 → 133
      checkIn: "2026-09-10",
      checkOut: "2026-09-14",
    });
  });

  it("labels the total honestly with nights + per-night", () => {
    expect(hotelStayLabel(531.1, bookingData)).toBe("from $531.10 total · 4 nights (~$133/nt)");
  });

  it("falls back to just the total when dates are absent (never a fake /night)", () => {
    expect(hotelStayLabel(531.1, {})).toBe("from $531.10 total");
    expect(hotelStayLabel(531.1)).toBe("from $531.10 total");
    expect(hotelStayLabel(531.1, {})).not.toContain("/nt");
  });

  it("returns empty string / null when there is no price", () => {
    expect(hotelStayLabel(undefined, bookingData)).toBe("");
    expect(deriveHotelStay(undefined, bookingData)).toBeNull();
  });
});

describe("deriveHotelFacts + hotelFactsFields (VOY-1783: rating + amenities)", () => {
  it("extracts rating and caps amenities at 3 salient ones", () => {
    const facts = deriveHotelFacts({ rating: 4.5, amenities: ["pool", "spa", "gym", "wifi"] })!;
    expect(facts.rating).toBe(4.5);
    expect(facts.amenities).toEqual(["pool", "spa", "gym"]);
  });

  it("accepts a starRating alias and rounds noisy decimals to one place", () => {
    expect(deriveHotelFacts({ starRating: 4 })!.rating).toBe(4);
    expect(deriveHotelFacts({ rating: 4.567 })!.rating).toBe(4.6);
  });

  it("returns null when neither rating nor amenities are present", () => {
    expect(deriveHotelFacts({ searchQuery: { checkInDate: "2026-09-10" } })).toBeNull();
    expect(deriveHotelFacts(undefined)).toBeNull();
    expect(deriveHotelFacts("nope")).toBeNull();
  });

  it("drops non-string amenities and non-numeric ratings (optional-safe)", () => {
    const facts = deriveHotelFacts({ rating: "5 stars", amenities: ["pool", 42, null, "spa"] })!;
    expect(facts.rating).toBeNull();
    expect(facts.amenities).toEqual(["pool", "spa"]);
  });

  it("hotelFactsFields emits only the known additive keys", () => {
    expect(hotelFactsFields({ rating: 4.5, amenities: ["pool"] })).toEqual({ rating: 4.5, amenities: ["pool"] });
    expect(hotelFactsFields({ amenities: ["pool"] })).toEqual({ amenities: ["pool"] });
    expect(hotelFactsFields({})).toEqual({});
  });
});

describe("deriveRoomStay (room/rate optionData nightly breakdown)", () => {
  // Shape mirrors the real HotelRoomList option payload (anonymized).
  const optionData = {
    checkInDate: "2026-09-10",
    checkOutDate: "2026-09-14",
    rate: {
      totalAmount: 616.98,
      taxes: {
        breakdown: [
          { amount: "17.42", startDate: "2026-09-10", endDate: "2026-09-11" },
          { amount: "18.72", startDate: "2026-09-11", endDate: "2026-09-13" },
          { amount: "16.12", startDate: "2026-09-13", endDate: "2026-09-14" },
        ],
      },
    },
  };

  it("derives nights + total + per-night from the breakdown", () => {
    const stay = deriveRoomStay(optionData);
    expect(stay).toEqual({
      nights: 4,
      total: 616.98,
      perNight: 154, // 616.98/4 = 154.245 → 154
      label: "4 nights · $616.98 total (~$154/nt incl. tax)",
    });
  });

  it("skips silently when the breakdown is absent", () => {
    expect(deriveRoomStay({ checkInDate: "2026-09-10", checkOutDate: "2026-09-14" })).toBeNull();
    expect(deriveRoomStay({ rate: { taxes: { breakdown: [] } } })).toBeNull();
    expect(deriveRoomStay(null)).toBeNull();
    expect(deriveRoomStay("nope")).toBeNull();
  });

  it("skips silently when dates are missing (can't count nights)", () => {
    expect(
      deriveRoomStay({ rate: { totalAmount: 100, taxes: { breakdown: [{ amount: "1" }] } } }),
    ).toBeNull();
  });
});
