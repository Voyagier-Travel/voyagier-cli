import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
  fatal: jest.fn().mockImplementation((msg: string) => {
    throw new CliError(CliErrorCode.VALIDATION, msg);
  }),
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerDestinationsCommands: (program: Command) => void;
let normalizeQuery: (raw: string) => string;
let formatDestinationContext: (d: Record<string, unknown>) => string | null;
let SEARCH_TRAVEL_DESTINATIONS: string;

beforeAll(async () => {
  const mod = await import("./destinations.js");
  registerDestinationsCommands = mod.registerDestinationsCommands;
  normalizeQuery = mod.normalizeQuery;
  formatDestinationContext = mod.formatDestinationContext as typeof formatDestinationContext;
  SEARCH_TRAVEL_DESTINATIONS = (await import("../queries.js")).SEARCH_TRAVEL_DESTINATIONS;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

// A City and a Country that share the name "Georgia" — the exact ambiguity the
// structured id exists to resolve.
const georgiaCountry = {
  id: "dst_ge",
  name: "Georgia",
  type: "Country",
  addressCountry: "GE",
  addressRegion: null,
  countries: null,
};

const georgiaState = {
  id: "dst_us_ga",
  name: "Georgia",
  type: "Region",
  addressCountry: "US",
  addressRegion: "Georgia",
  countries: null,
};

// A multi-country Area: no addressCountry, members listed in `countries`.
const dolomites = {
  id: "dst_dolomites",
  name: "The Dolomites",
  type: "Area",
  addressCountry: "",
  addressRegion: null,
  countries: ["IT", "AT"],
};

// ── Helpers ────────────────────────────────────────────────────────────────

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let logSpy: jest.SpiedFunction<(...args: unknown[]) => void>;

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerDestinationsCommands(p);
  return p;
}

/** Everything the command wrote to the TTY, joined. */
function consoleOutput(): string {
  return logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  stdoutSpy.mockRestore();
  logSpy.mockRestore();
});

// ── Pure helper tests ──────────────────────────────────────────────────────

describe("normalizeQuery", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeQuery("  the Dolomites  ")).toBe("the Dolomites");
  });

  it("rejects an empty or whitespace-only query", () => {
    expect(() => normalizeQuery("")).toThrow(/query is empty/);
    expect(() => normalizeQuery("   ")).toThrow(/query is empty/);
  });

  it("rejects a query longer than 200 characters (the API's own bound)", () => {
    expect(() => normalizeQuery("x".repeat(201))).toThrow(/maximum is 200/);
    expect(normalizeQuery("x".repeat(200))).toHaveLength(200);
  });

  it("measures length AFTER trimming, so padding alone never trips the bound", () => {
    expect(normalizeQuery(`  ${"x".repeat(200)}  `)).toHaveLength(200);
  });

  it("throws VALIDATION-coded CliErrors", () => {
    try {
      normalizeQuery("");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    }
  });
});

describe("formatDestinationContext", () => {
  it("prefers region, then country", () => {
    expect(formatDestinationContext(georgiaState)).toBe("Georgia, US");
    expect(formatDestinationContext(georgiaCountry)).toBe("GE");
  });

  it("falls back to the country list for a multi-country Area", () => {
    expect(formatDestinationContext(dolomites)).toBe("IT/AT");
  });

  it("returns null when there is no geographic context at all", () => {
    expect(formatDestinationContext({ id: "d", name: "Somewhere" })).toBeNull();
    expect(formatDestinationContext({ id: "d", name: "Somewhere", addressCountry: "", countries: [] })).toBeNull();
  });
});

// ── Command tests ──────────────────────────────────────────────────────────

describe("destinations search", () => {
  it("sends the query under the input wrapper the API expects", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [georgiaCountry] });
    await buildProgram().parseAsync(["destinations", "search", "Georgia", "--json"], { from: "user" });

    expect(mockGraphql).toHaveBeenCalledWith(SEARCH_TRAVEL_DESTINATIONS, { input: { query: "Georgia" } });
  });

  it("sends the TRIMMED query, not the raw argument", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [] });
    await buildProgram().parseAsync(["destinations", "search", "  Georgia  ", "--json"], { from: "user" });

    expect(mockGraphql).toHaveBeenCalledWith(SEARCH_TRAVEL_DESTINATIONS, { input: { query: "Georgia" } });
  });

  it("emits the candidates verbatim in the canonical Style A envelope", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [georgiaCountry, georgiaState] });
    await buildProgram().parseAsync(["destinations", "search", "Georgia", "--json"], { from: "user" });

    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: {
        destinations: [georgiaCountry, georgiaState],
        total: 2,
        query: "Georgia",
      },
    });
  });

  it("preserves server ranking order (the CLI never re-sorts candidates)", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [georgiaState, georgiaCountry] });
    await buildProgram().parseAsync(["destinations", "search", "Georgia", "--json"], { from: "user" });

    const payload = mockJsonOutput.mock.calls[0][0] as { data: { destinations: Array<{ id: string }> } };
    expect(payload.data.destinations.map((d) => d.id)).toEqual(["dst_us_ga", "dst_ge"]);
  });

  it("treats zero candidates as a normal empty result, not an error", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [] });
    await expect(
      buildProgram().parseAsync(["destinations", "search", "not a place", "--json"], { from: "user" }),
    ).resolves.toBeDefined();

    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { destinations: [], total: 0, query: "not a place" },
    });
  });

  it("degrades a null result set to an empty array", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: null });
    await buildProgram().parseAsync(["destinations", "search", "nowhere", "--json"], { from: "user" });

    const payload = mockJsonOutput.mock.calls[0][0] as { data: { destinations: unknown[]; total: number } };
    expect(payload.data.destinations).toEqual([]);
    expect(payload.data.total).toBe(0);
  });

  it("rejects an empty query before making any API call", async () => {
    await expect(
      buildProgram().parseAsync(["destinations", "search", "   ", "--json"], { from: "user" }),
    ).rejects.toThrow(/query is empty/);

    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("renders each candidate with name, type, context and id on the TTY", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [georgiaCountry, georgiaState] });
    await buildProgram().parseAsync(["destinations", "search", "Georgia"], { from: "user" });

    const out = consoleOutput();
    expect(out).toContain("[Country]");
    expect(out).toContain("[Region]");
    expect(out).toContain("Georgia, US");
    expect(out).toContain("dst_ge");
    expect(out).toContain("dst_us_ga");
    expect(out).toContain("2 candidates");
    // The point of the command: hand the id to plan-trip.
    expect(out).toContain("plan-trip --destination-id");
    expect(mockJsonOutput).not.toHaveBeenCalled();
  });

  it("says so plainly when nothing matched on the TTY", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [] });
    await buildProgram().parseAsync(["destinations", "search", "not a place"], { from: "user" });

    expect(consoleOutput()).toContain("No destinations matched.");
  });

  it("singularises the candidate count", async () => {
    mockGraphql.mockResolvedValue({ searchTravelDestinations: [dolomites] });
    await buildProgram().parseAsync(["destinations", "search", "the Dolomites"], { from: "user" });

    expect(consoleOutput()).toContain("1 candidate ·");
  });

  it("propagates API failures instead of swallowing them", async () => {
    mockGraphql.mockRejectedValue(new CliError(CliErrorCode.API_ERROR, "boom"));
    await expect(
      buildProgram().parseAsync(["destinations", "search", "Georgia", "--json"], { from: "user" }),
    ).rejects.toThrow("boom");
  });
});
