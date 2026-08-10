import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError } from "../errors.js";

// ── Mocks (must be declared before dynamic imports) ────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

// ── Dynamic imports after mocks ────────────────────────────────────────────

let registerSelectionOptionsCommands: (program: Command) => void;
let deriveChosen: typeof import("./selection-options.js").deriveChosen;

beforeAll(async () => {
  const mod = await import("./selection-options.js");
  registerSelectionOptionsCommands = mod.registerSelectionOptionsCommands;
  deriveChosen = mod.deriveChosen;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const SEL_ID = "c5ac11e2-cf59-45ee-b0bd-b778433cd1a2";
const MON_ID = "a4dbe42a-9705-4729-8c4e-beca3ce7491a";

function selectionResult(over: Partial<{ blueprintMonitorId: string | null; parentOptionId: string | null; options: unknown[] }> = {}) {
  return {
    getTripPlanSelection: {
      __typename: "TripPlanFlightJourneySelection",
      id: SEL_ID,
      type: "FlightJourney",
      blueprintMonitorId: over.blueprintMonitorId === undefined ? MON_ID : over.blueprintMonitorId,
      parentOptionId: over.parentOptionId ?? null,
      options: over.options ?? [],
    },
  };
}

function monitorResult(over: Partial<{ fetchedAt: string | null; lastFetchAttempt: string | null; lastFetchError: string | null }> = {}) {
  return {
    blueprintMonitor: {
      id: MON_ID,
      type: "FlightJourney",
      queryVersion: 1,
      fetchedAt: over.fetchedAt === undefined ? "2026-06-03T00:00:00Z" : over.fetchedAt,
      lastFetchAttempt: over.lastFetchAttempt === undefined ? "2026-06-03T00:00:00Z" : over.lastFetchAttempt,
      lastFetchError: over.lastFetchError ?? null,
    },
  };
}

const OPTION = { id: "opt-1", name: "BWI → MCO → BWI", price: 317, time: null, airline: "AA", duration: null, sortOrder: 0 };

// ── Harness ──────────────────────────────────────────────────────────────

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerSelectionOptionsCommands(program);
  await program.parseAsync(["node", "voyagier", "selection-options", ...args]);
}

let stdout: string;
let writeSpy: ReturnType<typeof jest.spyOn>;
let logSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  stdout = "";
  // Capture BOTH process.stdout.write (JSON/agent paths) AND console.log
  // (human path). Under the full suite jest intercepts console, so spying on
  // process.stdout.write alone misses console.log output.
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  });
  logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
    stdout += args.join(" ") + "\n";
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  logSpy.mockRestore();
});

