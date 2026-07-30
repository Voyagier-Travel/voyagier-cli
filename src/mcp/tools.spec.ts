/**
 * tools.ts — table-driven argv-builder tests (no spawning).
 *
 * The builders are the contract between MCP tool input and the CLI's argv, so
 * every case here pins a representative input against the exact args produced:
 * boolean flags omitted when false, arrays → CSV, money rendered via moneyArg()
 * (strings verbatim, numbers toFixed(2)), wait defaulting to true, and the
 * "--json on everything but agent_docs" rule.
 */
import { describe, it, expect } from "@jest/globals";
import {
  TOOLS,
  moneyArg,
  buildDoctorArgs,
  buildCreateClientArgs,
  buildPlanTripArgs,
  buildAddTravellerArgs,
  buildUpdateTravellerArgs,
  buildGoalAddArgs,
  buildSearchFlightsArgs,
  buildSearchHotelsArgs,
  buildSearchActivitiesArgs,
  buildGetSelectionOptionsArgs,
  buildSelectOptionArgs,
  buildPlanStatusArgs,
  buildQuoteArgs,
  buildBookDryRunArgs,
  buildBookArgs,
  buildBookingStatusArgs,
  buildAgentDocsArgs,
} from "./tools.js";

const EXPECTED_TOOL_NAMES = [
  "doctor",
  "create_client",
  "plan_trip",
  "add_traveller",
  "travellers_update",
  "goal_add",
  "search_flights",
  "search_hotels",
  "search_activities",
  "get_selection_options",
  "select_option",
  "plan_status",
  "quote",
  "book_dry_run",
  "book",
  "booking_status",
  "agent_docs",
];

