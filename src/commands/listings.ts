/**
 * Listings command surface (v2.0.0).
 *
 * Backed by Blueprint Listings — the advisor-inventory escape hatch. STABLE per
 * Phase 0 schema audit (PHASE2-DESIGN-FREEZE.md Section 7).
 *
 * Surface:
 *   voyagier listings recent --selection <id> [--type <changeType>] [--limit <n>] [--json] [--agent]
 *   voyagier listings add-to-selection <selectionId> --listing <listingId> [--json] [--agent]
 *
 * Schema correction: The original CLI-REFACTOR-PLAN proposed `listings search --type --location`
 * but the schema only exposes blueprintListingChangeEvents scoped to a blueprintMonitorId.
 * Surface adjusted to `listings recent`. Logged as P3 question for Mark sync.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { parsePositiveInt, formatPrice, formatNullableBool, escapeMdTableCell, shellArg } from "../utils.js";
import {
  GET_BLUEPRINT_LISTING_CHANGE_EVENTS,
  GET_BLUEPRINT_LISTING_CHANGE_EVENTS_BY_TYPE,
  ADD_BLUEPRINT_LISTING_AS_SELECTION_OPTION,
  GET_SELECTION_WITH_MONITOR,
} from "../queries.js";

// ----- Types -----

export interface BlueprintListing {
  id: string;
  name?: string | null;
  price?: number | null;
  isAvailable?: boolean | null;
  isBookable?: boolean | null;
}

export interface BlueprintListingChangeEvent {
  id: string;
  blueprintListingId: string;
  blueprintMonitorId: string;
  listingName?: string | null;
  changeType: string;
  details?: unknown;
  blueprintListing?: BlueprintListing | null;
}

export interface TripPlanSelectOption {
  id: string;
  name?: string | null;
  price?: number | null;
  isBookable?: boolean | null;
  status?: string | null;
}

// ----- Enum normalization -----

const VALID_LISTING_CHANGE_TYPES = [
  "availability-changed",
  "listing-expired",
  "listing-restored",
  "listing-unavailable",
  "new-listing",
  "price-changed",
] as const;

const LISTING_CHANGE_TYPE_MAP: Record<string, string> = {
  "availability-changed": "AvailabilityChanged",
  "listing-expired": "ListingExpired",
  "listing-restored": "ListingRestored",
  "listing-unavailable": "ListingUnavailable",
  "new-listing": "NewListing",
  "price-changed": "PriceChanged",
};

/**
 * Normalize a CLI flag value (kebab-case/lowercase) to the GraphQL enum (PascalCase).
 * Exported for unit testing.
 */
export function normalizeListingChangeType(value: string): string {
  const lower = value.toLowerCase().trim();
  const mapped = LISTING_CHANGE_TYPE_MAP[lower];
  if (mapped) return mapped;
  if (Object.values(LISTING_CHANGE_TYPE_MAP).includes(value)) return value;
  throw new CliError(
    CliErrorCode.VALIDATION,
    `Invalid --type "${value}". Must be one of: ${VALID_LISTING_CHANGE_TYPES.join(", ")}`
  );
}

// ----- Helpers -----

function formatChangeEventLine(e: BlueprintListingChangeEvent): string {
  const typeBadge = chalk.cyan(`[${e.changeType}]`);
  const name = chalk.bold(e.listingName ?? e.blueprintListing?.name ?? "(unnamed)");
  const price = e.blueprintListing?.price != null
    ? chalk.green(formatPrice(e.blueprintListing.price))
    : "";
  // Tri-state availability: true=green, false=red, null/undefined=dim grey.
  const isAvail = e.blueprintListing?.isAvailable;
  const available =
    isAvail === true ? chalk.green("●")
    : isAvail === false ? chalk.red("○")
    : chalk.dim("?");
  return `${available} ${typeBadge} ${name}  ${price}  ${chalk.dim(e.id)}`;
}

// ----- Commands -----

