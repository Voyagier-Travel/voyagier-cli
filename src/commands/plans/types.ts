import { getApiUrl } from "../../config.js";
import { deriveBaseUrl } from "../../utils.js";

export interface DeepSubSelection {
  id: string;
  type: string;
  selectedOptionId?: string;
  options: Array<{ id: string }>;
}

export interface DeepSelectedOption {
  id: string;
  name: string;
  price?: number;
  status: string;
  subSelections?: DeepSubSelection[];
}

export interface DeepSelection {
  id: string;
  isLocked: boolean;
  selectedOption?: DeepSelectedOption;
}

export interface DeepItem {
  id: string;
  type: string;
  title: string;
  selection?: DeepSelection;
}

export interface TripPlan {
  id: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

export interface TripPlanItem {
  id: string;
  type: string;
  title: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  day?: number;
}

export interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
  declaredTravellerType?: string;
}

export interface SelectionInfo {
  id: string;
  selectedOption?: { id: string; name: string; price?: number; status: string };
}

export interface TripPlanItemDetail extends TripPlanItem {
  selection?: SelectionInfo;
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

export function planUrl(id: string): string {
  const baseUrl = deriveBaseUrl(getApiUrl());
  return `${baseUrl}/plans/${id}`;
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
  if (!item.selection?.selectedOption) return "pending";
  const subs = item.selection.selectedOption.subSelections ?? [];
  const hasPendingSub = subs.some(s => !s.selectedOptionId && s.options.length > 0);
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

export const SELECTION_SCOPES = ["Group", "Traveller", "Trip"] as const;
export type SelectionScope = (typeof SELECTION_SCOPES)[number];

export interface TripPlanGoalSummary {
  id: string;
  name: string | null;
  type: SelectionType;
  scope: SelectionScope | null;
  sortOrder: number;
  relativeDay: number | null;
  date: string | null;
  isFulfilled: boolean;
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
