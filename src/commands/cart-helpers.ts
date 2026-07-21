/**
 * Pure helpers for v2 cart + bookability (Section 3, PHASE2-DESIGN-FREEZE.md).
 *
 * Why a separate module: the cart command + plans-bookable command + book command all
 * need the same enrichment logic. Keep it pure → easy unit tests, single source of
 * truth for `source`/`bookableReason` derivation across commands.
 */

// ----- shapes returned by GET_CART_V2 -----

export interface RawCartItem {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  currency: string;
  type: string; // CartItemType: Activity|Flight|Hotel|Restaurant|Other
  selectionId: string;
  optionId?: string | null;
  metadata?: unknown;
}

export interface RawSelectionOption {
  id: string;
  name?: string | null;
  isBookable?: boolean | null;
  status?: string | null;
  blueprintListingId?: string | null;
  externalId?: string | null;
}

export interface RawSelection {
  id: string;
  type: string;
  isLocked?: boolean | null;
  options: RawSelectionOption[];
}

export interface RawGoalItem {
  id: string;
  title: string;
  goalId?: string | null;
  selections: RawSelection[];
}

export interface RawGoal {
  id: string;
  name: string;
  sortOrder?: number | null;
  items: RawGoalItem[];
}

export interface CartV2QueryResult {
  tripPlan: {
    id: string;
    title: string;
    cart: {
      items: RawCartItem[];
      itemCount: number;
      total: number;
      currency: string;
    } | null;
    goals: RawGoal[];
  } | null;
}

// ----- enrichment outputs -----

export interface BookabilityInfo {
  isBookable: boolean;
  status?: string | null;
  blueprintListingId?: string | null;
  externalId?: string | null;
  selectionId: string;
  optionId: string;
  goalId?: string | null;
  goalName?: string | null;
}

export interface BookabilityIndex {
  /** key = `${selectionId}:${optionId}` — keyed only when both ids are known. */
  byKey: Map<string, BookabilityInfo>;
  /**
   * key = selectionId → goal info (incl. sortOrder). Used by `groupCartByGoal` so we
   * never rebuild this map elsewhere — single source of truth.
   */
  selectionToGoal: Map<string, { goalId: string; goalName: string; sortOrder: number }>;
}

export type CartItemSource =
  | "ACCOMMODATION_SUPPLIER"
  | "AIR_SUPPLIER"
  | "ACTIVITY_SUPPLIER"
  | "OTHER"
  | "UNKNOWN";

export interface EnrichedCartItem {
  id: string;
  name: string;
  description?: string;
  type: string;
  price: number;
  currency: string;
  selectionId: string;
  optionId?: string;
  isBookable: boolean;
  source: CartItemSource;
  bookableReason: string | null;
}

export interface GoalGroup {
  goalId: string;
  goalName: string;
  subtotal: number;
  isBookable: boolean;
  items: EnrichedCartItem[];
}

/**
 * Walk goals → items → selections → options to build the bookability lookup.
 * Done once per cart load (single round-trip; the goals→items→selections→options walk
 * is fetched in `GET_CART_V2`). Mitigates the N+1 worry from §3 of the design freeze.
 */
export function buildBookabilityIndex(goals: RawGoal[]): BookabilityIndex {
  const byKey = new Map<string, BookabilityInfo>();
  const selectionToGoal = new Map<string, { goalId: string; goalName: string; sortOrder: number }>();

  for (const goal of goals) {
    for (const item of goal.items ?? []) {
      for (const selection of item.selections ?? []) {
        selectionToGoal.set(selection.id, {
          goalId: goal.id,
          goalName: goal.name,
          sortOrder: goal.sortOrder ?? 0,
        });
        for (const opt of selection.options ?? []) {
          const info: BookabilityInfo = {
            isBookable: Boolean(opt.isBookable),
            status: opt.status ?? null,
            blueprintListingId: opt.blueprintListingId ?? null,
            externalId: opt.externalId ?? null,
            selectionId: selection.id,
            optionId: opt.id,
            goalId: goal.id,
            goalName: goal.name,
          };
          byKey.set(`${selection.id}:${opt.id}`, info);
          // Note: we deliberately do NOT add a selectionId-only fallback key here.
          // A cart line missing `optionId` is an unknown / unresolvable bookability
          // case — guessing from "the first option I happen to walk" can report the
          // wrong isBookable/reason. `enrichCartItem()` handles missing optionId
          // explicitly by surfacing UNKNOWN + a clear reason.
        }
      }
    }
  }

  return { byKey, selectionToGoal };
}

/**
 * Single source of truth for source classification + bookable-reason text.
 * Used by `cart`, `book`, and `plans bookable` so the three commands cannot drift.
 */
