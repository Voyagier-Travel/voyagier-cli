import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { formatPrice } from "../utils.js";

interface CartItem {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  type: string;
  selectionId: string;
  optionId?: string;
  subSelectionOptionId?: string;
}

interface Cart {
  items: CartItem[];
  total: number;
  currency: string;
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
      name: string;
      price?: number;
      status: string;
      subSelections?: Array<{
        id: string;
        type: string;
        selectedOptionId?: string;
        selectedOption?: { id: string; name: string; price?: number };
        options: Array<{ id: string; name: string; price?: number; description?: string }>;
      }>;
    };
  };
}

const GET_CART = `
  query TripPlanCart($tripPlanId: String!) {
    getTripPlanCart(tripPlanId: $tripPlanId) {
      items {
        id
        name
        description
        price
        currency
        type
        selectionId
        optionId
        subSelectionOptionId
      }
      itemCount
      total
      currency
    }
  }
`;

const GET_PLAN_ITEMS_DEEP = `
  query TripPlanDeep($id: String!) {
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
            name
            price
            status
            subSelections {
              id
              type
              selectedOptionId
              selectedOption { id name price }
              options { id name price description }
            }
          }
        }
      }
    }
  }
`;

export function registerCartCommands(program: Command): void {
  program
    .command("cart <planId>")
    .description("View the shopping cart for a trip plan")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      try {
        // Fetch both cart and deep plan data in parallel
        const [cartData, planData] = await Promise.all([
          graphql<{ getTripPlanCart: Cart }>(GET_CART, { tripPlanId: planId }),
          graphql<{ tripPlan: { id: string; title: string; items: PlanItem[] } }>(GET_PLAN_ITEMS_DEEP, { id: planId }),
        ]);

        const cart = cartData.getTripPlanCart;
        const plan = planData.tripPlan;

        // Find items with selections that have sub-selections needing choices
        const pendingSubSelections: Array<{ itemTitle: string; type: string; optionCount: number }> = [];
        for (const item of plan.items) {
          if (!item.selection?.selectedOption?.subSelections) continue;
          for (const sub of item.selection.selectedOption.subSelections) {
            if (!sub.selectedOptionId && sub.options.length > 0) {
              pendingSubSelections.push({
                itemTitle: item.title,
                type: sub.type === "FLIGHT_CLASS" ? "cabin class" : sub.type === "HOTEL_ROOM" ? "room type" : sub.type,
                optionCount: sub.options.length,
              });
            }
          }
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            cart,
            pendingSubSelections,
            travelFee: cart.total > 0 ? Math.round(cart.total * 0.06 * 100) / 100 : 0,
            estimatedTotal: cart.total > 0 ? Math.round(cart.total * 1.06 * 100) / 100 : 0,
            tripPlanUrl: `https://voyagier.com/plans/${planId}`,
          }, null, 2) + "\n");
          return;
        }

        console.log(chalk.bold(`\n🛒  Cart — ${plan.title}\n`));

        if (cart.itemCount === 0 && pendingSubSelections.length === 0) {
          console.log(chalk.dim("  Cart is empty. Select flights or hotels first."));
          console.log(chalk.dim(`  Plan: https://voyagier.com/plans/${planId}\n`));
          return;
        }

        // Show pending sub-selections as warnings
        if (pendingSubSelections.length > 0) {
          console.log(chalk.yellow("  ⚠ Items need sub-selection choices before checkout:\n"));
          for (const pending of pendingSubSelections) {
            console.log(chalk.yellow(`    • ${pending.itemTitle} — pick ${pending.type} (${pending.optionCount} options)`));
          }
          console.log(chalk.dim(`\n  Run: voyagier options ${planId}\n`));
        }

        // Show cart items
        if (cart.itemCount > 0) {
          for (const item of cart.items) {
            const typeIcon = item.type === "FLIGHT" ? "✈️" : item.type === "HOTEL" ? "🏨" : "📦";
            const price = formatPrice(item.price);
            console.log(`  ${typeIcon}  ${chalk.white(item.name)}`);
            if (item.description && item.description !== item.name) {
              console.log(chalk.dim(`      ${item.description}`));
            }
            console.log(chalk.green(`      ${price}`));
            console.log();
          }

          // Totals
          const subtotal = cart.total;
          const travelFee = Math.round(subtotal * 0.06 * 100) / 100;
          const total = Math.round((subtotal + travelFee) * 100) / 100;

          console.log(chalk.dim("  ─────────────────────────────────"));
          console.log(`  Subtotal:    ${chalk.white(formatPrice(subtotal))}`);
          console.log(`  Travel fee:  ${chalk.dim(formatPrice(travelFee))} ${chalk.dim("(6%)")}`);
          console.log(chalk.bold(`  Total:       ${formatPrice(total)}`));
          console.log();
        }

        if (pendingSubSelections.length === 0 && cart.itemCount > 0) {
          console.log(chalk.green("  ✓ Ready to book!"));
          console.log(chalk.dim(`  Run: voyagier book ${planId}\n`));
        }

        console.log(chalk.dim(`  Plan: https://voyagier.com/plans/${planId}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to load cart: ${message}\n`));
        process.exit(1);
      }
    });
}
