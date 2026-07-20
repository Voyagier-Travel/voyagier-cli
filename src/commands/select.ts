import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import {
  SET_TRIP_PLAN_SELECTED_OPTION,
  SET_TRAVELLER_CHOICE_FOR_SUBSET,
  SET_TRAVELLER_CHOICE_FOR_GROUP,
  SET_SELECTION_TRAVELLER_CHOICE,
} from "../queries.js";
import { loadSearchState, clearSearchState, isSearchStateStale } from "../state.js";
import { deriveBaseUrl } from "../utils.js";
import { hintFlightSelected, hintHotelSelected } from "../hints.js";
import { progress, warn, fatal, jsonOutput, jsonOutputWithPlan } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";

/**
 * `select` — choose an option on a selection.
 *
 * ONE verb (VOY-1414), now scope-aware (VOY-1692). Since the participant-choice
 * migration the backend records picks as per-traveller choices:
 *   - default            -> setTripPlanSelectedOption (alias for "for ALL travellers")
 *   - --travellers a,b   -> setTripPlanTravellerChoiceForSubset (replaceExisting)
 *   - --group <id>       -> setTripPlanTravellerChoiceForGroup
 *   - --traveller <id>   -> setTripPlanSelectionTravellerChoice (one traveller)
 *
 * Picks land on a goal's SINGLE decision selection (list-mode selections are
 * rejected server-side), and the option must come from that selection's own
 * options (which resolve from its direct mirrored list) — use
 * `selection-options <selectionId>` to list them.
 */

interface SelectionResponse {
  id: string;
  parentOptionId?: string | null;
  parentOption?: { id: string; name: string; price?: number } | null;
}

interface ChoiceScopeOpts {
  traveller?: string;
  travellers?: string;
  group?: string;
}

/** Human label for the scope a pick applies to (used in success output). */
function scopeLabel(scope: ChoiceScopeOpts): string {
  if (scope.traveller) return `for traveller ${scope.traveller}`;
  if (scope.travellers) return `for ${scope.travellers.split(",").filter((s) => s.trim()).length} traveller(s)`;
  if (scope.group) return `for group ${scope.group}`;
  return "for all travellers";
}

async function setSelectedOption(
  selectionId: string,
  optionId: string,
  scope: ChoiceScopeOpts = {},
): Promise<SelectionResponse> {
  const set = [scope.traveller, scope.travellers, scope.group].filter(Boolean);
  if (set.length > 1) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "Use at most ONE of --traveller, --travellers, --group (they are mutually exclusive scopes).",
    );
  }
  try {
    if (scope.traveller) {
      const data = await graphql<{ setTripPlanSelectionTravellerChoice: SelectionResponse }>(
        SET_SELECTION_TRAVELLER_CHOICE,
        { selectionId, travellerId: scope.traveller, optionId },
      );
      return data.setTripPlanSelectionTravellerChoice;
    }
    if (scope.travellers) {
      const travellerIds = scope.travellers.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (travellerIds.length === 0) {
        throw new CliError(CliErrorCode.VALIDATION, "--travellers requires a comma-separated list of traveller IDs.");
      }
      const data = await graphql<{ setTripPlanTravellerChoiceForSubset: SelectionResponse }>(
        SET_TRAVELLER_CHOICE_FOR_SUBSET,
        { selectionId, travellerIds, optionId, replaceExisting: true },
      );
      return data.setTripPlanTravellerChoiceForSubset;
    }
    if (scope.group) {
      const data = await graphql<{ setTripPlanTravellerChoiceForGroup: SelectionResponse }>(
        SET_TRAVELLER_CHOICE_FOR_GROUP,
        { selectionId, groupId: scope.group, optionId },
      );
      return data.setTripPlanTravellerChoiceForGroup;
    }
    const data = await graphql<{ setTripPlanSelectedOption: SelectionResponse }>(
      SET_TRIP_PLAN_SELECTED_OPTION,
      { selectionId, optionId },
    );
    return data.setTripPlanSelectedOption;
  } catch (err) {
    throw mapChoiceError(err, selectionId);
  }
}

