/**
 * VOY-2097: the plan-read documents must only select fields the API defines.
 *
 * `plans get` / `plans items` send whole documents, and validation is all or
 * nothing: one field the schema does not have and the request is rejected
 * before it runs. Catching that before release means checking the documents
 * against the schema itself, which is what this spec does: it
 * validates each document in PLAN_READ_DOCUMENTS against
 * plan-schema.fixture.graphql, the slice of the API schema those documents
 * read (refresh with `npm run refresh:plan-schema`).
 *
 * The snapshot carries each object type's OWN field list, so an invented field
 * fails here rather than at the API boundary. A field that the API has added
 * since the last refresh fails too — re-run the refresh script, which
 * re-validates every document against the API schema before writing.
 */
import { readFileSync } from "node:fs";
import { buildSchema, parse, validate } from "graphql";
import { PLAN_READ_DOCUMENTS } from "./plan-read-documents.js";

const schema = buildSchema(
  readFileSync(new URL("./plan-schema.fixture.graphql", import.meta.url), "utf-8"),
);

/** Validation error messages for one document, empty when it conforms. */
function conformanceErrors(document: string): string[] {
  return validate(schema, parse(document)).map((e) => e.message);
}

describe("plan-read documents conform to the API schema", () => {
  it.each(PLAN_READ_DOCUMENTS.map((d) => [d.name, d.command, d.document] as const))(
    "%s (%s) selects only fields the schema defines",
    (_name, _command, document) => {
      expect(conformanceErrors(document)).toEqual([]);
    },
  );

  it("covers the documents behind plans get and plans items", () => {
    const covered = PLAN_READ_DOCUMENTS.map((d) => d.command);
    expect(covered).toContain("plans get");
    expect(covered).toContain("plans items");
  });
});

describe("TripPlanItem's kind is selectionType", () => {
  const tripPlanItem = schema.getType("TripPlanItem");

  it("the schema defines selectionType and no item-level type", () => {
    const fields = Object.keys((tripPlanItem as { getFields(): object }).getFields());
    expect(fields).toContain("selectionType");
    expect(fields).not.toContain("type");
  });

  // Positive control: without this the suite above could pass against a
  // snapshot that validates nothing.
  it("selecting type on an item is rejected", () => {
    const errors = conformanceErrors(
      "query Probe($id: String!) { tripPlan(id: $id) { items { id type title } } }",
    );
    expect(errors).toEqual(['Cannot query field "type" on type "TripPlanItem".']);
  });

  it("TripPlanSelection.type is a different field and still resolves", () => {
    const errors = conformanceErrors(
      "query Probe($id: String!) { tripPlan(id: $id) { items { id selectionType selections { id type } } } }",
    );
    expect(errors).toEqual([]);
  });
});
