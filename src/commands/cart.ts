import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { formatPrice, findPendingSubSelections, subSelectionLabel, deriveBaseUrl, PlanItemForSubCheck } from "../utils.js";
import { hintCartCheckout } from "../hints.js";
import { GET_CART, GET_PLAN_DEEP } from "../queries.js";

interface CartItem {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  type: string;
}

interface Cart {
  items: CartItem[];
  total: number;
  currency: string;
  itemCount: number;
}

export function registerCartCommands(program: Command): void {
  program
    .command("cart <planId>")
    .description("View the shopping cart for a trip plan")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      try {
        const [cartData, planData] = await Promise.all([
          graphql<{ getTripPlanCart: Cart }>(GET_CART, { tripPlanId: planId }),
          graphql<{ tripPlan: { id: string; title: string; items: PlanItemForSubCheck[] } }>(GET_PLAN_DEEP, { id: planId }),
        ]);

        const cart = cartData.getTripPlanCart;
        const plan = planData.tripPlan;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const pending = findPendingSubSelections(plan.items);

        if (opts.json) {
          const travelFee = cart.total > 0 ? Math.round(cart.total * 0.06 * 100) / 100 : 0;
          process.stdout.write(JSON.stringify({
            cart,
            pendingSubSelections: pending.map(p => ({
              itemTitle: p.itemTitle,
              type: subSelectionLabel(p.subSelectionType),
              optionCount: p.optionCount,
            })),
            travelFee,
            estimatedTotal: cart.total > 0 ? Math.round((cart.total + travelFee) * 100) / 100 : 0,
            tripPlanUrl: `${baseUrl}/plans/${planId}`,
          }, null, 2) + "\n");
          return;
        }

        console.log(chalk.bold(`\n🛒  Cart — ${plan.title}\n`));

        if (cart.itemCount === 0 && pending.length === 0) {
          console.log(chalk.dim("  Cart is empty. Select flights or hotels first."));
          console.log(chalk.dim(`  Plan: ${baseUrl}/plans/${planId}\n`));
          return;
        }

        if (pending.length > 0) {
          console.log(chalk.yellow("  ⚠ Items need sub-selection choices before checkout:\n"));
          for (const p of pending) {
            console.log(chalk.yellow(`    • ${p.itemTitle} — pick ${subSelectionLabel(p.subSelectionType)} (${p.optionCount} options)`));
          }
          console.log(chalk.dim(`\n  Run: voyagier options ${planId}\n`));
        }

        if (cart.itemCount > 0) {
          for (const item of cart.items) {
            const typeIcon = item.type === "FLIGHT" ? "✈️" : item.type === "HOTEL" ? "🏨" : "📦";
            console.log(`  ${typeIcon}  ${chalk.white(item.name)}`);
            if (item.description && item.description !== item.name) {
              console.log(chalk.dim(`      ${item.description}`));
            }
            console.log(chalk.green(`      ${formatPrice(item.price)}`));
            console.log();
          }

          const subtotal = cart.total;
          const travelFee = Math.round(subtotal * 0.06 * 100) / 100;
          const total = Math.round((subtotal + travelFee) * 100) / 100;

          console.log(chalk.dim("  ─────────────────────────────────"));
          console.log(`  Subtotal:      ${chalk.white(formatPrice(subtotal))}`);
          console.log(`  Travel fee:    ${chalk.dim(formatPrice(travelFee))} ${chalk.dim("(6% est.)")}`);
          console.log(chalk.bold(`  Est. total:    ${formatPrice(total)}`));
          console.log();
        }

        if (pending.length === 0 && cart.itemCount > 0) {
          console.log(chalk.green("  ✓ Ready to book!"));
          console.log(hintCartCheckout());
          console.log(chalk.dim(`\n  Run: voyagier book ${planId}\n`));
        }

        console.log(chalk.dim(`  Plan: ${baseUrl}/plans/${planId}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to load cart: ${message}\n`));
        process.exit(1);
      }
    });
}
