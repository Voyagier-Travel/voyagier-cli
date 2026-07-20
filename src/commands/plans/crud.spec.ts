import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliErrorCode } from "../../errors.js";
import {
  GET_TRIP_PLAN, GET_TRIP_PLAN_SUMMARY, GET_PLAN_DEEP, GET_TRIP_PLAN_ITEM_TYPES,
  CREATE_FLIGHT_SELECTION, CREATE_HOTEL_SELECTION, CREATE_ACTIVITY_SELECTION,

} from "../../queries.js";
import { itemStatus, deepSubSelections, deepChosenOption, DeepItem } from "./types.js";

const mockGraphql = jest.fn();

jest.unstable_mockModule("../../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

// Stub plan-footer so registerCrudCommands doesn't try to fetch a footer in tests.
jest.unstable_mockModule("../../plan-footer.js", () => ({
  printPlanFooter: jest.fn().mockResolvedValue(undefined),
  getPlanSummary: jest.fn().mockResolvedValue({ travellerCount: 0, itemCount: 0 }),
}));

let registerCrudCommands: (plans: Command) => void;

beforeAll(async () => {
  const mod = await import("./crud.js");
  registerCrudCommands = mod.registerCrudCommands;
});

beforeEach(() => {
  mockGraphql.mockReset();
});

let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let writes: string[];
let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
let stderrWrites: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  writes = [];
  stderrWrites = [];
  writeSpy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  stderrSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  writeSpy.mockRestore();
  stderrSpy.mockRestore();
  logSpy.mockRestore();
});

async function runPlansCreate(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerCrudCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", "create", ...args]);
}

async function runPlans(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerCrudCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", ...args]);
}

const sampleClient = {
  id: "2c0dbde7-b658-4c7d-ab5b-0226e1a7e22d",
  name: "Daniel Gardner",
  email: "daniel@example.com",
  phone: null,
  avatarUrl: null,
  description: null,
  clientType: "Individual",
  status: "Active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const samplePlan = {
  id: "plan-1",
  title: "Test plan",
  startDate: null,
  endDate: null,
  description: null,
};

describe("plans create — client wiring", () => {
  it("sends { clientId, title } only when --client is an explicit UUID", async () => {
    // resolveClient takes UUID directly, no list call. Then createTripPlan.
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });

    await runPlansCreate([
      "--client",
      sampleClient.id,
      "--title",
      "Test plan",
      "--json",
    ]);

    // Single graphql call (the create); resolveClient short-circuits on UUID.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({
      input: { clientId: sampleClient.id, title: "Test plan" },
    });
    // Critically: no startDate, endDate, description in input.
    expect(vars.input).not.toHaveProperty("startDate");
    expect(vars.input).not.toHaveProperty("endDate");
    expect(vars.input).not.toHaveProperty("description");
  });

  it("auto-resolves the client when --client is omitted and exactly 1 ACTIVE exists, logs to stderr", async () => {
    // 1) tripPlanClients listing (resolveClient auto path).
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient], count: 1, page: 1, limit: 100 },
    });
    // 2) createTripPlan.
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });

    await runPlansCreate(["--title", "Test plan", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, createVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(createVars).toEqual({
      input: { clientId: sampleClient.id, title: "Test plan" },
    });
    const stderrJoined = stderrWrites.join("");
    expect(stderrJoined).toContain("auto-resolved client: Daniel Gardner");
  });

  it("throws NO_CLIENTS when --client is omitted and no ACTIVE clients exist", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [{ ...sampleClient, status: "Archived" }],
        count: 1,
        page: 1,
        limit: 100,
      },
    });

    await expect(
      runPlansCreate(["--title", "Test plan", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.NO_CLIENTS });
  });

  it("throws MULTIPLE_CLIENTS when --client is omitted and >1 ACTIVE exist", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [sampleClient, { ...sampleClient, id: "clt_OTHER", name: "Other" }],
        count: 2,
        page: 1,
        limit: 100,
      },
    });

    await expect(
      runPlansCreate(["--title", "Test plan", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.MULTIPLE_CLIENTS });
  });

  it("rejects --start/--end/--description on create (no no-op flags; use `plans update`)", async () => {
    // create accepts only { clientId, title }. The old no-op flags were removed:
    // a flag that silently does nothing is a trap for the agent consumer. Dates
    // are set via `plans update`, which wires them through.
    await expect(
      runPlansCreate(["--client", sampleClient.id, "--title", "Test plan", "--start", "2026-09-15"]),
    ).rejects.toThrow(/unknown option '--start'/);
  });

  it("sends only { clientId, title } in create input", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });
    await runPlansCreate(["--client", sampleClient.id, "--title", "Test plan", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toEqual({ clientId: sampleClient.id, title: "Test plan" });
  });
});

