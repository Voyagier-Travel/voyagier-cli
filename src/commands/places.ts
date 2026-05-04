/**
 * Places command surface (v2.0.0).
 *
 * Backed by the geo/place layer (TripPlanPlace + Google Places). STABLE per
 * Phase 0 schema audit (Section 7 of the v2 design freeze).
 *
 * Surface:
 *   voyagier places search --query <q> [--source google|internal] [--country <code|id>]
 *                          [--lat <f>] [--lng <f>] [--radius <m>] [--type <type>]
 *                          [--limit <n>] [--page <n>] [--json] [--agent]
 *   voyagier places get <id> [--external] [--json] [--agent]
 *   voyagier places attach --plan <id> --name <name> --place-id <placeId> [opts] [--json] [--agent]
 *   voyagier places list --plan <id> [--highlighted] [--category attraction|hotel|restaurant] [--json] [--agent]
 *   voyagier places highlight --plan <id> --place <detectedPlaceId> --category <cat> [--ranking <n>] [--json] [--agent]
 *   voyagier places unhighlight --plan <id> --place <detectedPlaceId> [--json] [--agent]
 *   voyagier places remove --id <tripPlanPlaceId> [--json] [--agent]
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { parsePositiveInt, parseNonNegativeInt, parseFloatStrict, escapeMdTableCell, validateIata } from "../utils.js";
import {
  SEARCH_PLACES,
  SEARCH_EXTERNAL_PLACES,
  GET_PLACE_BY_ID,
  GET_PLACE_BY_EXTERNAL_ID,
  GET_TRIP_PLAN_PLACES,
  UPSERT_TRIP_PLAN_PLACE,
  REMOVE_TRIP_PLAN_PLACE,
  HIGHLIGHT_TRIP_PLACE,
  UNHIGHLIGHT_TRIP_PLACE,
  GET_HIGHLIGHTED_TRIP_PLACES,
} from "../queries.js";

// ----- Types -----

export interface PlaceLocation {
  latitude?: number | null;
  longitude?: number | null;
}

export interface PlaceAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface SearchPlace {
  id: string;
  name?: string | null;
  description?: string | null;
  location?: PlaceLocation | null;
  address?: PlaceAddress | null;
  country?: { id: string; name: string } | null;
  locality?: { id: string; name: string } | null;
}

export interface TripPlanPlace {
  id: string;
  name?: string | null;
  placeId?: string | null;
  tripPlanId?: string | null;
  type?: string | null;
  types?: string[] | null;
  countryId?: string | null;
  countryName?: string | null;
  description?: string | null;
  iataCode?: string | null;
  image?: string | null;
  url?: string | null;
  placeTimezone?: string | null;
  location?: PlaceLocation | null;
}

export interface DetectedTripHighlightedPlace {
  id: string;
  ranking?: number | null;
  category?: string | null;
  detectedPlace?: {
    id: string;
    name?: string | null;
    placeId?: string | null;
    location?: PlaceLocation | null;
  } | null;
}

export interface SearchLocationInput {
  latitude?: number;
  longitude?: number;
  radius?: number;
}

// ----- Enum normalization -----

const VALID_HIGHLIGHT_CATEGORIES = ["attraction", "hotel", "restaurant"] as const;
type HighlightCategoryLower = (typeof VALID_HIGHLIGHT_CATEGORIES)[number];

const HIGHLIGHT_CATEGORY_MAP: Record<HighlightCategoryLower, string> = {
  attraction: "Attraction",
  hotel: "Hotel",
  restaurant: "Restaurant",
};

/**
 * Normalize a CLI flag value (lowercase) to the GraphQL enum (PascalCase).
 * Exported for unit testing.
 */
export function normalizeHighlightCategory(value: string): string {
  const lower = value.toLowerCase().trim() as HighlightCategoryLower;
  const mapped = HIGHLIGHT_CATEGORY_MAP[lower];
  if (mapped) return mapped;
  if (Object.values(HIGHLIGHT_CATEGORY_MAP).includes(value)) return value;
  throw new CliError(
    CliErrorCode.VALIDATION,
    `Invalid --category "${value}". Must be one of: ${VALID_HIGHLIGHT_CATEGORIES.join(", ")}`
  );
}

