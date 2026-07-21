/**
 * voyagier quote — read-only OFFER SNAPSHOT for a trip plan (VOY-1212).
 *
 * Quote = offer, book = acceptance:
 *   quote <planId>                      → itemized bookables + chargeable total
 *   (client says yes in a human channel)
 *   book <planId> --expect-total <X>    → acceptance; fails closed with
 *                                         PRICE_CHANGED if anything drifted
 *
 * The chargeable total is computed through the SAME cents() rounding the book
 * gate compares (utils.cents — VOY-1706 fuzz-proven), so the quoted number is
 * exactly the number the gate will enforce: quoted ≡ gated by construction.
 *
 * Deliberately NOT here:
 *   - No document rendering (md/html/pdf) — the webapp is the client-facing
 *     offer surface; `send` mails the invite link to the live trip.
 *   - No embedded payment links — Stripe sessions expire and unpaid Pending
 *     sessions are invisible to the CLI (VOY-1712). Links are minted fresh at
 *     acceptance time by `book`.
 *
 * The --json `acceptance` block { command, itemIds, expectedTotal } is the
 * machine-readable contract a future hosted "Approve" button would call:
 * server-side approve = book(planId, itemIds, expectedTotal).
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { GET_QUOTE_DATA } from "../queries.js";
import { CliError, CliErrorCode } from "../errors.js";
import { getUserContext } from "../config.js";
import { formatPrice, shellArg, cents } from "../utils.js";
import {
  buildBookabilityIndex,
  enrichCartItems,
  type EnrichedCartItem,
  type RawCartItem,
  type RawGoal,
} from "./cart-helpers.js";

interface QuoteQueryResult {
  tripPlan: {
    id: string;
    title: string;
    startDate?: string | null;
    endDate?: string | null;
    client?: { id: string; name: string; email?: string | null; phone?: string | null } | null;
    cart?: {
      items: RawCartItem[];
      itemCount: number;
      total: number;
      currency: string;
    } | null;
    goals?: RawGoal[] | null;
  } | null;
}

const TYPE_ICONS: Record<string, string> = {
  Flight: "✈️",
  Hotel: "🏨",
  Activity: "🎟️",
  Restaurant: "🍽️",
};

function itemLine(item: EnrichedCartItem): string {
  const icon = TYPE_ICONS[item.type] ?? "•";
  const price = item.price > 0 ? formatPrice(item.price) : "—";
  // Surface the specific bookableReason (matching cart's rendering) — a
  // generic tag would hide actionable issues like unavailable listings.
  const tag = item.isBookable
    ? ""
    : `  (display only — not charged${item.bookableReason ? `: ${item.bookableReason}` : ""})`;
  return `${icon} ${item.name} · ${price}${tag}`;
}

export function registerQuoteCommand(program: Command): void {
  program
    .command("quote <planId>")
    .description("Offer snapshot: itemized bookable items + the exact total a subsequent gated booking will enforce")
    .option("--json", "Output structured JSON (includes the machine-readable acceptance block)")
    .option("--agent", "Compact agent-friendly markdown")
    .action(async (planId: string, opts: { json?: boolean; agent?: boolean }) => {
      const planIdArg = shellArg(planId);

      let data: QuoteQueryResult;
      try {
        data = await graphql<QuoteQueryResult>(GET_QUOTE_DATA, { id: planId });
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load plan: ${message}`);
      }
      if (!data.tripPlan) {
        throw new CliError(CliErrorCode.NOT_FOUND, `Trip plan ${planId} not found.`);
      }
      const plan = data.tripPlan;
      const cart = plan.cart ?? { items: [], itemCount: 0, total: 0, currency: "USD" };
      const bookability = buildBookabilityIndex(plan.goals ?? []);
      const enriched = enrichCartItems(cart.items, bookability);

      const bookable = enriched.filter((i) => i.isBookable);
      const displayOnly = enriched.filter((i) => !i.isBookable);

      // THE number: same cents() rounding the book gate compares (quoted ≡ gated).
      const chargeableTotalCents = cents(bookable.reduce((acc, i) => acc + i.price, 0));
      const chargeableTotal = (chargeableTotalCents / 100).toFixed(2);
      const generatedAt = new Date().toISOString();

      // Acceptance = the exact gated-booking command. Only expressible when
      // every bookable item has an optionId (same constraint book enforces on
      // its itemIds pin — money path, so surface the gap instead of emitting a
      // command that book would refuse).
      // NB: unreachable today — enrichCartItem marks any optionId-less line
      // isBookable:false (cart-helpers.ts), so `bookable` items always carry an
      // optionId. Kept as fail-closed defense-in-depth: if that invariant ever
      // changes, quote must refuse to emit `sel:undefined` in the acceptance
      // contract rather than hand an agent a pin book would reject.
      const inexpressible = bookable.filter((i) => !i.optionId);
      const acceptance =
        bookable.length > 0 && inexpressible.length === 0
          ? {
              command: `voyagier book ${shellArg(plan.id)} --expect-total ${chargeableTotal}`,
              itemIds: bookable.map((i) => `${i.selectionId}:${i.optionId}`),
              expectedTotal: chargeableTotal,
            }
          : null;
      const acceptanceUnavailableReason =
        bookable.length === 0
          ? "no bookable items in the cart"
          : inexpressible.length > 0
            ? `${inexpressible.length} bookable item(s) missing optionId — cannot be pinned in a checkout`
            : null;

      // Advisor identity from the cached context (no extra network call; quote
      // must stay read-only-one-query). Absent context just omits the footer.
      const advisor = getUserContext();

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                plan: {
                  id: plan.id,
                  title: plan.title,
                  startDate: plan.startDate ?? null,
                  endDate: plan.endDate ?? null,
                },
                client: plan.client
                  ? { name: plan.client.name, email: plan.client.email ?? null, phone: plan.client.phone ?? null }
                  : null,
                // Per-item priceCents is rounded per line; the authoritative
                // total below is rounded ONCE on the raw-dollar subtotal (the
                // same number book's gate compares). On fractional-cent prices
                // sum(items[].priceCents) may differ from chargeableTotalCents
                // — raw `price` is included so consumers can re-derive it.
                items: enriched.map((i) => ({
                  id: i.id,
                  name: i.name,
                  type: i.type,
                  price: i.price,
                  priceCents: cents(i.price),
                  currency: i.currency,
                  bookable: i.isBookable,
                  ...(i.isBookable ? {} : { reason: i.bookableReason }),
                })),
                chargeableTotalCents,
                chargeableTotal,
                currency: cart.currency,
                generatedAt,
                acceptance,
                ...(acceptance === null ? { acceptanceUnavailableReason } : {}),
                alternatives: { selfServe: `voyagier send ${shellArg(plan.id)}` },
              },
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }

      if (opts.agent) {
        const lines: string[] = [];
        lines.push(`## Quote: ${plan.title}`);
        if (plan.client) lines.push(`Client: ${plan.client.name}${plan.client.email ? ` <${plan.client.email}>` : ""}`);
        if (plan.startDate) lines.push(`Dates: ${plan.startDate}${plan.endDate ? ` → ${plan.endDate}` : ""}`);
        lines.push("");
        for (const item of bookable) lines.push(`- ${itemLine(item)}`);
        for (const item of displayOnly) lines.push(`- ${itemLine(item)}`);
        if (enriched.length === 0) lines.push("- (cart is empty)");
        lines.push("");
        lines.push(`**Chargeable total: ${formatPrice(chargeableTotalCents / 100)}** (as of ${generatedAt})`);
        if (acceptance) {
          lines.push("");
          lines.push(`To book at this price (fails closed if anything drifted): ${acceptance.command}`);
          lines.push(`Self-serve alternative (client pays in webapp): voyagier send ${planIdArg}`);
        } else {
          lines.push(`No gated booking possible: ${acceptanceUnavailableReason}.`);
        }
        console.log(lines.join("\n"));
        return;
      }

      console.log(chalk.bold(`\n  Quote — ${plan.title}`));
      const meta: string[] = [];
      if (plan.client) meta.push(`${plan.client.name}${plan.client.email ? ` <${plan.client.email}>` : ""}`);
      if (plan.startDate) meta.push(`${plan.startDate}${plan.endDate ? ` → ${plan.endDate}` : ""}`);
      if (meta.length > 0) console.log(chalk.dim(`  ${meta.join(" · ")}`));
      console.log();

      if (enriched.length === 0) {
        console.log(chalk.dim("  (cart is empty)"));
      }
      for (const item of [...bookable, ...displayOnly]) {
        console.log(`  ${itemLine(item)}`);
      }

      console.log();
      console.log(`  ${chalk.bold(`Chargeable total: ${formatPrice(chargeableTotalCents / 100)}`)} ${chalk.dim(`(as of ${generatedAt})`)}`);
      if (advisor?.name) console.log(chalk.dim(`  Prepared by ${advisor.name}${advisor.email ? ` <${advisor.email}>` : ""}`));

      console.log();
      if (acceptance) {
        console.log(chalk.dim(`  Book at this price:  ${acceptance.command}`));
        console.log(chalk.dim(`  Or let the client self-serve:  voyagier send ${planIdArg}`));
      } else {
        console.log(chalk.yellow(`  ⚠ No gated booking possible: ${acceptanceUnavailableReason}.`));
      }
      console.log();
    });
}
