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
let rankByNavigator: (options: unknown[]) => unknown[];
let applyStrategy: (options: unknown[], strategy: string) => unknown[];
let generateAlternativeReason: (alt: unknown, selected: unknown) => string;
let getRankReason: (strategy: string) => string;
let parseDurationMinutes: (d?: string) => number;
let parseStops: (bd?: Record<string, unknown>) => number;

beforeAll(async () => {
  const mod = await import("./plan-trip.js");
  registerPlanTripCommand = mod.registerPlanTripCommand;
  rankByNavigator = mod.rankByNavigator as (options: unknown[]) => unknown[];
  applyStrategy = mod.applyStrategy as (options: unknown[], strategy: string) => unknown[];
  generateAlternativeReason = mod.generateAlternativeReason as (alt: unknown, selected: unknown) => string;
  getRankReason = mod.getRankReason as (strategy: string) => string;
  parseDurationMinutes = mod.parseDurationMinutes as (d?: string) => number;
  parseStops = mod.parseStops as (bd?: Record<string, unknown>) => number;
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
});

// ── Unit tests: rankByNavigator ───────────────────────────────────────────

describe("rankByNavigator", () => {
  it("returns empty array for empty input", () => {
    expect(rankByNavigator([])).toEqual([]);
  });

  it("returns single option unchanged", () => {
    const opt = makeOpt({ id: "a", price: 100, duration: "5h0m", stops: 0 });
    const result = rankByNavigator([opt]);
    expect(result).toHaveLength(1);
    expect((result[0] as typeof opt).id).toBe("a");
  });

  it("ranks cheapest+fastest option highest with composite score", () => {
    const cheap = makeOpt({ id: "cheap", price: 200, duration: "8h0m", stops: 0 });
    const expensive = makeOpt({ id: "expensive", price: 2000, duration: "7h0m", stops: 1 });
    const mid = makeOpt({ id: "mid", price: 400, duration: "9h0m", stops: 1 });

    const result = rankByNavigator([expensive, mid, cheap]) as typeof cheap[];
    // cheap should rank first: lowest price (rank 1) + reasonable duration + fewer stops
    expect(result[0].id).toBe("cheap");
  });

  it("does not mutate the original array", () => {
    const opts = [
      makeOpt({ id: "a", price: 300, duration: "9h", stops: 1 }),
      makeOpt({ id: "b", price: 100, duration: "11h", stops: 0 }),
    ];
    const originalOrder = opts.map(o => o.id);
    rankByNavigator(opts);
    expect(opts.map(o => o.id)).toEqual(originalOrder);
  });
});

// ── Unit tests: applyStrategy ─────────────────────────────────────────────

describe("applyStrategy", () => {
  const opts = [
    makeOpt({ id: "a", price: 500, duration: "10h0m", stops: 1, sortOrder: 0 }),
    makeOpt({ id: "b", price: 200, duration: "12h0m", stops: 0, sortOrder: 1 }),
    makeOpt({ id: "c", price: 800, duration: "8h0m", stops: 2, sortOrder: 2 }),
  ];

  it("cheapest: sorts by price ascending", () => {
    const result = applyStrategy(opts, "cheapest") as typeof opts;
    expect(result[0].id).toBe("b"); // $200
    expect(result[1].id).toBe("a"); // $500
    expect(result[2].id).toBe("c"); // $800
  });

  it("fastest: sorts by duration ascending", () => {
    const result = applyStrategy(opts, "fastest") as typeof opts;
    expect(result[0].id).toBe("c"); // 8h
    expect(result[1].id).toBe("a"); // 10h
    expect(result[2].id).toBe("b"); // 12h
  });

  it("fewest-stops: sorts by stops then price", () => {
    const result = applyStrategy(opts, "fewest-stops") as typeof opts;
    expect(result[0].id).toBe("b"); // 0 stops, $200
    expect(result[1].id).toBe("a"); // 1 stop, $500
    expect(result[2].id).toBe("c"); // 2 stops, $800
  });

  it("fewest-stops: secondary sort by price within same stop count", () => {
    const same1 = makeOpt({ id: "x", price: 800, stops: 1, duration: "10h", sortOrder: 0 });
    const same2 = makeOpt({ id: "y", price: 300, stops: 1, duration: "12h", sortOrder: 1 });
    const result = applyStrategy([same1, same2], "fewest-stops") as typeof same1[];
    expect(result[0].id).toBe("y"); // cheaper at same stop count
  });

  it("navigator: returns results (integration with rankByNavigator)", () => {
    const result = applyStrategy(opts, "navigator");
    expect(result).toHaveLength(opts.length);
  });
});

