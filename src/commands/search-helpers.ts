import { graphql } from "../api.js";
import {
  GET_GOALS_FOR_SEARCH,
  UPDATE_AIRPORT_SELECTION,
  ADD_DATE_OPTION,
  SET_DESTINATION_VALUE,
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

/**
 * The goal's Airport selections, requiring at least `min` of them. Flights need
 * origin + destination Airport inputs to feed the FlightList monitor; if the goal
 * graph can't accept them, fail fast with actionable guidance rather than create
 * a selection that's silently stuck AWAITING_INPUT.
 */
export function requireAirports(goal: SearchGoal, min: number): string[] {
  const ids = airportSelections(goal);
  if (ids.length < min) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Goal "${goal.name}" has ${ids.length} Airport input selection(s) but needs ${min} ` +
        `(origin + destination). The goal graph can't accept these search inputs.\n` +
        `  Inspect it:  voyagier plans goals <planId> --json`,
    );
  }
  return ids;
}

/**
 * Find the shared Date selection or throw. Dates live on a plan-level Date goal;
 * without one a dated search would create a selection stuck AWAITING_INPUT.
 */
export function requireDateSelection(goals: SearchGoal[]): string {
  const id = findDateSelection(goals);
  if (!id) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `This plan has no Date selection to bind the search dates to.\n` +
        `  Inspect the goal graph:  voyagier plans goals <planId> --json`,
    );
  }
  return id;
}

/**
 * Find the plan-level Destination selection (location/destination lives on a
 * shared Destination goal, NOT per Hotel/Activity goal). Returns null if absent.
 */
export function findDestinationSelection(goals: SearchGoal[]): string | null {
  for (const g of goals) {
    for (const item of g.items ?? []) {
      for (const sel of item.selections ?? []) {
        if (sel.type === "Destination") return sel.id;
      }
    }
  }
  return null;
}

/**
 * Apply a freeform location/destination string to the plan-level Destination
 * selection so the `--location`/`--destination` flag actually takes effect.
 * Throws if the plan has no Destination selection (rather than silently no-op).
 */
export async function setDestination(goals: SearchGoal[], name: string): Promise<void> {
  const selectionId = findDestinationSelection(goals);
  if (!selectionId) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Can't apply destination "${name}": this plan has no Destination selection.\n` +
        `  Inspect the goal graph:  voyagier plans goals <planId> --json`,
    );
  }
  await graphql(SET_DESTINATION_VALUE, { selectionId, name });
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
