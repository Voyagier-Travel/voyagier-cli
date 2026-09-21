#!/usr/bin/env node
/**
 * Refresh the remote MCP tool-registry fixture.
 *
 * Writes a `tools/list` result array to src/mcp/fixtures/remote-tools.json
 * from one of two sources:
 *
 *   --from <file>   a tools/list export on disk: either a bare tools array or
 *                   a `{ "tools": [...] }` envelope. No token, no network. The
 *                   server repository exports this file from its registry
 *                   source (`npm run mcp:export -- --format tools`), so the
 *                   fixture can follow a registry change before it is deployed.
 *   (default)       `tools/list` on the hosted Voyagier MCP server, read with
 *                   the token in VOYAGIER_TOKEN.
 *
 * Both paths go through the same validation and write step, so the fixture
 * has one shape regardless of where the list came from.
 *
 * The fixture is a documentation aid, not a contract: the CLI builds its
 * command surface from the live `tools/list` at runtime and the stdio proxy
 * forwards the remote list untouched, so nothing in the shipped code reads
 * this file. The specs that exercise the generated command surface offline
 * (build-program, schema-flags, doc-drift, removed-commands, the proxy's
 * byte-for-byte contract) use it as a realistic snapshot. Refresh it when the
 * server publishes new tools so those specs and the docs see them.
 *
 * Usage:
 *   npm run refresh:mcp-fixture -- --from <path/to/tools.json>
 *   VOYAGIER_TOKEN=<token> npm run refresh:mcp-fixture
 *
 * Run locally only. In live mode the token is read from the environment,
 * never written to the fixture, echoed, or included in any error message; it
 * must not be added to CI. Prefer `--from` with the server's export: it needs
 * no credentials and reflects the registry source rather than a deployment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ENDPOINT = "https://mcp.voyagier.com/api/mcp";
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mcp",
  "fixtures",
  "remote-tools.json",
);

/** Print a message and exit non-zero. Never include the token. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Read the JSON-RPC payload out of the response body, which is either a bare
 * JSON object or an SSE stream whose `data:` lines carry the JSON.
 */
function parsePayload(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  if (dataLines.length === 0) throw new Error("no JSON object and no SSE data lines in the response");
  return JSON.parse(dataLines[dataLines.length - 1]);
}

/**
 * Accept the shapes a tools/list can arrive in and return the tools array:
 * a bare array, a `{ tools: [...] }` envelope, or a full JSON-RPC response
 * with `result.tools`.
 */
function extractTools(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.tools)) return payload.tools;
    if (payload.result && Array.isArray(payload.result.tools)) return payload.result.tools;
  }
  return undefined;
}

/** Validate the array and write it as the fixture. Shared by both modes. */
function writeFixture(tools, source) {
  if (!Array.isArray(tools) || tools.length === 0) {
    fail(`${source} returned no tools — expected a non-empty tools array.`);
  }
  const bad = tools.filter((t) => !t || typeof t !== "object" || typeof t.name !== "string" || !t.inputSchema);
  if (bad.length) {
    fail(`${source}: ${bad.length} entr${bad.length === 1 ? "y is" : "ies are"} not a tool descriptor (need name + inputSchema).`);
  }
  const names = tools.map((t) => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) fail(`${source}: duplicate tool names: ${[...new Set(dupes)].join(", ")}`);

  writeFileSync(FIXTURE, `${JSON.stringify(tools, null, 2)}\n`, "utf-8");
  console.log(`Wrote ${tools.length} tools to ${path.relative(process.cwd(), FIXTURE)} (source: ${source})`);
  console.log("Next: review the diff, then run `npm test` — the docs and generated-surface specs read this snapshot.");
}

// ── --from <file>: offline, token-free

const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
if (fromIndex !== -1) {
  const file = args[fromIndex + 1];
  if (!file || file.startsWith("-")) {
    fail("--from needs a path:  npm run refresh:mcp-fixture -- --from <path/to/tools.json>");
  }
  const resolved = path.resolve(file);
  let payload;
  try {
    payload = JSON.parse(readFileSync(resolved, "utf-8"));
  } catch (error) {
    fail(`Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tools = extractTools(payload);
  if (!tools) fail(`${resolved} is neither a tools array nor a { "tools": [...] } envelope.`);
  writeFixture(tools, resolved);
  process.exit(0);
}

// ── default: live tools/list

const token = process.env.VOYAGIER_TOKEN;
if (!token || token.trim().length === 0) {
  fail(
    "VOYAGIER_TOKEN is not set.\n" +
      "This script reads the token from the environment only — it is never stored or logged.\n" +
      "Run it as:  VOYAGIER_TOKEN=<token> npm run refresh:mcp-fixture\n" +
      "Or, without a token, from a tools/list export:  npm run refresh:mcp-fixture -- --from <file>",
  );
}

let response;
try {
  response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      // Server-sent events: the MCP HTTP transport may answer either way.
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
} catch (error) {
  fail(`Could not reach ${ENDPOINT}: ${error instanceof Error ? error.message : String(error)}`);
}

if (!response.ok) {
  fail(`${ENDPOINT} returned HTTP ${response.status} ${response.statusText}.`);
}

const raw = await response.text();

let payload;
try {
  payload = parsePayload(raw);
} catch (error) {
  fail(`Could not parse the response from ${ENDPOINT}: ${error instanceof Error ? error.message : String(error)}`);
}

if (payload.error) {
  fail(`${ENDPOINT} returned a JSON-RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
}

writeFixture(extractTools(payload), ENDPOINT);
