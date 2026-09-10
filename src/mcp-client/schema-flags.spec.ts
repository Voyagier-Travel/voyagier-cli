import { describe, it, expect } from "@jest/globals";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import type { McpToolDescriptor } from "./client.js";
import { applyFlagsToCommand, attributeName, buildToolArguments, flagSpecsFromSchema, parseBoolean } from "./schema-flags.js";

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
  const specs = flagSpecsFromSchema(tool(name).inputSchema);
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
    expect(byParam.hotel_name.description).toMatch(/SPECIFIC property/);
  });

  it("maps enums, booleans, arrays of strings and object/array-of-object to the right kinds", () => {
    const plansList = Object.fromEntries(flagSpecsFromSchema(tool("plans_list").inputSchema).map((s) => [s.param, s]));
    expect(plansList.relationship).toMatchObject({ kind: "enum", enumValues: ["owner", "shared"] });
    expect(plansList.limit).toMatchObject({ kind: "integer" });

    const refresh = Object.fromEntries(flagSpecsFromSchema(tool("refresh_options").inputSchema).map((s) => [s.param, s]));
    expect(refresh.force).toMatchObject({ kind: "boolean" });

    const book = Object.fromEntries(flagSpecsFromSchema(tool("book").inputSchema).map((s) => [s.param, s]));
    expect(book.item_ids).toMatchObject({ kind: "array", itemKind: "string", required: true });
    expect(book.expect_total_cents).toMatchObject({ kind: "integer", required: true });

    const travellersAdd = Object.fromEntries(flagSpecsFromSchema(tool("travellers_add").inputSchema).map((s) => [s.param, s]));
    expect(travellersAdd.travellers).toMatchObject({ kind: "json", jsonShape: "array", required: true });

    const update = Object.fromEntries(flagSpecsFromSchema(tool("travellers_update").inputSchema).map((s) => [s.param, s]));
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
    expect(spec.description).toBe("Count. Default: 3.");
  });

  it("attributeName follows Commander's camelCase for dashed flags and keeps underscores", () => {
    expect(attributeName("plan_id")).toBe("plan_id");
    expect(attributeName("param-json")).toBe("paramJson");
  });

  it("handles an absent or empty schema", () => {
    expect(flagSpecsFromSchema(undefined)).toEqual([]);
    expect(flagSpecsFromSchema({ type: "object" })).toEqual([]);
  });
});

describe("parsing flags into tool arguments", () => {
  it("sends only the flags that were passed, typed", async () => {
    const args = await parseArgs("plans_list", ["--limit", "2", "--relationship", "owner"]);
    expect(args).toEqual({ limit: 2, relationship: "owner" });
  });

  it("collects repeatable array flags, coercing items", async () => {
    expect(await parseArgs("search_hotels", ["--location", "Lisbon", "--checkin", "2026-10-01", "--checkout", "2026-10-04", "--children_ages", "4", "9"])).toEqual({
      location: "Lisbon",
      checkin: "2026-10-01",
      checkout: "2026-10-04",
      children_ages: [4, 9],
    });
    expect(await parseArgs("book", ["--plan_id", "p", "--expect_total_cents", "1000", "--item_ids", "a", "--item_ids", "b"])).toEqual({
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
    expect(await parseArgs("travellers_add", ["--plan_id", "p", "--travellers", JSON.stringify(travellers)])).toEqual({ plan_id: "p", travellers });
    await expect(parseArgs("travellers_add", ["--plan_id", "p", "--travellers", '{"not":"an array"}'])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    await expect(parseArgs("travellers_add", ["--plan_id", "p", "--travellers", "nope"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
  });

  it("rejects a value outside an enum, a non-integer, non-finite numbers, and a missing required flag", async () => {
    await expect(parseArgs("plans_list", ["--relationship", "friend"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    await expect(parseArgs("plans_list", ["--limit", "2.5"])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    // Number("Infinity") / Number("1e309") are non-finite; JSON.stringify would send null.
    for (const bad of ["Infinity", "-Infinity", "1e309", "NaN"]) {
      await expect(parseArgs("plans_list", ["--limit", bad])).rejects.toMatchObject({ code: "commander.invalidArgument" });
      await expect(parseArgs("search_hotels", ["--location", "x", "--checkin", "d", "--checkout", "d", "--children_ages", bad])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    }
    await expect(parseArgs("plan_status", [])).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
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