// --- VOY-1407 regression: plans get / summary must use the live TripPlanItem schema ---
// The CLI shipped a prod outage by querying TripPlanItem.{date,startTime,endTime,day}
// (dropped in API PR #386) and the singular `selection` field (replaced by `selections`).
// These tests lock the query shape and the multi-selection rendering.

// Mirrors the live dev schema: each TripPlanSelection has candidate `options` and a
// `parentOptionId` pointing at the chosen one (or null when nothing is selected yet).
const planWithSelections = {
  id: "plan-1",
  title: "Paris Trip",
  description: "Anniversary",
  startDate: "2026-09-15",
  endDate: "2026-09-22",
  items: [
    {
      id: "item-flight",
      type: "Selection",
      title: "Flight to Paris",
      selections: [
        {
          id: "sel-dep", type: "Flight", isLocked: false, parentOptionId: "o1",
          options: [
            { id: "o1", name: "B6 DCA→CDG", price: 268, status: "None" },
            { id: "o1b", name: "UA DCA→CDG", price: 540, status: "None" },
          ],
        },
        {
          id: "sel-ret", type: "Flight", isLocked: false, parentOptionId: "o2",
          options: [{ id: "o2", name: "B6 CDG→DCA", price: 330, status: "None" }],
        },
      ],
    },
    {
      id: "item-hotel",
      type: "Selection",
      title: "Hotel in Paris",
      selections: [
        // No parentOptionId => nothing chosen yet (awaiting selection).
        { id: "sel-h", type: "Hotel", isLocked: false, parentOptionId: null, options: [{ id: "h1", name: "Hotel Le Marais", price: 150, status: "None" }] },
      ],
    },
  ],
  travellers: [
    { id: "t1", firstName: "John", lastName: "Doe", declaredTravellerType: "ADULT" },
  ],
};

