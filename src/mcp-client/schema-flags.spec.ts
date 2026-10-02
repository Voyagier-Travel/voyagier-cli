import { describe, it, expect } from "@jest/globals";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import type { McpJsonSchema, McpToolDescriptor } from "./client.js";
import { applyFlagsToCommand, attributeName, buildToolArguments, flagSpecsFromSchema, optionForSpec, parseBoolean, resolveRef } from "./schema-flags.js";

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
    // A nullable array of scalars stays a repeatable flag and keeps its nullability (lone `null` clears).
    expect(specs.l).toMatchObject({ kind: "array", itemKind: "string", nullable: true });
    // Non-nullable shapes are untouched: no `nullable` key, same kinds as before.
    expect(specs.plain).toEqual({ param: "plain", flag: "plain", attribute: "plain", required: false, description: "", kind: "string" });
    expect(specs.union).toMatchObject({ kind: "json" });
    expect(specs.union.nullable).toBeUndefined();
  });

  it("resolves the fixture's nullable params to their base kinds; the only required one is set_plan_lead.traveller_id", async () => {
    const update = Object.fromEntries(flagSpecsFromSchema(tool("update_plan").inputSchema).map((s) => [s.param, s]));
    expect(update.cover_media_id).toMatchObject({ kind: "string", nullable: true, required: false });
    expect(update.description).toMatchObject({ kind: "string", nullable: true, required: false });
    const event = Object.fromEntries(flagSpecsFromSchema(tool("update_guide_event").inputSchema).map((s) => [s.param, s]));
    expect(event.local_time).toMatchObject({ kind: "string", nullable: true });
    expect(event.duration_minutes).toMatchObject({ kind: "integer", nullable: true });

    // A required nullable property means "always say, and null is a valid
    // answer". The sentinel stays unambiguous: the flag must be given, and
    // `null` is the one spelling that sends JSON null. set_plan_lead is the
    // only tool published this way (traveller_id null clears the lead); pin
    // the list so a new one is a deliberate decision, not a surprise.
    const requiredNullable = FIXTURE_TOOLS.flatMap((t) =>
      flagSpecsFromSchema(t.inputSchema)
        .filter((s) => s.nullable && s.required)
        .map((s) => `${t.name}.${s.param}`),
    );
    expect(requiredNullable).toEqual(["set_plan_lead.traveller_id"]);
    const lead = Object.fromEntries(flagSpecsFromSchema(tool("set_plan_lead").inputSchema).map((s) => [s.param, s]));
    expect(lead.traveller_id).toMatchObject({ kind: "string", nullable: true, required: true });
    expect(optionForSpec(lead.traveller_id).description).toBe(
      "(required) Plan traveller id (from list_travellers), or null to clear the lead. (pass null to clear)",
    );
    await expect(parseArgs("set_plan_lead", ["--plan_id", "p1", "--traveller_id", "t1"])).resolves.toEqual({ plan_id: "p1", traveller_id: "t1" });
    await expect(parseArgs("set_plan_lead", ["--plan_id", "p1", "--traveller_id", "null"])).resolves.toEqual({ plan_id: "p1", traveller_id: null });
    // Required means required: omitting the flag is still an error, null or not.
    await expect(parseArgs("set_plan_lead", ["--plan_id", "p1"])).rejects.toThrow(/traveller_id/);
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

  it("resolves a local $ref on an items schema, so the fixture's exclude_airlines is a repeatable string flag like airlines", () => {
    for (const name of ["search_flights", "get_search_status"]) {
      const specs = Object.fromEntries(flagSpecsFromSchema(tool(name).inputSchema).map((s) => [s.param, s]));
      expect(specs.airlines).toMatchObject({ kind: "array", itemKind: "string" });
      expect(specs.exclude_airlines).toMatchObject({ kind: "array", itemKind: "string" });
      expect(specs.exclude_airlines.jsonShape).toBeUndefined();
      // The referrer's own description is kept, not the target's.
      expect(specs.exclude_airlines.description).toMatch(/^Never these airlines/);
      expect(optionForSpec(specs.exclude_airlines).flags).toBe("--exclude_airlines <value...>");
    }
  });

  it("resolves #/definitions and #/$defs references on properties and items, chained, with sibling keywords winning", () => {
    const schema: McpJsonSchema = {
      type: "object",
      definitions: {
        code: { type: "string", pattern: "^[A-Z]{2}$", description: "target text" },
        codes: { type: "array", items: { $ref: "#/definitions/code" } },
        "a/b": { type: "integer" },
        a: { b: { type: "boolean" } },
        "x~1": { type: "number" },
      },
      $defs: { count: { type: "integer" }, alias: { $ref: "#/definitions/codes" }, deep: { $ref: "#/$defs/alias" } },
      properties: {
        one: { $ref: "#/definitions/code" },
        described: { $ref: "#/definitions/code", description: "mine" },
        many: { type: "array", items: { $ref: "#/definitions/code" } },
        viaDefs: { $ref: "#/$defs/count" },
        list: { $ref: "#/definitions/codes" },
        chained: { $ref: "#/$defs/deep" },
        nullableRef: { anyOf: [{ $ref: "#/definitions/codes" }, { type: "null" }] },
        viaProperty: { $ref: "#/properties/one" },
        escaped: { $ref: "#/definitions/a~1b" },
        // RFC 6901 §6: the fragment is percent-decoded as a whole, so %2F is a separator.
        percentSlash: { $ref: "#/definitions/a%2Fb" },
        // RFC 6901 §4: ~1 is unescaped before ~0, so ~01 is the literal key "x~1".
        tildeOrder: { $ref: "#/definitions/x~01" },
      },
    };
    const specs = Object.fromEntries(flagSpecsFromSchema(schema).map((s) => [s.param, s]));
    expect(specs.one).toMatchObject({ kind: "string", description: "target text" });
    expect(specs.described).toMatchObject({ kind: "string", description: "mine" });
    expect(specs.many).toMatchObject({ kind: "array", itemKind: "string" });
    expect(specs.viaDefs).toMatchObject({ kind: "integer" });
    expect(specs.list).toMatchObject({ kind: "array", itemKind: "string" });
    expect(specs.chained).toMatchObject({ kind: "array", itemKind: "string" });
    expect(specs.nullableRef).toMatchObject({ kind: "array", itemKind: "string", nullable: true });
    expect(specs.viaProperty).toMatchObject({ kind: "string", description: "target text" });
    expect(specs.escaped).toMatchObject({ kind: "integer" });
    expect(specs.percentSlash).toMatchObject({ kind: "boolean" });
    expect(specs.tildeOrder).toMatchObject({ kind: "number" });
  });

  it("leaves a reference it cannot resolve locally as a JSON flag, and never loops on a cycle", () => {
    const schema: McpJsonSchema = {
      type: "object",
      definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } },
      properties: {
        dangling: { $ref: "#/definitions/missing" },
        remote: { $ref: "https://example.test/schema.json#/x" },
        cyclic: { $ref: "#/definitions/a" },
        danglingItems: { type: "array", items: { $ref: "#/definitions/missing" } },
      },
    };
    const specs = Object.fromEntries(flagSpecsFromSchema(schema).map((s) => [s.param, s]));
    expect(specs.dangling).toMatchObject({ kind: "json" });
    expect(specs.remote).toMatchObject({ kind: "json" });
    expect(specs.cyclic).toMatchObject({ kind: "json" });
    expect(specs.danglingItems).toMatchObject({ kind: "json", jsonShape: "array" });
    // The resolver hands back the node minus $ref, so callers never see one.
    expect(resolveRef(schema, { $ref: "#/definitions/a" })).toEqual({});
    expect(resolveRef(schema, { type: "string" })).toEqual({ type: "string" });
  });

  it("gives every repeatable array flag a --no-<flag> companion that sends [], and nothing else one", () => {
    const specs = flagSpecsFromSchema(tool("get_search_status").inputSchema);
    const cmd = new Command("get_search_status");
    applyFlagsToCommand(cmd, specs);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(["--airlines", "--no-airlines", "--exclude_airlines", "--no-exclude_airlines"]));
    expect(longs).not.toContain("--no-search_id");
    expect(longs).not.toContain("--no-limit");
    expect(longs).not.toContain("--no-sort");
    const negated = cmd.options.find((o) => o.long === "--no-airlines")!;
    expect(negated.description).toBe("Send an empty list for --airlines (where the tool clears a stored value on []).");
    // JSON-array flags take the literal `[]`; they get no negation.
    const travellers = new Command("add_travellers");
    applyFlagsToCommand(travellers, flagSpecsFromSchema(tool("add_travellers").inputSchema));
    expect(travellers.options.map((o) => o.long)).not.toContain("--no-travellers");
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

  it("sends JSON null for a lone `null` on a nullable scalar array, and refuses to mix it with values", async () => {
    const schema: McpJsonSchema = {
      type: "object",
      properties: {
        tags: { type: ["array", "null"], items: { type: "string" } },
        nums: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }] },
        plain: { type: "array", items: { type: "string" } },
      },
    };
    const specs = Object.fromEntries(flagSpecsFromSchema(schema).map((s) => [s.param, s]));
    expect(specs.tags).toMatchObject({ kind: "array", itemKind: "string", nullable: true });
    expect(specs.nums).toMatchObject({ kind: "array", itemKind: "integer", nullable: true });
    expect(specs.plain).toMatchObject({ kind: "array", itemKind: "string" });
    expect(specs.plain.nullable).toBeUndefined();
    expect(optionForSpec(specs.tags).description).toContain("(repeatable strings; pass null to clear)");
    expect(optionForSpec(specs.plain).description).toContain("(repeatable strings)");
    expect(optionForSpec(specs.plain).description).not.toContain("null");

    expect(await parseSchema("t", schema, ["--tags", "null"])).toEqual({ tags: null });
    expect(await parseSchema("t", schema, ["--nums", "null"])).toEqual({ nums: null });
    expect(await parseSchema("t", schema, ["--tags", "a", "b"])).toEqual({ tags: ["a", "b"] });
    expect(await parseSchema("t", schema, ["--tags", "a", "--tags", "b"])).toEqual({ tags: ["a", "b"] });
    expect(await parseSchema("t", schema, ["--nums", "1", "2"])).toEqual({ nums: [1, 2] });
    // Non-nullable arrays keep `null` as an ordinary item.
    expect(await parseSchema("t", schema, ["--plain", "null"])).toEqual({ plain: ["null"] });
    // The sentinel stands for the whole list, so it cannot sit next to a value.
    for (const argv of [["--tags", "null", "a"], ["--tags", "a", "null"], ["--tags", "null", "--tags", "a"], ["--tags", "a", "--tags", "null"]]) {
      await expect(parseSchema("t", schema, argv)).rejects.toMatchObject({
        code: "commander.invalidArgument",
        message: expect.stringContaining("cannot be combined with other values"),
      });
    }
  });

  it("sends [] for --no-<flag> on an array flag, nothing when the flag is omitted, and the last spelling wins", async () => {
    expect(await parseArgs("get_search_status", ["--search_id", "s"])).toEqual({ search_id: "s" });
    expect(await parseArgs("get_search_status", ["--search_id", "s", "--no-airlines"])).toEqual({ search_id: "s", airlines: [] });
    expect(await parseArgs("get_search_status", ["--search_id", "s", "--no-airlines", "--no-exclude_airlines"])).toEqual({
      search_id: "s",
      airlines: [],
      exclude_airlines: [],
    });
    // The referenced items schema parses exactly like the inline one.
    expect(await parseArgs("get_search_status", ["--search_id", "s", "--exclude_airlines", "UA", "DL"])).toEqual({ search_id: "s", exclude_airlines: ["UA", "DL"] });
    expect(await parseArgs("search_flights", ["--from", "BWI", "--to", "LIS", "--date", "2026-11-20", "--exclude_airlines", "UA", "--exclude_airlines", "DL", "--airlines", "TP"])).toEqual({
      from: "BWI",
      to: "LIS",
      date: "2026-11-20",
      exclude_airlines: ["UA", "DL"],
      airlines: ["TP"],
    });
    // Commander's negation shares the attribute: whichever comes last wins.
    expect(await parseArgs("get_search_status", ["--search_id", "s", "--airlines", "UA", "--no-airlines"])).toEqual({ search_id: "s", airlines: [] });
    expect(await parseArgs("get_search_status", ["--search_id", "s", "--no-airlines", "--airlines", "UA", "DL"])).toEqual({ search_id: "s", airlines: ["UA", "DL"] });
    // A literal "[]" is a value, not a clear.
    expect(await parseArgs("get_search_status", ["--search_id", "s", "--airlines", "[]"])).toEqual({ search_id: "s", airlines: ["[]"] });
    // Numeric arrays negate the same way.
    expect(await parseArgs("search_hotels", ["--location", "Lisbon", "--checkin", "2026-10-01", "--checkout", "2026-10-04", "--no-children_ages"])).toEqual({
      location: "Lisbon",
      checkin: "2026-10-01",
      checkout: "2026-10-04",
      children_ages: [],
    });
  });

  it("--no-<flag> and the null sentinel are distinct on a nullable array: [] versus null", async () => {
    const schema: McpJsonSchema = { type: "object", properties: { tags: { type: ["array", "null"], items: { type: "string" } } } };
    expect(await parseSchema("t", schema, ["--no-tags"])).toEqual({ tags: [] });
    expect(await parseSchema("t", schema, ["--tags", "null"])).toEqual({ tags: null });
    expect(await parseSchema("t", schema, ["--no-tags", "--tags", "null"])).toEqual({ tags: null });
    expect(await parseSchema("t", schema, ["--tags", "null", "--no-tags"])).toEqual({ tags: [] });
  });

  describe("JSON-literal flags document their keys", () => {
    it("lists the keys of an array-of-objects flag from items.properties, marking required ones", () => {
      const specs = Object.fromEntries(flagSpecsFromSchema(tool("set_airport").inputSchema).map((s) => [s.param, s]));
      expect(specs.groups).toMatchObject({ kind: "json", jsonShape: "array", required: true });
      expect(specs.groups.jsonKeys).toEqual([
        { name: "code", required: true, type: "string", description: expect.stringMatching(/IATA/) },
        { name: "traveller_names", required: false, type: "string[]", description: expect.any(String) },
        { name: "traveller_ids", required: false, type: "string[]", description: expect.any(String) },
      ]);
      const help = optionForSpec(specs.groups).description;
      expect(help).toContain("(JSON array of {code*, traveller_names, traveller_ids})");
      expect(help).toMatch(/Keys: code \(required, string\) — IATA airport or metro code/);
      expect(help).toMatch(/traveller_names \(string\[\]\) — /);
      expect(help).not.toContain("(JSON array)");
    });

    it("lists the keys of an object flag from properties, with enum choices as the type", () => {
      const schema: McpJsonSchema = {
        type: "object",
        properties: {
          passport: {
            type: "object",
            description: "Passport.",
            properties: {
              number: { type: "string", description: "Document number." },
              country: { type: "string", enum: ["US", "CA"] },
              expires: { type: ["string", "null"] },
            },
            required: ["number"],
          },
        },
      };
      const [spec] = flagSpecsFromSchema(schema);
      expect(spec.jsonKeys).toEqual([
        { name: "number", required: true, type: "string", description: "Document number." },
        { name: "country", required: false, type: "US|CA" },
        { name: "expires", required: false, type: "string" },
      ]);
      const help = optionForSpec(spec).description;
      expect(help).toBe("Passport. (JSON {number*, country, expires}) Keys: number (required, string) — Document number; country (US|CA); expires (string).");
    });

    it("keeps the bare shape hint when the schema names no keys", () => {
      const specs = Object.fromEntries(
        flagSpecsFromSchema({ type: "object", properties: { o: { type: "object" }, a: { type: "array", items: { type: "object" } }, x: {} } }).map((s) => [s.param, s]),
      );
      expect(specs.o.jsonKeys).toBeUndefined();
      expect(optionForSpec(specs.o).description).toBe("(JSON object)");
      expect(optionForSpec(specs.a).description).toBe("(JSON array)");
      expect(optionForSpec(specs.x).description).toBe("(JSON)");
    });

    it("documents the keys of a nullable object flag (anyOf with null) from the fixture", () => {
      const specs = Object.fromEntries(flagSpecsFromSchema(tool("update_traveller").inputSchema).map((s) => [s.param, s]));
      expect(specs.passport).toMatchObject({ kind: "json", jsonShape: "object", nullable: true });
      expect(specs.passport.jsonKeys?.map((k) => k.name)).toEqual(["passport_number", "issue_country", "nationality_country", "expiration_date"]);
      const help = optionForSpec(specs.passport).description;
      expect(help).toContain("(JSON {passport_number*, issue_country*, nationality_country*, expiration_date*}; pass null to clear)");
      expect(help).toMatch(/Keys: passport_number \(required, string\) — Passport number: letters and digits only \(no spaces, hyphens or punctuation\);/);
    });

    it("resolves a local $ref on the items schema and on nested properties", () => {
      const schema: McpJsonSchema = {
        type: "object",
        properties: { rows: { type: "array", items: { $ref: "#/$defs/row" } } },
        $defs: { row: { type: "object", properties: { id: { $ref: "#/$defs/id" }, qty: { type: "integer" } }, required: ["id"] }, id: { type: "string", description: "Row id." } },
      };
      const [spec] = flagSpecsFromSchema(schema);
      expect(spec.jsonKeys).toEqual([
        { name: "id", required: true, type: "string", description: "Row id." },
        { name: "qty", required: false, type: "integer" },
      ]);
      expect(optionForSpec(spec).description).toContain("(JSON array of {id*, qty})");
    });

    it("leaves out a key whose name is not a valid flag name and lists many keys by name only", () => {
      const props: Record<string, McpJsonSchema> = { "bad key": { type: "string" } };
      for (let i = 0; i < 13; i++) props[`k${i}`] = { type: "string", description: `Key ${i}.` };
      const [spec] = flagSpecsFromSchema({ type: "object", properties: { o: { type: "object", properties: props, required: ["k0"] } } });
      expect(spec.jsonKeys?.map((k) => k.name)).toEqual(Array.from({ length: 13 }, (_, i) => `k${i}`));
      const help = optionForSpec(spec).description;
      expect(help).toContain("(JSON {k0*, k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12})");
      expect(help).toContain("Keys: k0 (required), k1, k2,");
      expect(help).not.toContain("Key 0.");
      expect(help).not.toContain("bad key");
    });

    it("names the expected shape in the parse error for a malformed or mis-shaped literal", async () => {
      const argv = ["--selection_id", "sel"];
      await expect(parseArgs("set_airport", [...argv, "--groups", "not json"])).rejects.toThrow(
        "--groups expects a JSON literal (JSON array of {code*, traveller_names, traveller_ids}).",
      );
      await expect(parseArgs("set_airport", [...argv, "--groups", '{"code":"BWI"}'])).rejects.toThrow(
        "--groups expects a JSON array of {code*, traveller_names, traveller_ids}.",
      );
      // A well-formed literal still parses; nothing is validated against the keys client-side.
      expect(await parseArgs("set_airport", [...argv, "--groups", '[{"code":"BWI"}]'])).toEqual({ selection_id: "sel", groups: [{ code: "BWI" }] });
    });
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
