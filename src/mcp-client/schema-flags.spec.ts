import { describe, it, expect } from "@jest/globals";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import type { McpJsonSchema, McpToolDescriptor } from "./client.js";
import { applyFlagsToCommand, attributeName, buildToolArguments, flagSpecsFromSchema, optionForSpec, parseBoolean } from "./schema-flags.js";

const FIXTURE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("../mcp/fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as McpToolDescriptor[];

function tool(name: string): McpToolDescriptor {
  const t = FIXTURE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`fixture has no tool ${name}`);
  return t;
}

/** Parse argv on a bare command carrying the tool's flags; return the tool arguments. */
async function parseArgs(name: string, argv: string[]): Promise<Record<string, unknown>> {
  return parseSchema(name, tool(name).inputSchema, argv);
}

async function parseSchema(name: string, schema: McpJsonSchema | undefined, argv: string[]): Promise<Record<string, unknown>> {
  const specs = flagSpecsFromSchema(schema);
  let captured: Record<string, unknown> | null = null;
  const cmd = new Command(name).exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  applyFlagsToCommand(cmd, specs);
  cmd.action((opts: Record<string, unknown>) => {
    captured = buildToolArguments(specs, opts);
  });
  await cmd.parseAsync(["node", name, ...argv]);
  return captured!;
}

