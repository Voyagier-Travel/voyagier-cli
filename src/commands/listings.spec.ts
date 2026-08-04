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

let registerListingsCommands: (program: Command) => void;
let normalizeListingChangeType: (value: string) => string;

beforeAll(async () => {
  const mod = await import("./listings.js");
  registerListingsCommands = mod.registerListingsCommands;
  normalizeListingChangeType = mod.normalizeListingChangeType;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const sampleSelection = {
  id: "sel_01HX",
  blueprintMonitorId: "mon_01HX",
};

const sampleSelectionNoMonitor = {
  id: "sel_02HX",
  blueprintMonitorId: null,
};

const sampleChangeEvent = {
  id: "evt_01HX",
  blueprintListingId: "lst_01HX",
  blueprintMonitorId: "mon_01HX",
  listingName: "Hotel Le Bristol",
  changeType: "PriceChanged",
  details: { oldPrice: 500, newPrice: 450 },
  blueprintListing: {
    id: "lst_01HX",
    name: "Hotel Le Bristol",
    price: 450,
    isAvailable: true,
    isBookable: true,
  },
};

const sampleOption = {
  id: "opt_01HX",
  name: "Hotel Le Bristol — King Suite",
  price: 1840.0,
  isBookable: true,
  status: "Active",
};

// ── Helpers ────────────────────────────────────────────────────────────────

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerListingsCommands(p);
  return p;
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("normalizeListingChangeType", () => {
  it("converts kebab-case to PascalCase", () => {
    expect(normalizeListingChangeType("availability-changed")).toBe("AvailabilityChanged");
    expect(normalizeListingChangeType("new-listing")).toBe("NewListing");
    expect(normalizeListingChangeType("price-changed")).toBe("PriceChanged");
    expect(normalizeListingChangeType("listing-expired")).toBe("ListingExpired");
    expect(normalizeListingChangeType("listing-restored")).toBe("ListingRestored");
    expect(normalizeListingChangeType("listing-unavailable")).toBe("ListingUnavailable");
  });

  it("accepts PascalCase input unchanged", () => {
    expect(normalizeListingChangeType("PriceChanged")).toBe("PriceChanged");
    expect(normalizeListingChangeType("NewListing")).toBe("NewListing");
  });

  it("handles uppercase input", () => {
    expect(normalizeListingChangeType("PRICE-CHANGED")).toBe("PriceChanged");
  });

  it("throws on invalid values", () => {
    expect(() => normalizeListingChangeType("invalid")).toThrow(/Invalid --type/);
    expect(() => normalizeListingChangeType("foo-bar")).toThrow(/Invalid --type/);
  });
});

describe("listings list (VOY-1835)", () => {
  const sampleMonitorListings = {
    id: "mon_01HX",
    totalAvailableListings: 42,
    listings: [
      {
        id: "lst_01HX", name: "Hotel Le Bristol", price: 450, sortOrder: 1,
        isBookable: true, isAvailable: true,
        optionData: { rating: 4.8, hugeProviderBlob: { deeply: "nested" } },
      },
      {
        id: "lst_02HX", name: "Hotel Lutetia", price: 610, sortOrder: 2,
        isBookable: null, isAvailable: false,
        optionData: null,
      },
    ],
  };

  it("outputs compact JSON rows with rating extracted and raw optionData discarded", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintMonitor: sampleMonitorListings });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "listings", "list", "--selection", "sel_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockGraphql).toHaveBeenNthCalledWith(2,
      expect.stringContaining("totalAvailableListings"),
      { id: "mon_01HX" }
    );
    const payload = mockJsonOutput.mock.calls[0][0] as {
      ok: boolean;
      data: { selectionId: string; monitorId: string; totalAvailable: number; shown: number; listings: Array<Record<string, unknown>> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.selectionId).toBe("sel_01HX");
    expect(payload.data.monitorId).toBe("mon_01HX");
    expect(payload.data.totalAvailable).toBe(42);
    expect(payload.data.shown).toBe(2);
    expect(payload.data.listings[0]).toEqual({
      id: "lst_01HX", name: "Hotel Le Bristol", price: 450, rating: 4.8,
      sortOrder: 1, isBookable: true, isAvailable: true,
    });
    expect(payload.data.listings[1].rating).toBeNull();
    // Payload discipline: raw provider data never reaches output.
    expect(JSON.stringify(payload)).not.toContain("hugeProviderBlob");
    expect(JSON.stringify(payload)).not.toContain("optionData");
  });

  it("applies --limit client-side", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintMonitor: sampleMonitorListings });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "listings", "list", "--selection", "sel_01HX", "--limit", "1", "--json"]);

    const payload = mockJsonOutput.mock.calls[0][0] as { data: { shown: number; listings: unknown[]; totalAvailable: number } };
    expect(payload.data.shown).toBe(1);
    expect(payload.data.listings).toHaveLength(1);
    expect(payload.data.totalAvailable).toBe(42);
  });

  it("emits an agent markdown table with a promote hint", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintMonitor: sampleMonitorListings });
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const p = buildProgram();
      await p.parseAsync(["node", "test", "listings", "list", "--selection", "sel_01HX", "--agent"]);
    } finally {
      logSpy.mockRestore();
    }
    const out = logs.join("\n");
    expect(out).toContain("## Available Listings");
    expect(out).toContain("2 of 42 available");
    expect(out).toContain("Hotel Le Bristol");
    expect(out).toContain("⭐4.8");
    expect(out).toContain("listings add-to-selection");
  });

  it("throws NOT_FOUND when the selection doesn't exist", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: null });
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "list", "--selection", "sel_MISSING", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("throws NO_MONITOR when the selection has no blueprintMonitorId", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: sampleSelectionNoMonitor });
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "list", "--selection", "sel_02HX", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NO_MONITOR });
  });
});

