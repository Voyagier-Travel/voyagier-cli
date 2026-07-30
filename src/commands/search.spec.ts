import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";
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
// VOY-1793: selection-reuse param observability. Default: no stored record
// (first search) → no effectiveParams/warnings. Tests override the getter to
// simulate a prior search with different params.
const mockGetSelectionSearchParams = jest.fn<(id: string) => unknown>(() => null);
const mockRememberSelectionSearchParams = jest.fn();

jest.unstable_mockModule("../state.js", () => ({
  loadSearchState: mockLoadSearchState,
  saveSearchState: jest.fn(),
  clearSearchState: jest.fn(),
  isSearchStateStale: jest.fn(() => false),
  saveOptionsState: jest.fn(),
  loadOptionsState: jest.fn(),
  clearOptionsState: jest.fn(),
  getSelectionSearchParams: mockGetSelectionSearchParams,
  rememberSelectionSearchParams: mockRememberSelectionSearchParams,
}));

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

// VOY-1780: the human/TTY inline wait delegates the poll loop to
// selection-wait.waitForSelectionOptions (unit-tested in its own spec). Mock it
// here so the command-level tests drive the post-wait branches (render on
// READY, descriptive stops on FETCHING/NO_RESULTS/FETCH_ERROR/AWAITING_INPUT)
// deterministically without real timers.
const mockWaitForSelectionOptions =
  jest.fn<(...args: unknown[]) => Promise<{ raw: unknown; result: Record<string, unknown> }>>();
jest.unstable_mockModule("../selection-wait.js", () => ({
  waitForSelectionOptions: mockWaitForSelectionOptions,
}));

const mockGetHomeAirports = jest.fn<() => string[]>(() => []);
jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn(() => "https://dev.voyagier.com/api"),
  getHomeAirports: mockGetHomeAirports,
  // state.ts (fully mocked) is the only other config consumer in this graph;
  // plan-footer.ts uses getApiUrl above. CONFIG_DIR kept for completeness.
  CONFIG_DIR: "/tmp/voyagier-search-spec-config",
}));

