/**
 * The plan-read GraphQL documents covered by the schema-conformance snapshot.
 *
 * Every document here reads `tripPlan` and is validated against
 * plan-schema.fixture.graphql by schema-conformance.spec.ts, so a selection of
 * a field the API does not define fails in CI rather than at the API boundary.
 * Adding a document here means re-running `npm run refresh:plan-schema` so the
 * snapshot covers the types it reads.
 */
import {
  GET_PLAN_DEEP,
  GET_TRIP_PLAN,
  GET_TRIP_PLAN_BASIC,
  GET_TRIP_PLAN_ITEM_TYPES,
  GET_TRIP_PLAN_SUMMARY,
  GET_TRIP_PLAN_WITH_DESC,
} from "../../queries.js";

export interface PlanReadDocument {
  /** The export name in queries.ts — used as the test/report label. */
  name: string;
  /** The command surface the document backs, for failure messages. */
  command: string;
  document: string;
}

export const PLAN_READ_DOCUMENTS: readonly PlanReadDocument[] = [
  { name: "GET_TRIP_PLAN", command: "plans get", document: GET_TRIP_PLAN },
  { name: "GET_PLAN_DEEP", command: "plans items", document: GET_PLAN_DEEP },
  { name: "GET_TRIP_PLAN_SUMMARY", command: "plans summary", document: GET_TRIP_PLAN_SUMMARY },
  { name: "GET_TRIP_PLAN_ITEM_TYPES", command: "search --add (item kind lookup)", document: GET_TRIP_PLAN_ITEM_TYPES },
  { name: "GET_TRIP_PLAN_BASIC", command: "plan-trip (existing-plan lookup)", document: GET_TRIP_PLAN_BASIC },
  { name: "GET_TRIP_PLAN_WITH_DESC", command: "plans update", document: GET_TRIP_PLAN_WITH_DESC },
];
