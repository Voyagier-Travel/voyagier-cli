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

const MOCK_PLAN_DEEP_WITH_SUBS = {
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
            subSelections: [
              {
                id: "sub-1",
                type: "FLIGHT_CLASS",
                selectedOptionId: undefined,
                options: [
                  { id: "class-eco", name: "Economy", price: 0, sortOrder: 0 },
                  { id: "class-biz", name: "Business", price: 500, sortOrder: 1 },
                ],
              },
            ],
          },
        },
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

describe("plan-trip --auto-select (round-trip flight)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";

    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  function setupRoundTripMocks() {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("selectDepartureFlight")) return Promise.resolve(MOCK_DEPARTURE_RESULT);
      if (query.includes("selectReturnFlight")) return Promise.resolve(MOCK_RETURN_RESULT);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve(MOCK_SET_SELECTED);
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });
  }

  it("calls SELECT_DEPARTURE_FLIGHT with top-ranked flight token", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string, Record<string, unknown>][]);
    const depCall = calls.find(([q]) => q.includes("selectDepartureFlight"));
    expect(depCall).toBeDefined();
    // cheapest is f1 ($268) — its flightToken is "tok-f1"
    expect(depCall![1]).toMatchObject({ flightToken: "tok-f1" });
  });

  it("calls SELECT_RETURN_FLIGHT after departure", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("selectReturnFlight"))).toBe(true);
  });

  it("calls SET_TRIP_PLAN_SELECTED_OPTION after return flight", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("setTripPlanSelectedOption"))).toBe(true);
  });

  it("JSON output has correct selected shape", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);

    expect(parsed.plan).toBeDefined();
    expect(parsed.plan.id).toBe("plan-1");
    expect(parsed.selected).toBeDefined();
    expect(parsed.selected.strategy).toBe("cheapest");
    expect(parsed.selected.rank).toBe(1);
    expect(parsed.selected.departure).toBeDefined();
    expect(parsed.selected.return).toBeDefined();
    expect(parsed.alternatives).toBeInstanceOf(Array);
    expect(parsed.cart).toBeDefined();
    expect(parsed.nextSteps).toBeDefined();
    expect(parsed.nextSteps.review).toContain("cart");
    expect(parsed.nextSteps.book).toContain("book");
  });

  it("includes up to 3 alternatives", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.alternatives.length).toBeGreaterThan(0);
    expect(parsed.alternatives.length).toBeLessThanOrEqual(3);
    // Alternatives should have rank, summary, reason
    for (const alt of parsed.alternatives) {
      expect(alt.rank).toBeGreaterThan(1);
      expect(typeof alt.summary).toBe("string");
      expect(typeof alt.reason).toBe("string");
    }
  });

  it("auto-picks sub-selection (cabin class) via SET_SUB_SELECTION", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("selectDepartureFlight")) return Promise.resolve(MOCK_DEPARTURE_RESULT);
      if (query.includes("selectReturnFlight")) return Promise.resolve(MOCK_RETURN_RESULT);
      if (query.includes("setTripPlanSubSelectionOption")) return Promise.resolve(MOCK_SET_SUB_SELECTION);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve(MOCK_SET_SELECTED);
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_WITH_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "navigator",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("setTripPlanSubSelectionOption"))).toBe(true);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.selected.cabin).toBeDefined();
    expect(parsed.selected.cabin.name).toBe("Economy");
  });

  it("navigator strategy uses composite ranking", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "navigator",
      "--json",
    ]);

    // With the navigator strategy, the top-ranked flight should be selected
    // (whatever rankByNavigator chooses from our mock options)
    const calls = (mockGraphql.mock.calls as [string][]);
    const depCall = calls.find(([q]) => q.includes("selectDepartureFlight"));
    expect(depCall).toBeDefined(); // selection was made
  });

  it("fewest-stops strategy selects the direct flight (f4)", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "fewest-stops",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string, Record<string, unknown>][]);
    const depCall = calls.find(([q]) => q.includes("selectDepartureFlight"));
    expect(depCall).toBeDefined();
    // f4 has 0 stops and is the only direct flight
    expect(depCall![1]).toMatchObject({ flightToken: "tok-f4" });
  });

  it("fastest strategy selects the shortest duration flight (f4)", async () => {
    setupRoundTripMocks();

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "fastest",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string, Record<string, unknown>][]);
    const depCall = calls.find(([q]) => q.includes("selectDepartureFlight"));
    // f4 is 8h — fastest
    expect(depCall![1]).toMatchObject({ flightToken: "tok-f4" });
  });
});

// ── Integration tests: auto-select one-way flight ────────────────────────

