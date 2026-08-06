import { clientPlanUrl } from "../../plan-urls.js";
import { deriveChosen, type RawTravellerChoice } from "../../choices.js";

// --- Deep plan model (GET_PLAN_DEEP) ---
// API model (post PR #386 / selections migration): a TripPlanItem has `selections`
// (plural). Each TripPlanSelection has candidate `options`; the chosen one is
// derived from per-traveller `travellerOptionChoices` consensus (VOY-1701 —
// new-model picks never write `parentOptionId`, which survives only as a
// legacy fallback). A "sub-selection" (cabin class, room type) is a
// `childSelections` entry hanging off a chosen option.

export interface DeepOption {
  id: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  optionType?: string;
  status?: string;
  isBookable?: boolean;
  sortOrder?: number;
  sourceOptionId?: string | null;
  childSelections?: DeepSelection[];
}

export interface DeepSelection {
  id: string;
  type?: string;
  isLocked?: boolean;
  parentOptionId?: string | null;
  travellerOptionChoices?: RawTravellerChoice[] | null;
  assignedTravellers?: Array<{ id: string; firstName?: string; lastName?: string; dateOfBirth?: string; gender?: string }>;
  options?: DeepOption[];
}

export interface DeepItem {
  id: string;
  type: string;
  title: string;
  selections?: DeepSelection[];
}

/** The chosen option of a selection (traveller-choice consensus, legacy parentOptionId fallback), or null. */
export function deepChosenOption(sel: DeepSelection): DeepOption | null {
  const { chosenOptionId } = deriveChosen(sel);
  if (!chosenOptionId) return null;
  return (sel.options ?? []).find((o) => o.id === chosenOptionId) ?? null;
}

/** All sub-selections (childSelections) hanging off an item's chosen options. */
export function deepSubSelections(item: DeepItem): Array<{ selection: DeepSelection; parentOption: DeepOption }> {
  const out: Array<{ selection: DeepSelection; parentOption: DeepOption }> = [];
  for (const sel of item.selections ?? []) {
    const chosen = deepChosenOption(sel);
    if (!chosen) continue;
    for (const child of chosen.childSelections ?? []) {
      out.push({ selection: child, parentOption: chosen });
    }
  }
  return out;
}

export interface TripPlan {
  id: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

// NOTE: date/startTime/endTime/day were dropped from TripPlanItem in API PR #386
// (timing now lives on tripPlanEvents). Do not re-add them here — see VOY-1407.
export interface TripPlanItem {
  id: string;
  type: string;
  title: string;
}

export interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
  declaredTravellerType?: string;
}

export interface SelectionOption {
  id: string;
  name: string;
  price?: number | null;
  status?: string;
}

export interface SelectionInfo {
  id: string;
  type?: string;
  isLocked?: boolean;
  // Legacy chosen-option pointer — new-model picks never write it (VOY-1701).
  parentOptionId?: string | null;
  travellerOptionChoices?: RawTravellerChoice[] | null;
  options?: SelectionOption[];
}

/** Resolve the chosen option (traveller-choice consensus, legacy parentOptionId fallback), or null. */
export function chosenOption(sel: SelectionInfo): SelectionOption | null {
  const { chosenOptionId } = deriveChosen(sel);
  if (!chosenOptionId) return null;
  return (sel.options ?? []).find((o) => o.id === chosenOptionId) ?? null;
}

export interface TripPlanItemDetail extends TripPlanItem {
  // selections (plural) replaced the singular `selection` field in the API.
  selections?: SelectionInfo[];
}

export interface PaginatedTripPlans {
  tripPlans: {
    items: TripPlan[];
    count: number;
    page: number;
    limit: number;
  };
}

export interface TripPlanDetail {
  tripPlan: TripPlan & {
    items: TripPlanItemDetail[];
    travellers: Traveller[];
  };
}

/**
 * Human-facing plan link (the traveller-facing clientUrl). JSON payloads should
 * emit the full `planUrls(id)` trio instead so clientUrl/advisorUrl are both
 * available; this single-string form is for console/markdown output.
 */
export function planUrl(id: string): string {
  return clientPlanUrl(id);
}

/** Shared type inference from title text — used by both inferItemType and typeIcon. */
export function inferTypeFromTitle(title: string): "flight" | "hotel" | "other" {
  const t = title.toLowerCase();
  if (t.includes("hotel")) return "hotel";
  if (t.includes("flight")) return "flight";
  return "other";
}

