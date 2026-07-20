/**
 * voyagier book <planId>
 *
 * v2.4 (VOY-1706 — price hard-gate + checkout idempotency).
 *
 * Modes:
 *   --dry-run              — preview cart + chargeable total + blockers + existing
 *                             checkout sessions; no checkout created, no gate needed
 *   --expect-total <amt>   — REQUIRED (or --max-total): abort with PRICE_CHANGED
 *                             unless the chargeable subtotal equals <amt> exactly
 *                             (compared in cents)
 *   --max-total <amt>      — alternative gate: abort unless chargeable ≤ <amt>;
 *                             when both flags are given, BOTH are enforced
 *   --validate             — fail with BOOKING_BLOCKED if anything is non-bookable
 *   --only-bookable        — restrict checkout to bookable items (server-side)
 *   --types flight,hotel   — restrict checkout to matching item types (server-side)
 *   --new-session          — supersede an existing unpaid (Pending) checkout session
 *   --rebook               — proceed even though a Paid checkout already exists
 *   --status               — alias for tripPlanPaymentCheckouts query (post-checkout)
 *
 * PRICE HARD-GATE (VOY-1706):
 *   `book` mints a Stripe Checkout URL that a human will pay. The gate guarantees
 *   the URL the caller hands over matches the price the caller claims: a real
 *   checkout REQUIRES --expect-total or --max-total, checked against the
 *   *chargeable* subtotal (bookable items actually sent to checkout — NOT the
 *   display subtotal, which may include non-bookable lines). Mismatch aborts
 *   with PRICE_CHANGED before any mutation. Note: Voyagier adds a travel fee at
 *   checkout — the gate covers the cart subtotal; Stripe shows the final total.
 *
 * IDEMPOTENCY PRE-FLIGHT (VOY-1706):
 *   The schema has no idempotency key, so retries would mint duplicate Stripe
 *   sessions. Before creating a checkout we query tripPlanPaymentCheckouts:
 *   a Paid checkout → ALREADY_BOOKED (override: --rebook); a Pending checkout →
 *   CHECKOUT_PENDING surfacing the existing session URL (override: --new-session).
 *   The pre-flight failing is a hard failure (fail closed), not a skip.
 *
 * SERVER-SIDE FILTERING (schema change, verified via dev introspection 2026-07-20):
 *   CreateTripPlanCheckoutInput.itemIds ("selectionId:optionId") now exists —
 *   "When omitted, all bookable items are included." When --types /
 *   --only-bookable narrow the set, we pass itemIds so the Stripe session
 *   charges exactly the narrowed set. A bookable item whose optionId is unknown
 *   cannot be expressed in itemIds — with filters active we abort (fail closed)
 *   rather than silently drop it.
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
  enrichCartItems,
  filterBookable,
  filterByTypes,
  type CartV2QueryResult,
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

/**
 * Parse a money amount from a CLI flag. Accepts "339.10", "$339.10", "339".
 * Rejects NaN, negatives, and trailing garbage — a mis-parsed price gate is
 * worse than no gate.
 */
export function parseMoney(raw: string, flagName: string): number {
  const cleaned = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `${flagName} must be a plain dollar amount (e.g. 339.10) — got ${JSON.stringify(raw)}.`,
    );
  }
  return Number(cleaned);
}

interface CheckoutSummary {
  pending: PaymentCheckout[];
  paid: PaymentCheckout[];
}

/** Load existing checkout sessions for the plan, bucketed by status (idempotency pre-flight). */
async function loadCheckoutSummary(planId: string): Promise<CheckoutSummary> {
  const data = await graphql<{ tripPlanPaymentCheckouts: PaymentCheckout[] }>(
    GET_PAYMENT_CHECKOUTS,
    { tripPlanId: planId },
  );
  const checkouts = data.tripPlanPaymentCheckouts ?? [];
  return {
    // Statuses (introspection-verified 2026-07-20): Pending | Paid | Cancelled.
    pending: checkouts.filter((c) => c.status === "Pending"),
    paid: checkouts.filter((c) => c.status === "Paid"),
  };
}