function lastJson() {
  const calls = mockJsonOutput.mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as any) : null;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("selection-options command (VOY-1415)", () => {
  it("READY: emits status + options, JSON by default (no --human/--json flag)", async () => {
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID]);
    const out = lastJson();
    expect(out.status).toBe("READY");
    expect(out.optionCount).toBe(1);
    expect(out.options[0].id).toBe("opt-1");
    expect(out.selectionId).toBe(SEL_ID);
    // VOY-1875: the selection also exposes `id` as an additive alias, equal to selectionId.
    expect(out.id).toBe(SEL_ID);
    expect(out.id).toBe(out.selectionId);
  });

  it("--human produces a table (no JSON output call)", async () => {
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID, "--human"]);
    expect(mockJsonOutput).not.toHaveBeenCalled();
    expect(stdout).toMatch(/READY/);
    expect(stdout).toMatch(/BWI/);
  });

  it("AWAITING_INPUT when empty + no monitor; without --wait does not poll", async () => {
    mockGraphql.mockResolvedValueOnce(selectionResult({ blueprintMonitorId: null, options: [] }));
    await run([SEL_ID]);
    expect(lastJson().status).toBe("AWAITING_INPUT");
    // Only the selection read — no monitor read (no monitorId), no refresh (no --wait).
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it("--wait stops IMMEDIATELY on a terminal status (no refresh, no extra polls)", async () => {
    // READY is terminal: should read selection (+monitor) once and stop, never refresh.
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID, "--wait"]);
    expect(lastJson().status).toBe("READY");
    // selection + monitor reads only; no REFRESH mutation call.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("--wait polls through a refresh + one cycle, then resolves READY", async () => {
    // 1st read: FETCHING (monitor present, attempted, no options yet).
    // refresh mutation (Boolean). 2nd read after backoff sleep: READY.
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [] })) // selection #1
      .mockResolvedValueOnce(monitorResult({ fetchedAt: null, lastFetchAttempt: "2026-06-03T00:00:00Z" })) // monitor #1 -> FETCHING
      .mockResolvedValueOnce({ refreshTripPlanSelectionOptions: true }) // REFRESH
      .mockResolvedValueOnce(selectionResult({ options: [OPTION] })) // selection #2
      .mockResolvedValueOnce(monitorResult()); // monitor #2 -> READY
    await run([SEL_ID, "--wait", "--timeout", "10"]);
    const out = lastJson();
    expect(out.status).toBe("READY");
    expect(out.optionCount).toBe(1);
    // selection#1 + monitor#1 + refresh + selection#2 + monitor#2 = 5 calls.
    expect(mockGraphql).toHaveBeenCalledTimes(5);
  }, 15000);

  it("--human renders multiple option rows", async () => {
    const opt2 = { ...OPTION, id: "opt-2", name: "BWI \u2192 MCO direct", price: 412, sortOrder: 1 };
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION, opt2] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID, "--human"]);
    expect(mockJsonOutput).not.toHaveBeenCalled();
    expect(stdout).toMatch(/opt-1|BWI/);
    expect(stdout).toMatch(/412|direct/);
  });

  it("NOT_FOUND when getTripPlanSelection is null", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: null });
    await expect(run([SEL_ID])).rejects.toBeInstanceOf(CliError);
  });

  it("--timeout 0 clamps to 1s (does not silently revert to 30s) — terminal returns at once", async () => {
    // With a terminal READY status the loop never sleeps; we just assert the
    // command runs cleanly with --timeout 0 (clamp path exercised, no hang).
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID, "--wait", "--timeout", "0"]);
    expect(lastJson().status).toBe("READY");
  });

  it("READY + staleWarning when options exist but the latest refresh errored", async () => {
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION] }))
      .mockResolvedValueOnce(
        monitorResult({ fetchedAt: "2026-05-22T15:41:43Z", lastFetchAttempt: "2026-06-03T02:00:02Z", lastFetchError: "Request failed with status code 404" }),
      );
    await run([SEL_ID]);
    const out = lastJson();
    expect(out.status).toBe("READY");
    expect(out.staleWarning).toBe(true);
    expect(out.fetchError).toMatch(/404/);
  });

  // Forward-compat: the current monitor query (GET_SELECTION_WITH_MONITOR)
  // does not fetch optionData, so against today's server these options never
  // carry rankScore. The wiring lights up if/when the server exposes it on
  // the lean read — these specs pin that forward path, not current behavior.
  it("surfaces rankScore in JSON when the option payload carries it (forward-compat, VOY-1824)", async () => {
    const ranked = { ...OPTION, optionData: { rankScore: 0.71 } };
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [ranked] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID]);
    const out = lastJson();
    expect(out.options[0].rankScore).toBe(0.71);
    // Display-only: the internal breakdown is never surfaced.
    expect(JSON.stringify(out)).not.toContain("rankBreakdown");
  });

  it("omits rankScore when absent or non-finite (VOY-1824)", async () => {
    const bad = { ...OPTION, id: "opt-bad", optionData: { rankScore: NaN } };
    mockGraphql
      .mockResolvedValueOnce(selectionResult({ options: [OPTION, bad] }))
      .mockResolvedValueOnce(monitorResult());
    await run([SEL_ID]);
    const out = lastJson();
    expect(out.options[0]).not.toHaveProperty("rankScore");
    expect(out.options[1]).not.toHaveProperty("rankScore");
  });
});

// ── deriveChosen (participant-choice consensus, VOY-1692) ──────────────────

