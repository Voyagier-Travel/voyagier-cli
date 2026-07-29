import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();
const mockResolveClient = jest.fn();
const mockProgress = jest.fn();
const mockWarn = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  graphqlWithFieldFallback: jest.fn(),
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../output.js", () => ({
  progress: mockProgress,
  warn: mockWarn,
  fatal: jest.fn(),
  jsonOutput: jest.fn(),
}));

jest.unstable_mockModule("./clients.js", () => ({
  resolveClient: mockResolveClient,
}));

// ── Dynamic import after mocks ─────────────────────────────────────────────

let scaffoldPlan: typeof import("./scaffold.js").scaffoldPlan;
let generateTripTitle: typeof import("./scaffold.js").generateTripTitle;
let desiredGoalShape: typeof import("./scaffold.js").desiredGoalShape;

beforeAll(async () => {
  const mod = await import("./scaffold.js");
  scaffoldPlan = mod.scaffoldPlan;
  generateTripTitle = mod.generateTripTitle;
  desiredGoalShape = mod.desiredGoalShape;
});

// Default scaffold goal graph (mirrors the server template) for prune tests.
const SCAFFOLD_GOALS = [
  { id: "g-trav", name: "Travelers", type: "TravellerList" },
  { id: "g-out", name: "Outbound Flights", type: "Flight" },
  { id: "g-hotel", name: "Secure Lodging", type: "Hotel" },
  { id: "g-ret", name: "Return Flights", type: "Flight" },
  { id: "g-journey", name: "Flight Booking Details", type: "FlightJourney" },
];

beforeEach(() => {
  mockGraphql.mockReset();
  mockResolveClient.mockReset();
  mockProgress.mockReset();
  mockWarn.mockReset();
  mockResolveClient.mockResolvedValue({ id: "client-1", name: "Test Client", autoResolved: false });
});

describe("scaffoldPlan — happy path", () => {
  it("resolves the client and creates a plan with { clientId, title }", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-1", title: "Paris Trip", startDate: null, endDate: null, description: null } });

    const result = await scaffoldPlan({ client: "client-1", title: "Paris Trip" });

    expect(result.plan.id).toBe("plan-1");
    expect(result.plan.title).toBe("Paris Trip");
    expect(result.client).toEqual({ id: "client-1", name: "Test Client", autoResolved: false, isSelf: undefined });
    expect(result.travellerIds).toEqual([]);
    expect(result.prunedGoals).toEqual([]);
    expect(result.pruneWarnings).toEqual([]);

    // Only the create mutation — no traveller fetch, no goal list.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ input: { clientId: "client-1", title: "Paris Trip" } });
    expect(vars.input).not.toHaveProperty("startDate");
    expect(vars.input).not.toHaveProperty("description");
  });

  it("passes dryRun through to the createTripPlan mutation", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-d", title: "Dry" } });
    await scaffoldPlan({ client: "client-1", title: "Dry", dryRun: true });
    const [, , options] = mockGraphql.mock.calls[0] as [string, any, any];
    expect(options).toEqual({ dryRun: true });
  });

  // VOY-1762: the interactivity signal + hint carry-forward flags must be
  // forwarded to resolveClient explicitly (never guessed globally).
  it("forwards interactive + clientHintFlags to resolveClient", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-1", title: "T" } });
    await scaffoldPlan({ client: "Smith", title: "T", interactive: true, clientHintFlags: "--title 'T'" });
    expect(mockResolveClient).toHaveBeenCalledWith("Smith", { interactive: true, carryFlags: "--title 'T'" });
  });

  it("defaults to non-interactive resolveClient when no signal is passed", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-1", title: "T" } });
    await scaffoldPlan({ client: "client-1", title: "T" });
    expect(mockResolveClient).toHaveBeenCalledWith("client-1", { interactive: undefined, carryFlags: undefined });
  });
});

