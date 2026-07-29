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

beforeAll(async () => {
  const mod = await import("./scaffold.js");
  scaffoldPlan = mod.scaffoldPlan;
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

  it("does not fetch goals when no shape flags are set", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-5", title: "P" } });
    const result = await scaffoldPlan({ client: "client-1", title: "P" });
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(result.prunedGoals).toEqual([]);
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
});
