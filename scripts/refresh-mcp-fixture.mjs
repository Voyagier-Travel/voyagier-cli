#!/usr/bin/env node
/**
 * Refresh the remote MCP tool-registry fixture.
 *
 * Calls `tools/list` on the remote Voyagier MCP server and writes the
 * `result.tools` array to src/mcp/fixtures/remote-tools.json, which
 * src/mcp/registry-contract.spec.ts compares the CLI's own tool table against.
 * Run it when the remote server's tools change, then read the diff: a new
 * difference makes the contract spec fail until it is either resolved in
 * src/mcp/tools.ts or recorded as a deliberate exception in that spec.
 *
 * Usage:  VOYAGIER_TOKEN=<token> npm run refresh:mcp-fixture
 *
 * The token is read from the environment only. It is never written to the
 * fixture, echoed, or included in any error message.
 */
import { writeFileSync } from "node:fs";
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

const token = process.env.VOYAGIER_TOKEN;
if (!token || token.trim().length === 0) {
  fail(
    "VOYAGIER_TOKEN is not set.\n" +
      "This script reads the token from the environment only — it is never stored or logged.\n" +
      "Run it as:  VOYAGIER_TOKEN=<token> npm run refresh:mcp-fixture",
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

let payload;
try {
  payload = parsePayload(raw);
} catch (error) {
  fail(`Could not parse the response from ${ENDPOINT}: ${error instanceof Error ? error.message : String(error)}`);
}

if (payload.error) {
  fail(`${ENDPOINT} returned a JSON-RPC error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
}

const tools = payload.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) {
  fail(`${ENDPOINT} returned no tools — expected a non-empty result.tools array.`);
}

writeFileSync(FIXTURE, `${JSON.stringify(tools, null, 2)}\n`, "utf-8");
console.log(`Wrote ${tools.length} tools to ${path.relative(process.cwd(), FIXTURE)}`);
console.log("Next: review the diff, then run `npm test` — src/mcp/registry-contract.spec.ts checks it against the CLI tool table.");
