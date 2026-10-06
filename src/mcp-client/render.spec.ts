import { describe, it, expect } from "@jest/globals";
import { TOOL_RENDERERS, renderItinerary, renderPlanStatus, renderQuote, renderSearchResult, renderSelectionOptions, renderToolPayload, shellQuote } from "./render.js";

/**
 * Renderer contract on fixture payloads shaped like the server's tool results:
 * the bare result object (no `{ <operation>: … }` wrapper, empty fields
 * pruned). Renderers return null on an unrecognized shape so the caller falls
 * back to JSON; they never throw. Ids are fake.
 */

// eslint-disable-next-line no-control-regex
const strip = (s: string | null): string => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "");

const PLAN_STATUS = {
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
};

const SEARCH = {
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
};

describe("renderPlanStatus", () => {
  it("shows readiness, counts, cart, goals, blockers, waiting, traveller gaps and next actions", () => {
    const out = strip(renderToolPayload("get_plan_status", PLAN_STATUS));
    expect(out).toContain("Doe — Lisbon");
    expect(out).toContain("readiness Blocked");
    expect(out).toContain("goals decided 2/4");
    expect(out).toContain("cart: 1 item(s), 0 bookable, total $412.50");
    expect(out).not.toContain("bookable now");
    expect(out).toMatch(/decided\s+Flights \(Flight\) goal_id g-1/);
    expect(out).toMatch(/open\s+Accommodation \(Hotel\)/);
    expect(out).toContain("TravellerData: Jane Doe is missing dateOfBirth");
    expect(out).toContain("RequirementUnmet (unverified): Flights: Cabin class");
    expect(out).toContain("OptionsPending: Hotel inventory is loading");
    expect(out).toContain("Jane Doe: dateOfBirth traveller_id trv-1");
    expect(out).toContain("SelectOption: Pick a fare  (selectionId s-1)");
  });

  it("reads summary.bookableNow and cart.bookableCount, the plan-status names the server sends", () => {
    const ready = strip(
      renderPlanStatus({
        ...PLAN_STATUS,
        readiness: "ReadyToBook",
        summary: { ...PLAN_STATUS.summary, bookableNow: true },
        cart: { itemCount: 2, bookableCount: 2, total: 812.4, currency: "USD" },
      }),
    );
    expect(ready).toContain("bookable now");
    expect(ready).toContain("cart: 2 item(s), 2 bookable, total $812.40");
    expect(ready).not.toContain("not bookable");
  });

  it("returns null for a shape without readiness", () => {
    expect(renderPlanStatus({ foo: 1 })).toBeNull();
    expect(renderToolPayload("get_plan_status", { nope: true })).toBeNull();
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
    expect(out).not.toContain("bookable");
  });

  // Only rows that book as themselves carry the quote pair bookable +
  // bookableReason; every other row carries no bookable key. A journey or
  // hotel row is never the bookable unit, so the renderer prints no verdict
  // for it; a leaf's verdict comes with the server's reason.
  it("prints the bookable pair only on the rows that carry it", () => {
    const out = strip(
      renderSearchResult({
        id: "s",
        type: "Hotel",
        status: "Ready",
        optionsSummary: {
          optionCount: 3,
          topOptions: [
            { index: 1, optionId: "a", name: "Hotel A", price: 100, currency: "USD" },
            { index: 2, optionId: "b", name: "Flexible Rate", price: 200, currency: "USD", bookable: true },
            { index: 3, optionId: "c", name: "Booked Rate", price: 300, currency: "USD", bookable: false, bookableReason: "Already booked on this plan." },
          ],
        },
      }),
    );
    expect(out).toContain("[1]  Hotel A  ·  $100.00\n");
    expect(out).toContain("[2]  Flexible Rate  ·  $200.00  ·  bookable\n");
    expect(out).toContain("[3]  Booked Rate  ·  $300.00  ·  not bookable: Already booked on this plan.");
  });

  it("prints no verdict for a row without a bookable key", () => {
    const out = strip(
      renderSearchResult({
        id: "s",
        status: "Ready",
        optionsSummary: {
          optionCount: 2,
          topOptions: [
            { index: 1, optionId: "a", name: "Hotel A", price: 100, currency: "USD", rating: 4.2 },
            { index: 2, optionId: "b", name: "Hotel B", price: 200, currency: "USD", isBookable: false },
          ],
        },
      }),
    );
    expect(out).toContain("[1]  Hotel A  ·  ⭐4.2  ·  $100.00\n");
    expect(out).toContain("[2]  Hotel B  ·  $200.00\n");
    expect(out).not.toMatch(/bookable/i);
    expect(out).not.toContain("exploration");
    expect(out).not.toContain("next:");
  });

  it("renders a flight row without fare or leg fields exactly as before (no conditions line, no carrier codes)", () => {
    const out = strip(renderToolPayload("search_flights", SEARCH));
    const lines = out.split("\n");
    const row = lines.findIndex((l) => l.startsWith("  [0]"));
    expect(lines[row]).toBe("  [0]  TP  ·  BWI→LIS 17:40–06:55 8h 15m nonstop  ·  LIS→BWI 11:10–15:05 8h 55m 1 stop  ·  $812.40  ·  [cheapest, fastest]");
    expect(lines[row + 1]).toBe("       option_id opt-1");
    expect(out).not.toMatch(/refundable|changeable|bags:|fare basis|base |taxes|\(op\. /);
  });

  it("shows a flight row's fare conditions and per-segment legs when the server sends them", () => {
    const row = {
      index: 0,
      optionId: "opt-9",
      price: 1240.5,
      currency: "USD",
      airlines: ["EK", "FZ"],
      cabinClass: "Economy",
      refundable: false,
      changeable: true,
      fareBasis: ["KLXESAU1", "KLXESAU1/CH"],
      baggage: { carryOn: "1 piece, 7 kg", checked: null },
      baseFare: 980,
      taxes: 260.5,
      segments: [
        {
          origin: "JFK",
          destination: "DXB",
          departureTime: "2026-11-20T22:20:00",
          arrivalTime: "2026-11-21T19:10:00",
          durationLabel: "12h 50m",
          stops: 0,
          legs: [{ marketingCarrier: "EK", operatingCarrier: "EK", flightNumber: 204 }],
        },
        {
          origin: "DXB",
          destination: "JFK",
          departureTime: "2026-11-28T08:30:00",
          arrivalTime: "2026-11-28T14:25:00",
          durationLabel: "14h 55m",
          stops: 1,
          legs: [
            { marketingCarrier: "EK", operatingCarrier: "FZ", flightNumber: 384 },
            { marketingCarrier: "EK", operatingCarrier: null, flightNumber: 201 },
          ],
        },
      ],
    };
    const out = strip(renderSearchResult({ id: "srch-2", type: "Flight", status: "Ready", optionsSummary: { optionCount: 1, topOptions: [row] } }));
    expect(out).toContain("JFK→DXB 22:20–19:10 12h 50m nonstop EK 204  ·  DXB→JFK 08:30–14:25 14h 55m 1 stop EK 384 (op. FZ), EK 201  ·  $1,240.50");
    // A search row carries the slot the fare was priced under, not the cabin per flight: the line says so instead of printing the slot.
    expect(out).toContain(
      "       cabin per flight not reported  ·  non-refundable  ·  changeable  ·  bags: carry-on 1 piece, 7 kg  ·  fare basis KLXESAU1/KLXESAU1/CH  ·  base $980.00 + taxes $260.50",
    );
    expect(out).not.toContain("Economy");
    // Null checked baggage is "unknown", never printed as a number of bags.
    expect(out).not.toContain("checked");
    expect(out).toContain("option_id opt-9");

    // Partial fields: only what is present, no dangling separators.
    const partial = strip(
      renderSearchResult({
        id: "srch-3",
        status: "Ready",
        optionsSummary: {
          optionCount: 1,
          topOptions: [
            {
              index: 0,
              price: 300,
              currency: "EUR",
              refundable: true,
              baggage: { carryOn: null, checked: "1 x 23 kg" },
              taxes: 45,
              segments: [{ origin: "LIS", destination: "MAD", legs: [{ marketingCarrier: null, operatingCarrier: "IB", flightNumber: "3102" }, { marketingCarrier: null }] }],
            },
          ],
        },
      }),
    );
    expect(partial).toContain("LIS→MAD IB 3102");
    expect(partial).toContain("       refundable  ·  bags: checked 1 x 23 kg  ·  taxes 45.00 EUR");
    expect(partial).not.toContain("changeable");
  });

  it("labels a fare by the cabin on each flight from its legs, and never by cabinClass or bookedCabin", () => {
    const fareRow = (fields: Record<string, unknown>) =>
      strip(
        renderSearchResult({
          id: "srch-4",
          type: "Flight",
          status: "Ready",
          optionsSummary: { optionCount: 1, topOptions: [{ index: 0, price: 2100, currency: "USD", refundable: false, ...fields }] },
        }),
      );
    const bwiOrd = { origin: "BWI", destination: "ORD", carrier: "UA", flightNumber: 512, cabin: "economy", bookingCode: "K" };
    const ordCdg = { origin: "ORD", destination: "CDG", carrier: "UA", flightNumber: 986, cabin: "business", bookingCode: "D" };
    // A Fare & Cabin row carries its legs inside the `fare` block: one cabin per flight, in flight order.
    const mixed = fareRow({ cabinClass: "economy", fare: { cabinClass: "economy", bookedCabin: null, legs: [bwiOrd, ordCdg] } });
    expect(mixed).toContain("       BWI→ORD Economy · ORD→CDG Business  ·  non-refundable");
    // The slot the fare was priced under is not the cabin flown and is not printed as one.
    expect(mixed).not.toMatch(/\beconomy\b/);
    // Same cabin on every flight: still one entry per flight, never collapsed to the deprecated bookedCabin.
    expect(fareRow({ cabinClass: "premium-economy", fare: { cabinClass: "premium-economy", bookedCabin: "business", legs: [{ ...bwiOrd, cabin: "business" }, ordCdg] } })).toContain(
      "       BWI→ORD Business · ORD→CDG Business  ·  non-refundable",
    );
    expect(fareRow({ fare: { legs: [{ ...bwiOrd, cabin: "premium-economy" }] } })).toContain("       BWI→ORD Premium economy  ·  non-refundable");
    // Null legs: the per-flight cabin is unknown for that fare; the row name, cabinClass and bookedCabin are not relayed in its place.
    for (const row of [
      { cabinClass: "economy", fare: { cabinClass: "economy", bookedCabin: "economy", legs: null } },
      { cabinClass: "business", fare: { cabinClass: "business", bookedCabin: null } },
      { cabinClass: "business", fare: { cabinClass: "business", legs: [] } },
      // A search row carries only the slot: the cabin is per flight and the row does not have it.
      { cabinClass: "economy" },
      { cabinClass: "premium-economy", bookedCabin: "business" },
    ]) {
      const out = fareRow(row);
      expect(out).toContain("       cabin per flight not reported  ·  non-refundable");
      expect(out).not.toMatch(/\b(economy|business)\b/i);
    }
    // A leg without a cabin keeps its place as not reported (never dropped, so the other flights do not read as the whole fare); one without a route still names its cabin.
    expect(fareRow({ fare: { legs: [{ origin: "BWI", destination: "ORD" }, { cabin: "first" }] } })).toContain(
      "       BWI→ORD cabin not reported · First  ·  non-refundable",
    );
    // No leg carries a cabin: the whole line is not reported.
    expect(fareRow({ fare: { legs: [{ origin: "BWI", destination: "ORD" }] } })).toContain("       cabin per flight not reported  ·  non-refundable");
    // No cabin fields at all (a hotel or activity row): the conditions line starts with the next field.
    expect(fareRow({})).toContain("       non-refundable");
    expect(fareRow({})).not.toContain("cabin per flight");
  });

  it("footer: matched/total counts, the airline facet, noMatchReason, a shell-quoted next-page command and the server's sentences", () => {
    const paged = {
      id: "srch-1",
      type: "Flight",
      status: "Ready",
      optionsSummary: {
        optionCount: 42,
        matchedCount: 17,
        nextCursor: "eyJvIjoxMH0=",
        airlines: [
          { key: "TP", count: 9 },
          { key: "UA", count: 5 },
          { key: "LH", count: 3 },
        ],
        nextStep: "promote_search with listing_id onto the plan's flight goal.",
        howToRefine: "get_search_status with this id and cursor / sort / airlines.",
        topOptions: SEARCH.optionsSummary.topOptions,
      },
    };
    const out = strip(renderToolPayload("get_search_status", paged));
    expect(out).toContain("17 of 42 options match the current filters");
    expect(out).toContain("airlines: TP 9  UA 5  LH 3");
    // The cursor is opaque and the payload has no offset, so no remaining count is computed.
    expect(out).toContain("more → voyagier get_search_status --search_id srch-1 --cursor eyJvIjoxMH0=  (repeat the same sort and filters)");
    expect(out).not.toMatch(/\d+ more/);
    expect(out).not.toContain("(showing top");
    expect(out).toContain("next: promote_search with listing_id onto the plan's flight goal.");
    expect(out).toContain("refine: get_search_status with this id and cursor / sort / airlines.");
    expect(out).not.toContain("no match");
    // Same text for search_flights: the footer is part of the shared renderer.
    expect(strip(renderToolPayload("search_flights", paged))).toContain("--cursor eyJvIjoxMH0=");

    // Hostile ids and cursors are quoted for the shell; the id is the search's own.
    const hostile = strip(renderSearchResult({ ...paged, id: "s;rm -rf x", optionsSummary: { ...paged.optionsSummary, nextCursor: "c'ur sor" } }));
    expect(hostile).toContain("voyagier get_search_status --search_id 's;rm -rf x' --cursor 'c'\\''ur sor'");

    // A cursor without a search id: no command line (a bare placeholder would be a shell redirection).
    const noId = strip(renderSearchResult({ ...paged, id: undefined, optionsSummary: { ...paged.optionsSummary, nextCursor: "eyJvIjoxMH0=" } }));
    expect(noId).toContain("more results available");
    expect(noId).not.toContain("voyagier get_search_status");
    expect(noId).not.toContain("<");
    // searchId is accepted as the id field too.
    expect(strip(renderSearchResult({ ...paged, id: undefined, searchId: "srch-2" }))).toContain("--search_id srch-2 --cursor eyJvIjoxMH0=");

    // Last page (no cursor) of a paged summary: the matched total is stated, no "… N more" arithmetic.
    const lastPage = strip(renderSearchResult({ ...paged, optionsSummary: { ...paged.optionsSummary, nextCursor: null } }));
    expect(lastPage).toContain("17 of 42 options match the current filters");
    expect(lastPage).not.toMatch(/\d+ more/);
    expect(lastPage).not.toContain("→ voyagier");
    // A summary without matchedCount (single, unpaged digest) keeps the "… N more" line as before.
    expect(strip(renderToolPayload("search_flights", SEARCH))).toContain("… 40 more (showing top 2)");

    // A filter no carrier matches: 0 rows, the reason, and the carriers that are there.
    const none = strip(
      renderSearchResult({
        id: "srch-1",
        type: "Flight",
        status: "Ready",
        optionsSummary: { optionCount: 42, matchedCount: 0, noMatchReason: "airlines [ZZ] matches no carrier; this list carries TP (30), UA (12)", airlines: [{ key: "TP", count: 30 }, { key: "UA", count: 12 }], topOptions: [] },
      }),
    );
    expect(none).toContain("0 of 42 options match the current filters");
    expect(none).toContain("no match: airlines [ZZ] matches no carrier; this list carries TP (30), UA (12)");
    expect(none).toContain("airlines: TP 30  UA 12");
    expect(none).not.toContain("0 options yet");

    // Equal counts print no filter line; a summary without the fields prints no footer at all.
    const plain = strip(renderToolPayload("search_flights", SEARCH));
    expect(plain).not.toMatch(/match the current filters|airlines:|→ voyagier|next:|refine:/);
    expect(strip(renderSearchResult({ ...SEARCH, optionsSummary: { ...SEARCH.optionsSummary, matchedCount: 42 } }))).not.toContain("match the current filters");
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

  // Hotel rows may carry distanceMi from the searched point (server-computed,
  // in miles); the digest shows it after the rating, always with one decimal,
  // and omits it when absent.
  it("shows a hotel row's distanceMi as `· 1.2 mi`, in the server's order, and nothing when the row has none", () => {
    const out = strip(
      renderSearchResult({
        id: "s",
        type: "Hotel",
        status: "Ready",
        optionsSummary: {
          optionCount: 2,
          topOptions: [
            { index: 0, optionId: "h-far", name: "Park Hyatt Tokyo", price: 900, currency: "USD", rating: 4.8, distanceMi: 1.2 },
            { index: 1, optionId: "h-none", name: "Kimpton Shinjuku", price: 400, currency: "USD" },
          ],
        },
      }),
    );
    expect(out).toContain("[0]  Park Hyatt Tokyo  ·  ⭐4.8  ·  1.2 mi  ·  $900.00");
    expect(out).toContain("[1]  Kimpton Shinjuku  ·  $400.00");
    expect(out).not.toContain("undefined mi");
    expect(out.indexOf("Park Hyatt Tokyo")).toBeLessThan(out.indexOf("Kimpton Shinjuku"));
  });

  it("formats a whole-number distanceMi with one decimal so rows line up", () => {
    const out = strip(
      renderSearchResult({
        id: "s",
        type: "Hotel",
        status: "Ready",
        optionsSummary: {
          optionCount: 2,
          topOptions: [
            { index: 0, optionId: "h-two", name: "Hotel Gracery", price: 200, currency: "USD", rating: 4.1, distanceMi: 2 },
            { index: 1, optionId: "h-zero", name: "Hotel Sunroute", price: 150, currency: "USD", distanceMi: 0 },
          ],
        },
      }),
    );
    expect(out).toContain("[0]  Hotel Gracery  ·  ⭐4.1  ·  2.0 mi  ·  $200.00");
    expect(out).toContain("[1]  Hotel Sunroute  ·  0.0 mi  ·  $150.00");
  });
});

describe("shellQuote", () => {
  it("leaves plain words bare and single-quotes everything else", () => {
    expect(shellQuote("srch-1")).toBe("srch-1");
    expect(shellQuote("eyJvIjoyfQ==")).toBe("eyJvIjoyfQ==");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("x;rm -rf y")).toBe("'x;rm -rf y'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
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
  it("lists items, the chargeable total, blockers and a copy-pasteable book_plan command", () => {
    const out = strip(
      renderToolPayload(
        "get_plan_quote",
        {
          items: [
            { selectionId: "s-1", optionId: "o-1", name: "TP 203 BWI→LIS", priceCents: 81240, currency: "USD", bookable: true },
            { selectionId: "s-2", name: "Grand Hotel", priceCents: 129000, currency: "USD", bookable: false, bookableReason: "room not picked" },
          ],
          chargeableTotalCents: 81240,
          currency: "USD",
          acceptance: { expectTotalCents: 81240, itemIds: ["i-1"] },
          checkoutBlockers: [{ kind: "TRAVELLER_DATA", label: "Date of birth" }],
        },
        "plan-9",
      ),
    );
    expect(out).toContain("• TP 203 BWI→LIS  $812.40  bookable");
    expect(out).toContain("• Grand Hotel  $1,290.00  not bookable: room not picked");
    expect(out).not.toMatch(/economy|business|requested/);
    expect(out).toContain("chargeable total $812.40  (81240 cents)");
    expect(out).toContain("TRAVELLER_DATA: Date of birth");
    expect(out).toContain("voyagier book_plan --plan_id plan-9 --expect_total_cents 81240 --item_ids i-1");
  });

  it("shows a flight line's cabin per flight under the line, and says when the server did not report it", () => {
    const out = strip(
      renderQuote({
        items: [
          {
            selectionId: "s-1",
            name: "UA 512 / UA 986 BWI→CDG",
            priceCents: 412000,
            currency: "USD",
            bookable: true,
            cabinClass: "economy",
            bookedCabin: null,
            legs: [
              { origin: "BWI", destination: "ORD", carrier: "UA", flightNumber: 512, cabin: "economy", bookingCode: "K" },
              { origin: "ORD", destination: "CDG", carrier: "UA", flightNumber: 986, cabin: "business", bookingCode: "D" },
            ],
          },
          {
            selectionId: "s-2",
            name: "LH 400 FRA→JFK",
            priceCents: 98000,
            currency: "USD",
            bookable: true,
            cabinClass: "premium-economy",
            bookedCabin: "business",
            legs: [{ origin: "FRA", destination: "JFK", carrier: "LH", flightNumber: 400, cabin: "business", bookingCode: "D" }],
          },
          { selectionId: "s-3", name: "Grand Hotel", priceCents: 129000, currency: "USD", bookable: true },
          // A quote line whose legs are null (pruned or explicit) has no known cabin: never relabelled with the slot or the deprecated bookedCabin.
          { selectionId: "s-4", name: "AF 7 JFK→CDG", priceCents: 150000, currency: "USD", bookable: true, cabinClass: "business", bookedCabin: "business", legs: null },
          { selectionId: "s-5", name: "AF 8 CDG→JFK", priceCents: 150000, currency: "USD", bookable: true, cabinClass: "business" },
        ],
        chargeableTotalCents: 939000,
        currency: "USD",
      }),
    );
    const lines = out.split("\n");
    const ua = lines.findIndex((l) => l.includes("UA 512"));
    expect(lines[ua + 1]).toBe("      BWI→ORD Economy · ORD→CDG Business");
    expect(lines[ua + 2]).toBe("      selection_id s-1");
    const lh = lines.findIndex((l) => l.includes("LH 400"));
    expect(lines[lh + 1]).toBe("      FRA→JFK Business");
    const hotel = lines.findIndex((l) => l.includes("Grand Hotel"));
    expect(lines[hotel + 1]).toBe("      selection_id s-3");
    const af7 = lines.findIndex((l) => l.includes("AF 7"));
    expect(lines[af7 + 1]).toBe("      cabin per flight not reported");
    const af8 = lines.findIndex((l) => l.includes("AF 8"));
    expect(lines[af8 + 1]).toBe("      cabin per flight not reported");
    expect(out).not.toMatch(/premium-economy|requested|mixed/);
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
    expect(renderToolPayload("list_plans", { count: 0, items: [], limit: 20, page: 1 })).toBeNull();
    expect(renderToolPayload("get_plan_status", null)).toBeNull();
    expect(renderToolPayload("get_plan_itinerary", { tripPlanEvents: [null, 3, "x"] })).not.toBeNull();
  });

  it("keys the renderers by the verb-first tool names and leaves refresh_options (returns true) to JSON", () => {
    expect(Object.keys(TOOL_RENDERERS).sort()).toEqual(
      ["get_options", "get_plan_itinerary", "get_plan_quote", "get_plan_status", "get_search_status", "promote_search", "search_activities", "search_flights", "search_hotels"].sort(),
    );
    for (const old of ["plan_status", "search_status", "get_selection_options", "itinerary", "quote", "refresh_options"]) {
      expect(TOOL_RENDERERS[old]).toBeUndefined();
      expect(renderToolPayload(old, PLAN_STATUS)).toBeNull();
    }
  });

  it("renders every renamed renderer's fixture from the bare payload", () => {
    expect(strip(renderToolPayload("get_plan_status", PLAN_STATUS))).toContain("readiness Blocked");
    expect(strip(renderToolPayload("get_search_status", SEARCH))).toContain("id srch-1");
    expect(strip(renderToolPayload("promote_search", SEARCH))).toContain("id srch-1");
    expect(strip(renderToolPayload("get_options", { id: "sel-1", fetchStatus: { status: "Ready" }, optionsSummary: { optionCount: 0, topOptions: [] } }))).toContain(
      "status Ready  ·  selection_id sel-1",
    );
    expect(strip(renderToolPayload("get_plan_itinerary", { title: "Lisbon", tripPlanEvents: [] }))).toContain("No events yet");
    expect(strip(renderToolPayload("get_plan_quote", { chargeableTotalCents: 0, currency: "USD", acceptanceUnavailableReason: "empty" }, "plan-9"))).toContain("No items in the cart yet.");
  });

  it("reads the payload as sent: a single-key object is the payload, never a wrapper to open", () => {
    // The server returns the bare result; a one-field object such as { items: [] }
    // or { tripPlanEvents: [] } is that result, not an envelope around one.
    expect(strip(renderToolPayload("get_plan_itinerary", { tripPlanEvents: [] }))).toContain("No events yet");
    expect(renderToolPayload("get_plan_status", { tripPlanStatus: PLAN_STATUS })).toBeNull();
    expect(renderToolPayload("get_plan_quote", { tripPlanQuote: { chargeableTotalCents: 0 } })).toBeNull();
    expect(renderToolPayload("get_search_status", { searchFlights: SEARCH })).toBeNull();
    expect(renderToolPayload("get_options", { selection: { fetchStatus: { status: "Ready" } } })).toBeNull();
    // A one-key payload the renderer does not recognize is left for the JSON
    // fallback, not opened up to find something it does.
    expect(renderToolPayload("get_plan_status", { items: [] })).toBeNull();
  });
});