describe("deriveChosen", () => {
  const pick = (tid: string, oid: string | null, scope = "AllTravellers") => ({
    traveller: { id: tid, firstName: tid, lastName: "T" },
    selectedOption: oid ? { id: oid } : null,
    scope,
  });

  it("falls back to legacy parentOptionId when there are no choice entries", () => {
    expect(deriveChosen({ travellerOptionChoices: [], parentOptionId: "opt-legacy" }))
      .toEqual({ chosenOptionId: "opt-legacy", consensus: true });
    expect(deriveChosen({ travellerOptionChoices: null, parentOptionId: null }))
      .toEqual({ chosenOptionId: null, consensus: false });
  });

  it("consensus when every traveller picked the same option", () => {
    expect(deriveChosen({ travellerOptionChoices: [pick("t1", "opt-a"), pick("t2", "opt-a")], parentOptionId: null }))
      .toEqual({ chosenOptionId: "opt-a", consensus: true });
  });

  it("NO consensus when travellers picked different options", () => {
    expect(deriveChosen({ travellerOptionChoices: [pick("t1", "opt-a"), pick("t2", "opt-b")], parentOptionId: null }))
      .toEqual({ chosenOptionId: null, consensus: false });
  });

  it("NO consensus when some travellers have not picked yet (partial pick)", () => {
    expect(deriveChosen({ travellerOptionChoices: [pick("t1", "opt-a"), pick("t2", null)], parentOptionId: null }))
      .toEqual({ chosenOptionId: null, consensus: false });
  });

  it("does not fall back to parentOptionId when choice entries exist but diverge", () => {
    expect(deriveChosen({ travellerOptionChoices: [pick("t1", "opt-a"), pick("t2", null)], parentOptionId: "opt-stale" }))
      .toEqual({ chosenOptionId: null, consensus: false });
  });
});

// ── deriveBlockedOn (AWAITING_INPUT honesty, VOY-1703) ─────────────────────

describe("deriveBlockedOn", () => {
  let deriveBlockedOn: typeof import("./selection-options.js").deriveBlockedOn;
  beforeAll(async () => {
    ({ deriveBlockedOn } = await import("./selection-options.js"));
  });

  const input = (over: Partial<{ fieldName: string; fieldLabel: string | null; isRequired: boolean; value: unknown; sourceOutputId: string | null }> = {}) => ({
    id: "in-1",
    fieldName: over.fieldName ?? "departureDate",
    fieldLabel: over.fieldLabel === undefined ? "Departure date" : over.fieldLabel,
    isRequired: over.isRequired ?? true,
    value: over.value ?? null,
    sourceOutputId: over.sourceOutputId ?? null,
  });

  it("names required inputs with no value and no source binding", () => {
    expect(deriveBlockedOn({ inputs: [input()] })).toEqual([
      { fieldName: "departureDate", fieldLabel: "Departure date" },
    ]);
  });

  it("excludes inputs satisfied by a direct value", () => {
    expect(deriveBlockedOn({ inputs: [input({ value: "2026-09-15" })] })).toEqual([]);
  });

  it("excludes inputs satisfied by a source-output binding", () => {
    expect(deriveBlockedOn({ inputs: [input({ sourceOutputId: "out-9" })] })).toEqual([]);
  });

  it("excludes optional inputs and handles missing inputs array", () => {
    expect(deriveBlockedOn({ inputs: [input({ isRequired: false })] })).toEqual([]);
    expect(deriveBlockedOn({})).toEqual([]);
  });

  it("falls back to fieldName when there is no label", () => {
    expect(deriveBlockedOn({ inputs: [input({ fieldLabel: null })] })).toEqual([
      { fieldName: "departureDate", fieldLabel: null },
    ]);
  });
});

// ── VOY-1896: refresh-options (backs the refresh_options MCP tool) ───────────
describe("refresh-options", () => {
  async function runRefresh(args: string[]) {
    const program = new Command();
    program.exitOverride();
    registerSelectionOptionsCommands(program);
    await program.parseAsync(["node", "voyagier", "refresh-options", ...args]);
  }

  it("sends selectionId only (no force) by default and reports started", async () => {
    mockGraphql.mockResolvedValueOnce({ refreshTripPlanSelectionOptions: true });
    await runRefresh([SEL_ID, "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { selectionId: SEL_ID });
    expect(mockJsonOutput).toHaveBeenCalledWith({ ok: true, selectionId: SEL_ID, started: true });
  });

  it("forwards force:true only when --force is given", async () => {
    mockGraphql.mockResolvedValueOnce({ refreshTripPlanSelectionOptions: true });
    await runRefresh([SEL_ID, "--force", "--json"]);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { selectionId: SEL_ID, force: true });
  });

  it("reports started:false when the backend enqueues nothing", async () => {
    mockGraphql.mockResolvedValueOnce({ refreshTripPlanSelectionOptions: false });
    await runRefresh([SEL_ID, "--json"]);
    expect(mockJsonOutput).toHaveBeenCalledWith({ ok: true, selectionId: SEL_ID, started: false });
  });
});