describe("plan-trip --auto-select (one-way flight)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  it("calls SET_TRIP_PLAN_SELECTED_OPTION directly for one-way", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve(MOCK_SET_SELECTED);
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "One-way Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("setTripPlanSelectedOption"))).toBe(true);
    expect(calls.some(([q]) => q.includes("selectDepartureFlight"))).toBe(false);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.selected.departure).toBeDefined();
    expect(parsed.selected.return).toBeUndefined();
  });
});

// ── Validation tests ──────────────────────────────────────────────────────

describe("plan-trip --auto-select validation", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("rejects invalid --auto-select value", async () => {
    let err: unknown;
    try {
      await runPlanTrip([
        "--title", "Trip",
        "--client", "clt_test",
        "--to", "CDG",
        "--depart", "2026-03-23",
        "--auto-select", "invalid-strategy",
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).toContain("Invalid --auto-select");
  });

  it("accepts all valid strategy values without throwing validation error", async () => {
    // navigator, cheapest, fastest, fewest-stops should all pass validation
    // (they will fail later if no GraphQL mock, but validation check should pass)
    const strategies = ["navigator", "cheapest", "fastest", "fewest-stops"];
    for (const strategy of strategies) {
      mockGraphql.mockResolvedValue(MOCK_PLAN);
      // Just check validation doesn't throw VALIDATION about the strategy itself
      // (any error will come from subsequent missing mocks, not from strategy validation)
      let err: unknown;
      try {
        await runPlanTrip([
          "--title", "Trip",
          "--client", "clt_test",
          "--auto-select", strategy,
          "--json",
        ]);
      } catch (e) {
        err = e;
      }
      // Error might occur (no flight search etc) but shouldn't say "Invalid --auto-select"
      if (err) {
        expect(String(err)).not.toContain("Invalid --auto-select");
      }
    }
  });
});

// ── Backward compatibility: no --auto-select ────────────────────────────

describe("plan-trip without --auto-select (backward compat)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("does not call SELECT_DEPARTURE_FLIGHT when --auto-select is not set", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--json",
    ]);

    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("selectDepartureFlight"))).toBe(false);
  });

  it("JSON output has flights/hotels shape (not selected/alternatives)", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--json",
    ]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.flights).toBeDefined();
    expect(parsed.selected).toBeUndefined();
    expect(parsed.alternatives).toBeUndefined();
  });
});

// ── Integration tests: agent output (--agent) ─────────────────────────────

describe("plan-trip --auto-select --agent output", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  it("outputs markdown header with plan title for --agent", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("selectDepartureFlight")) return Promise.resolve(MOCK_DEPARTURE_RESULT);
      if (query.includes("selectReturnFlight")) return Promise.resolve(MOCK_RETURN_RESULT);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve(MOCK_SET_SELECTED);
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--agent",
    ]);

    const output = stdoutOutput.join("");
    expect(output).toContain("## ✈️ Paris Trip");
    expect(output).toContain("Departure:");
    expect(output).toContain("Return:");
  });

  it("agent output includes next steps commands", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("selectDepartureFlight")) return Promise.resolve(MOCK_DEPARTURE_RESULT);
      if (query.includes("selectReturnFlight")) return Promise.resolve(MOCK_RETURN_RESULT);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve(MOCK_SET_SELECTED);
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "navigator",
      "--agent",
    ]);

    const output = stdoutOutput.join("");
    expect(output).toContain("voyagier cart");
    expect(output).toContain("voyagier book");
  });

  it("agent output without --auto-select shows flight options", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--agent",
    ]);

    const output = stdoutOutput.join("");
    expect(output).toContain("## ✈️ Paris Trip");
    expect(output).toContain("Flights");
  });
});

// ── Integration tests: human (no --json, no --agent) ────────────────────────

describe("plan-trip --auto-select human output", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  it("human output with --auto-select completes without error and calls all selection APIs", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("selectDepartureFlight")) return Promise.resolve(MOCK_DEPARTURE_RESULT);
      if (query.includes("selectReturnFlight")) return Promise.resolve(MOCK_RETURN_RESULT);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve(MOCK_SET_SELECTED);
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
    ]);

    // Verify the full auto-select flow ran (departure + return + final selection)
    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("selectDepartureFlight"))).toBe(true);
    expect(calls.some(([q]) => q.includes("selectReturnFlight"))).toBe(true);
    expect(calls.some(([q]) => q.includes("setTripPlanSelectedOption"))).toBe(true);
  });

  it("human output without --auto-select completes without error and returns flight options", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
    ]);

    // Verify the flight search ran
    const calls = (mockGraphql.mock.calls as [string][]);
    expect(calls.some(([q]) => q.includes("CreateFlightSelection"))).toBe(true);
    // And no auto-select calls were made
    expect(calls.some(([q]) => q.includes("selectDepartureFlight"))).toBe(false);
  });
});

