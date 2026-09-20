import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  TOOL_RENDERERS,
  renderItinerary,
  renderPlanStatus,
  renderQuote,
  renderSearchResult,
  renderSelectionOptions,
  renderToolPayload,
  shellQuote,
  unwrapToolPayload,
} from "./render.js";
import type { McpToolDescriptor } from "./client.js";

const FIXTURE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("../mcp/fixtures/remote-tools.json", import.meta.url), "utf-8")
) as McpToolDescriptor[];

/**
 * Renderer contract on fixture payloads shaped like the server's tool results
 * (the bare payload object, empty fields pruned). A few cases still feed the
 * legacy `{ <operation>: payload }` envelope to prove the fallback unwrap.
 * Renderers return null on an unrecognized shape so the caller falls back to
 * JSON; they never throw.
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
    {
      kind: "RequirementUnmet",
      message: "Flights: Cabin class",
      unverified: true,
      refs: { goalId: "g-1", selectionId: "s-1" },
    },
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

// Legacy envelope shape (pre-2026-09-14 server): the renderer must still read it.
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
            {
              origin: "BWI",
              destination: "LIS",
              departureTime: "2026-11-20T17:40:00",
              arrivalTime: "2026-11-21T06:55:00",
              durationLabel: "8h 15m",
              stops: 0,
            },
            {
              origin: "LIS",
              destination: "BWI",
              departureTime: "2026-11-27T11:10:00",
              arrivalTime: "2026-11-27T15:05:00",
              durationLabel: "8h 55m",
              stops: 1,
            },
          ],
        },
        {
          index: 1,
          optionId: "opt-2",
          name: "Grand Hotel",
          price: 1290,
          currency: "USD",
          rating: 4.5,
          amenities: ["Pool", "Spa", "Gym", "Bar", "Wifi"],
        },
      ],
      callouts: { cheapestIndex: 0, fastestIndex: 0, highestRatedIndex: 1 },
    },
  },
};

describe("unwrapToolPayload", () => {
  it("unwraps the legacy single operation key and leaves other shapes alone", () => {
    expect(unwrapToolPayload({ myTripPlans: { count: 1 } })).toEqual({ count: 1 });
    expect(unwrapToolPayload({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(unwrapToolPayload({ ok: true })).toEqual({ ok: true });
    expect(unwrapToolPayload("text")).toBe("text");
    expect(unwrapToolPayload({ searchTravelDestinations: [{ id: "d1" }] })).toEqual([{ id: "d1" }]);
  });

  it("does not unwrap a genuine one-field payload", () => {
    // A field the renderer reads is a payload, not an envelope.
    expect(unwrapToolPayload({ items: [] }, ["items", "chargeableTotalCents"])).toEqual({ items: [] });
    expect(unwrapToolPayload({ tripPlanEvents: [] }, ["tripPlanEvents"])).toEqual({ tripPlanEvents: [] });
    // Keys that cannot be a GraphQL operation name are never unwrapped.
    expect(unwrapToolPayload({ __typename: { x: 1 } })).toEqual({ __typename: { x: 1 } });
    expect(unwrapToolPayload({ plan_id: { x: 1 } })).toEqual({ plan_id: { x: 1 } });
    expect(unwrapToolPayload({ Items: { x: 1 } })).toEqual({ Items: { x: 1 } });
  });

  it("through renderToolPayload, a bare one-field payload renders as itself", () => {
    // Bare payload with exactly one root field: must not be unwrapped into `[]`.
    expect(strip(renderToolPayload("get_plan_itinerary", { tripPlanEvents: [] }))).toContain("No events yet");
    expect(strip(renderToolPayload("get_plan_quote", { items: [] }))).toContain("No items in the cart yet.");
  });
});

describe("renderPlanStatus", () => {
  it("shows readiness, counts, cart, goals, blockers, waiting, traveller gaps and next actions", () => {
    const out = strip(renderToolPayload("get_plan_status", PLAN_STATUS));
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
    expect(renderToolPayload("get_plan_status", { tripPlanStatus: { nope: true } })).toBeNull();
    expect(renderToolPayload("get_plan_status", { nope: true })).toBeNull();
  });
});

describe("renderSearchResult", () => {
  it("renders flights with per-direction segments, hotel facts, prices and callouts (legacy envelope unwrapped)", () => {
    const out = strip(renderToolPayload("search_flights", SEARCH));
    expect(out).toContain("status Ready");
    expect(out).toContain("id srch-1");
    expect(out).toContain(
      "[0]  TP  ·  BWI→LIS 17:40–06:55 8h 15m nonstop  ·  LIS→BWI 11:10–15:05 8h 55m 1 stop  ·  $812.40  ·  [cheapest, fastest]"
    );
    expect(out).toContain("option_id opt-1");
    expect(out).toContain("[1]  Grand Hotel  ·  ⭐4.5  ·  Pool, Spa, Gym, Bar  ·  $1,290.00  ·  [top rated]");
    expect(out).toContain("… 40 more (showing top 2)");
    // Same payload, bare (current server shape) renders identically.
    expect(strip(renderToolPayload("search_flights", SEARCH.searchFlights))).toBe(out);
  });

  it("points a still-fetching search at the verb-first polling tools", () => {
    const out = strip(
      renderToolPayload("get_search_status", {
        id: "s",
        type: "Hotel",
        status: "Fetching",
        optionsSummary: { optionCount: 0, topOptions: [] },
      })
    );
    expect(out).toContain("poll get_search_status / get_options");
  });

  it("says when a search is still fetching and surfaces fetchError", () => {
    const out = strip(
      renderSearchResult({
        id: "s",
        type: "Hotel",
        status: "Fetching",
        optionsSummary: { optionCount: 0, topOptions: [] },
      })
    );
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
        fetchStatus: {
          status: "NoResults",
          searchedQuery: { summary: "BWI→LIS 2026-11-20, return same day", degenerateHint: "same-day return" },
        },
        optionsSummary: { optionCount: 0, topOptions: [] },
      })
    );
    expect(out).toContain("FlightSelection  ·  status NoResults  ·  selection_id sel-1");
    expect(out).toContain("searched: BWI→LIS 2026-11-20, return same day");
    expect(out).toContain("hint: same-day return");
  });

  // Field names as the live server returns them (2026-09-20): participantChoices[]
  // { id, decided, travellerIds, travellerNames, locked, selectedOption { id, name } },
  // optionsSummary { optionCount, matchedCount, truncated, nextCursor, topOptions, … };
  // null fields are pruned, so an undecided row has no selectedOption and a last
  // page has no nextCursor.
  const HOTEL_PAGE = {
    __typename: "TripPlanHotelSelection",
    id: "sel-h1",
    fetchStatus: { status: "Ready" },
    optionsSummary: {
      optionCount: 5,
      matchedCount: 5,
      truncated: true,
      nextCursor: "eyJvIjoyfQ",
      topOptions: [
        { index: 1, optionId: "opt-a", name: "Hotel A", price: 1862.52, currency: "USD", isBookable: false },
        { index: 2, optionId: "opt-b", name: "Hotel B", price: 2045.73, currency: "USD", isBookable: false },
      ],
      callouts: { cheapestIndex: 1 },
    },
    participantChoices: [
      {
        id: "pc-decided",
        decided: true,
        travellerIds: ["t1"],
        travellerNames: ["Ana Example"],
        locked: false,
        selectedOption: { id: "opt-a", name: "Hotel A" },
      },
      {
        id: "pc-open",
        decided: false,
        travellerIds: ["t2", "t3"],
        travellerNames: ["Bo Example", "Cy Example"],
        locked: false,
      },
    ],
  };

  it("lists the decision rows with their participant_choice_id and a select_option hint for the first undecided row", () => {
    const out = strip(renderSelectionOptions(HOTEL_PAGE));
    const lines = out.split("\n");
    const rowsAt = lines.indexOf("  rows:");
    expect(rowsAt).toBeGreaterThan(lines.findIndex(l => l.includes("option_id opt-b")));
    expect(lines[rowsAt + 1]).toBe("    participant_choice_id pc-decided  ·  Ana Example  ·  decided  ·  → Hotel A");
    expect(lines[rowsAt + 2]).toBe("    participant_choice_id pc-open  ·  Bo Example, Cy Example  ·  undecided");
    expect(lines[rowsAt + 3]).toBe(
      "  decide a row: voyagier select_option --participant_choice_id pc-open --option_id <option_id>"
    );
  });

  it("points at the next page with the server's cursor and the same selection id", () => {
    const out = strip(renderSelectionOptions(HOTEL_PAGE));
    expect(out).toContain("… 3 more (showing top 2)");
    expect(out.split("\n").at(-1)).toBe(
      "  more options: voyagier get_options --selection_id sel-h1 --cursor eyJvIjoyfQ"
    );
    expect(out).not.toContain("--query");
    expect(out).not.toContain("--limit");
    // Same through the tool entry point with no hints (the get_options command without --query/--limit).
    expect(strip(renderToolPayload("get_options", HOTEL_PAGE))).toBe(out);
  });

  it("repeats the query and page size the page was read with, shell-quoted, in the next-page line", () => {
    // The get_options contract: pass nextCursor back as cursor, with the same query.
    const filtered = {
      ...HOTEL_PAGE,
      optionsSummary: { ...HOTEL_PAGE.optionsSummary, optionCount: 12, matchedCount: 5 },
    };
    const out = strip(renderToolPayload("get_options", filtered, { query: "Grand O'Hara hotel", limit: 2 }));
    expect(out.split("\n").at(-1)).toBe(
      "  more options: voyagier get_options --selection_id sel-h1 --cursor eyJvIjoyfQ --query 'Grand O'\\''Hara hotel' --limit 2"
    );
    // A plain word needs no quotes; limit alone threads too.
    expect(strip(renderToolPayload("get_options", filtered, { query: "grand" }))).toMatch(
      /--cursor eyJvIjoyfQ --query grand$/
    );
    expect(strip(renderToolPayload("get_options", filtered, { limit: 2 }))).toMatch(/--cursor eyJvIjoyfQ --limit 2$/);
  });

  it("shell-quotes server-provided ids and cursors in the copy-pasteable lines", () => {
    // The sanitizer strips control characters, not shell metacharacters: a
    // non-UUID id from a custom server must not alter the pasted command.
    const hostile = {
      ...HOTEL_PAGE,
      id: "sel;rm -rf x",
      optionsSummary: { ...HOTEL_PAGE.optionsSummary, nextCursor: "cur$(id)" },
      participantChoices: [
        { id: "pc open`x`", decided: false, travellerIds: ["t2"], travellerNames: ["Bo Example"], locked: false },
      ],
    };
    const out = strip(renderSelectionOptions(hostile));
    expect(out).toContain(
      "decide a row: voyagier select_option --participant_choice_id 'pc open`x`' --option_id <option_id>"
    );
    expect(out.split("\n").at(-1)).toBe(
      "  more options: voyagier get_options --selection_id 'sel;rm -rf x' --cursor 'cur$(id)'"
    );
    // Plain-word ids stay bare (the common case is unchanged).
    expect(strip(renderSelectionOptions(HOTEL_PAGE))).toContain("--participant_choice_id pc-open --option_id");
  });

  it("words a queried digest as matching even when every option matched", () => {
    // matchedCount 5 of optionCount 5 with a --query: filtered, not "3 more (showing top 2)".
    const out = strip(renderToolPayload("get_options", HOTEL_PAGE, { query: "hotel" }));
    expect(out).toContain("… 3 more (showing top 2 of 5 matching, 5 total)");
    const all = strip(
      renderToolPayload(
        "get_options",
        { ...HOTEL_PAGE, optionsSummary: { ...HOTEL_PAGE.optionsSummary, optionCount: 2, matchedCount: 2 } },
        { query: "hotel" }
      )
    );
    expect(all).toContain("  (2 matching of 2 total)");
    expect(all).not.toContain("more (");
  });

  it("omits the select_option hint when every row is decided, and the cursor line on the last page", () => {
    const allDecided = {
      ...HOTEL_PAGE,
      optionsSummary: { ...HOTEL_PAGE.optionsSummary, nextCursor: undefined, truncated: false },
      participantChoices: [
        HOTEL_PAGE.participantChoices[0],
        {
          id: "pc-2",
          decided: true,
          travellerNames: ["Bo Example"],
          locked: true,
          selectedOption: { id: "opt-b", name: "Hotel B" },
        },
      ],
    };
    const out = strip(renderSelectionOptions(allDecided));
    expect(out).toContain("    participant_choice_id pc-2  ·  Bo Example  ·  decided  ·  locked  ·  → Hotel B");
    expect(out).not.toContain("decide a row:");
    expect(out).not.toContain("more options:");
  });

  it("says how many options matched a query filter when the server narrows the digest", () => {
    const filtered = {
      ...HOTEL_PAGE,
      optionsSummary: { ...HOTEL_PAGE.optionsSummary, optionCount: 12, matchedCount: 5 },
    };
    expect(strip(renderSelectionOptions(filtered))).toContain("… 3 more (showing top 2 of 5 matching, 12 total)");
  });

  it('never counts non-matching options as "more" when the page already shows every match', () => {
    // matchedCount 2, optionCount 12, two topOptions: the other ten do not match the query.
    const allMatchesShown = {
      ...HOTEL_PAGE,
      optionsSummary: { ...HOTEL_PAGE.optionsSummary, optionCount: 12, matchedCount: 2 },
    };
    const out = strip(renderSelectionOptions(allMatchesShown));
    expect(out).not.toContain("more (");
    expect(out).toContain("  (2 matching of 12 total)");
    expect(out).not.toContain("10 more");
  });

  it('keeps the count-based "more" line when the server reports no matchedCount', () => {
    const { matchedCount: _m, ...noMatched } = HOTEL_PAGE.optionsSummary;
    const out = strip(renderSelectionOptions({ ...HOTEL_PAGE, optionsSummary: { ...noMatched, optionCount: 12 } }));
    expect(out).toContain("… 10 more (showing top 2)");
    expect(out).not.toContain("matching");
  });

  it("renders a payload without rows or a cursor exactly as before, and skips malformed rows", () => {
    const { participantChoices: _rows, ...noRows } = HOTEL_PAGE;
    const { nextCursor: _c, ...summaryNoCursor } = HOTEL_PAGE.optionsSummary;
    const out = strip(renderSelectionOptions({ ...noRows, optionsSummary: summaryNoCursor }));
    expect(out).toBe(
      [
        "HotelSelection  ·  status Ready  ·  selection_id sel-h1",
        "  [1]  Hotel A  ·  $1,862.52  ·  not bookable  ·  [cheapest]",
        "       option_id opt-a",
        "  [2]  Hotel B  ·  $2,045.73  ·  not bookable",
        "       option_id opt-b",
        "  … 3 more (showing top 2)",
      ].join("\n")
    );
    // Unknown shapes skip the section rather than failing the render.
    const odd = strip(
      renderSelectionOptions({
        ...noRows,
        optionsSummary: { ...summaryNoCursor, nextCursor: 7 },
        participantChoices: ["x", { decided: false }, null],
      })
    );
    expect(odd).toBe(out);
    expect(strip(renderSelectionOptions({ ...noRows, participantChoices: "not-an-array" }))).toContain(
      "option_id opt-a"
    );
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
          {
            name: "Flight BWI → LIS",
            datetime: "2026-11-20T17:40:00",
            localTime: "5:40pm",
            duration: "PT8H15M",
            location: { name: "BWI" },
            travellers: [{ id: "t", name: "Jane Doe" }],
            bookingRecordId: "b1",
          },
          { name: "Check-in Grand Hotel", datetime: "2026-11-21T15:00:00", location: { name: "Grand Hotel" } },
        ],
      })
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
        "get_plan_quote",
        {
          items: [
            {
              selectionId: "s-1",
              optionId: "o-1",
              name: "TP 203 BWI→LIS",
              priceCents: 81240,
              currency: "USD",
              bookable: true,
            },
            {
              selectionId: "s-2",
              name: "Grand Hotel",
              priceCents: 129000,
              currency: "USD",
              bookable: false,
              bookableReason: "room not picked",
            },
          ],
          chargeableTotalCents: 81240,
          currency: "USD",
          acceptance: { expectTotalCents: 81240, itemIds: ["i-1"] },
          checkoutBlockers: [{ kind: "TRAVELLER_DATA", label: "Date of birth" }],
        },
        { planId: "plan-9" }
      )
    );
    expect(out).toContain("• TP 203 BWI→LIS  $812.40  bookable");
    expect(out).toContain("• Grand Hotel  $1,290.00  not bookable: room not picked");
    expect(out).toContain("chargeable total $812.40  (81240 cents)");
    expect(out).toContain("TRAVELLER_DATA: Date of birth");
    expect(out).toContain("voyagier book_plan --plan_id plan-9 --expect_total_cents 81240 --item_ids i-1");
  });

  it("handles a pruned payload with nothing carted", () => {
    const out = strip(
      renderQuote({
        chargeableTotalCents: 0,
        currency: "USD",
        acceptanceUnavailableReason: "no bookable items in the cart",
      })
    );
    expect(out).toContain("No items in the cart yet.");
    expect(out).toContain("No gated booking possible: no bookable items in the cart");
    expect(renderQuote({ something: "else" })).toBeNull();
  });
});

describe("shellQuote", () => {
  it("leaves plain words bare and single-quotes everything else, escaping embedded single quotes", () => {
    expect(shellQuote("grand")).toBe("grand");
    expect(shellQuote("eyJvIjoyfQ==")).toBe("eyJvIjoyfQ==");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("O'Hara")).toBe("'O'\\''Hara'");
    expect(shellQuote('$(rm -rf) `x` ; & | > "q"')).toBe("'$(rm -rf) `x` ; & | > \"q\"'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("renderToolPayload", () => {
  it("returns null for tools without a renderer and never throws on garbage", () => {
    expect(renderToolPayload("list_plans", { items: [] })).toBeNull();
    expect(renderToolPayload("get_plan_status", null)).toBeNull();
    expect(renderToolPayload("get_plan_itinerary", { tripPlan: { tripPlanEvents: [null, 3, "x"] } })).not.toBeNull();
    expect(renderToolPayload("get_plan_itinerary", { tripPlanEvents: [null, 3, "x"] })).not.toBeNull();
  });

  it("keys every renderer by a tool name the server publishes", () => {
    const live = new Set(FIXTURE_TOOLS.map(t => t.name));
    expect(Object.keys(TOOL_RENDERERS).filter(name => !live.has(name))).toEqual([]);
    for (const old of ["plan_status", "search_status", "get_selection_options", "itinerary", "quote"]) {
      expect(renderToolPayload(old, PLAN_STATUS)).toBeNull();
    }
  });
});
