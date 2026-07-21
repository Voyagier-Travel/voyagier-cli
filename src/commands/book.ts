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
 *   --rebook               — proceed even though a Paid checkout already exists
 *   --status               — alias for tripPlanPaymentCheckouts query (post-checkout)
 *
 * PRICE HARD-GATE (VOY-1706):
 *   `book` mints a Stripe Checkout URL that a human will pay. The gate checks
 *   the price against a point-in-time snapshot: a real checkout REQUIRES
 *   --expect-total or --max-total, checked against the *chargeable* subtotal
 *   (bookable items actually sent to checkout — NOT the display subtotal, which
 *   may include non-bookable lines). Mismatch aborts with PRICE_CHANGED before
 *   any mutation. Residual risks the gate cannot close: (1) itemIds pins the
 *   ITEMS, not their prices — the server re-prices line items at mutation time,
 *   so a price change in the window between the cart read and the mutation
 *   sails through; (2) Voyagier adds a travel fee at checkout — the gate covers
 *   the cart subtotal; Stripe shows the final total.
 *
 * PAID-CHECKOUT PRE-FLIGHT (VOY-1706):
 *   The schema has no idempotency key. Before creating a checkout we query
 *   tripPlanPaymentCheckouts: a Paid checkout → ALREADY_BOOKED (override:
 *   --rebook). The pre-flight failing is a hard failure (fail closed), not a
 *   skip. ⚠️ KNOWN GAP: the server's findByTripPlanId excludes Pending rows
 *   (`status: Not(Pending)` — nest-api trip-plan-payment-checkout.service.ts),
 *   so unpaid sessions are INVISIBLE to the CLI: a retry after a successful
 *   `book` will mint a duplicate (harmless-if-unpaid) Stripe session. Real
 *   pending-session idempotency needs a backend change (expose Pending or an
 *   includePending arg) — tracked in Linear; do not fake it client-side.
 *
 * SERVER-SIDE FILTERING (schema change, verified via dev introspection 2026-07-20):
 *   CreateTripPlanCheckoutInput.itemIds ("selectionId:optionId") now exists —
 *   "When omitted, all bookable items are included." We ALWAYS send itemIds for
 *   the exact bookable set the gate priced, so the gated set and the charged
 *   set cannot diverge (the server's notion of "all bookable" is not guaranteed
 *   to equal the CLI's join; unknown ids are rejected server-side — fail
 *   closed). A bookable item whose optionId is unknown cannot be expressed in
 *   itemIds — we abort (fail closed) rather than silently drop it.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { CliError, CliErrorCode } from "../errors.js";
