import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { loadSearchState, saveSearchState, clearSearchState, isSearchStateStale } from "../state.js";
import { formatFlights } from "../formatters.js";
import { extractFlightToken, buildFlightSummary, deriveBaseUrl } from "../utils.js";
import { hintFlightSelected, hintHotelSelected } from "../hints.js";
import { progress, warn, fatal, jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";

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
    .option("--selection-id <id>", "Explicit selection ID (direct mode, skips state file)")
    .option("--option-id <id>", "Explicit option ID (for hotels and one-way flights)")
    .option("--flight-token <token>", "Explicit flight token (for round-trip flights)")
    .option("--phase <phase>", "departure or return (required with --flight-token)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (number: string | undefined, opts) => {
      if (opts.clear) {
        clearSearchState();
        if (!opts.json) console.log(chalk.green("✓ Search cache cleared."));
        else process.stdout.write(JSON.stringify({ cleared: true }) + "\n");
        return;
      }

      // Direct mode: --selection-id + (--option-id or --flight-token)
      if (opts.selectionId && !opts.optionId && !opts.flightToken) {
        throw new CliError(CliErrorCode.VALIDATION, "--selection-id requires --option-id or --flight-token for direct mode.");
      }
      if (opts.selectionId && (opts.optionId || opts.flightToken)) {
        try {
          if (opts.flightToken) {
            // Round-trip flight via explicit token
            if (opts.phase === "departure") {
              if (!opts.json) progress("Selecting departure flight...");
              const data = await graphql<{ selectDepartureFlight: FlightSelectionResponse }>(
                `mutation SelectDeparture($selectionId: String!, $flightToken: String!) {
                  selectDepartureFlight(selectionId: $selectionId, flightToken: $flightToken) {
                    id
                    options { id name price time airline duration bookingData }
                  }
                }`,
                { selectionId: opts.selectionId, flightToken: opts.flightToken }
              );
              const returnOptions = data.selectDepartureFlight.options;
              if (opts.json) {
                jsonOutput({
                  success: true,
                  type: "departure_selected",
                  selectionId: opts.selectionId,
                  returnOptions,
                });
              } else if (opts.agent) {
                const lines = [
                  "✅ **Departure flight selected.**",
                  "",
                  "**Next:** Select your return flight with `voyagier select <number>`",
                ];
                process.stdout.write(lines.join("\n") + "\n");
              } else {
                console.log(chalk.green("✓ Departure flight selected."));
                console.log(hintFlightSelected());
              }
            } else if (opts.phase === "return") {
              if (!opts.json) progress("Selecting return flight...");
              await graphql<{ selectReturnFlight: FlightSelectionResponse }>(
                `mutation SelectReturn($selectionId: String!, $flightToken: String!) {
                  selectReturnFlight(selectionId: $selectionId, flightToken: $flightToken) {
                    id
                    options { id name price time airline duration bookingData }
                  }
                }`,
                { selectionId: opts.selectionId, flightToken: opts.flightToken }
              );
              if (opts.json) {
                jsonOutput({
                  success: true,
                  type: "return_selected",
                  selectionId: opts.selectionId,
                });
              } else if (opts.agent) {
                process.stdout.write("✅ **Return flight selected.**\n");
              } else {
                console.log(chalk.green("✓ Return flight selected."));
                console.log(hintFlightSelected());
              }
            } else {
              throw new CliError(CliErrorCode.VALIDATION, "--phase departure|return required with --flight-token");
            }
          } else {
            // Hotel or one-way flight via explicit option ID
            if (!opts.json) progress("Selecting option...");
            const data = await graphql<{ setTripPlanSelectedOption: SelectionResponse }>(
              `mutation SetSelected($selectionId: String!, $optionId: String!) {
                setTripPlanSelectedOption(selectionId: $selectionId, optionId: $optionId) {
                  id
                  selectedOption { id name price }
                }
              }`,
              { selectionId: opts.selectionId, optionId: opts.optionId }
            );
            const result = data.setTripPlanSelectedOption;
            if (opts.json) {
              jsonOutput({
                success: true,
                type: "option_selected",
                selectionId: result.id,
                selected: result.selectedOption ?? null,
              });
            } else if (opts.agent) {
              const name = result.selectedOption?.name ?? opts.optionId;
              process.stdout.write(`✅ **Selected:** ${name}\n`);
            } else {
              const name = result.selectedOption?.name ?? opts.optionId;
              console.log(chalk.green(`✓ Selected: ${name}`));
              console.log(hintHotelSelected());
            }
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(CliErrorCode.API_ERROR, `Selection failed: ${message}`);
        }
        return;
      }

      // Indexed mode: use state file
      const state = loadSearchState();
      if (!state) {
        fatal("No search results cached. Run a search first:\n  voyagier search flights --plan <id> --from LAX --to NRT --date 2026-04-15");
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
          if (result.flightToken) console.log(chalk.dim(`  Flight Token: ${result.flightToken}`));
        }
        return;
      }

      // Selection mode
      if (!number) {
        throw new CliError(CliErrorCode.VALIDATION, `Please specify an option number: voyagier select <number>\n  Available: 1-${state.results.length}`);
      }

      const idx = parseInt(number, 10);
      if (isNaN(idx) || idx < 1) {
        throw new CliError(CliErrorCode.VALIDATION, `Invalid selection: "${number}". Please specify a number (1-${state.results.length}).`);
      }
      const selected = state.results.find((r) => r.index === idx);
      if (!selected) {
        const searchType = state.type === "flights" ? "flights" : "hotels";
        throw new CliError(CliErrorCode.NOT_FOUND, `No option [${idx}]. Valid range: 1-${state.results.length}\n  Tip: voyagier search ${searchType} --plan ${state.tripPlanId} ... to refresh results`);
      }

      try {
        // Round-trip flight: departure selection
        if (state.type === "flights" && state.isRoundTrip && !state.awaitingReturn) {
          if (!selected.flightToken) {
            throw new CliError(CliErrorCode.STATE_CORRUPT, "No flight token found for this option. Try refreshing your search.");
          }

          if (!opts.json) progress("Selecting departure flight...");

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
              url: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
            }, null, 2) + "\n");
          } else if (opts.agent) {
            const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`;
            const lines = [
              `✅ **Departure selected:** ${selected.summary}`,
              "",
              `👉 **Plan:** ${planUrl}`,
              "",
              "**Next:** Select your return flight with `voyagier select <number>`",
            ];
            process.stdout.write(lines.join("\n") + "\n");
          } else {
            console.log(chalk.green(`\n✓ Departure selected: ${selected.summary}`));
            console.log(hintFlightSelected());
          }

          // Save return options to state (swap origin/destination for return leg)
          const returnOrigin = state.destination;
          const returnDestination = state.origin;
          const returnResults = returnOptions.map((opt, i) => ({
            index: i + 1,
            optionId: opt.id,
            flightToken: extractFlightToken(opt.bookingData),
            summary: buildFlightSummary(opt, returnOrigin, returnDestination),
          }));

          saveSearchState({
            ...state,
            awaitingReturn: true,
            origin: returnOrigin,
            destination: returnDestination,
            results: returnResults,
            timestamp: new Date().toISOString(),
          });

          if (!opts.json && returnResults.length > 0) {
            console.log(chalk.bold(`\nNow select your return flight:\n`));
            const routeOverride = returnOrigin && returnDestination
              ? { origin: returnOrigin, destination: returnDestination }
              : undefined;
            console.log(formatFlights(returnOptions, routeOverride));
            console.log(chalk.dim(`\nRun: voyagier select <number>`));
          }
          return;
        }

        // Round-trip flight: return selection
        if (state.type === "flights" && state.awaitingReturn) {
          if (!selected.flightToken) {
            throw new CliError(CliErrorCode.STATE_CORRUPT, "No flight token found for this option. Try refreshing your search.");
          }

          if (!opts.json) progress("Selecting return flight...");

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
              url: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
            }, null, 2) + "\n");
          } else if (opts.agent) {
            const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`;
            const lines = [
              `✅ **Return flight selected:** ${selected.summary}`,
              "",
              `👉 **View & edit:** ${planUrl}`,
              "",
              `**Next steps:**`,
              `- View cart: \`voyagier cart ${state.tripPlanId}\``,
            ];
            process.stdout.write(lines.join("\n") + "\n");
          } else {
            console.log(chalk.green(`\n✓ Return flight selected: ${selected.summary}`));
            await printPlanFooter(state.tripPlanId);
            console.log(hintFlightSelected());
            console.log(chalk.dim(`  Next: voyagier plans get ${state.tripPlanId}`));
          }

          clearSearchState();
          return;
        }

        // One-way flight or hotel: generic selection
        if (!opts.json) progress("Selecting option...");

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
            url: `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`,
          }, null, 2) + "\n");
        } else if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${state.tripPlanId}`;
          const icon = state.type === "flights" ? "✈️" : "🏨";
          const lines = [
            `✅ **${icon} Selected:** ${selected.summary}`,
            "",
            `👉 **View & edit:** ${planUrl}`,
            "",
            "**Next steps:**",
            `- View cart: \`voyagier cart ${state.tripPlanId}\``,
          ];
          process.stdout.write(lines.join("\n") + "\n");
        } else {
          const icon = state.type === "flights" ? "✈️" : "🏨";
          console.log(chalk.green(`\n✓ ${icon} Selected: ${selected.summary}`));
          if (state.type === "flights") {
            console.log(hintFlightSelected());
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
