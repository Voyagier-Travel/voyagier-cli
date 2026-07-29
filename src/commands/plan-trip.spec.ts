import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();

// Compat-wrapper double (VOY-1748) delegating to mockGraphql, so resolveClient's
// fetchAllClients still routes through mockGraphql (preserving call-count
// assertions). Real fallback detection is unit-tested in api.spec.ts.
async function graphqlWithFieldFallbackDouble(
  enriched: string,
  legacy: string,
  pattern: RegExp,
  variables?: Record<string, unknown>,
  options?: unknown,
): Promise<unknown> {
  const invoke = (q: string): Promise<unknown> => {
    const args: unknown[] = [q, variables, options];
    while (args.length > 1 && args[args.length - 1] === undefined) args.pop();
    return (mockGraphql as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  try {
    return await invoke(enriched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot query field|Unknown field/i.test(message) && pattern.test(message)) {
      return await invoke(legacy);
    }
    throw err;
  }
}

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  graphqlWithFieldFallback: graphqlWithFieldFallbackDouble,
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AuthError";
    }
  },
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://api.test.voyagier.com/graphql"),
  getHomeAirports: jest.fn().mockReturnValue(["DCA"]),
}));

jest.unstable_mockModule("../output.js", () => ({
  progress: jest.fn(),
  warn: jest.fn(),
  fatal: jest.fn().mockImplementation((msg: unknown) => {
    throw new Error(String(msg));
  }),
  jsonOutput: jest.fn().mockImplementation((data: unknown) => {
    process.stdout.write(JSON.stringify(data) + "\n");
  }),
  jsonOutputWithPlan: jest.fn().mockImplementation((data: unknown, planId: string, planTitle?: string) => {
    process.stdout.write(JSON.stringify({ ...data as object, planContext: { planId, title: planTitle } }) + "\n");
  }),
}));

jest.unstable_mockModule("../utils.js", () => ({
  validateDate: jest.fn(),
  warnPastDate: jest.fn(),
  validateIata: jest.fn(),
  extractFlightToken: jest.fn().mockImplementation((bd: unknown) => {
    if (bd && typeof bd === "object" && "flightToken" in bd) return (bd as Record<string, unknown>).flightToken as string;
    return undefined;
  }),
  buildFlightSummary: jest.fn().mockImplementation(
    (opt: unknown, origin: unknown, dest: unknown) =>
      `${String(origin)}→${String(dest)} · ${(opt as Record<string, unknown>).airline ?? "??"} · $${(opt as Record<string, unknown>).price ?? 0}`
  ),
  buildHotelSummary: jest.fn().mockImplementation(
    (opt: unknown) => `${(opt as Record<string, unknown>).name} · $${(opt as Record<string, unknown>).price ?? 0}/night`
  ),
  deriveBaseUrl: jest.fn().mockReturnValue("https://app.voyagier.com"),
  formatPrice: jest.fn().mockImplementation((p: unknown) => `$${Number(p).toFixed(2)}`),
  formatDateRange: jest.fn().mockReturnValue("Mar 23-25, 2026"),
  // Real implementation so next-step shell-safety is actually asserted.
  shellArg: jest.fn().mockImplementation((v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.length > 0 && /^[A-Za-z0-9_./:@%+,=-]+$/.test(s)) return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
  }),
}));

jest.unstable_mockModule("../data/airports.js", () => ({
  searchAirports: jest.fn().mockReturnValue([]),
}));

