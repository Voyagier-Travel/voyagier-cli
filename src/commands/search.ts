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
    .option("--cabin <class>", "Cabin class: economy, business, first", "economy")
    .action(async (opts) => {
      try {
        console.log(chalk.dim("Searching flights..."));
        const client = await createMcpClient();

        const args: Record<string, unknown> = {
          title: `Flight search: ${opts.from} → ${opts.to}`,
          origin: opts.from.toUpperCase(),
          destination: opts.to.toUpperCase(),
          departureDate: opts.date,
          travellers: buildTravellers(parseInt(opts.passengers, 10)),
          searchFlights: true,
          searchHotels: false,
        };
        if (opts.return) args.returnDate = opts.return;
        if (opts.cabin) args.cabinClass = opts.cabin;

        const result = await callTool(client, "voyagier_plan_trip", args);

        if (result.isError) {
          const errText = result.content[0]?.text ?? "Unknown error";
          console.error(chalk.red(`\nSearch failed: ${errText}`));
          return;
        }

        const data = parseToolResult(result);
        const flights = (data?.flights ?? []) as Array<Record<string, unknown>>;

        if (flights.length === 0) {
          console.log(chalk.dim("\nNo flights found for this route and date."));
        } else {
          console.log(chalk.bold(`\n${flights.length} flight option${flights.length > 1 ? "s" : ""} found:\n`));
          console.log(formatFlights(flights));
        }

        if (data?.tripPlanId) {
          console.log(chalk.dim(`\nTrip plan: ${data.tripPlanId}`));
          console.log(chalk.dim(`Select a flight: voyagier tools call voyagier_select_flight '{"tripPlanId":"${data.tripPlanId}","optionId":"<id>"}'`));
        }

        await client.close();
      } catch (err) {
        handleSearchError(err);
      }
    });

  search
    .command("hotels")
    .description("Search for hotels")
    .requiredOption("--location <place>", "Destination (city or airport code)")
    .requiredOption("--checkin <date>", "Check-in date (YYYY-MM-DD)")
    .requiredOption("--checkout <date>", "Check-out date (YYYY-MM-DD)")
    .option("--guests <n>", "Number of guests", "1")
    .option("--rooms <n>", "Number of rooms", "1")
    .action(async (opts) => {
      try {
        console.log(chalk.dim("Searching hotels..."));
        const client = await createMcpClient();

        const args: Record<string, unknown> = {
          title: `Hotel search: ${opts.location}`,
          destination: opts.location,
          checkInDate: opts.checkin,
          checkOutDate: opts.checkout,
          travellers: buildTravellers(parseInt(opts.guests, 10)),
          searchFlights: false,
          searchHotels: true,
          rooms: parseInt(opts.rooms, 10),
        };

        const result = await callTool(client, "voyagier_plan_trip", args);

        if (result.isError) {
          const errText = result.content[0]?.text ?? "Unknown error";
          console.error(chalk.red(`\nSearch failed: ${errText}`));
          return;
        }

        const data = parseToolResult(result);
        const hotels = (data?.hotels ?? []) as Array<Record<string, unknown>>;

        if (hotels.length === 0) {
          console.log(chalk.dim("\nNo hotels found for this location and dates."));
        } else {
          console.log(chalk.bold(`\n${hotels.length} hotel option${hotels.length > 1 ? "s" : ""} found:\n`));
          console.log(formatHotels(hotels));
        }

        if (data?.tripPlanId) {
          console.log(chalk.dim(`\nTrip plan: ${data.tripPlanId}`));
        }

        await client.close();
      } catch (err) {
        handleSearchError(err);
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
    console.error(chalk.red("Authentication failed. Check your token: voyagier auth status"));
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    console.error(chalk.red("Could not connect to API. Check your API URL: voyagier auth status"));
  } else {
    console.error(chalk.red(`Search error: ${message}`));
  }
}
