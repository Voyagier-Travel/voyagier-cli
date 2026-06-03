import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
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
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-1", title: "Paris Trip" } }) // CREATE_TRIP_PLAN_BASIC
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
});