describe("flagSpecsFromSchema", () => {
  it("derives one flag per property, typed from the schema, with required-ness", () => {
    const specs = flagSpecsFromSchema(tool("search_hotels").inputSchema);
    const byParam = Object.fromEntries(specs.map((s) => [s.param, s]));
    expect(byParam.location).toMatchObject({ kind: "string", required: true, flag: "location" });
    expect(byParam.checkin).toMatchObject({ kind: "string", required: true });
    expect(byParam.adults).toMatchObject({ kind: "integer", required: false });
    expect(byParam.children_ages).toMatchObject({ kind: "array", itemKind: "integer" });
    // Descriptions flow from the schema into the flag help. The check uses a
    // required property: the server currently publishes optional properties
    // without their descriptions.
    expect(byParam.location.description).toMatch(/Stay location/);
    expect(byParam.checkin.description).toMatch(/Check-in date/);
  });

  it("maps enums, booleans, arrays of strings and object/array-of-object to the right kinds", () => {
    const plansList = Object.fromEntries(flagSpecsFromSchema(tool("list_plans").inputSchema).map((s) => [s.param, s]));
    expect(plansList.relationship).toMatchObject({ kind: "enum", enumValues: ["owner", "shared"] });
    expect(plansList.limit).toMatchObject({ kind: "integer" });

    const refresh = Object.fromEntries(flagSpecsFromSchema(tool("refresh_options").inputSchema).map((s) => [s.param, s]));
    expect(refresh.force).toMatchObject({ kind: "boolean" });

    const book = Object.fromEntries(flagSpecsFromSchema(tool("book_plan").inputSchema).map((s) => [s.param, s]));
    expect(book.item_ids).toMatchObject({ kind: "array", itemKind: "string", required: true });
    expect(book.expect_total_cents).toMatchObject({ kind: "integer", required: true });

    const travellersAdd = Object.fromEntries(flagSpecsFromSchema(tool("add_travellers").inputSchema).map((s) => [s.param, s]));
    expect(travellersAdd.travellers).toMatchObject({ kind: "json", jsonShape: "array", required: true });

    const update = Object.fromEntries(flagSpecsFromSchema(tool("update_traveller").inputSchema).map((s) => [s.param, s]));
    expect(update.passport).toMatchObject({ kind: "json", jsonShape: "object" });
  });

  it("renames a property that collides with a CLI-owned flag", () => {
    const specs = flagSpecsFromSchema({ type: "object", properties: { json: { type: "string" }, help: { type: "boolean" } } });
    expect(specs.map((s) => s.flag)).toEqual(["param-json", "param-help"]);
    expect(specs.map((s) => s.param)).toEqual(["json", "help"]);
  });

  it("treats a nullable type union as its non-null member and appends the schema default to help", () => {
    const [spec] = flagSpecsFromSchema({ type: "object", properties: { n: { type: ["integer", "null"], description: "Count.", default: 3 } } });
    expect(spec.kind).toBe("integer");
    expect(spec.nullable).toBe(true);
    expect(spec.description).toBe("Count. Default: 3.");
  });

  it("marks nullable properties from both type unions and anyOf, keeping the base kind", () => {
    const specs = Object.fromEntries(
      flagSpecsFromSchema({
        type: "object",
        properties: {
          s: { type: ["string", "null"] },
          a: { anyOf: [{ type: "string", maxLength: 32 }, { type: "null" }] },
          i: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
          e: { anyOf: [{ type: "string", enum: ["x", "y"] }, { type: "null" }] },
          o: { anyOf: [{ type: "object" }, { type: "null" }] },
          l: { type: ["array", "null"], items: { type: "string" } },
          plain: { type: "string" },
          union: { anyOf: [{ type: "string" }, { type: "integer" }] },
        },
      }).map((s) => [s.param, s]),
    );
    expect(specs.s).toMatchObject({ kind: "string", nullable: true });
    expect(specs.a).toMatchObject({ kind: "string", nullable: true });
    expect(specs.i).toMatchObject({ kind: "integer", nullable: true });
    expect(specs.e).toMatchObject({ kind: "enum", enumValues: ["x", "y"], nullable: true });
    expect(specs.o).toMatchObject({ kind: "json", jsonShape: "object", nullable: true });
    // A repeatable flag has no slot for the sentinel: exposed as a plain array flag.
    expect(specs.l).toMatchObject({ kind: "array", itemKind: "string" });
    expect(specs.l.nullable).toBeUndefined();
    // Non-nullable shapes are untouched: no `nullable` key, same kinds as before.
    expect(specs.plain).toEqual({ param: "plain", flag: "plain", attribute: "plain", required: false, description: "", kind: "string" });
    expect(specs.union).toMatchObject({ kind: "json" });
    expect(specs.union.nullable).toBeUndefined();
  });

  it("resolves the fixture's nullable params to their base kinds, and none of them is required", () => {
    const update = Object.fromEntries(flagSpecsFromSchema(tool("update_plan").inputSchema).map((s) => [s.param, s]));
    expect(update.cover_media_id).toMatchObject({ kind: "string", nullable: true, required: false });
    expect(update.description).toMatchObject({ kind: "string", nullable: true, required: false });
    const event = Object.fromEntries(flagSpecsFromSchema(tool("update_guide_event").inputSchema).map((s) => [s.param, s]));
    expect(event.local_time).toMatchObject({ kind: "string", nullable: true });
    expect(event.duration_minutes).toMatchObject({ kind: "integer", nullable: true });

    // The `null` sentinel is only unambiguous on an optional input. If the
    // server ever publishes a REQUIRED nullable property this must be revisited.
    const requiredNullable = FIXTURE_TOOLS.flatMap((t) =>
      flagSpecsFromSchema(t.inputSchema)
        .filter((s) => s.nullable && s.required)
        .map((s) => `${t.name}.${s.param}`),
    );
    expect(requiredNullable).toEqual([]);
    const nullableCount = FIXTURE_TOOLS.flatMap((t) => flagSpecsFromSchema(t.inputSchema).filter((s) => s.nullable)).length;
    expect(nullableCount).toBeGreaterThan(0);
  });

  it("help text carries the null hint on nullable flags only", () => {
    const specs = flagSpecsFromSchema({
      type: "object",
      properties: {
        s: { type: ["string", "null"], description: "Cover." },
        i: { anyOf: [{ type: "integer" }, { type: "null" }] },
        plain: { type: "string", description: "Title." },
        n: { type: "integer" },
      },
    });
    const help = Object.fromEntries(specs.map((s) => [s.param, optionForSpec(s).description]));
    expect(help.s).toBe("Cover. (pass null to clear)");
    expect(help.i).toBe("(integer; pass null to clear)");
    expect(help.plain).toBe("Title.");
    expect(help.n).toBe("(integer)");
  });

  it("attributeName follows Commander's camelCase for dashed flags and keeps underscores", () => {
    expect(attributeName("plan_id")).toBe("plan_id");
    expect(attributeName("param-json")).toBe("paramJson");
  });

  it("refuses property names outside the allowlist (remote keys are not sanitized as strings)", () => {
    for (const bad of ["plan\u001b[31m_id", "with space", "1starts_with_digit", "dash-name", "a.b", ""]) {
      expect(() => flagSpecsFromSchema({ type: "object", properties: { [bad]: { type: "string" } } })).toThrow(/not a valid flag name/);
    }
    for (const ok of ["plan_id", "_x", "Camel9", "children_ages"]) {
      expect(flagSpecsFromSchema({ type: "object", properties: { [ok]: { type: "string" } } })).toHaveLength(1);
    }
  });

  it("handles an absent or empty schema", () => {
    expect(flagSpecsFromSchema(undefined)).toEqual([]);
    expect(flagSpecsFromSchema({ type: "object" })).toEqual([]);
  });
});