import { getApiUrl } from "../config.js";
import { formatPrice, openBrowser, deriveBaseUrl, shellArg, cents } from "../utils.js";
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
    amount: number; // CENTS (live-verified 2026-07-20: prod record 129706 = $1,297.06; bookings.ts renders amount/100)
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
  const value = Number(cleaned);
  // A few hundred digits pass the regex but overflow to Infinity — an
  // infinite --max-total would wave through any price. Reject non-finite.
  if (!Number.isFinite(value)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `${flagName} is too large to be a real price — got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

interface CheckoutSummary {
  paid: PaymentCheckout[];
}

/** Load existing checkout sessions for the plan (Paid-checkout pre-flight). */
async function loadCheckoutSummary(planId: string): Promise<CheckoutSummary> {
  const data = await graphql<{ tripPlanPaymentCheckouts: PaymentCheckout[] }>(
    GET_PAYMENT_CHECKOUTS,
    { tripPlanId: planId },
  );
  const checkouts = data.tripPlanPaymentCheckouts ?? [];
  return {
    // Statuses (introspection-verified 2026-07-20): Pending | Paid | Cancelled.
    // NOTE: the server never returns Pending rows on this query (WHERE
    // status != Pending in nest-api) — do not add a pending bucket here
    // without a backend change; it would be dead code that fakes idempotency.
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

      // Runnable hints interpolate ids — shellArg() them all (VOY-1709
      // convention; planId is user-supplied but must stay paste-runnable).
      const planIdArg = shellArg(planId);

      // Price hard-gate: parse + require BEFORE any network call (fail fast).
      const expectTotal = opts.expectTotal !== undefined ? parseMoney(opts.expectTotal, "--expect-total") : null;
      const maxTotal = opts.maxTotal !== undefined ? parseMoney(opts.maxTotal, "--max-total") : null;
      if (!opts.dryRun && expectTotal === null && maxTotal === null) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Booking requires a price gate: pass --expect-total <amount> (exact) or --max-total <amount> (cap).\n` +
            `Get the current chargeable subtotal first:  voyagier book ${planIdArg} --dry-run\n` +
            `Then:  voyagier book ${planIdArg} --expect-total <subtotal>`,
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
          `Cart is empty. Nothing to book.\nSelect flights, hotels, or activities first: voyagier search ... --plan ${planIdArg}`,
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

      // Recipe an agent can follow verbatim — must carry the active filters,
      // or the copy-pasted command gates the FULL cart against the filtered
      // subtotal and trips PRICE_CHANGED.
      // nextStep is documented as copy/paste runnable — shellArg() every
      // interpolated value (VOY-1709 convention, see plan-status.ts) and
      // rebuild --types from the normalized typeFilter, not the raw user input.
      const filterFlags =
        (typeFilter.length > 0 ? ` --types ${shellArg(typeFilter.join(","))}` : "") +
        (opts.onlyBookable ? " --only-bookable" : "");
      // The recipe amount MUST come from the same rounded-cents value the gate
      // compares (not toFixed on the raw float): on a genuine half-cent
      // subtotal, toFixed can round the other way and emit a recipe that fails
      // its own gate. cents() is shared via utils — quote's offer total uses
      // the same function, so quoted ≡ gated by construction (VOY-1212).
      const gateAmount = (cents(chargeableSubtotal) / 100).toFixed(2);
      const nextStepCmd = `voyagier book ${shellArg(plan.id)}${filterFlags} --expect-total ${gateAmount}`;

      // Gate verdict, evaluated once for BOTH dry-run reporting and the real
      // gate below (single source of truth — dry-run can never disagree).
      const expectFails = expectTotal !== null && cents(chargeableSubtotal) !== cents(expectTotal);
      const maxFails = maxTotal !== null && cents(chargeableSubtotal) > cents(maxTotal);

      // --dry-run
      if (opts.dryRun) {
        // Best-effort existing-session report (never blocks a dry run).
        // NOTE: unpaid (Pending) sessions are invisible on this query — the
        // server filters them out; only Paid/Cancelled are observable.
        let existingCheckouts: { paid: number } | null = null;
        try {
          const summary = await loadCheckoutSummary(planId);
          existingCheckouts = { paid: summary.paid.length };
        } catch {
          existingCheckouts = null; // surfaced as unknown below
        }
        // Verdict on any supplied gate flags — dry-run doesn't REQUIRE a gate,
        // but when one is given the caller deserves to know if it would pass.
        const gateSupplied = expectTotal !== null || maxTotal !== null;
        const gateWouldPass = gateSupplied ? !expectFails && !maxFails : null;
        // Report ALL failing gates (not first-match): an agent that fixes only
        // the expect mismatch shouldn't then trip an unreported max cap.
        const gateFailReasons = [
          ...(expectFails ? [`--expect-total ${expectTotal!.toFixed(2)} ≠ chargeable ${gateAmount}`] : []),
          ...(maxFails ? [`chargeable ${gateAmount} exceeds --max-total ${maxTotal!.toFixed(2)}`] : []),
        ];
        const gateFailReason = gateFailReasons.length > 0 ? gateFailReasons.join("; ") : null;
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
              gate: gateSupplied
                ? { expectedTotal: expectTotal, maxTotal, wouldPass: gateWouldPass, failReason: gateFailReason }
                : null,
              filters: { types: typeFilter, onlyBookable: Boolean(opts.onlyBookable) },
              note: "Travel fee added at checkout",
              message: "Would create Stripe Checkout Session",
              nextStep: nextStepCmd,
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
          if (existingCheckouts === null) {
            lines.push("");
            lines.push(`⚠️ Could not verify existing checkouts (query failed) — check \`voyagier book ${shellArg(plan.id)} --status\` before booking.`);
          } else if (existingCheckouts.paid > 0) {
            lines.push("");
            lines.push(`⚠️ Existing checkouts: ${existingCheckouts.paid} paid. Check: \`voyagier book ${shellArg(plan.id)} --status\``);
          }
          if (gateWouldPass !== null) {
            lines.push("");
            lines.push(gateWouldPass ? "✅ **Gate check:** supplied gate would PASS at the current price." : `❌ **Gate check:** would FAIL — ${gateFailReason}.`);
          }
          lines.push("");
          lines.push("_(Travel fee added at checkout — Stripe shows final total.)_");
          lines.push(`**Book at this price:** \`${nextStepCmd}\``);
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
        if (existingCheckouts === null) {
          console.log("\n  " + chalk.yellow(`⚠ Could not verify existing checkouts (query failed) — run: voyagier book ${shellArg(plan.id)} --status`));
        } else if (existingCheckouts.paid > 0) {
          console.log("\n  " + chalk.yellow(`⚠ Existing checkouts: ${existingCheckouts.paid} paid — voyagier book ${shellArg(plan.id)} --status`));
        }
        if (gateWouldPass !== null) {
          console.log("\n  " + (gateWouldPass ? chalk.green("✓ Gate check: supplied gate would pass at the current price") : chalk.red(`✗ Gate check: would fail — ${gateFailReason}`)));
        }
        console.log(hintDryRun());
        console.log(chalk.dim(`\n  [dry-run] Would create Stripe Checkout Session`));
        console.log(chalk.dim(`  Book at this price: ${nextStepCmd}\n`));
        return;
      }

      // --- Paid-checkout pre-flight (fail closed: query error aborts) ---
      let summary: CheckoutSummary;
      try {
        summary = await loadCheckoutSummary(planId);
      } catch (err) {
        const note = "Could not verify existing checkouts for this plan — refusing to create a new session (double-booking risk).";
        // Preserve the original error code (AUTH_FAILED, SCHEMA_DRIFT, …) so
        // agents can dispatch on it; still fail closed either way.
        if (err instanceof CliError) {
          throw new CliError(err.code, `${note}\n${err.message}`, err.details);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `${note}\n${message}`);
      }
      if (summary.paid.length > 0 && !opts.rebook) {
        throw new CliError(
          CliErrorCode.ALREADY_BOOKED,
          `A Paid checkout already exists for this plan — refusing to book again.\n` +
            `Review it:  voyagier book ${planIdArg} --status\n` +
            `If you really want another checkout, re-run with --rebook.`,
          {
            paidCheckouts: summary.paid.map((c) => ({
              id: c.id,
              // amountCents: raw cents from the API — named explicitly so agents
              // don't compare it against dollar totals like chargeableSubtotal.
              bookingRecords: c.bookingRecords.map((r) => ({ type: r.type, status: r.status, amountCents: r.amount })),
            })),
          },
        );
      }

      // --- Price hard-gate against the chargeable subtotal ---
      // expectFails/maxFails computed above (shared with the dry-run verdict).
      const gateDetails = {
        expectedTotal: expectTotal,
        maxTotal,
        actualTotal: chargeableSubtotal,
        currency: cart.currency,
        items: bookableInSet.map((i) => ({ name: i.name, type: i.type, price: i.price })),
      };
      if (expectFails) {
        throw new CliError(
          CliErrorCode.PRICE_CHANGED,
          `Chargeable subtotal is ${formatPrice(chargeableSubtotal)} but --expect-total was ${formatPrice(expectTotal!)} — not creating checkout.\n` +
            `Review the cart (voyagier book ${planIdArg} --dry-run), then re-run with the current total if it's acceptable.`,
          gateDetails,
        );
      }
      if (maxFails) {
        throw new CliError(
          CliErrorCode.PRICE_CHANGED,
          `Chargeable subtotal ${formatPrice(chargeableSubtotal)} exceeds --max-total ${formatPrice(maxTotal!)} — not creating checkout.`,
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
      // ALWAYS send itemIds (itemIds = "selectionId:optionId", introspection-
      // verified 2026-07-20): the gate priced exactly bookableInSet, so pin the
      // server to that same set. If itemIds were omitted, the server would
      // charge ITS notion of "all bookable items", which is not guaranteed to
      // equal the CLI's join — a divergence would mean charged ≠ gated,
      // silently. Unknown ids are rejected server-side (fail closed).
      // Defensive: today bookable ⇒ optionId present (bookability is keyed on
      // `${selectionId}:${optionId}`), so the inexpressible guard can only fire
      // if enrichment semantics change. Money path — fail closed rather than
      // silently drop.
      const inexpressible = bookableInSet.filter((i) => !i.optionId);
      if (inexpressible.length > 0) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Cannot create a checkout: ${inexpressible.length} bookable item(s) have no optionId and can't be referenced server-side — the gated total would not match the charged total.`,
          { items: inexpressible.map((i) => ({ name: i.name, selectionId: i.selectionId })) },
        );
      }
      input.itemIds = bookableInSet.map((i) => `${i.selectionId}:${i.optionId}`);
      const filtersActive = typeFilter.length > 0 || Boolean(opts.onlyBookable);

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
            itemIdsPinned: true,
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
          `**After payment:** \`voyagier book ${planIdArg} --status\``,
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
      console.log(chalk.dim(`\n  After payment, check status: voyagier book ${planIdArg} --status`));
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
    // Machine surface: rename bookingRecords[].amount → amountCents. The API
    // stores integer cents (nest-api booking-record.entity.ts) but exposes an
    // undocumented Float named `amount` — the dollar-looking name caused a
    // 100× display bug (VOY-1706) and ALREADY_BOOKED.details already says
    // amountCents. One name per unit across every CLI machine surface.
    const renamed = checkouts.map((c) => ({
      ...c,
      // ?? [] : guard schema drift — the selection implies non-null, but a null
      // here previously serialized fine and must not become a TypeError.
      bookingRecords: (c.bookingRecords ?? []).map(({ amount, ...rest }) => ({ ...rest, amountCents: amount })),
    }));
    process.stdout.write(JSON.stringify({
      ok: true,
      data: { checkouts: renamed },
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
          lines.push(`- ${record.type.replace(/_/g, " ").toLowerCase()} — ${record.status.toLowerCase()}${ref ? ` — ${ref}` : ""} — ${formatPrice(record.amount / 100)}`);
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
  // Status enums serialize in PascalCase ("Paid", "Confirmed" — live-verified on
  // prod 2026-07-20). The old UPPERCASE comparisons here never matched, so
  // confirmed bookings rendered as a red ✗ and the confirmed/pending hints
  // never fired.
  for (const checkout of checkouts) {
    const statusColor = checkout.status === "Paid" ? chalk.green
      : checkout.status === "Cancelled" ? chalk.red
      : chalk.yellow;
    console.log(`  ${statusColor(checkout.status.padEnd(10))}  ${chalk.dim(checkout.id.slice(0, 8))}`);
    for (const record of checkout.bookingRecords) {
      const recordStatus = record.status === "Confirmed" ? chalk.green("✓ confirmed")
        : record.status === "Pending" ? chalk.yellow("⏳ pending")
        : chalk.red("✗ " + record.status.toLowerCase());
      const ref = record.pnr ? chalk.white(`PNR: ${record.pnr}`)
        : record.providerReference ? chalk.white(`Ref: ${record.providerReference}`) : "";
      console.log(`    ${record.type.replace(/_/g, " ").toLowerCase()}  ${recordStatus}  ${ref}  ${formatPrice(record.amount / 100)}`);
    }
    console.log();
  }
  const hasConfirmed = checkouts.some((co) => co.bookingRecords.some((r) => r.status === "Confirmed"));
  const hasPending = checkouts.some((co) => co.bookingRecords.some((r) => r.status === "Pending"));
  if (hasConfirmed) console.log(hintBookingConfirmed());
  else if (hasPending) console.log(hintBookingPending());
  console.log(chalk.dim(`\n  Plan: ${planUrl}\n`));
}