/**
 * Translate the backend's two participant-choice signature errors into
 * actionable guidance instead of leaking raw GraphQL messages (VOY-1692).
 */
function mapChoiceError(err: unknown, selectionId: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("list-mode selection")) {
    return new CliError(
      CliErrorCode.API_ERROR,
      `Selection ${selectionId} is a LIST selection (inventory source) — picks are rejected there.\n` +
        `  Choose on the goal's single DECISION selection instead:\n` +
        `    voyagier plans goals <planId> --tree   # find the decision selection (e.g. type Flight, not FlightList/FlightJourney)\n` +
        `    voyagier selection-options <decisionSelectionId>   # its options\n` +
        `    voyagier select --selection-id <decisionSelectionId> --option-id <id>`,
    );
  }
  if (message.includes("Option not found or does not belong")) {
    return new CliError(
      CliErrorCode.API_ERROR,
      `That option does not belong to selection ${selectionId} (the backend only accepts options from the selection itself or its direct mirrored list).\n` +
        `  List THIS selection's options and pick one of those IDs:\n` +
        `    voyagier selection-options ${selectionId} --wait --json`,
    );
  }
  return err;
}

export function registerSelectCommands(program: Command): void {
  program
    .command("select [number]")
    .description("Select an option on a selection (by --selection-id + --option-id, or by index from the last search)")
    .option("--info <n>", "Show full details for option N without selecting")
    .option("--clear", "Clear cached search results")
    .option("--selection-id <id>", "Explicit selection ID (direct mode)")
    .option("--option-id <id>", "Explicit option ID (direct mode)")
    .option("--traveller <id>", "Choose for ONE traveller only")
    .option("--travellers <ids>", "Choose for a subset of travellers (comma-separated IDs; replaces their existing choices)")
    .option("--group <groupId>", "Choose for a traveller group")
    .option("--plan <id>", "Assert that cached results belong to this trip plan (safety check for agent mode)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (number: string | undefined, opts) => {
      if (opts.clear) {
        clearSearchState();
        if (!opts.json) console.log(chalk.green("✓ Search cache cleared."));
        else process.stdout.write(JSON.stringify({ cleared: true }) + "\n");
        return;
      }

      // ── Direct mode: --selection-id + --option-id ───────────────────────
      if (opts.selectionId || opts.optionId) {
        if (!opts.selectionId || !opts.optionId) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            "Direct mode requires BOTH --selection-id and --option-id.",
          );
        }
        try {
          if (!opts.json) progress("Selecting option...");
          const result = await setSelectedOption(opts.selectionId, opts.optionId, opts);
          const name = result.parentOption?.name ?? opts.optionId;
          const forScope = scopeLabel(opts);
          if (opts.json) {
            jsonOutput({
              success: true,
              type: "option_selected",
              selectionId: result.id,
              scope: forScope,
              selected: result.parentOption ?? null,
              parentOptionId: result.parentOptionId ?? null,
            });
          } else if (opts.agent) {
            process.stdout.write(`✅ **Selected** (${forScope})**:** ${name}\n`);
          } else {
            console.log(chalk.green(`✓ Selected ${forScope}: ${name}`));
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(CliErrorCode.API_ERROR, `Selection failed: ${message}`);
        }
        return;
      }

      // ── Indexed mode: use last-search state ─────────────────────────────
      const state = loadSearchState();
      if (!state) {
        fatal(
          "No search results cached. Run a search first, or use direct mode:\n  voyagier select --selection-id <id> --option-id <id>",
        );
        return;
      }

      if (opts.plan && state.tripPlanId !== opts.plan) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Plan mismatch: cached results belong to plan ${state.tripPlanId}, not ${opts.plan}. Re-run your search with --plan ${opts.plan}.`,
        );
      }

      if (isSearchStateStale(state)) {
        warn("Search results are over 2 hours old and may have expired.");
        progress("  Re-run your search for current pricing.\n");
      }

      // --info mode: show details without selecting
      const infoIdx = opts.info ? parseInt(opts.info, 10) : null;
      if (infoIdx !== null) {
        const result = state.results.find((r) => r.index === infoIdx);
        if (!result) {
          throw new CliError(CliErrorCode.NOT_FOUND, `No option [${infoIdx}]. Valid range: 1-${state.results.length}`);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          console.log(chalk.bold(`\nOption [${infoIdx}]:`));
          console.log(`  ${result.summary}`);
          console.log(chalk.dim(`  Option ID: ${result.optionId}`));
        }
        return;
      }

      if (!number) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Please specify an option number: voyagier select <number>\n  Available: 1-${state.results.length}`,
        );
      }

      const idx = parseInt(number, 10);
      if (isNaN(idx) || idx < 1) {
        throw new CliError(CliErrorCode.VALIDATION, `Invalid selection: "${number}". Please specify a number (1-${state.results.length}).`);
      }
      const selected = state.results.find((r) => r.index === idx);
      if (!selected) {
        const searchType = state.type === "flights" ? "flights" : state.type === "activities" ? "activities" : "hotels";
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `No option [${idx}]. Valid range: 1-${state.results.length}\n  Tip: voyagier search ${searchType} --plan ${state.tripPlanId} ... to refresh results`,
        );
      }

      try {
        if (!opts.json) progress("Selecting option...");
        const result = await setSelectedOption(state.selectionId, selected.optionId, opts);

        if (opts.json) {
          jsonOutputWithPlan(
            {
              success: true,
              type:
                state.type === "flights"
                  ? "flight_selected"
                  : state.type === "activities"
                    ? "activity_selected"
                    : "hotel_selected",
              selected: selected.summary,
              selectionId: result.id,
              ...(state.type === "flights" && state.returnSelectionId
                ? { returnSelectionId: state.returnSelectionId, note: "Round trip: choose on returnSelectionId too." }
                : {}),
              parentOptionId: result.parentOptionId ?? null,
              url: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
            },
            state.tripPlanId,
          );
        } else if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`;
          const icon = state.type === "flights" ? "✈️" : state.type === "activities" ? "🎯" : "🏨";
          const nextSteps = [
            ...(state.type === "flights" && state.returnSelectionId
              ? [
                  `- Choose the RETURN leg too: \`voyagier select --selection-id ${state.returnSelectionId} --option-id <id>\` (options: \`voyagier selection-options ${state.returnSelectionId} --json\`)`,
                ]
              : []),
            `- View cart: \`voyagier cart ${state.tripPlanId}\``,
          ];
          process.stdout.write(
            [
              `✅ **${icon} Selected:** ${selected.summary}`,
              "",
              `👉 **View & edit:** ${planUrl}`,
              "",
              "**Next steps:**",
              ...nextSteps,
            ].join("\n") + "\n",
          );
        } else {
          const icon = state.type === "flights" ? "✈️" : state.type === "activities" ? "🎯" : "🏨";
          console.log(chalk.green(`\n✓ ${icon} Selected: ${selected.summary}`));
          if (state.type === "flights" && state.returnSelectionId) {
            console.log(chalk.dim(`  Round trip: also choose the return leg — voyagier select --selection-id ${state.returnSelectionId} --option-id <id>`));
          }
          if (state.type === "flights") {
            console.log(hintFlightSelected());
          } else if (state.type === "activities") {
            console.log(chalk.dim("  💡 Activity details and timing can be adjusted after booking."));
          } else {
            console.log(hintHotelSelected());
          }
          await printPlanFooter(state.tripPlanId);
          console.log(chalk.dim(`  Next: voyagier plans get ${state.tripPlanId}`));
        }

        clearSearchState();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Selection failed: ${message}`);
      }
    });
}
