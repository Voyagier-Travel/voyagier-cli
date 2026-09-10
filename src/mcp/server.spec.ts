/**
 * server.ts — the stdio proxy, tested end-to-end in memory.
 *
 * A real SDK Client talks to the proxy over InMemoryTransport; the proxy talks
 * to a scripted "hosted server" (test/mock-remote.ts) through the real
 * McpClient with a mocked fetch. No network, no token, no child processes.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CliError, CliErrorCode } from "../errors.js";
import type { McpToolDescriptor } from "../mcp-client/client.js";
import { makeMockRemote, jsonResponse, MOCK_REMOTE_URL, type MockRemoteOptions } from "../../test/mock-remote.js";
import { cliErrorToMcpError, createProxyServer, PROXY_ERROR_CODES, SET_TOKEN_HINT, unavailableInstructions } from "./server.js";

const FIXTURE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("./fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as McpToolDescriptor[];

const INSTRUCTIONS = "Voyagier trip-planning MCP. Routing rules:\n1. Search never touches a plan.";

async function connect(remoteOpts: MockRemoteOptions = {}, extra: { instructions?: boolean } = {}) {
  const { client: upstream, sent } = makeMockRemote({
    tools: FIXTURE_TOOLS,
    instructions: extra.instructions === false ? undefined : INSTRUCTIONS,
    ...remoteOpts,
  });
  const logs: string[] = [];
  const proxy = await createProxyServer({ client: upstream, version: "9.9.9", log: (l) => logs.push(l) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "0" });
  await Promise.all([proxy.server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, proxy, sent, logs };
}

describe("voyagier mcp — stdio proxy", () => {
  it("initialize: local serverInfo, the remote's instructions and tools capability passed through", async () => {
    const { client, proxy, sent } = await connect();
    expect(client.getServerVersion()).toEqual({ name: "voyagier", version: "9.9.9" });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    expect(proxy.remote?.serverInfo).toEqual({ name: "voyagier", version: "1.0.0" });
    expect(proxy.startupError).toBeNull();
    // Exactly one remote handshake happened at startup: initialize + initialized.
    expect(sent.map((s) => s.body.method)).toEqual(["initialize", "notifications/initialized"]);
  });

  it("initialize: no instructions locally when the remote sends none", async () => {
    const { client } = await connect({}, { instructions: false });
    expect(client.getInstructions()).toBeUndefined();
  });

  it("tools/list is the remote's list, byte for byte — no local tools added or removed", async () => {
    const { client, sent } = await connect();
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools)).toBe(JSON.stringify(FIXTURE_TOOLS));
    expect(tools.map((t) => t.name)).not.toContain("doctor");
    expect(tools.map((t) => t.name)).not.toContain("agent_docs");
    const listCalls = sent.filter((s) => s.body.method === "tools/list");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].headers.authorization).toBe("Bearer pat_placeholder");
    expect(listCalls[0].url).toBe(MOCK_REMOTE_URL);
  });

  it("tools/list forwards the cursor and returns the remote page with its nextCursor", async () => {
    const { client, sent } = await connect({ pageSize: 4 });
    const first = await client.listTools();
    expect(first.tools).toEqual(FIXTURE_TOOLS.slice(0, 4));
    expect(first.nextCursor).toBe("4");
    const second = await client.listTools({ cursor: first.nextCursor });
    expect(second.tools).toEqual(FIXTURE_TOOLS.slice(4, 8));
    const cursors = sent.filter((s) => s.body.method === "tools/list").map((s) => (s.body.params as { cursor?: string }).cursor);
    expect(cursors).toEqual([undefined, "4"]);
  });

  it("tools/call forwards name + arguments and returns content, structuredContent and _meta untouched", async () => {
    const remoteResult = {
      content: [{ type: "text", text: JSON.stringify({ myTripPlans: { items: [], count: 0 } }) }],
      structuredContent: { myTripPlans: { items: [], count: 0 } },
      _meta: { requestId: "r-1" },
    };
    const { client, sent } = await connect({ onCall: () => remoteResult });
    const result = await client.callTool({ name: "plans_list", arguments: { limit: 1 } });
    expect(result).toEqual(remoteResult);
    const call = sent.find((s) => s.body.method === "tools/call");
    expect(call?.body.params).toEqual({ name: "plans_list", arguments: { limit: 1 } });
  });

  it("tools/call passes an isError result through as a result, not as a protocol error", async () => {
    const remoteResult = { content: [{ type: "text", text: '{"code":"PRICE_CHANGED","message":"total moved"}' }], isError: true };
    const { client } = await connect({ onCall: () => remoteResult });
    const result = await client.callTool({ name: "book", arguments: { plan_id: "p" } });
    expect(result).toEqual(remoteResult);
  });

  it("remote 401 on a request → JSON-RPC error 401 telling the user to set the token", async () => {
    const { client } = await connect({
      intercept: (sent) => (sent.body.method === "tools/list" ? jsonResponse({ message: "Unauthorized" }, { status: 401 }) : undefined),
    });
    const err = await client.listTools().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.AUTH_FAILED);
    expect((err as McpError).message).toContain("VOYAGIER_TOKEN");
    expect((err as McpError).data).toMatchObject({ code: "AUTH_FAILED" });
  });

  it("remote 429 → JSON-RPC error 429 carrying Retry-After", async () => {
    const { client } = await connect({
      intercept: (sent) =>
        sent.body.method === "tools/call" ? jsonResponse({ message: "slow down" }, { status: 429, headers: { "retry-after": "7" } }) : undefined,
    });
    const err = await client.callTool({ name: "plans_list", arguments: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.RATE_LIMITED);
    expect((err as McpError).message).toContain("Retry after 7s");
    expect((err as McpError).data).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 7 });
  });

  it("remote JSON-RPC error (unknown tool) → JSON-RPC method-not-found locally", async () => {
    const { client } = await connect({
      intercept: (sent) =>
        sent.body.method === "tools/call"
          ? jsonResponse({ jsonrpc: "2.0", id: sent.body.id, error: { code: -32601, message: "Unknown tool: frobnicate" } })
          : undefined,
    });
    const err = await client.callTool({ name: "frobnicate", arguments: {} }).catch((e: unknown) => e);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.METHOD_NOT_FOUND);
    expect((err as McpError).message).toContain("Unknown tool: frobnicate");
  });

  it("startup 401: the local handshake still succeeds, instructions explain, requests fail with the fix and retry the remote", async () => {
    let unauthorized = true;
    const { client, proxy, sent, logs } = await connect({
      intercept: (sent) => (unauthorized && sent.body.method === "initialize" ? jsonResponse({ message: "Unauthorized" }, { status: 401 }) : undefined),
    });
    expect(proxy.startupError?.code).toBe(CliErrorCode.AUTH_FAILED);
    expect(client.getInstructions()).toContain("could not complete the handshake");
    expect(client.getInstructions()).toContain("VOYAGIER_TOKEN");
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(logs.some((l) => l.includes("AUTH_FAILED"))).toBe(true);

    const err = await client.listTools().catch((e: unknown) => e);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.AUTH_FAILED);

    // The environment is fixed (token now valid): the next request succeeds without a restart.
    unauthorized = false;
    const { tools } = await client.listTools();
    expect(tools).toEqual(FIXTURE_TOOLS);
    expect(sent.filter((s) => s.body.method === "initialize").length).toBeGreaterThanOrEqual(2);
  });

  it("startup network failure: instructions explain and tools/list is a connection error", async () => {
    const { client, proxy } = await connect({
      intercept: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(proxy.startupError?.code).toBe(CliErrorCode.NETWORK);
    expect(client.getInstructions()).toContain("could not complete the handshake");
    const err = await client.listTools().catch((e: unknown) => e);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.NETWORK);
  });

  it("no client at all (token resolution failed) → every request is the auth error", async () => {
    const proxy = await createProxyServer({
      version: "9.9.9",
      client: undefined,
    }).catch((e: unknown) => e);
    // createDefaultClient needs a token; the sandbox has none, so startup records AUTH_FAILED.
    expect(proxy).not.toBeInstanceOf(Error);
    const built = proxy as Awaited<ReturnType<typeof createProxyServer>>;
    expect(built.startupError?.code).toBe(CliErrorCode.AUTH_FAILED);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host", version: "0" });
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getInstructions()).toContain(SET_TOKEN_HINT);
    const err = await client.listTools().catch((e: unknown) => e);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.AUTH_FAILED);
  });

  it("tools/list with a malformed remote result is an internal error, not a crash", async () => {
    const { client } = await connect({
      intercept: (sent) => (sent.body.method === "tools/list" ? jsonResponse({ jsonrpc: "2.0", id: sent.body.id, result: { nope: true } }) : undefined),
    });
    const err = await client.listTools().catch((e: unknown) => e);
    expect((err as McpError).code).toBe(PROXY_ERROR_CODES.INTERNAL);
    expect((err as McpError).message).toContain("no tool list");
  });
});

describe("cliErrorToMcpError", () => {
  it("maps every CLI code the client can raise", () => {
    expect(cliErrorToMcpError(new CliError(CliErrorCode.AUTH_FAILED, "x")).code).toBe(401);
    expect(cliErrorToMcpError(new CliError(CliErrorCode.PERMISSION_DENIED, "x")).code).toBe(403);
    expect(cliErrorToMcpError(new CliError(CliErrorCode.RATE_LIMITED, "x")).code).toBe(429);
    expect(cliErrorToMcpError(new CliError(CliErrorCode.RATE_LIMITED, "x")).message).not.toContain("Retry after");
    expect(cliErrorToMcpError(new CliError(CliErrorCode.NETWORK, "x")).code).toBe(-32000);
    expect(cliErrorToMcpError(new CliError(CliErrorCode.VALIDATION, "x")).code).toBe(-32602);
    expect(cliErrorToMcpError(new CliError(CliErrorCode.NOT_FOUND, "x")).code).toBe(-32601);
    expect(cliErrorToMcpError(new CliError(CliErrorCode.API_ERROR, "x")).code).toBe(-32603);
  });

  it("passes McpError through and wraps plain errors", () => {
    const original = new McpError(-32099, "keep me");
    expect(cliErrorToMcpError(original)).toBe(original);
    expect(cliErrorToMcpError(new Error("boom")).message).toContain("boom");
    expect(cliErrorToMcpError("string").message).toContain("string");
  });

  it("unavailableInstructions names the endpoint and the fix", () => {
    const text = unavailableInstructions("https://mcp.example.test/api/mcp", new CliError(CliErrorCode.NETWORK, "timed out"));
    expect(text).toContain("https://mcp.example.test/api/mcp");
    expect(text).toContain("timed out");
    expect(text).toContain("retry");
  });
});
