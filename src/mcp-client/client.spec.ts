import { describe, it, expect, jest } from "@jest/globals";
import { CliError, CliErrorCode } from "../errors.js";
import {
  McpClient,
  MCP_PROTOCOL_VERSION,
  parseRetryAfter,
  parseSseMessages,
  parseJsonMessages,
  rpcErrorToCliError,
  toolErrorToCliError,
} from "./client.js";

/**
 * Transport contract for the MCP client, against a scripted fetch.
 *
 * Each test builds a queue of responses (or a function) and asserts both the
 * requests the client sent (method, headers, session handling) and how the
 * outcome is mapped onto CliError codes.
 */

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Scripted = (sent: Sent, index: number) => Response | Promise<Response>;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function sseResponse(messages: unknown[], init: { headers?: Record<string, string> } = {}): Response {
  const body = messages.map((m, i) => `event: message\nid: ${i}\ndata: ${JSON.stringify(m)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...(init.headers ?? {}) } });
}

function initResult(id: unknown) {
  return { jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "voyagier", version: "1.0.0" }, capabilities: {} } };
}

function makeClient(script: Scripted, opts: { log?: (l: string) => void } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const record = { url: String(input), headers, body };
    sent.push(record);
    return script(record, sent.length - 1);
  }) as unknown as typeof fetch;
  const client = new McpClient({
    url: "https://mcp.example.test/api/mcp",
    token: "pat_test",
    fetchImpl,
    clientInfo: { name: "spec", version: "0.0.0" },
    timeoutMs: 5000,
    log: opts.log,
  });
  return { client, sent };
}

/** Standard happy-path server: initialize → 200 JSON, notification → 202, then per-method results. */
function happyServer(handlers: Record<string, (body: Record<string, unknown>) => unknown>, headers: Record<string, string> = {}): Scripted {
  return (sent) => {
    const method = sent.body.method as string;
    if (method === "initialize") return jsonResponse(initResult(sent.body.id), { headers });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    const handler = handlers[method];
    if (!handler) return jsonResponse({ jsonrpc: "2.0", id: sent.body.id, error: { code: -32601, message: `Method not found: ${method}` } });
    return jsonResponse({ jsonrpc: "2.0", id: sent.body.id, result: handler(sent.body) });
  };
}

const TOOLS = [{ name: "plans_list", title: "List trip plans", inputSchema: { type: "object", properties: {} } }];

describe("McpClient handshake", () => {
  it("initializes once, sends notifications/initialized, then lists tools with the protocol-version header", async () => {
    const { client, sent } = makeClient(happyServer({ "tools/list": () => ({ tools: TOOLS }) }));
    const tools = await client.toolsList();
    expect(tools.map((t) => t.name)).toEqual(["plans_list"]);
    expect(sent.map((s) => s.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    // Bearer + accept both content types on every request.
    for (const s of sent) {
      expect(s.headers.authorization).toBe("Bearer pat_test");
      expect(s.headers.accept).toBe("application/json, text/event-stream");
      expect(s.headers["content-type"]).toBe("application/json");
    }
    expect((sent[0].body.params as Record<string, unknown>).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(sent[2].headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
    // Stateless server: no session header sent when none was issued.
    expect(sent[2].headers["mcp-session-id"]).toBeUndefined();
    expect(client.session).toBeNull();
    expect(client.server?.serverInfo?.name).toBe("voyagier");
  });

  it("toolsList drops a descriptor whose name fails the allowlist instead of rewriting it, and sanitizes only display metadata", async () => {
    const { client } = makeClient(
      happyServer({
        "tools/list": () => ({
          tools: [
            { name: "bad\u001bname", description: "pwned" },
            { name: "badname", title: "Real\u001b[31m", description: "real", inputSchema: { type: "object", properties: { plan_id: { type: "string", description: "x\u001by" } } } },
          ],
        }),
      }),
    );
    const tools = await client.toolsList();
    expect(tools.map((t) => t.name)).toEqual(["badname"]);
    expect(tools[0].title).not.toMatch(/\u001b/);
    expect((tools[0].inputSchema as { properties: Record<string, { description?: string }> }).properties.plan_id.description).not.toMatch(/\u001b/);
  });

  it("does not re-initialize on subsequent calls", async () => {
    const { client, sent } = makeClient(happyServer({ "tools/list": () => ({ tools: TOOLS }), "tools/call": () => ({ content: [{ type: "text", text: "{}" }] }) }));
    await client.toolsList();
    await client.toolsCall("plans_list", {});
    expect(sent.filter((s) => s.body.method === "initialize")).toHaveLength(1);
  });

  it("echoes Mcp-Session-Id when the server issues one", async () => {
    const { client, sent } = makeClient(happyServer({ "tools/list": () => ({ tools: TOOLS }) }, { "mcp-session-id": "sess-123" }));
    await client.toolsList();
    expect(client.session).toBe("sess-123");
    // Not on initialize itself; on everything after.
    expect(sent[0].headers["mcp-session-id"]).toBeUndefined();
    expect(sent[1].headers["mcp-session-id"]).toBe("sess-123");
    expect(sent[2].headers["mcp-session-id"]).toBe("sess-123");
  });

  it("follows nextCursor pages on tools/list", async () => {
    const { client } = makeClient(
      happyServer({
        "tools/list": (body) => {
          const params = (body.params ?? {}) as { cursor?: string };
          return params.cursor ? { tools: [{ name: "b" }] } : { tools: [{ name: "a" }], nextCursor: "page2" };
        },
      }),
    );
    const tools = await client.toolsList();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });
});

describe("McpClient response parsing", () => {
  it("parses an SSE body (data: lines) and picks the message with the matching id", async () => {
    const { client } = makeClient((sent) => {
      const method = sent.body.method as string;
      if (method === "initialize") return sseResponse([initResult(sent.body.id)]);
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      return sseResponse([
        { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        { jsonrpc: "2.0", id: sent.body.id, result: { tools: TOOLS } },
      ]);
    });
    const tools = await client.toolsList();
    expect(tools).toHaveLength(1);
  });

  it("parseSseMessages joins multi-line data and ignores comments and non-JSON", () => {
    const raw = [": keep-alive", "data: {\"a\":", "data: 1}", "", "data: not json", "", "event: x", "data: {\"b\":2}", ""].join("\n");
    expect(parseSseMessages(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("parseJsonMessages accepts a single object or a batch", () => {
    expect(parseJsonMessages('{"id":1}')).toEqual([{ id: 1 }]);
    expect(parseJsonMessages('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parseJsonMessages("")).toEqual([]);
    expect(() => parseJsonMessages("nope")).toThrow(CliError);
  });

  it("maps a JSON-RPC error to a CliError", async () => {
    const { client } = makeClient(happyServer({}));
    await expect(client.toolsCall("nope", {})).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("throws API_ERROR carrying the tool's text when the result isError", async () => {
    const { client } = makeClient(happyServer({ "tools/call": () => ({ isError: true, content: [{ type: "text", text: "Plan not found: p1" }] }) }));
    await expect(client.toolsCall("plan_status", { plan_id: "p1" })).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
      message: "Plan not found: p1",
      details: { tool: "plan_status" },
    });
  });

  it("returns content and structuredContent on success", async () => {
    const { client, sent } = makeClient(
      happyServer({ "tools/call": () => ({ content: [{ type: "text", text: '{"ok":true}' }], structuredContent: { ok: true } }) }),
    );
    const result = await client.toolsCall("plans_list", { limit: 2 });
    expect(result.content[0].text).toBe('{"ok":true}');
    expect(result.structuredContent).toEqual({ ok: true });
    const call = sent.find((s) => s.body.method === "tools/call")!;
    expect(call.body.params).toEqual({ name: "plans_list", arguments: { limit: 2 } });
  });
});

describe("McpClient HTTP status mapping", () => {
  it("401 → AUTH_FAILED with the login hint", async () => {
    const { client } = makeClient(() => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"' } }));
    await expect(client.toolsList()).rejects.toMatchObject({ code: CliErrorCode.AUTH_FAILED });
    await expect(client.toolsList()).rejects.toThrow(/voyagier login/);
  });

  it("403 → PERMISSION_DENIED", async () => {
    const { client } = makeClient((sent) => {
      if (sent.body.method === "initialize") return jsonResponse(initResult(sent.body.id));
      if (sent.body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("", { status: 403 });
    });
    await expect(client.toolsList()).rejects.toMatchObject({ code: CliErrorCode.PERMISSION_DENIED });
  });

  it("429 → RATE_LIMITED with Retry-After seconds in details", async () => {
    const { client } = makeClient((sent) => {
      if (sent.body.method === "initialize") return jsonResponse(initResult(sent.body.id));
      if (sent.body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("", { status: 429, headers: { "retry-after": "7" } });
    });
    await expect(client.toolsList()).rejects.toMatchObject({ code: CliErrorCode.RATE_LIMITED, details: { retryAfterSeconds: 7 } });
  });

  it("404 with a live session → re-initializes once and retries the request", async () => {
    const log: string[] = [];
    let generation = 0;
    const { client, sent } = makeClient((sent) => {
      const method = sent.body.method as string;
      if (method === "initialize") {
        generation++;
        return jsonResponse(initResult(sent.body.id), { headers: { "mcp-session-id": `sess-${generation}` } });
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      // The first session is stale: 404 until the client re-initializes.
      if (sent.headers["mcp-session-id"] === "sess-1") return new Response("Session not found", { status: 404 });
      return jsonResponse({ jsonrpc: "2.0", id: sent.body.id, result: { tools: TOOLS } });
    }, { log: (l) => log.push(l) });
    const tools = await client.toolsList();
    expect(tools).toHaveLength(1);
    expect(client.session).toBe("sess-2");
    expect(sent.map((s) => s.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list", // 404
      "initialize",
      "notifications/initialized",
      "tools/list", // retry
    ]);
    expect(log.some((l) => /re-initializing/.test(l))).toBe(true);
  });

  it("404 without a session is a plain API_ERROR (no retry loop)", async () => {
    const { client, sent } = makeClient((sent) => {
      if (sent.body.method === "initialize") return jsonResponse(initResult(sent.body.id));
      if (sent.body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    });
    await expect(client.toolsList()).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
    expect(sent.filter((s) => s.body.method === "tools/list")).toHaveLength(1);
  });

  it("network failure → NETWORK naming the endpoint", async () => {
    const { client } = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client.toolsList()).rejects.toMatchObject({ code: CliErrorCode.NETWORK });
    await expect(client.toolsList()).rejects.toThrow(/mcp\.example\.test/);
  });

  it("5xx → API_ERROR with a sanitized body snippet", async () => {
    const { client } = makeClient(() => new Response("\u001b[31mboom\u001b[0m", { status: 502, statusText: "Bad Gateway" }));
    await expect(client.toolsList()).rejects.toMatchObject({ code: CliErrorCode.API_ERROR, message: expect.stringContaining("502") });
    await expect(client.toolsList()).rejects.toThrow(/boom/);
    await expect(client.toolsList()).rejects.not.toThrow(/\u001b/);
  });
});

describe("error mapping helpers", () => {
  it("parseRetryAfter handles delta-seconds, HTTP dates and garbage", () => {
    expect(parseRetryAfter("30")).toBe(30);
    const now = Date.parse("2026-09-10T12:00:00Z");
    expect(parseRetryAfter("Thu, 10 Sep 2026 12:00:45 GMT", now)).toBe(45);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("rpcErrorToCliError maps codes and auth phrasing", () => {
    expect(rpcErrorToCliError({ code: -32602, message: "invalid params" }).code).toBe(CliErrorCode.VALIDATION);
    expect(rpcErrorToCliError({ code: -32601, message: "unknown tool" }).code).toBe(CliErrorCode.NOT_FOUND);
    expect(rpcErrorToCliError({ code: -32000, message: "Unauthorized" }).code).toBe(CliErrorCode.AUTH_FAILED);
    expect(rpcErrorToCliError({ code: -32000, message: "Forbidden resource" }).code).toBe(CliErrorCode.PERMISSION_DENIED);
    expect(rpcErrorToCliError({ code: -32000, message: "boom" })).toMatchObject({ code: CliErrorCode.API_ERROR, details: { rpcCode: -32000 } });
  });

  it("toolErrorToCliError keeps a JSON envelope's code when it is a known CliErrorCode", () => {
    const err = toolErrorToCliError("book", JSON.stringify({ code: "PRICE_CHANGED", message: "Total moved", details: { actual: 1 } }));
    expect(err.code).toBe(CliErrorCode.PRICE_CHANGED);
    expect(err.message).toBe("Total moved");
    expect(err.details).toMatchObject({ tool: "book", serverDetails: { actual: 1 } });
  });

  it("toolErrorToCliError strips terminal escapes from plain text", () => {
    const err = toolErrorToCliError("x", "\u001b]0;evil\u0007bad thing");
    expect(err.message).toBe("bad thing");
    expect(err.code).toBe(CliErrorCode.API_ERROR);
  });
});
