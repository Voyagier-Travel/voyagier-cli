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

let registerPlacesCommands: (program: Command) => void;
let normalizeHighlightCategory: (value: string) => string;
let normalizePlaceType: (value: string) => string;
let parseSearchLocation: (opts: { lat?: string; lng?: string; radius?: string }) => { latitude?: number; longitude?: number; radius?: number } | undefined;

beforeAll(async () => {
  const mod = await import("./places.js");
  registerPlacesCommands = mod.registerPlacesCommands;
  normalizeHighlightCategory = mod.normalizeHighlightCategory;
  normalizePlaceType = mod.normalizePlaceType;
  parseSearchLocation = mod.parseSearchLocation;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const sampleSearchPlace = {
  id: "place_01HX",
  name: "Eiffel Tower",
  description: "Iconic iron lattice tower",
  location: { latitude: 48.8584, longitude: 2.2945 },
  address: { city: "Paris", country: "France" },
  country: { id: "FR", name: "France" },
  locality: { id: "paris", name: "Paris" },
};

const sampleTripPlanPlace = {
  id: "tpp_01HX",
  name: "Hotel Le Bristol",
  placeId: "place_02HX",
  tripPlanId: "plan_01HX",
  type: "Hotel",
  types: ["lodging", "establishment"],
  countryId: "FR",
  countryName: "France",
  description: "Luxury hotel",
  iataCode: null,
  image: "https://example.com/hotel.jpg",
  url: "https://lebristolparis.com",
  placeTimezone: "Europe/Paris",
  location: { latitude: 48.8706, longitude: 2.3161 },
};

const sampleHighlightedPlace = {
  id: "hp_01HX",
  ranking: 1,
  category: "Hotel",
  detectedPlace: {
    id: "dp_01HX",
    name: "Hotel Le Bristol",
    placeId: "place_02HX",
    location: { latitude: 48.8706, longitude: 2.3161 },
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerPlacesCommands(p);
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

// ── Pure helper tests ──────────────────────────────────────────────────────

describe("normalizeHighlightCategory", () => {
  it("converts lowercase to PascalCase", () => {
    expect(normalizeHighlightCategory("attraction")).toBe("Attraction");
    expect(normalizeHighlightCategory("hotel")).toBe("Hotel");
    expect(normalizeHighlightCategory("restaurant")).toBe("Restaurant");
  });

  it("accepts PascalCase input unchanged", () => {
    expect(normalizeHighlightCategory("Attraction")).toBe("Attraction");
    expect(normalizeHighlightCategory("Hotel")).toBe("Hotel");
  });

  it("handles mixed case input", () => {
    expect(normalizeHighlightCategory("HOTEL")).toBe("Hotel");
    expect(normalizeHighlightCategory("AtTrAcTiOn")).toBe("Attraction");
  });

  it("throws on invalid values", () => {
    expect(() => normalizeHighlightCategory("invalid")).toThrow(/Invalid --category/);
    expect(() => normalizeHighlightCategory("bar")).toThrow(/Invalid --category/);
  });
});

describe("normalizePlaceType", () => {
  it("converts lowercase words to PascalCase", () => {
    expect(normalizePlaceType("hotel")).toBe("Hotel");
    expect(normalizePlaceType("restaurant")).toBe("Restaurant");
    expect(normalizePlaceType("city")).toBe("City");
  });

  it("handles multi-word types", () => {
    expect(normalizePlaceType("tourist attraction")).toBe("TouristAttraction");
    expect(normalizePlaceType("train_station")).toBe("TrainStation");
    expect(normalizePlaceType("car-rental")).toBe("CarRental");
  });

  it("handles already PascalCase input", () => {
    expect(normalizePlaceType("Airport")).toBe("Airport");
  });

  // Regression: Copilot review caught that already-PascalCase multi-word
  // values like "TouristAttraction" were being mangled to "Touristattraction"
  // by the previous lowercase-then-capitalize implementation.
  it("preserves already-PascalCase multi-word values verbatim", () => {
    expect(normalizePlaceType("TouristAttraction")).toBe("TouristAttraction");
    expect(normalizePlaceType("TrainStation")).toBe("TrainStation");
    expect(normalizePlaceType("CafeOrCoffeeShop")).toBe("CafeOrCoffeeShop");
    expect(normalizePlaceType("BedAndBreakfast")).toBe("BedAndBreakfast");
  });

  it("normalizes mixed-case inputs that aren't already PascalCase", () => {
    // Has a separator — not the no-op path.
    expect(normalizePlaceType("tourist Attraction")).toBe("TouristAttraction");
  });

  it("strips empty segments from separator runs", () => {
    expect(normalizePlaceType("hotel--bar")).toBe("HotelBar");
    expect(normalizePlaceType("  hotel  bar  ")).toBe("HotelBar");
  });
});

describe("parseSearchLocation", () => {
  it("returns undefined when no location opts provided", () => {
    expect(parseSearchLocation({})).toBeUndefined();
  });

  it("parses lat/lng/radius into SearchLocationInput", () => {
    expect(parseSearchLocation({ lat: "48.8584", lng: "2.2945", radius: "1000" })).toEqual({
      latitude: 48.8584,
      longitude: 2.2945,
      radius: 1000,
    });
  });

  it("handles partial location opts", () => {
    expect(parseSearchLocation({ lat: "48.8584" })).toEqual({ latitude: 48.8584 });
    expect(parseSearchLocation({ lng: "2.2945" })).toEqual({ longitude: 2.2945 });
    expect(parseSearchLocation({ radius: "1000" })).toEqual({ radius: 1000 });
  });

  it("throws VALIDATION error for invalid numeric values", () => {
    expect(() => parseSearchLocation({ lat: "invalid" })).toThrow(/Invalid --lat/);
    expect(() => parseSearchLocation({ lng: "abc" })).toThrow(/Invalid --lng/);
    expect(() => parseSearchLocation({ radius: "xyz" })).toThrow(/Invalid --radius/);
  });

  // Regression: Copilot review caught that out-of-range coordinates were
  // being passed through to the API. Latitude must be in [-90, 90],
  // longitude in [-180, 180], radius >= 0.
  it("rejects latitude outside [-90, 90]", () => {
    expect(() => parseSearchLocation({ lat: "100" })).toThrow(/--lat/);
    expect(() => parseSearchLocation({ lat: "-91" })).toThrow(/--lat/);
  });

  it("accepts latitude at the boundary", () => {
    expect(parseSearchLocation({ lat: "90" })).toEqual({ latitude: 90 });
    expect(parseSearchLocation({ lat: "-90" })).toEqual({ latitude: -90 });
  });

  it("rejects longitude outside [-180, 180]", () => {
    expect(() => parseSearchLocation({ lng: "200" })).toThrow(/--lng/);
    expect(() => parseSearchLocation({ lng: "-500" })).toThrow(/--lng/);
  });

  it("accepts longitude at the boundary", () => {
    expect(parseSearchLocation({ lng: "180" })).toEqual({ longitude: 180 });
    expect(parseSearchLocation({ lng: "-180" })).toEqual({ longitude: -180 });
  });

  it("rejects negative radius", () => {
    expect(() => parseSearchLocation({ radius: "-500" })).toThrow(/--radius/);
  });

  it("accepts zero radius", () => {
    expect(parseSearchLocation({ radius: "0" })).toEqual({ radius: 0 });
  });
});

// ── places search ──────────────────────────────────────────────────────────

describe("places search", () => {
  it("uses searchPlaces by default (internal source)", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [sampleSearchPlace], count: 1, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "search", "--query", "Eiffel", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchPlaces"),
      expect.objectContaining({ query: "Eiffel" })
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { places: [sampleSearchPlace], total: 1, source: "internal" },
    });
  });

  it("uses searchExternalPlaces with --source google", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchExternalPlaces: [sampleSearchPlace],
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "Eiffel",
      "--source", "google",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchExternalPlaces"),
      expect.objectContaining({ query: "Eiffel" })
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { places: [sampleSearchPlace], total: 1, source: "google" },
    });
  });

  it("passes location opts to internal search", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "coffee",
      "--lat", "48.8584",
      "--lng", "2.2945",
      "--radius", "500",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        location: { latitude: 48.8584, longitude: 2.2945, radius: 500 },
      })
    );
  });

  it("passes location opts to google search", async () => {
    mockGraphql.mockResolvedValueOnce({ searchExternalPlaces: [] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "coffee",
      "--source", "google",
      "--lat", "48.8584",
      "--lng", "2.2945",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        location: expect.objectContaining({ latitude: 48.8584, longitude: 2.2945 }),
      })
    );
  });

  it("passes --type and pagination to internal search", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 2, limit: 10 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "hotel",
      "--type", "Hotel",
      "--limit", "10",
      "--page", "2",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "Hotel", limit: 10, page: 2 })
    );
  });

  it("handles empty results", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "search", "--query", "nonexistent", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { places: [], total: 0, source: "internal" },
      })
    );
  });
});