describe("listings recent", () => {
  it("fetches change events and outputs JSON", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [sampleChangeEvent] });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: {
        events: [sampleChangeEvent],
        total: 1,
        monitorId: "mon_01HX",
        selectionId: "sel_01HX",
      },
    });
  });

  it("filters by --type and normalizes to PascalCase", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintListingChangeEventsByType: [sampleChangeEvent] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--type", "price-changed",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("blueprintListingChangeEventsByType"),
      expect.objectContaining({ changeType: "PriceChanged" })
    );
  });

  it("respects --limit flag", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--limit", "5",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 5 })
    );
  });

  it("throws NOT_FOUND when selection doesn't exist", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_MISSING", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("throws NO_MONITOR when selection has no blueprintMonitorId", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanSelection: sampleSelectionNoMonitor });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_02HX", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NO_MONITOR });
  });

  it("handles empty events list", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [] });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_01HX", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ events: [], total: 0 }),
      })
    );
  });
});

describe("listings add-to-selection", () => {
  it("adds listing and returns option in JSON", async () => {
    mockGraphql.mockResolvedValueOnce({
      addBlueprintListingAsSelectionOption: sampleOption,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "add-to-selection", "sel_01HX",
      "--listing", "lst_01HX",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { listingId: "lst_01HX", selectionId: "sel_01HX" },
      { dryRun: undefined }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { option: sampleOption, selectionId: "sel_01HX", idempotencyKey: null },
    });
  });

  it("throws LISTING_NOT_FOUND when mutation returns null", async () => {
    mockGraphql.mockResolvedValueOnce({
      addBlueprintListingAsSelectionOption: null,
    });

    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "listings", "add-to-selection", "sel_01HX",
        "--listing", "lst_MISSING",
        "--json",
      ])
    ).rejects.toMatchObject({ code: CliErrorCode.LISTING_NOT_FOUND });
  });

  it("requires --listing flag", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "add-to-selection", "sel_01HX", "--json"])
    ).rejects.toThrow();
  });
});