/**
 * Best-effort PascalCase normalization for PlaceType.
 * The enum has 100+ values; we don't validate exhaustively client-side.
 *
 * Strategy:
 *   - If the input is already PascalCase (starts with uppercase, contains no
 *     separators), pass it through untouched. This preserves multi-word
 *     values like "TouristAttraction" or "TrainStation" that the caller
 *     spelled correctly per the schema.
 *   - Otherwise, split on whitespace/underscore/hyphen and capitalize each
 *     segment. Handles "hotel", "tourist-attraction", "train_station",
 *     "tourist attraction", etc.
 * Exported for unit testing.
 */
export function normalizePlaceType(value: string): string {
  // Already PascalCase (no separators, starts uppercase): preserve verbatim.
  if (/^[A-Z][A-Za-z0-9]*$/.test(value)) {
    return value;
  }
  return value
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

/**
 * Parse --lat/--lng/--radius into a SearchLocationInput if any are provided.
 * Rejects non-numeric values, out-of-range coordinates, and negative radius
 * with VALIDATION_ERROR.
 *
 * Bounds:
 *   --lat in [-90, 90]
 *   --lng in [-180, 180]
 *   --radius >= 0  (meters, per searchExternalPlaces)
 *
 * Exported for unit testing.
 */
export function parseSearchLocation(opts: {
  lat?: string;
  lng?: string;
  radius?: string;
}): SearchLocationInput | undefined {
  const lat = parseFloatStrict(opts.lat, "--lat", { min: -90, max: 90 });
  const lng = parseFloatStrict(opts.lng, "--lng", { min: -180, max: 180 });
  const radius = parseFloatStrict(opts.radius, "--radius", { nonNegative: true });

  if (lat === undefined && lng === undefined && radius === undefined) {
    return undefined;
  }

  const location: SearchLocationInput = {};
  if (lat !== undefined) location.latitude = lat;
  if (lng !== undefined) location.longitude = lng;
  if (radius !== undefined) location.radius = radius;

  return Object.keys(location).length > 0 ? location : undefined;
}

// ----- Helpers -----

function formatPlaceLine(p: SearchPlace | TripPlanPlace): string {
  const name = chalk.bold(p.name ?? "(unnamed)");
  // Location fallback chain (most specific first):
  //   SearchPlace: address.city -> locality.name -> country.name
  //   TripPlanPlace: address.city -> countryName
  // This ensures TTY output never blanks the location when the API returned
  // location data in a different shape than address.city.
  let locText: string | null = null;
  if ("address" in p && p.address?.city) {
    locText = p.address.city;
  } else if ("locality" in p && p.locality?.name) {
    locText = p.locality.name;
  } else if ("country" in p && p.country?.name) {
    locText = p.country.name;
  } else if ("countryName" in p && p.countryName) {
    locText = p.countryName;
  }
  const loc = locText ? chalk.dim(` — ${locText}`) : "";
  const type = "type" in p && p.type ? chalk.cyan(`[${p.type}]`) + " " : "";
  return `  ${type}${name}${loc}  ${chalk.dim(p.id)}`;
}

function formatHighlightedLine(h: DetectedTripHighlightedPlace): string {
  const ranking = h.ranking != null ? chalk.yellow(`#${h.ranking}`) : chalk.dim("#—");
  const name = chalk.bold(h.detectedPlace?.name ?? "(unnamed)");
  const cat = h.category ? chalk.cyan(`[${h.category}]`) : "";
  return `  ${ranking} ${cat} ${name}  ${chalk.dim(h.detectedPlace?.id ?? h.id)}`;
}

// ----- Commands -----

export function registerPlacesCommands(program: Command): void {
  const places = program
    .command("places")
    .description("Search and manage places (geo/place layer)");

  // -- search --
  places
    .command("search")
    .description("Search for places (internal or Google Places)")
    .requiredOption("--query <q>", "Search query")
    .option("--source <source>", "Data source: internal (default) or google", "internal")
    .option(
      "--country <value>",
      "Country filter: ISO country code (e.g. FR) when --source google; country ID when --source internal"
    )
    .option("--lat <f>", "Latitude for location-based search")
    .option("--lng <f>", "Longitude for location-based search")
    .option("--radius <m>", "Radius in meters for location-based search")
    .option("--type <type>", "Place type filter (internal only)")
    .option("--limit <n>", "Max results (internal only)", "20")
    .option("--page <n>", "Page number (internal only)", "1")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (opts) => {
      const source = opts.source.toLowerCase();

      // Group D: Validate --source against allowed values
      const VALID_SOURCES = ["google", "internal"];
      if (!VALID_SOURCES.includes(source)) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Invalid --source "${opts.source}". Must be one of: ${VALID_SOURCES.join(", ")}.\n  Fix: --source google|internal`
        );
      }

      const location = parseSearchLocation(opts);

      let places: SearchPlace[];
      let total: number | undefined;

      if (source === "google") {
        const data = await graphql<{ searchExternalPlaces: SearchPlace[] }>(
          SEARCH_EXTERNAL_PLACES,
          {
            query: opts.query,
            countryCode: opts.country ?? null,
            location: location ?? null,
          }
        );
        places = data.searchExternalPlaces ?? [];
        total = places.length;
      } else {
        // Group A: Strict validation for --limit and --page
        const limit = parsePositiveInt(opts.limit, "--limit", { default: 20, max: 100 }) ?? 20;
        const page = parsePositiveInt(opts.page, "--page", { default: 1 }) ?? 1;
        // Normalize --type the same way `places attach` does so the casing
        // contract is uniform across the command group. The schema enum is
        // PascalCase; the CLI accepts lowercase / kebab / snake and translates.
        const normalizedType = opts.type ? normalizePlaceType(opts.type) : null;
        const data = await graphql<{
          searchPlaces: { items: SearchPlace[]; count: number; page: number; limit: number };
        }>(SEARCH_PLACES, {
          query: opts.query,
          countryId: opts.country ?? null,
          location: location ?? null,
          type: normalizedType,
          limit,
          page,
        });
        places = data.searchPlaces?.items ?? [];
        total = data.searchPlaces?.count ?? places.length;
      }

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            places,
            total,
            source,
          },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Place Search Results\n`);
        console.log(`**Query:** ${escapeMdTableCell(opts.query)}  `);
        console.log(`**Source:** ${source}\n`);
        if (places.length === 0) {
          console.log("No places found.\n");
        } else {
          console.log(`| Name | Location | ID |`);
          console.log(`|---|---|---|`);
          for (const p of places) {
            // Same fallback chain as formatPlaceLine — keep them in sync.
            const loc =
              p.address?.city
              ?? p.locality?.name
              ?? p.country?.name
              ?? "—";
            console.log(
              `| ${escapeMdTableCell(p.name)} | ${escapeMdTableCell(loc)} | \`${escapeMdTableCell(p.id)}\` |`
            );
          }
          console.log(`\n*${places.length} of ${total} result(s)*`);
        }
        return;
      }

      console.log(`\n${chalk.bold("Place Search Results")}  ${chalk.dim(`(source: ${source})`)}\n`);
      if (places.length === 0) {
        console.log(chalk.dim("  No places found."));
      } else {
        for (const p of places) {
          console.log(formatPlaceLine(p));
        }
        console.log(chalk.dim(`\n${places.length} of ${total} result(s)`));
      }
    });

  // -- get --
  places
    .command("get <id>")
    .description("Get a place by ID (internal or external)")
    .option("--external", "Look up by external ID (e.g., Google Place ID)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (id, opts) => {
      let place: SearchPlace | null;

      if (opts.external) {
        const data = await graphql<{ getPlaceByExternalId: SearchPlace | null }>(
          GET_PLACE_BY_EXTERNAL_ID,
          { externalId: id }
        );
        place = data.getPlaceByExternalId;
      } else {
        const data = await graphql<{ getPlaceById: SearchPlace | null }>(
          GET_PLACE_BY_ID,
          { id }
        );
        place = data.getPlaceById;
      }

      if (!place) {
        throw new CliError(
          CliErrorCode.PLACE_NOT_FOUND,
          `Place "${id}" not found.\n  Fix: voyagier places search --query ...`
        );
      }

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: { place },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Place Details\n`);
        console.log(`**ID:** \`${place.id}\`  `);
        console.log(`**Name:** ${place.name ?? "—"}  `);
        if (place.description) console.log(`**Description:** ${place.description}  `);
        if (place.address?.city) console.log(`**City:** ${place.address.city}  `);
        if (place.country?.name) console.log(`**Country:** ${place.country.name}  `);
        // Group B: Use typeof check to preserve lat=0 or lng=0 (equator/prime meridian)
        const lat = place.location?.latitude;
        const lng = place.location?.longitude;
        if (typeof lat === "number" && typeof lng === "number" && !isNaN(lat) && !isNaN(lng)) {
          console.log(`**Coordinates:** ${lat}, ${lng}  `);
        }
        console.log("");
        return;
      }

      console.log(`\n${chalk.bold(place.name ?? "(unnamed)")}  ${chalk.dim(place.id)}`);
      if (place.description) console.log(chalk.dim(`  ${place.description}`));
      if (place.address?.city) console.log(chalk.dim(`  City: ${place.address.city}`));
      if (place.country?.name) console.log(chalk.dim(`  Country: ${place.country.name}`));
      // Group B: Use typeof check to preserve lat=0 or lng=0 (equator/prime meridian)
      const ttyLat = place.location?.latitude;
      const ttyLng = place.location?.longitude;
      if (typeof ttyLat === "number" && typeof ttyLng === "number" && !isNaN(ttyLat) && !isNaN(ttyLng)) {
        console.log(chalk.dim(`  Coordinates: ${ttyLat}, ${ttyLng}`));
      }
    });

  // -- attach --
  places
    .command("attach")
    .description("Attach a place to a trip plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .requiredOption("--name <name>", "Place name")
    .requiredOption("--place-id <id>", "Place ID")
    .option("--type <type>", "Place type (Hotel, Restaurant, City, Airport, etc.)")
    .option("--country-id <id>", "Country ID")
    // Deprecated v2.1.0; removed v2.2.0.
    // The server resolves these from the upstream Place entity (Google Places /
    // Foursquare cache). Agent-supplied overrides cause drift between the place
    // record and downstream UI surfaces. Pass `--place-id` only and let the
    // resolver populate the rest.
    .option("--country-name <name>", "[deprecated] Country name. Resolved server-side from --country-id. Will be removed in v2.2.0.")
    .option("--description <d>", "[deprecated] Description. Resolved server-side from upstream Place entity. Will be removed in v2.2.0.")
    .option("--image <url>", "[deprecated] Image URL. Resolved server-side from upstream Place entity. Will be removed in v2.2.0.")
    .option("--iata-code <code>", "IATA code (for airports)")
    .option("--url <url>", "[deprecated] URL. Resolved server-side from upstream Place entity. Will be removed in v2.2.0.")
    .option("--place-timezone <tz>", "Timezone")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      const input: Record<string, unknown> = {
        tripPlanId: opts.plan,
        name: opts.name,
        placeId: opts.placeId,
      };
      if (opts.type) input.type = normalizePlaceType(opts.type);
      if (opts.countryId) input.countryId = opts.countryId;
      // --country-name, --description, --image, --url are deprecated in v2.1.0.
      // We continue to send them to the API when explicitly provided so existing
      // scripts don't break, but each emits a one-line stderr warning. The server
      // already populates these from the upstream Place entity; agent-supplied
      // values drift over time. Removal in v2.2.0.
      if (opts.countryName) {
        input.countryName = opts.countryName;
        // eslint-disable-next-line no-console
        console.error("[deprecated] --country-name is deprecated; resolved server-side from --country-id. Will be removed in v2.2.0.");
      }
      if (opts.description) {
        input.description = opts.description;
        // eslint-disable-next-line no-console
        console.error("[deprecated] --description on `places attach` is deprecated; resolved server-side from the upstream Place entity. Will be removed in v2.2.0.");
      }
      if (opts.image) {
        input.image = opts.image;
        // eslint-disable-next-line no-console
        console.error("[deprecated] --image on `places attach` is deprecated; resolved server-side from the upstream Place entity. Will be removed in v2.2.0.");
      }
      if (opts.iataCode) {
        // Match the rest of the CLI: validate IATA at the boundary, not at the API.
        validateIata(opts.iataCode, "--iata-code");
        input.iataCode = opts.iataCode.toUpperCase();
      }
      if (opts.url) {
        input.url = opts.url;
        // eslint-disable-next-line no-console
        console.error("[deprecated] --url on `places attach` is deprecated; resolved server-side from the upstream Place entity. Will be removed in v2.2.0.");
      }
      if (opts.placeTimezone) input.placeTimezone = opts.placeTimezone;

      const data = await graphql<{ upsertTripPlanPlace: TripPlanPlace }>(
        UPSERT_TRIP_PLAN_PLACE,
        { input },
        { dryRun: opts.dryRun }
      );

      const place = data.upsertTripPlanPlace;

      if (opts.json) {
        // Echoed in JSON output for agent-side tracking; not yet enforced server-side
        jsonOutput({
          ok: true,
          data: { place, idempotencyKey: opts.idempotencyKey ?? null },
          planContext: { planId: opts.plan },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Place Attached\n`);
        console.log(`**ID:** \`${place.id}\`  `);
        console.log(`**Name:** ${place.name ?? "—"}  `);
        console.log(`**Plan:** \`${opts.plan}\`\n`);
        return;
      }

      console.log(chalk.green(`✓ Attached place to plan`));
      console.log(chalk.dim(`  ID:   ${place.id}`));
      console.log(chalk.dim(`  Name: ${place.name ?? "—"}`));
      console.log(chalk.dim(`  Plan: ${opts.plan}`));
    });

  // -- list --
  places
    .command("list")
    .description("List places on a trip plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--highlighted", "Show highlighted places instead")
    .option("--category <cat>", "Category filter (attraction|hotel|restaurant) — required with --highlighted")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (opts) => {
      const planId = opts.plan;

      if (opts.highlighted) {
        if (!opts.category) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            `--category is required when using --highlighted.\n  Fix: voyagier places list --plan ${planId} --highlighted --category hotel`
          );
        }
        const category = normalizeHighlightCategory(opts.category);
        const data = await graphql<{
          highlightedTripPlaces: DetectedTripHighlightedPlace[];
        }>(GET_HIGHLIGHTED_TRIP_PLACES, { tripId: planId, category });

        const highlighted = data.highlightedTripPlaces ?? [];

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              highlighted,
              total: highlighted.length,
              category,
            },
            planContext: { planId },
          });
          return;
        }

        if (opts.agent) {
          console.log(`## Highlighted Places\n`);
          console.log(`**Plan:** \`${planId}\`  `);
          console.log(`**Category:** ${category}\n`);
          if (highlighted.length === 0) {
            console.log("No highlighted places.\n");
          } else {
            console.log(`| Rank | Name | ID |`);
            console.log(`|---|---|---|`);
            for (const h of highlighted) {
              const rank = h.ranking != null ? String(h.ranking) : null;
              const id = h.detectedPlace?.id ?? h.id;
              console.log(
                `| ${escapeMdTableCell(rank)} | ${escapeMdTableCell(h.detectedPlace?.name)} | \`${escapeMdTableCell(id)}\` |`
              );
            }
            console.log(`\n*${highlighted.length} place(s)*`);
          }
          return;
        }

        console.log(`\n${chalk.bold("Highlighted Places")}  ${chalk.dim(`(${category})`)}\n`);
        if (highlighted.length === 0) {
          console.log(chalk.dim("  No highlighted places in this category."));
        } else {
          for (const h of highlighted) {
            console.log(formatHighlightedLine(h));
          }
          console.log(chalk.dim(`\n${highlighted.length} place(s)`));
        }
        return;
      }

      const data = await graphql<{ getTripPlanPlaces: TripPlanPlace[] }>(
        GET_TRIP_PLAN_PLACES,
        { tripPlanId: planId }
      );

      const placesList = data.getTripPlanPlaces ?? [];

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            places: placesList,
            total: placesList.length,
          },
          planContext: { planId },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Trip Plan Places\n`);
        console.log(`**Plan:** \`${planId}\`\n`);
        if (placesList.length === 0) {
          console.log("No places attached.\n");
        } else {
          console.log(`| Type | Name | ID |`);
          console.log(`|---|---|---|`);
          for (const p of placesList) {
            console.log(
              `| ${escapeMdTableCell(p.type)} | ${escapeMdTableCell(p.name)} | \`${escapeMdTableCell(p.id)}\` |`
            );
          }
          console.log(`\n*${placesList.length} place(s)*`);
        }
        return;
      }

      console.log(`\n${chalk.bold("Trip Plan Places")}\n`);
      if (placesList.length === 0) {
        console.log(chalk.dim("  No places attached to this plan."));
        console.log(chalk.dim("  Attach one: voyagier places attach --plan " + planId + " --name ... --place-id ..."));
      } else {
        for (const p of placesList) {
          console.log(formatPlaceLine(p));
        }
        console.log(chalk.dim(`\n${placesList.length} place(s)`));
      }
    });

  // -- highlight --
  places
    .command("highlight")
    .description("Highlight a place on a trip plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .requiredOption("--place <id>", "Detected place ID")
    .requiredOption("--category <cat>", "Category (attraction|hotel|restaurant)")
    .option("--ranking <n>", "Ranking position")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      const category = normalizeHighlightCategory(opts.category);
      // Group A: Strict validation for --ranking (allows 0 per GraphQL schema)
      const ranking = parseNonNegativeInt(opts.ranking, "--ranking");

      const data = await graphql<{
        highlightTripPlace: DetectedTripHighlightedPlace;
      }>(
        HIGHLIGHT_TRIP_PLACE,
        {
          tripId: opts.plan,
          detectedPlaceId: opts.place,
          category,
          ranking: ranking ?? null,
        },
        { dryRun: opts.dryRun }
      );

      const highlighted = data.highlightTripPlace;

      if (opts.json) {
        // Echoed in JSON output for agent-side tracking; not yet enforced server-side
        jsonOutput({
          ok: true,
          data: { highlighted, idempotencyKey: opts.idempotencyKey ?? null },
          planContext: { planId: opts.plan },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Place Highlighted\n`);
        console.log(`**ID:** \`${highlighted.id}\`  `);
        console.log(`**Category:** ${category}  `);
        console.log(`**Ranking:** ${highlighted.ranking ?? "—"}\n`);
        return;
      }

      console.log(chalk.green(`✓ Highlighted place`));
      console.log(chalk.dim(`  ID:       ${highlighted.id}`));
      console.log(chalk.dim(`  Category: ${category}`));
      console.log(chalk.dim(`  Ranking:  ${highlighted.ranking ?? "—"}`));
    });

  // -- unhighlight --
  places
    .command("unhighlight")
    .description("Remove highlight from a place")
    .requiredOption("--plan <id>", "Trip plan ID")
    .requiredOption("--place <id>", "Detected place ID")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      const data = await graphql<{ unhighlightTripPlace: boolean }>(
        UNHIGHLIGHT_TRIP_PLACE,
        { tripId: opts.plan, detectedPlaceId: opts.place },
        { dryRun: opts.dryRun }
      );

      if (opts.json) {
        // Echoed in JSON output for agent-side tracking; not yet enforced server-side
        jsonOutput({
          ok: true,
          data: { removed: data.unhighlightTripPlace, placeId: opts.place, idempotencyKey: opts.idempotencyKey ?? null },
          planContext: { planId: opts.plan },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Place Unhighlighted\n`);
        console.log(`**Place:** \`${opts.place}\`  `);
        console.log(`**Removed:** ${data.unhighlightTripPlace ? "Yes" : "No"}\n`);
        return;
      }

      if (data.unhighlightTripPlace) {
        console.log(chalk.green(`✓ Removed highlight from place`));
        console.log(chalk.dim(`  Place: ${opts.place}`));
      } else {
        console.log(chalk.yellow(`⚠ Place was not highlighted or already removed`));
        console.log(chalk.dim(`  Place: ${opts.place}`));
      }
    });

  // -- remove --
  places
    .command("remove")
    .description("Remove a place from a trip plan")
    .requiredOption("--id <id>", "Trip plan place ID")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      const data = await graphql<{ removeTripPlanPlace: boolean }>(
        REMOVE_TRIP_PLAN_PLACE,
        { id: opts.id },
        { dryRun: opts.dryRun }
      );

      if (opts.json) {
        // Echoed in JSON output for agent-side tracking; not yet enforced server-side
        jsonOutput({
          ok: true,
          data: { removed: data.removeTripPlanPlace, id: opts.id, idempotencyKey: opts.idempotencyKey ?? null },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Place Removed\n`);
        console.log(`**ID:** \`${opts.id}\`  `);
        console.log(`**Removed:** ${data.removeTripPlanPlace ? "Yes" : "No"}\n`);
        return;
      }

      if (data.removeTripPlanPlace) {
        console.log(chalk.green(`✓ Removed place from plan`));
        console.log(chalk.dim(`  ID: ${opts.id}`));
      } else {
        console.log(chalk.yellow(`⚠ Place was not found or already removed`));
        console.log(chalk.dim(`  ID: ${opts.id}`));
      }
    });
}
