import { describe, it, expect } from "@jest/globals";
import { renderItinerary, renderPlanStatus, renderQuote, renderSearchResult, renderSelectionOptions, renderToolPayload, unwrapToolPayload } from "./render.js";

/**
 * Renderer contract on fixture payloads shaped like the server's tool results
 * (`{ <operation>: payload }`, empty fields pruned). Renderers return null on
 * an unrecognized shape so the caller falls back to JSON; they never throw.
 */

// eslint-disable-next-line no-control-regex
const strip = (s: string | null): string => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "");

const PLAN_STATUS = {
  tripPlanStatus: {
    tripPlanId: "plan-1",
    title: "Doe — Lisbon",
    readiness: "Blocked",
    summary: { goalsTotal: 4, goalsDecided: 2, goalsBooked: 0, blockerCount: 2, bookableNow: false },
    blockers: [
      { kind: "TravellerData", message: "Jane Doe is missing dateOfBirth", refs: { travellerId: "trv-1" } },
      { kind: "RequirementUnmet", message: "Flights: Cabin class", unverified: true, refs: { goalId: "g-1", selectionId: "s-1" } },
    ],
    nextActions: [{ action: "SelectOption", detail: "Pick a fare", selectionId: "s-1" }],
    waiting: [{ kind: "OptionsPending", message: "Hotel inventory is loading", refs: { selectionId: "s-2" } }],
    travellers: [{ travellerId: "trv-1", name: "Jane Doe", missing: ["dateOfBirth"] }],
    cart: { itemCount: 1, bookableCount: 0, total: 412.5, currency: "USD" },
    goals: [
      { goalId: "g-1", name: "Flights", type: "Flight", isDecided: true, isReady: true },
      { goalId: "g-2", name: "Accommodation", type: "Hotel", isDecided: false, isReady: false },
    ],
  },
};

const SEARCH = {
  searchFlights: {
    id: "srch-1",
    type: "Flight",
    status: "Ready",
    optionsSummary: {
      optionCount: 42,
      truncated: true,
      topOptions: [
        {
          index: 0,
          optionId: "opt-1",
          name: "TAP Air Portugal",
          price: 812.4,
          currency: "USD",
          isBookable: true,
          airlines: ["TP"],
          segments: [
            { origin: "BWI", destination: "LIS", departureTime: "2026-11-20T17:40:00", arrivalTime: "2026-11-21T06:55:00", durationLabel: "8h 15m", stops: 0 },
            { origin: "LIS", destination: "BWI", departureTime: "2026-11-27T11:10:00", arrivalTime: "2026-11-27T15:05:00", durationLabel: "8h 55m", stops: 1 },
          ],
        },
        { index: 1, optionId: "opt-2", name: "Grand Hotel", price: 1290, currency: "USD", rating: 4.5, amenities: ["Pool", "Spa", "Gym", "Bar", "Wifi"] },
      ],
      callouts: { cheapestIndex: 0, fastestIndex: 0, highestRatedIndex: 1 },
    },
  },
};