describe("listings --agent output", () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("outputs markdown for recent command", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [sampleChangeEvent] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--agent",
    ]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("## Listing Change Events");
    expect(output).toContain("PriceChanged");
  });

  it("outputs markdown for add-to-selection command", async () => {
    mockGraphql.mockResolvedValueOnce({
      addBlueprintListingAsSelectionOption: sampleOption,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "add-to-selection", "sel_01HX",
      "--listing", "lst_01HX",
      "--agent",
    ]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("## Listing Added");
    expect(output).toContain("opt_01HX");
  });
});

// ── Group A: Strict numeric validation ────────────────────────────────────

describe("listings recent — strict --limit validation", () => {
  it("throws VALIDATION error for invalid --limit", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_01HX", "--limit", "abc", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("throws VALIDATION error for negative --limit", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_01HX", "--limit", "-5", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("accepts valid --limit values", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanSelection: sampleSelection })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--limit", "50",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 50 })
    );
  });
});

// ── Group C: Echo --idempotency-key in JSON output ────────────────────────

describe("listings add-to-selection — idempotency-key echo", () => {
  it("echoes --idempotency-key in JSON output when provided", async () => {
    mockGraphql.mockResolvedValueOnce({
      addBlueprintListingAsSelectionOption: sampleOption,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "add-to-selection", "sel_01HX",
      "--listing", "lst_01HX",
      "--idempotency-key", "01HXYZ999ZZZ",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: "01HXYZ999ZZZ" }),
      })
    );
  });

  it("echoes null for idempotencyKey when not provided", async () => {
    mockGraphql.mockResolvedValueOnce({
      addBlueprintListingAsSelectionOption: sampleOption,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "add-to-selection", "sel_01HX",
      "--listing", "lst_01HX",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: null }),
      })
    );
  });
});

// ── Regression: Copilot review (second pass) ──────────────────────────────
//
// Copilot caught three classes of issue:
//   1. Prices using string interpolation lost thousand-separators / decimals.
//   2. Nullable booleans (isAvailable, isBookable) were rendered as "No"
//      when null/undefined, conflating absence with negative.
//   3. --idempotency-key help text claimed it was "for the mutation" but the
//      key was never sent server-side; only echoed in JSON.

describe("listings recent — formatPrice consistency", () => {
  const sampleEventWithPrice = {
    id: "evt_01HX",
    blueprintListingId: "lst_01HX",
    blueprintMonitorId: "mon_01HX",
    listingName: "Hotel Le Bristol",
    changeType: "PriceChanged",
    details: null,
    blueprintListing: {
      id: "lst_01HX",
      name: "Hotel Le Bristol",
      price: 1840.0,
      isAvailable: true,
      isBookable: true,
    },
  };

  it("renders prices with thousand-separators in --agent markdown table", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        getTripPlanSelection: { id: "sel_01HX", blueprintMonitorId: "mon_01HX" },
      })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [sampleEventWithPrice] });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("$1,840.00");
    // The bare interpolation pattern would emit something like "$1840 |".
    // Our formatPrice() always adds .00. Make sure we never see the raw form.
    expect(allOut).not.toMatch(/\$1840[^.]/);

    logSpy.mockRestore();
  });
});

describe("listings — nullable boolean rendering", () => {
  const eventWithNullAvailable = {
    id: "evt_01HX",
    blueprintListingId: "lst_01HX",
    blueprintMonitorId: "mon_01HX",
    listingName: "Hotel Mystery",
    changeType: "NewListing",
    details: null,
    blueprintListing: {
      id: "lst_01HX",
      name: "Hotel Mystery",
      price: 200,
      isAvailable: null,
      isBookable: null,
    },
  };

  it("renders null isAvailable as 'Unknown' (not 'No') in agent markdown", async () => {
    mockGraphql
      .mockResolvedValueOnce({
        getTripPlanSelection: { id: "sel_01HX", blueprintMonitorId: "mon_01HX" },
      })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [eventWithNullAvailable] });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("Unknown");
    // The agent-markdown table cell for availability must NOT be the literal "No"
    // when isAvailable is null. Look at the table row specifically.
    const tableRow = allOut.split("\n").find((l) => l.includes("Hotel Mystery")) ?? "";
    expect(tableRow).toContain("Unknown");
    expect(tableRow).not.toMatch(/\| No \|/);

    logSpy.mockRestore();
  });

  it("renders null isBookable as 'Unknown' in add-to-selection agent output", async () => {
    mockGraphql.mockResolvedValueOnce({
      addBlueprintListingAsSelectionOption: {
        id: "opt_01HX",
        name: "Mystery Option",
        price: 500,
        isBookable: null,
      },
    });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "add-to-selection", "sel_01HX",
      "--listing", "lst_01HX",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toMatch(/Bookable:\*?\*?\s*Unknown/);
    expect(allOut).not.toMatch(/Bookable:\*?\*?\s*No\b/);

    logSpy.mockRestore();
  });
});

