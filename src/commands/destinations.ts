/**
 * Destinations command surface.
 *
 * Resolves freeform destination text ("Georgia", "the Dolomites", "Split") to
 * STRUCTURED travel destinations. A bare name is ambiguous — Georgia the
 * country vs the US state — and downstream airport and hotel resolution needs
 * the country/region a structured destination carries. Run this first, then
 * pass the chosen id to `plan-trip --destination-id`.
 *
 * Surface:
 *   voyagier destinations search <query> [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { SEARCH_TRAVEL_DESTINATIONS } from "../queries.js";

// ----- Types -----

/** A ranked destination candidate as returned by searchTravelDestinations. */
export interface TravelDestination {
  id: string;
  name: string;
  /** City | Country | Region | Continent | Area. */
  type?: string | null;
  /** ISO alpha-2 country code. Empty string for a multi-country Area. */
  addressCountry?: string | null;
  addressRegion?: string | null;
  /** ISO alpha-2 codes of every country an Area spans. */
  countries?: string[] | null;
}

/** Max query length the API accepts. Rejected here so a typo fails locally. */
const MAX_QUERY_LENGTH = 200;

/**
 * Trim and bounds-check the freeform query, mirroring the API's own contract
 * (1..200 characters after trimming). Exported for direct testing.
 */
export function normalizeQuery(raw: string): string {
  const query = raw.trim();
  if (query.length === 0) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      'Destination query is empty. Pass the text to resolve, e.g. voyagier destinations search "the Dolomites"',
    );
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Destination query is ${query.length} characters; the maximum is ${MAX_QUERY_LENGTH}.`,
    );
  }
  return query;
}

/**
 * The geographic context of a candidate, most specific first: region, then
 * country. An Area spanning several countries has neither, so it falls back to
 * the country list it carries. Returns null when there is nothing to show.
 */
export function formatDestinationContext(d: TravelDestination): string | null {
  const parts: string[] = [];
  if (d.addressRegion) parts.push(d.addressRegion);
  if (d.addressCountry) parts.push(d.addressCountry);
  if (parts.length > 0) return parts.join(", ");
  const countries = (d.countries ?? []).filter(Boolean);
  return countries.length > 0 ? countries.join("/") : null;
}

/** Format one candidate for human-readable TTY output (single line). */
function formatDestinationLine(d: TravelDestination): string {
  const type = d.type ? chalk.cyan(`[${d.type}]`) + " " : "";
  const context = formatDestinationContext(d);
  const where = context ? chalk.dim(` — ${context}`) : "";
  return `  ${type}${chalk.bold(d.name)}${where}  ${chalk.dim(d.id)}`;
}

export function registerDestinationsCommands(program: Command): void {
  const destinations = program
    .command("destinations")
    .description("Resolve freeform destination text to structured travel destinations");

  // -- search --
  destinations
    .command("search <query>")
    .description("Resolve freeform destination text (city, country, region, continent, or named area) to ranked candidates")
    .addHelpText(
      "after",
      `
Examples:
  voyagier destinations search "Georgia" --json
  voyagier destinations search "the Dolomites" --json

  Candidates are ranked, and each carries the type (City | Country | Region |
  Continent | Area) plus the country/region that tells two same-named places
  apart. Pass the chosen id to: voyagier plan-trip --destination-id <id>
  A place that is not a travel destination returns no candidates — an empty
  result, not an error.
`,
    )
    .option("--json", "Output raw JSON")
    .action(async (rawQuery: string, opts: { json?: boolean }) => {
      const query = normalizeQuery(rawQuery);

      const data = await graphql<{ searchTravelDestinations: TravelDestination[] | null }>(
        SEARCH_TRAVEL_DESTINATIONS,
        { input: { query } },
      );
      const results = data.searchTravelDestinations ?? [];

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            destinations: results,
            total: results.length,
            query,
          },
        });
        return;
      }

      console.log(`\n${chalk.bold("Destinations")}  ${chalk.dim(`(query: ${query})`)}\n`);
      if (results.length === 0) {
        // Not an error: plenty of freeform text names no travel destination.
        console.log(chalk.dim("  No destinations matched."));
        console.log(chalk.dim("  Try a broader or differently-spelled query, or plan with a freeform name:"));
        console.log(chalk.dim("    voyagier plan-trip --destination \"<name>\" ..."));
        return;
      }
      for (const d of results) console.log(formatDestinationLine(d));
      console.log(
        chalk.dim(`\n${results.length} candidate${results.length === 1 ? "" : "s"} · use one with: voyagier plan-trip --destination-id <id>`),
      );
    });
}
