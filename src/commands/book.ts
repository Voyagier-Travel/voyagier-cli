import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { CliError, CliErrorCode } from "../errors.js";
import { getApiUrl } from "../config.js";
import { formatPrice, findPendingSubSelections, subSelectionLabel, openBrowser, deriveBaseUrl, PlanItemForSubCheck, SelectionTraveller } from "../utils.js";
import { hintCheckoutCreated, hintBookingConfirmed, hintBookingPending, hintDryRun } from "../hints.js";
import { GET_CART, GET_PLAN_DEEP, CREATE_CHECKOUT, GET_PAYMENT_CHECKOUTS } from "../queries.js";

type MissingField = "dateOfBirth" | "gender";

const FIELD_LABELS: Record<MissingField, string> = {
  dateOfBirth: "date of birth",
  gender: "gender",
};

const FIELD_FLAGS: Record<MissingField, string> = {
  dateOfBirth: "--dob YYYY-MM-DD",
  gender: "--gender M",
};

interface TravellerValidationError {
  travellerId: string;
  travellerName: string;
  missingFields: MissingField[];
}

/**
 * Validate that travellers assigned to flight selections have the fields Sabre requires.
 * Returns an array of errors. Empty = all good.
 */
function validateTravellersForBooking(items: PlanItemForSubCheck[]): TravellerValidationError[] {
  const errors: TravellerValidationError[] = [];
  const checked = new Set<string>();

  for (const item of items) {
    const sel = item.selection;
    if (!sel || !sel.selectedOption) continue;

    // Only validate flight selections — hotels don't need DOB/gender
    if (sel.type !== "FLIGHT") continue;

    const travellers: SelectionTraveller[] = sel.assignedTravellers ?? [];
    for (const t of travellers) {
      if (checked.has(t.id)) continue;
      checked.add(t.id);

      const missing: MissingField[] = [];
      if (!t.dateOfBirth) missing.push("dateOfBirth");
      if (!t.gender) missing.push("gender");
      if (missing.length > 0) {
        errors.push({
          travellerId: t.id,
          travellerName: `${t.firstName} ${t.lastName}`,
          missingFields: missing,
        });
      }
    }
  }
  return errors;
}

interface CartItem {
  id: string;
  name: string;
  description?: string;
  price: number;
  type: string;
}

interface Cart {
  items: CartItem[];
  total: number;
  itemCount: number;
}

interface PaymentCheckout {
  id: string;
  status: string;
  checkoutUrl?: string;
  createdAt: string;
  bookingRecords: Array<{
    id: string;
    type: string;
    status: string;
    pnr?: string;
    providerReference?: string;
    amount: number; // stored in cents
  }>;
}

