import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

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

const mockWarn = jest.fn();

jest.unstable_mockModule("../output.js", () => ({
  progress: jest.fn(),
  warn: mockWarn,
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
let resolveDestination: (opts: { destination?: string; destinationId?: string; plan?: string }) => {
  travelDestinationId?: string;
  destinationName?: string;
};

beforeAll(async () => {
  const mod = await import("./plan-trip.js");
  registerPlanTripCommand = mod.registerPlanTripCommand;
  parseDurationMinutes = mod.parseDurationMinutes as (d?: string) => number;
  parseStops = mod.parseStops as (bd?: Record<string, unknown>) => number;
  nextDay = mod.nextDay as (d?: string) => string | undefined;
  resolveDestination = mod.resolveDestination as typeof resolveDestination;
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
        selectionType: "Selection",
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
    // It must NOT auto-search/select: only create + the traveller roster read.
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
      // No --json: the real isInteractive() gate disables prompting under
      // --json, so exercising the prompt path with it would be unreachable
      // in production (Copilot review, PR #131).
      await runPlanTrip(["--client", "client-1"]);
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
    expect(mockGraphql).toHaveBeenCalledTimes(2); // create + traveller roster read
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
      .mockResolvedValueOnce({ addTripPlanTravellers: [{ id: "t1", firstName: "Ann", lastName: "Lee" }] }); // batch add

    await runPlanTrip(["--plan", "plan-X", "--travellers", "Ann Lee", "--json"]);

    const out = jsonOutputCalls();
    expect(out.tripPlanId).toBe("plan-X");
    expect(out.travellerIds).toEqual(["t1"]);
    // fetch + add only — the fallback traveller fetch is skipped when we added some.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });
});

// ── Trip templates: the goal graph is chosen at creation ────────────────────
//
// These replace the shape-flag pruning tests. The CLI used to create the full
// round-trip + hotel graph and then delete what the brief did not want, which
// meant a failed delete left a plan holding goals that block booking (an
// unpruned return leg stops one-way inventory fetching and the fare carting).
// The server now builds the requested shape directly, so there is nothing to
// prune and no partial state to report.

describe("plan-trip templates", () => {
  let stdout: string;
  let writeSpy: ReturnType<typeof jest.spyOn>;

  const lastJson = (): any => {
    const line = stdout.trim().split("\n").filter(Boolean).pop();
    return line ? JSON.parse(line) : null;
  };

  const HOTEL_ONLY_GOALS = [
    { id: "g-trav", name: "Travelers", type: "TravellerList" },
    { id: "g-hotel", name: "Accommodation", type: "Hotel" },
  ];

  beforeEach(() => {
    mockGraphql.mockReset();
    mockWarn.mockReset();
    stdout = "";
    writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((c: any) => {
      stdout += typeof c === "string" ? c : c.toString();
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("sends --template on the create and reports the goals it produced", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        createTripPlan: { id: "plan-h", title: "Nashville", travellers: [], goals: HOTEL_ONLY_GOALS },
      })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip([
      "--client", "client-1", "--title", "Nashville",
      "--hotel", "Nashville", "--checkin", "2026-09-01", "--checkout", "2026-09-05",
      "--template", "HotelOnly", "--json",
    ]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({ template: "HotelOnly" });

    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.template).toBe("HotelOnly");
    expect(out.goals.map((g: any) => g.type)).toEqual(["TravellerList", "Hotel"]);
    // create + traveller roster read. No goal listing, no deletes.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("omits template from the JSON when none was given (the server default applies)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-p", title: "P", travellers: [], goals: [] } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--client", "client-1", "--title", "P", "--json"]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).not.toHaveProperty("template");
    expect(lastJson().template).toBeUndefined();
  });

  it("maps the deprecated shape flags onto a template and warns", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-ow", title: "OW", travellers: [], goals: [] } })
      .mockResolvedValueOnce({ tripPlanTravellers: [{ id: "t1", firstName: "A", lastName: "B" }] });

    await runPlanTrip([
      "--client", "client-1", "--title", "OW",
      "--to", "DEN", "--depart", "2026-10-20",
      "--one-way", "--flight-only", "--json",
    ]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({ template: "OneWayFlight" });
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining("--template OneWayFlight"));
    // The flight search next-step must not carry --return on a one-way.
    const flightStep = lastJson().nextSteps.find((s: string) => s.includes("search flights"));
    expect(flightStep).toBeTruthy();
    expect(flightStep).not.toContain("--return");
  });

  it("rejects an unknown --template before any API call", async () => {
    await expect(
      runPlanTrip(["--client", "client-1", "--title", "X", "--template", "RoundTrip", "--json"]),
    ).rejects.toThrow(/Unknown --template "RoundTrip"/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects mixing --template with a deprecated flag before any API call", async () => {
    await expect(
      runPlanTrip(["--client", "client-1", "--title", "X", "--template", "HotelOnly", "--hotel-only", "--json"]),
    ).rejects.toThrow(/--template replaces/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

// ── Structured destination (VOY-2082) ──────────────────────────────────────

describe("resolveDestination", () => {
  it("maps --destination-id onto travelDestinationId", () => {
    expect(resolveDestination({ destinationId: "dst_42" })).toEqual({ travelDestinationId: "dst_42" });
  });

  it("maps --destination onto destinationName", () => {
    expect(resolveDestination({ destination: "the Dolomites" })).toEqual({ destinationName: "the Dolomites" });
  });

  it("returns neither field when no destination flag was given", () => {
    expect(resolveDestination({})).toEqual({});
  });

  it("trims both values", () => {
    expect(resolveDestination({ destinationId: "  dst_42  " })).toEqual({ travelDestinationId: "dst_42" });
    expect(resolveDestination({ destination: "  Split  " })).toEqual({ destinationName: "Split" });
  });

  it("rejects both destination flags at once rather than picking a winner", () => {
    expect(() => resolveDestination({ destinationId: "dst_42", destination: "Georgia" }))
      .toThrow(/not both/);
  });

  it("points at destinations search in the both-given message", () => {
    expect(() => resolveDestination({ destinationId: "dst_42", destination: "Georgia" }))
      .toThrow(/destinations search/);
  });

  it("rejects a destination flag combined with --plan (add-to-existing mode)", () => {
    expect(() => resolveDestination({ destinationId: "dst_42", plan: "plan-1" }))
      .toThrow(/only apply when creating a NEW plan/);
    expect(() => resolveDestination({ destination: "Georgia", plan: "plan-1" }))
      .toThrow(/only apply when creating a NEW plan/);
  });

  it("rejects an explicit-but-empty flag instead of silently ignoring it", () => {
    expect(() => resolveDestination({ destinationId: "" })).toThrow(/--destination-id was provided but empty/);
    expect(() => resolveDestination({ destinationId: "   " })).toThrow(/--destination-id was provided but empty/);
    expect(() => resolveDestination({ destination: "" })).toThrow(/--destination was provided but empty/);
  });

  it("throws VALIDATION-coded CliErrors", () => {
    try {
      resolveDestination({ destinationId: "a", destination: "b" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    }
  });
});

describe("plan-trip --destination-id / --destination", () => {
  let stdout: string;
  let writeSpy: ReturnType<typeof jest.spyOn>;

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

  it("sends travelDestinationId on the create when --destination-id is given", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-d", title: "Tbilisi", travellers: [], goals: [] } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--client", "client-1", "--title", "Tbilisi", "--destination-id", "dst_ge", "--json"]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({ travelDestinationId: "dst_ge" });
    expect(vars.input).not.toHaveProperty("destinationName");
  });

  it("sends destinationName on the create when the freeform --destination is given", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-f", title: "Dolomites", travellers: [], goals: [] } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--client", "client-1", "--title", "Dolomites", "--destination", "the Dolomites", "--json"]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toMatchObject({ destinationName: "the Dolomites" });
    expect(vars.input).not.toHaveProperty("travelDestinationId");
  });

  it("sends neither field when no destination flag was given", async () => {
    mockGraphql
      .mockResolvedValueOnce({ createTripPlan: { id: "plan-n", title: "N", travellers: [], goals: [] } })
      .mockResolvedValueOnce({ tripPlanTravellers: [] });

    await runPlanTrip(["--client", "client-1", "--title", "N", "--json"]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).not.toHaveProperty("travelDestinationId");
    expect(vars.input).not.toHaveProperty("destinationName");
  });

  it("rejects --destination-id together with --destination BEFORE any API call", async () => {
    await expect(
      runPlanTrip([
        "--client", "client-1", "--title", "X",
        "--destination-id", "dst_ge", "--destination", "Georgia", "--json",
      ]),
    ).rejects.toThrow(/not both/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects a destination flag in add-to-existing (--plan) mode before any API call", async () => {
    await expect(
      runPlanTrip(["--plan", "plan-1", "--destination-id", "dst_ge", "--json"]),
    ).rejects.toThrow(/only apply when creating a NEW plan/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

describe("buildClientHintFlags destination carry-through", () => {
  let buildClientHintFlags: (opts: Record<string, unknown>) => string;

  beforeAll(async () => {
    const mod = await import("./plan-trip.js");
    buildClientHintFlags = mod.buildClientHintFlags as typeof buildClientHintFlags;
  });

  it("carries --destination-id into the MULTIPLE_CLIENTS retry hint", () => {
    expect(buildClientHintFlags({ title: "T", destinationId: "dst_42" })).toBe(
      "--title T --destination-id dst_42",
    );
  });

  it("carries --destination (shell-quoted) into the retry hint", () => {
    expect(buildClientHintFlags({ destination: "the Dolomites" })).toBe(
      "--destination 'the Dolomites'",
    );
  });

  it("omits destination flags when neither was given", () => {
    expect(buildClientHintFlags({ title: "T" })).toBe("--title T");
  });
});
