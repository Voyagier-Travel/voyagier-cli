/**
 * Shared checkout dry-run computation (VOY-1724).
 *
 * `book --dry-run` and `plan-status --verify` must agree on "what would
 * actually be charged" down to the cent — so the cart load + bookability
 * enrichment + blocker collection + chargeable subtotal live here, in ONE
 * place, and both commands call it. No logic duplication: the derivation is
 * defined once (this file reuses the same cart-helpers primitives book already
 * used inline).
 */
import { graphql } from "../api.js";
import { CliError, CliErrorCode } from "../errors.js";
import { GET_CART_V2 } from "../queries.js";
import {
  buildBookabilityIndex,
  collectBlockers,
  enrichCartItems,
  type Blocker,
  type CartV2QueryResult,
  type EnrichedCartItem,
} from "./cart-helpers.js";

export interface CheckoutPreview {
  plan: { id: string; title: string };
  currency: string;
  /** Every cart line, enriched with bookability + source. */
  enriched: EnrichedCartItem[];
  /** Bookable subset of `enriched`. */
  bookableItems: EnrichedCartItem[];
  /** Per-item non-bookable blockers (book --validate / details.blockers[]). */
  blockers: Blocker[];
  /** Sum of ALL line prices (display subtotal, may include non-bookable). */
  subtotal: number;
  /** Sum of bookable line prices — what checkout charges (modulo processing fee). */
  chargeableSubtotal: number;
  /** True when there is at least one bookable line. */
  bookable: boolean;
}

/**
 * Load the plan's cart and compute the checkout preview. Throws NOT_FOUND when
 * the plan is missing and API_ERROR on a failed load; NEVER throws on an empty
 * or all-non-bookable cart (callers decide how to treat those).
 */
export async function loadCheckoutPreview(planId: string): Promise<CheckoutPreview> {
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
  return buildCheckoutPreview(data);
}

/** Pure builder — split out so it is unit-testable without any I/O. */
export function buildCheckoutPreview(data: CartV2QueryResult): CheckoutPreview {
  if (!data.tripPlan) {
    throw new CliError(CliErrorCode.NOT_FOUND, "buildCheckoutPreview: tripPlan is null");
  }
  const plan = data.tripPlan;
  const cart = plan.cart ?? { items: [], itemCount: 0, total: 0, currency: "USD" };
  const bookability = buildBookabilityIndex(plan.goals ?? []);
  const enriched = enrichCartItems(cart.items, bookability);
  const blockers = collectBlockers(enriched);
  const bookableItems = enriched.filter((i) => i.isBookable);
  const chargeableSubtotal = bookableItems.reduce((acc, i) => acc + i.price, 0);
  const subtotal = enriched.reduce((acc, i) => acc + i.price, 0);
  return {
    plan: { id: plan.id, title: plan.title },
    currency: cart.currency,
    enriched,
    bookableItems,
    blockers,
    subtotal,
    chargeableSubtotal,
    bookable: bookableItems.length > 0,
  };
}
