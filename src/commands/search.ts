import { Command } from "commander";
import chalk from "chalk";
import { createMcpClient, callTool } from "../mcp.js";
import { formatFlights, formatHotels } from "../formatters.js";

export function registerSearchCommands(program: Command): void {
  const search = program.command("search").description("Search flights and hotels");

  search
    .command("flights")
    .description("Search for flights")
    .requiredOption("--from <code>", "Origin airport code (e.g., LAX)")
    .requiredOption("--to <code>", "Destination airport code (e.g., NRT)")
    .requiredOption("--date <date>", "Departure date (YYYY-MM-DD)")
    .option("--return <date>", "Return date (YYYY-MM-DD)")
    .option("--passengers <n>", "Number of passengers", "1")
    .action(async (opts) => {
      let client;
      try {
        console.log(chalk.dim("Searching flights..."));
        client = await createMcpClient();

        const args: Record<string, unknown> = {
          title: `Flight: ${opts.from.toUpperCase()} → ${opts.to.toUpperCase()}`,
          travellers: buildTravellers(parseInt(opts.passengers, 10)),
          flights: [
            {
              origin: opts.from.toUpperCase(),
              destination: opts.to.toUpperCase(),
              departureDate: opts.date,
              returnDate: opts.return,
            },
          ],
        };

        const result = await callTool(client, "voyagier_plan_trip", args);

        if (result.isError) {
          const errText = result.content[0]?.text ?? "Unknown error";
          console.error(chalk.red(`\nSearch failed: ${errText}`));
          return;
        }

        const data = parseToolResult(result);
        const flightGroups = (data?.flights ?? []) as Array<Record<string, unknown>>;

        // Each flight group has options array
        const allOptions: Array<Record<string, unknown>> = [];
        let selectionId: string | undefined;
        for (const group of flightGroups) {
          if (!selectionId && typeof group.selectionId === "string") {
            selectionId = group.selectionId;
          }
          const opts = (group.options ?? []) as Array<Record<string, unknown>>;
          allOptions.push(...opts);
        }

        if (allOptions.length === 0) {
          console.log(chalk.dim("\nNo flights found for this route and date."));
        } else {
          console.log(chalk.bold(`\n${allOptions.length} flight option${allOptions.length > 1 ? "s" : ""} found:\n`));
          console.log(formatFlights(allOptions));
        }

        if (data?.tripPlanId) {
          console.log(chalk.dim(`\nTrip plan: ${data.tripPlanId}`));
        }
        if (selectionId) {
          console.log(chalk.dim(`Selection: ${selectionId}`));
          console.log(chalk.dim(`Select: voyagier tools call voyagier_select_flight '{"selectionId":"${selectionId}","optionId":"<id>"}'`));
        }

      } catch (err) {
        handleSearchError(err);
      } finally {
        await client?.close();
      }
    });

  search
    .command("hotels")
    .description("Search for hotels")
    .requiredOption("--location <place>", "Destination (city or airport code)")
    .requiredOption("--checkin <date>", "Check-in date (YYYY-MM-DD)")
    .requiredOption("--checkout <date>", "Check-out date (YYYY-MM-DD)")
    .option("--guests <n>", "Number of guests", "1")
    .action(async (opts) => {
      let client;
      try {
        console.log(chalk.dim("Searching hotels..."));
        client = await createMcpClient();

        const adults = parseInt(opts.guests, 10);
        const args: Record<string, unknown> = {
          title: `Hotel: ${opts.location}`,
          travellers: buildTravellers(adults),
          hotels: [
            {
              location: opts.location,
              checkInDate: opts.checkin,
              checkOutDate: opts.checkout,
              adults,
            },
          ],
        };

        const result = await callTool(client, "voyagier_plan_trip", args);

        if (result.isError) {
          const errText = result.content[0]?.text ?? "Unknown error";
          console.error(chalk.red(`\nSearch failed: ${errText}`));
          return;
        }

        const data = parseToolResult(result);
        const hotelGroups = (data?.hotels ?? []) as Array<Record<string, unknown>>;

        const allOptions: Array<Record<string, unknown>> = [];
        let selectionId: string | undefined;
        for (const group of hotelGroups) {
          if (!selectionId && typeof group.selectionId === "string") {
            selectionId = group.selectionId;
          }
          const opts = (group.options ?? []) as Array<Record<string, unknown>>;
          allOptions.push(...opts);
        }

        if (allOptions.length === 0) {
          console.log(chalk.dim("\nNo hotels found for this location and dates."));
        } else {
          console.log(chalk.bold(`\n${allOptions.length} hotel option${allOptions.length > 1 ? "s" : ""} found:\n`));
          console.log(formatHotels(allOptions));
        }

        if (data?.tripPlanId) {
          console.log(chalk.dim(`\nTrip plan: ${data.tripPlanId}`));
        }
        if (selectionId) {
          console.log(chalk.dim(`Selection: ${selectionId}`));
          console.log(chalk.dim(`Select: voyagier tools call voyagier_select_hotel '{"selectionId":"${selectionId}","optionId":"<id>"}'`));
        }
      } catch (err) {
        handleSearchError(err);
      } finally {
        await client?.close();
      }
    });
}

function buildTravellers(count: number): Array<{ firstName: string; lastName: string }> {
  return Array.from({ length: count }, (_, i) => ({
    firstName: `Traveller`,
    lastName: `${i + 1}`,
  }));
}

function parseToolResult(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> | null {
  const textPart = result.content.find((c) => c.type === "text" && c.text);
  if (!textPart?.text) return null;
  try {
    return JSON.parse(textPart.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function handleSearchError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("401") || message.includes("Unauthorized")) {
    console.error(chalk.red("Authentication failed. Check your token: voyagier auth status\n  Need a token? Run: voyagier auth setup"));
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    console.error(chalk.red("Could not connect to API. Check your connection: voyagier auth status"));
  } else {
    console.error(chalk.red(`Search error: ${message}`));
  }
}
