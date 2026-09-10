/**
 * TripPlanGoal selection scopes accepted by the server's goal_add tool.
 * Kept as a constant so the stdio server's schema derives from one list.
 */
export const SELECTION_SCOPES = ["AllTravellers", "Subset", "Individual"] as const;
export type SelectionScope = (typeof SELECTION_SCOPES)[number];

/** The server-side default SelectionScope applied when no scope is provided. */
export const DEFAULT_SELECTION_SCOPE: SelectionScope = "Subset";
