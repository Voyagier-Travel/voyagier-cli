import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});
const mockFatal = jest.fn().mockImplementation((msg: string) => {
  throw new CliError(CliErrorCode.VALIDATION, msg);
});

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
  fatal: mockFatal,
}));

// utils.validateDate is the real implementation; pass-through is fine.
// resolvePlanArg is NOT mocked — it lives in its own module
// (resolve-plan-arg.ts) precisely so suites that mock utils.js always
// exercise the real contract (string or throw INVALID_INPUT).
jest.unstable_mockModule("../utils.js", () => ({
  validateDate: jest.fn().mockImplementation((value: string, flagName: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `Invalid date for ${flagName}: ${value}`
      );
    }
  }),
  deriveBaseUrl: (api: string) => {
    try { const u = new URL(api); u.pathname = ""; return u.origin; } catch { return "https://travel.voyagier.com"; }
  },
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerItineraryCommand: (program: Command) => void;
let computeDayNumber: (eventDatetime: string | null | undefined, planStart: string | null | undefined) => number | null;
let extractEventType: (event: { metadata?: Record<string, unknown> | null }) => string | null;
let filterEvents: (
  events: unknown[],
  planStart: string | null | undefined,
  filters: { day?: number; from?: string; to?: string; type?: string }
) => unknown[];

beforeAll(async () => {
  const mod = await import("./itinerary.js");
  registerItineraryCommand = mod.registerItineraryCommand;
  computeDayNumber = mod.computeDayNumber;
  extractEventType = mod.extractEventType;
  filterEvents = mod.filterEvents as typeof filterEvents;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const planStart = "2026-09-15";
const planEnd = "2026-09-22";

const event1 = {
  name: "Flight DCA→CDG",
  datetime: "2026-09-15T18:30:00Z",
  localTime: "2026-09-15T14:30:00-04:00",
  duration: "PT7H30M",
  description: null,
  metadata: { type: "Flight" },
  location: { name: "DCA", address: null, placeId: null, metadata: null },
};

const event2 = {
  name: "Hotel check-in: Le Bristol",
  datetime: "2026-09-16T15:00:00Z",
  localTime: "2026-09-16T17:00:00+02:00",
  duration: null,
  description: null,
  metadata: { type: "Hotel" },
  location: { name: "Hotel Le Bristol", address: "112 Rue du Faubourg", placeId: "ChIJ...", metadata: null },
};

const event3 = {
  name: "Wine tasting tour",
  datetime: "2026-09-18T10:00:00Z",
  localTime: "2026-09-18T12:00:00+02:00",
  duration: "PT3H",
  description: "Bordeaux region",
  metadata: { type: "Activity" },
  location: { name: "Bordeaux", address: null, placeId: null, metadata: null },
};

const event4UnknownType = {
  name: "Mystery event",
  datetime: "2026-09-19T08:00:00Z",
  localTime: null,
  duration: null,
  description: null,
  metadata: {}, // no type
  location: null,
};

const allEvents = [event1, event2, event3, event4UnknownType];

const samplePlan = {
  id: "tp_01HX",
  title: "Paris → Bordeaux",
  startDate: planStart,
  endDate: planEnd,
  tripPlanEvents: allEvents,
};

// ── Helpers ────────────────────────────────────────────────────────────────

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerItineraryCommand(p);
  return p;
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  mockFatal.mockClear();
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ── Pure-function tests ────────────────────────────────────────────────────

describe("computeDayNumber", () => {
  it("returns 1 for an event on the plan start date", () => {
    expect(computeDayNumber("2026-09-15T18:30:00Z", planStart)).toBe(1);
  });

  it("returns 2 for an event the next day", () => {
    expect(computeDayNumber("2026-09-16T15:00:00Z", planStart)).toBe(2);
  });

  it("returns null when planStart is missing", () => {
    expect(computeDayNumber("2026-09-15T18:30:00Z", null)).toBeNull();
    expect(computeDayNumber("2026-09-15T18:30:00Z", undefined)).toBeNull();
  });

  it("returns null when eventDatetime is missing", () => {
    expect(computeDayNumber(null, planStart)).toBeNull();
    expect(computeDayNumber(undefined, planStart)).toBeNull();
  });

  it("returns null for unparseable dates", () => {
    expect(computeDayNumber("not-a-date", planStart)).toBeNull();
  });

  it("ignores intra-day time when computing day number", () => {
    // Both at start day, different hours
    expect(computeDayNumber("2026-09-15T01:00:00Z", planStart)).toBe(1);
    expect(computeDayNumber("2026-09-15T23:59:00Z", planStart)).toBe(1);
  });
});

describe("extractEventType", () => {
  it("reads `type` from metadata", () => {
    expect(extractEventType({ metadata: { type: "Flight" } })).toBe("Flight");
  });

  it("reads `eventType` as a fallback", () => {
    expect(extractEventType({ metadata: { eventType: "Hotel" } })).toBe("Hotel");
  });

  it("reads `selectionType` as a fallback", () => {
    expect(extractEventType({ metadata: { selectionType: "Activity" } })).toBe("Activity");
  });

  it("returns null when no recognized key is present", () => {
    expect(extractEventType({ metadata: { other: "foo" } })).toBeNull();
  });

  it("returns null when metadata is missing", () => {
    expect(extractEventType({})).toBeNull();
    expect(extractEventType({ metadata: null })).toBeNull();
  });

  it("returns null for non-string values", () => {
    expect(extractEventType({ metadata: { type: 42 } })).toBeNull();
  });
});

describe("filterEvents", () => {
  it("returns all events sorted by datetime when no filters applied", () => {
    const out = filterEvents(allEvents, planStart, {});
    expect(out).toHaveLength(4);
    expect((out[0] as typeof event1).name).toBe(event1.name);
    expect((out[3] as typeof event4UnknownType).name).toBe(event4UnknownType.name);
  });

  it("filters by --day", () => {
    const out = filterEvents(allEvents, planStart, { day: 2 });
    expect(out).toHaveLength(1);
    expect((out[0] as typeof event2).name).toBe(event2.name);
  });

  it("filters by --from inclusively", () => {
    const out = filterEvents(allEvents, planStart, { from: "2026-09-18" });
    expect(out).toHaveLength(2);
    expect((out[0] as typeof event3).name).toBe(event3.name);
  });

  it("filters by --to inclusively (end-of-day)", () => {
    const out = filterEvents(allEvents, planStart, { to: "2026-09-16" });
    expect(out).toHaveLength(2);
    expect((out[0] as typeof event1).name).toBe(event1.name);
    expect((out[1] as typeof event2).name).toBe(event2.name);
  });

  it("filters by --type case-insensitively", () => {
    const out = filterEvents(allEvents, planStart, { type: "hotel" });
    expect(out).toHaveLength(1);
    expect((out[0] as typeof event2).name).toBe(event2.name);
  });

  it("excludes events with no recognizable type when --type is set", () => {
    const out = filterEvents(allEvents, planStart, { type: "flight" });
    expect(out).toHaveLength(1);
    // event4UnknownType should be excluded
    expect(out.find((e) => (e as typeof event4UnknownType).name === event4UnknownType.name)).toBeUndefined();
  });

  it("combines --from and --to as a range", () => {
    const out = filterEvents(allEvents, planStart, { from: "2026-09-16", to: "2026-09-18" });
    expect(out).toHaveLength(2);
  });

  it("sorts events with missing datetimes deterministically (by name as tiebreaker)", () => {
    const evtA = { ...event1, name: "Zeta", datetime: null as unknown as string };
    const evtB = { ...event1, name: "Alpha", datetime: null as unknown as string };
    const evtC = { ...event1, name: "Beta", datetime: null as unknown as string };
    const out = filterEvents([evtA, evtB, evtC], planStart, {});
    // All-missing → alphabetical tiebreak
    expect((out[0] as typeof evtA).name).toBe("Alpha");
    expect((out[1] as typeof evtA).name).toBe("Beta");
    expect((out[2] as typeof evtA).name).toBe("Zeta");
  });

  it("sorts events with mixed missing+present datetimes (missing go to the end)", () => {
    const evtMissing = { ...event4UnknownType, name: "Floating", datetime: null as unknown as string };
    const out = filterEvents([evtMissing, event1, event2], planStart, {});
    expect((out[0] as typeof event1).name).toBe(event1.name);
    expect((out[1] as typeof event2).name).toBe(event2.name);
    expect((out[2] as typeof evtMissing).name).toBe("Floating");
  });

  it("treats unparseable datetime strings as missing (no NaN bubble-up)", () => {
    const evtBad = { ...event1, name: "Garbled", datetime: "not-a-date" };
    const out = filterEvents([evtBad, event1], planStart, {});
    expect((out[0] as typeof event1).name).toBe(event1.name);
    expect((out[1] as typeof evtBad).name).toBe("Garbled");
  });
});

// ── Command-level tests ────────────────────────────────────────────────────

describe("voyagier itinerary <planId>", () => {
  it("returns the full itinerary in --json mode with planContext", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: samplePlan });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { id: "tp_01HX" });
    expect(mockJsonOutput).toHaveBeenCalledTimes(1);
    const out = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { events: unknown[]; total: number; totalUnfiltered: number; dayRange: unknown };
      planContext: { planId: string; title: string; url: string };
    };
    expect(out.ok).toBe(true);
    expect(out.data.total).toBe(4);
    expect(out.data.totalUnfiltered).toBe(4);
    expect(out.planContext.planId).toBe("tp_01HX");
    expect(out.planContext.url).toContain("tp_01HX");
  });

  it("applies --day filter", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: samplePlan });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--day", "2", "--json"]);

    const out = mockJsonOutput.mock.calls[0][0] as {
      data: { events: { name: string }[]; total: number };
    };
    expect(out.data.total).toBe(1);
    expect(out.data.events[0].name).toBe(event2.name);
  });

  it("rejects non-numeric --day", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: samplePlan });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--day", "abc", "--json"])
    ).rejects.toThrow(/Invalid --day/);
  });

  it("rejects --day 0 and negative values", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: samplePlan });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--day", "0", "--json"])
    ).rejects.toThrow(/Invalid --day/);
  });

  it("validates --from and --to format", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--from", "not-a-date", "--json"])
    ).rejects.toThrow(/Invalid date for --from/);
  });

  it("applies --type filter", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: samplePlan });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--type", "Activity", "--json"]);

    const out = mockJsonOutput.mock.calls[0][0] as {
      data: { events: { name: string }[]; total: number };
    };
    expect(out.data.total).toBe(1);
    expect(out.data.events[0].name).toBe(event3.name);
  });

  it("throws NOT_FOUND when the plan doesn't exist", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "itinerary", "tp_BAD", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("handles plans with no events gracefully", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlan: { ...samplePlan, tripPlanEvents: [] },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--json"]);

    const out = mockJsonOutput.mock.calls[0][0] as {
      data: { total: number; totalUnfiltered: number; dayRange: unknown };
    };
    expect(out.data.total).toBe(0);
    expect(out.data.totalUnfiltered).toBe(0);
    expect(out.data.dayRange).toBeNull();
  });

  it("handles tripPlanEvents being null (server returned no field)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlan: { ...samplePlan, tripPlanEvents: null },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "itinerary", "tp_01HX", "--json"]);

    const out = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { total: number };
    };
    expect(out.ok).toBe(true);
    expect(out.data.total).toBe(0);
  });
});
