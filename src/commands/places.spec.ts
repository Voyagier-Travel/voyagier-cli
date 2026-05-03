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

  it("ignores invalid numeric values", () => {
    expect(parseSearchLocation({ lat: "invalid" })).toBeUndefined();
    expect(parseSearchLocation({ lat: "48.8584", lng: "invalid" })).toEqual({ latitude: 48.8584 });
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
      data: { place: sampleTripPlanPlace },
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
      data: { highlighted: sampleHighlightedPlace },
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
      data: { removed: true, placeId: "dp_01HX" },
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
      data: { removed: false, placeId: "dp_02HX" },
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
      data: { removed: true, id: "tpp_01HX" },
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
      data: { removed: false, id: "tpp_MISSING" },
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