// ── places get ─────────────────────────────────────────────────────────────

describe("places get", () => {
  it("uses getPlaceById by default", async () => {
    mockGraphql.mockResolvedValueOnce({ getPlaceById: sampleSearchPlace });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "get", "place_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("getPlaceById"),
      { id: "place_01HX" }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { place: sampleSearchPlace },
    });
  });

  it("uses getPlaceByExternalId with --external", async () => {
    mockGraphql.mockResolvedValueOnce({ getPlaceByExternalId: sampleSearchPlace });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "get", "ChIJLU7jZClu5kcR4PcOOO6p3I0", "--external", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("getPlaceByExternalId"),
      { externalId: "ChIJLU7jZClu5kcR4PcOOO6p3I0" }
    );
  });

  it("throws PLACE_NOT_FOUND when place doesn't exist", async () => {
    mockGraphql.mockResolvedValueOnce({ getPlaceById: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "get", "place_MISSING", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.PLACE_NOT_FOUND });
  });
});

// ── places attach ──────────────────────────────────────────────────────────

describe("places attach", () => {
  it("creates trip plan place with required fields", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertTripPlanPlace: sampleTripPlanPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "Hotel Le Bristol",
      "--place-id", "place_02HX",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      {
        input: {
          tripPlanId: "plan_01HX",
          name: "Hotel Le Bristol",
          placeId: "place_02HX",
        },
      },
      { dryRun: undefined }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { place: sampleTripPlanPlace, idempotencyKey: null },
      planContext: { planId: "plan_01HX" },
    });
  });

  it("includes optional fields when provided", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertTripPlanPlace: sampleTripPlanPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "Hotel Le Bristol",
      "--place-id", "place_02HX",
      "--type", "hotel",
      "--country-id", "FR",
      "--country-name", "France",
      "--description", "Luxury hotel",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      {
        input: expect.objectContaining({
          type: "Hotel",
          countryId: "FR",
          countryName: "France",
          description: "Luxury hotel",
        }),
      },
      { dryRun: undefined }
    );
  });

  it("normalizes --type to PascalCase", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertTripPlanPlace: sampleTripPlanPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "CDG Airport",
      "--place-id", "place_03HX",
      "--type", "airport",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      {
        input: expect.objectContaining({ type: "Airport" }),
      },
      { dryRun: undefined }
    );
  });

  it("requires --plan, --name, and --place-id", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "attach", "--plan", "plan_01HX", "--json"])
    ).rejects.toThrow();
  });
});

