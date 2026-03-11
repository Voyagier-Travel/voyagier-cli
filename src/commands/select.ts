import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { loadSearchState, saveSearchState, clearSearchState, isSearchStateStale } from "../state.js";
import { formatFlights } from "../formatters.js";
import { extractFlightToken, buildFlightSummary, deriveBaseUrl } from "../utils.js";
import { hintFlightSelected, hintHotelSelected } from "../hints.js";

interface SelectionResponse {
  id: string;
  selectedOption?: { id: string; name: string; price?: number };
}

interface FlightSelectionResponse {
  id: string;
  options: Array<{
    id: string;
    name: string;
    price?: number;
    time?: string;
    airline?: string;
    duration?: string;
    bookingData?: Record<string, unknown>;
  }>;
}

export function registerSelectCommands(program: Command): void {
  program
    .command("select [number]")
    .description("Select an option from the last search results")
    .option("--info <n>", "Show full details for option N without selecting")
    .option("--clear", "Clear cached search results")
    .option("--json", "Output raw JSON")
    .action(async (number: string | undefined, opts) => {
      if (opts.clear) {
        clearSearchState();
        if (!opts.json) console.log(chalk.green("✓ Search cache cleared."));
        else process.stdout.write(JSON.stringify({ cleared: true }) + "\n");
        return;
      }

      const state = loadSearchState();
      if (!state) {
        process.stderr.write(chalk.red("No search results cached. Run a search first:\n"));
        process.stderr.write(chalk.dim("  voyagier search flights --plan <id> --from LAX --to NRT --date 2026-04-15\n"));
        process.exit(1);
      }

      if (isSearchStateStale(state)) {
        process.stderr.write(chalk.yellow("⚠ Search results are over 2 hours old and may have expired.\n"));
        process.stderr.write(chalk.dim("  Re-run your search for current pricing.\n\n"));
      }

      // --info mode: show details without selecting
      const infoIdx = opts.info ? parseInt(opts.info, 10) : null;
      if (infoIdx !== null) {
        const result = state.results.find((r) => r.index === infoIdx);
        if (!result) {
          process.stderr.write(chalk.red(`No option [${infoIdx}]. Valid range: 1-${state.results.length}\n`));
          process.exit(1);
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          console.log(chalk.bold(`\nOption [${infoIdx}]:`));
          console.log(`  ${result.summary}`);
          console.log(chalk.dim(`  Option ID: ${result.optionId}`));
          if (result.flightToken) console.log(chalk.dim(`  Flight Token: ${result.flightToken}`));
        }
        return;
      }

      // Selection mode
      if (!number) {
        process.stderr.write(chalk.red("Please specify an option number: voyagier select <number>\n"));
        process.stderr.write(chalk.dim(`  Available: 1-${state.results.length}\n`));
        process.exit(1);
      }

      const idx = parseInt(number, 10);
      const selected = state.results.find((r) => r.index === idx);
      if (!selected) {
        process.stderr.write(chalk.red(`No option [${idx}]. Valid range: 1-${state.results.length}\n`));
        process.exit(1);
      }

      try {
        // Round-trip flight: departure selection
        if (state.type === "flights" && state.isRoundTrip && !state.awaitingReturn) {
          if (!selected.flightToken) {
            process.stderr.write(chalk.red("No flight token found for this option. Try refreshing your search.\n"));
            process.exit(1);
          }

          if (!opts.json) process.stderr.write(chalk.dim("Selecting departure flight...\n"));

          const data = await graphql<{ selectDepartureFlight: FlightSelectionResponse }>(
            `mutation SelectDeparture($selectionId: String!, $flightToken: String!) {
              selectDepartureFlight(selectionId: $selectionId, flightToken: $flightToken) {
                id
                options { id name price time airline duration bookingData }
              }
            }`,
            { selectionId: state.selectionId, flightToken: selected.flightToken }
          );

          const returnOptions = data.selectDepartureFlight.options;

          if (opts.json) {
            process.stdout.write(JSON.stringify({
              success: true,
              type: "departure_selected",
              selected: selected.summary,
              returnOptions,
              tripPlanUrl: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
            }, null, 2) + "\n");
          } else {
            console.log(chalk.green(`\n✓ Departure selected: ${selected.summary}`));
            console.log(hintFlightSelected());
          }

          // Save return options to state
          const returnResults = returnOptions.map((opt, i) => ({
            index: i + 1,
            optionId: opt.id,
            flightToken: extractFlightToken(opt.bookingData),
            summary: buildFlightSummary(opt),
          }));

          saveSearchState({
            ...state,
            awaitingReturn: true,
            results: returnResults,
            timestamp: new Date().toISOString(),
          });

          if (!opts.json && returnResults.length > 0) {
            console.log(chalk.bold(`\nNow select your return flight:\n`));
            console.log(formatFlights(returnOptions));
            console.log(chalk.dim(`\nRun: voyagier select <number>`));
          }
          return;
        }

        // Round-trip flight: return selection
        if (state.type === "flights" && state.awaitingReturn) {
          if (!selected.flightToken) {
            process.stderr.write(chalk.red("No flight token found for this option. Try refreshing your search.\n"));
            process.exit(1);
          }

          if (!opts.json) process.stderr.write(chalk.dim("Selecting return flight...\n"));

          await graphql<{ selectReturnFlight: FlightSelectionResponse }>(
            `mutation SelectReturn($selectionId: String!, $flightToken: String!) {
              selectReturnFlight(selectionId: $selectionId, flightToken: $flightToken) {
                id
                options { id name price time airline duration bookingData }
              }
            }`,
            { selectionId: state.selectionId, flightToken: selected.flightToken }
          );

          if (opts.json) {
            process.stdout.write(JSON.stringify({
              success: true,
              type: "return_selected",
              selected: selected.summary,
              tripPlanUrl: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
            }, null, 2) + "\n");
          } else {
            console.log(chalk.green(`\n✓ Return flight selected: ${selected.summary}`));
            console.log(chalk.dim(`\n  Plan: ${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`));
            console.log(hintFlightSelected());
            console.log(chalk.dim(`  Next: voyagier plans get ${state.tripPlanId}`));
          }

          clearSearchState();
          return;
        }

        // One-way flight or hotel: generic selection
        if (!opts.json) process.stderr.write(chalk.dim("Selecting option...\n"));

        const data = await graphql<{ setTripPlanSelectedOption: SelectionResponse }>(
          `mutation SetSelected($selectionId: String!, $optionId: String!) {
            setTripPlanSelectedOption(selectionId: $selectionId, optionId: $optionId) {
              id
              selectedOption { id name price }
            }
          }`,
          { selectionId: state.selectionId, optionId: selected.optionId }
        );

        const result = data.setTripPlanSelectedOption;

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            success: true,
            type: state.type === "flights" ? "flight_selected" : "hotel_selected",
            selected: selected.summary,
            selectionId: result.id,
            tripPlanUrl: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
          }, null, 2) + "\n");
        } else {
          const icon = state.type === "flights" ? "✈️" : "🏨";
          console.log(chalk.green(`\n✓ ${icon} Selected: ${selected.summary}`));
          if (state.type === "flights") {
            console.log(hintFlightSelected());
          } else {
            console.log(hintHotelSelected());
          }
          console.log(chalk.dim(`\n  Plan: ${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`));
          console.log(chalk.dim(`  Next: voyagier plans get ${state.tripPlanId}`));
        }

        clearSearchState();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Selection failed: ${message}\n`));
        process.exit(1);
      }
    });
}




