import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { CliErrorCode } from "../errors.js";
import { McpClient } from "./client.js";
import { isHelpInvocation, isLocalInvocation, resolveStartupTools } from "./startup.js";
import { clearToolsCache, readToolsCache, writeToolsCache } from "./tools-cache.js";
import { getMcpUrl, DEFAULT_MCP_URL } from "./url.js";

/**
 * Startup tool resolution: fresh cache → no network; local commands → no
 * network; otherwise fetch, cache, and fall back to a stale cache on failure.
 * The jest bootstrap points CONFIG_DIR at a sandbox, so the cache file here is
 * throwaway.
 */

const URL = "https://mcp.example.test/api/mcp";
const TOOLS = [{ name: "plans_list", inputSchema: { type: "object", properties: {} } }];

function scriptedClient(behaviour: "ok" | "auth" | "network"): { client: McpClient; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number };
    calls.push(body.method);
    if (behaviour === "network") throw new TypeError("fetch failed");
    if (behaviour === "auth") return new Response("", { status: 401 });
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "voyagier", version: "9" } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: new McpClient({ url: URL, token: "t", fetchImpl }), calls };
}

describe("resolveStartupTools", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.VOYAGIER_MCP_URL = URL;
    process.env.VOYAGIER_TOKEN = "pat_test";
    clearToolsCache();
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    clearToolsCache();
    jest.restoreAllMocks();
  });

  it("uses a fresh cache without touching the network", async () => {
    writeToolsCache({ url: URL, fetchedAt: new Date().toISOString(), tools: TOOLS });
    const { client, calls } = scriptedClient("ok");
    const res = await resolveStartupTools(["plans_list"], { createClient: () => client });
    expect(res.source).toBe("cache");
    expect(res.tools).toEqual(TOOLS);
    expect(calls).toEqual([]);
  });

  it("fetches, caches and reports network when the cache is missing", async () => {
    const { client, calls } = scriptedClient("ok");
    const res = await resolveStartupTools(["plans_list", "--json"], { createClient: () => client });
    expect(res.source).toBe("network");
    expect(res.tools).toEqual(TOOLS);
    expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(readToolsCache()).toMatchObject({ url: URL, server: { name: "voyagier", version: "9" }, tools: TOOLS });
  });

  it("refetches when the cache is expired or for another endpoint", async () => {
    writeToolsCache({ url: URL, fetchedAt: new Date(Date.now() - 48 * 3600_000).toISOString(), tools: [{ name: "old" }] });
    const { client } = scriptedClient("ok");
    expect((await resolveStartupTools(["plans_list"], { createClient: () => client })).source).toBe("network");
    writeToolsCache({ url: "https://elsewhere.example.test/mcp", fetchedAt: new Date().toISOString(), tools: [{ name: "other" }] });
    const again = await resolveStartupTools(["plans_list"], { createClient: () => scriptedClient("ok").client });
    expect(again.source).toBe("network");
    expect(again.tools).toEqual(TOOLS);
  });

  it("skips the network for local commands, using a stale cache when present", async () => {
    const { client, calls } = scriptedClient("ok");
    for (const argv of [["auth", "status"], ["doctor"], ["mcp"], ["telemetry", "status"], ["--version"]]) {
      const res = await resolveStartupTools(argv, { createClient: () => client });
      expect(res.source).toBe("none");
      expect(res.tools).toEqual([]);
    }
    expect(calls).toEqual([]);
    writeToolsCache({ url: URL, fetchedAt: new Date(Date.now() - 48 * 3600_000).toISOString(), tools: [{ name: "old" }] });
    const stale = await resolveStartupTools(["doctor"], { createClient: () => client });
    expect(stale.source).toBe("stale-cache");
    expect(stale.tools).toEqual([{ name: "old" }]);
    expect(calls).toEqual([]);
  });

  it("makes one best-effort fetch for help when nothing is cached and credentials exist", async () => {
    const { client, calls } = scriptedClient("ok");
    const res = await resolveStartupTools([], { createClient: () => client });
    expect(res.source).toBe("network");
    expect(calls).toContain("tools/list");
    // Help without credentials: no fetch.
    delete process.env.VOYAGIER_TOKEN;
    clearToolsCache();
    const { client: c2, calls: calls2 } = scriptedClient("ok");
    expect((await resolveStartupTools(["--help"], { createClient: () => c2 })).source).toBe("none");
    expect(calls2).toEqual([]);
  });

  it("returns AUTH_FAILED as the error (not a throw) when there are no credentials", async () => {
    delete process.env.VOYAGIER_TOKEN;
    const { client, calls } = scriptedClient("ok");
    const res = await resolveStartupTools(["plans_list"], { createClient: () => client });
    expect(res.source).toBe("none");
    expect(res.error?.code).toBe(CliErrorCode.AUTH_FAILED);
    expect(calls).toEqual([]);
  });

  it("falls back to a stale cache and keeps the error when the fetch fails", async () => {
    writeToolsCache({ url: URL, fetchedAt: new Date(Date.now() - 48 * 3600_000).toISOString(), tools: [{ name: "old" }] });
    const net = await resolveStartupTools(["plans_list"], { createClient: () => scriptedClient("network").client });
    expect(net.source).toBe("stale-cache");
    expect(net.tools).toEqual([{ name: "old" }]);
    expect(net.error?.code).toBe(CliErrorCode.NETWORK);
    clearToolsCache();
    const auth = await resolveStartupTools(["plans_list"], { createClient: () => scriptedClient("auth").client });
    expect(auth.source).toBe("none");
    expect(auth.error?.code).toBe(CliErrorCode.AUTH_FAILED);
  });

  it("force refetches even with a fresh cache", async () => {
    writeToolsCache({ url: URL, fetchedAt: new Date().toISOString(), tools: [{ name: "old" }] });
    const { client, calls } = scriptedClient("ok");
    const res = await resolveStartupTools(["doctor"], { createClient: () => client, force: true });
    expect(res.source).toBe("network");
    expect(calls).toContain("tools/list");
  });
});