// ── VOY-1762: generated default title for the interactive --title prompt ──────
describe("generateTripTitle", () => {
  const now = new Date(2026, 6, 15); // 2026-07-15 (deterministic clock)

  it("uses destination + Mon YYYY from --to and --depart", () => {
    expect(generateTripTitle({ to: "CDG", depart: "2026-09-03" }, now)).toBe("CDG · Sep 2026");
  });

  it("rejects calendar-overflow dates instead of silently rolling them (Copilot, PR #131)", () => {
    // 2026-02-31 would overflow to Mar 2026 via new Date(); fall back to `now` instead.
    expect(generateTripTitle({ to: "CDG", depart: "2026-02-31" }, now)).toBe("CDG · Jul 2026");
  });

  it("falls back to --hotel for destination and --checkin for the date", () => {
    expect(generateTripTitle({ hotel: "Paris", checkin: "2026-12-20" }, now)).toBe("Paris · Dec 2026");
  });

  it("uses `Trip` + the current Mon YYYY when nothing is derivable", () => {
    expect(generateTripTitle({}, now)).toBe("Trip · Jul 2026");
  });

  it("uses the current month when the date is unparseable but a destination exists", () => {
    expect(generateTripTitle({ to: "Rome", depart: "soon" }, now)).toBe("Rome · Jul 2026");
  });
});

describe("scaffoldPlan — travellers", () => {
  it("adds each parsed traveller and returns their ids", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-2", title: "Trip" } })
      .mockResolvedValueOnce({ createTripPlanTraveller: { id: "t1", firstName: "John", lastName: "Doe" } })
      .mockResolvedValueOnce({ createTripPlanTraveller: { id: "t2", firstName: "Jane", lastName: "Smith" } });

    const result = await scaffoldPlan({ client: "client-1", title: "Trip", travellers: "John Doe, Jane Smith" });

    expect(result.travellerIds).toEqual(["t1", "t2"]);
    expect(mockGraphql).toHaveBeenCalledTimes(3);
    // Second call adds the first traveller with the parsed first/last split.
    const [, addVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(addVars).toEqual({
      tripPlanId: "plan-2",
      input: { firstName: "John", lastName: "Doe", declaredTravellerType: "Adult" },
    });
  });
});

describe("scaffoldPlan — shape pruning", () => {
  it("--one-way --flight-only lists goals, deletes return + hotel, reports them", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-3", title: "OW" } }) // CREATE
      .mockResolvedValueOnce({ tripPlanGoals: SCAFFOLD_GOALS }) // LIST goals
      .mockResolvedValueOnce({ deleteTripPlanGoal: true }) // delete return
      .mockResolvedValueOnce({ deleteTripPlanGoal: true }); // delete hotel

    const result = await scaffoldPlan({
      client: "client-1",
      title: "OW",
      shape: { oneWay: true, flightOnly: true },
    });

    expect(result.prunedGoals.map(g => g.id).sort()).toEqual(["g-hotel", "g-ret"]);
    expect(result.pruneWarnings).toEqual([]);
    // create + list + 2 deletes
    expect(mockGraphql).toHaveBeenCalledTimes(4);
  });

  it("surfaces a warning (not a throw) when the server declines a delete", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-4", title: "F" } })
      .mockResolvedValueOnce({ tripPlanGoals: SCAFFOLD_GOALS })
      .mockResolvedValueOnce({ deleteTripPlanGoal: false }); // server declines the return-flight delete

    const result = await scaffoldPlan({ client: "client-1", title: "F", shape: { oneWay: true } });

    expect(result.prunedGoals).toEqual([]);
    expect(result.pruneWarnings).toHaveLength(1);
    expect(result.pruneWarnings[0]).toContain("plans goal-remove g-ret --force");
    // Warnings are surfaced via warn(), not swallowed.
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("g-ret"));
  });

  it("does not fetch goals when neither a shape flag nor ensureGoals is set (plans-create path)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-5", title: "P" } });
    const result = await scaffoldPlan({ client: "client-1", title: "P" });
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(result.prunedGoals).toEqual([]);
    expect(result.addedGoals).toEqual([]);
  });
});