// ── Integration tests: hotel auto-select ─────────────────────────────────────

const MOCK_HOTEL_SELECTION = {
  createTripPlanHotelSelection: {
    item: { id: "item-h", title: "Hotel Paris", tripPlanId: "plan-1" },
    selection: { id: "hotel-sel-1" },
    options: [
      { id: "h1", name: "Grand Hotel Paris", price: 200, sortOrder: 0 },
      { id: "h2", name: "Budget Inn", price: 80, sortOrder: 1 },
    ],
  },
};

describe("plan-trip --hotel with --auto-select", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  it("auto-selects hotel (cheapest) via SET_TRIP_PLAN_SELECTED_OPTION", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("CreateHotelSelection")) return Promise.resolve(MOCK_HOTEL_SELECTION);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve({
        setTripPlanSelectedOption: { id: "hotel-sel-1", selectedOption: { id: "h2", name: "Budget Inn", price: 80 } },
      });
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--hotel", "Paris",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string, Record<string, unknown>][];
    const hotelSelectCall = calls.find(([q]) => q.includes("setTripPlanSelectedOption"));
    expect(hotelSelectCall).toBeDefined();
    // Budget Inn (h2, $80) should be selected as cheapest
    expect(hotelSelectCall![1]).toMatchObject({ optionId: "h2" });
  });

  it("JSON output includes hotel in selected when --hotel with --auto-select", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("CreateHotelSelection")) return Promise.resolve(MOCK_HOTEL_SELECTION);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve({
        setTripPlanSelectedOption: { id: "hotel-sel-1", selectedOption: { id: "h2", name: "Budget Inn", price: 80 } },
      });
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--hotel", "Paris",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--json",
    ]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);
    expect(parsed.selected).toBeDefined();
    expect(parsed.selected.hotel).toBeDefined();
    expect(parsed.selected.hotel.name).toBe("Budget Inn");
  });

  it("agent output includes hotel name when hotel auto-selected", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("CreateHotelSelection")) return Promise.resolve(MOCK_HOTEL_SELECTION);
      if (query.includes("setTripPlanSelectedOption")) return Promise.resolve({
        setTripPlanSelectedOption: { id: "hotel-sel-1", selectedOption: { id: "h2", name: "Budget Inn", price: 80 } },
      });
      if (query.includes("TripPlanDeep")) return Promise.resolve(MOCK_PLAN_DEEP_NO_SUBS);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--hotel", "Paris",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--auto-select", "cheapest",
      "--agent",
    ]);

    const output = stdoutOutput.join("");
    expect(output).toContain("Hotel");
    expect(output).toContain("Budget Inn");
  });
});

// ── Integration tests: --plan (reuse existing plan) ──────────────────────────

describe("plan-trip --plan (reuse existing plan)", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("fetches existing plan with GET_TRIP_PLAN_BASIC when --plan provided", async () => {
    mockGraphql.mockImplementation((query: string) => {
      // GET_TRIP_PLAN_BASIC: `query TripPlan($id: String!) { tripPlan(id: $id) { ... } }`
      if (query.includes("query TripPlan(")) return Promise.resolve({ tripPlan: MOCK_PLAN.createTripPlan });
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--plan", "plan-1",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string][];
    // Should NOT call CreateTripPlan
    expect(calls.some(([q]) => q.includes("mutation CreateTripPlan"))).toBe(false);
  });
});

// ── Integration tests: --travellers flag (parseTravellers function) ───────────

describe("plan-trip --travellers", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  const MOCK_TRAVELLER = {
    createTripPlanTraveller: { id: "trav-1", firstName: "John", lastName: "Doe" },
  };

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("calls CREATE_TRAVELLER_BRIEF when --travellers is provided", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("createTripPlanTraveller")) return Promise.resolve(MOCK_TRAVELLER);
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--travellers", "John Doe",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string][];
    expect(calls.some(([q]) => q.includes("createTripPlanTraveller"))).toBe(true);
  });

  it("parses multiple comma-separated travellers", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("createTripPlanTraveller")) return Promise.resolve(MOCK_TRAVELLER);
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--travellers", "John Doe, Jane Smith",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string][];
    const travellerCalls = calls.filter(([q]) => q.includes("createTripPlanTraveller"));
    expect(travellerCalls.length).toBe(2);
  });

  it("declares the traveller mutation variable with the correct schema type CreateTripPlanTravellerInput!", async () => {
    // Regression guard: dev schema renamed the input type from CreateTravellerInput
    // to CreateTripPlanTravellerInput. Anything else 400s with "Unknown type".
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("createTripPlanTraveller")) return Promise.resolve(MOCK_TRAVELLER);
      if (query.includes("CreateFlightSelection")) return Promise.resolve(MOCK_FLIGHT_SELECTION);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--title", "Paris Trip",
      "--client", "clt_test",
      "--travellers", "John Doe",
      "--to", "CDG",
      "--from", "DCA",
      "--depart", "2026-03-23",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string][];
    const travellerCall = calls.find(([q]) => q.includes("createTripPlanTraveller"));
    expect(travellerCall).toBeDefined();
    const [query] = travellerCall as [string];
    expect(query).toContain("$input: CreateTripPlanTravellerInput!");
    expect(query).not.toContain("$input: CreateTravellerInput!");
  });
});