describe("VOY-1407 — plans get/summary schema alignment", () => {
  it("GET_TRIP_PLAN query uses the live selections/options shape, not dropped fields", () => {
    for (const dead of ["date", "startTime", "endTime", "day"]) {
      // word-boundary check inside the items selection set
      expect(GET_TRIP_PLAN).not.toMatch(new RegExp(`\\b${dead}\\b`));
    }
    expect(GET_TRIP_PLAN).toContain("selections {");
    expect(GET_TRIP_PLAN).not.toMatch(/\bselection\s*\{/);
    // No OLD singular selectedOption node (name/price shape). The NEW model's
    // travellerOptionChoices { selectedOption { id } } is expected (VOY-1701).
    expect(GET_TRIP_PLAN).not.toMatch(/selectedOption\s*\{\s*id\s+name/);
    expect(GET_TRIP_PLAN).toContain("travellerOptionChoices");
    expect(GET_TRIP_PLAN).toContain("parentOptionId");
    expect(GET_TRIP_PLAN).toContain("options {");
  });

  it("GET_TRIP_PLAN_SUMMARY query uses the live selections/options shape, not dropped fields", () => {
    for (const dead of ["date", "startTime", "endTime", "day"]) {
      expect(GET_TRIP_PLAN_SUMMARY).not.toMatch(new RegExp(`\\b${dead}\\b`));
    }
    expect(GET_TRIP_PLAN_SUMMARY).toContain("selections {");
    expect(GET_TRIP_PLAN_SUMMARY).not.toMatch(/\bselection\s*\{/);
    expect(GET_TRIP_PLAN_SUMMARY).not.toMatch(/selectedOption\s*\{\s*id\s+name/);
    expect(GET_TRIP_PLAN_SUMMARY).toContain("travellerOptionChoices");
    expect(GET_TRIP_PLAN_SUMMARY).toContain("parentOptionId");
    expect(GET_TRIP_PLAN_SUMMARY).toContain("options {");
  });

  it("plans get --json passes through the live selections/options shape", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: planWithSelections });
    await runPlans(["get", "plan-1", "--json"]);
    const out = JSON.parse(writes.join(""));
    expect(out.id).toBe("plan-1");
    expect(out.items[0].selections).toHaveLength(2);
    // get --json is a raw passthrough: each selection carries options[] + parentOptionId,
    // and the chosen option is the one whose id === parentOptionId.
    const sels = out.items[0].selections;
    expect(sels[0].parentOptionId).toBe("o1");
    const chosen0 = sels[0].options.find((o: any) => o.id === sels[0].parentOptionId);
    expect(chosen0.name).toBe("B6 DCA→CDG");
    expect(sels[1].parentOptionId).toBe("o2");
    expect(sels[0]).not.toHaveProperty("selectedOption");
  });

  it("plans get --agent surfaces pending selections even when a sibling is chosen", async () => {
    // Item with one chosen + one pending selection must show BOTH lines,
    // not hide the pending one (VOY-1407 Copilot review).
    const mixed = {
      id: "plan-2",
      title: "Mixed",
      description: null,
      startDate: null,
      endDate: null,
      items: [
        {
          id: "i1", type: "Selection", title: "Flights",
          selections: [
            { id: "s-dep", type: "Flight", isLocked: false, parentOptionId: "o1", options: [{ id: "o1", name: "Outbound B6", price: 200, status: "None" }] },
            { id: "s-ret", type: "Flight", isLocked: false, parentOptionId: null, options: [{ id: "o2", name: "Return UA", price: 250, status: "None" }] },
          ],
        },
      ],
      travellers: [],
    };
    mockGraphql.mockResolvedValueOnce({ tripPlan: mixed });
    await runPlans(["get", "plan-2", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("Outbound B6");
    // the pending sibling must still be visible
    expect(out).toContain("awaiting selection");
  });

  it("plans summary --json resolves the chosen option per selection via parentOptionId", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: planWithSelections });
    await runPlans(["summary", "plan-1", "--json"]);
    const out = JSON.parse(writes.join(""));
    const flight = out.items.find((i: any) => i.title === "Flight to Paris");
    expect(flight.selections).toHaveLength(2);
    expect(flight.selections[0].selected).toBe("B6 DCA→CDG");
    expect(flight.selections[1].selected).toBe("B6 CDG→DCA");
    // hotel selection has no parentOptionId => nothing chosen yet
    const hotel = out.items.find((i: any) => i.title === "Hotel in Paris");
    expect(hotel.selections[0].selected).toBeNull();
  });
});

// --- VOY-1412 regression: GET_PLAN_DEEP / item-types queries must use live schema ---

