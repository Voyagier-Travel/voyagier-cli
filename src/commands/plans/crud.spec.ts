import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliErrorCode } from "../../errors.js";
import { GET_TRIP_PLAN, GET_TRIP_PLAN_SUMMARY } from "../../queries.js";

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

  it("warns to stderr when --start, --end, or --description are passed (currently no-ops)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });

    await runPlansCreate([
      "--client",
      sampleClient.id,
      "--title",
      "Test plan",
      "--start",
      "2026-09-15",
      "--end",
      "2026-09-22",
      "--description",
      "Demo",
      "--json",
    ]);

    const stderrJoined = stderrWrites.join("");
    expect(stderrJoined).toContain("--start, --end, --description");
    expect(stderrJoined).toContain("not yet wired");
    // And critically, those values are NOT sent in input.
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
    // TripPlanSelection has no selectedOption; chosen option is via parentOptionId + options[].
    expect(GET_TRIP_PLAN).not.toContain("selectedOption");
    expect(GET_TRIP_PLAN).toContain("parentOptionId");
    expect(GET_TRIP_PLAN).toContain("options {");
  });

  it("GET_TRIP_PLAN_SUMMARY query uses the live selections/options shape, not dropped fields", () => {
    for (const dead of ["date", "startTime", "endTime", "day"]) {
      expect(GET_TRIP_PLAN_SUMMARY).not.toMatch(new RegExp(`\\b${dead}\\b`));
    }
    expect(GET_TRIP_PLAN_SUMMARY).toContain("selections {");
    expect(GET_TRIP_PLAN_SUMMARY).not.toMatch(/\bselection\s*\{/);
    expect(GET_TRIP_PLAN_SUMMARY).not.toContain("selectedOption");
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