// ── places list ────────────────────────────────────────────────────────────

describe("places list", () => {
  it("lists trip plan places by default", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanPlaces: [sampleTripPlanPlace] });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "list", "--plan", "plan_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("getTripPlanPlaces"),
      { tripPlanId: "plan_01HX" }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { places: [sampleTripPlanPlace], total: 1 },
      planContext: { planId: "plan_01HX" },
    });
  });

  it("lists highlighted places with --highlighted --category", async () => {
    mockGraphql.mockResolvedValueOnce({ highlightedTripPlaces: [sampleHighlightedPlace] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "list",
      "--plan", "plan_01HX",
      "--highlighted",
      "--category", "hotel",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("highlightedTripPlaces"),
      { tripId: "plan_01HX", category: "Hotel" }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { highlighted: [sampleHighlightedPlace], total: 1, category: "Hotel" },
      planContext: { planId: "plan_01HX" },
    });
  });

  it("throws VALIDATION when --highlighted used without --category", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "list", "--plan", "plan_01HX", "--highlighted", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("requires --plan flag", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "list", "--json"])
    ).rejects.toThrow();
  });
});

// ── places highlight ───────────────────────────────────────────────────────

describe("places highlight", () => {
  it("highlights a place with required fields", async () => {
    mockGraphql.mockResolvedValueOnce({ highlightTripPlace: sampleHighlightedPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "highlight",
      "--plan", "plan_01HX",
      "--place", "dp_01HX",
      "--category", "hotel",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      {
        tripId: "plan_01HX",
        detectedPlaceId: "dp_01HX",
        category: "Hotel",
        ranking: null,
      },
      { dryRun: undefined }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { highlighted: sampleHighlightedPlace, idempotencyKey: null },
      planContext: { planId: "plan_01HX" },
    });
  });

  it("includes --ranking when provided", async () => {
    mockGraphql.mockResolvedValueOnce({ highlightTripPlace: { ...sampleHighlightedPlace, ranking: 3 } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "highlight",
      "--plan", "plan_01HX",
      "--place", "dp_01HX",
      "--category", "attraction",
      "--ranking", "3",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ ranking: 3 }),
      { dryRun: undefined }
    );
  });

  it("requires --category flag", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "places", "highlight",
        "--plan", "plan_01HX",
        "--place", "dp_01HX",
        "--json",
      ])
    ).rejects.toThrow();
  });
});