describe("invocation classification", () => {
  it("isLocalInvocation", () => {
    expect(isLocalInvocation([])).toBe(true);
    expect(isLocalInvocation(["--help"])).toBe(true);
    expect(isLocalInvocation(["auth", "login"])).toBe(true);
    expect(isLocalInvocation(["login"])).toBe(true);
    expect(isLocalInvocation(["plans_list"])).toBe(false);
    expect(isLocalInvocation(["plans", "list"])).toBe(false);
  });
  it("isHelpInvocation", () => {
    expect(isHelpInvocation([])).toBe(true);
    expect(isHelpInvocation(["-h"])).toBe(true);
    expect(isHelpInvocation(["help"])).toBe(true);
    expect(isHelpInvocation(["--version"])).toBe(false);
  });
});

describe("getMcpUrl", () => {
  it("defaults to the hosted endpoint and honours a secure override", () => {
    expect(getMcpUrl({})).toBe(DEFAULT_MCP_URL);
    expect(getMcpUrl({ VOYAGIER_MCP_URL: " https://staging.example.test/api/mcp " })).toBe("https://staging.example.test/api/mcp");
    expect(getMcpUrl({ VOYAGIER_MCP_URL: "http://localhost:3001/api/mcp" })).toBe("http://localhost:3001/api/mcp");
    expect(getMcpUrl({ VOYAGIER_MCP_URL: "" })).toBe(DEFAULT_MCP_URL);
  });
  it("rejects cleartext non-loopback and unparseable overrides", () => {
    expect(() => getMcpUrl({ VOYAGIER_MCP_URL: "http://mcp.example.test/api/mcp" })).toThrow(/Insecure/);
    expect(() => getMcpUrl({ VOYAGIER_MCP_URL: "not a url" })).toThrow(/Invalid/);
  });
});