export function registerBookCommands(program: Command): void {
  program
    .command("book <planId>")
    .description("Checkout and book the bookable items in a trip plan via Stripe")
    .option("--json", "Output structured JSON envelope")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show what would be charged without creating checkout")
    .option("--expect-total <amount>", "Create checkout only if the chargeable subtotal equals this amount exactly (PRICE_CHANGED otherwise)")
    .option("--max-total <amount>", "Create checkout only if the chargeable subtotal is at most this amount (PRICE_CHANGED otherwise)")
    .option("--validate", "Fail if any item in the cart is not bookable (BOOKING_BLOCKED)")
    .option("--only-bookable", "Restrict checkout to bookable items (passed server-side via itemIds)")
    .option("--types <list>", "Comma-separated CartItemType filter (Flight,Hotel,Activity,Restaurant,Other); passed server-side via itemIds")
    .option("--new-session", "Create a new checkout even if an unpaid (Pending) session already exists")
    .option("--rebook", "Create a checkout even though a Paid checkout already exists for this plan")
    .option("--status", "Show payment + booking status for past checkouts on this plan")
    .action(async (planId: string, opts: {
      json?: boolean;
      agent?: boolean;
      dryRun?: boolean;
      expectTotal?: string;
      maxTotal?: string;
      validate?: boolean;
      onlyBookable?: boolean;
      types?: string;
      newSession?: boolean;
      rebook?: boolean;
      status?: boolean;
    }) => {
      const baseUrl = deriveBaseUrl(getApiUrl());
      const planUrl = `${baseUrl}/plans/${planId}`;

      // --status mode
      if (opts.status) {
        await showBookingStatus(planId, baseUrl, Boolean(opts.json), Boolean(opts.agent));
        return;
      }

      // Price hard-gate: parse + require BEFORE any network call (fail fast).
      const expectTotal = opts.expectTotal !== undefined ? parseMoney(opts.expectTotal, "--expect-total") : null;
      const maxTotal = opts.maxTotal !== undefined ? parseMoney(opts.maxTotal, "--max-total") : null;
      if (!opts.dryRun && expectTotal === null && maxTotal === null) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Booking requires a price gate: pass --expect-total <amount> (exact) or --max-total <amount> (cap).\n` +
            `Get the current chargeable subtotal first:  voyagier book ${planId} --dry-run\n` +
            `Then:  voyagier book ${planId} --expect-total <subtotal>`,
        );
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
      const enriched = enrichCartItems(cart.items, bookability);

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
      // What the server will actually charge (modulo travel fee): bookable items
      // in the working set. Non-bookable lines are never charged by checkout.
      const chargeableSubtotal = bookableInSet.reduce((acc, i) => acc + i.price, 0);
      const planContext = {
        planId: plan.id,
        title: plan.title,
        url: planUrl,
        urlForCli: `voyagier plans get ${plan.id}`,
      };

      // --dry-run
      if (opts.dryRun) {
        // Best-effort existing-session report (never blocks a dry run).
        let existingCheckouts: { pending: number; paid: number; pendingUrl: string | null } | null = null;
        try {
          const summary = await loadCheckoutSummary(planId);
          existingCheckouts = { pending: summary.pending.length, paid: summary.paid.length, pendingUrl: summary.pending[0]?.checkoutUrl ?? null };
        } catch {
          existingCheckouts = null; // surfaced as unknown below
        }
        if (opts.json) {
          process.stdout.write(JSON.stringify({
            ok: true,
            data: {
              dryRun: true,
              items: workingSet.map((i) => ({
                name: i.name, type: i.type, price: i.price, isBookable: i.isBookable, source: i.source,
              })),
              subtotal,
              chargeableSubtotal,
              currency: cart.currency,
              blockers,
              existingCheckouts,
              filters: { types: typeFilter, onlyBookable: Boolean(opts.onlyBookable) },
              note: "Travel fee added at checkout",
              message: "Would create Stripe Checkout Session",
              nextStep: `voyagier book ${plan.id} --expect-total ${chargeableSubtotal.toFixed(2)}`,
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
          lines.push(`**Chargeable subtotal:** ${formatPrice(chargeableSubtotal)}`);
          if (chargeableSubtotal !== subtotal) {
            lines.push(`**Display subtotal (incl. non-bookable):** ${formatPrice(subtotal)}`);
          }
          if (blockers.length > 0) {
            lines.push("");
            lines.push(`⚠️ ${blockers.length} blocker${blockers.length === 1 ? "" : "s"} — won't be charged:`);
            for (const b of blockers) lines.push(`- ${b.itemName} — ${b.reason}`);
          }
          if (existingCheckouts && (existingCheckouts.pending > 0 || existingCheckouts.paid > 0)) {
            lines.push("");
            lines.push(`⚠️ Existing checkouts: ${existingCheckouts.paid} paid, ${existingCheckouts.pending} pending. Check: \`voyagier book ${plan.id} --status\``);
          }
          lines.push("");
          lines.push("_(Travel fee added at checkout — Stripe shows final total.)_");
          lines.push(`**Book at this price:** \`voyagier book ${plan.id} --expect-total ${chargeableSubtotal.toFixed(2)}\``);
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
        console.log(`  Chargeable:    ${chalk.bold(formatPrice(chargeableSubtotal))}`);
        if (chargeableSubtotal !== subtotal) {
          console.log(`  Subtotal:      ${formatPrice(subtotal)} ${chalk.dim("(incl. non-bookable lines)")}`);
        }
        console.log(`  Travel fee:    ${chalk.dim("added at checkout")}`);
        if (blockers.length > 0) {
          console.log("\n  " + chalk.yellow(`${blockers.length} non-bookable item${blockers.length === 1 ? "" : "s"} (won't be charged):`));
          for (const b of blockers) console.log(chalk.yellow(`    • ${b.itemName} — ${b.reason}`));
        }
        if (existingCheckouts && (existingCheckouts.pending > 0 || existingCheckouts.paid > 0)) {
          console.log("\n  " + chalk.yellow(`⚠ Existing checkouts: ${existingCheckouts.paid} paid, ${existingCheckouts.pending} pending — voyagier book ${plan.id} --status`));
        }
        console.log(hintDryRun());
        console.log(chalk.dim(`\n  [dry-run] Would create Stripe Checkout Session`));
        console.log(chalk.dim(`  Book at this price: voyagier book ${plan.id} --expect-total ${chargeableSubtotal.toFixed(2)}\n`));
        return;
      }

      // --- Idempotency pre-flight (fail closed: query error aborts) ---
      let summary: CheckoutSummary;
      try {
        summary = await loadCheckoutSummary(planId);
      } catch (err) {
        const message = err instanceof CliError ? err.message : err instanceof Error ? err.message : String(err);
        throw new CliError(
          CliErrorCode.API_ERROR,
          `Could not verify existing checkouts for this plan — refusing to create a new session (double-booking risk).\n${message}`,
        );
      }
      if (summary.paid.length > 0 && !opts.rebook) {
        throw new CliError(
          CliErrorCode.ALREADY_BOOKED,
          `A Paid checkout already exists for this plan — refusing to book again.\n` +
            `Review it:  voyagier book ${planId} --status\n` +
            `If you really want another checkout, re-run with --rebook.`,
          {
            paidCheckouts: summary.paid.map((c) => ({
              id: c.id,
              bookingRecords: c.bookingRecords.map((r) => ({ type: r.type, status: r.status, amount: r.amount })),
            })),
          },
        );
      }
      if (summary.pending.length > 0 && !opts.newSession) {
        const existing = summary.pending[0];
        throw new CliError(
          CliErrorCode.CHECKOUT_PENDING,
          `An unpaid checkout session already exists for this plan — reuse it instead of minting another.\n` +
            (existing.checkoutUrl ? `Pay here:  ${existing.checkoutUrl}\n` : "") +
            `⚠️ Its price was fixed when it was created — if the cart changed since, supersede it with --new-session.`,
          { pendingCheckouts: summary.pending.map((c) => ({ id: c.id, checkoutUrl: c.checkoutUrl ?? null })) },
        );
      }

      // --- Price hard-gate against the chargeable subtotal ---
      const cents = (n: number): number => Math.round(n * 100);
      const gateDetails = {
        expectedTotal: expectTotal,
        maxTotal,
        actualTotal: chargeableSubtotal,
        currency: cart.currency,
        items: bookableInSet.map((i) => ({ name: i.name, type: i.type, price: i.price })),
      };
      if (expectTotal !== null && cents(chargeableSubtotal) !== cents(expectTotal)) {
        throw new CliError(
          CliErrorCode.PRICE_CHANGED,
          `Chargeable subtotal is ${formatPrice(chargeableSubtotal)} but --expect-total was ${formatPrice(expectTotal)} — not creating checkout.\n` +
            `Review the cart (voyagier book ${planId} --dry-run), then re-run with the current total if it's acceptable.`,
          gateDetails,
        );
      }
      if (maxTotal !== null && cents(chargeableSubtotal) > cents(maxTotal)) {
        throw new CliError(
          CliErrorCode.PRICE_CHANGED,
          `Chargeable subtotal ${formatPrice(chargeableSubtotal)} exceeds --max-total ${formatPrice(maxTotal)} — not creating checkout.`,
          gateDetails,
        );
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
      // Server-side filtering: when --types / --only-bookable narrowed the set,
      // pass the narrowed bookable items explicitly (itemIds = "selectionId:optionId",
      // introspection-verified 2026-07-20). Omitted → server includes all bookable
      // items. Fail closed if a bookable item can't be expressed (missing optionId).
      const filtersActive = typeFilter.length > 0 || Boolean(opts.onlyBookable);
      if (filtersActive) {
        // Defensive: today bookable ⇒ optionId present (bookability is keyed on
        // `${selectionId}:${optionId}`), so this can only fire if enrichment
        // semantics change. Money path — fail closed rather than silently drop.
        const inexpressible = bookableInSet.filter((i) => !i.optionId);
        if (inexpressible.length > 0) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            `Cannot create a filtered checkout: ${inexpressible.length} bookable item(s) have no optionId and can't be referenced server-side.\n` +
              `Re-run without --types/--only-bookable to book the full bookable cart.`,
            { items: inexpressible.map((i) => ({ name: i.name, selectionId: i.selectionId })) },
          );
        }
        input.itemIds = bookableInSet.map((i) => `${i.selectionId}:${i.optionId}`);
      }

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
            chargeableSubtotal,
            currency: cart.currency,
            itemCount: workingSet.length,
            bookableCount: bookableInSet.length,
            gate: { expectedTotal: expectTotal, maxTotal },
            serverSideFilter: filtersActive,
            skippedBlockers: opts.onlyBookable ? blockers : [],
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
          `**Chargeable subtotal:** ${formatPrice(chargeableSubtotal)}`,
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
      console.log(`  Items:         ${bookableInSet.length}`);
      console.log(`  Chargeable:    ${chalk.bold(formatPrice(chargeableSubtotal))}`);
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