jest.unstable_mockModule("../data/metro-areas.js", () => ({
  findMetroArea: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule("./clients.js", () => ({
  resolveClient: jest.fn().mockResolvedValue({ id: "client-1", name: "Test Client", autoResolved: false }),
}));

// VOY-1762: default non-interactive so every existing test keeps its exact
// non-TTY behavior; individual tests flip mockIsInteractive to exercise prompts.
const mockIsInteractive = jest.fn(() => false);
const mockPromptText = jest.fn<() => Promise<string>>();
jest.unstable_mockModule("../prompt.js", () => ({
  isInteractive: mockIsInteractive,
  promptText: mockPromptText,
  promptPick: jest.fn(),
}));

jest.unstable_mockModule("../agent-output.js", () => ({
  agentFlightOptions: jest.fn().mockReturnValue("1. AA · 10h · $500"),
  agentHotelOptions: jest.fn().mockReturnValue("1. Grand Hotel · $200/night"),
}));

// ── Dynamic imports after mocks ────────────────────────────────────────────

let registerPlanTripCommand: (program: Command) => void;
let parseDurationMinutes: (d?: string) => number;
let parseStops: (bd?: Record<string, unknown>) => number;
let nextDay: (d?: string) => string | undefined;

beforeAll(async () => {
  const mod = await import("./plan-trip.js");
  registerPlanTripCommand = mod.registerPlanTripCommand;
  parseDurationMinutes = mod.parseDurationMinutes as (d?: string) => number;
  parseStops = mod.parseStops as (bd?: Record<string, unknown>) => number;
  nextDay = mod.nextDay as (d?: string) => string | undefined;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeOpt(overrides: {
  id: string;
  price?: number;
  duration?: string;
  airline?: string;
  stops?: number;
  sortOrder?: number;
}) {
  return {
    id: overrides.id,
    name: `Option ${overrides.id}`,
    price: overrides.price,
    duration: overrides.duration,
    airline: overrides.airline,
    bookingData: overrides.stops !== undefined
      ? { stops: overrides.stops, flightToken: `tok-${overrides.id}` }
      : { flightToken: `tok-${overrides.id}` },
    sortOrder: overrides.sortOrder ?? 0,
  };
}

const MOCK_PLAN = {
  createTripPlan: { id: "plan-1", title: "Paris Trip", startDate: "2026-03-23", endDate: "2026-03-25" },
};

const MOCK_TRAVELLERS_EMPTY = {
  tripPlanTravellers: [],
};

const MOCK_FLIGHT_OPTIONS = [
  makeOpt({ id: "f1", price: 268, duration: "10h5m", airline: "B6", stops: 1, sortOrder: 0 }),
  makeOpt({ id: "f2", price: 2870, duration: "9h55m", airline: "UA", stops: 1, sortOrder: 1 }),
  makeOpt({ id: "f3", price: 2876, duration: "10h45m", airline: "AF", stops: 1, sortOrder: 2 }),
  makeOpt({ id: "f4", price: 500, duration: "8h0m", airline: "DL", stops: 0, sortOrder: 3 }),
];

const MOCK_FLIGHT_SELECTION = {
  createTripPlanFlightSelection: {
    item: { id: "item-1", title: "Flight DCA→CDG", tripPlanId: "plan-1" },
    selection: { id: "sel-1" },
    options: MOCK_FLIGHT_OPTIONS,
  },
};

const MOCK_DEPARTURE_RESULT = {
  selectDepartureFlight: {
    id: "sel-1",
    options: [
      { id: "r1", name: "Return B6 34", price: 330, duration: "12h40m", airline: "B6", bookingData: { flightToken: "tok-r1" } },
      { id: "r2", name: "Return UA 100", price: 450, duration: "11h30m", airline: "UA", bookingData: { flightToken: "tok-r2" } },
    ],
  },
};

const MOCK_RETURN_RESULT = {
  selectReturnFlight: {
    id: "sel-1",
    options: [
      { id: "final-1", name: "Combined B6", price: 598 },
    ],
  },
};

const MOCK_SET_SELECTED = {
  setTripPlanSelectedOption: {
    id: "sel-1",
    selectedOption: { id: "final-1", name: "Combined B6", price: 598 },
  },
};

// New model: item.selections[]; chosen option (parentOptionId) carries childSelections[].
const MOCK_PLAN_DEEP_WITH_SUBS = {
  tripPlan: {
    id: "plan-1",
    title: "Paris Trip",
    items: [
      {
        id: "item-1",
        title: "Flight DCA→CDG",
        type: "Selection",
        selections: [
          {
            id: "sel-1",
            type: "Flight",
            isLocked: false,
            parentOptionId: "final-1",
            options: [
              {
                id: "final-1",
                name: "Combined B6",
                price: 598,
                status: "ACTIVE",
                isBookable: true,
                sortOrder: 0,
                childSelections: [
                  {
                    id: "sub-1",
                    type: "FLIGHT_CLASS",
                    isLocked: false,
                    parentOptionId: null,
                    options: [
                      { id: "class-eco", name: "Economy", price: 0, sortOrder: 0 },
                      { id: "class-biz", name: "Business", price: 500, sortOrder: 1 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const MOCK_SET_SUB_SELECTION = {
  setTripPlanSubSelectionOption: {
    id: "sub-1",
    selectedOptionId: "class-eco",
    selectedOption: { id: "class-eco", name: "Economy", price: 0 },
  },
};

const MOCK_PLAN_DEEP_NO_SUBS = {
  tripPlan: {
    id: "plan-1",
    title: "Paris Trip",
    items: [
      {
        id: "item-1",
        title: "Flight DCA→CDG",
        selection: {
          id: "sel-1",
          isLocked: false,
          selectedOption: {
            id: "final-1",
            name: "Combined B6",
            price: 598,
            status: "ACTIVE",
            subSelections: [],
          },
        },
      },
    ],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function runPlanTrip(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerPlanTripCommand(program);
  await program.parseAsync(["node", "voyagier", "plan-trip", ...args]);
}

// ── Unit tests: parseDurationMinutes ──────────────────────────────────────

describe("parseDurationMinutes", () => {
  it("parses Xh Ym format", () => {
    expect(parseDurationMinutes("10h5m")).toBe(605);
    expect(parseDurationMinutes("1h30m")).toBe(90);
    expect(parseDurationMinutes("0h45m")).toBe(45);
  });

  it("parses hours-only format", () => {
    expect(parseDurationMinutes("8h")).toBe(480);
  });

  it("parses minutes-only format", () => {
    expect(parseDurationMinutes("45m")).toBe(45);
  });

  it("returns Infinity for undefined or unparseable", () => {
    expect(parseDurationMinutes(undefined)).toBe(Infinity);
    expect(parseDurationMinutes("")).toBe(Infinity);
    expect(parseDurationMinutes("unknown")).toBe(Infinity);
  });
});

// ── Unit tests: nextDay ───────────────────────────────────────────────────

describe("nextDay", () => {
  it("returns the next calendar day for a YYYY-MM-DD string", () => {
    expect(nextDay("2026-09-01")).toBe("2026-09-02");
  });
  it("rolls month/year boundaries (UTC-safe)", () => {
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29"); // leap year
  });
  it("returns undefined for missing or malformed input", () => {
    expect(nextDay(undefined)).toBeUndefined();
    expect(nextDay("")).toBeUndefined();
    expect(nextDay("not-a-date")).toBeUndefined();
    expect(nextDay("2026/09/01")).toBeUndefined();
  });
});

// ── Unit tests: parseStops ────────────────────────────────────────────────

describe("parseStops", () => {
  it("reads numeric stops field", () => {
    expect(parseStops({ stops: 0 })).toBe(0);
    expect(parseStops({ stops: 2 })).toBe(2);
  });

  it("derives stops from segments length", () => {
    expect(parseStops({ segments: ["a", "b"] })).toBe(1);
    expect(parseStops({ segments: ["a", "b", "c"] })).toBe(2);
    expect(parseStops({ segments: ["a"] })).toBe(0);
  });

  it("returns Infinity for missing bookingData", () => {
    expect(parseStops(undefined)).toBe(Infinity);
    expect(parseStops({})).toBe(Infinity);
  });
// ── Integration tests: scaffold flow ──
// ── plan-trip creates plan + travellers + default goal graph, then hands off
// to the composable primitives (search → selection-options → select). ──

describe("plan-trip scaffold (VOY-1414)", () => {
  let stdout: string;
  let writeSpy: ReturnType<typeof jest.spyOn>;

  const jsonOutputCalls = (): any => {
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  };

  beforeEach(() => {
    mockGraphql.mockReset();
    stdout = "";
    writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((c: any) => {
      stdout += typeof c === "string" ? c : c.toString();
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("creates a plan and emits compose next-steps (JSON)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-1", title: "Paris Trip" } }) // CREATE_TRIP_PLAN (via scaffoldPlan)
      .mockResolvedValueOnce({ tripPlanTravellers: [] }); // GET_TRAVELLERS_BRIEF

    await runPlanTrip(["--client", "client-1", "--title", "Paris Trip", "--json"]);

    const out = jsonOutputCalls();
    expect(out).toBeTruthy();
    expect(out.tripPlanId).toBe("plan-1");
    expect(out.scaffolded).toBe(true);
    // It must NOT auto-search/select; only create + travellers reads.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(out.nextSteps.some((s: string) => s.includes("selection-options"))).toBe(true);
    expect(out.nextSteps.some((s: string) => s.includes("select --selection-id"))).toBe(true);
  });

  it("prompts for --title with a generated default when interactive and none given (VOY-1762)", async () => {
    mockIsInteractive.mockReturnValue(true);
    mockPromptText.mockResolvedValue("Prompted Title");
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-i", title: "Prompted Title" } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });
    try {
      await runPlanTrip(["--client", "client-1", "--json"]);
      const [, vars] = mockGraphql.mock.calls[0] as [string, any];
      expect(vars.input.title).toBe("Prompted Title");
      // A generated `<...> · <Mon YYYY>` default is offered to the prompt.
      expect(mockPromptText).toHaveBeenCalledWith("Trip title: ", { default: expect.stringContaining("·") });
    } finally {
      mockIsInteractive.mockReturnValue(false);
    }
  });

  it("suggests a search flights next-step when --to/--depart given (but does not run it)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-2", title: "Trip" } })
      .mockResolvedValueOnce({ tripPlanTravellers: [{ id: "t1", firstName: "A", lastName: "B" }] });

    await runPlanTrip(["--client", "client-1", "--title", "Trip", "--to", "MCO", "--depart", "2026-09-01", "--json"]);

    const out = jsonOutputCalls();
    expect(mockGraphql).toHaveBeenCalledTimes(2); // still only create + travellers
    expect(out.nextSteps.some((s: string) => s.includes("search flights") && s.includes("--to MCO"))).toBe(true);
  });

  it("shell-quotes next-step values that contain spaces (thread 7)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-q", title: "Trip" } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip([
      "--client", "client-1", "--title", "Trip",
      "--hotel", "Grand Plaza Hotel",
      "--checkin", "2026-09-01", "--checkout", "2026-09-05",
      "--json",
    ]);

    const out = jsonOutputCalls();
    const hotelStep = out.nextSteps.find((s: string) => s.includes("search hotels"));
    // The spaced value must be single-quoted so the pasted command is valid.
    expect(hotelStep).toContain("--location 'Grand Plaza Hotel'");
    // And not left bare/unquoted.
    expect(hotelStep).not.toMatch(/--location Grand Plaza Hotel/);
  });

  it("hotel next-step ALWAYS carries --checkin/--checkout, deriving checkout when missing (thread 8)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-h", title: "Trip" } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    // --hotel given with a depart date but NO checkout/return: command must still
    // be runnable (checkout derived from checkin + 1 day).
    await runPlanTrip(["--client", "client-1", "--title", "Trip", "--hotel", "Marriott", "--depart", "2026-09-01", "--json"]);

    const hotelStep = jsonOutputCalls().nextSteps.find((s: string) => s.includes("search hotels"));
    expect(hotelStep).toContain("--checkin 2026-09-01");
    expect(hotelStep).toContain("--checkout 2026-09-02");
  });

  it("hotel next-step uses placeholders when there is no date context at all (thread 8)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-h2", title: "Trip" } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--client", "client-1", "--title", "Trip", "--hotel", "Marriott", "--json"]);

    const hotelStep = jsonOutputCalls().nextSteps.find((s: string) => s.includes("search hotels"));
    // Placeholders contain spaces, so they must be quoted, and both flags present.
    expect(hotelStep).toMatch(/--checkin '<checkin/);
    expect(hotelStep).toMatch(/--checkout '<checkout/);
  });

  it("reuses an existing plan with --plan (fetch, no create)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlan: { id: "plan-X", title: "Existing" } }) // GET_TRIP_PLAN_BASIC
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--plan", "plan-X", "--json"]);

    const out = jsonOutputCalls();
    expect(out.tripPlanId).toBe("plan-X");
  });

  it("--plan with --travellers adds them to the existing plan (no fallback fetch)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlan: { id: "plan-X", title: "Existing" } }) // GET_TRIP_PLAN_BASIC
      .mockResolvedValueOnce({ createTripPlanTraveller: { id: "t1", firstName: "Ann", lastName: "Lee" } }); // add

    await runPlanTrip(["--plan", "plan-X", "--travellers", "Ann Lee", "--json"]);

    const out = jsonOutputCalls();
    expect(out.tripPlanId).toBe("plan-X");
    expect(out.travellerIds).toEqual(["t1"]);
    // fetch + add only — the fallback traveller fetch is skipped when we added some.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });
});

// ── Unit tests: trip-shape pruning (VOY-1727) ──────────────────────────────

const SCAFFOLD_GOALS = [
  { id: "g-trav", name: "Travelers", type: "TravellerList" },
  { id: "g-curr", name: "Choose Currency", type: "Currency" },
  { id: "g-dur", name: "Choose Duration", type: "Duration" },
  { id: "g-date", name: "Choose Date", type: "Date" },
  { id: "g-dest", name: "Choose Destination", type: "Destination" },
  { id: "g-out", name: "Outbound Flights", type: "Flight" },
  { id: "g-hotel", name: "Secure Lodging", type: "Hotel" },
  { id: "g-ret", name: "Return Flights", type: "Flight" },
  { id: "g-manifest", name: "Traveler Manifest", type: "TravellerList" },
  { id: "g-journey", name: "Flight Booking Details", type: "FlightJourney" },
];

describe("selectGoalsToPrune (VOY-1727)", () => {
  let selectGoalsToPrune: typeof import("./plan-trip.js").selectGoalsToPrune;

  beforeAll(async () => {
    const mod = await import("./plan-trip.js");
    selectGoalsToPrune = mod.selectGoalsToPrune;
  });

  it("--one-way prunes only the return-flight goal", () => {
    const { prune, warnings } = selectGoalsToPrune(SCAFFOLD_GOALS, { oneWay: true, flightOnly: false, hotelOnly: false });
    expect(prune.map(g => g.id)).toEqual(["g-ret"]);
    expect(warnings).toEqual([]);
  });

  it("--flight-only prunes only Hotel-type goals", () => {
    const { prune, warnings } = selectGoalsToPrune(SCAFFOLD_GOALS, { oneWay: false, flightOnly: true, hotelOnly: false });
    expect(prune.map(g => g.id)).toEqual(["g-hotel"]);
    expect(warnings).toEqual([]);
  });

  it("--one-way --flight-only prunes both, no duplicates", () => {
    const { prune } = selectGoalsToPrune(SCAFFOLD_GOALS, { oneWay: true, flightOnly: true, hotelOnly: false });
    expect(prune.map(g => g.id).sort()).toEqual(["g-hotel", "g-ret"]);
  });

  it("--hotel-only prunes all Flight and FlightJourney goals, keeps Hotel", () => {
    const { prune } = selectGoalsToPrune(SCAFFOLD_GOALS, { oneWay: false, flightOnly: false, hotelOnly: true });
    expect(prune.map(g => g.id).sort()).toEqual(["g-journey", "g-out", "g-ret"]);
  });

  it("matches the return goal case-insensitively and does NOT touch non-Flight goals named 'return'", () => {
    const goals = [
      { id: "g1", name: "RETURN flights", type: "Flight" },
      { id: "g2", name: "Return policy", type: "Hotel" },
    ];
    const { prune } = selectGoalsToPrune(goals, { oneWay: true, flightOnly: false, hotelOnly: false });
    expect(prune.map(g => g.id)).toEqual(["g1"]);
  });

  it("warns (does not throw) when a shape flag matches nothing", () => {
    const noMatch = SCAFFOLD_GOALS.filter(g => g.type !== "Flight" && g.type !== "Hotel" && g.type !== "FlightJourney");
    const oneWay = selectGoalsToPrune(noMatch, { oneWay: true, flightOnly: false, hotelOnly: false });
    expect(oneWay.prune).toEqual([]);
    expect(oneWay.warnings.length).toBe(1);
    expect(oneWay.warnings[0]).toContain("--one-way");
    const hotelOnly = selectGoalsToPrune(noMatch, { oneWay: false, flightOnly: true, hotelOnly: true });
    expect(hotelOnly.prune).toEqual([]);
    expect(hotelOnly.warnings.length).toBe(2);
  });

  it("handles null goal names", () => {
    const goals = [{ id: "g1", name: null, type: "Flight" }];
    const { prune, warnings } = selectGoalsToPrune(goals, { oneWay: true, flightOnly: false, hotelOnly: false });
    expect(prune).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe("validateShapeFlags (VOY-1727)", () => {
  let validateShapeFlags: typeof import("./plan-trip.js").validateShapeFlags;

  beforeAll(async () => {
    const mod = await import("./plan-trip.js");
    validateShapeFlags = mod.validateShapeFlags;
  });

  it("passes with no shape flags regardless of other opts", () => {
    expect(() => validateShapeFlags({ plan: "p1", return: "2026-09-08", hotel: "Paris" })).not.toThrow();
  });

  it("rejects shape flags on an existing plan (--plan)", () => {
    expect(() => validateShapeFlags({ oneWay: true, plan: "p1" })).toThrow(/existing/i);
    expect(() => validateShapeFlags({ hotelOnly: true, plan: "p1" })).toThrow(/goal-remove/);
  });

  it("rejects --one-way with --return", () => {
    expect(() => validateShapeFlags({ oneWay: true, return: "2026-09-08" })).toThrow(/--one-way conflicts with --return/);
  });

  it("rejects --hotel-only with --one-way or flight flags", () => {
    expect(() => validateShapeFlags({ hotelOnly: true, oneWay: true })).toThrow(/conflicts/);
    expect(() => validateShapeFlags({ hotelOnly: true, to: "MCO" })).toThrow(/flight flags/);
    expect(() => validateShapeFlags({ hotelOnly: true, depart: "2026-09-01" })).toThrow(/flight flags/);
  });

  it("rejects --flight-only with --hotel", () => {
    expect(() => validateShapeFlags({ flightOnly: true, hotel: "Paris" })).toThrow(/--flight-only conflicts with hotel flags/);
    expect(() => validateShapeFlags({ flightOnly: true, checkin: "2026-09-01" })).toThrow(/hotel flags/);
    expect(() => validateShapeFlags({ hotelOnly: true, flightOnly: true })).toThrow(/--hotel-only conflicts with --flight-only/);
  });

  it("accepts valid combos", () => {
    expect(() => validateShapeFlags({ oneWay: true, flightOnly: true, to: "DEN", depart: "2026-10-20" })).not.toThrow();
    expect(() => validateShapeFlags({ hotelOnly: true, hotel: "Nashville" })).not.toThrow();
  });
});

describe("plan-trip shape flags integration (VOY-1727)", () => {
  let stdout: string;
  let writeSpy: ReturnType<typeof jest.spyOn>;

  const lastJson = (): any => {
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  };

  beforeEach(() => {
    mockGraphql.mockReset();
    stdout = "";
    writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((c: any) => {
      stdout += typeof c === "string" ? c : c.toString();
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("--one-way --flight-only: fetches goals, deletes return + hotel, reports prunedGoals", async () => {
    // Call order: scaffoldPlan runs create → prune (list + deletes); plan-trip
    // then does its own traveller-fetch fallback (scaffold only returns the IDs
    // it added, and none were added here).
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-ow", title: "OW" } }) // CREATE
      .mockResolvedValueOnce({ tripPlanGoals: SCAFFOLD_GOALS }) // LIST goals
      .mockResolvedValueOnce({ deleteTripPlanGoal: true }) // delete return
      .mockResolvedValueOnce({ deleteTripPlanGoal: true }) // delete hotel
      .mockResolvedValueOnce({ tripPlanTravellers: [{ id: "t1", firstName: "A", lastName: "B" }] }); // TRAVELLERS fallback

    await runPlanTrip([
      "--client", "client-1", "--title", "OW",
      "--to", "DEN", "--depart", "2026-10-20",
      "--one-way", "--flight-only", "--json",
    ]);

    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.shape).toEqual(["one-way", "flight-only"]);
    expect(out.prunedGoals.map((g: any) => g.id).sort()).toEqual(["g-hotel", "g-ret"]);
    expect(out.pruneWarnings).toBeUndefined();
    // 2 scaffold calls + 1 goals list + 2 deletes
    expect(mockGraphql).toHaveBeenCalledTimes(5);
    // The flight search next-step must NOT carry --return.
    const flightStep = out.nextSteps.find((s: string) => s.includes("search flights"));
    expect(flightStep).toBeTruthy();
    expect(flightStep).not.toContain("--return");
  });

  it("delete failure is a warning, not a fatal — surfaces manual goal-remove fallback", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-f", title: "F" } })
      .mockResolvedValueOnce({ tripPlanGoals: SCAFFOLD_GOALS })
      .mockResolvedValueOnce({ deleteTripPlanGoal: false }) // server declines
      .mockResolvedValueOnce({ tripPlanTravellers: [] }); // TRAVELLERS fallback

    await runPlanTrip(["--client", "client-1", "--title", "F", "--one-way", "--json"]);

    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.prunedGoals).toEqual([]);
    expect(out.pruneWarnings.length).toBe(1);
    expect(out.pruneWarnings[0]).toContain("plans goal-remove g-ret --force");
  });

  it("no shape flags: no goals fetch, no shape/prunedGoals fields (contract unchanged)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-p", title: "P" } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--client", "client-1", "--title", "P", "--json"]);

    const out = lastJson();
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(out.shape).toBeUndefined();
    expect(out.prunedGoals).toBeUndefined();
  });

  it("--one-way with --return fails validation before any API call", async () => {
    await expect(
      runPlanTrip(["--client", "client-1", "--title", "X", "--one-way", "--return", "2026-10-26", "--json"]),
    ).rejects.toThrow(/--one-way conflicts with --return/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});