describe("TOOLS table", () => {
  it("exposes exactly the 17 expected tools, in order", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("does NOT expose `send` (emails a real client — CLI-only)", () => {
    expect(TOOLS.map((t) => t.name)).not.toContain("send");
  });

  it("every tool name is snake_case", () => {
    for (const t of TOOLS) expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("every tool has a non-trivial description and a positive timeout", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe("argv builders", () => {
  it("doctor", () => {
    expect(buildDoctorArgs()).toEqual(["doctor", "--json"]);
  });

  it("create_client defaults type to Individual", () => {
    expect(buildCreateClientArgs({ email: "a@b.co", name: "Al" })).toEqual([
      "clients", "upsert", "--email", "a@b.co", "--name", "Al", "--type", "Individual", "--json",
    ]);
    expect(buildCreateClientArgs({ email: "a@b.co", name: "Al", type: "Company" })).toContain("Company");
  });

  it("plan_trip omits absent optionals and false booleans; emits bare flags for true booleans", () => {
    const args = buildPlanTripArgs({ client: "Smith", title: "Paris", from: "DCA", to: "CDG", depart: "2026-09-01", return: "2026-09-08", one_way: false, flight_only: true });
    expect(args).toEqual([
      "plan-trip", "--client", "Smith", "--title", "Paris",
      "--from", "DCA", "--to", "CDG", "--depart", "2026-09-01", "--return", "2026-09-08",
      "--flight-only", "--json",
    ]);
    expect(args).not.toContain("--one-way");
  });

  it("plan_trip supports add-to-existing mode: plan_id only, no client/title (maps to the CLI --plan flag)", () => {
    const args = buildPlanTripArgs({ plan_id: "pl_42", hotel: "Kyoto", checkin: "2026-09-15", checkout: "2026-09-18" });
    expect(args).toEqual([
      "plan-trip", "--hotel", "Kyoto", "--checkin", "2026-09-15", "--checkout", "2026-09-18", "--plan", "pl_42", "--json",
    ]);
    expect(args).not.toContain("--client");
    expect(args).not.toContain("--title");
  });

  it("plan_trip renders numeric guests with String()", () => {
    const args = buildPlanTripArgs({ client: "c", title: "t", guests: 3 });
    const idx = args.indexOf("--guests");
    expect(args[idx + 1]).toBe("3");
  });

  it("add_traveller defaults type to Adult", () => {
    expect(buildAddTravellerArgs({ plan_id: "p", first: "Jane", last: "Doe" })).toEqual([
      "travellers", "add", "--plan", "p", "--first", "Jane", "--last", "Doe", "--type", "Adult", "--json",
    ]);
  });

  it("travellers_update: id positional + only provided fields forwarded", () => {
    expect(buildUpdateTravellerArgs({ traveller_id: "t1", first: "Jane", gender: "F", dob: "1990-01-02" })).toEqual([
      "travellers", "update", "t1", "--first", "Jane", "--gender", "F", "--dob", "1990-01-02", "--json",
    ]);
    // Sparse update: nothing but the id → the CLI's own VALIDATION handles the
    // empty-update case; the builder stays pure and forwards no field flags.
    expect(buildUpdateTravellerArgs({ traveller_id: "t1" })).toEqual(["travellers", "update", "t1", "--json"]);
  });

  it("travellers_update: passport fields, repeatable loyalty, and clear flags", () => {
    const args = buildUpdateTravellerArgs({
      traveller_id: "t9",
      passport_number: "X1234567",
      passport_country: "US",
      passport_nationality: "US",
      passport_expiry: "2030-05",
      frequent_flyer: ["DL:1234567", "B6:987654"],
      clear_hotel_loyalty: true,
    });
    expect(args).toEqual([
      "travellers", "update", "t9",
      "--passport-number", "X1234567", "--passport-country", "US", "--passport-nationality", "US", "--passport-expiry", "2030-05",
      "--frequent-flyer", "DL:1234567", "--frequent-flyer", "B6:987654",
      "--clear-hotel-loyalty", "--json",
    ]);
    // clear flag is a bare flag only when true.
    expect(buildUpdateTravellerArgs({ traveller_id: "t9", clear_hotel_loyalty: false })).not.toContain("--clear-hotel-loyalty");
  });

  it("goal_add: plan_id positional + --type required; optionals only when present", () => {
    expect(buildGoalAddArgs({ plan_id: "pl1", type: "Activity" })).toEqual([
      "plans", "goal-add", "pl1", "--type", "Activity", "--json",
    ]);
    const full = buildGoalAddArgs({
      plan_id: "pl1", type: "Hotel", name: "Stay", relative_day: 2, sort_order: 3,
      date: "2026-09-01", scope: "Group", travellers: "a,b", idempotency_key: "k1",
    });
    expect(full).toEqual([
      "plans", "goal-add", "pl1", "--type", "Hotel", "--name", "Stay",
      "--relative-day", "2", "--sort-order", "3", "--date", "2026-09-01",
      "--scope", "Group", "--travellers", "a,b", "--idempotency-key", "k1", "--json",
    ]);
  });

  it("search_flights includes --return only when present", () => {
    expect(buildSearchFlightsArgs({ plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15" })).toEqual([
      "search", "flights", "--plan", "p", "--from", "JFK", "--to", "NRT", "--date", "2026-09-15", "--json",
    ]);
    expect(buildSearchFlightsArgs({ plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15", return: "2026-09-22" }))
      .toContain("--return");
  });

  it("search_flights maps each sort field to --sort; default order preserved when omitted", () => {
    for (const field of ["price", "duration", "stops"] as const) {
      const args = buildSearchFlightsArgs({ plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15", sort: field });
      expect(args).toEqual(expect.arrayContaining(["--sort", field]));
    }
    // No sort → no --sort flag → CLI default (server order) preserved.
    expect(buildSearchFlightsArgs({ plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15" })).not.toContain("--sort");
  });

  it("search_hotels", () => {
    expect(buildSearchHotelsArgs({ plan_id: "p", location: "Paris", checkin: "2026-09-01", checkout: "2026-09-05" })).toEqual([
      "search", "hotels", "--plan", "p", "--location", "Paris", "--checkin", "2026-09-01", "--checkout", "2026-09-05", "--json",
    ]);
  });

  it("search_hotels maps sort=price to --sort; default order preserved when omitted", () => {
    expect(buildSearchHotelsArgs({ plan_id: "p", location: "Paris", checkin: "2026-09-01", checkout: "2026-09-05", sort: "price" }))
      .toEqual(expect.arrayContaining(["--sort", "price"]));
    expect(buildSearchHotelsArgs({ plan_id: "p", location: "Paris", checkin: "2026-09-01", checkout: "2026-09-05" }))
      .not.toContain("--sort");
  });

  it("search_activities includes --query only when present", () => {
    expect(buildSearchActivitiesArgs({ plan_id: "p", destination: "Tokyo", date: "2026-09-16" })).toEqual([
      "search", "activities", "--plan", "p", "--destination", "Tokyo", "--date", "2026-09-16", "--json",
    ]);
    expect(buildSearchActivitiesArgs({ plan_id: "p", destination: "Tokyo", date: "2026-09-16", query: "sushi" }))
      .toEqual(expect.arrayContaining(["--query", "sushi"]));
  });

  it("get_selection_options: wait defaults to true, omitted only when explicitly false", () => {
    expect(buildGetSelectionOptionsArgs({ selection_id: "s1" })).toEqual(["selection-options", "s1", "--wait", "--json"]);
    expect(buildGetSelectionOptionsArgs({ selection_id: "s1", wait: true })).toContain("--wait");
    expect(buildGetSelectionOptionsArgs({ selection_id: "s1", wait: false })).toEqual(["selection-options", "s1", "--json"]);
  });

  it("select_option uses explicit-id mode ONLY (never index mode) and waits by default", () => {
    const args = buildSelectOptionArgs({ selection_id: "s1", option_id: "o1" });
    expect(args).toEqual(["select", "--selection-id", "s1", "--option-id", "o1", "--wait", "--json"]);
    // No bare numeric positional that would trigger index mode / global-state reads.
    expect(args.some((a) => /^\d+$/.test(a))).toBe(false);
    expect(buildSelectOptionArgs({ selection_id: "s1", option_id: "o1", wait: false })).not.toContain("--wait");
  });

  it("plan_status / quote / booking_status", () => {
    expect(buildPlanStatusArgs({ plan_id: "p" })).toEqual(["plan-status", "p", "--json"]);
    expect(buildQuoteArgs({ plan_id: "p" })).toEqual(["quote", "p", "--json"]);
    expect(buildBookingStatusArgs({ plan_id: "p" })).toEqual(["book", "p", "--status", "--json"]);
  });

  it("book_dry_run: --expect-total only when provided, rendered via moneyArg", () => {
    expect(buildBookDryRunArgs({ plan_id: "p" })).toEqual(["book", "p", "--dry-run", "--json"]);
    const gated = buildBookDryRunArgs({ plan_id: "p", expect_total: 339.1 });
    expect(gated).toEqual(["book", "p", "--dry-run", "--expect-total", "339.10", "--json"]);
  });

  it("book: expect_total required + rendered via moneyArg; array types → CSV; false booleans omitted", () => {
    const args = buildBookArgs({ plan_id: "p", expect_total: 1297.06, validate: false, only_bookable: true, types: ["Activity", "Hotel"], rebook: false });
    expect(args).toEqual([
      "book", "p", "--expect-total", "1297.06", "--only-bookable", "--types", "Activity,Hotel", "--json",
    ]);
    expect(args).not.toContain("--validate");
    expect(args).not.toContain("--rebook");
    expect(args).not.toContain("--max-total");
  });

  it("book: --max-total rendered via moneyArg when present", () => {
    const args = buildBookArgs({ plan_id: "p", expect_total: 400, max_total: 450 });
    expect(args).toEqual(expect.arrayContaining(["--expect-total", "400.00", "--max-total", "450.00"]));
  });

  describe("moneyArg", () => {
    it("forwards strings verbatim (trimmed) — exact passthrough, no float round-trip", () => {
      expect(moneyArg("339.10")).toBe("339.10");
      expect(moneyArg(" 2418.60 ")).toBe("2418.60");
    });

    it("renders numbers with toFixed(2), recovering intended cents from float artifacts", () => {
      expect(moneyArg(339.1)).toBe("339.10");
      expect(moneyArg(100.1 + 0.2)).toBe("100.30"); // String() would emit 100.30000000000000004
      expect(moneyArg(400)).toBe("400.00");
    });

    it("book schema accepts string money and forwards it verbatim", () => {
      const args = buildBookArgs({ plan_id: "p", expect_total: "1297.06", max_total: "1300.00" });
      expect(args).toEqual(expect.arrayContaining(["--expect-total", "1297.06", "--max-total", "1300.00"]));
    });
  });

  it("add_traveller forwards repeatable frequent_flyer and hotel_loyalty params", () => {
    expect(buildAddTravellerArgs({
      plan_id: "p", first: "Jane", last: "Doe",
      frequent_flyer: ["DL:1234567", "B6:987654"],
      hotel_loyalty: ["HI:12345678"],
    })).toEqual([
      "travellers", "add", "--plan", "p", "--first", "Jane", "--last", "Doe", "--type", "Adult",
      "--frequent-flyer", "DL:1234567", "--frequent-flyer", "B6:987654",
      "--hotel-loyalty", "HI:12345678",
      "--json",
    ]);
  });

  it("agent_docs is the ONLY builder without --json", () => {
    expect(buildAgentDocsArgs()).toEqual(["agent-docs"]);
  });
});

describe("--json discipline via the table (buildArgs on representative input)", () => {
  // Minimal valid input per tool so buildArgs runs; then assert the --json rule.
  const SAMPLE: Record<string, Record<string, unknown>> = {
    doctor: {},
    create_client: { email: "a@b.co", name: "n" },
    plan_trip: { client: "c", title: "t" },
    add_traveller: { plan_id: "p", first: "f", last: "l" },
    travellers_update: { traveller_id: "t", first: "f" },
    goal_add: { plan_id: "p", type: "Activity" },
    search_flights: { plan_id: "p", from: "A", to: "B", date: "d" },
    search_hotels: { plan_id: "p", location: "L", checkin: "c", checkout: "o" },
    search_activities: { plan_id: "p", destination: "D", date: "d" },
    get_selection_options: { selection_id: "s" },
    select_option: { selection_id: "s", option_id: "o" },
    plan_status: { plan_id: "p" },
    quote: { plan_id: "p" },
    book_dry_run: { plan_id: "p" },
    book: { plan_id: "p", expect_total: 10 },
    booking_status: { plan_id: "p" },
    agent_docs: {},
  };

  it.each(TOOLS.map((t) => t.name))("%s ends with --json unless it is agent_docs", (name) => {
    const tool = TOOLS.find((t) => t.name === name)!;
    const args = tool.buildArgs(SAMPLE[name]);
    if (name === "agent_docs") {
      expect(args).not.toContain("--json");
    } else {
      expect(args[args.length - 1]).toBe("--json");
    }
  });
});