// ── places unhighlight ─────────────────────────────────────────────────────

describe("places unhighlight", () => {
  it("removes highlight from a place", async () => {
    mockGraphql.mockResolvedValueOnce({ unhighlightTripPlace: true });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "unhighlight",
      "--plan", "plan_01HX",
      "--place", "dp_01HX",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { tripId: "plan_01HX", detectedPlaceId: "dp_01HX" },
      { dryRun: undefined }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { removed: true, placeId: "dp_01HX", idempotencyKey: null },
      planContext: { planId: "plan_01HX" },
    });
  });

  it("reports when place was not highlighted", async () => {
    mockGraphql.mockResolvedValueOnce({ unhighlightTripPlace: false });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "unhighlight",
      "--plan", "plan_01HX",
      "--place", "dp_02HX",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { removed: false, placeId: "dp_02HX", idempotencyKey: null },
      planContext: { planId: "plan_01HX" },
    });
  });
});

// ── places remove ──────────────────────────────────────────────────────────

describe("places remove", () => {
  it("removes a trip plan place", async () => {
    mockGraphql.mockResolvedValueOnce({ removeTripPlanPlace: true });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "remove",
      "--id", "tpp_01HX",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { id: "tpp_01HX" },
      { dryRun: undefined }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { removed: true, id: "tpp_01HX", idempotencyKey: null },
    });
  });

  it("reports when place was not found", async () => {
    mockGraphql.mockResolvedValueOnce({ removeTripPlanPlace: false });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "remove",
      "--id", "tpp_MISSING",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { removed: false, id: "tpp_MISSING", idempotencyKey: null },
    });
  });

  it("requires --id flag", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "remove", "--json"])
    ).rejects.toThrow();
  });
});

// ── Agent output tests ─────────────────────────────────────────────────────

describe("places --agent output", () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("outputs markdown for search command", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [sampleSearchPlace], count: 1, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "search", "--query", "Eiffel", "--agent"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("## Place Search Results");
    expect(output).toContain("Eiffel Tower");
  });

  it("outputs markdown for list command", async () => {
    mockGraphql.mockResolvedValueOnce({ getTripPlanPlaces: [sampleTripPlanPlace] });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "list", "--plan", "plan_01HX", "--agent"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("## Trip Plan Places");
    expect(output).toContain("Hotel Le Bristol");
  });

  it("outputs markdown for attach command", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertTripPlanPlace: sampleTripPlanPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "Hotel Le Bristol",
      "--place-id", "place_02HX",
      "--agent",
    ]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("## Place Attached");
    expect(output).toContain("tpp_01HX");
  });
});

// ── Group A: Strict numeric validation ────────────────────────────────────

describe("places search — strict numeric validation", () => {
  it("throws VALIDATION error for invalid --limit", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "search", "--query", "test", "--limit", "abc", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("throws VALIDATION error for negative --limit", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "search", "--query", "test", "--limit", "-5", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("throws VALIDATION error for invalid --page", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "search", "--query", "test", "--page", "abc", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("accepts valid --limit and --page values", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 2, limit: 10 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "hotel",
      "--limit", "10",
      "--page", "2",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ limit: 10, page: 2 })
    );
  });
});

