import { Command } from "commander";
import chalk from "chalk";
import { exec } from "child_process";
import { graphql } from "../api.js";
import { formatPrice } from "../utils.js";

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

interface PlanItem {
  id: string;
  title: string;
  selection?: {
    id: string;
    isLocked: boolean;
    selectedOption?: {
      id: string;
      status: string;
      subSelections?: Array<{
        id: string;
        type: string;
        selectedOptionId?: string;
        options: Array<{ id: string }>;
      }>;
    };
  };
}

interface CheckoutResponse {
  url: string;
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
    amount: number;
  }>;
}

const GET_CART = `
  query TripPlanCart($tripPlanId: String!) {
    getTripPlanCart(tripPlanId: $tripPlanId) {
      items { id name description price type }
      itemCount
      total
    }
  }
`;

const GET_PLAN_ITEMS = `
  query TripPlanItems($id: String!) {
    tripPlan(id: $id) {
      id
      title
      items {
        id
        title
        selection {
          id
          isLocked
          selectedOption {
            id
            status
            subSelections {
              id
              type
              selectedOptionId
              options { id }
            }
          }
        }
      }
    }
  }
`;

const CREATE_CHECKOUT = `
  mutation CreateTripPlanCheckout($input: CreateTripPlanCheckoutInput!) {
    createTripPlanCheckout(input: $input) {
      url
    }
  }
`;

const GET_PAYMENT_CHECKOUTS = `
  query TripPlanPaymentCheckouts($tripPlanId: String!) {
    tripPlanPaymentCheckouts(tripPlanId: $tripPlanId) {
      id
      status
      checkoutUrl
      createdAt
      bookingRecords {
        id
        type
        status
        pnr
        providerReference
        amount
      }
    }
  }
`;

function findMissingSubSelections(items: PlanItem[]): string[] {
  const missing: string[] = [];
  for (const item of items) {
    if (!item.selection?.selectedOption?.subSelections) continue;
    if (item.selection.isLocked) continue;
    for (const sub of item.selection.selectedOption.subSelections) {
      if (!sub.selectedOptionId && sub.options.length > 0) {
        const label = sub.type === "FLIGHT_CLASS" ? "cabin class" : sub.type === "HOTEL_ROOM" ? "room type" : sub.type;
        missing.push(`${item.title} — pick ${label}`);
      }
    }
  }
  return missing;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" :
              process.platform === "win32" ? "start" : "xdg-open";
  try {
    exec(`${cmd} "${url}"`, () => {});
  } catch {
    // User can open manually
  }
}

export function registerBookCommands(program: Command): void {
  program
    .command("book <planId>")
    .description("Checkout and book a trip plan via Stripe")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show what would be charged without creating checkout")
    .option("--status", "Check payment and booking status")
    .action(async (planId: string, opts) => {
      try {
        // --status mode
        if (opts.status) {
          await showBookingStatus(planId, opts.json);
          return;
        }

        // Fetch cart + plan data
        process.stderr.write(chalk.dim("Loading cart...\n"));

        const [cartData, planData] = await Promise.all([
          graphql<{ getTripPlanCart: Cart }>(GET_CART, { tripPlanId: planId }),
          graphql<{ tripPlan: { id: string; title: string; items: PlanItem[] } }>(GET_PLAN_ITEMS, { id: planId }),
        ]);

        const cart = cartData.getTripPlanCart;
        const plan = planData.tripPlan;

        // Pre-flight checks
        if (cart.itemCount === 0) {
          process.stderr.write(chalk.red("Cart is empty. Nothing to book.\n"));
          process.stderr.write(chalk.dim(`Select flights or hotels first: voyagier search flights --plan ${planId} ...\n`));
          process.exit(1);
        }

        const missingSubSelections = findMissingSubSelections(plan.items);
        if (missingSubSelections.length > 0) {
          process.stderr.write(chalk.red("Cannot checkout — items need sub-selection choices:\n\n"));
          for (const msg of missingSubSelections) {
            process.stderr.write(chalk.yellow(`  • ${msg}\n`));
          }
          process.stderr.write(chalk.dim(`\nRun: voyagier options ${planId}\n`));
          process.exit(1);
        }

        // Calculate totals
        const subtotal = cart.total;
        const travelFee = Math.round(subtotal * 0.06 * 100) / 100;
        const total = Math.round((subtotal + travelFee) * 100) / 100;

        // --dry-run mode
        if (opts.dryRun) {
          if (opts.json) {
            process.stdout.write(JSON.stringify({
              dryRun: true,
              planId,
              title: plan.title,
              items: cart.items.map(i => ({ name: i.name, price: i.price, type: i.type })),
              subtotal,
              travelFee,
              total,
              message: "Would create Stripe Checkout Session",
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
          console.log(`  Subtotal:    ${formatPrice(subtotal)}`);
          console.log(`  Travel fee:  ${formatPrice(travelFee)} ${chalk.dim("(6%)")}`);
          console.log(chalk.bold(`  Total:       ${formatPrice(total)}`));
          console.log(chalk.dim("\n  [dry-run] Would create Stripe Checkout Session\n"));
          return;
        }

        // Create checkout
        process.stderr.write(chalk.dim("Creating checkout session...\n"));

        const baseUrl = "https://voyagier.com";
        const checkoutData = await graphql<{ createTripPlanCheckout: CheckoutResponse }>(
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
            travelFee,
            total,
            tripPlanUrl: `${baseUrl}/plans/${planId}`,
          }, null, 2) + "\n");
          return;
        }

        console.log(chalk.green.bold("\n  ✓ Checkout session created!\n"));
        console.log(`  Items:       ${cart.itemCount}`);
        console.log(`  Total:       ${chalk.bold(formatPrice(total))} ${chalk.dim(`(includes ${formatPrice(travelFee)} travel fee)`)}`);
        console.log();
        console.log(chalk.bold("  Opening Stripe checkout in your browser..."));
        console.log(chalk.dim(`  ${checkoutUrl}\n`));

        openBrowser(checkoutUrl);

        console.log(chalk.dim(`  After payment, check status: voyagier book ${planId} --status`));
        console.log(chalk.dim(`  Plan: ${baseUrl}/plans/${planId}\n`));

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Checkout failed: ${message}\n`));
        process.exit(1);
      }
    });
}

async function showBookingStatus(planId: string, json: boolean): Promise<void> {
  const data = await graphql<{ tripPlanPaymentCheckouts: PaymentCheckout[] }>(
    GET_PAYMENT_CHECKOUTS,
    { tripPlanId: planId }
  );

  const checkouts = data.tripPlanPaymentCheckouts;

  if (json) {
    process.stdout.write(JSON.stringify({ planId, checkouts }, null, 2) + "\n");
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
      const amount = formatPrice(record.amount / 100); // stored in cents

      console.log(`    ${record.type.replace(/_/g, " ").toLowerCase()}  ${recordStatus}  ${ref}  ${amount}`);
    }
    console.log();
  }

  console.log(chalk.dim(`  Plan: https://voyagier.com/plans/${planId}\n`));
}
