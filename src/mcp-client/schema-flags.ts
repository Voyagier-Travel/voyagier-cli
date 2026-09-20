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
 * Nullable properties — `type: [X, "null"]` or `anyOf: [{type: X}, {type: "null"}]`
 * — keep X's flag kind and additionally accept the literal argument `null`,
 * which is sent as JSON null (the server's own "pass null to clear"). Only
 * a schema that allows null gets the sentinel; elsewhere `null` is an
 * ordinary value of the base kind.
 *
 * Required properties become Commander required options, so a missing one is
 * a parse error — which already flows through the CLI's VALIDATION envelope.
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { CliError, CliErrorCode } from "../errors.js";
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
  /** Schema allows null: the literal argument `null` is sent as JSON null. */
  nullable?: boolean;
}

/** Flag names Commander or the CLI already own on every command. */
const RESERVED_FLAGS = new Set(["json", "help", "version", "stacktrace", "verbose"]);

/** The one argument spelling that means JSON null on a nullable flag. */
const NULL_SENTINEL = "null";
/**
 * Parsed-option marker for "send JSON null". Commander treats a parser that
 * returns null as "no value" (it stores "" or true), so the parser hands back
 * this symbol and buildToolArguments turns it into null on the wire.
 */
export const JSON_NULL: unique symbol = Symbol("json null");

/**
 * Property names become Commander option names and appear in help and error
 * text. They are remote object KEYS, which the string sanitizer does not
 * touch, so they are checked against a strict allowlist instead: a name that
 * fails makes the whole tool unusable (see registerGeneratedCommands).
 */
export const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Tool names become command words. */
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function primaryType(schema: McpJsonSchema): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null");
  return t;
}

/**
 * Split a property into the schema that decides its flag kind and whether it
 * also allows null. `type: [X, "null"]` and `anyOf: [{type: X}, {type: "null"}]`
 * (the non-null member may carry `enum`, `items`, bounds) are nullable; any
 * other shape is returned as-is, so the mapping below is unchanged for it.
 */
function resolveNullable(prop: McpJsonSchema): { base: McpJsonSchema; nullable: boolean } {
  if (Array.isArray(prop.type)) return { base: prop, nullable: prop.type.includes("null") };
  if (Array.isArray(prop.anyOf)) {
    const members = prop.anyOf.filter((m): m is McpJsonSchema => typeof m === "object" && m !== null);
    const nonNull = members.filter((m) => m.type !== "null");
    if (members.length === prop.anyOf.length && nonNull.length === 1 && nonNull.length < members.length) {
      return { base: nonNull[0], nullable: true };
    }
  }
  return { base: prop, nullable: false };
}

/** Derive the flag specs for a tool input schema (object with properties). */
export function flagSpecsFromSchema(schema: McpJsonSchema | undefined): FlagSpec[] {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const specs: FlagSpec[] = [];
  for (const [param, prop] of Object.entries(properties)) {
    if (!PARAM_NAME_PATTERN.test(param)) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `Input property name ${JSON.stringify(param.slice(0, 40))} is not a valid flag name (allowed: letters, digits, underscore; must not start with a digit).`,
      );
    }
    const flag = RESERVED_FLAGS.has(param) ? `param-${param}` : param;
    const description = describe(prop);
    const { base: shape, nullable } = resolveNullable(prop);
    const type = primaryType(shape);
    const plain = {
      param,
      flag,
      attribute: attributeName(flag),
      required: required.has(param),
      description,
    };
    const base = nullable ? { ...plain, nullable } : plain;
    if (Array.isArray(shape.enum) && shape.enum.length > 0 && (type === undefined || type === "string")) {
      specs.push({ ...base, kind: "enum", enumValues: shape.enum.map(String) });
    } else if (type === "boolean") {
      specs.push({ ...base, kind: "boolean" });
    } else if (type === "integer") {
      specs.push({ ...base, kind: "integer" });
    } else if (type === "number") {
      specs.push({ ...base, kind: "number" });
    } else if (type === "string") {
      specs.push({ ...base, kind: "string" });
    } else if (type === "array") {
      const itemType = shape.items ? primaryType(shape.items) : undefined;
      if (itemType === "string" || itemType === "number" || itemType === "integer") {
        // A repeatable flag has no unambiguous slot for a null sentinel, so a
        // nullable array of scalars stays a plain repeatable flag.
        specs.push({ ...plain, kind: "array", itemKind: itemType });
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
  const hint = baseKindHint(spec);
  if (!spec.nullable) return hint;
  return hint ? `${hint.slice(0, -1)}; pass null to clear)` : "(pass null to clear)";
}

function baseKindHint(spec: FlagSpec): string {
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
  // Number.isFinite also rejects Infinity/1e309/NaN, which JSON.stringify
  // would otherwise turn into null and send as a different request.
  if (value.trim() === "" || !Number.isFinite(n)) throw new InvalidArgumentError(`expected ${kind === "integer" ? "an" : "a"} finite ${kind}, got "${value}".`);
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
  if (parsed === null && spec.nullable) return JSON_NULL;
  if (spec.jsonShape === "array" && !Array.isArray(parsed)) {
    throw new InvalidArgumentError(`--${spec.flag} expects a JSON array.`);
  }
  if (spec.jsonShape === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new InvalidArgumentError(`--${spec.flag} expects a JSON object.`);
  }
  return parsed;
}

/** Wrap a scalar parser so the literal `null` yields JSON null on a nullable spec. */
function nullableParser<T>(spec: FlagSpec, parse: (v: string) => T): (v: string) => T | typeof JSON_NULL {
  if (!spec.nullable) return parse;
  return (v: string) => (v === NULL_SENTINEL ? JSON_NULL : parse(v));
}

/** Build the Commander Option for one spec. */
export function optionForSpec(spec: FlagSpec): Option {
  const desc = [spec.required ? "(required)" : "", spec.description, kindHint(spec)].filter(Boolean).join(" ");
  let option: Option;
  switch (spec.kind) {
    case "boolean":
      option = new Option(`--${spec.flag} [value]`, desc).argParser(nullableParser(spec, (v: string) => parseBoolean(v)));
      break;
    case "integer":
    case "number": {
      const kind = spec.kind;
      option = new Option(`--${spec.flag} <n>`, desc).argParser(nullableParser(spec, (v: string) => parseNumber(kind, v)));
      break;
    }
    case "enum": {
      const choices = spec.enumValues ?? [];
      option = new Option(`--${spec.flag} <choice>`, desc).choices(choices);
      if (spec.nullable) {
        // .choices() installed the validating parser and the help listing;
        // keep the listing, re-check the choice ourselves after the sentinel.
        option.argParser(
          nullableParser(spec, (v: string) => {
            if (!choices.includes(v)) throw new InvalidArgumentError(`Allowed choices are ${choices.join(", ")}.`);
            return v;
          }),
        );
      }
      break;
    }
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
      if (spec.nullable) option.argParser(nullableParser(spec, (v: string) => v));
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
 * flags the user passed are sent (nothing for an omitted flag), so the
 * server's own defaults apply. A nullable flag given the literal `null` is
 * sent as JSON null.
 */
export function buildToolArguments(specs: FlagSpec[], opts: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = opts[spec.attribute];
    if (value === undefined) continue;
    if (value === JSON_NULL) {
      args[spec.param] = null;
      continue;
    }
    if (spec.kind === "boolean") {
      args[spec.param] = typeof value === "string" ? parseBoolean(value) : Boolean(value);
      continue;
    }
    args[spec.param] = value;
  }
  return args;
}