describe("places highlight — strict --ranking validation", () => {
  it("throws VALIDATION error for non-numeric --ranking", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "places", "highlight",
        "--plan", "plan_01HX",
        "--place", "dp_01HX",
        "--category", "hotel",
        "--ranking", "abc",
        "--json",
      ])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("throws VALIDATION error for negative --ranking", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "places", "highlight",
        "--plan", "plan_01HX",
        "--place", "dp_01HX",
        "--category", "hotel",
        "--ranking", "-1",
        "--json",
      ])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("accepts --ranking 0 (non-negative)", async () => {
    mockGraphql.mockResolvedValueOnce({ highlightTripPlace: { ...sampleHighlightedPlace, ranking: 0 } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "highlight",
      "--plan", "plan_01HX",
      "--place", "dp_01HX",
      "--category", "hotel",
      "--ranking", "0",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ ranking: 0 }),
      { dryRun: undefined }
    );
  });
});

// ── Group B: Preserve zero-valued coordinates ─────────────────────────────

describe("places get — zero-valued coordinates", () => {
  const placeAtEquatorPrimeMeridian = {
    ...sampleSearchPlace,
    location: { latitude: 0, longitude: 0 },
  };

  it("renders lat=0, lng=0 in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ getPlaceById: placeAtEquatorPrimeMeridian });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "get", "place_01HX", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      data: { place: placeAtEquatorPrimeMeridian },
    });
  });

  it("renders lat=0, lng=0 in --agent output", async () => {
    mockGraphql.mockResolvedValueOnce({ getPlaceById: placeAtEquatorPrimeMeridian });
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "get", "place_01HX", "--agent"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("**Coordinates:** 0, 0");
    consoleSpy.mockRestore();
  });

  it("renders lat=0, lng=0 in TTY output", async () => {
    mockGraphql.mockResolvedValueOnce({ getPlaceById: placeAtEquatorPrimeMeridian });
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const p = buildProgram();
    await p.parseAsync(["node", "test", "places", "get", "place_01HX"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Coordinates: 0, 0");
    consoleSpy.mockRestore();
  });
});

// ── Group C: Echo --idempotency-key in JSON output ────────────────────────

describe("places attach — idempotency-key echo", () => {
  it("echoes --idempotency-key in JSON output when provided", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertTripPlanPlace: sampleTripPlanPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "Hotel Le Bristol",
      "--place-id", "place_02HX",
      "--idempotency-key", "01HXYZ123ABC",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: "01HXYZ123ABC" }),
      })
    );
  });

  it("echoes null for idempotencyKey when not provided", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertTripPlanPlace: sampleTripPlanPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "Hotel Le Bristol",
      "--place-id", "place_02HX",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: null }),
      })
    );
  });
});

describe("places highlight — idempotency-key echo", () => {
  it("echoes --idempotency-key in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ highlightTripPlace: sampleHighlightedPlace });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "highlight",
      "--plan", "plan_01HX",
      "--place", "dp_01HX",
      "--category", "hotel",
      "--idempotency-key", "01HXYZ456DEF",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: "01HXYZ456DEF" }),
      })
    );
  });
});

describe("places unhighlight — idempotency-key echo", () => {
  it("echoes --idempotency-key in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ unhighlightTripPlace: true });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "unhighlight",
      "--plan", "plan_01HX",
      "--place", "dp_01HX",
      "--idempotency-key", "01HXYZ789GHI",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: "01HXYZ789GHI" }),
      })
    );
  });
});

describe("places remove — idempotency-key echo", () => {
  it("echoes --idempotency-key in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ removeTripPlanPlace: true });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "remove",
      "--id", "tpp_01HX",
      "--idempotency-key", "01HXYZABCDEF",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: "01HXYZABCDEF" }),
      })
    );
  });
});

// ── Group D: Strict --source validation ───────────────────────────────────

describe("places search — strict --source validation", () => {
  it("throws VALIDATION error for typo --source gogole", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "search", "--query", "test", "--source", "gogole", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("throws VALIDATION error for unknown --source value", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "places", "search", "--query", "test", "--source", "bing", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("accepts --source google", async () => {
    mockGraphql.mockResolvedValueOnce({ searchExternalPlaces: [] });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "test",
      "--source", "google",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchExternalPlaces"),
      expect.any(Object)
    );
  });

  it("accepts --source internal", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "test",
      "--source", "internal",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchPlaces"),
      expect.any(Object)
    );
  });
});

// ── Regression: Copilot review (second pass) ──────────────────────────────

