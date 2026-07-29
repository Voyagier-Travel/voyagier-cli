import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliErrorCode } from "../errors.js";
import type { SearchState } from "../state.js";

/**
 * resolvePlanId --plan contract (VOY-1437)
 * ----------------------------------------
 * The agent-facing rule, made explicit and regression-locked:
 *   - --plan with a real value  -> use it (trimmed).
 *   - --plan passed but empty/whitespace -> VALIDATION error (NEVER silently
 *     fall back to the last-search plan; that would run against a different
 *     plan than the caller named).
 *   - --plan omitted entirely + last-search state present -> fall back, with a
 *     loud stderr notice.
 *   - --plan omitted entirely + no state -> VALIDATION error.
 */

const mockLoadSearchState = jest.fn<() => SearchState | null>();
const mockGraphql = jest.fn<(query: string, vars?: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../state.js", () => ({
  loadSearchState: mockLoadSearchState,
  saveSearchState: jest.fn(),
  clearSearchState: jest.fn(),
  isSearchStateStale: jest.fn(() => false),
  saveOptionsState: jest.fn(),
  loadOptionsState: jest.fn(),
  clearOptionsState: jest.fn(),
}));

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

const mockGetHomeAirports = jest.fn<() => string[]>(() => []);
jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn(() => "https://dev.voyagier.com/api"),
  getHomeAirports: mockGetHomeAirports,
  // state.ts (fully mocked) is the only other config consumer in this graph;
  // plan-footer.ts uses getApiUrl above. CONFIG_DIR kept for completeness.
  CONFIG_DIR: "/tmp/voyagier-search-spec-config",
}));

let resolvePlanId: (opts: { plan?: string }) => string;
let resolveOrCreateDecisionSelection: typeof import("./search.js").resolveOrCreateDecisionSelection;
let registerSearchCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./search.js");
  resolvePlanId = mod.resolvePlanId;
  resolveOrCreateDecisionSelection = mod.resolveOrCreateDecisionSelection;
  registerSearchCommands = mod.registerSearchCommands;
});

let stderrSpy: ReturnType<typeof jest.spyOn>;
let stderrWrites: string[];

