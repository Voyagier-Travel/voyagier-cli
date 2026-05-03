import { describe, it, expect } from "@jest/globals";
import {
  buildBookabilityIndex,
  groupCartByGoal,
  filterByTypes,
  filterBookable,
  collectBlockers,
  type RawGoal,
  type EnrichedCartItem,
} from "./cart-helpers.js";

const sampleGoals: RawGoal[] = [
  {
    id: "g-paris-hotel",
    name: "Paris Hotel",
    sortOrder: 2,
    items: [
      {
        id: "i-1",
        title: "Hotel Paris",
        goalId: "g-paris-hotel",
        selections: [
          {
            id: "sel-h1",
            type: "Hotel",
            isLocked: false,
            options: [
              {
                id: "opt-h1",
                name: "King Suite",
                isBookable: true,
                status: "ACTIVE",
                blueprintListingId: "bl-1",
                externalId: "blueprint:1",
              },
              {
                id: "opt-h2",
                name: "Twin Room",
                isBookable: false,
                status: "ACTIVE",
                blueprintListingId: "bl-2",
                externalId: "blueprint:2",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "g-flight",
    name: "Outbound Flight",
    sortOrder: 1,
    items: [
      {
        id: "i-2",
        title: "Flight",
        goalId: "g-flight",
        selections: [
          {
            id: "sel-f1",
            type: "Flight",
            isLocked: false,
            options: [
              {
                id: "opt-f1",
                name: "AF023",
                isBookable: false,
                status: "ACTIVE",
                blueprintListingId: null,
                externalId: "sabre:af023",
              },
            ],
          },
        ],
      },
    ],
  },
];

const enrichedFixture: EnrichedCartItem[] = [
  {
    id: "ci-1", name: "King Suite", type: "Hotel", price: 1840, currency: "USD",
    selectionId: "sel-h1", optionId: "opt-h1", isBookable: true, source: "BLUEPRINT", bookableReason: null,
  },
  {
    id: "ci-2", name: "AF023", type: "Flight", price: 0, currency: "USD",
    selectionId: "sel-f1", optionId: "opt-f1", isBookable: false, source: "SABRE",
    bookableReason: "Flights are itinerary display only; book directly with the airline.",
  },
];

describe("buildBookabilityIndex", () => {
  it("indexes options by selectionId:optionId", () => {
    const idx = buildBookabilityIndex(sampleGoals);
    expect(idx.byKey.get("sel-h1:opt-h1")?.isBookable).toBe(true);
    expect(idx.byKey.get("sel-h1:opt-h2")?.isBookable).toBe(false);
    expect(idx.byKey.get("sel-f1:opt-f1")?.isBookable).toBe(false);
  });

  it("falls back to selectionId-only key for cart items without optionId", () => {
    const idx = buildBookabilityIndex(sampleGoals);
    expect(idx.byKey.get("sel-h1")).toBeDefined();
  });

  it("maps each selectionId to its parent goal", () => {
    const idx = buildBookabilityIndex(sampleGoals);
    expect(idx.selectionToGoal.get("sel-h1")?.goalName).toBe("Paris Hotel");
    expect(idx.selectionToGoal.get("sel-f1")?.goalId).toBe("g-flight");
  });

  it("handles goals with empty items/selections gracefully", () => {
    const idx = buildBookabilityIndex([{ id: "g", name: "Empty", items: [] }]);
    expect(idx.byKey.size).toBe(0);
  });

  it("preserves blueprintListingId and externalId on the lookup", () => {
    const idx = buildBookabilityIndex(sampleGoals);
    expect(idx.byKey.get("sel-h1:opt-h1")?.blueprintListingId).toBe("bl-1");
    expect(idx.byKey.get("sel-f1:opt-f1")?.externalId).toBe("sabre:af023");
  });
});

describe("groupCartByGoal", () => {
  it("groups items into their parent goals", () => {
    const groups = groupCartByGoal(enrichedFixture, sampleGoals);
    const flight = groups.find((g) => g.goalId === "g-flight");
    const hotel = groups.find((g) => g.goalId === "g-paris-hotel");
    expect(flight?.items).toHaveLength(1);
    expect(hotel?.items).toHaveLength(1);
  });

  it("orders goals by sortOrder ascending", () => {
    const groups = groupCartByGoal(enrichedFixture, sampleGoals);
    expect(groups[0].goalId).toBe("g-flight"); // sortOrder 1
    expect(groups[1].goalId).toBe("g-paris-hotel"); // sortOrder 2
  });

  it("computes subtotal per goal", () => {
    const groups = groupCartByGoal(enrichedFixture, sampleGoals);
    expect(groups.find((g) => g.goalId === "g-paris-hotel")?.subtotal).toBe(1840);
    expect(groups.find((g) => g.goalId === "g-flight")?.subtotal).toBe(0);
  });

  it("sets goal.isBookable to false if any item is not bookable", () => {
    const groups = groupCartByGoal(enrichedFixture, sampleGoals);
    expect(groups.find((g) => g.goalId === "g-paris-hotel")?.isBookable).toBe(true);
    expect(groups.find((g) => g.goalId === "g-flight")?.isBookable).toBe(false);
  });

  it("buckets selections without a matching goal into 'Ungrouped'", () => {
    const orphan: EnrichedCartItem = { ...enrichedFixture[0], id: "x", selectionId: "sel-x" };
    const groups = groupCartByGoal([orphan], sampleGoals);
    expect(groups[0].goalName).toBe("Ungrouped");
  });
});

describe("filterByTypes", () => {
  it("returns all items when filter list is empty", () => {
    expect(filterByTypes(enrichedFixture, [])).toHaveLength(2);
  });

  it("matches case-insensitively", () => {
    const out = filterByTypes(enrichedFixture, ["flight"]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("Flight");
  });

  it("supports multiple types", () => {
    const out = filterByTypes(enrichedFixture, ["Flight", "Hotel"]);
    expect(out).toHaveLength(2);
  });

  it("returns empty when no items match", () => {
    expect(filterByTypes(enrichedFixture, ["Restaurant"])).toHaveLength(0);
  });
});

describe("filterBookable", () => {
  it("keeps only bookable items", () => {
    const out = filterBookable(enrichedFixture);
    expect(out).toHaveLength(1);
    expect(out[0].isBookable).toBe(true);
  });
});

describe("collectBlockers", () => {
  it("emits one blocker per non-bookable item", () => {
    const blockers = collectBlockers(enrichedFixture);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].itemName).toBe("AF023");
  });

  it("includes a fix string tailored to the source", () => {
    const blockers = collectBlockers(enrichedFixture);
    expect(blockers[0].fix).toContain("airline");
  });

  it("returns empty when everything is bookable", () => {
    const allBookable = enrichedFixture.map((i) => ({ ...i, isBookable: true, bookableReason: null }));
    expect(collectBlockers(allBookable)).toHaveLength(0);
  });
});