// VOY-1761: the auto-scaffold path (no --plan, no last-search) delegates client
// resolution to scaffold.ts → resolveClient. Mock it so the scaffold flow never
// hits the real clients query (search.spec's api mock has no fieldFallback).
const mockResolveClient = jest.fn<(explicit?: string, opts?: unknown) => Promise<unknown>>();
jest.unstable_mockModule("./clients.js", () => ({
  resolveClient: mockResolveClient,
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
    /** Goals the scaffold's ensure step sees (VOY-1761). Default: template graph. */
    scaffoldGoals?: unknown[];
    /** Options the getTripPlanSelection read returns; defaults to `options`.
     *  VOY-1780: lets the inline-wait re-fetch return a DIFFERENT (non-empty)
     *  set than the create mutation's initial (empty) options. */
    decisionOptions?: unknown[];
  }

  function installRouter(cfg: RouterOpts = {}): void {
    const travellers = cfg.travellers ?? [{ id: "t-1", firstName: "Ada", lastName: "Lovelace" }];
    const goals = cfg.goals ?? buildFlightGoals();
    const options = cfg.options ?? sampleFlightOptions();
    const items = cfg.items ?? [];
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("tripPlanTravellers")) return { tripPlanTravellers: travellers };
      if (query.includes("GoalsForSearch")) return { tripPlanGoals: goals };
      // VOY-1761 auto-scaffold ops (only exercised by the scaffold tests). Match
      // the plan-create mutation by its exact "(" so it never captures the
      // createTripPlanGoal mutation, whose name extends past "CreateTripPlan".
      if (query.includes("mutation CreateTripPlan(")) return { createTripPlan: { id: "scaffold-plan", title: "MCO · Sep 2026" } };
      if (query.includes("query TripPlanGoals")) return { tripPlanGoals: cfg.scaffoldGoals ?? [] };
      if (query.includes("createTripPlanGoal")) return { createTripPlanGoal: { id: "ng-scaffold", name: "Outbound Flights", type: "Flight" } };
      if (query.includes("deleteTripPlanGoal")) return { deleteTripPlanGoal: true };
      if (query.includes("getTripPlanSelection")) {
        return { getTripPlanSelection: { id: "sel-reused", options: cfg.decisionOptions ?? options } };
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
    mockResolveClient.mockReset();
    mockResolveClient.mockResolvedValue({ id: "client-1", name: "Blog Tester", autoResolved: false });
    mockWaitForSelectionOptions.mockReset();
    mockGetSelectionSearchParams.mockReset();
    mockGetSelectionSearchParams.mockReturnValue(null);
    mockRememberSelectionSearchParams.mockReset();
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
      // VOY-1795: url aliases the traveller-facing clientUrl; advisorUrl added alongside.
      expect(out.url).toBe("https://dev.voyagier.com/me/trips/plans/plan-1");
      expect(out.clientUrl).toBe("https://dev.voyagier.com/me/trips/plans/plan-1");
      expect(out.advisorUrl).toBe("https://dev.voyagier.com/advisor/plans/plan-1");
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

  // ── VOY-1761: auto-scaffold a draft plan when no --plan and no last-search ──
  describe("search flights auto-scaffold (VOY-1761)", () => {
    it("no --plan + no last-search: scaffolds a draft plan and runs the search", async () => {
      mockLoadSearchState.mockReturnValue(null);
      installRouter({ travellers: [] }); // draft plan is traveller-less by design
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
        "--client", "blog.tester@example.com", "--no-input", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.scaffolded).toBe(true);
      expect(out.tripPlanId).toBe("scaffold-plan");
      expect(out.url).toBe("https://dev.voyagier.com/me/trips/plans/scaffold-plan");
      expect(out.clientUrl).toBe("https://dev.voyagier.com/me/trips/plans/scaffold-plan");
      expect(out.advisorUrl).toBe("https://dev.voyagier.com/advisor/plans/scaffold-plan");
      // The search still ran against the drafted plan (selection resolved).
      expect(out.selectionId).toBe("sel-fdec");
      // Client resolution was delegated with the explicit --client ref.
      expect(mockResolveClient).toHaveBeenCalledWith("blog.tester@example.com", expect.anything());
      // The draft plan is created via the shared scaffold mutation.
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("mutation CreateTripPlan("))).toBe(true);
    });

    it("does NOT throw the no-travellers error on a scaffolded (traveller-less) plan", async () => {
      mockLoadSearchState.mockReturnValue(null);
      installRouter({ travellers: [] });
      // Would previously reject with VALIDATION on 0 travellers; now proceeds.
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
        "--client", "blog.tester@example.com", "--no-input", "--json",
      ]);
      expect(JSON.parse(stdout()).scaffolded).toBe(true);
    });

    it("--return scaffolds a round-trip draft (isRoundTrip true)", async () => {
      mockLoadSearchState.mockReturnValue(null);
      installRouter({ goals: buildFlightGoals(true), travellers: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--return", "2026-08-10",
        "--client", "blog.tester@example.com", "--no-input", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.scaffolded).toBe(true);
      expect(out.isRoundTrip).toBe(true);
    });

    it("non-interactive (jest is non-TTY) never prompts; surfaces the client error instead", async () => {
      mockLoadSearchState.mockReturnValue(null);
      installRouter({ travellers: [] });
      mockResolveClient.mockRejectedValue(
        new CliError(CliErrorCode.MULTIPLE_CLIENTS, "Multiple ACTIVE clients found. Specify --client"),
      );
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--no-input", "--json",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.MULTIPLE_CLIENTS });
      // resolveClient was asked NOT to run an interactive picker.
      const call = mockResolveClient.mock.calls[0];
      expect((call[1] as { interactive?: boolean }).interactive).toBe(false);
    });

    it("still hard-errors (no scaffold) under --dry-run when no plan/state", async () => {
      mockLoadSearchState.mockReturnValue(null);
      installRouter({ travellers: [] });
      await expect(
        buildProgram().parseAsync([
          "node", "v", "search", "flights",
          "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--dry-run",
        ]),
      ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
      // No plan was created.
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("mutation CreateTripPlan("))).toBe(false);
    });

    it("with --plan given: no scaffold, no 'scaffolded' key (byte-compatible)", async () => {
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect("scaffolded" in out).toBe(false);
      expect(mockResolveClient).not.toHaveBeenCalled();
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("mutation CreateTripPlan("))).toBe(false);
      // --plan path never touches the last-search state file (loadSearchState
      // has side effects on corrupted files — must stay unread here).
      expect(mockLoadSearchState).not.toHaveBeenCalled();
    });

    it("reads the last-search state exactly once on the fallback path (no scaffold)", async () => {
      mockLoadSearchState.mockReturnValue(state("last-search-plan"));
      installRouter();
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      expect(mockLoadSearchState).toHaveBeenCalledTimes(1);
      const out = JSON.parse(stdout());
      expect(out.tripPlanId).toBe("last-search-plan");
      expect("scaffolded" in out).toBe(false);
      expect(mockGraphql.mock.calls.some(c => String(c[0]).includes("mutation CreateTripPlan("))).toBe(false);
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
    // reproducing commander's original `.requiredOption` failure BYTE-FOR-BYTE:
    // the exact string on stderr, an empty stdout, and exit code 1.
    it("missing --date hard-fails non-interactively, byte-matching commander's required-option failure", async () => {
      const err = await buildProgram()
        .parseAsync(["node", "v", "search", "flights", "--plan", "plan-1", "--from", "LAX", "--to", "NRT"])
        .catch((e) => e as { code?: string; exitCode?: number; message?: string });
      // Exact commander bytes: `error: ` prefix, no trailing period, no added hint.
      expect(err.message).toBe("error: required option '--date <date>' not specified");
      // Commander's own exit semantics (throws under exitOverride).
      expect(err.code).toBe("commander.missingMandatoryOptionValue");
      expect(err.exitCode).toBe(1);
      // stderr carries the message; stdout stays empty.
      expect(stderrWrites.join("")).toBe("error: required option '--date <date>' not specified\n");
      expect(stdout()).toBe("");
    });

    // The date error must preempt origin resolution: `--to` set, no `--date` and
    // no origin — commander used to report the missing --date at parse time,
    // BEFORE any action code ran. Assert we still fail on --date, not origin.
    it("missing --date preempts the 'No origin specified' error", async () => {
      mockGetHomeAirports.mockReturnValue([]);
      const err = await buildProgram()
        .parseAsync(["node", "v", "search", "flights", "--plan", "plan-1", "--to", "NRT"])
        .catch((e) => e as { message?: string });
      expect(err.message).toBe("error: required option '--date <date>' not specified");
    });

    // --json is a non-interactive machine mode: same commander failure, and
    // stdout MUST stay empty (no JSON error envelope) exactly as when the parser
    // rejected the missing required option.
    it("missing --date under --json: commander bytes on stderr, empty stdout", async () => {
      const err = await buildProgram()
        .parseAsync(["node", "v", "search", "flights", "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--json"])
        .catch((e) => e as { message?: string; exitCode?: number });
      expect(err.message).toBe("error: required option '--date <date>' not specified");
      expect(err.exitCode).toBe(1);
      expect(stderrWrites.join("")).toBe("error: required option '--date <date>' not specified\n");
      expect(stdout()).toBe("");
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

  // ── selection-reuse param observability (VOY-1793) ──────────────────────────

  describe("selection-reuse param observability", () => {
    const flightArgs = (date: string, extra: string[] = []) => [
      "node", "v", "search", "flights",
      "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", date, ...extra,
    ];

    it("flights --json echoes requestedParams and records the original on a first search (no warning)", async () => {
      installRouter();
      await buildProgram().parseAsync(flightArgs("2026-08-01", ["--json"]));
      const out = JSON.parse(stdout());
      expect(out.requestedParams).toEqual({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
      expect(out.effectiveParams).toBeUndefined();
      expect(out.warnings).toBeUndefined();
      expect(mockRememberSelectionSearchParams).toHaveBeenCalledWith(
        "sel-fdec",
        expect.objectContaining({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 }),
      );
    });

    it("flights --json warns + echoes effectiveParams when the reused selection was searched with a different date", async () => {
      installRouter();
      mockGetSelectionSearchParams.mockReturnValue({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
      await buildProgram().parseAsync(flightArgs("2026-09-01", ["--json"]));
      const out = JSON.parse(stdout());
      expect(out.requestedParams.depart).toBe("2026-09-01");
      expect(out.effectiveParams).toEqual({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0]).toContain("SELECTION_REUSED_PARAMS_MISMATCH");
      expect(out.warnings[0]).toContain("departure date");
      // Reuse must NOT overwrite the stored original (else mismatch is undetectable next time).
      expect(mockRememberSelectionSearchParams).not.toHaveBeenCalled();
    });

    it("flights --json: matching reused params echo effectiveParams but emit no warning", async () => {
      installRouter();
      mockGetSelectionSearchParams.mockReturnValue({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
      await buildProgram().parseAsync(flightArgs("2026-08-01", ["--json"]));
      const out = JSON.parse(stdout());
      expect(out.warnings).toBeUndefined();
      expect(out.effectiveParams).toEqual({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
    });

    it("flights human output prints a clear ⚠ mismatch line to stderr", async () => {
      installRouter();
      mockGetSelectionSearchParams.mockReturnValue({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
      await buildProgram().parseAsync(flightArgs("2026-09-01"));
      expect(stderrWrites.join("")).toMatch(/⚠[\s\S]*SELECTION_REUSED_PARAMS_MISMATCH/);
    });

    it("hotels --json warns + echoes effectiveParams when the reused selection was searched with a different check-in", async () => {
      installRouter({ goals: buildHotelGoals() });
      mockGetSelectionSearchParams.mockReturnValue({ destination: "Paris", checkin: "2026-08-01", checkout: "2026-08-05", partySize: 1 });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-09-01", "--checkout", "2026-09-05", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.requestedParams).toEqual({ destination: "Paris", checkin: "2026-09-01", checkout: "2026-09-05", partySize: 1 });
      expect(out.effectiveParams.checkin).toBe("2026-08-01");
      expect(out.warnings[0]).toContain("SELECTION_REUSED_PARAMS_MISMATCH");
      expect(out.warnings[0]).toContain("check-in");
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

    // VOY-1762 regression: missing --date still hard-fails non-interactively,
    // byte-matching commander's original `.requiredOption` failure.
    it("missing --date hard-fails non-interactively, byte-matching commander's required-option failure", async () => {
      const err = await buildProgram()
        .parseAsync(["node", "v", "search", "activities", "--plan", "plan-1", "--destination", "Bali"])
        .catch((e) => e as { code?: string; exitCode?: number; message?: string });
      expect(err.message).toBe("error: required option '--date <date>' not specified");
      expect(err.code).toBe("commander.missingMandatoryOptionValue");
      expect(err.exitCode).toBe(1);
      expect(stderrWrites.join("")).toBe("error: required option '--date <date>' not specified\n");
      expect(stdout()).toBe("");
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

  function hotelGoalsNoDecision() {
    // A Hotel goal with a mirror list but NO existing decision selection →
    // resolveOrCreateDecisionSelection takes the create branch (VOY-1780 lets
    // the inline-wait re-fetch differ from the create mutation's options).
    return [
      sharedGoal(),
      {
        id: "g-hotel", name: "Hotel", type: "Hotel", sortOrder: 1,
        items: [{ selections: [{ id: "sel-hlist", type: "HotelList" }] }],
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
      // Non-TTY never enters the inline wait, so no heartbeat lines either
      // (the "(Ns)" elapsed suffix is unique to a heartbeat).
      expect(mockWaitForSelectionOptions).not.toHaveBeenCalled();
      expect(stderrWrites.join("")).not.toMatch(/fetching inventory \(\d+s\)/);
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

  // ── inline wait for async inventory (VOY-1780) ──────────────────────────────
  describe("inline wait (VOY-1780)", () => {
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    let realIsTTY: boolean | undefined;
    let realCI: string | undefined;

    beforeEach(() => {
      // Force the human/TTY gate on; suppress the animated spinner via CI so
      // stderr assertions see only the message writes (the wait gate keys off
      // isTTY only, not CI, so it still fires).
      realIsTTY = process.stderr.isTTY;
      realCI = process.env.CI;
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.env.CI = "1";
    });
    afterEach(() => {
      Object.defineProperty(process.stderr, "isTTY", { value: realIsTTY, configurable: true });
      if (realCI === undefined) delete process.env.CI;
      else process.env.CI = realCI;
    });

    const snap = (result: Record<string, unknown>) => ({ raw: { id: "sel-new" }, result });

    it("flights: waits, then renders full results through the immediate-results path when READY", async () => {
      // Create path (no existing decision selection): the create mutation returns
      // EMPTY options → the wait fires; the READY re-fetch returns the real set.
      installRouter({ goals: flightGoalsNoDecision(), options: [], decisionOptions: sampleFlightOptions() });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "READY", optionCount: 2 }));
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      expect(mockWaitForSelectionOptions).toHaveBeenCalledTimes(1);
      // Rendered the real options, not a poll pointer.
      expect(stdout()).toMatch(/2 flight options found/);
      expect(stdout()).toMatch(/voyagier select <number>/);
      expect(stderrWrites.join("")).not.toMatch(/still fetching inventory/);
    });

    // Drive the real heartbeat sink the command hands to waitForSelectionOptions
    // with synthetic per-poll beats at chosen elapsed times. The spinner is
    // suppressed (CI=1) so this exercises the plain-stderr fallback (VOY-1780).
    const withHeartbeats = (
      beats: number[],
      final: Record<string, unknown>,
    ) => mockWaitForSelectionOptions.mockImplementation(async (...args: unknown[]) => {
      const deps = args[2] as { heartbeat?: (h: Record<string, unknown>) => void };
      beats.forEach((elapsedMs, i) =>
        deps.heartbeat?.({ attempt: i + 1, status: "FETCHING", optionCount: 0, elapsedMs }),
      );
      return snap(final);
    });

    it("flights: no-spinner TTY (CI) falls back to plain stderr heartbeats at ~10s cadence", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [], decisionOptions: sampleFlightOptions() });
      // Five polls, elapsed 2s/9s/11s/15s/21s → lines only when a new 10s window
      // is crossed (11s and 21s); the sub-10s polls stay silent (not every poll).
      withHeartbeats([2000, 9000, 11000, 15000, 21000], { status: "READY", optionCount: 2 });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      const err = stripAnsi(stderrWrites.join(""));
      // Exactly two heartbeat lines emitted, and at the window boundaries only.
      expect((err.match(/fetching inventory/g) ?? [])).toHaveLength(2);
      expect(err).toMatch(/Searching LAX → NRT… fetching inventory \(11s\)/);
      expect(err).toMatch(/Searching LAX → NRT… fetching inventory \(21s\)/);
      // Sub-window polls did NOT print — cadence respected, not one-per-poll.
      expect(err).not.toMatch(/\(2s\)/);
      expect(err).not.toMatch(/\(9s\)/);
      expect(err).not.toMatch(/\(15s\)/);
      // Still rendered the real results through the immediate-results path.
      expect(stdout()).toMatch(/2 flight options found/);
    });

    it("hotels: no-spinner TTY (CI) emits a plain stderr heartbeat past the 10s window", async () => {
      installRouter({
        goals: hotelGoalsNoDecision(),
        options: [],
        decisionOptions: [{ id: "h-1", name: "Ritz", price: 900, sortOrder: 1 }],
      });
      withHeartbeats([5000, 12000], { status: "READY", optionCount: 1 });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
      ]);
      const err = stripAnsi(stderrWrites.join(""));
      expect((err.match(/fetching inventory/g) ?? [])).toHaveLength(1);
      expect(err).toMatch(/Searching hotels in Paris… fetching inventory \(12s\)/);
      expect(err).not.toMatch(/\(5s\)/);
    });

    it("flights: timeout (still FETCHING) → plain-English line + bare resume command, exit 0", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "FETCHING", optionCount: 0, retryAfterMs: 2000 }));
      // Resolves (exit 0) — never throws.
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      const err = stripAnsi(stderrWrites.join(""));
      expect(err).toMatch(/still loading on our side/);
      // Copy-safe: the command is alone on its own line, no `Poll:`/label prefix.
      expect(err).toMatch(/^ {2}voyagier selection-options sel-new --wait$/m);
      expect(err).not.toMatch(/Poll: voyagier/);
    });

    it("flights: NO_RESULTS → descriptive 'no flights matched' (not a generic message)", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "NO_RESULTS", optionCount: 0 }));
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      expect(stripAnsi(stderrWrites.join(""))).toMatch(/No flights matched LAX → NRT on these dates/);
    });

    it("flights: FETCH_ERROR → surfaces the fetch error, not a bare empty", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      mockWaitForSelectionOptions.mockResolvedValue(
        snap({ status: "FETCH_ERROR", optionCount: 0, fetchError: "provider timeout" }),
      );
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      const err = stripAnsi(stderrWrites.join(""));
      expect(err).toMatch(/hit an error while fetching: provider timeout/);
    });

    it("flights: AWAITING_INPUT → names the missing-input situation", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "AWAITING_INPUT", optionCount: 0 }));
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      expect(stripAnsi(stderrWrites.join(""))).toMatch(/missing a required input/);
    });

    it("flights: --no-wait skips polling and prints the copy-safe hint", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--no-wait",
      ]);
      expect(mockWaitForSelectionOptions).not.toHaveBeenCalled();
      const err = stripAnsi(stderrWrites.join(""));
      expect(err).toMatch(/No options yet/);
      expect(err).toMatch(/^ {2}voyagier selection-options sel-new --wait$/m);
      expect(err).not.toMatch(/Poll: voyagier/);
    });

    it("flights: --json never polls (immediate return + poll pointer)", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--json",
      ]);
      expect(mockWaitForSelectionOptions).not.toHaveBeenCalled();
      expect(JSON.parse(stdout()).selectionId).toBe("sel-new");
    });

    it("flights: --agent never polls", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01", "--agent",
      ]);
      expect(mockWaitForSelectionOptions).not.toHaveBeenCalled();
      expect(stdout()).toMatch(/selection-options sel-new --wait --json/);
    });

    it("hotels: waits, then renders full results when READY", async () => {
      installRouter({
        goals: hotelGoalsNoDecision(),
        options: [],
        decisionOptions: [{ id: "h-1", name: "Ritz", price: 900, sortOrder: 1 }],
      });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "READY", optionCount: 1 }));
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
      ]);
      expect(mockWaitForSelectionOptions).toHaveBeenCalledTimes(1);
      expect(stdout()).toMatch(/1 hotel option found/);
    });

    it("hotels: NO_RESULTS falls through to the location-specific suggestions", async () => {
      installRouter({ goals: buildHotelGoals(), options: [] });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "NO_RESULTS", optionCount: 0 }));
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "BKI", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
      ]);
      const err = stripAnsi(stderrWrites.join(""));
      expect(err).toMatch(/no hotels matched "BKI"/);
      expect(err).toMatch(/looks like an airport code/);
    });

    it("hotels: timeout (FETCHING) → plain-English line + bare resume command", async () => {
      installRouter({ goals: hotelGoalsNoDecision(), options: [] });
      mockWaitForSelectionOptions.mockResolvedValue(snap({ status: "FETCHING", optionCount: 0, retryAfterMs: 2000 }));
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
      ]);
      const err = stripAnsi(stderrWrites.join(""));
      expect(err).toMatch(/still loading on our side/);
      expect(err).toMatch(/^ {2}voyagier selection-options sel-new --wait$/m);
    });

    it("hotels: --no-wait skips polling with a copy-safe hint", async () => {
      installRouter({ goals: hotelGoalsNoDecision(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--plan", "plan-1", "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05", "--no-wait",
      ]);
      expect(mockWaitForSelectionOptions).not.toHaveBeenCalled();
      expect(stripAnsi(stderrWrites.join(""))).toMatch(/^ {2}voyagier selection-options sel-new --wait$/m);
    });
  });

  describe("non-TTY never polls (VOY-1780)", () => {
    it("flights: no inline wait when stderr is not a TTY", async () => {
      installRouter({ goals: flightGoalsNoDecision(), options: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "flights",
        "--plan", "plan-1", "--from", "LAX", "--to", "NRT", "--date", "2026-08-01",
      ]);
      expect(mockWaitForSelectionOptions).not.toHaveBeenCalled();
      expect(stderrWrites.join("")).toMatch(/No options yet/);
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

    // VOY-1761: hotels get the same auto-scaffold treatment (hotel-only shape).
    it("auto-scaffolds a hotel-only draft when no --plan/last-search", async () => {
      mockLoadSearchState.mockReturnValue(null);
      installRouter({ goals: buildHotelGoals(), travellers: [] });
      await buildProgram().parseAsync([
        "node", "v", "search", "hotels",
        "--location", "Paris", "--checkin", "2026-08-01", "--checkout", "2026-08-05",
        "--client", "blog.tester@example.com", "--no-input", "--json",
      ]);
      const out = JSON.parse(stdout());
      expect(out.scaffolded).toBe(true);
      expect(out.tripPlanId).toBe("scaffold-plan");
      expect(out.selectionId).toBe("sel-hdec");
      expect(mockResolveClient).toHaveBeenCalledWith("blog.tester@example.com", expect.anything());
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
