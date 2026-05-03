/**
 * Pure helpers for v2 cart + bookability (Section 3, PHASE2-DESIGN-FREEZE.md).
 *
 * Why a separate module: the cart command + plans-bookable command + book command all
 * need the same enrichment logic. Keep it pure → easy unit tests.
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
  /** key = `${selectionId}:${optionId}` (or just `selectionId` if no optionId) */
  byKey: Map<string, BookabilityInfo>;
  /** key = selectionId → goal info */
  selectionToGoal: Map<string, { goalId: string; goalName: string }>;
}

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
  source: "BLUEPRINT" | "SABRE" | "VIATOR" | "OTHER";
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
 * Done once per cart load (single round-trip, mitigates the N+1 worry from §3 of the design freeze).
 */
export function buildBookabilityIndex(goals: RawGoal[]): BookabilityIndex {
  const byKey = new Map<string, BookabilityInfo>();
  const selectionToGoal = new Map<string, { goalId: string; goalName: string }>();

  for (const goal of goals) {
    for (const item of goal.items ?? []) {
      for (const selection of item.selections ?? []) {
        selectionToGoal.set(selection.id, { goalId: goal.id, goalName: goal.name });
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
          // Also key by just selectionId so cart items without optionId still resolve to a fallback
          if (!byKey.has(selection.id)) byKey.set(selection.id, info);
        }
      }
    }
  }

  return { byKey, selectionToGoal };
}

/**
 * Group enriched cart items by goal, in goal `sortOrder` order.
 * Items not tied to any goal land in a synthetic "Ungrouped" bucket.
 *
 * A goal is `isBookable` only if **all** its items are bookable (per §3 contract).
 */
export function groupCartByGoal(items: EnrichedCartItem[], goals: RawGoal[]): GoalGroup[] {
  const selectionToGoal = new Map<string, { goalId: string; goalName: string; sortOrder: number }>();
  const goalOrder = new Map<string, number>();
  goals
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .forEach((g, i) => goalOrder.set(g.id, i));

  for (const goal of goals) {
    for (const item of goal.items ?? []) {
      for (const selection of item.selections ?? []) {
        selectionToGoal.set(selection.id, {
          goalId: goal.id,
          goalName: goal.name,
          sortOrder: goal.sortOrder ?? 0,
        });
      }
    }
  }

  const buckets = new Map<string, GoalGroup>();
  for (const item of items) {
    const goalInfo = selectionToGoal.get(item.selectionId);
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
    const ai = goalOrder.get(a.goalId) ?? Number.MAX_SAFE_INTEGER;
    const bi = goalOrder.get(b.goalId) ?? Number.MAX_SAFE_INTEGER;
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
        item.source === "SABRE"
          ? "Book this flight directly with the airline; remove from cart with the web UI to clear the blocker."
          : item.source === "BLUEPRINT"
            ? "Refresh the listing or pick a different option."
            : "Remove the item from the cart, or wait for it to become bookable.",
    });
  }
  return blockers;
}
