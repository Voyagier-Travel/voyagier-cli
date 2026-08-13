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
let resolveTemplate: typeof import("./scaffold.js").resolveTemplate;

beforeAll(async () => {
  const mod = await import("./scaffold.js");
  scaffoldPlan = mod.scaffoldPlan;
  generateTripTitle = mod.generateTripTitle;
  resolveTemplate = mod.resolveTemplate;
});

// The goal graph the server returns for the default (round-trip + hotel) template.
const SCAFFOLD_GOALS = [
  { id: "g-trav", name: "Travelers", type: "TravellerList" },
  { id: "g-out", name: "Outbound Flights", type: "Flight" },
  { id: "g-hotel", name: "Accommodation", type: "Hotel" },
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
    expect(result.goals).toEqual([]);

    // ONE mutation for the whole thing — no goal list, no prune, no traveller
    // fetch. The template makes the graph correct on creation.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ input: { clientId: "client-1", title: "Paris Trip" } });
    // No template means the server default applies — don't pin it here.
    expect(vars.input).not.toHaveProperty("template");
    expect(vars.input).not.toHaveProperty("startDate");
    expect(vars.input).not.toHaveProperty("description");
  });

  it("passes the template through and reports the goal graph the server built", async () => {
    mockGraphql.mockResolvedValueOnce({
      createTripPlan: {
        id: "plan-h",
        title: "Nashville Stay",
        travellers: [],
        goals: [
          { id: "g-trav", name: "Travelers", type: "TravellerList" },
          { id: "g-hotel", name: "Accommodation", type: "Hotel" },
        ],
      },
    });

    const result = await scaffoldPlan({ client: "client-1", title: "Nashville Stay", template: "HotelOnly" });

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({ template: "HotelOnly" });
    expect(result.template).toBe("HotelOnly");
    expect(result.goals.map(g => g.type)).toEqual(["TravellerList", "Hotel"]);
    // Still one call: no follow-up read to discover what was created.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
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
  /**
   * The party goes in the CREATE call, not a follow-up. Two reasons: passing
   * travellers makes the list authoritative so an INDIVIDUAL client is not
   * auto-seeded on top of them (which would put the client on the plan twice),
   * and the traveller cap is checked before the plan row exists.
   */
  it("sends the parsed party with the create and returns every traveller on the plan", async () => {
    mockGraphql.mockResolvedValueOnce({
      createTripPlan: {
        id: "plan-2",
        title: "Trip",
        travellers: [
          { id: "t1", firstName: "John", lastName: "Doe" },
          { id: "t2", firstName: "Jane", lastName: "Smith" },
        ],
        goals: [],
      },
    });

    const result = await scaffoldPlan({ client: "client-1", title: "Trip", travellers: "John Doe, Jane Smith" });

    expect(result.travellerIds).toEqual(["t1", "t2"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input.travellers).toEqual([
      { firstName: "John", lastName: "Doe", type: "Adult" },
      { firstName: "Jane", lastName: "Smith", type: "Adult" },
    ]);
  });

  it("omits travellers entirely when none were named, so an individual client is still seeded", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: { id: "plan-3", title: "Trip", travellers: [], goals: [] } });

    await scaffoldPlan({ client: "client-1", title: "Trip" });

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).not.toHaveProperty("travellers");
  });
});

/**
 * --template replaced --one-way/--flight-only/--hotel-only. The old flags stay as
 * aliases for one release so existing scripts keep working, but they map onto a
 * template rather than driving a client-side prune.
 */
describe("resolveTemplate", () => {
  it("returns nothing when no template or flag was given (server default applies)", () => {
    expect(resolveTemplate({})).toEqual({});
  });

  it("accepts a template case-insensitively", () => {
    expect(resolveTemplate({ template: "hotelonly" })).toEqual({ template: "HotelOnly" });
    expect(resolveTemplate({ template: " OneWayFlight " })).toEqual({ template: "OneWayFlight" });
  });

  it("rejects an unknown template, listing the valid ones", () => {
    expect(() => resolveTemplate({ template: "RoundTrip" })).toThrow(/Unknown --template "RoundTrip"/);
    expect(() => resolveTemplate({ template: "RoundTrip" })).toThrow(/RoundTripFlightAndHotel/);
  });

  it("rejects mixing --template with the deprecated flags", () => {
    expect(() => resolveTemplate({ template: "HotelOnly", hotelOnly: true })).toThrow(/--template replaces/);
  });

  it.each([
    [{ oneWay: true, flightOnly: true }, "OneWayFlight"],
    [{ oneWay: true }, "OneWayFlightAndHotel"],
    [{ flightOnly: true }, "RoundTripFlight"],
    [{ hotelOnly: true }, "HotelOnly"],
  ])("maps the legacy flags %j onto %s with a deprecation warning", (flags, expected) => {
    const result = resolveTemplate(flags);

    expect(result.template).toBe(expected);
    expect(result.deprecationWarning).toContain(`--template ${expected}`);
  });

  it("rejects --hotel-only combined with a flight flag", () => {
    expect(() => resolveTemplate({ hotelOnly: true, oneWay: true })).toThrow(/hotel-only conflicts/);
    expect(() => resolveTemplate({ hotelOnly: true, flightOnly: true })).toThrow(/hotel-only conflicts/);
  });

  it("rejects the legacy flags on an existing plan — there is nothing to template", () => {
    expect(() => resolveTemplate({ oneWay: true, plan: "plan-1" })).toThrow(/only apply when creating a NEW plan/);
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

  it("progress:false stays silent even with a party and a template", async () => {
    mockGraphql.mockResolvedValueOnce({
      createTripPlan: { id: "plan-d", title: "D", travellers: [{ id: "trav-1" }], goals: SCAFFOLD_GOALS },
    });
    await scaffoldPlan({ title: "D", travellers: "Ada", template: "OneWayFlight", progress: false });
    expect(mockProgress).not.toHaveBeenCalled();
  });
});