export function registerBookCommands(program: Command): void {
  program
    .command("book <planId>")
    .description("Checkout and book a trip plan via Stripe")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show what would be charged without creating checkout")
    .option("--status", "Check payment and booking status")
    .action(async (planId: string, opts) => {
      try {
        const baseUrl = deriveBaseUrl(getApiUrl());

        // --status mode
        if (opts.status) {
          await showBookingStatus(planId, baseUrl, opts.json, opts.agent);
          return;
        }

        if (!opts.json && !opts.agent) process.stderr.write(chalk.dim("Loading cart...\n"));

        const [cartData, planData] = await Promise.all([
          graphql<{ getTripPlanCart: { items: CartItem[]; total: number; itemCount: number } }>(GET_CART, { tripPlanId: planId }),
          graphql<{ tripPlan: { id: string; title: string; items: PlanItemForSubCheck[] } }>(GET_PLAN_DEEP, { id: planId }),
        ]);

        const cart = cartData.getTripPlanCart;
        const plan = planData.tripPlan;

        // Pre-flight: validate traveller data for flight bookings (skip in dry-run — show warnings instead)
        const travellerErrors = validateTravellersForBooking(plan.items);
        if (travellerErrors.length > 0 && !opts.dryRun) {
          const errorLines = travellerErrors.map(e =>
            `  ${e.travellerName}:\n${e.missingFields.map(f => `    ✗ ${FIELD_LABELS[f]}`).join("\n")}`
          ).join("\n\n");

          const fixLines = travellerErrors.map(e =>
            `  voyagier travellers update ${e.travellerId} ${e.missingFields.map(f => FIELD_FLAGS[f]).join(" ")}`
          ).join("\n");

          throw new CliError(CliErrorCode.VALIDATION,
            `Cannot checkout — travellers missing required flight booking data:\n\n${errorLines}\n\nFix:\n${fixLines}`
          );
        }

        // Pre-flight: check for missing sub-selections (these make cart appear empty)
        const pending = findPendingSubSelections(plan.items);
        if (pending.length > 0) {
          const pendingList = pending.map(p => `  • ${p.itemTitle} — pick ${subSelectionLabel(p.subSelectionType)}`).join("\n");
          throw new CliError(CliErrorCode.VALIDATION, `Cannot checkout — items need sub-selection choices:\n\n${pendingList}\n\nRun: voyagier options ${planId}`);
        }

        // Pre-flight: cart not empty
        if (cart.itemCount === 0) {
          throw new CliError(CliErrorCode.VALIDATION, `Cart is empty. Nothing to book.\nSelect flights or hotels first: voyagier search flights --plan ${planId} ...`);
        }

        const subtotal = cart.total;

        // --dry-run mode
        if (opts.dryRun) {
          // Include traveller warnings in dry-run
          const dryRunTravellerErrors = validateTravellersForBooking(plan.items);

          if (opts.json) {
            process.stdout.write(JSON.stringify({
              dryRun: true,
              planId,
              title: plan.title,
              items: cart.items.map(i => ({ name: i.name, price: i.price, type: i.type })),
              subtotal,
              note: "Travel fee added at checkout",
              message: "Would create Stripe Checkout Session",
              ...(dryRunTravellerErrors.length > 0 && {
                warnings: dryRunTravellerErrors.map(e => ({
                  traveller: e.travellerName,
                  missingFields: e.missingFields,
                })),
              }),
            }, null, 2) + "\n");
            return;
          }

          console.log(chalk.bold(`\n🧾  Dry Run — ${plan.title}\n`));
          for (const item of cart.items) {
            const icon = item.type === "FLIGHT" ? "✈️" : item.type === "HOTEL" ? "🏨" : "📦";
            console.log(`  ${icon}  ${item.name}  ${chalk.green(formatPrice(item.price))}`);
          }
          console.log();
          console.log(chalk.dim("  ─────────────────────────────────"));
          console.log(`  Subtotal:      ${formatPrice(subtotal)}`);
          console.log(`  Travel fee:    ${chalk.dim("added at checkout")}`);
          console.log(hintDryRun());
          console.log(chalk.dim("\n  [dry-run] Would create Stripe Checkout Session\n"));
          return;
        }

        // Create checkout
        process.stderr.write(chalk.dim("Creating checkout session...\n"));

        const checkoutData = await graphql<{ createTripPlanCheckout: { url: string } }>(
          CREATE_CHECKOUT,
          {
            input: {
              tripPlanId: planId,
              successUrl: `${baseUrl}/me/plans/${planId}?payment_status=success`,
              cancelUrl: `${baseUrl}/me/plans/${planId}?payment_status=cancel`,
            },
          }
        );

        const checkoutUrl = checkoutData.createTripPlanCheckout.url;

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            planId,
            title: plan.title,
            checkoutUrl,
            subtotal,
            note: "Final total (with travel fee) shown on Stripe checkout page",
            url: `${baseUrl}/plans/${planId}`,
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${baseUrl}/plans/${planId}`;
          const lines = [
            "✅ **Checkout session created!**",
            "",
            `💳 **Pay here:** ${checkoutUrl}`,
            "",
            `**Subtotal:** ${formatPrice(subtotal)}`,
            "_(Travel fee shown on checkout page)_",
            "",
            `👉 **Plan:** ${planUrl}`,
            "",
            `**After payment:** \`voyagier book ${planId} --status\``,
          ];
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        console.log(chalk.green.bold("\n  ✓ Checkout session created!\n"));
        console.log(`  Items:         ${cart.itemCount}`);
        console.log(`  Subtotal:      ${chalk.bold(formatPrice(subtotal))}`);
        console.log(`  Travel fee:    ${chalk.dim("included on checkout page")}`);
        console.log();
        console.log(chalk.bold("  Opening Stripe checkout in your browser..."));
        console.log(chalk.dim(`  ${checkoutUrl}\n`));

        openBrowser(checkoutUrl);

        console.log(hintCheckoutCreated());
        console.log(chalk.dim(`\n  After payment, check status: voyagier book ${planId} --status`));
        console.log(chalk.dim(`  Plan: ${baseUrl}/plans/${planId}\n`));

      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Checkout failed: ${message}`);
      }
    });
}

async function showBookingStatus(planId: string, baseUrl: string, json: boolean, agent = false): Promise<void> {
  const data = await graphql<{ tripPlanPaymentCheckouts: PaymentCheckout[] }>(
    GET_PAYMENT_CHECKOUTS,
    { tripPlanId: planId }
  );

  const checkouts = data.tripPlanPaymentCheckouts;

  if (json) {
    process.stdout.write(JSON.stringify({ planId, checkouts }, null, 2) + "\n");
    return;
  }

  const planUrl = `${baseUrl}/plans/${planId}`;

  if (agent) {
    const lines: string[] = [];
    lines.push("## Booking Status");
    lines.push("");
    if (checkouts.length === 0) {
      lines.push("_No payment history for this plan._");
    } else {
      for (const checkout of checkouts) {
        const date = new Date(checkout.createdAt).toLocaleDateString();
        lines.push(`**${checkout.status}** — ${date}`);
        for (const record of checkout.bookingRecords) {
          const ref = record.pnr ? `PNR: ${record.pnr}` :
                      record.providerReference ? `Ref: ${record.providerReference}` : "";
          const amount = formatPrice(record.amount / 100);
          lines.push(`- ${record.type.replace(/_/g, " ").toLowerCase()} — ${record.status.toLowerCase()}${ref ? ` — ${ref}` : ""} — ${amount}`);
        }
        lines.push("");
      }
    }
    lines.push(`👉 **Plan:** ${planUrl}`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  if (checkouts.length === 0) {
    console.log(chalk.dim("\n  No payment history for this plan.\n"));
    return;
  }

  console.log(chalk.bold(`\n📑  Booking Status\n`));

  for (const checkout of checkouts) {
    const date = new Date(checkout.createdAt).toLocaleDateString();
    const statusColor = checkout.status === "PAID" ? chalk.green :
                        checkout.status === "CANCELLED" ? chalk.red : chalk.yellow;

    console.log(`  ${statusColor(checkout.status.padEnd(10))}  ${chalk.dim(date)}  ${chalk.dim(checkout.id.slice(0, 8))}`);

    for (const record of checkout.bookingRecords) {
      const recordStatus = record.status === "CONFIRMED" ? chalk.green("✓ confirmed") :
                           record.status === "PENDING" ? chalk.yellow("⏳ pending") :
                           chalk.red("✗ " + record.status.toLowerCase());
      const ref = record.pnr ? chalk.white(`PNR: ${record.pnr}`) :
                  record.providerReference ? chalk.white(`Ref: ${record.providerReference}`) : "";
      // amount is stored in cents in BookingRecord
      const amount = formatPrice(record.amount / 100);

      console.log(`    ${record.type.replace(/_/g, " ").toLowerCase()}  ${recordStatus}  ${ref}  ${amount}`);
    }
    console.log();
  }

  // Show contextual hints based on status
  const hasConfirmed = checkouts.some(co => co.bookingRecords.some(r => r.status === "CONFIRMED"));
  const hasPending = checkouts.some(co => co.bookingRecords.some(r => r.status === "PENDING"));
  if (hasConfirmed) {
    console.log(hintBookingConfirmed());
  } else if (hasPending) {
    console.log(hintBookingPending());
  }

  console.log(chalk.dim(`\n  Plan: ${planUrl}\n`));
}
