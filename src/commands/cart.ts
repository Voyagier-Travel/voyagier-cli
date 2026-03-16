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
    .option("--agent", "Output plain markdown for AI agents")
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
          process.stdout.write(JSON.stringify({
            cart,
            pendingSubSelections: pending.map(p => ({
              itemTitle: p.itemTitle,
              type: subSelectionLabel(p.subSelectionType),
              optionCount: p.optionCount,
            })),
            note: "Travel fee added at checkout",
            tripPlanUrl: `${baseUrl}/plans/${planId}`,
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${baseUrl}/plans/${planId}`;
          const lines: string[] = [];
          lines.push(`## 🛒 Cart — ${plan.title}`);
          lines.push("");

          if (pending.length > 0) {
            lines.push("⚠️ **Items need sub-selection before checkout:**");
            for (const p of pending) {
              lines.push(`- ${p.itemTitle} — pick ${subSelectionLabel(p.subSelectionType)} (${p.optionCount} options)`);
            }
            lines.push("");
            lines.push(`Run: \`voyagier options ${planId}\``);
            lines.push("");
          }

          if (cart.items && cart.items.length > 0) {
            for (const item of cart.items) {
              const icon = item.type === "FLIGHT" ? "✈️" : item.type === "HOTEL" ? "🏨" : "📦";
              lines.push(`- ${icon} ${item.name} — ${formatPrice(item.price)}`);
            }
            lines.push("");
            lines.push(`**Subtotal:** ${formatPrice(cart.total)}`);
            lines.push("_(Travel fee added at checkout)_");
          } else if (pending.length === 0) {
            lines.push("_Cart is empty. Select flights or hotels first._");
          }

          lines.push("");
          lines.push(`👉 **View & edit:** ${planUrl}`);

          if (pending.length === 0 && cart.items && cart.items.length > 0) {
            lines.push("");
            lines.push("✅ **Ready to book!**");
            lines.push(`**Next:** \`voyagier book ${planId}\``);
          }

          process.stdout.write(lines.join("\n") + "\n");
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

          console.log(chalk.dim("  ─────────────────────────────────"));
          console.log(`  Subtotal:      ${chalk.white(formatPrice(cart.total))}`);
          console.log(`  Travel fee:    ${chalk.dim("added at checkout")}`);
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
