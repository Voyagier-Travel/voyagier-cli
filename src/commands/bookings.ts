import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { formatPrice, deriveBaseUrl } from "../utils.js";
import { getApiUrl } from "../config.js";

interface BookingRecord {
  id: string;
  type: string;
  status: string;
  pnr?: string;
  providerName?: string;
  providerReference?: string;
  amount: number;
  currency?: string;
  issueDate?: string;
  travelStartDate?: string;
  travelEndDate?: string;
  tripPlanId?: string;
  tripPlan?: { id: string; title: string };
  tripPlanItem?: { id: string; title: string };
  travellers?: Array<{ firstName: string; lastName: string }>;
}

function statusIcon(status: string): string {
  switch (status) {
    case "Confirmed": return chalk.green("✓ confirmed");
    case "Pending": return chalk.yellow("⏳ pending");
    case "Failed": return chalk.red("✗ failed");
    case "Cancelled": return chalk.red("✗ cancelled");
    default: return chalk.dim(status);
  }
}

function typeIcon(type: string): string {
  switch (type) {
    case "FlightBooking": return "✈️";
    case "HotelBooking": return "🏨";
    default: return "📦";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "FlightBooking": return "Flight";
    case "HotelBooking": return "Hotel";
    default: return type.replace(/Booking$/, "");
  }
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function registerBookingsCommands(program: Command): void {
  const bookings = program.command("bookings").description("View booking records and confirmations");

  bookings
    .command("list")
    .description("List all your bookings")
    .option("--plan <planId>", "Filter by trip plan")
    .option("--status <status>", "Filter by status: Confirmed, Pending, Failed, Cancelled")
    .option("--type <type>", "Filter by type: FlightBooking, HotelBooking")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const filters: Record<string, unknown> = {};
        if (opts.plan) filters.tripPlanId = opts.plan;
        if (opts.status) filters.status = opts.status;
        if (opts.type) filters.type = opts.type;
        if (opts.limit) filters.limit = parseInt(opts.limit, 10);

        const hasFilters = Object.keys(filters).length > 0;

        const query = hasFilters
          ? `query GetBookingRecords($filters: BookingRecordFiltersInput) {
              getBookingRecords(filters: $filters) {
                id type status pnr providerName providerReference amount currency
                issueDate travelStartDate travelEndDate tripPlanId
                tripPlan { id title }
                tripPlanItem { id title }
              }
            }`
          : `{ getBookingRecordsByUser {
              id type status pnr providerName providerReference amount currency
              issueDate travelStartDate travelEndDate tripPlanId
              tripPlan { id title }
              tripPlanItem { id title }
            } }`;

        const raw = hasFilters
          ? await graphql<{ getBookingRecords: BookingRecord[] }>(query, { filters })
          : await graphql<{ getBookingRecordsByUser: BookingRecord[] }>(query);

        const records = hasFilters
          ? (raw as { getBookingRecords: BookingRecord[] }).getBookingRecords
          : (raw as { getBookingRecordsByUser: BookingRecord[] }).getBookingRecordsByUser;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ bookings: records }, null, 2) + "\n");
          return;
        }

        if (records.length === 0) {
          console.log(chalk.dim("\n  No bookings found.\n"));
          return;
        }

        console.log(chalk.bold(`\n  📋 Bookings (${records.length})\n`));

        for (const r of records) {
          const icon = typeIcon(r.type);
          const label = typeLabel(r.type);
          const status = statusIcon(r.status);
          const amount = r.amount ? chalk.green(formatPrice(r.amount / 100)) : "";
          const pnr = r.pnr ? chalk.white(` PNR: ${r.pnr}`) : "";
          const ref = !r.pnr && r.providerReference ? chalk.dim(` Ref: ${r.providerReference}`) : "";
          const dates = r.travelStartDate
            ? chalk.dim(` ${formatDate(r.travelStartDate)}${r.travelEndDate ? ` → ${formatDate(r.travelEndDate)}` : ""}`)
            : "";
          const plan = r.tripPlan ? chalk.dim(` · ${r.tripPlan.title}`) : "";

          console.log(`  ${icon}  ${chalk.white(label)}  ${status}  ${amount}${pnr}${ref}${dates}${plan}`);
          console.log(chalk.dim(`      ID: ${r.id}`));
        }
        console.log();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to list bookings: ${message}\n`));
        process.exit(1);
      }
    });

  bookings
    .command("get <id>")
    .description("View booking record details")
    .option("--refresh", "Refresh booking status from provider")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        if (opts.refresh) {
          if (!opts.json) process.stderr.write(chalk.dim("Refreshing from provider...\n"));
          await graphql<{ refreshBookingRecord: BookingRecord }>(
            `mutation Refresh($id: String!) {
              refreshBookingRecord(id: $id) { id status }
            }`,
            { id }
          );
        }

        const data = await graphql<{ getBookingRecord: BookingRecord }>(
          `query GetBookingRecord($id: String!) {
            getBookingRecord(id: $id) {
              id type status pnr providerName providerReference amount currency
              issueDate travelStartDate travelEndDate tripPlanId
              tripPlan { id title }
              tripPlanItem { id title }
              travellers { firstName lastName }
            }
          }`,
          { id }
        );

        const r = data.getBookingRecord;
        const baseUrl = deriveBaseUrl(getApiUrl());

        if (opts.json) {
          process.stdout.write(JSON.stringify(r, null, 2) + "\n");
          return;
        }

        const icon = typeIcon(r.type);
        const label = typeLabel(r.type);

        console.log(chalk.bold(`\n  ${icon}  Booking: ${label}\n`));
        console.log(`  Status:     ${statusIcon(r.status)}`);
        if (r.pnr) console.log(`  PNR:        ${chalk.bold(r.pnr)}`);
        if (r.providerReference) console.log(`  Reference:  ${r.providerReference}`);
        if (r.providerName) console.log(`  Provider:   ${r.providerName}`);
        if (r.amount) console.log(`  Amount:     ${chalk.green(formatPrice(r.amount / 100))}${r.currency ? ` ${r.currency}` : ""}`);
        if (r.issueDate) console.log(`  Issued:     ${formatDate(r.issueDate)}`);
        if (r.travelStartDate) {
          const dateStr = `${formatDate(r.travelStartDate)}${r.travelEndDate ? ` → ${formatDate(r.travelEndDate)}` : ""}`;
          console.log(`  Travel:     ${dateStr}`);
        }
        if (r.tripPlan) {
          console.log(`  Plan:       ${r.tripPlan.title}`);
          console.log(chalk.dim(`              ${baseUrl}/plans/${r.tripPlan.id}`));
        }
        if (r.tripPlanItem) console.log(`  Item:       ${r.tripPlanItem.title}`);
        if (r.travellers && r.travellers.length > 0) {
          const names = r.travellers.map(t => `${t.firstName} ${t.lastName}`).join(", ");
          console.log(`  Travellers: ${names}`);
        }
        console.log(chalk.dim(`\n  ID: ${r.id}`));
        if (opts.refresh) console.log(chalk.green(`  ✓ Refreshed from provider`));
        console.log();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to get booking: ${message}\n`));
        process.exit(1);
      }
    });
}
