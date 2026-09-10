/**
 * Registry contract: the stdio proxy publishes the hosted server's tool list.
 * ---------------------------------------------------------------------------
 * `voyagier mcp` (and the MCPB bundle built from it) has no tool table of its
 * own; it forwards `tools/list` to the hosted Voyagier MCP server. The whole
 * contract is therefore one assertion: what a local MCP host receives from the
 * proxy is exactly what the remote sent — same tools, same order, same
 * descriptors, nothing added (no `doctor`, no `agent_docs`) and nothing hidden.
 *
 * The remote is a scripted fetch that answers with the checked-in snapshot of
 * the hosted server's `tools/list` (fixtures/remote-tools.json). The snapshot
 * is a documentation aid for the specs that build the generated command
 * surface (build-program, schema-flags, doc-drift, removed-commands); it is not
 * an allowlist and the proxy never reads it. Refresh with
 * `npm run refresh:mcp-fixture` (needs a token in the environment; run locally,
 * never in CI).
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpToolDescriptor } from "../mcp-client/client.js";
import { makeMockRemote } from "../../test/mock-remote.js";
import { createProxyServer } from "./server.js";

const REMOTE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("./fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as McpToolDescriptor[];

describe("registry contract — proxied tools/list == remote tools/list", () => {
  it("returns the remote tool list byte for byte", async () => {
    expect(REMOTE_TOOLS.length).toBeGreaterThan(0);
    const { client: upstream } = makeMockRemote({ tools: REMOTE_TOOLS });
    const proxy = await createProxyServer({ client: upstream, version: "0.0.0-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const host = new Client({ name: "contract", version: "0" });
    await Promise.all([proxy.server.connect(serverTransport), host.connect(clientTransport)]);

    const { tools } = await host.listTools();

    expect(JSON.stringify(tools)).toBe(JSON.stringify(REMOTE_TOOLS));
  });
});