// ── Unit tests: getRankReason ─────────────────────────────────────────────

describe("getRankReason", () => {
  it("returns correct reasons for each strategy", () => {
    expect(getRankReason("navigator")).toContain("overall value");
    expect(getRankReason("cheapest")).toContain("price");
    expect(getRankReason("fastest")).toContain("duration");
    expect(getRankReason("fewest-stops")).toContain("layover");
  });
});

// ── Unit tests: generateAlternativeReason ────────────────────────────────

describe("generateAlternativeReason", () => {
  it("describes direct flight with higher price", () => {
    const alt = makeOpt({ id: "alt", price: 600, duration: "8h0m", stops: 0 });
    const sel = makeOpt({ id: "sel", price: 200, duration: "10h0m", stops: 1 });
    const reason = generateAlternativeReason(alt, sel);
    expect(reason).toContain("Direct flight");
    expect(reason).toContain("more");
  });

  it("describes direct flight with lower price", () => {
    const alt = makeOpt({ id: "alt", price: 100, duration: "8h0m", stops: 0 });
    const sel = makeOpt({ id: "sel", price: 200, duration: "10h0m", stops: 1 });
    const reason = generateAlternativeReason(alt, sel);
    expect(reason).toContain("Direct flight");
    expect(reason).toContain("saves");
  });

  it("describes faster option using ratio when >1.5x price", () => {
    const alt = makeOpt({ id: "alt", price: 2870, duration: "9h55m", stops: 1 });
    const sel = makeOpt({ id: "sel", price: 268, duration: "10h5m", stops: 1 });
    const reason = generateAlternativeReason(alt, sel);
    expect(reason).toContain("faster");
    expect(reason).toContain("x price");
  });

  it("describes faster option with $X more when <1.5x price", () => {
    const alt = makeOpt({ id: "alt", price: 300, duration: "9h0m", stops: 1 });
    const sel = makeOpt({ id: "sel", price: 260, duration: "10h0m", stops: 1 });
    const reason = generateAlternativeReason(alt, sel);
    expect(reason).toContain("faster");
    expect(reason).toContain("more");
  });

  it("describes cheaper but slower option", () => {
    const alt = makeOpt({ id: "alt", price: 150, duration: "14h0m", stops: 2 });
    const sel = makeOpt({ id: "sel", price: 268, duration: "10h0m", stops: 1 });
    const reason = generateAlternativeReason(alt, sel);
    expect(reason).toContain("Saves");
    expect(reason).toContain("longer");
  });

  it("falls back to airline service description", () => {
    const alt = makeOpt({ id: "alt", price: 300, duration: "10h0m", stops: 1, airline: "Lufthansa" });
    const sel = makeOpt({ id: "sel", price: 268, duration: "10h0m", stops: 1 });
    const reason = generateAlternativeReason(alt, sel);
    expect(reason).toContain("Lufthansa");
    expect(reason).toContain("service");
  });
});

// ── Integration tests: auto-select flow ──────────────────────────────────
// ── plan-trip is now a scaffold (VOY-1414): create plan + travellers, then
// hand off to the composable primitives. No auto-search / auto-select. ──────

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

  it("reuses an existing plan with --plan (fetch, no create)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlan: { id: "plan-X", title: "Existing" } }) // GET_TRIP_PLAN_BASIC
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--plan", "plan-X", "--json"]);

    const out = jsonOutputCalls();
    expect(out.tripPlanId).toBe("plan-X");
  });
});