describe("places search — markdown escaping (--agent)", () => {
  it("escapes pipe characters in place names in the agent table", async () => {
    const mischievousPlace = {
      id: "place_evil",
      name: "Hotel | Wreckage `cafe`",
      description: "Pipes | and backticks `everywhere`",
      location: { latitude: 1, longitude: 1 },
      address: { city: "Paris | Center", country: "France" },
      country: { id: "FR", name: "France" },
      locality: { id: "paris", name: "Paris" },
    };
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [mischievousPlace], count: 1, page: 1, limit: 20 },
    });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "evil",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    // The pipe inside the place name MUST be escaped so it doesn't break
    // the markdown table structure.
    expect(allOut).toContain("Hotel \\| Wreckage \\`cafe\\`");
    // The pipe inside the city MUST be escaped too.
    expect(allOut).toContain("Paris \\| Center");

    logSpy.mockRestore();
  });
});

describe("places — formatPlaceLine location fallback (TTY)", () => {
  it("uses locality.name when address.city is absent", async () => {
    const placeNoCity = {
      id: "place_loc",
      name: "Test Place",
      description: null,
      location: { latitude: 0, longitude: 0 },
      address: null,
      country: { id: "FR", name: "France" },
      locality: { id: "lyo", name: "Lyon" },
    };
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [placeNoCity], count: 1, page: 1, limit: 20 },
    });

    const writes: string[] = [];
    const writeSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "Test",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("Lyon");

    writeSpy.mockRestore();
  });

  it("falls back to country.name when both city and locality are absent", async () => {
    const placeOnlyCountry = {
      id: "place_country",
      name: "Test Place",
      description: null,
      location: { latitude: 0, longitude: 0 },
      address: null,
      country: { id: "FR", name: "France" },
      locality: null,
    };
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [placeOnlyCountry], count: 1, page: 1, limit: 20 },
    });

    const writes: string[] = [];
    const writeSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "Test",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("France");

    writeSpy.mockRestore();
  });
});

describe("places search — --country help text honesty", () => {
  it("documents that --country is an ID for internal source and a code for google source", () => {
    const p = buildProgram();
    const help = p.commands
      .find((c) => c.name() === "places")!
      .commands.find((c) => c.name() === "search")!
      .helpInformation();

    expect(help).toContain("--country");
    expect(help).toMatch(/ISO country code|country ID/);
  });
});

describe("places — --idempotency-key help text", () => {
  const mutatingCommands = ["attach", "highlight", "unhighlight", "remove"];

  for (const name of mutatingCommands) {
    it(`documents --idempotency-key on \`places ${name}\` as JSON-echo, not server-side dedup`, () => {
      const p = buildProgram();
      const help = p.commands
        .find((c) => c.name() === "places")!
        .commands.find((c) => c.name() === name)!
        .helpInformation();

      expect(help).toContain("--idempotency-key");
      expect(help).toContain("Echoed in JSON output");
      expect(help).not.toContain("for the mutation");
    });
  }
});

// ── Regression: PLACE_NOT_FOUND remains; PLAN_REQUIRED/PLACE_ID_REQUIRED dropped ─

describe("CliErrorCode — Section 7 surface", () => {
  it("retains the codes that are actually thrown", async () => {
    const errors = await import("../errors.js");
    expect(errors.CliErrorCode.LISTING_NOT_FOUND).toBe("LISTING_NOT_FOUND");
    expect(errors.CliErrorCode.PLACE_NOT_FOUND).toBe("PLACE_NOT_FOUND");
    expect(errors.CliErrorCode.NO_MONITOR).toBe("NO_MONITOR");
  });

  it("does not declare codes that are never thrown", async () => {
    const errors = await import("../errors.js");
    // PLAN_REQUIRED and PLACE_ID_REQUIRED were removed because Commander's
    // required-flag validation already covers those cases.
    expect((errors.CliErrorCode as Record<string, string>).PLAN_REQUIRED).toBeUndefined();
    expect((errors.CliErrorCode as Record<string, string>).PLACE_ID_REQUIRED).toBeUndefined();
  });
});

// ── Regression: Copilot review (third pass) ──────────────────────────────

