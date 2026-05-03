/**
 * voyagier book <planId>
 *
 * v2 (Section 3 — PHASE2-DESIGN-FREEZE.md). Clean replacement.
 *
 * Modes:
 *   --dry-run             — preview cart + total + blockers, no checkout
 *   --validate            — fail with BOOKING_BLOCKED if anything is non-bookable
 *   --only-bookable       — skip non-bookable items (advisor convenience)
 *   --types flight,hotel  — restrict checkout to a comma list of item types
 *   --idempotency-key <k> — passed through on the mutation (Phase 4 will enforce)
 *   --status              — alias for tripPlanPaymentCheckouts query (post-checkout)
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { CliError, CliErrorCode } from "../errors.js";
import { getApiUrl } from "../config.js";
import { formatPrice, openBrowser, deriveBaseUrl } from "../utils.js";
import { hintCheckoutCreated, hintBookingConfirmed, hintBookingPending, hintDryRun } from "../hints.js";
import { GET_CART_V2, CREATE_CHECKOUT, GET_PAYMENT_CHECKOUTS } from "../queries.js";
import {
  buildBookabilityIndex,
  collectBlockers,
  filterBookable,
  filterByTypes,
  type CartV2QueryResult,
  type EnrichedCartItem,
} from "./cart-helpers.js";

interface PaymentCheckout {
  id: string;
  status: string;
  checkoutUrl?: string | null;
  hostedInvoiceUrl?: string | null;
  bookingRecords: Array<{
    id: string;
    type: string;
    status: string;
    pnr?: string | null;
    providerReference?: string | null;
    amount: number; // dollars (Float on schema; not cents)
  }>;
}

export function registerBookCommands(program: Command): void {
  program
    .command("book <planId>")
    .description("Checkout and book the bookable items in a trip plan via Stripe")
    .option("--json", "Output structured JSON envelope")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show what would be charged without creating checkout")
    .option("--validate", "Fail if any item in the cart is not bookable (BOOKING_BLOCKED)")
    .option("--only-bookable", "Skip non-bookable items rather than failing")
    .option("--types <list>", "Comma-separated CartItemType filter (Flight,Hotel,Activity,Restaurant,Other)")
    .option("--idempotency-key <key>", "Idempotency key for the checkout mutation")
    .option("--status", "Show payment + booking status for past checkouts on this plan")
    .action(async (planId: string, opts: {
      json?: boolean;
      agent?: boolean;
      dryRun?: boolean;
      validate?: boolean;
      onlyBookable?: boolean;
      types?: string;
      idempotencyKey?: string;
      status?: boolean;
    }) => {
      const baseUrl = deriveBaseUrl(getApiUrl());
      const planUrl = `${baseUrl}/plans/${planId}`;

      // --status mode
      if (opts.status) {
        await showBookingStatus(planId, baseUrl, Boolean(opts.json), Boolean(opts.agent));
        return;
      }

      // Load cart with bookability map
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

      const enriched: EnrichedCartItem[] = cart.items.map((item) => {
        const key = item.optionId ? `${item.selectionId}:${item.optionId}` : item.selectionId;
        const info = bookability.byKey.get(key);
        const source = info?.blueprintListingId
          ? "BLUEPRINT"
          : info?.externalId?.toLowerCase().startsWith("sabre")
            ? "SABRE"
            : info?.externalId?.toLowerCase().startsWith("viator")
              ? "VIATOR"
              : "OTHER";
        const reason = info?.isBookable
          ? null
          : source === "SABRE"
            ? "Flights are itinerary display only; book directly with the airline."
            : source === "BLUEPRINT"
              ? "Listing currently unavailable."
              : source === "VIATOR"
                ? "Activity not currently available via Viator."
                : "Booking source not yet integrated.";
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
          source: source as EnrichedCartItem["source"],
          bookableReason: reason,
        };
      });

      // Cart-empty short-circuit
      if (enriched.length === 0) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Cart is empty. Nothing to book.\nSelect flights, hotels, or activities first: voyagier search ... --plan ${planId}`,
        );
      }

      // Apply --types filter
      const typeFilter = (opts.types ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      let workingSet = filterByTypes(enriched, typeFilter);
      if (typeFilter.length > 0 && workingSet.length === 0) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `No cart items match --types ${typeFilter.join(",")}.`,
          { availableTypes: Array.from(new Set(enriched.map((i) => i.type))) },
        );
      }

      // Bookability gating
      const blockers = collectBlockers(workingSet);

      if (opts.validate && blockers.length > 0) {
        throw new CliError(
          CliErrorCode.BOOKING_BLOCKED,
          `Cannot book — ${blockers.length} item${blockers.length === 1 ? " is" : "s are"} not bookable. Re-run without --validate, or pass --only-bookable to skip them.`,
          { blockers },
        );
      }

      if (opts.onlyBookable) {
        workingSet = filterBookable(workingSet);
      }

      const bookableInSet = workingSet.filter((i) => i.isBookable);
      if (bookableInSet.length === 0) {
        throw new CliError(
          CliErrorCode.NOT_BOOKABLE,
          "No bookable items in cart. Voyagier checkout requires at least one bookable line.",
          { blockers },
        );
      }

      const subtotal = workingSet.reduce((acc, i) => acc + i.price, 0);
      const planContext = {
        planId: plan.id,
        title: plan.title,
        url: planUrl,
        urlForCli: `voyagier plans get ${plan.id}`,
      };

      // --dry-run
      if (opts.dryRun) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({
            ok: true,
            data: {
              dryRun: true,
              items: workingSet.map((i) => ({
                name: i.name, type: i.type, price: i.price, isBookable: i.isBookable, source: i.source,
              })),
              subtotal,
              currency: cart.currency,
              blockers,
              filters: { types: typeFilter, onlyBookable: Boolean(opts.onlyBookable) },
              note: "Travel fee added at checkout",
              message: "Would create Stripe Checkout Session",
            },
            planContext,
          }, null, 2) + "\n");
          return;
        }
        if (opts.agent) {
          const lines: string[] = [];
          lines.push(`## 🧾 Dry Run — ${plan.title}`);
          lines.push("");
          for (const item of workingSet) {
            const mark = item.isBookable ? "✓" : "·";
            lines.push(`- ${mark} ${item.name} (${item.type}) — ${formatPrice(item.price)}`);
          }
          lines.push("");
          lines.push(`**Subtotal:** ${formatPrice(subtotal)}`);
          if (blockers.length > 0) {
            lines.push("");
            lines.push(`⚠️ ${blockers.length} blocker${blockers.length === 1 ? "" : "s"} — won't be charged:`);
            for (const b of blockers) lines.push(`- ${b.itemName} — ${b.reason}`);
          }
          lines.push("");
          lines.push("_(Travel fee added at checkout — Stripe shows final total.)_");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }
        console.log(chalk.bold(`\n🧾  Dry Run — ${plan.title}\n`));
        for (const item of workingSet) {
          const mark = item.isBookable ? chalk.green("✓") : chalk.dim("·");
          console.log(`  ${mark} ${item.name}  ${chalk.dim(`(${item.type})`)}  ${chalk.green(formatPrice(item.price))}`);
        }
        console.log();
        console.log(chalk.dim("  ─────────────────────────────────"));
        console.log(`  Subtotal:      ${formatPrice(subtotal)}`);
        console.log(`  Travel fee:    ${chalk.dim("added at checkout")}`);
        if (blockers.length > 0) {
          console.log("\n  " + chalk.yellow(`${blockers.length} non-bookable item${blockers.length === 1 ? "" : "s"} (won't be charged):`));
          for (const b of blockers) console.log(chalk.yellow(`    • ${b.itemName} — ${b.reason}`));
        }
        console.log(hintDryRun());
        console.log(chalk.dim("\n  [dry-run] Would create Stripe Checkout Session\n"));
        return;
      }

      // --- Create real checkout session ---
      if (!opts.json && !opts.agent) {
        process.stderr.write(chalk.dim("Creating checkout session...\n"));
      }

      const input: Record<string, unknown> = {
        tripPlanId: planId,
        successUrl: `${baseUrl}/me/plans/${planId}?payment_status=success`,
        cancelUrl: `${baseUrl}/me/plans/${planId}?payment_status=cancel`,
      };
      // Note: idempotency key is passed via header in Phase 4; for now we surface it on JSON output.
      // (Mutation input itself doesn't accept the key in current schema.)

      let checkoutUrl: string;
      try {
        const checkoutData = await graphql<{ createTripPlanCheckout: { url: string } }>(
          CREATE_CHECKOUT,
          { input },
        );
        checkoutUrl = checkoutData.createTripPlanCheckout.url;
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Checkout failed: ${message}`);
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          ok: true,
          data: {
            checkoutUrl,
            subtotal,
            currency: cart.currency,
            itemCount: workingSet.length,
            bookableCount: bookableInSet.length,
            skippedBlockers: opts.onlyBookable ? blockers : [],
            idempotencyKey: opts.idempotencyKey ?? null,
            note: "Final total (with travel fee) shown on Stripe checkout page",
          },
          planContext,
        }, null, 2) + "\n");
        return;
      }
      if (opts.agent) {
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
      console.log(`  Items:         ${workingSet.length}`);
      console.log(`  Subtotal:      ${chalk.bold(formatPrice(subtotal))}`);
      console.log(`  Travel fee:    ${chalk.dim("included on checkout page")}`);
      console.log();
      console.log(chalk.bold("  Opening Stripe checkout in your browser..."));
      console.log(chalk.dim(`  ${checkoutUrl}\n`));
      openBrowser(checkoutUrl);
      console.log(hintCheckoutCreated());
      console.log(chalk.dim(`\n  After payment, check status: voyagier book ${planId} --status`));
      console.log(chalk.dim(`  Plan: ${planUrl}\n`));
    });
}

async function showBookingStatus(planId: string, baseUrl: string, json: boolean, agent: boolean): Promise<void> {
  let data: { tripPlanPaymentCheckouts: PaymentCheckout[] };
  try {
    data = await graphql<{ tripPlanPaymentCheckouts: PaymentCheckout[] }>(
      GET_PAYMENT_CHECKOUTS,
      { tripPlanId: planId },
    );
  } catch (err) {
    if (err instanceof CliError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(CliErrorCode.API_ERROR, `Failed to load booking status: ${message}`);
  }
  const checkouts = data.tripPlanPaymentCheckouts ?? [];
  const planUrl = `${baseUrl}/plans/${planId}`;

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      data: { checkouts },
      planContext: { planId, url: planUrl, urlForCli: `voyagier plans get ${planId}` },
    }, null, 2) + "\n");
    return;
  }

  if (agent) {
    const lines: string[] = [];
    lines.push("## Booking Status");
    lines.push("");
    if (checkouts.length === 0) {
      lines.push("_No payment history for this plan._");
    } else {
      for (const checkout of checkouts) {
        lines.push(`**${checkout.status}** — ${checkout.id.slice(0, 8)}`);
        for (const record of checkout.bookingRecords) {
          const ref = record.pnr
            ? `PNR: ${record.pnr}`
            : record.providerReference ? `Ref: ${record.providerReference}` : "";
          lines.push(`- ${record.type.replace(/_/g, " ").toLowerCase()} — ${record.status.toLowerCase()}${ref ? ` — ${ref}` : ""} — ${formatPrice(record.amount)}`);
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
    const statusColor = checkout.status === "PAID" ? chalk.green
      : checkout.status === "CANCELLED" ? chalk.red
      : chalk.yellow;
    console.log(`  ${statusColor(checkout.status.padEnd(10))}  ${chalk.dim(checkout.id.slice(0, 8))}`);
    for (const record of checkout.bookingRecords) {
      const recordStatus = record.status === "CONFIRMED" ? chalk.green("✓ confirmed")
        : record.status === "PENDING" ? chalk.yellow("⏳ pending")
        : chalk.red("✗ " + record.status.toLowerCase());
      const ref = record.pnr ? chalk.white(`PNR: ${record.pnr}`)
        : record.providerReference ? chalk.white(`Ref: ${record.providerReference}`) : "";
      console.log(`    ${record.type.replace(/_/g, " ").toLowerCase()}  ${recordStatus}  ${ref}  ${formatPrice(record.amount)}`);
    }
    console.log();
  }
  const hasConfirmed = checkouts.some((co) => co.bookingRecords.some((r) => r.status === "CONFIRMED"));
  const hasPending = checkouts.some((co) => co.bookingRecords.some((r) => r.status === "PENDING"));
  if (hasConfirmed) console.log(hintBookingConfirmed());
  else if (hasPending) console.log(hintBookingPending());
  console.log(chalk.dim(`\n  Plan: ${planUrl}\n`));
}