// ── VOY-1761: desiredGoalShape (the additive twin of selectGoalsToPrune) ─────
describe("desiredGoalShape", () => {
  it("full round-trip + hotel when no flags (plan-trip default)", () => {
    expect(desiredGoalShape({ oneWay: false, flightOnly: false, hotelOnly: false })).toEqual({ flights: 2, hotels: 1 });
  });
  it("one-way flight-only → exactly one Flight goal, no hotel (flight search, no --return)", () => {
    expect(desiredGoalShape({ oneWay: true, flightOnly: true, hotelOnly: false })).toEqual({ flights: 1, hotels: 0 });
  });
  it("round-trip flight-only → two Flight goals, no hotel (flight search, --return)", () => {
    expect(desiredGoalShape({ oneWay: false, flightOnly: true, hotelOnly: false })).toEqual({ flights: 2, hotels: 0 });
  });
  it("hotel-only → one Hotel goal, no flights (hotel search)", () => {
    expect(desiredGoalShape({ oneWay: false, flightOnly: false, hotelOnly: true })).toEqual({ flights: 0, hotels: 1 });
  });
  it("one-way alone still keeps the hotel (a one-way trip can still lodge)", () => {
    expect(desiredGoalShape({ oneWay: true, flightOnly: false, hotelOnly: false })).toEqual({ flights: 1, hotels: 1 });
  });
});

// ── VOY-1761: ensure-goals converges identically in BOTH worlds ──────────────
// (a) server returns the round-trip + hotel TEMPLATE (today), (b) server returns
// ZERO goals (post-1513 blank plans). Same resulting goal shape either way.
describe("scaffoldPlan — ensure-goals both worlds", () => {
  it("one-way flight-only: TEMPLATE world prunes return + hotel, adds nothing", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-t1", title: "T" } })
      .mockResolvedValueOnce({ tripPlanGoals: SCAFFOLD_GOALS })
      .mockResolvedValueOnce({ deleteTripPlanGoal: true }) // return
      .mockResolvedValueOnce({ deleteTripPlanGoal: true }); // hotel

    const result = await scaffoldPlan({
      client: "client-1", title: "T", ensureGoals: true,
      shape: { oneWay: true, flightOnly: true },
    });

    expect(result.prunedGoals.map(g => g.id).sort()).toEqual(["g-hotel", "g-ret"]);
    expect(result.addedGoals).toEqual([]);
    // create + list + 2 deletes (no adds).
    expect(mockGraphql).toHaveBeenCalledTimes(4);
  });

  it("one-way flight-only: BLANK world prunes nothing, adds one Flight goal — same shape", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-b1", title: "B" } })
      .mockResolvedValueOnce({ tripPlanGoals: [] }) // blank plan (VOY-1513)
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-out", name: "Outbound Flights", type: "Flight" } });

    const result = await scaffoldPlan({
      client: "client-1", title: "B", ensureGoals: true,
      shape: { oneWay: true, flightOnly: true },
    });

    expect(result.prunedGoals).toEqual([]);
    expect(result.addedGoals).toEqual([{ id: "ng-out", name: "Outbound Flights", type: "Flight" }]);
    // create + list + 1 add.
    expect(mockGraphql).toHaveBeenCalledTimes(3);
    const addCall = mockGraphql.mock.calls[2] as [string, any];
    expect(addCall[1].input).toMatchObject({ tripPlanId: "plan-b1", type: "Flight" });
  });

  it("round-trip flight-only: BLANK world adds TWO Flight goals (outbound + return)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-b2", title: "RT" } })
      .mockResolvedValueOnce({ tripPlanGoals: [] })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-out", name: "Outbound Flights", type: "Flight" } })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-ret", name: "Return Flights", type: "Flight" } });

    const result = await scaffoldPlan({
      client: "client-1", title: "RT", ensureGoals: true,
      shape: { oneWay: false, flightOnly: true },
    });

    expect(result.addedGoals.map(g => g.id)).toEqual(["ng-out", "ng-ret"]);
    expect(result.prunedGoals).toEqual([]);
  });

  it("hotel-only: BLANK world adds one Hotel goal, no flights", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-b3", title: "H" } })
      .mockResolvedValueOnce({ tripPlanGoals: [] })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-hotel", name: "Accommodation", type: "Hotel" } });

    const result = await scaffoldPlan({
      client: "client-1", title: "H", ensureGoals: true,
      shape: { hotelOnly: true },
    });

    expect(result.addedGoals).toEqual([{ id: "ng-hotel", name: "Accommodation", type: "Hotel" }]);
    const addCall = mockGraphql.mock.calls[2] as [string, any];
    expect(addCall[1].input).toMatchObject({ type: "Hotel" });
  });

  it("ensureGoals with no shape flags: TEMPLATE world already complete → no adds/prunes", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-t2", title: "D" } })
      .mockResolvedValueOnce({ tripPlanGoals: SCAFFOLD_GOALS });

    const result = await scaffoldPlan({ client: "client-1", title: "D", ensureGoals: true });

    expect(result.prunedGoals).toEqual([]);
    expect(result.addedGoals).toEqual([]);
    // create + list only.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("ensureGoals with no shape flags: BLANK world adds the full default (2 flights + 1 hotel)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-b4", title: "D" } })
      .mockResolvedValueOnce({ tripPlanGoals: [] })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-out", name: "Outbound Flights", type: "Flight" } })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-ret", name: "Return Flights", type: "Flight" } })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-hotel", name: "Accommodation", type: "Hotel" } });

    const result = await scaffoldPlan({ client: "client-1", title: "D", ensureGoals: true });

    expect(result.addedGoals.map(g => g.type)).toEqual(["Flight", "Flight", "Hotel"]);
  });

  it("surfaces a warning (not a throw) when adding a missing goal fails", async () => {
    // No shape flags → no "nothing to prune" warnings, so the only warning is the
    // add failure. The failed Flight add doesn't abort the remaining adds.
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-b5", title: "B" } })
      .mockResolvedValueOnce({ tripPlanGoals: [] })
      .mockRejectedValueOnce(new Error("server boom")) // outbound Flight add fails
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-ret", name: "Return Flights", type: "Flight" } })
      .mockResolvedValueOnce({ createTripPlanGoal: { id: "ng-hotel", name: "Accommodation", type: "Hotel" } });

    const result = await scaffoldPlan({ client: "client-1", title: "B", ensureGoals: true });

    expect(result.addedGoals.map(g => g.id)).toEqual(["ng-ret", "ng-hotel"]);
    expect(result.pruneWarnings).toHaveLength(1);
    expect(result.pruneWarnings[0]).toMatch(/Failed to add a Flight goal/);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("Failed to add a Flight goal"));
  });
});

