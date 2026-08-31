#!/usr/bin/env -S npx tsx
/**
 * Refresh the plan-read schema snapshot.
 *
 * Reads the API's generated GraphQL SDL, checks every document in
 * PLAN_READ_DOCUMENTS against it, and writes the slice of that schema the
 * documents read to src/commands/plans/plan-schema.fixture.graphql.
 * src/commands/plans/schema-conformance.spec.ts validates the same documents
 * against that snapshot, so a field the API does not define fails in CI.
 *
 * The snapshot is a projection, not a copy: it carries the object types the
 * documents reach, each with its own fields (so a selection of a field the type
 * does not have is a snapshot miss), minus fields pointing at types outside the
 * plan-read surface, and minus descriptions.
 *
 * Usage:  VOYAGIER_API_SCHEMA=<path to the API's generated schema> npm run refresh:plan-schema
 *
 * A document that no longer matches the schema stops the refresh and is
 * reported — fix the document, then re-run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isObjectType,
  isScalarType,
  parse,
  print,
  specifiedScalarTypes,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type FieldDefinitionNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type InputValueDefinitionNode,
  type ObjectTypeDefinitionNode,
} from "graphql";
import { PLAN_READ_DOCUMENTS } from "../src/commands/plans/plan-read-documents.js";

const SNAPSHOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "commands",
  "plans",
  "plan-schema.fixture.graphql",
);

const BUILTIN_SCALARS = new Set(specifiedScalarTypes.map((s) => s.name));

/** Print a message and exit non-zero. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const schemaPath = process.env.VOYAGIER_API_SCHEMA;
if (!schemaPath || schemaPath.trim().length === 0) {
  fail(
    "VOYAGIER_API_SCHEMA is not set.\n" +
      "Point it at the API's generated GraphQL SDL, then re-run:\n" +
      "  VOYAGIER_API_SCHEMA=<path>/schema.gql npm run refresh:plan-schema",
  );
}

let schema: GraphQLSchema;
try {
  schema = buildSchema(readFileSync(schemaPath, "utf-8"));
} catch (error) {
  fail(`Could not read a GraphQL schema from ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`);
}

// --- 1. Every document must still match the schema -------------------------

const invalid = PLAN_READ_DOCUMENTS.flatMap(({ name, command, document }) => {
  const errors = validate(schema, parse(document));
  return errors.map((e) => `  ${name} (${command}): ${e.message}`);
});
if (invalid.length > 0) {
  fail(
    `${invalid.length} document(s) do not match the schema at ${schemaPath}:\n` +
      `${invalid.join("\n")}\n` +
      "Fix the document(s) in src/queries.ts, then re-run this script.",
  );
}

// --- 2. Collect the types the documents reach ------------------------------

/** Root-operation fields the documents enter through, e.g. Query.tripPlan. */
const rootFields = new Set<string>();
/** Object types the documents select into or through. */
const reached = new Set<string>();

for (const { document } of PLAN_READ_DOCUMENTS) {
  const typeInfo = new TypeInfo(schema);
  visit(
    parse(document),
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const parent = typeInfo.getParentType();
        if (parent === schema.getQueryType()) rootFields.add(node.name.value);
        else if (parent && isObjectType(parent)) reached.add(parent.name);
        const named = typeInfo.getType() && getNamedType(typeInfo.getType());
        if (named && isObjectType(named)) reached.add(named.name);
      },
    }),
  );
}

// --- 3. Project the schema onto that surface -------------------------------

/** Leaf types (scalars, enums) and input types pulled in by kept fields/args. */
const leaves = new Set<string>();
const inputs = new Set<string>();

/** A field/arg is keepable when its type is a leaf, or an object type we carry. */
function keepable(type: GraphQLNamedType, { asInput = false } = {}): boolean {
  if (isScalarType(type)) {
    if (!BUILTIN_SCALARS.has(type.name)) leaves.add(type.name);
    return true;
  }
  if (isEnumType(type)) {
    leaves.add(type.name);
    return true;
  }
  if (asInput && isInputObjectType(type)) {
    // Only carry input types whose own fields all survive the same rule.
    if (!inputs.has(type.name)) {
      inputs.add(type.name);
      const ok = Object.values(type.getFields()).every((f) => keepable(getNamedType(f.type), { asInput: true }));
      if (!ok) {
        inputs.delete(type.name);
        return false;
      }
    }
    return true;
  }
  return !asInput && isObjectType(type) && reached.has(type.name);
}

/** The field, with out-of-surface arguments dropped, or null if it can't be carried. */
function projectField(node: FieldDefinitionNode, owner: string): FieldDefinitionNode | null {
  const type = schema.getType(owner);
  if (!isObjectType(type)) return null;
  const field = type.getFields()[node.name.value];
  if (!field || !keepable(getNamedType(field.type))) return null;
  const args: InputValueDefinitionNode[] = (node.arguments ?? []).filter((argNode) => {
    const arg = field.args.find((a) => a.name === argNode.name.value);
    return arg !== undefined && keepable(getNamedType(arg.type), { asInput: true });
  });
  return { ...node, description: undefined, arguments: args };
}

/** One object type as SDL: its own fields, minus what the surface can't carry. */
function projectType(name: string, fieldFilter?: (fieldName: string) => boolean): string {
  const type = schema.getType(name);
  if (!isObjectType(type)) fail(`${name} is not an object type in ${schemaPath}.`);
  const node = type.astNode as ObjectTypeDefinitionNode | undefined;
  if (!node) fail(`${name} has no definition in ${schemaPath}.`);
  const fields = (node.fields ?? [])
    .filter((f) => (fieldFilter ? fieldFilter(f.name.value) : true))
    .map((f) => projectField(f, name))
    .filter((f): f is FieldDefinitionNode => f !== null);
  // `implements` is dropped with the interfaces themselves — the documents
  // never select through one, and carrying them would widen the snapshot.
  return print({ ...node, description: undefined, interfaces: [], fields });
}

const queryType = schema.getQueryType();
if (!queryType) fail(`${schemaPath} has no Query type.`);
const blocks = [
  projectType(queryType.name, (fieldName) => rootFields.has(fieldName)),
  ...[...reached].sort().map((name) => projectType(name)),
];

// Leaf and input definitions are printed verbatim (minus descriptions) — they
// have no object fields to project. keepable() grows both sets while the object
// types above are projected, so this runs last.
for (const name of [...leaves].sort()) {
  const type = schema.getType(name);
  if (type?.astNode) blocks.push(print({ ...type.astNode, description: undefined }));
}
for (const name of [...inputs].sort()) {
  const type = schema.getType(name);
  if (type?.astNode) blocks.push(print({ ...type.astNode, description: undefined }));
}

const header = [
  "# Generated by scripts/refresh-plan-schema.mts — do not edit by hand.",
  "#",
  "# The slice of the API schema that the plan-read documents in",
  "# src/commands/plans/plan-read-documents.ts select from. Fields pointing at",
  "# types outside that surface are dropped, so this is not the whole API.",
  "#",
  "# Refresh: VOYAGIER_API_SCHEMA=<path> npm run refresh:plan-schema",
  "",
].join("\n");

writeFileSync(SNAPSHOT, `${header}${blocks.join("\n\n")}\n`, "utf-8");
console.log(
  `Wrote ${blocks.length} type(s) covering ${PLAN_READ_DOCUMENTS.length} document(s) to ${path.relative(process.cwd(), SNAPSHOT)}`,
);
console.log("Next: review the diff, then run `npm test` — schema-conformance.spec.ts checks the documents against it.");
