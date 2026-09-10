/**
 * JSON Schema (tool inputSchema) → Commander flags, and parsed flags → tool
 * arguments. One flag per top-level property, named after the property
 * (`--plan_id`), so the CLI's `--help` reads exactly like the tool's schema.
 *
 * Type mapping:
 *  - string                       → `--name <value>`
 *  - number / integer             → `--name <n>` (validated; integer must be whole)
 *  - boolean                      → `--name [true|false]` (bare flag = true)
 *  - string with enum             → `--name <choice>` with Commander choices
 *  - array of string/number/int   → `--name <value...>` (repeatable / space-separated)
 *  - object, array of objects,
 *    anything else                → `--name <json>` (a JSON literal)
 *
 * Required properties become Commander required options, so a missing one is
 * a parse error — which already flows through the CLI's VALIDATION envelope.
 */
import { Command, InvalidArgumentError, Option } from "commander";
import type { McpJsonSchema } from "./client.js";

export type FlagKind = "string" | "number" | "integer" | "boolean" | "enum" | "array" | "json";

export interface FlagSpec {
  /** Schema property name (what the tool receives). */
  param: string;
  /** Long flag without dashes (usually === param). */
  flag: string;
  /** Commander attribute the parsed value lands on. */
  attribute: string;
  kind: FlagKind;
  /** Item type for `array`. */
  itemKind?: "string" | "number" | "integer";
  enumValues?: string[];
  required: boolean;
  description: string;
  /** Expected JSON shape for `json` flags (help text only). */
  jsonShape?: "object" | "array";
}

/** Flag names Commander or the CLI already own on every command. */
const RESERVED_FLAGS = new Set(["json", "help", "version", "stacktrace", "verbose"]);

function primaryType(schema: McpJsonSchema): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null");
  return t;
}

/** Derive the flag specs for a tool input schema (object with properties). */
export function flagSpecsFromSchema(schema: McpJsonSchema | undefined): FlagSpec[] {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const specs: FlagSpec[] = [];
  for (const [param, prop] of Object.entries(properties)) {
    const flag = RESERVED_FLAGS.has(param) ? `param-${param}` : param;
    const description = describe(prop);
    const type = primaryType(prop);
    const base = {
      param,
      flag,
      attribute: attributeName(flag),
      required: required.has(param),
      description,
    };
    if (Array.isArray(prop.enum) && prop.enum.length > 0 && (type === undefined || type === "string")) {
      specs.push({ ...base, kind: "enum", enumValues: prop.enum.map(String) });
    } else if (type === "boolean") {
      specs.push({ ...base, kind: "boolean" });
    } else if (type === "integer") {
      specs.push({ ...base, kind: "integer" });
    } else if (type === "number") {
      specs.push({ ...base, kind: "number" });
    } else if (type === "string") {
      specs.push({ ...base, kind: "string" });
    } else if (type === "array") {
      const itemType = prop.items ? primaryType(prop.items) : undefined;
      if (itemType === "string" || itemType === "number" || itemType === "integer") {
        specs.push({ ...base, kind: "array", itemKind: itemType });
      } else {
        specs.push({ ...base, kind: "json", jsonShape: "array" });
      }
    } else if (type === "object") {
      specs.push({ ...base, kind: "json", jsonShape: "object" });
    } else {
      specs.push({ ...base, kind: "json" });
    }
  }
  return specs;
}

function describe(prop: McpJsonSchema): string {
  const parts: string[] = [];
  if (typeof prop.description === "string" && prop.description.trim()) parts.push(prop.description.trim());
  if (prop.default !== undefined) parts.push(`Default: ${JSON.stringify(prop.default)}.`);
  return parts.join(" ");
}

/** Commander's camelCase attribute for a long flag (`plan-id` → `planId`; underscores kept). */
export function attributeName(flag: string): string {
  return flag.split("-").reduce((acc, word) => (acc ? acc + word[0].toUpperCase() + word.slice(1) : word));
}

/** Human help suffix per kind, appended to the schema description. */
function kindHint(spec: FlagSpec): string {
  switch (spec.kind) {
    case "integer":
      return "(integer)";
    case "number":
      return "(number)";
    case "boolean":
      return "(true|false; bare flag = true)";
    case "array":
      return `(repeatable ${spec.itemKind}s)`;
    case "json":
      return spec.jsonShape ? `(JSON ${spec.jsonShape})` : "(JSON)";
    default:
      return "";
  }
}

function parseNumber(kind: "number" | "integer", value: string): number {
  const n = Number(value);
  if (value.trim() === "" || Number.isNaN(n)) throw new InvalidArgumentError(`expected ${kind === "integer" ? "an" : "a"} ${kind}, got "${value}".`);
  if (kind === "integer" && !Number.isInteger(n)) throw new InvalidArgumentError(`expected an integer, got "${value}".`);
  return n;
}

export function parseBoolean(value: string | boolean | undefined): boolean {
  if (value === undefined || value === true) return true;
  if (value === false) return false;
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;
  throw new InvalidArgumentError(`expected true or false, got "${value}".`);
}

function parseJsonValue(spec: FlagSpec, value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError(`--${spec.flag} expects a JSON literal${spec.jsonShape ? ` (${spec.jsonShape})` : ""}.`);
  }
  if (spec.jsonShape === "array" && !Array.isArray(parsed)) {
    throw new InvalidArgumentError(`--${spec.flag} expects a JSON array.`);
  }
  if (spec.jsonShape === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new InvalidArgumentError(`--${spec.flag} expects a JSON object.`);
  }
  return parsed;
}

/** Build the Commander Option for one spec. */
export function optionForSpec(spec: FlagSpec): Option {
  const desc = [spec.required ? "(required)" : "", spec.description, kindHint(spec)].filter(Boolean).join(" ");
  let option: Option;
  switch (spec.kind) {
    case "boolean":
      option = new Option(`--${spec.flag} [value]`, desc).argParser((v: string) => parseBoolean(v));
      break;
    case "integer":
    case "number": {
      const kind = spec.kind;
      option = new Option(`--${spec.flag} <n>`, desc).argParser((v: string) => parseNumber(kind, v));
      break;
    }
    case "enum":
      option = new Option(`--${spec.flag} <choice>`, desc).choices(spec.enumValues ?? []);
      break;
    case "array": {
      const itemKind = spec.itemKind ?? "string";
      option = new Option(`--${spec.flag} <value...>`, desc).argParser((v: string, previous: unknown[] | undefined) => {
        const item = itemKind === "string" ? v : parseNumber(itemKind, v);
        return [...(previous ?? []), item];
      });
      break;
    }
    case "json":
      option = new Option(`--${spec.flag} <json>`, desc).argParser((v: string) => parseJsonValue(spec, v));
      break;
    case "string":
    default:
      option = new Option(`--${spec.flag} <value>`, desc);
  }
  if (spec.required) option.makeOptionMandatory(true);
  return option;
}

/** Register every spec on `cmd`. */
export function applyFlagsToCommand(cmd: Command, specs: FlagSpec[]): void {
  for (const spec of specs) cmd.addOption(optionForSpec(spec));
}

/**
 * Convert parsed Commander options into the tool's argument object. Only
 * flags the user passed are sent (no explicit nulls/undefined), so the
 * server's own defaults apply.
 */
export function buildToolArguments(specs: FlagSpec[], opts: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = opts[spec.attribute];
    if (value === undefined) continue;
    if (spec.kind === "boolean") {
      args[spec.param] = typeof value === "string" ? parseBoolean(value) : Boolean(value);
      continue;
    }
    args[spec.param] = value;
  }
  return args;
}