export function registerListingsCommands(program: Command): void {
  const listings = program
    .command("listings")
    .description("Blueprint Listings — advisor inventory escape hatch");

  // -- recent --
  listings
    .command("recent")
    .description("List recent listing change events for a selection's monitor")
    .requiredOption("--selection <id>", "Selection ID (must have a blueprintMonitorId)")
    .option("--type <type>", "Filter by change type (availability-changed|new-listing|price-changed|...)")
    .option("--limit <n>", "Max events to return", "20")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (opts) => {
      const selectionId = opts.selection;
      // Group A: Strict validation for --limit
      const limit = parsePositiveInt(opts.limit, "--limit", { default: 20, max: 100 }) ?? 20;

      // GET_SELECTION_WITH_MONITOR is now the generic, shape-agnostic union query
      // (getTripPlanSelection(tripPlanSelectionId)); listings only needs id +
      // blueprintMonitorId, which the union returns as a superset.
      const selectionData = await graphql<{
        getTripPlanSelection: { id: string; blueprintMonitorId?: string | null } | null;
      }>(GET_SELECTION_WITH_MONITOR, { tripPlanSelectionId: selectionId });

      const selection = selectionData.getTripPlanSelection;
      if (!selection) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Selection "${selectionId}" not found.\n  Fix: voyagier selections list --plan <planId> --json`
        );
      }

      const monitorId = selection.blueprintMonitorId;
      if (!monitorId) {
        throw new CliError(
          CliErrorCode.NO_MONITOR,
          `Selection "${selectionId}" has no blueprintMonitorId. Cannot fetch listing events.\n  Fix: voyagier monitors create --selection ${shellArg(selectionId)}`
        );
      }

      let events: BlueprintListingChangeEvent[];
      if (opts.type) {
        const changeType = normalizeListingChangeType(opts.type);
        const data = await graphql<{
          blueprintListingChangeEventsByType: BlueprintListingChangeEvent[];
        }>(GET_BLUEPRINT_LISTING_CHANGE_EVENTS_BY_TYPE, {
          blueprintMonitorId: monitorId,
          changeType,
          limit,
        });
        events = data.blueprintListingChangeEventsByType ?? [];
      } else {
        const data = await graphql<{
          blueprintListingChangeEvents: BlueprintListingChangeEvent[];
        }>(GET_BLUEPRINT_LISTING_CHANGE_EVENTS, {
          blueprintMonitorId: monitorId,
          limit,
        });
        events = data.blueprintListingChangeEvents ?? [];
      }

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            events,
            total: events.length,
            monitorId,
            selectionId,
          },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Listing Change Events\n`);
        console.log(`**Selection:** \`${selectionId}\`  `);
        console.log(`**Monitor:** \`${monitorId}\`\n`);
        if (events.length === 0) {
          console.log("No recent change events.\n");
        } else {
          console.log(`| Change Type | Listing | Price | Available |`);
          console.log(`|---|---|---|---|`);
          for (const e of events) {
            const price = e.blueprintListing?.price != null
              ? formatPrice(e.blueprintListing.price)
              : "—";
            // Nullable schema field: null/undefined renders as Unknown, not No.
            const avail = formatNullableBool(e.blueprintListing?.isAvailable);
            // Listing name fallback chain matches the TTY formatter
            // (formatChangeEventLine): listingName → blueprintListing.name.
            // Escape against pipes/backticks/newlines that would corrupt the
            // markdown table.
            const name = e.listingName ?? e.blueprintListing?.name ?? null;
            console.log(
              `| ${escapeMdTableCell(e.changeType)} | ${escapeMdTableCell(name)} | ${escapeMdTableCell(price)} | ${escapeMdTableCell(avail)} |`
            );
          }
          console.log(`\n*${events.length} event(s)*`);
        }
        return;
      }

      console.log(`\n${chalk.bold("Listing Change Events")}  ${chalk.dim(`(monitor: ${monitorId})`)}\n`);
      if (events.length === 0) {
        console.log(chalk.dim("  No recent change events."));
      } else {
        for (const e of events) {
          console.log(formatChangeEventLine(e));
        }
        console.log(chalk.dim(`\n${events.length} event(s)`));
      }
    });

  // -- add-to-selection --
  listings
    .command("add-to-selection <selectionId>")
    .description("Add a Blueprint Listing as an option to a selection")
    .requiredOption("--listing <id>", "Blueprint Listing ID")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking (server-side dedup pending)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (selectionId, opts) => {
      const listingId = opts.listing;

      const data = await graphql<{
        addBlueprintListingAsSelectionOption: TripPlanSelectOption | null;
      }>(
        ADD_BLUEPRINT_LISTING_AS_SELECTION_OPTION,
        { listingId, selectionId },
        { dryRun: opts.dryRun }
      );

      const option = data.addBlueprintListingAsSelectionOption;
      if (!option) {
        throw new CliError(
          CliErrorCode.LISTING_NOT_FOUND,
          `Listing "${listingId}" could not be added. It may not exist or may be unavailable.\n  Fix: voyagier listings recent --selection ${shellArg(selectionId)}`
        );
      }

      if (opts.json) {
        // Echoed in JSON output for agent-side tracking; not yet enforced server-side
        jsonOutput({
          ok: true,
          data: { option, selectionId, idempotencyKey: opts.idempotencyKey ?? null },
        });
        return;
      }

      if (opts.agent) {
        console.log(`## Listing Added\n`);
        console.log(`**Option ID:** \`${option.id}\`  `);
        console.log(`**Name:** ${option.name ?? "—"}  `);
        console.log(`**Price:** ${option.price != null ? formatPrice(option.price) : "—"}  `);
        // Nullable schema field: null/undefined renders as Unknown, not No.
        console.log(`**Bookable:** ${formatNullableBool(option.isBookable)}\n`);
        return;
      }

      console.log(chalk.green(`✓ Added listing to selection`));
      console.log(chalk.dim(`  Option ID: ${option.id}`));
      console.log(chalk.dim(`  Name:      ${option.name ?? "—"}`));
      if (option.price != null) console.log(chalk.dim(`  Price:     ${formatPrice(option.price)}`));
      console.log(chalk.dim(`  Bookable:  ${formatNullableBool(option.isBookable)}`));
    });
}