describe("scaffoldPlan — auto-resolved client note", () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stderr: string;

  beforeEach(() => {
    stderr = "";
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((c: any) => {
      stderr += typeof c === "string" ? c : c.toString();
      return true;
    });
    mockResolveClient.mockResolvedValue({ id: "client-1", name: "Daniel Gardner", autoResolved: true });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("writes the auto-resolved note to stderr by default", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-a", title: "A" } });
    await scaffoldPlan({ title: "A" });
    expect(stderr).toContain("auto-resolved client: Daniel Gardner");
    expect(mockProgress).toHaveBeenCalledWith("Creating trip plan...");
  });

  it("suppresses the note and progress under quiet", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-b", title: "B" } });
    await scaffoldPlan({ title: "B", quiet: true });
    expect(stderr).not.toContain("auto-resolved client");
    expect(mockProgress).not.toHaveBeenCalled();
  });

  it("progress:false suppresses progress but keeps the note (plans create contract)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-c", title: "C" } });
    await scaffoldPlan({ title: "C", progress: false });
    expect(stderr).toContain("auto-resolved client: Daniel Gardner");
    expect(mockProgress).not.toHaveBeenCalled();
  });

  it("progress:false silences traveller-add and prune progress too", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-d", title: "D" } }) // create
      .mockResolvedValueOnce({ createTripPlanTraveller: { id: "trav-1" } }) // traveller add
      .mockResolvedValueOnce({ tripPlanGoals: [] }); // prune listing
    await scaffoldPlan({ title: "D", travellers: "Ada", shape: { oneWay: true }, progress: false });
    expect(mockProgress).not.toHaveBeenCalled();
  });
});