export function inferSource(info: BookabilityInfo | undefined): {
  source: CartItemSource;
  reason: string | null;
} {
  if (!info) {
    return {
      source: "UNKNOWN",
      reason:
        "Cart item references a selection/option that wasn't found on the plan; refresh the cart and retry.",
    };
  }
  if (info.blueprintListingId) {
    return {
      source: "ACCOMMODATION_SUPPLIER",
      reason: info.isBookable ? null : "Listing currently unavailable.",
    };
  }
  const ext = info.externalId?.toLowerCase() ?? "";
  if (ext.startsWith("sabre")) {
    return {
      source: "AIR_SUPPLIER",
      // Flights book via the fare-level (Fare & Cabin) cart item; the parent
      // Flight pick itself is never carted. Reason only when NOT bookable.
      reason: info.isBookable
        ? null
        : "This flight line is display-only; the bookable fare-level (Fare & Cabin) item is carted once all legs are picked.",
    };
  }
  if (ext.startsWith("viator")) {
    return {
      source: "ACTIVITY_SUPPLIER",
      reason: info.isBookable ? null : "Activity not currently available from the supplier.",
    };
  }
  return {
    source: "OTHER",
    reason: info.isBookable ? null : "Booking source not yet integrated.",
  };
}

/**
 * Single source of truth for cart-item enrichment. Use this everywhere a cart
 * line needs `isBookable`/`source`/`bookableReason`.
 */
export function enrichCartItem(item: RawCartItem, index: BookabilityIndex): EnrichedCartItem {
  // No optionId → cannot resolve bookability deterministically. Be explicit.
  if (!item.optionId) {
    return {
      id: item.id,
      name: item.name,
      description: item.description ?? undefined,
      type: item.type,
      price: item.price,
      currency: item.currency,
      selectionId: item.selectionId,
      optionId: undefined,
      isBookable: false,
      source: "UNKNOWN",
      bookableReason:
        "Cart line is missing an optionId; cannot resolve bookability. Re-select the option from the plan.",
    };
  }

  const info = index.byKey.get(`${item.selectionId}:${item.optionId}`);
  const { source, reason } = inferSource(info);

  return {
    id: item.id,
    name: item.name,
    description: item.description ?? undefined,
    type: item.type,
    price: item.price,
    currency: item.currency,
    selectionId: item.selectionId,
    optionId: item.optionId,
    isBookable: info?.isBookable ?? false,
    source,
    bookableReason: info?.isBookable ? null : reason,
  };
}

/** Convenience helper for walking the whole cart in one call. */
export function enrichCartItems(items: RawCartItem[], index: BookabilityIndex): EnrichedCartItem[] {
  return items.map((item) => enrichCartItem(item, index));
}

/**
 * Group enriched cart items by goal, in goal `sortOrder` order.
 * Items not tied to any goal land in a synthetic "Ungrouped" bucket.
 *
 * A goal is `isBookable` only if **all** its items are bookable (per §3 contract).
 * Uses `index.selectionToGoal` directly — no rebuilt local map.
 */
export function groupCartByGoal(items: EnrichedCartItem[], index: BookabilityIndex): GoalGroup[] {
  const buckets = new Map<string, GoalGroup>();
  for (const item of items) {
    const goalInfo = index.selectionToGoal.get(item.selectionId);
    const key = goalInfo?.goalId ?? "__ungrouped__";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        goalId: goalInfo?.goalId ?? "ungrouped",
        goalName: goalInfo?.goalName ?? "Ungrouped",
        subtotal: 0,
        isBookable: true,
        items: [],
      };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
    bucket.subtotal += item.price;
    if (!item.isBookable) bucket.isBookable = false;
  }

  return Array.from(buckets.values()).sort((a, b) => {
    const ai = index.selectionToGoal.get(a.items[0]?.selectionId ?? "")?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bi = index.selectionToGoal.get(b.items[0]?.selectionId ?? "")?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/** Filter helper for `book --types flight,hotel,activity` (case-insensitive). */
export function filterByTypes(items: EnrichedCartItem[], types: string[]): EnrichedCartItem[] {
  if (types.length === 0) return items;
  const wanted = new Set(types.map((t) => t.toLowerCase()));
  return items.filter((i) => wanted.has(i.type.toLowerCase()));
}

/** Filter helper for `book --only-bookable`. */
export function filterBookable(items: EnrichedCartItem[]): EnrichedCartItem[] {
  return items.filter((i) => i.isBookable);
}

/**
 * Per-item blockers. Returned by `book --validate` and as `details.blockers[]` on
 * BOOKING_BLOCKED errors.
 */
export interface Blocker {
  itemId: string;
  itemName: string;
  reason: string;
  fix: string;
}

export function collectBlockers(items: EnrichedCartItem[]): Blocker[] {
  const blockers: Blocker[] = [];
  for (const item of items) {
    if (item.isBookable) continue;
    blockers.push({
      itemId: item.id,
      itemName: item.name,
      reason: item.bookableReason ?? "Item is not bookable.",
      fix:
        item.source === "AIR_SUPPLIER"
          ? "Pick the fare-level (Fare & Cabin) option once all legs are selected — that is the bookable flight item; this line itself is display-only."
          : item.source === "ACCOMMODATION_SUPPLIER"
            ? "Refresh the listing or pick a different option."
            : item.source === "UNKNOWN"
              ? "Refresh the plan to re-resolve the cart line."
              : "Remove the item from the cart, or wait for it to become bookable.",
    });
  }
  return blockers;
}
