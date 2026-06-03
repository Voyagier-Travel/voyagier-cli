import { graphql } from "../api.js";
import {
  GET_GOALS_FOR_SEARCH,
  UPDATE_AIRPORT_SELECTION,
  ADD_DATE_OPTION,
} from "../queries.js";
import { CliError, CliErrorCode } from "../errors.js";

/**
 * Search helpers for the goal/mirror-list model (VOY-1414).
 *
 * In the Goals/Blueprint architecture a "search" is no longer a synchronous
 * create-and-attach. Each goal carries a mirror `*List` selection whose options
 * are produced asynchronously by the goal's inputs (Airport / Date selections)
 * feeding a BlueprintMonitor. So a CLI search:
 *   1. resolves the goal of the requested type + its mirror `*List` selection,
 *   2. sets the goal's inputs from the search params (airports / dates),
 *   3. creates a concrete selection mirroring that list,
 *   4. surfaces options if present, else points at `selection-options --wait`.
 *
 * The CLI never recomputes sufficiency or re-implements the backend's fetch
 * orchestration; it sets inputs and reflects state.
 */

export interface GoalSelection {
  id: string;
  type: string | null;
}

export interface SearchGoal {
  id: string;
  name: string;
  type: string | null;
  sortOrder: number;
  items: { selections: GoalSelection[] }[];
}

/** Map a search kind to the goal type + the mirror list selection type it owns. */
const KIND_MAP: Record<string, { goalType: string; listType: string; airportTypes?: string[] }> = {
  flights: { goalType: "Flight", listType: "FlightList", airportTypes: ["Airport"] },
  hotels: { goalType: "Hotel", listType: "HotelList" },
  activities: { goalType: "Activity", listType: "ActivityList" },
};

export async function loadGoals(tripPlanId: string): Promise<SearchGoal[]> {
  const data = await graphql<{ tripPlanGoals: SearchGoal[] }>(GET_GOALS_FOR_SEARCH, { tripPlanId });
  return (data.tripPlanGoals ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Find a goal by explicit id, or the first goal matching the search kind's goal type. */
export function resolveGoal(goals: SearchGoal[], kind: string, explicitGoalId?: string): SearchGoal {
  if (explicitGoalId) {
    const g = goals.find((x) => x.id === explicitGoalId);
    if (!g) {
      throw new CliError(CliErrorCode.NOT_FOUND, `Goal ${explicitGoalId} not found on this plan.`);
    }
    return g;
  }
  const map = KIND_MAP[kind];
  const match = goals.find((g) => g.type === map.goalType);
  if (!match) {
    throw new CliError(
      CliErrorCode.NOT_FOUND,
      `No ${map.goalType} goal on this plan. Add one first:\n  voyagier plans goal-add <planId> --type ${map.goalType}\n  (or pass --goal <goalId>)`,
    );
  }
  return match;
}

/** Find the mirror `*List` selection id for the search kind within a goal. */
export function resolveMirrorList(goal: SearchGoal, kind: string): string {
  const listType = KIND_MAP[kind].listType;
  for (const item of goal.items ?? []) {
    for (const sel of item.selections ?? []) {
      if (sel.type === listType) return sel.id;
    }
  }
  throw new CliError(
    CliErrorCode.NOT_FOUND,
    `Goal "${goal.name}" has no ${listType} (mirror list) selection to search against.`,
  );
}

/** The goal's Airport selections, in document order (origin first, destination second). */
export function airportSelections(goal: SearchGoal): string[] {
  const ids: string[] = [];
  for (const item of goal.items ?? []) {
    for (const sel of item.selections ?? []) {
      if (sel.type === "Airport") ids.push(sel.id);
    }
  }
  return ids;
}

export async function setAirport(selectionId: string, location: string): Promise<void> {
  await graphql(UPDATE_AIRPORT_SELECTION, { selectionId, input: { location } });
}

/** Find a Date selection anywhere on the plan (dates often live on a shared Date goal). */
export function findDateSelection(goals: SearchGoal[]): string | null {
  for (const g of goals) {
    for (const item of g.items ?? []) {
      for (const sel of item.selections ?? []) {
        if (sel.type === "Date") return sel.id;
      }
    }
  }
  return null;
}

export async function addDateOption(selectionId: string, startDate: string): Promise<void> {
  await graphql(ADD_DATE_OPTION, { selectionId, startDate });
}