export function inferItemType(title: string): "flight" | "hotel" | "other" {
  return inferTypeFromTitle(title);
}

export function itemStatus(item: DeepItem): "selected" | "pending" | "needs_sub_selection" {
  const selections = item.selections ?? [];
  if (selections.length === 0) return "pending";
  // An item is pending if any of its selections has no chosen option yet.
  const anyUnchosen = selections.some((s) => !deepChosenOption(s));
  if (anyUnchosen) return "pending";
  // All chosen: but a chosen option may have pending child selections (sub-selections).
  const subs = deepSubSelections(item);
  const hasPendingSub = subs.some(({ selection }) => !deepChosenOption(selection) && (selection.options ?? []).length > 0);
  return hasPendingSub ? "needs_sub_selection" : "selected";
}

export function typeIcon(type: string, title?: string): string {
  const t = (type ?? "").toLowerCase();
  // API returns "Selection" for all search-created items — infer from title
  if (t === "selection" && title) {
    const inferred = inferTypeFromTitle(title);
    if (inferred === "hotel") return "🏨";
    if (inferred === "flight") return "✈️";
    return "📋";
  }
  switch (t) {
    case "flight":
      return "✈️";
    case "hotel":
      return "🏨";
    case "activity":
      return "🎯";
    case "transport":
      return "🚗";
    default:
      return "📌";
  }
}

// --- Goals (v2.0.0 — Section 4) ---

export const SELECTION_TYPES = [
  "Activity", "ActivityList", "ActivityOption", "ActivityOptionList",
  "Airport", "BookingAnswer", "Currency", "Date", "Destination", "Duration",
  "Flight", "FlightClass", "FlightClassList", "FlightJourney", "FlightJourneyList", "FlightList",
  "Hotel", "HotelList", "HotelRoom", "HotelRoomList",
  "Location", "LocationList", "Passport",
  "Restaurant", "RestaurantList", "RestaurantReservation", "Ride", "RoomArrangement",
  "Time", "TimeList", "TransportEvent", "TravellerList",
] as const;
export type SelectionType = (typeof SELECTION_TYPES)[number];

// Single source of truth for the GraphQL SelectionScope enum. The server accepts
// AllTravellers | Subset | Individual and defaults to Subset when no scope is sent.
// Both the CLI --scope validation and the MCP goal_add tool schema derive from this
// list — do not duplicate these literals elsewhere.
export const SELECTION_SCOPES = ["AllTravellers", "Subset", "Individual"] as const;
export type SelectionScope = (typeof SELECTION_SCOPES)[number];

/** The server-side default SelectionScope applied when no scope is provided. */
export const DEFAULT_SELECTION_SCOPE: SelectionScope = "Subset";

/**
 * One checkout/decision requirement on a goal, as computed server-side
 * (TripPlanGoal.checkoutReadiness.requirements). This is the canonical,
 * backend-owned "what is still blocking this goal" signal — the CLI surfaces
 * it and maps unfulfilled entries to next-step commands; it does NOT recompute
 * sufficiency itself.
 */
export interface CheckoutRequirementStatus {
  label: string | null;
  isFulfilled: boolean;
  isRequired: boolean;
  selectionId: string | null;
  type: string | null;
  missingTravellerIds: string[];
}

export interface GoalCheckoutReadiness {
  isReady: boolean;
  requirements: CheckoutRequirementStatus[];
}

export interface TripPlanGoalSummary {
  id: string;
  name: string | null;
  type: SelectionType;
  scope: SelectionScope | null;
  sortOrder: number;
  relativeDay: number | null;
  date: string | null;
  isDecided: boolean;
  isBooked: boolean;
  checkoutReadiness?: GoalCheckoutReadiness | null;
  includeAllTravellers: boolean;
  groupName: string | null;
  primaryItemId: string | null;
  tripPlanId?: string;
}

export interface TripPlanGoalDeep extends TripPlanGoalSummary {
  items?: Array<{
    id: string;
    title: string;
    goalId: string;
    selections?: Array<{ id: string; type: string; isLocked: boolean }>;
  }>;
  travellers?: Array<{ id: string; firstName?: string | null; lastName?: string | null }>;
}

export interface CreateGoalResult {
  goal: TripPlanGoalSummary;
  item?: { id: string; title?: string; goalId?: string };
  selection?: { id: string; type: string; isLocked?: boolean };
}