beforeEach(() => {
  mockLoadSearchState.mockReset();
  stderrWrites = [];
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function state(tripPlanId: string): SearchState {
  return { tripPlanId } as SearchState;
}

describe("resolvePlanId --plan contract", () => {
  it("uses an explicit --plan value (trimmed)", () => {
    expect(resolvePlanId({ plan: "plan-123" })).toBe("plan-123");
    expect(resolvePlanId({ plan: "  plan-123  " })).toBe("plan-123");
    expect(mockLoadSearchState).not.toHaveBeenCalled();
  });

  it("hard-errors on an empty --plan (does NOT fall back to last-search)", () => {
    mockLoadSearchState.mockReturnValue(state("last-search-plan"));
    expect.assertions(3);
    try {
      resolvePlanId({ plan: "" });
    } catch (err) {
      expect(err).toMatchObject({ code: CliErrorCode.VALIDATION });
      expect((err as Error).message).toMatch(/empty value/i);
    }
    // Critically: it must not have consulted (or returned) the last-search plan.
    expect(mockLoadSearchState).not.toHaveBeenCalled();
  });

  it("hard-errors on a whitespace-only --plan", () => {
    mockLoadSearchState.mockReturnValue(state("last-search-plan"));
    expect(() => resolvePlanId({ plan: "   " })).toThrow(
      expect.objectContaining({ code: CliErrorCode.VALIDATION }),
    );
  });

  it("falls back to last-search plan when --plan is omitted, with a stderr notice", () => {
    mockLoadSearchState.mockReturnValue(state("last-search-plan"));
    expect(resolvePlanId({})).toBe("last-search-plan");
    expect(stderrWrites.join("")).toMatch(/last search.*last-search-plan/i);
  });

  it("hard-errors when --plan is omitted and there is no last-search state", () => {
    mockLoadSearchState.mockReturnValue(null);
    expect(() => resolvePlanId({})).toThrow(
      expect.objectContaining({ code: CliErrorCode.VALIDATION }),
    );
  });
});

/**
 * resolveOrCreateDecisionSelection fail-fast contract (VOY-1692 review).
 * When the goal graph names a decision selection but getTripPlanSelection
 * returns null (stale graph / deleted selection), the reuse path must throw
 * — an empty options array would read as "still fetching" and send the
 * caller off to poll a selection that does not exist.
 */
describe("resolveOrCreateDecisionSelection reuse path", () => {
  const goalWithSelection = {
    id: "goal-1",
    name: "Flights",
    items: [{ selections: [{ id: "sel-decision", type: "Flight" }] }],
  };

  beforeEach(() => {
    mockGraphql.mockReset();
  });

  it("fails fast with API_ERROR when the reused selection cannot be loaded", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: null });
    let err: unknown;
    try {
      await resolveOrCreateDecisionSelection(
        "flights", goalWithSelection as never, "plan-1", "mutation X", "x", {}, true,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe(CliErrorCode.API_ERROR);
    expect((err as Error).message).toContain("sel-decision");
    expect((err as Error).message).toContain("plans goals plan-1");
  });

  it("returns the reused selection's options when it loads", async () => {
    mockGraphql.mockResolvedValueOnce({
      getTripPlanSelection: { id: "sel-decision", options: [{ id: "opt-1" }] },
    });
    const result = await resolveOrCreateDecisionSelection(
      "flights", goalWithSelection as never, "plan-1", "mutation X", "x", {}, true,
    );
    expect(result).toEqual({ selectionId: "sel-decision", options: [{ id: "opt-1" }], reused: true });
  });

  it("still treats a loaded selection with empty options as fetching (no throw)", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: { id: "sel-decision", options: [] } });
    const result = await resolveOrCreateDecisionSelection(
      "flights", goalWithSelection as never, "plan-1", "mutation X", "x", {}, true,
    );
    expect(result.options).toEqual([]);
    expect(result.reused).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Command surface: registerSearchCommands (flights / hotels / activities / airports)
//
// The helper modules (search-helpers, formatters, utils, data/*) are real; only
// the network boundary (../api.js graphql), state persistence (../state.js) and
// config (../config.js) are mocked. The graphql mock is a query-router so tests
// don't depend on brittle call ordering — each GraphQL op is matched by a unique
// substring of its document.
// ─────────────────────────────────────────────────────────────────────────────

describe("registerSearchCommands", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let logSpy: ReturnType<typeof jest.spyOn>;
  let stdoutWrites: string[];

  function buildProgram(): Command {
    const p = new Command();
    p.exitOverride();
    registerSearchCommands(p);
    return p;
  }

  // Human output goes through console.log; --json/--agent go through
  // process.stdout.write. Capture BOTH into one buffer so assertions are
  // independent of how console.log is wired across the worker's other suites.
  function stdout(): string {
    return stdoutWrites.join("");
  }

  interface RouterOpts {
    travellers?: Array<{ id: string; firstName: string; lastName: string }>;
    goals?: unknown[];
    options?: unknown[];
    items?: Array<{ id: string; title: string; selections?: Array<{ type: string }> }>;
  }

  function installRouter(cfg: RouterOpts = {}): void {
    const travellers = cfg.travellers ?? [{ id: "t-1", firstName: "Ada", lastName: "Lovelace" }];
    const goals = cfg.goals ?? buildFlightGoals();
    const options = cfg.options ?? sampleFlightOptions();
    const items = cfg.items ?? [];
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("tripPlanTravellers")) return { tripPlanTravellers: travellers };
      if (query.includes("GoalsForSearch")) return { tripPlanGoals: goals };
      if (query.includes("getTripPlanSelection")) {
        return { getTripPlanSelection: { id: "sel-reused", options } };
      }
      if (query.includes("createTripPlanFlightSelection")) {
        return { createTripPlanFlightSelection: { item: { id: "i", title: "t", tripPlanId: "plan-1" }, selection: { id: "sel-new" }, options } };
      }
      if (query.includes("createTripPlanHotelSelection")) {
        return { createTripPlanHotelSelection: { item: { id: "i", title: "t", tripPlanId: "plan-1" }, selection: { id: "sel-new" }, options } };
      }
      if (query.includes("createTripPlanActivitySelection")) {
        return { createTripPlanActivitySelection: { item: { id: "i", title: "t", tripPlanId: "plan-1" }, selection: { id: "sel-new" }, options } };
      }
      if (query.includes("updateTripPlanAirportSelection")) return { updateTripPlanAirportSelection: { id: "x" } };
      if (query.includes("addTripPlanDateOption")) return { addTripPlanDateOption: { id: "x" } };
      if (query.includes("setTripPlanSelectionInputValue")) return { setTripPlanSelectionInputValue: { id: "x" } };
      if (query.includes("setTripPlanDestinationValue")) return { setTripPlanDestinationValue: { id: "x" } };
      if (query.includes("deleteTripPlanItem")) return { deleteTripPlanItem: true };
      if (query.includes("selections { type }")) return { tripPlan: { items } };
      if (query.includes("PlanFooter")) return { tripPlan: null };
      throw new Error(`unrouted query: ${query.slice(0, 60)}`);
    });
  }

  function sampleFlightOptions(): unknown[] {
    return [
      { id: "opt-a", name: "AA 100", price: 500, duration: "8h 00m", sortOrder: 2, bookingData: { stops: 1, flightToken: "TKa" } },
      { id: "opt-b", name: "UA 200", price: 300, duration: "5h 30m", sortOrder: 1, bookingData: { stops: 0, flightToken: "TKb" } },
    ];
  }

  function sharedGoal() {
    return {
      id: "g-shared", name: "Trip", type: "Trip", sortOrder: 0,
      items: [{ selections: [{ id: "sel-date", type: "Date" }, { id: "sel-dest", type: "Destination" }] }],
    };
  }

  function buildFlightGoals(withReturn = false) {
    const goals: unknown[] = [
      sharedGoal(),
      {
        id: "g-flight", name: "Flights", type: "Flight", sortOrder: 1,
        items: [{ selections: [
          { id: "sel-flist", type: "FlightList" },
          { id: "sel-ap-o", type: "Airport" },
          { id: "sel-ap-d", type: "Airport" },
          { id: "sel-fdec", type: "Flight" },
        ] }],
      },
    ];
    if (withReturn) {
      goals.push({
        id: "g-flight-ret", name: "Return Flights", type: "Flight", sortOrder: 2,
        items: [{ selections: [
          { id: "sel-flist-r", type: "FlightList", segmentIndex: 1 },
          { id: "sel-ap-ro", type: "Airport", segmentIndex: 1 },
          { id: "sel-ap-rd", type: "Airport", segmentIndex: 1 },
          { id: "sel-fdec-r", type: "Flight", segmentIndex: 1 },
        ] }],
      });
    }
    return goals;
  }

  function buildHotelGoals() {
    return [
      sharedGoal(),
      {
        id: "g-hotel", name: "Hotel", type: "Hotel", sortOrder: 1,
        items: [{ selections: [{ id: "sel-hlist", type: "HotelList" }, { id: "sel-hdec", type: "Hotel" }] }],
      },
    ];
  }

  function buildActivityGoals() {
    return [
      sharedGoal(),
      {
        id: "g-act", name: "Activity", type: "Activity", sortOrder: 1,
        items: [{ selections: [{ id: "sel-alist", type: "ActivityList" }, { id: "sel-adec", type: "Activity" }] }],
      },
    ];
  }

  beforeEach(() => {
    mockGraphql.mockReset();
    mockLoadSearchState.mockReset();
    mockGetHomeAirports.mockReset();
    mockGetHomeAirports.mockReturnValue([]);
    stdoutWrites = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutWrites.push(args.map(String).join(" ") + "\n");
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── airports ──────────────────────────────────────────────────────────────

  describe("search airports", () => {
    it("emits raw JSON of matches", async () => {
      await buildProgram().parseAsync(["node", "v", "search", "airports", "Keflavik", "--json"]);
      const out = JSON.parse(stdout());
      expect(Array.isArray(out)).toBe(true);
      expect(out.find((a: { code: string }) => a.code === "KEF")).toBeTruthy();
    });

    it("emits agent markdown with a bullet per airport", async () => {
      await buildProgram().parseAsync(["node", "v", "search", "airports", "Keflavik", "--agent"]);
      expect(stdout()).toMatch(/### Airports matching "Keflavik"/);
      expect(stdout()).toMatch(/- \*\*KEF\*\*/);
    });

    it("agent mode reports no matches without throwing", async () => {
      await buildProgram().parseAsync(["node", "v", "search", "airports", "Zzznowhere", "--agent"]);
      expect(stdout()).toMatch(/_No airports found matching "Zzznowhere"._/);
    });
  });

  // ── flights ───────────────────────────────────────────────────────────────

  describe("search flights", () => {
    it("one-way happy path: sets airports+dates, reuses the goal's Flight selection, emits --json", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.tripPlanId).toBe("plan-1");
      expect(out.selectionId).toBe("sel-fdec");
      expect(out.isRoundTrip).toBe(false);
      // Compact envelope (VOY-1714): summaries only — never raw bookingData.
      expect(out.optionCount).toBe(2);
      expect(out.topOptions).toHaveLength(2);
      // Default sort is by sortOrder: opt-b (1) before opt-a (2).
      expect(out.topOptions.map((o: { optionId: string }) => o.optionId)).toEqual(["opt-b", "opt-a"]);
      expect(JSON.stringify(out)).not.toContain("bookingData");
      expect(out.options).toBeUndefined();
      expect(out.url).toBe("https://dev.voyagier.com/plans/plan-1");
      // Airports were pushed to the goal graph (origin + destination).
      const airportCalls = mockGraphql.mock.calls.filter(c => String(c[0]).includes("updateTripPlanAirportSelection"));
      expect(airportCalls).toHaveLength(2);
    });

    it("uses the profile home airport when --from is omitted", async () => {
      mockGetHomeAirports.mockReturnValue(["sfo"]);
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      const airportVars = mockGraphql.mock.calls
        .filter(c => String(c[0]).includes("updateTripPlanAirportSelection"))
        .map(c => (c[1] as { input: { location: string } }).input.location);
      expect(airportVars).toContain("SFO");
    });

    it("throws when --from omitted and no home airport configured", async () => {
      installRouter();
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--plan", "plan-1", "--to", "NRT", "--date", "2026-08-01", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });

    it("round trip wires the return-leg goal and surfaces returnSelectionId", async () => {
      installRouter({ goals: buildFlightGoals(true) });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT",
        "--date", "2026-08-01", "--return", "2026-08-10", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.isRoundTrip).toBe(true);
      expect(out.returnSelectionId).toBe("sel-fdec-r");
      // Four airport sets: outbound (2) + return (2).
      const airportCalls = mockGraphql.mock.calls.filter(c => String(c[0]).includes("updateTripPlanAirportSelection"));
      expect(airportCalls).toHaveLength(4);
      // Return range sets a duration (endDate derived).
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("setTripPlanSelectionInputValue"))).toBe(true);
    });

    it("filters by --max-stops (client-side presentation filter)", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
        "--max-stops", "0", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.topOptions.map((o: { optionId: string }) => o.optionId)).toEqual(["opt-b"]); // only the 0-stop option
    });

    it("rejects a negative --max-stops", async () => {
      installRouter();
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
          "--max-stops", "-1", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });

    it("sorts by price when --sort price", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
        "--sort", "price", "--json",
      ]);
      const out = JSON.parse(stdout());
      // Prices live in the one-line summaries in the compact envelope.
      expect(out.topOptions.map((o: { summary: string }) => o.summary)).toEqual([
        expect.stringContaining("$300.00"),
        expect.stringContaining("$500.00"),
      ]);
    });

    it("emits agent markdown with the options and a select hint", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--agent",
      ]);
      expect(stdout()).toMatch(/### Flights \(LAX → NRT\)/);
      expect(stdout()).toMatch(/voyagier select/);
      expect(stdout()).toMatch(/👉 \*\*Plan:\*\*/);
    });

    it("agent mode points at selection-options --wait when options are empty", async () => {
      installRouter({ options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--agent",
      ]);
      expect(stdout()).toMatch(/still fetching inventory/);
      expect(stdout()).toMatch(/selection-options sel-fdec --wait --json/);
    });

    it("human output lists the flight options", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      expect(stdout()).toMatch(/flight option/);
      expect(stdout()).toMatch(/voyagier select <number>/);
    });

    it("--dry-run resolves airports and prints the plan without touching the API", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "Washington", "--to", "Goroka", "--date", "2026-08-01", "--dry-run",
      ]);
      const out = JSON.parse(stdout());
      expect(out.dryRun).toBe(true);
      // Washington → multi-airport metro, primary DCA; Goroka → single city match GKA.
      expect(out.steps.join("\n")).toMatch(/origin airport -> DCA, destination airport -> GKA/);
      expect(mockGraphql).not.toHaveBeenCalled();
    });

    it("rejects a malformed --date", async () => {
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "not-a-date", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
      expect(mockGraphql).not.toHaveBeenCalled();
    });

    it("falls back to VALIDATION when --plan omitted and no last-search state", async () => {
      mockLoadSearchState.mockReturnValue(null);
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });

    it("throws when the plan has no travellers", async () => {
      installRouter({ travellers: [] });
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });
  });

  // ── resolveAirportInput branches (exercised via flights --dry-run) ──────────

  describe("resolveAirportInput (via flights)", () => {
    it("throws VALIDATION for an unknown airport value", async () => {
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--plan", "plan-1", "--from", "LAX", "--to", "Zzznowhere", "--date", "2026-08-01", "--dry-run",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });

    it("throws VALIDATION (ambiguous) when a city matches multiple non-metro airports", async () => {
      // "Springfield" matches 3 airports and is not a metro alias.
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--plan", "plan-1", "--from", "LAX", "--to", "Springfield", "--date", "2026-08-01", "--dry-run",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });
  });

  // ── handleSearchError mapping ───────────────────────────────────────────────

  describe("handleSearchError mapping", () => {
    async function runWithFailingTravellers(message: string) {
      mockGraphql.mockImplementation(async (query: string) => {
        if (query.includes("tripPlanTravellers")) throw new Error(message);
        return {};
      });
      return buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
    }

    it("maps 401/Unauthorized to AUTH_FAILED", async () => {
      await expect(runWithFailingTravellers("Request failed: 401 Unauthorized")).rejects.toMatchObject({
        code: CliErrorCode.AUTH_FAILED,
      });
    });

    it("maps ECONNREFUSED to NETWORK", async () => {
      await expect(runWithFailingTravellers("connect ECONNREFUSED 127.0.0.1")).rejects.toMatchObject({
        code: CliErrorCode.NETWORK,
      });
    });

    it("maps anything else to API_ERROR", async () => {
      await expect(runWithFailingTravellers("kaboom")).rejects.toMatchObject({
        code: CliErrorCode.API_ERROR,
      });
    });

    // VOY-1762: --date became an .option() (so a TTY can be prompted), but a
    // missing --date must STILL hard-fail non-interactively (jest is non-TTY)
    // with the same required-option semantics commander used to enforce.
    it("missing --date hard-fails non-interactively with --date <date> required semantics", async () => {
      const err = await buildProgram()
        .parseAsync(["node", "v", "search", "flights", "--plan", "plan-1", "--from", "LAX", "--to", "NRT"])
        .catch((e) => e as { code?: CliErrorCode; message?: string });
      expect(err.code).toBe(CliErrorCode.VALIDATION);
      expect(err.message).toContain("--date <date>");
    });
  });

  // ── hotels ──────────────────────────────────────────────────────────────────

  describe("search hotels", () => {
    it("happy path: sets destination + date range, reuses the Hotel selection, emits --json", async () => {
      installRouter({ goals: buildHotelGoals() });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.selectionId).toBe("sel-hdec");
      expect(out.optionCount).toBe(2);
      expect(out.topOptions).toHaveLength(2);
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("setTripPlanDestinationValue"))).toBe(true);
      // Check-out derived via a duration input.
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("setTripPlanSelectionInputValue"))).toBe(true);
    });

    it("warns (non-JSON) about existing hotel items without --replace", async () => {
      installRouter({ goals: buildHotelGoals(), items: [{ id: "it-1", title: "Old hotel", selections: [{ type: "HOTEL" }] }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
      ]);
      expect(stderrWrites.join("")).toMatch(/already has 1 hotel item/);
      // Did NOT delete anything.
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("deleteTripPlanItem"))).toBe(false);
    });

    it("--replace deletes existing hotel items before searching", async () => {
      installRouter({ goals: buildHotelGoals(), items: [{ id: "it-1", title: "Old hotel", selections: [{ type: "HOTEL" }] }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--replace", "--json",
      ]);
      const deletes = mockGraphql.mock.calls.filter(c => String(c[0]).includes("deleteTripPlanItem"));
      expect(deletes).toHaveLength(1);
      expect((deletes[0][1] as { id: string }).id).toBe("it-1");
    });

    it("rejects --guests below 1", async () => {
      installRouter({ goals: buildHotelGoals() });
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "hotels",
          "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
          "--guests", "0", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });

    it("--dry-run short-circuits before hitting the goal graph", async () => {
      installRouter({ goals: buildHotelGoals() });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--dry-run",
      ]);
      const out = JSON.parse(stdout());
      expect(out.dryRun).toBe(true);
      // No goal-graph mutations in dry-run.
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("createTripPlanHotelSelection"))).toBe(false);
    });

    it("throws VALIDATION for an invalid --checkin date", async () => {
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "hotels",
          "--plan", "plan-1", "--location", "Paris", "--checkin", "nope", "--checkout", "2026-08-05", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });
  });

  // ── activities ────────────────────────────────────────────────────────────

  describe("search activities", () => {
    it("happy path: sets destination + date, reuses the Activity selection, emits --json", async () => {
      installRouter({ goals: buildActivityGoals(), options: [{ id: "act-1", name: "Snorkel tour", price: 80, sortOrder: 1 }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--query", "snorkeling", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.selectionId).toBe("sel-adec");
      expect(out.optionCount).toBe(1);
      expect(out.topOptions).toHaveLength(1);
      expect(out.topOptions[0].summary).toContain("Snorkel tour");
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("addTripPlanDateOption"))).toBe(true);
    });

    // VOY-1762 regression: missing --date still hard-fails non-interactively.
    it("missing --date hard-fails non-interactively with --date <date> required semantics", async () => {
      const err = await buildProgram()
        .parseAsync(["node", "v", "search", "activities", "--plan", "plan-1", "--destination", "Bali"])
        .catch((e) => e as { code?: CliErrorCode; message?: string });
      expect(err.code).toBe(CliErrorCode.VALIDATION);
      expect(err.message).toContain("--date <date>");
    });

    it("agent mode reports 'no activities found' on empty options", async () => {
      installRouter({ goals: buildActivityGoals(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--agent",
      ]);
      expect(stdout()).toMatch(/_No activities found for this destination and date._/);
    });

    it("--dry-run short-circuits before hitting the goal graph", async () => {
      installRouter({ goals: buildActivityGoals() });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--dry-run",
      ]);
      const out = JSON.parse(stdout());
      expect(out.dryRun).toBe(true);
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("createTripPlanActivitySelection"))).toBe(false);
    });
  });

  // ── extra coverage: create path, sort variants, output modes ────────────────

  function flightGoalsNoDecision() {
    // A Flight goal with a mirror list + airports but NO existing decision
    // selection → resolveOrCreateDecisionSelection takes the create branch.
    return [
      sharedGoal(),
      {
        id: "g-flight", name: "Flights", type: "Flight", sortOrder: 1,
        items: [{ selections: [
          { id: "sel-flist", type: "FlightList" },
          { id: "sel-ap-o", type: "Airport" },
          { id: "sel-ap-d", type: "Airport" },
        ] }],
      },
    ];
  }

  describe("decision-selection create path", () => {
    it("creates a new Flight selection when the goal has none", async () => {
      installRouter({ goals: flightGoalsNoDecision() });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.selectionId).toBe("sel-new"); // from createTripPlanFlightSelection
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("createTripPlanFlightSelection"))).toBe(true);
      // Reuse query must NOT have been issued.
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("getTripPlanSelection"))).toBe(false);
    });
  });

  describe("compact envelope vs --full (VOY-1714)", () => {
    /** 12 options — enough to cross the TOP_OPTIONS=10 display cap. */
    function manyFlightOptions(): unknown[] {
      return Array.from({ length: 12 }, (_, i) => ({
        id: `opt-${String(i).padStart(2, "0")}`,
        name: `XX ${100 + i}`,
        price: 100 + i,
        duration: "5h 00m",
        sortOrder: i + 1,
        bookingData: { stops: 0, flightToken: `TK${i}`, segments: [{ giant: "raw provider payload" }] },
      }));
    }

    it("caps default --json at 10 topOptions with a note, keeps full optionCount, and never leaks bookingData", async () => {
      installRouter({ options: manyFlightOptions() });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.optionCount).toBe(12);
      expect(out.topOptions).toHaveLength(10);
      expect(out.note).toMatch(/top 10 of 12/);
      expect(out.note).toMatch(/--full/);
      // The whole point: raw provider payloads stay OUT of the default stream.
      expect(JSON.stringify(out)).not.toContain("raw provider payload");
      expect(out.topOptions.every((o: Record<string, unknown>) => !("bookingData" in o))).toBe(true);
    });

    it("--full restores the complete option dump (bookingData included), indexed", async () => {
      installRouter({ options: manyFlightOptions() });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json", "--full",
      ]);
      const out = JSON.parse(stdout());
      expect(out.optionCount).toBe(12);
      expect(out.options).toHaveLength(12);
      expect(out.topOptions).toBeUndefined();
      expect(out.options[0].index).toBe(1);
      expect(out.options[0].bookingData).toBeDefined();
    });

    it("small result sets emit all options as topOptions with no note", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.topOptions).toHaveLength(2);
      expect(out.note).toBeUndefined();
    });

    it("agent mode caps the listing at 10 with an '…and N more' tail (—full lists all)", async () => {
      installRouter({ options: manyFlightOptions() });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--agent",
      ]);
      const md = stdout();
      expect(md).toContain("…and 2 more");
      expect(md).not.toContain("11.");
    });
  });

  describe("flight sort + stops parsing", () => {
    it("sorts by duration (parses '5h 30m' vs '8h 00m')", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--sort", "duration", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.topOptions.map((o: { optionId: string }) => o.optionId)).toEqual(["opt-b", "opt-a"]); // 5h30 before 8h
    });

    it("sorts by stops, deriving stop count from segments[] when no explicit stops", async () => {
      installRouter({
        options: [
          { id: "two-seg", name: "X", sortOrder: 1, bookingData: { segments: [{}, {}, {}] } }, // 2 stops
          { id: "nonstop", name: "Y", sortOrder: 2, bookingData: { segments: [{}] } },        // 0 stops
        ],
      });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--sort", "stops", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.topOptions.map((o: { optionId: string }) => o.optionId)).toEqual(["nonstop", "two-seg"]);
    });
  });

  describe("single-airport metro", () => {
    it("resolves a single-airport metro to its one code (via dry-run)", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "Seattle", "--to", "NRT", "--date", "2026-08-01", "--dry-run",
      ]);
      const out = JSON.parse(stdout());
      expect(out.steps.join("\n")).toMatch(/origin airport -> SEA/);
      expect(stderrWrites.join("")).toMatch(/Using SEA \(Seattle Metro\)/);
    });
  });

  describe("flights agent + human output edge cases", () => {
    it("agent round-trip includes the return-selection instruction", async () => {
      installRouter({ goals: buildFlightGoals(true) });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT",
        "--date", "2026-08-01", "--return", "2026-08-10", "--agent",
      ]);
      expect(stdout()).toMatch(/Round trip:/);
      expect(stdout()).toMatch(/sel-fdec-r/);
    });

    it("human output notes 'still fetching' when options are empty", async () => {
      installRouter({ options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      expect(stderrWrites.join("")).toMatch(/No options yet/);
      expect(stderrWrites.join("")).toMatch(/selection-options sel-fdec --wait/);
    });

    it("human round trip prints the outbound-then-return note", async () => {
      installRouter({ goals: buildFlightGoals(true) });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT",
        "--date", "2026-08-01", "--return", "2026-08-10",
      ]);
      expect(stdout()).toMatch(/Select the outbound leg first/);
    });
  });

  describe("airports human output", () => {
    it("prints a table of matches", async () => {
      await buildProgram().parseAsync(["node", "v", "search", "airports", "Keflavik"]);
      expect(stdout()).toMatch(/airport.*matching "Keflavik"/);
      expect(stdout()).toMatch(/KEF/);
    });

    it("warns (stderr) when nothing matches", async () => {
      await buildProgram().parseAsync(["node", "v", "search", "airports", "Zzznowhere"]);
      expect(stderrWrites.join("")).toMatch(/No airports found matching "Zzznowhere"./);
    });

    it("emits [] JSON when nothing matches", async () => {
      await buildProgram().parseAsync(["node", "v", "search", "airports", "Zzznowhere", "--json"]);
      expect(JSON.parse(stdout())).toEqual([]);
    });
  });

  describe("hotels output modes", () => {
    it("--replace prints a human confirmation of removed items", async () => {
      installRouter({ goals: buildHotelGoals(), items: [{ id: "it-1", title: "Old", selections: [{ type: "HOTEL" }] }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--replace",
      ]);
      expect(stderrWrites.join("")).toMatch(/Replaced 1 existing hotel item/);
    });

    it("warns but proceeds when --replace cleanup fails", async () => {
      mockGraphql.mockImplementation(async (query: string) => {
        if (query.includes("tripPlanTravellers")) return { tripPlanTravellers: [{ id: "t-1", firstName: "A", lastName: "B" }] };
        if (query.includes("selections { type }")) throw new Error("item-types boom");
        if (query.includes("GoalsForSearch")) return { tripPlanGoals: buildHotelGoals() };
        if (query.includes("getTripPlanSelection")) return { getTripPlanSelection: { id: "sel-hdec", options: [] } };
        return {};
      });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--replace",
      ]);
      expect(stderrWrites.join("")).toMatch(/failed to clean up existing hotel items/);
    });

    it("--verbose logs the request details", async () => {
      installRouter({ goals: buildHotelGoals() });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--verbose",
      ]);
      expect(stderrWrites.join("")).toMatch(/location: "Paris"/);
    });

    it("sorts hotels by price", async () => {
      installRouter({
        goals: buildHotelGoals(),
        options: [
          { id: "h-hi", name: "Ritz", price: 900, sortOrder: 1 },
          { id: "h-lo", name: "Ibis", price: 120, sortOrder: 2 },
        ],
      });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--sort", "price", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.topOptions.map((o: { optionId: string }) => o.optionId)).toEqual(["h-lo", "h-hi"]);
    });

    it("agent mode lists hotels with a select hint", async () => {
      installRouter({ goals: buildHotelGoals(), options: [{ id: "h-1", name: "Ritz", price: 900, sortOrder: 1 }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--agent",
      ]);
      expect(stdout()).toMatch(/### Hotels \(Paris\)/);
      expect(stdout()).toMatch(/voyagier select/);
    });

    it("human output for empty hotel results hints an airport-code location", async () => {
      installRouter({ goals: buildHotelGoals(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "BKI", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
      ]);
      const err = stderrWrites.join("");
      expect(err).toMatch(/no hotels matched "BKI"/);
      expect(err).toMatch(/looks like an airport code/);
    });

    it("throws when the plan has no travellers", async () => {
      installRouter({ goals: buildHotelGoals(), travellers: [] });
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "hotels",
          "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });
  });

  describe("activities output modes", () => {
    it("warns about existing activity items without --replace", async () => {
      installRouter({ goals: buildActivityGoals(), items: [{ id: "a-1", title: "Old tour", selections: [{ type: "ACTIVITY" }] }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01",
      ]);
      expect(stderrWrites.join("")).toMatch(/already has 1 activity item/);
    });

    it("--replace removes existing activity items", async () => {
      installRouter({ goals: buildActivityGoals(), items: [{ id: "a-1", title: "Old", selections: [{ type: "ACTIVITY" }] }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--replace", "--json",
      ]);
      expect(mockGraphql.mock.calls.filter(c => String(c[0]).includes("deleteTripPlanItem"))).toHaveLength(1);
    });

    it("--verbose logs the request details", async () => {
      installRouter({ goals: buildActivityGoals() });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--query", "dive", "--verbose",
      ]);
      expect(stderrWrites.join("")).toMatch(/destination: "Bali".*query: "dive"/);
    });

    it("sorts activities by price", async () => {
      installRouter({
        goals: buildActivityGoals(),
        options: [
          { id: "act-hi", name: "Yacht", price: 500, sortOrder: 1 },
          { id: "act-lo", name: "Walk", price: 20, sortOrder: 2 },
        ],
      });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--sort", "price", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.topOptions.map((o: { optionId: string }) => o.optionId)).toEqual(["act-lo", "act-hi"]);
    });

    it("agent mode lists activities", async () => {
      installRouter({ goals: buildActivityGoals(), options: [{ id: "act-1", name: "Snorkel", price: 80, sortOrder: 1 }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--agent",
      ]);
      expect(stdout()).toMatch(/### Activities \(Bali\)/);
    });

    it("human output lists activity options", async () => {
      installRouter({ goals: buildActivityGoals(), options: [{ id: "act-1", name: "Snorkel", price: 80, sortOrder: 1 }] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01",
      ]);
      expect(stdout()).toMatch(/activity option/);
    });

    it("human output warns when there are no activities", async () => {
      installRouter({ goals: buildActivityGoals(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "activities",
        "--plan", "plan-1", "--destination", "Nowheresville", "--date", "2026-08-01",
      ]);
      expect(stderrWrites.join("")).toMatch(/No activities found for "Nowheresville"/);
    });

    it("throws when the plan has no travellers", async () => {
      installRouter({ goals: buildActivityGoals(), travellers: [] });
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "activities",
          "--plan", "plan-1", "--destination", "Bali", "--date", "2026-08-01", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    });
  });
});