describe("unwrapToolPayload", () => {
  it("unwraps the single operation key and leaves other shapes alone", () => {
    expect(unwrapToolPayload({ myTripPlans: { count: 1 } })).toEqual({ count: 1 });
    expect(unwrapToolPayload({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(unwrapToolPayload({ ok: true })).toEqual({ ok: true });
    expect(unwrapToolPayload("text")).toBe("text");
    expect(unwrapToolPayload({ searchTravelDestinations: [{ id: "d1" }] })).toEqual([{ id: "d1" }]);
  });
});

describe("renderPlanStatus", () => {
  it("shows readiness, counts, cart, goals, blockers, waiting, traveller gaps and next actions", () => {
    const out = strip(renderToolPayload("plan_status", PLAN_STATUS));
    expect(out).toContain("Doe — Lisbon");
    expect(out).toContain("readiness Blocked");
    expect(out).toContain("goals decided 2/4");
    expect(out).toContain("cart: 1 item(s), 0 bookable, total $412.50");
    expect(out).toMatch(/decided\s+Flights \(Flight\) goal_id g-1/);
    expect(out).toMatch(/open\s+Accommodation \(Hotel\)/);
    expect(out).toContain("TravellerData: Jane Doe is missing dateOfBirth");
    expect(out).toContain("RequirementUnmet (unverified): Flights: Cabin class");
    expect(out).toContain("OptionsPending: Hotel inventory is loading");
    expect(out).toContain("Jane Doe: dateOfBirth traveller_id trv-1");
    expect(out).toContain("SelectOption: Pick a fare  (selectionId s-1)");
  });

  it("returns null for a shape without readiness", () => {
    expect(renderPlanStatus({ foo: 1 })).toBeNull();
    expect(renderToolPayload("plan_status", { tripPlanStatus: { nope: true } })).toBeNull();
  });
});

describe("renderSearchResult", () => {
  it("renders flights with per-direction segments, hotel facts, prices and callouts", () => {
    const out = strip(renderToolPayload("search_flights", SEARCH));
    expect(out).toContain("status Ready");
    expect(out).toContain("id srch-1");
    expect(out).toContain("[0]  TP  ·  BWI→LIS 17:40–06:55 8h 15m nonstop  ·  LIS→BWI 11:10–15:05 8h 55m 1 stop  ·  $812.40  ·  [cheapest, fastest]");
    expect(out).toContain("option_id opt-1");
    expect(out).toContain("[1]  Grand Hotel  ·  ⭐4.5  ·  Pool, Spa, Gym, Bar  ·  $1,290.00  ·  [top rated]");
    expect(out).toContain("… 40 more (showing top 2)");
  });

  it("says when a search is still fetching and surfaces fetchError", () => {
    const out = strip(renderSearchResult({ id: "s", type: "Hotel", status: "Fetching", optionsSummary: { optionCount: 0, topOptions: [] } }));
    expect(out).toContain("status Fetching");
    expect(out).toContain("0 options yet");
    const err = strip(renderSearchResult({ id: "s", status: "FetchError", fetchError: "Supplier timeout" }));
    expect(err).toContain("Supplier timeout");
  });

  it("returns null for an unrelated shape", () => {
    expect(renderSearchResult({ items: [] })).toBeNull();
    expect(renderSearchResult("x")).toBeNull();
  });
});

describe("renderSelectionOptions", () => {
  it("renders fetch state, searched query and the options digest", () => {
    const out = strip(
      renderSelectionOptions({
        __typename: "TripPlanFlightSelection",
        id: "sel-1",
        fetchStatus: { status: "NoResults", searchedQuery: { summary: "BWI→LIS 2026-11-20, return same day", degenerateHint: "same-day return" } },
        optionsSummary: { optionCount: 0, topOptions: [] },
      }),
    );
    expect(out).toContain("FlightSelection  ·  status NoResults  ·  selection_id sel-1");
    expect(out).toContain("searched: BWI→LIS 2026-11-20, return same day");
    expect(out).toContain("hint: same-day return");
  });
});

describe("renderItinerary", () => {
  it("groups events by day using the ISO datetime and prefers the server's localTime label", () => {
    const out = strip(
      renderItinerary({
        title: "Lisbon",
        startDate: "2026-11-20",
        endDate: "2026-11-27",
        tripPlanEvents: [
          { name: "Flight BWI → LIS", datetime: "2026-11-20T17:40:00", localTime: "5:40pm", duration: "PT8H15M", location: { name: "BWI" }, travellers: [{ id: "t", name: "Jane Doe" }], bookingRecordId: "b1" },
          { name: "Check-in Grand Hotel", datetime: "2026-11-21T15:00:00", location: { name: "Grand Hotel" } },
        ],
      }),
    );
    expect(out).toContain("Lisbon  2026-11-20 → 2026-11-27");
    expect(out).toContain("  2026-11-20\n    5:40pm  Flight BWI → LIS  @ BWI  PT8H15M  [Jane Doe]  booked");
    expect(out).toContain("  2026-11-21\n    15:00   Check-in Grand Hotel  @ Grand Hotel");
  });

  it("says so when there are no events, and returns null for a non-itinerary shape", () => {
    expect(strip(renderItinerary({ title: "Empty", tripPlanEvents: [] }))).toContain("No events yet");
    expect(renderItinerary({ title: "Empty" })).toBeNull();
  });
});

describe("renderQuote", () => {
  it("lists items, the chargeable total, blockers and a copy-pasteable book command", () => {
    const out = strip(
      renderToolPayload(
        "quote",
        {
          tripPlanQuote: {
            items: [
              { selectionId: "s-1", optionId: "o-1", name: "TP 203 BWI→LIS", priceCents: 81240, currency: "USD", bookable: true },
              { selectionId: "s-2", name: "Grand Hotel", priceCents: 129000, currency: "USD", bookable: false, bookableReason: "room not picked" },
            ],
            chargeableTotalCents: 81240,
            currency: "USD",
            acceptance: { expectTotalCents: 81240, itemIds: ["i-1"] },
            checkoutBlockers: [{ kind: "TRAVELLER_DATA", label: "Date of birth" }],
          },
        },
        "plan-9",
      ),
    );
    expect(out).toContain("• TP 203 BWI→LIS  $812.40  bookable");
    expect(out).toContain("• Grand Hotel  $1,290.00  not bookable: room not picked");
    expect(out).toContain("chargeable total $812.40  (81240 cents)");
    expect(out).toContain("TRAVELLER_DATA: Date of birth");
    expect(out).toContain("voyagier book --plan_id plan-9 --expect_total_cents 81240 --item_ids i-1");
  });

  it("handles a pruned payload with nothing carted", () => {
    const out = strip(renderQuote({ chargeableTotalCents: 0, currency: "USD", acceptanceUnavailableReason: "no bookable items in the cart" }));
    expect(out).toContain("No items in the cart yet.");
    expect(out).toContain("No gated booking possible: no bookable items in the cart");
    expect(renderQuote({ something: "else" })).toBeNull();
  });
});

describe("renderToolPayload", () => {
  it("returns null for tools without a renderer and never throws on garbage", () => {
    expect(renderToolPayload("plans_list", { myTripPlans: { items: [] } })).toBeNull();
    expect(renderToolPayload("plan_status", null)).toBeNull();
    expect(renderToolPayload("itinerary", { tripPlan: { tripPlanEvents: [null, 3, "x"] } })).not.toBeNull();
  });
});