describe("VOY-1412 — GET_PLAN_DEEP schema alignment", () => {
  it("GET_PLAN_DEEP uses selections[]/options[]/childSelections, not dropped fields", () => {
    expect(GET_PLAN_DEEP).toContain("selections {");
    expect(GET_PLAN_DEEP).toContain("childSelections {");
    expect(GET_PLAN_DEEP).toContain("parentOptionId");
    expect(GET_PLAN_DEEP).not.toMatch(/\bselection\s*\{/);
    // Guard against the OLD singular selectedOption node (pre-#386). The
    // participant-choice read `travellerOptionChoices { selectedOption { id } }`
    // is the NEW model and is expected (VOY-1701).
    expect(GET_PLAN_DEEP).not.toMatch(/selectedOption\s*\{\s*id\s+name/);
    expect(GET_PLAN_DEEP).not.toContain("subSelections");
    expect(GET_PLAN_DEEP).toContain("travellerOptionChoices");
  });

  it("GET_TRIP_PLAN_ITEM_TYPES uses selections (plural)", () => {
    expect(GET_TRIP_PLAN_ITEM_TYPES).toContain("selections {");
    expect(GET_TRIP_PLAN_ITEM_TYPES).not.toMatch(/\bselection\s*\{/);
  });

  it("deepChosenOption resolves the option matching parentOptionId (legacy fallback)", () => {
    const sel = { id: "s", parentOptionId: "o2", options: [{ id: "o1", name: "A" }, { id: "o2", name: "B" }] };
    expect(deepChosenOption(sel)?.name).toBe("B");
    expect(deepChosenOption({ id: "s", parentOptionId: null, options: [{ id: "o1", name: "A" }] })).toBeNull();
  });

  it("deepChosenOption resolves from travellerOptionChoices consensus (new-model picks, VOY-1701)", () => {
    const sel = {
      id: "s",
      parentOptionId: null, // new-model picks never write it
      travellerOptionChoices: [
        { traveller: { id: "t1" }, selectedOption: { id: "o2" } },
        { traveller: { id: "t2" }, selectedOption: { id: "o2" } },
      ],
      options: [{ id: "o1", name: "A" }, { id: "o2", name: "B" }],
    };
    expect(deepChosenOption(sel)?.name).toBe("B");
  });

  it("deepChosenOption returns null without consensus (partial or divergent picks)", () => {
    const partial = {
      id: "s", parentOptionId: null,
      travellerOptionChoices: [
        { traveller: { id: "t1" }, selectedOption: { id: "o2" } },
        { traveller: { id: "t2" }, selectedOption: null },
      ],
      options: [{ id: "o2", name: "B" }],
    };
    expect(deepChosenOption(partial)).toBeNull();
  });

  it("deepSubSelections finds childSelections hanging off the chosen option", () => {
    const item: DeepItem = {
      id: "i", type: "Selection", title: "Flight",
      selections: [{
        id: "s1", type: "Flight", isLocked: false, parentOptionId: "opt-1",
        options: [{
          id: "opt-1", name: "AA",
          childSelections: [{ id: "sub-1", type: "FLIGHT_CLASS", parentOptionId: null, options: [{ id: "eco", name: "Economy" }] }],
        }],
      }],
    };
    const subs = deepSubSelections(item);
    expect(subs).toHaveLength(1);
    expect(subs[0].selection.id).toBe("sub-1");
    expect(subs[0].parentOption.name).toBe("AA");
    // status: chosen parent + pending child = needs_sub_selection
    expect(itemStatus(item)).toBe("needs_sub_selection");
  });

  it("itemStatus is pending when a selection has no chosen option", () => {
    const item: DeepItem = {
      id: "i", type: "Selection", title: "Hotel",
      selections: [{ id: "s", type: "Hotel", parentOptionId: null, options: [{ id: "h1", name: "Hotel" }] }],
    };
    expect(itemStatus(item)).toBe("pending");
  });
});

// --- VOY-1413 regression: option blob is `optionData` on the API, aliased to bookingData ---
// `bookingData` was dropped from TripPlanSelectOption (renamed to `optionData`). The CLI
// aliases it back (`bookingData: optionData`) so consumers (extractFlightToken, parseStops,
// formatters) keep reading `opt.bookingData` unchanged. Lock the alias so the drift can't
// silently re-ship and re-break `plan-trip`.
describe("VOY-1413 — option blob field uses optionData (aliased to bookingData)", () => {
  const optionQueries: Array<[string, string]> = [
    ["CREATE_FLIGHT_SELECTION", CREATE_FLIGHT_SELECTION],
    ["CREATE_HOTEL_SELECTION", CREATE_HOTEL_SELECTION],
    ["CREATE_ACTIVITY_SELECTION", CREATE_ACTIVITY_SELECTION],
  ];

  it.each(optionQueries)("%s aliases optionData -> bookingData (no bare bookingData)", (_name, query) => {
    expect(query).toContain("bookingData: optionData");
    // No bare `bookingData` field selection (the dropped field) outside the alias.
    expect(query.replace(/bookingData: optionData/g, "")).not.toMatch(/\bbookingData\b/);
  });
});

// ── Coverage: list ───────────────────────────────────────────────────────────

const logJoined = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

describe("plans create — human output", () => {
  it("prints a confirmation with id, url, and next-step hint", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });
    await runPlansCreate(["--client", sampleClient.id, "--title", "Test plan"]);
    const out = logJoined();
    expect(out).toContain("Created trip plan: Test plan");
    expect(out).toContain(samplePlan.id);
    expect(out).toContain("/plans/plan-1");
    expect(out).toContain("travellers add");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("kaboom"));
    await expect(
      runPlansCreate(["--client", sampleClient.id, "--title", "T", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

describe("plans list", () => {
  // Dates are computed from the real clock (crud.ts --active uses `new Date()`);
  // hardcoded dates were a time bomb that would flip past-tense on main.
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const planA = { ...samplePlan, id: "plan-a", title: "Alpha", startDate: iso(-30), endDate: iso(-25) };
  const planB = { ...samplePlan, id: "plan-b", title: "Beta", startDate: iso(30), endDate: iso(40) };

  it("--json returns items enriched with url + paging metadata", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlans: { items: [planA, planB], count: 2, page: 1, limit: 20 } });
    await runPlans(["list", "--json"]);
    const out = JSON.parse(writes.join(""));
    expect(out.total).toBe(2);
    expect(out.page).toBe(1);
    expect(out.limit).toBe(20);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].url).toContain("/plans/plan-a");
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ page: 1, limit: 20 });
  });

  it("--active filters out past plans and marks the result filtered", async () => {
    // planA ended 25 days ago (past); planB starts in 30 days (future).
    mockGraphql.mockResolvedValueOnce({ tripPlans: { items: [planA, planB], count: 2, page: 1, limit: 20 } });
    await runPlans(["list", "--active", "--json"]);
    const out = JSON.parse(writes.join(""));
    expect(out.filtered).toBe(true);
    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("plan-b");
    // --active always fetches page 1, limit 100 regardless of paging flags.
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ page: 1, limit: 100 });
  });

  it("--agent renders a markdown list with plan links", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlans: { items: [planB], count: 1, page: 1, limit: 20 } });
    await runPlans(["list", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("## Your Trip Plans");
    expect(out).toContain("**Beta**");
    expect(out).toContain("/plans/plan-b");
  });

  it("--agent shows an empty-state line when there are no plans", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlans: { items: [], count: 0, page: 1, limit: 20 } });
    await runPlans(["list", "--agent"]);
    expect(writes.join("")).toContain("_No trip plans found._");
  });

  it("human mode prints a heading with the plan count", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlans: { items: [planA, planB], count: 2, page: 1, limit: 20 } });
    await runPlans(["list"]);
    expect(logJoined()).toContain("2 trip plans");
    expect(logJoined()).toContain("Alpha");
  });

  it("rejects --page below 1 with a VALIDATION error", async () => {
    await expect(runPlans(["list", "--page", "0", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
  });

  it("rejects a non-numeric --limit with a VALIDATION error", async () => {
    await expect(runPlans(["list", "--limit", "abc", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("boom"));
    await expect(runPlans(["list", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── Coverage: get / summary human rendering ──────────────────────────────────

describe("plans get — human & error paths", () => {
  it("prints title, travellers, and chosen selections in human mode", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: planWithSelections });
    await runPlans(["get", "plan-1"]);
    const out = logJoined();
    expect(out).toContain("Paris Trip");
    expect(out).toContain("John Doe");
    expect(out).toContain("B6 DCA→CDG");
    // hotel selection has no chosen option → awaiting selection line
    expect(out).toContain("awaiting selection");
  });

  it("throws NOT_FOUND-free API_ERROR wrap on graphql failure", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("network down"));
    await expect(runPlans(["get", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });

  it("--agent renders travellers section and items without selections", async () => {
    const plan = {
      id: "plan-3",
      title: "Agent Plan",
      description: "Trip desc",
      startDate: "2026-09-15",
      endDate: "2026-09-22",
      items: [
        { id: "i-empty", type: "Selection", title: "Dinner reservation", selections: [] },
        {
          id: "i-flight", type: "Selection", title: "Flight to Paris",
          selections: [
            { id: "s1", type: "Flight", isLocked: false, parentOptionId: "o1", options: [{ id: "o1", name: "B6", price: 200, status: "None" }] },
          ],
        },
      ],
      travellers: [{ id: "t1", firstName: "Jane", lastName: "Roe", declaredTravellerType: "ADULT" }],
    };
    mockGraphql.mockResolvedValueOnce({ tripPlan: plan });
    await runPlans(["get", "plan-3", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("## Agent Plan");
    expect(out).toContain("_Trip desc_");
    expect(out).toContain("### Travellers");
    expect(out).toContain("Jane Roe");
    // item with no selections rendered as a bare bullet
    expect(out).toContain("Dinner reservation");
    expect(out).toContain("B6");
  });

  it("human mode renders items without selections as bare rows", async () => {
    const plan = {
      id: "plan-4", title: "Bare", description: null, startDate: null, endDate: null,
      items: [{ id: "i-empty", type: "Selection", title: "Museum visit", selections: [] }],
      travellers: [],
    };
    mockGraphql.mockResolvedValueOnce({ tripPlan: plan });
    await runPlans(["get", "plan-4"]);
    expect(logJoined()).toContain("Museum visit");
  });
});

describe("plans summary — human rendering", () => {
  it("prints chosen options and a pending marker in human mode", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: planWithSelections });
    await runPlans(["summary", "plan-1"]);
    const out = logJoined();
    expect(out).toContain("Paris Trip");
    expect(out).toContain("B6 DCA→CDG");
    // hotel item has selections but none chosen → pending
    expect(out).toContain("pending");
  });

  it("--agent renders chosen options, a pending marker, and the edit link", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: planWithSelections });
    await runPlans(["summary", "plan-1", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("## Paris Trip");
    expect(out).toContain("B6 DCA→CDG");
    expect(out).toContain("⏳ pending");
    expect(out).toContain("**View & edit:**");
  });

  it("--agent shows an empty-items line when the plan has no items", async () => {
    const plan = { id: "plan-5", title: "Empty", description: null, startDate: null, endDate: null, items: [], travellers: [] };
    mockGraphql.mockResolvedValueOnce({ tripPlan: plan });
    await runPlans(["summary", "plan-5", "--agent"]);
    expect(writes.join("")).toContain("_No items yet._");
  });

  it("human mode shows 'No items yet.' when the plan is empty", async () => {
    const plan = { id: "plan-6", title: "Empty2", description: null, startDate: null, endDate: null, items: [], travellers: [] };
    mockGraphql.mockResolvedValueOnce({ tripPlan: plan });
    await runPlans(["summary", "plan-6"]);
    expect(logJoined()).toContain("No items yet.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("bad"));
    await expect(runPlans(["summary", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── Coverage: update ─────────────────────────────────────────────────────────

describe("plans update", () => {
  const updatedPlan = { ...samplePlan, title: "Renamed", startDate: "2026-09-15", endDate: "2026-09-22", description: "New desc" };

  it("sends only the changed fields then re-fetches for --json output", async () => {
    mockGraphql
      .mockResolvedValueOnce({ updateTripPlan: { id: "plan-1" } }) // UPDATE_TRIP_PLAN
      .mockResolvedValueOnce({ tripPlan: updatedPlan }); // GET_TRIP_PLAN_WITH_DESC refetch

    await runPlans([
      "update", "plan-1",
      "--title", "Renamed",
      "--start", "2026-09-15",
      "--end", "2026-09-22",
      "--description", "New desc",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, updateVars] = mockGraphql.mock.calls[0] as [string, any];
    expect(updateVars).toEqual({
      id: "plan-1",
      input: { title: "Renamed", startDate: "2026-09-15", endDate: "2026-09-22", description: "New desc" },
    });
    const out = JSON.parse(writes.join(""));
    expect(out.title).toBe("Renamed");
    expect(out.url).toContain("/plans/plan-1");
  });

  it("sends only the title when only --title is provided", async () => {
    mockGraphql
      .mockResolvedValueOnce({ updateTripPlan: { id: "plan-1" } })
      .mockResolvedValueOnce({ tripPlan: { ...samplePlan, title: "Just Title" } });
    await runPlans(["update", "plan-1", "--title", "Just Title", "--json"]);
    const [, updateVars] = mockGraphql.mock.calls[0] as [string, any];
    expect(updateVars.input).toEqual({ title: "Just Title" });
  });

  it("fails with VALIDATION when no fields are provided", async () => {
    await expect(runPlans(["update", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects a malformed --start date with VALIDATION", async () => {
    await expect(
      runPlans(["update", "plan-1", "--start", "15-09-2026", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("human mode prints the updated title, dates, and description", async () => {
    mockGraphql
      .mockResolvedValueOnce({ updateTripPlan: { id: "plan-1" } })
      .mockResolvedValueOnce({ tripPlan: updatedPlan });
    await runPlans(["update", "plan-1", "--title", "Renamed", "--start", "2026-09-15", "--end", "2026-09-22", "--description", "New desc"]);
    const out = logJoined();
    expect(out).toContain("Updated trip plan: Renamed");
    expect(out).toContain("New desc");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("upstream 500"));
    await expect(
      runPlans(["update", "plan-1", "--title", "X", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

// ── Coverage: delete ─────────────────────────────────────────────────────────

describe("plans delete", () => {
  it("--json emits { success, id }", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlan: true });
    await runPlans(["delete", "plan-1", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ id: "plan-1" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, id: "plan-1" });
  });

  it("human mode prints a confirmation", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlan: true });
    await runPlans(["delete", "plan-1"]);
    expect(logJoined()).toContain("Deleted trip plan plan-1");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("nope"));
    await expect(runPlans(["delete", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});
