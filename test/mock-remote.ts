/**
 * A scripted "hosted Voyagier MCP server" for specs: an McpClient whose fetch
 * answers initialize / notifications/initialized / tools/list / tools/call
 * from in-memory data. No network, no token — the PAT is a placeholder string
 * and never leaves the process.
 */
import { jest } from "@jest/globals";
import { McpClient, MCP_PROTOCOL_VERSION, type McpToolDescriptor } from "../src/mcp-client/client.js";

export interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface MockRemoteOptions {
  tools?: McpToolDescriptor[];
  instructions?: string;
  capabilities?: Record<string, unknown>;
  /** Result for tools/call (may include isError / structuredContent). */
  onCall?: (name: string, args: Record<string, unknown>) => unknown;
  /** Override any request with a raw Response (auth/rate-limit scenarios). */
  intercept?: (sent: Sent, index: number) => Response | undefined;
  /** Page size for tools/list; omitted → one page. */
  pageSize?: number;
}

export const MOCK_REMOTE_URL = "https://mcp.example.test/api/mcp";

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function makeMockRemote(opts: MockRemoteOptions = {}): { client: McpClient; sent: Sent[] } {
  const tools = opts.tools ?? [];
  const sent: Sent[] = [];
  const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const record = { url: String(input), headers, body };
    sent.push(record);
    const intercepted = opts.intercept?.(record, sent.length - 1);
    if (intercepted) return intercepted;

    const method = body.method as string;
    const id = body.id;
    if (method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: "voyagier", version: "1.0.0" },
          capabilities: opts.capabilities ?? { tools: { listChanged: true } },
          ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
        },
      });
    }
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "tools/list") {
      const params = (body.params ?? {}) as { cursor?: string };
      if (!opts.pageSize) return jsonResponse({ jsonrpc: "2.0", id, result: { tools } });
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = tools.slice(start, start + opts.pageSize);
      const next = start + opts.pageSize < tools.length ? String(start + opts.pageSize) : undefined;
      return jsonResponse({ jsonrpc: "2.0", id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } });
    }
    if (method === "tools/call") {
      const params = (body.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
      const result = opts.onCall
        ? opts.onCall(params.name, params.arguments ?? {})
        : { content: [{ type: "text", text: JSON.stringify({ echo: params }) }] };
      return jsonResponse({ jsonrpc: "2.0", id, result });
    }
    return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }) as unknown as typeof fetch;

  const client = new McpClient({
    url: MOCK_REMOTE_URL,
    token: "pat_placeholder",
    fetchImpl,
    clientInfo: { name: "spec", version: "0.0.0" },
    timeoutMs: 5000,
  });
  return { client, sent };
}
