/**
 * Registry contract: this CLI's MCP tool table vs the remote Voyagier MCP server.
 * ---------------------------------------------------------------------------
 * Voyagier exposes the same agent surface twice: this CLI's stdio server
 * (src/mcp/tools.ts) and the remote server at https://mcp.voyagier.com. The two
 * tool tables are maintained separately, so an agent that learned one and then
 * spoke to the other can find a tool renamed or a required input missing.
 *
 * This spec keeps the two lists aligned. It compares the CLI's TOOLS table
 * against a checked-in snapshot of the remote server's `tools/list` response
 * (fixtures/remote-tools.json — refresh with `npm run refresh:mcp-fixture`) and
 * fails when a NEW difference appears. Every difference that exists today is
 * listed below as an explicit allowlist entry: adding to one of those lists is a
 * conscious decision to let the two surfaces differ, not a formality.
 *
 * Scope, and what this deliberately does NOT check:
 *  - Parameter comparison is by NAME, from structured data on both sides: the
 *    keys of the CLI tool's zod input shape (`inputSchema`, a z.ZodRawShape) vs
 *    the remote tool's JSON Schema `properties`/`required`. No source text is
 *    matched.
 *  - Types, optionality, enums, defaults and nested object shapes are NOT
 *    compared — a zod shape and a draft-07 schema do not line up field for
 *    field, and the CLI's inputs map onto CLI flags rather than onto the remote
 *    API's argument shapes.
 *  - The subset direction is one-way on purpose: every input the remote server
 *    REQUIRES must have somewhere to land on the CLI side. Extra CLI-only
 *    parameters are fine — the CLI surface is intentionally a superset (it
 *    exposes flags like --validate and --force-checkout the remote has no
 *    equivalent for).
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { TOOLS } from "./tools.js";

// ---- The remote snapshot ---------------------------------------------------

/** The subset of an MCP `tools/list` entry this contract reads. */
interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

