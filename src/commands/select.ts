import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { SET_TRIP_PLAN_SELECTED_OPTION } from "../queries.js";
import { loadSearchState, clearSearchState, isSearchStateStale } from "../state.js";
import { deriveBaseUrl } from "../utils.js";
import { hintFlightSelected, hintHotelSelected } from "../hints.js";
import { progress, warn, fatal, jsonOutput, jsonOutputWithPlan } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";

/**
 * `select` — choose an option on a selection.
 *
 * Collapsed in VOY-1414 to ONE verb over `setTripPlanSelectedOption`. The old
 * `selectDepartureFlight` / `selectReturnFlight` two-phase round-trip token
 * dance was deleted server-side in the Goals/Blueprint migration: every leg /
 * journey is now an ordinary selection whose chosen option is set the same way.
 * The chosen option is reported as `parentOption` / `parentOptionId` (the old
 * `selectedOption` field is gone).
 */

interface SelectionResponse {
  id: string;
  parentOptionId?: string | null;
  parentOption?: { id: string; name: string; price?: number } | null;
}

async function setSelectedOption(selectionId: string, optionId: string): Promise<SelectionResponse> {
  const data = await graphql<{ setTripPlanSelectedOption: SelectionResponse }>(
    SET_TRIP_PLAN_SELECTED_OPTION,
    { selectionId, optionId },
  );
  return data.setTripPlanSelectedOption;
}

export function registerSelectCommands(program: Command): void {
  program
    .command("select [number]")
    .description("Select an option on a selection (by --selection-id + --option-id, or by index from the last search)")
    .option("--info <n>", "Show full details for option N without selecting")
    .option("--clear", "Clear cached search results")
    .option("--selection-id <id>", "Explicit selection ID (direct mode)")
    .option("--option-id <id>", "Explicit option ID (direct mode)")
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
          const result = await setSelectedOption(opts.selectionId, opts.optionId);
          const name = result.parentOption?.name ?? opts.optionId;
          if (opts.json) {
            jsonOutput({
              success: true,
              type: "option_selected",
              selectionId: result.id,
              selected: result.parentOption ?? null,
              parentOptionId: result.parentOptionId ?? null,
            });
          } else if (opts.agent) {
            process.stdout.write(`✅ **Selected:** ${name}\n`);
          } else {
            console.log(chalk.green(`✓ Selected: ${name}`));
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
        const result = await setSelectedOption(state.selectionId, selected.optionId);

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
              parentOptionId: result.parentOptionId ?? null,
              url: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
            },
            state.tripPlanId,
          );
        } else if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`;
          const icon = state.type === "flights" ? "✈️" : state.type === "activities" ? "🎯" : "🏨";
          process.stdout.write(
            [
              `✅ **${icon} Selected:** ${selected.summary}`,
              "",
              `👉 **View & edit:** ${planUrl}`,
              "",
              "**Next steps:**",
              `- View cart: \`voyagier cart ${state.tripPlanId}\``,
            ].join("\n") + "\n",
          );
        } else {
          const icon = state.type === "flights" ? "✈️" : state.type === "activities" ? "🎯" : "🏨";
          console.log(chalk.green(`\n✓ ${icon} Selected: ${selected.summary}`));
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
