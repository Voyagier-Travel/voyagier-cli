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

describe("listings recent", () => {
  it("fetches change events and outputs JSON", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanHotelSelection: sampleSelection })
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
      .mockResolvedValueOnce({ getTripPlanHotelSelection: sampleSelection })
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
      .mockResolvedValueOnce({ getTripPlanHotelSelection: sampleSelection })
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
    mockGraphql.mockResolvedValueOnce({ getTripPlanHotelSelection: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_MISSING", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("throws NO_MONITOR when selection has no blueprintMonitorId", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanHotelSelection: sampleSelectionNoMonitor });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "listings", "recent", "--selection", "sel_02HX", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NO_MONITOR });
  });

  it("handles empty events list", async () => {
    mockGraphql
      .mockResolvedValueOnce({ getTripPlanHotelSelection: sampleSelection })
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
      data: { option: sampleOption, selectionId: "sel_01HX" },
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
      .mockResolvedValueOnce({ getTripPlanHotelSelection: sampleSelection })
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
