/**
 * Admin-gated read of the booking_intents table (VOY-2210).
 *
 * Surface:
 *   voyagier admin booking-intents list [--page] [--limit] [--query] [--status]
 *     [--start-date] [--end-date] [--user-id] [--trip-id] [--json]
 *
 * Backed by the `adminBookingIntents` GraphQL query (AdminAuthGuard-gated —
 * requires an admin PAT). Returns EVERY row regardless of userId linkage or
 * paid status — the gap in Navigator CRM's link-only sync this ticket exists
 * to close, so unpaid/abandoned/pre-auth drafts are included by default.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { parsePositiveInt } from "../utils.js";
import { CliError, CliErrorCode } from "../errors.js";
import { ADMIN_BOOKING_INTENTS } from "../queries.js";

const VALID_STATUSES = ["DRAFT", "SAVED", "PAID", "PLAN_CREATED", "BOOKED", "ABANDONED"] as const;

export interface AdminBookingIntent {
  id: string;
  userId: string | null;
  tripId: string | null;
  tripName: string | null;
  message: string;
  status: string | null;
  destinationLabel: string | null;
  adultCount: number | null;
  youthCount: number | null;
  childCount: number | null;
  infantCount: number | null;
  petCount: number | null;
  heartedPlaces: unknown[] | null;
  startDate: string | null;
  endDate: string | null;
  minNights: number | null;
  maxNights: number | null;
  flexibleMonths: string[] | null;
  dateNotes: string | null;
  flightPreferences: unknown | null;
  hotelPreferences: unknown | null;
  roomCount: number | null;
  travellerDetails: unknown[] | null;
  depositAmountCents: number | null;
  paidAt: string | null;
  stripeCheckoutSessionId: string | null;
  emailSentAt: string | null;
  slackThreadTs: string | null;
  aiDerivedSignals: unknown | null;
  aiSignalsGeneratedAt: string | null;
  createdAt: string;
}

interface AdminBookingIntentsResponse {
  adminBookingIntents: {
    items: AdminBookingIntent[];
    count: number;
    page: number;
    limit: number;
  };
}

function statusIcon(status: string | null): string {
  switch (status) {
    case "PAID": return chalk.green("$ paid");
    case "PLAN_CREATED": return chalk.green("✓ plan created");
    case "BOOKED": return chalk.green("✓ booked");
    case "DRAFT": return chalk.yellow("… draft");
    case "SAVED": return chalk.yellow("… saved");
    case "ABANDONED": return chalk.red("✗ abandoned");
    default: return chalk.dim("— (none)");
  }
}

export function registerAdminBookingIntentsCommands(program: Command): void {
  const admin = program.command("admin").description("Admin-only reads (requires an admin PAT)");
  const bookingIntents = admin.command("booking-intents").description("Read the booking_intents table directly");

  bookingIntents
    .command("list")
    .description("List booking intents across every user, unfiltered by userId linkage or paid status")
    .option("--page <n>", "Page number (1-based)")
    .option("--limit <n>", "Page size (default 20)")
    .option("--query <text>", "Free-text search across message, tripName, destinationLabel")
    .option("--status <status>", `Filter by status: ${VALID_STATUSES.join(", ")}`)
    .option("--start-date <date>", "Only intents created on/after this date (ISO 8601)")
    .option("--end-date <date>", "Only intents created before this date (ISO 8601)")
    .option("--user-id <id>", "Filter by the user who expressed the intent")
    .option("--trip-id <id>", "Filter by the trip the intent fired from")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const page = parsePositiveInt(opts.page, "--page", { default: 1 });
      const limit = parsePositiveInt(opts.limit, "--limit", { default: 20, max: 100 });

      let status: string | undefined;
      if (opts.status) {
        status = String(opts.status).toUpperCase();
        if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            `Invalid --status "${opts.status}". Expected one of: ${VALID_STATUSES.join(", ")}`,
          );
        }
      }

      const data = await graphql<AdminBookingIntentsResponse>(ADMIN_BOOKING_INTENTS, {
        page,
        limit,
        query: opts.query,
        status,
        startDate: opts.startDate,
        endDate: opts.endDate,
        userId: opts.userId,
        tripId: opts.tripId,
      });

      const { items, count, page: normalizedPage, limit: normalizedLimit } = data.adminBookingIntents;

      if (opts.json) {
        jsonOutput({ bookingIntents: items, count, page: normalizedPage, limit: normalizedLimit });
        return;
      }

      if (items.length === 0) {
        console.log(chalk.dim("\n  No booking intents found.\n"));
        return;
      }

      console.log(chalk.bold(`\n  📥 Booking Intents (${items.length} of ${count})\n`));

      for (const intent of items) {
        const statusLabel = statusIcon(intent.status);
        const dest = intent.destinationLabel ? chalk.white(` ${intent.destinationLabel}`) : "";
        const trip = intent.tripName ? chalk.dim(` · ${intent.tripName}`) : "";
        const user = intent.userId ? chalk.dim(` · user ${intent.userId}`) : chalk.dim(" · no user");

        console.log(`  ${statusLabel}${dest}${trip}${user}`);
        console.log(chalk.dim(`      ID: ${intent.id}  Created: ${intent.createdAt.slice(0, 10)}`));
      }
      console.log();
    });
}