describe("parsing flags into tool arguments", () => {
  it("sends only the flags that were passed, typed", async () => {
    const args = await parseArgs("list_plans", ["--limit", "2", "--relationship", "owner"]);
    expect(args).toEqual({ limit: 2, relationship: "owner" });
  });

  it("collects repeatable array flags, coercing items", async () => {
    expect(await parseArgs("search_hotels", ["--location", "Lisbon", "--checkin", "2026-10-01", "--checkout", "2026-10-04", "--children_ages", "4", "9"])).toEqual({
      location: "Lisbon",
      checkin: "2026-10-01",
      checkout: "2026-10-04",
      children_ages: [4, 9],
    });
    expect(await parseArgs("book_plan", ["--plan_id", "p", "--expect_total_cents", "1000", "--item_ids", "a", "--item_ids", "b"])).toEqual({
      plan_id: "p",
      expect_total_cents: 1000,
      item_ids: ["a", "b"],
    });
  });

  it("parses booleans: bare flag, explicit true/false", async () => {
    expect(await parseArgs("refresh_options", ["--selection_id", "s", "--force"])).toEqual({ selection_id: "s", force: true });
    expect(await parseArgs("refresh_options", ["--selection_id", "s", "--force", "false"])).toEqual({ selection_id: "s", force: false });
    expect(parseBoolean("yes")).toBe(true);
    expect(parseBoolean("0")).toBe(false);
    expect(() => parseBoolean("maybe")).toThrow(/true or false/);
  });

  it("parses JSON flags and validates their shape", async () => {
    const travellers = [{ first_name: "Jane", last_name: "Doe" }];
    expect(await parseArgs("add_travellers", ["--plan_id", "p", "--travellers", JSON.stringify(travellers)])).toEqual({ plan_id: "p", travellers });
    await expect(parseArgs("add_travellers", ["--plan_id", "p", "--travellers", '{"not":"an array"}'])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    await expect(parseArgs("add_travellers", ["--plan_id", "p", "--travellers", "nope"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });

  it("rejects a value outside an enum, a non-integer, non-finite numbers, and a missing required flag", async () => {
    await expect(parseArgs("list_plans", ["--relationship", "friend"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    await expect(parseArgs("list_plans", ["--limit", "2.5"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    // Number("Infinity") / Number("1e309") are non-finite; JSON.stringify would send null.
    for (const bad of ["Infinity", "-Infinity", "1e309", "NaN"]) {
      await expect(parseArgs("list_plans", ["--limit", bad])).rejects.toMatchObject({ code: "commander.invalidArgument" });
      await expect(parseArgs("search_hotels", ["--location", "x", "--checkin", "d", "--checkout", "d", "--children_ages", bad])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    }
    await expect(parseArgs("get_plan_status", [])).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
  });

  it("sends JSON null for the literal `null` on nullable flags, from the fixture schemas", async () => {
    expect(await parseArgs("update_plan", ["--plan_id", "p", "--cover_media_id", "null"])).toEqual({ plan_id: "p", cover_media_id: null });
    expect(await parseArgs("update_plan", ["--plan_id", "p", "--cover_media_id", "m1", "--description", "null"])).toEqual({ plan_id: "p", cover_media_id: "m1", description: null });
    // anyOf string|null is a plain string flag, not a JSON literal.
    expect(await parseArgs("update_guide_event", ["--event_id", "e", "--local_time", "09:30"])).toEqual({ event_id: "e", local_time: "09:30" });
    expect(await parseArgs("update_guide_event", ["--event_id", "e", "--local_time", "null", "--duration_minutes", "null"])).toEqual({ event_id: "e", local_time: null, duration_minutes: null });
    expect(await parseArgs("update_guide_event", ["--event_id", "e", "--duration_minutes", "12"])).toEqual({ event_id: "e", duration_minutes: 12 });
    await expect(parseArgs("update_guide_event", ["--event_id", "e", "--duration_minutes", "x"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });

  it("keeps `null` a literal value on non-nullable flags, and case-sensitive on nullable ones", async () => {
    const schema: McpJsonSchema = {
      type: "object",
      properties: {
        s: { type: "string" },
        n: { type: "integer" },
        ns: { type: ["string", "null"] },
        ne: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
        e: { type: "string", enum: ["a", "b"] },
        nb: { type: ["boolean", "null"] },
        no: { anyOf: [{ type: "object" }, { type: "null" }] },
        o: { type: "object" },
      },
    };
    expect(await parseSchema("t", schema, ["--s", "null"])).toEqual({ s: "null" });
    await expect(parseSchema("t", schema, ["--n", "null"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    await expect(parseSchema("t", schema, ["--e", "null"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    await expect(parseSchema("t", schema, ["--o", "null"])).rejects.toMatchObject({ code: "commander.invalidArgument" });

    expect(await parseSchema("t", schema, ["--ns", "null"])).toEqual({ ns: null });
    expect(await parseSchema("t", schema, ["--ns", "abc"])).toEqual({ ns: "abc" });
    expect(await parseSchema("t", schema, ["--ns", "NULL"])).toEqual({ ns: "NULL" });
    expect(await parseSchema("t", schema, ["--ne", "null"])).toEqual({ ne: null });
    expect(await parseSchema("t", schema, ["--ne", "a"])).toEqual({ ne: "a" });
    await expect(parseSchema("t", schema, ["--ne", "c"])).rejects.toMatchObject({ code: "commander.invalidArgument", message: expect.stringContaining("Allowed choices are a, b.") });
    expect(await parseSchema("t", schema, ["--nb", "null"])).toEqual({ nb: null });
    expect(await parseSchema("t", schema, ["--nb", "false"])).toEqual({ nb: false });
    expect(await parseSchema("t", schema, ["--no", "null"])).toEqual({ no: null });
    expect(await parseSchema("t", schema, ["--no", '{"k":1}'])).toEqual({ no: { k: 1 } });
    await expect(parseSchema("t", schema, ["--no", "[1]"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });

  it("every fixture tool registers without option-name conflicts", () => {
    for (const t of FIXTURE_TOOLS) {
      const cmd = new Command(t.name);
      applyFlagsToCommand(cmd, flagSpecsFromSchema(t.inputSchema));
      cmd.option("--json", "json");
      const longs = cmd.options.map((o) => o.long);
      expect(new Set(longs).size).toBe(longs.length);
    }
  });
});
