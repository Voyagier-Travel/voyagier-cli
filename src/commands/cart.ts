/**
 * voyagier cart <planId>           — view cart with by-goal grouping + bookability
 *
 * v2 (Section 3 — PHASE2-DESIGN-FREEZE.md). Clean replacement of v1; no compat shims.
 *
 * - Cart items use PascalCase `CartItemType` (Activity|Flight|Hotel|Restaurant|Other)
 * - `subSelectionOptionId` no longer exists; cart references `selectionId + optionId` directly
 * - `isBookable` is resolved per item via the goals→items→selections→options walk in `GET_CART_V2`
 *   (single round-trip). Source-of-truth note in PHASE2-DESIGN-FREEZE.md §3.
 * - JSON envelope follows §0 standard: `{ ok, data, planContext }`.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { CliError, CliErrorCode } from "../errors.js";
import { getApiUrl } from "../config.js";
import { formatPrice, deriveBaseUrl } from "../utils.js";
import { GET_CART_V2 } from "../queries.js";
import {
  buildBookabilityIndex,
  groupCartByGoal,
  type CartV2QueryResult,
  type EnrichedCartItem,
  type GoalGroup,
} from "./cart-helpers.js";

export function registerCartCommands(program: Command): void {
  program
    .command("cart <planId>")
    .description("View the shopping cart for a trip plan")
    .option("--json", "Output structured JSON envelope")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (planId: string, opts: { json?: boolean; agent?: boolean }) => {
      const baseUrl = deriveBaseUrl(getApiUrl());
      const planUrl = `${baseUrl}/plans/${planId}`;

      let data: CartV2QueryResult;
      try {
        data = await graphql<CartV2QueryResult>(GET_CART_V2, { id: planId });
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load cart: ${message}`);
      }

      if (!data.tripPlan) {
        throw new CliError(CliErrorCode.NOT_FOUND, `Trip plan ${planId} not found.`);
      }

      const plan = data.tripPlan;
      const cart = plan.cart ?? { items: [], itemCount: 0, total: 0, currency: "USD" };

      const bookability = buildBookabilityIndex(plan.goals ?? []);
      const enriched = cart.items.map((item) => enrichItem(item, bookability));
      const byGoal = groupCartByGoal(enriched, plan.goals ?? []);

      const planContext = {
        planId: plan.id,
        title: plan.title,
        url: planUrl,
        urlForCli: `voyagier plans get ${plan.id}`,
      };

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          ok: true,
          data: {
            cart: {
              total: cart.total,
              currency: cart.currency,
              itemCount: cart.itemCount,
              byGoal,
            },
          },
          planContext,
        }, null, 2) + "\n");
        return;
      }

      if (opts.agent) {
        renderAgent(plan.title, byGoal, cart.total, cart.currency, planUrl, planId);
        return;
      }

      renderHuman(plan.title, byGoal, cart, planUrl, planId);
    });
}

function enrichItem(
  item: { id: string; name: string; description?: string | null; price: number; currency: string; type: string; selectionId: string; optionId?: string | null; metadata?: unknown },
  bookability: ReturnType<typeof buildBookabilityIndex>,
): EnrichedCartItem {
  const key = item.optionId ? `${item.selectionId}:${item.optionId}` : item.selectionId;
  const info = bookability.byKey.get(key);
  const sourceInfo = inferSource(info);

  return {
    id: item.id,
    name: item.name,
    description: item.description ?? undefined,
    type: item.type,
    price: item.price,
    currency: item.currency,
    selectionId: item.selectionId,
    optionId: item.optionId ?? undefined,
    isBookable: info?.isBookable ?? false,
    source: sourceInfo.source,
    bookableReason: info?.isBookable ? null : sourceInfo.reason,
  };
}

function inferSource(info?: { isBookable: boolean; blueprintListingId?: string | null; externalId?: string | null }): { source: "BLUEPRINT" | "SABRE" | "VIATOR" | "OTHER"; reason: string | null } {
  if (info?.blueprintListingId) {
    return {
      source: "BLUEPRINT",
      reason: info.isBookable ? null : "Listing currently unavailable.",
    };
  }
  if (info?.externalId?.toLowerCase().startsWith("sabre")) {
    return {
      source: "SABRE",
      reason: "Flights are itinerary display only; book directly with the airline.",
    };
  }
  if (info?.externalId?.toLowerCase().startsWith("viator")) {
    return {
      source: "VIATOR",
      reason: info?.isBookable ? null : "Activity not currently available via Viator.",
    };
  }
  return {
    source: "OTHER",
    reason: info?.isBookable ? null : "Booking source not yet integrated.",
  };
}

function iconFor(type: string): string {
  switch (type) {
    case "Flight": return "✈️";
    case "Hotel": return "🏨";
    case "Activity": return "🎟️";
    case "Restaurant": return "🍽️";
    default: return "📦";
  }
}

function renderHuman(
  title: string,
  byGoal: GoalGroup[],
  cart: { total: number; currency: string; itemCount: number },
  planUrl: string,
  planId: string,
): void {
  console.log(chalk.bold(`\n🛒  Cart — ${title}\n`));

  if (cart.itemCount === 0) {
    console.log(chalk.dim("  Cart is empty. Select flights, hotels, or activities first."));
    console.log(chalk.dim(`  Plan: ${planUrl}\n`));
    return;
  }

  for (const goal of byGoal) {
    const bookableMark = goal.isBookable ? chalk.green("✓ bookable") : chalk.dim("· display-only");
    console.log(`  ${chalk.bold(goal.goalName)}  ${bookableMark}`);
    for (const item of goal.items) {
      const itemMark = item.isBookable ? chalk.green("✓") : chalk.dim("·");
      console.log(`    ${iconFor(item.type)} ${itemMark} ${chalk.white(item.name)}  ${chalk.green(formatPrice(item.price))}`);
      if (!item.isBookable && item.bookableReason) {
        console.log(chalk.dim(`        ${item.bookableReason}`));
      }
    }
    console.log(`    ${chalk.dim("subtotal:")} ${formatPrice(goal.subtotal)}`);
    console.log();
  }

  console.log(chalk.dim("  ─────────────────────────────────"));
  console.log(`  Total:         ${chalk.bold(formatPrice(cart.total))}`);
  console.log(`  Travel fee:    ${chalk.dim("added at checkout")}`);
  console.log();

  const bookableCount = byGoal.reduce((acc, g) => acc + g.items.filter((i) => i.isBookable).length, 0);
  if (bookableCount > 0) {
    console.log(chalk.green(`  ✓ ${bookableCount} bookable item${bookableCount === 1 ? "" : "s"} ready.`));
    console.log(chalk.dim(`  Run: voyagier book ${planId}\n`));
  } else {
    console.log(chalk.yellow("  No items are currently bookable through Voyagier checkout."));
    console.log(chalk.dim("  See per-item reasons above.\n"));
  }
  console.log(chalk.dim(`  Plan: ${planUrl}`));
}

function renderAgent(
  title: string,
  byGoal: GoalGroup[],
  total: number,
  _currency: string,
  planUrl: string,
  planId: string,
): void {
  const lines: string[] = [];
  lines.push(`## 🛒 Cart — ${title}`);
  lines.push("");
  if (byGoal.length === 0) {
    lines.push("_Cart is empty. Select flights, hotels, or activities first._");
    lines.push("");
    lines.push(`👉 **Plan:** ${planUrl}`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  for (const goal of byGoal) {
    const tag = goal.isBookable ? "**bookable**" : "_display-only_";
    lines.push(`### ${goal.goalName} — ${tag}`);
    for (const item of goal.items) {
      const mark = item.isBookable ? "✓" : "·";
      lines.push(`- ${mark} ${iconFor(item.type)} ${item.name} — ${formatPrice(item.price)}`);
      if (!item.isBookable && item.bookableReason) {
        lines.push(`  - _${item.bookableReason}_`);
      }
    }
    lines.push(`- _Subtotal:_ ${formatPrice(goal.subtotal)}`);
    lines.push("");
  }
  lines.push(`**Total:** ${formatPrice(total)}`);
  lines.push("_(Travel fee added at checkout)_");
  lines.push("");

  const bookableCount = byGoal.reduce((acc, g) => acc + g.items.filter((i) => i.isBookable).length, 0);
  if (bookableCount > 0) {
    lines.push(`✅ ${bookableCount} bookable item${bookableCount === 1 ? "" : "s"} — \`voyagier book ${planId}\``);
  } else {
    lines.push("⚠️ No items are currently bookable through Voyagier checkout.");
  }
  lines.push("");
  lines.push(`👉 **Plan:** ${planUrl}`);
  process.stdout.write(lines.join("\n") + "\n");
}
