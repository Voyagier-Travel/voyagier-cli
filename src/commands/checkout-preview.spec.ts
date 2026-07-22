import { describe, it, expect } from "@jest/globals";
import { buildCheckoutPreview } from "./checkout-preview.js";
import type { CartV2QueryResult } from "./cart-helpers.js";

/**
 * VOY-1724: the checkout preview shared by `book --dry-run` and
 * `plan-status --verify`. One definition of "what would be charged".
 */

function data(over: Partial<NonNullable<CartV2QueryResult["tripPlan"]>> = {}): CartV2QueryResult {
  return {
    tripPlan: {
      id: "plan-1",
      title: "Test",
      cart: { items: [], itemCount: 0, total: 0, currency: "USD" },
      goals: [],
      ...over,
    },
  };
}

describe("buildCheckoutPreview", () => {
  it("sums only bookable lines into the chargeable subtotal", () => {
    const preview = buildCheckoutPreview(
      data({
        cart: {
          items: [
            { id: "c1", name: "Room rate", price: 616.98, currency: "USD", type: "Hotel", selectionId: "s-rate", optionId: "o-rate" },
            { id: "c2", name: "Flight leg", price: 100, currency: "USD", type: "Flight", selectionId: "s-flight", optionId: "o-flight" },
          ],
          itemCount: 2,
          total: 716.98,
          currency: "USD",
        },
        goals: [
          {
            id: "g1",
            name: "Lodging",
            items: [
              {
                id: "i1",
                title: "Lodging",
                selections: [
                  { id: "s-rate", type: "HotelRoomRate", options: [{ id: "o-rate", isBookable: true, blueprintListingId: "L1" }] },
                  { id: "s-flight", type: "Flight", options: [{ id: "o-flight", isBookable: false, externalId: "sabre-x" }] },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(preview.bookable).toBe(true);
    expect(preview.chargeableSubtotal).toBe(616.98);
    expect(preview.subtotal).toBe(716.98);
    // The non-bookable flight line surfaces as a blocker.
    expect(preview.blockers.map((b) => b.itemName)).toEqual(["Flight leg"]);
    expect(preview.currency).toBe("USD");
  });

  it("reports not-bookable on an empty cart (no throw)", () => {
    const preview = buildCheckoutPreview(data());
    expect(preview.bookable).toBe(false);
    expect(preview.chargeableSubtotal).toBe(0);
    expect(preview.blockers).toEqual([]);
  });
});