describe("listings — --idempotency-key help text", () => {
  it("documents the flag as JSON-echo, not server-side dedup", () => {
    const p = buildProgram();
    const help = p.commands
      .find((c) => c.name() === "listings")!
      .commands.find((c) => c.name() === "add-to-selection")!
      .helpInformation();

    expect(help).toContain("--idempotency-key");
    expect(help).toContain("Echoed in JSON output");
    expect(help).not.toContain("for the mutation");
  });
});

// ── Regression: Copilot review (third pass) ──────────────────────────────

describe("listings recent — markdown table escaping (--agent)", () => {
  it("escapes pipe/backtick characters in listingName", async () => {
    const evilEvent = {
      id: "evt_evil",
      blueprintListingId: "lst_evil",
      blueprintMonitorId: "mon_01HX",
      listingName: "Hotel | Wreckage `cafe`",
      changeType: "PriceChanged",
      details: null,
      blueprintListing: {
        id: "lst_evil",
        name: "Hotel | Wreckage `cafe`",
        price: 200,
        isAvailable: true,
        isBookable: true,
      },
    };

    mockGraphql
      .mockResolvedValueOnce({
        getTripPlanSelection: { id: "sel_01HX", blueprintMonitorId: "mon_01HX" },
      })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [evilEvent] });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("Hotel \\| Wreckage \\`cafe\\`");

    logSpy.mockRestore();
  });

  it("falls back to blueprintListing.name when listingName is null in --agent table", async () => {
    const eventNoListingName = {
      id: "evt_fallback",
      blueprintListingId: "lst_fallback",
      blueprintMonitorId: "mon_01HX",
      listingName: null,
      changeType: "NewListing",
      details: null,
      blueprintListing: {
        id: "lst_fallback",
        name: "Real Hotel Name",
        price: 100,
        isAvailable: true,
        isBookable: true,
      },
    };

    mockGraphql
      .mockResolvedValueOnce({
        getTripPlanSelection: { id: "sel_01HX", blueprintMonitorId: "mon_01HX" },
      })
      .mockResolvedValueOnce({ blueprintListingChangeEvents: [eventNoListingName] });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "listings", "recent",
      "--selection", "sel_01HX",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    // Must show the fallback name, not the em-dash placeholder.
    expect(allOut).toContain("Real Hotel Name");
    const tableRow = allOut.split("\n").find((l) => l.includes("NewListing")) ?? "";
    expect(tableRow).not.toMatch(/\|\s+—\s+\|/); // no bare em-dash where name should be
    expect(tableRow).toContain("Real Hotel Name");

    logSpy.mockRestore();
  });
});

describe("listings — --agent help text consistency", () => {
  it("uses the canonical help wording 'Output plain markdown for AI agents'", () => {
    const p = buildProgram();
    const recentHelp = p.commands
      .find((c) => c.name() === "listings")!
      .commands.find((c) => c.name() === "recent")!
      .helpInformation();
    const addHelp = p.commands
      .find((c) => c.name() === "listings")!
      .commands.find((c) => c.name() === "add-to-selection")!
      .helpInformation();

    expect(recentHelp).toContain("Output plain markdown for AI agents");
    expect(addHelp).toContain("Output plain markdown for AI agents");
    expect(recentHelp).not.toContain("Output markdown for AI display");
    expect(addHelp).not.toContain("Output markdown for AI display");
  });
});
