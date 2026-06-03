import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

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

beforeAll(async () => {
  const mod = await import("./selection-options.js");
  registerSelectionOptionsCommands = mod.registerSelectionOptionsCommands;
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
});