const REMOTE_TOOLS: RemoteTool[] = JSON.parse(
  readFileSync(new URL("./fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as RemoteTool[];

// ---- Deliberate differences ------------------------------------------------
//
// ADDING TO ANY LIST BELOW IS A CONSCIOUS DECISION. Each entry means "these two
// surfaces differ here on purpose"; an agent written against one server will hit
// that difference on the other. Prefer changing the tool table over adding an
// entry, and say why the difference has to exist when you can't.

/** Tools only this CLI exposes. */
const CLI_ONLY_TOOLS: Record<string, string> = {
  doctor: "Diagnoses the local CLI environment (auth, local state files, version) — nothing to diagnose remotely.",
  create_client: "Deprecated alias of client_create, kept for existing hosts.",
  add_traveller: "Deprecated alias of travellers_add, kept for existing hosts.",
  listings_list: "Hotel-listing browse/attach flow that only the CLI's selection commands expose.",
  listings_add_to_selection: "Pairs with listings_list.",
  book_dry_run: "Maps onto `book --dry-run`; the remote server folds the preview into quote.",
  booking_status: "Maps onto `book --status`; the remote server covers it with bookings_list.",
  agent_docs: "Ships the CLI's bundled AGENT.md reference — a local file, not a remote capability.",
};

/** Tools only the remote server exposes. */
const REMOTE_ONLY_TOOLS: Record<string, string> = {
  set_airport: "No CLI command backs it yet: the CLI resolves origin airports from `from` on search_flights/plan_trip.",
};

/**
 * Remote-required parameters that have no same-named CLI input.
 * Keyed by tool name, then by the remote parameter name.
 */
const REQUIRED_PARAM_EXCEPTIONS: Record<string, Record<string, string>> = {
  book: {
    item_ids:
      "The remote tool pins the charged set from the caller. The CLI computes itemIds itself from the plan's bookable cart items and has no --item-ids flag, so there is no CLI input to map it to; narrow the set with types / only_bookable instead.",
  },
  plan_trip: {
    client_id:
      "Same input under a different name: the CLI calls it `client` and resolves an id, email, or name (mirroring `voyagier plans create --client`).",
  },
  travellers_add: {
    travellers:
      "Different shape: the remote tool takes an array of travellers, the CLI tool adds ONE per call through flat first/last/type fields (mirroring `voyagier travellers add`). Add a party in one call with plan_trip's `travellers` input.",
  },
};

/**
 * Annotation hints that differ. Keyed by tool name, then by hint name.
 */
const ANNOTATION_EXCEPTIONS: Record<string, Record<string, string>> = {
  search_flights: {
    readOnlyHint:
      "The CLI marks its search tools read-only (they report inventory); the remote server marks them writing, since a search also creates/updates the plan's selection. Aligning these changes the hints MCP clients see, so it is tracked separately.",
  },
  search_hotels: {
    readOnlyHint: "See search_flights.",
  },
  search_activities: {
    readOnlyHint: "See search_flights.",
  },
};

// ---- Structured views of both sides ----------------------------------------

const cliByName = new Map(TOOLS.map((t) => [t.name, t]));
const remoteByName = new Map(REMOTE_TOOLS.map((t) => [t.name, t]));

/** Parameter names the CLI tool accepts (keys of its zod input shape). */
function cliParams(name: string): string[] {
  return Object.keys(cliByName.get(name)!.inputSchema);
}

/** Parameter names the remote tool REQUIRES. */
function remoteRequired(name: string): string[] {
  return remoteByName.get(name)!.inputSchema?.required ?? [];
}

/** Parameter names the remote tool declares at all. */
function remoteProps(name: string): string[] {
  return Object.keys(remoteByName.get(name)!.inputSchema?.properties ?? {});
}

/** Tool names present on both servers. */
const SHARED_TOOLS = TOOLS.map((t) => t.name)
  .filter((n) => remoteByName.has(n))
  .sort();

// ---- The contract ----------------------------------------------------------

describe("MCP tool-registry contract (CLI table vs remote server snapshot)", () => {
  it("loads both registries (sanity — the checks below would vacuously pass)", () => {
    expect(REMOTE_TOOLS.length).toBeGreaterThan(15);
    expect(TOOLS.length).toBeGreaterThan(15);
    expect(SHARED_TOOLS.length).toBeGreaterThan(15);
    // Every remote entry is a named tool with an object input schema.
    for (const tool of REMOTE_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  describe("tool-name parity", () => {
    it("exposes no CLI tool the remote server lacks, outside CLI_ONLY_TOOLS", () => {
      const unexpected = TOOLS.map((t) => t.name)
        .filter((n) => !remoteByName.has(n) && !(n in CLI_ONLY_TOOLS))
        .map(
          (n) =>
            `${n}: exists in the CLI tool table but not on the remote server. Add the tool remotely, or add "${n}" to CLI_ONLY_TOOLS in this spec with the reason it is CLI-only.`,
        );
      expect(unexpected).toEqual([]);
    });

    it("is missing no remote tool, outside REMOTE_ONLY_TOOLS", () => {
      const missing = REMOTE_TOOLS.map((t) => t.name)
        .filter((n) => !cliByName.has(n) && !(n in REMOTE_ONLY_TOOLS))
        .map(
          (n) =>
            `${n}: exists on the remote server but not in the CLI tool table. Add it to TOOLS in src/mcp/tools.ts, or add "${n}" to REMOTE_ONLY_TOOLS in this spec with the reason it stays remote-only.`,
        );
      expect(missing).toEqual([]);
    });

    it("keeps the tool-name allowlists free of stale entries", () => {
      const stale: string[] = [];
      for (const name of Object.keys(CLI_ONLY_TOOLS)) {
        if (!cliByName.has(name)) stale.push(`CLI_ONLY_TOOLS.${name}: no longer in the CLI tool table — remove the entry.`);
        else if (remoteByName.has(name)) stale.push(`CLI_ONLY_TOOLS.${name}: the remote server exposes it now — remove the entry.`);
      }
      for (const name of Object.keys(REMOTE_ONLY_TOOLS)) {
        if (!remoteByName.has(name)) stale.push(`REMOTE_ONLY_TOOLS.${name}: no longer in the remote snapshot — remove the entry.`);
        else if (cliByName.has(name)) stale.push(`REMOTE_ONLY_TOOLS.${name}: the CLI exposes it now — remove the entry.`);
      }
      expect(stale).toEqual([]);
    });
  });

  describe("shared tools accept every input the remote server requires", () => {
    it.each(SHARED_TOOLS)("%s", (name) => {
      const accepted = new Set(cliParams(name));
      const exceptions = REQUIRED_PARAM_EXCEPTIONS[name] ?? {};
      const missing = remoteRequired(name)
        .filter((param) => !accepted.has(param) && !(param in exceptions))
        .map(
          (param) =>
            `${name}.${param}: required by the remote server but not accepted by the CLI tool (accepts: ${[...accepted].join(", ")}). Add the input to TOOLS in src/mcp/tools.ts, or record the divergence under REQUIRED_PARAM_EXCEPTIONS["${name}"] in this spec.`,
        );
      expect(missing).toEqual([]);
    });

    it("keeps REQUIRED_PARAM_EXCEPTIONS free of stale entries", () => {
      const stale: string[] = [];
      for (const [name, params] of Object.entries(REQUIRED_PARAM_EXCEPTIONS)) {
        if (!cliByName.has(name) || !remoteByName.has(name)) {
          stale.push(`REQUIRED_PARAM_EXCEPTIONS.${name}: no longer a shared tool — remove the entry.`);
          continue;
        }
        const accepted = new Set(cliParams(name));
        const required = new Set(remoteRequired(name));
        for (const param of Object.keys(params)) {
          if (!required.has(param)) {
            stale.push(`REQUIRED_PARAM_EXCEPTIONS.${name}.${param}: the remote server no longer requires it — remove the entry.`);
          } else if (accepted.has(param)) {
            stale.push(`REQUIRED_PARAM_EXCEPTIONS.${name}.${param}: the CLI accepts it now — remove the entry.`);
          }
        }
      }
      expect(stale).toEqual([]);
    });
  });

  describe("shared tools agree on the annotation hints both declare", () => {
    // Only hints declared on BOTH sides are compared: the CLI's ToolAnnotations
    // leaves destructiveHint optional, and an absent hint is "unspecified", not
    // "false".
    const HINTS = ["readOnlyHint", "destructiveHint"] as const;

    it.each(SHARED_TOOLS)("%s", (name) => {
      const cli = cliByName.get(name)!.annotations as Record<string, boolean | undefined>;
      const remote = (remoteByName.get(name)!.annotations ?? {}) as Record<string, boolean | undefined>;
      const exceptions = ANNOTATION_EXCEPTIONS[name] ?? {};
      const mismatched: string[] = [];
      for (const hint of HINTS) {
        if (cli[hint] === undefined || remote[hint] === undefined) continue;
        if (cli[hint] === remote[hint]) continue;
        if (hint in exceptions) continue;
        mismatched.push(
          `${name}.${hint}: CLI says ${cli[hint]}, remote server says ${remote[hint]}. Align the annotation in src/mcp/tools.ts, or record the divergence under ANNOTATION_EXCEPTIONS["${name}"] in this spec.`,
        );
      }
      expect(mismatched).toEqual([]);
    });

    it("keeps ANNOTATION_EXCEPTIONS free of stale entries", () => {
      const stale: string[] = [];
      for (const [name, hints] of Object.entries(ANNOTATION_EXCEPTIONS)) {
        if (!cliByName.has(name) || !remoteByName.has(name)) {
          stale.push(`ANNOTATION_EXCEPTIONS.${name}: no longer a shared tool — remove the entry.`);
          continue;
        }
        const cli = cliByName.get(name)!.annotations as Record<string, boolean | undefined>;
        const remote = (remoteByName.get(name)!.annotations ?? {}) as Record<string, boolean | undefined>;
        for (const hint of Object.keys(hints)) {
          if (cli[hint] === undefined || remote[hint] === undefined) {
            stale.push(`ANNOTATION_EXCEPTIONS.${name}.${hint}: one side no longer declares the hint — remove the entry.`);
          } else if (cli[hint] === remote[hint]) {
            stale.push(`ANNOTATION_EXCEPTIONS.${name}.${hint}: the two sides agree now — remove the entry.`);
          }
        }
      }
      expect(stale).toEqual([]);
    });
  });

  describe("book: the price gate is expressible in cents on both servers", () => {
    // The remote server gates in integer cents (expect_total_cents); the CLI
    // gate is a dollar flag. The CLI tool accepts BOTH forms and converts, so a
    // host can hand the same acceptance value to either server. This locks that
    // in: dropping expect_total_cents from the CLI tool fails here.
    it("both sides accept expect_total_cents", () => {
      expect(cliParams("book")).toContain("expect_total_cents");
      expect(remoteProps("book")).toContain("expect_total_cents");
    });

    it("the CLI still accepts the dollar form as well", () => {
      expect(cliParams("book")).toContain("expect_total");
    });

    it("both sides mark book as the destructive, non-read-only tool", () => {
      const cli = cliByName.get("book")!.annotations;
      expect(cli.readOnlyHint).toBe(false);
      expect(cli.destructiveHint).toBe(true);
      expect(remoteByName.get("book")!.annotations?.readOnlyHint).toBe(false);
      expect(remoteByName.get("book")!.annotations?.destructiveHint).toBe(true);
    });
  });
});
