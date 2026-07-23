/**
 * voyagier plans bookable <planId>
 *
 * v2 (Section 3 — PHASE2-DESIGN-FREEZE.md). Per-item bookability summary as a list,
 * with blockers for everything currently un-bookable. No checkout side effects.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { getApiUrl } from "../../config.js";
import { formatPrice, deriveBaseUrl, shellArg } from "../../utils.js";
import { resolvePlanArg } from "../../resolve-plan-arg.js";
import { GET_CART_V2 } from "../../queries.js";
import {
  buildBookabilityIndex,
  collectBlockers,
  enrichCartItems,
  type CartV2QueryResult,
} from "../cart-helpers.js";

export function registerBookableCommand(plans: Command): void {
  plans
    .command("bookable [planId]")
    .description("Show which cart items are bookable through Voyagier checkout")
    .option("--json", "Output structured JSON envelope")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts: { json?: boolean; agent?: boolean; plan?: string }) => {
      const planId = resolvePlanArg(planIdInput, opts, "plans bookable");
      const baseUrl = deriveBaseUrl(getApiUrl());
      const planUrl = `${baseUrl}/plans/${planId}`;

      let data: CartV2QueryResult;
      try {
        data = await graphql<CartV2QueryResult>(GET_CART_V2, { id: planId });
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load plan bookability: ${message}`);
      }
      if (!data.tripPlan) {
        throw new CliError(CliErrorCode.NOT_FOUND, `Trip plan ${planId} not found.`);
      }

      const plan = data.tripPlan;
      const cart = plan.cart ?? { items: [], itemCount: 0, total: 0, currency: "USD" };
      const bookability = buildBookabilityIndex(plan.goals ?? []);
      const enriched = enrichCartItems(cart.items, bookability);

      const bookable = enriched.filter((i) => i.isBookable);
      const blockers = collectBlockers(enriched);
      const bookableSubtotal = bookable.reduce((acc, i) => acc + i.price, 0);

      const planContext = {
        planId: plan.id,
        title: plan.title,
        url: planUrl,
        urlForCli: `voyagier plans get ${shellArg(plan.id)}`,
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          ok: true,
          data: {
            itemCount: enriched.length,
            bookableCount: bookable.length,
            blockedCount: blockers.length,
            bookableSubtotal,
            currency: cart.currency,
            items: enriched,
            blockers,
          },
          planContext,
        }, null, 2) + "\n");
        return;
      }

      if (opts.agent) {
        const lines: string[] = [];
        lines.push(`## ✅ Bookability — ${plan.title}`);
        lines.push("");
        if (enriched.length === 0) {
          lines.push("_Cart is empty._");
        } else {
          lines.push(`**${bookable.length}/${enriched.length}** items bookable through Voyagier — ${formatPrice(bookableSubtotal)}`);
          lines.push("");
          for (const item of enriched) {
            const mark = item.isBookable ? "✓" : "✗";
            lines.push(`- ${mark} ${item.name} (${item.type}) — ${formatPrice(item.price)}`);
            if (!item.isBookable && item.bookableReason) {
              lines.push(`  - _${item.bookableReason}_`);
            }
          }
          if (blockers.length > 0) {
            lines.push("");
            lines.push("### Fixes");
            for (const b of blockers) {
              lines.push(`- **${b.itemName}** — ${b.fix}`);
            }
          }
        }
        lines.push("");
        lines.push(`👉 **Plan:** ${planUrl}`);
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }

      console.log(chalk.bold(`\n✅  Bookability — ${plan.title}\n`));
      if (enriched.length === 0) {
        console.log(chalk.dim("  Cart is empty.\n"));
        return;
      }
      console.log(`  ${chalk.green(bookable.length)}/${enriched.length} items bookable — ${chalk.bold(formatPrice(bookableSubtotal))}\n`);
      for (const item of enriched) {
        const mark = item.isBookable ? chalk.green("✓") : chalk.red("✗");
        console.log(`  ${mark} ${chalk.white(item.name)}  ${chalk.dim(`(${item.type})`)}  ${chalk.green(formatPrice(item.price))}`);
        if (!item.isBookable && item.bookableReason) {
          console.log(chalk.dim(`      ${item.bookableReason}`));
        }
      }
      if (blockers.length > 0) {
        console.log("\n  " + chalk.yellow("Fixes:"));
        for (const b of blockers) {
          console.log(chalk.yellow(`    • ${b.itemName} — ${b.fix}`));
        }
      }
      console.log(chalk.dim(`\n  Plan: ${planUrl}\n`));
    });
}