describe("places list --highlighted --agent — markdown escaping", () => {
  it("escapes pipe/backtick characters in highlighted place name and ID", async () => {
    const evilHighlighted = {
      id: "hp_evil",
      ranking: 1,
      category: "Hotel",
      detectedPlace: {
        id: "dp_ev|il",
        name: "Hotel | `Le Mauvais`",
        placeId: "place_evil",
        location: { latitude: 1, longitude: 1 },
      },
    };

    mockGraphql.mockResolvedValueOnce({ highlightedTripPlaces: [evilHighlighted] });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "list",
      "--plan", "plan_01HX",
      "--highlighted",
      "--category", "Hotel",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("Hotel \\| \\`Le Mauvais\\`");
    expect(allOut).toContain("dp_ev\\|il");

    logSpy.mockRestore();
  });
});

describe("places list (TripPlanPlaces) --agent — markdown escaping", () => {
  it("escapes pipe/backtick characters in trip plan place fields", async () => {
    const evilPlace = {
      id: "tpp_ev`il",
      name: "Cafe | `Le Pipe`",
      placeId: "place_evil",
      tripPlanId: "plan_01HX",
      type: "Cafe|OrCoffeeShop",
      types: [],
      countryId: "FR",
      countryName: "France",
      description: null,
      iataCode: null,
      image: null,
      url: null,
      placeTimezone: null,
      location: { latitude: 1, longitude: 1 },
    };

    mockGraphql.mockResolvedValueOnce({ getTripPlanPlaces: [evilPlace] });

    const writes: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
      writes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "list",
      "--plan", "plan_01HX",
      "--agent",
    ]);

    const allOut = writes.join("\n");
    expect(allOut).toContain("Cafe \\| \\`Le Pipe\\`");
    expect(allOut).toContain("Cafe\\|OrCoffeeShop");
    expect(allOut).toContain("tpp_ev\\`il");

    logSpy.mockRestore();
  });
});

describe("places search — --type normalization consistency with attach", () => {
  it("normalizes lowercase --type to PascalCase before sending to searchPlaces", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "Eiffel",
      "--type", "tourist-attraction",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchPlaces"),
      expect.objectContaining({ type: "TouristAttraction" })
    );
  });

  it("preserves already-PascalCase --type input verbatim", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "Eiffel",
      "--type", "TrainStation",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchPlaces"),
      expect.objectContaining({ type: "TrainStation" })
    );
  });

  it("sends null when --type is omitted", async () => {
    mockGraphql.mockResolvedValueOnce({
      searchPlaces: { items: [], count: 0, page: 1, limit: 20 },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "search",
      "--query", "Eiffel",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("searchPlaces"),
      expect.objectContaining({ type: null })
    );
  });
});

describe("places attach — --iata-code validation", () => {
  it("rejects malformed IATA codes (e.g., 'L4X' with a digit)", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "places", "attach",
        "--plan", "plan_01HX",
        "--name", "Test Airport",
        "--place-id", "place_test",
        "--iata-code", "L4X",
        "--json",
      ])
    ).rejects.toThrow(/Invalid IATA code|--iata-code/);

    // The mutation must NOT have been called for an invalid IATA.
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("rejects 4-letter IATA codes", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "places", "attach",
        "--plan", "plan_01HX",
        "--name", "Test Airport",
        "--place-id", "place_test",
        "--iata-code", "LAXX",
        "--json",
      ])
    ).rejects.toThrow(/Invalid IATA code|--iata-code/);
  });

  it("uppercases lowercase IATA input before sending to mutation", async () => {
    mockGraphql.mockResolvedValueOnce({
      upsertTripPlanPlace: { ...sampleTripPlanPlace, iataCode: "LAX" },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "places", "attach",
      "--plan", "plan_01HX",
      "--name", "LAX",
      "--place-id", "place_lax",
      "--iata-code", "lax",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining("upsertTripPlanPlace"),
      expect.objectContaining({
        input: expect.objectContaining({ iataCode: "LAX" }),
      }),
      expect.anything()
    );
  });
});

describe("places — --agent help text consistency", () => {
  const cmds = ["search", "get", "attach", "list", "highlight", "unhighlight", "remove"];
  for (const name of cmds) {
    it(`\`places ${name}\` uses the canonical help wording`, () => {
      const p = buildProgram();
      const help = p.commands
        .find((c) => c.name() === "places")!
        .commands.find((c) => c.name() === name)!
        .helpInformation();

      expect(help).toContain("Output plain markdown for AI agents");
      expect(help).not.toContain("Output markdown for AI display");
    });
  }
});