// ── Integration tests: --client resolution (VOY-1211) ──────────────────────

describe("plan-trip --client", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrOutput: string[];
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    stderrOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
  });

  it("uses an explicit clt_ id directly without listing clients", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--client", "clt_explicit_abc",
      "--title", "Trip",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string, Record<string, unknown>][];
    expect(calls.some(([q]) => q.includes("TripPlanClients"))).toBe(false);
    const create = calls.find(([q]) => q.includes("mutation CreateTripPlan"));
    expect(create).toBeDefined();
    expect(create![1]).toEqual({ input: { clientId: "clt_explicit_abc", title: "Trip" } });
  });

  it("resolves an email via LIST_TRIP_PLAN_CLIENTS and sends the matched id", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("TripPlanClients")) {
        return Promise.resolve({
          tripPlanClients: {
            items: [
              { id: "clt_smith", name: "Smith Family", email: "smith@example.com", clientType: "Group", status: "Active" },
              { id: "clt_old", name: "Old Co", email: "old@example.com", clientType: "Company", status: "Archived" },
            ],
          },
        });
      }
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--client", "smith@example.com",
      "--title", "Trip",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string, Record<string, unknown>][];
    const create = calls.find(([q]) => q.includes("mutation CreateTripPlan"));
    expect(create![1]).toEqual({ input: { clientId: "clt_smith", title: "Trip" } });
  });

  it("throws NO_CLIENTS when --client is omitted and no active clients exist", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("TripPlanClients")) {
        return Promise.resolve({
          tripPlanClients: {
            items: [
              { id: "clt_old", name: "Old Co", email: "old@example.com", clientType: "Company", status: "Archived" },
            ],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    let err: unknown;
    try {
      await runPlanTrip(["--title", "Trip", "--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "NO_CLIENTS" });
  });

  it("auto-picks the single active client and logs to stderr when --client is omitted", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("TripPlanClients")) {
        return Promise.resolve({
          tripPlanClients: {
            items: [
              { id: "clt_only", name: "Only Active", email: "only@example.com", clientType: "Individual", status: "Active" },
            ],
          },
        });
      }
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip(["--title", "Trip", "--json"]);

    const stderrJoined = stderrOutput.join("");
    expect(stderrJoined).toContain("auto-resolved client: Only Active (clt_only)");
    const calls = mockGraphql.mock.calls as [string, Record<string, unknown>][];
    const create = calls.find(([q]) => q.includes("mutation CreateTripPlan"));
    expect(create![1]).toEqual({ input: { clientId: "clt_only", title: "Trip" } });
  });

  it("throws MULTIPLE_CLIENTS when --client is omitted and multiple active clients exist", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("TripPlanClients")) {
        return Promise.resolve({
          tripPlanClients: {
            items: [
              { id: "clt_a", name: "Alpha", email: "a@example.com", clientType: "Individual", status: "Active" },
              { id: "clt_b", name: "Bravo", email: "b@example.com", clientType: "Individual", status: "Active" },
            ],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    let err: unknown;
    try {
      await runPlanTrip(["--title", "Trip", "--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "MULTIPLE_CLIENTS" });
  });

  it("createTripPlan input contains only clientId + title (no startDate/endDate even when --depart/--return given)", async () => {
    mockGraphql.mockImplementation((query: string) => {
      if (query.includes("mutation CreateTripPlan")) return Promise.resolve(MOCK_PLAN);
      if (query.includes("tripPlanTravellers")) return Promise.resolve(MOCK_TRAVELLERS_EMPTY);
      return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
    });

    await runPlanTrip([
      "--client", "clt_explicit",
      "--title", "Trip",
      "--depart", "2026-03-23",
      "--return", "2026-03-25",
      "--json",
    ]);

    const calls = mockGraphql.mock.calls as [string, Record<string, unknown>][];
    const create = calls.find(([q]) => q.includes("mutation CreateTripPlan"));
    expect(create).toBeDefined();
    const input = (create![1] as { input: Record<string, unknown> }).input;
    expect(input).toEqual({ clientId: "clt_explicit", title: "Trip" });
    expect(input).not.toHaveProperty("startDate");
    expect(input).not.toHaveProperty("endDate");
  });
});
