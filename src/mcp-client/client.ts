/**
 * Minimal MCP client over Streamable HTTP (spec revision 2025-06-18).
 *
 * The whole CLI talks to the Voyagier MCP server through this one class:
 * `initialize` → `tools/list` → `tools/call`. It is fetch-based on purpose —
 * a few hundred lines that are easy to test with a mocked `fetch` — and it
 * maps every transport outcome onto the CLI's existing error codes so
 * generated commands inherit the same envelope as the rest of the CLI.
 *
 * Transport behaviour:
 *  - Bearer PAT on every request; `Accept: application/json, text/event-stream`.
 *  - A response may be plain JSON or an SSE stream (`data:` lines); both are
 *    parsed to the JSON-RPC message with the matching id.
 *  - `Mcp-Session-Id` is stored when the server issues one and echoed back.
 *    A 404 on a session-bearing request means the session expired: the
 *    client re-initializes once and retries.
 *  - 429 surfaces as RATE_LIMITED with the server's Retry-After.
 *  - A `tools/call` result with `isError: true` is thrown as API_ERROR with the
 *    tool's own error text, so callers only ever see successful results.
 */
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";
import { sanitizeExternalData, sanitizeExternalText } from "../utils.js";
import { TOOL_NAME_PATTERN } from "./schema-flags.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** JSON Schema subset the server publishes for tool inputs. */
export interface McpJsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: McpJsonSchema;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

/** One entry of a `tools/list` result. */
/**
 * Identity-preserving sanitizer for a remote tool descriptor. Returns null when
 * the name fails TOOL_NAME_PATTERN (the descriptor must be skipped, never
 * renamed); otherwise sanitizes only display metadata and schema VALUES —
 * property names are allowlisted separately by schema-flags.ts.
 */
export function sanitizeToolDescriptor(raw: McpToolDescriptor): McpToolDescriptor | null {
  if (typeof raw?.name !== "string" || !TOOL_NAME_PATTERN.test(raw.name)) return null;
  const { name, ...display } = raw;
  return { ...sanitizeExternalData(display), name };
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** A successful `tools/call` result (isError results are thrown). */
export interface McpToolResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpClientOptions {
  url: string;
  token: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  clientInfo?: { name: string; version: string };
  /** Per-request timeout. Defaults to 90s (tool calls can run a supplier search). */
  timeoutMs?: number;
  /** Trace id for the `x-request-id` header; regenerated per request when omitted. */
  requestId?: () => string;
  /** Diagnostic sink (verbose mode); never stdout. */
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export class McpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientInfo: { name: string; version: string };
  private readonly timeoutMs: number;
  private readonly requestId?: () => string;
  private readonly log: (line: string) => void;

  private sessionId: string | null = null;
  private initialized = false;
  private initializing: Promise<McpInitializeResult> | null = null;
  private serverInfo: McpInitializeResult | null = null;
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clientInfo = opts.clientInfo ?? { name: "voyagier-cli", version: "0.0.0" };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestId = opts.requestId;
    this.log = opts.log ?? (() => {});
  }

  /** The session id the server issued, if any (stateless servers issue none). */
  get session(): string | null {
    return this.sessionId;
  }

  /** Server identity from the last successful initialize. */
  get server(): McpInitializeResult | null {
    return this.serverInfo;
  }

  /**
   * Perform the initialize handshake (idempotent; concurrent callers share one
   * in-flight handshake). Sends `notifications/initialized` afterwards; a
   * non-2xx on the notification is logged, not fatal — the server is
   * stateless when it issues no session id and the notification is advisory.
   */
  async initialize(): Promise<McpInitializeResult> {
    if (this.initialized && this.serverInfo) return this.serverInfo;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.sessionId = null;
      const { response, headers } = await this.post(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: this.clientInfo,
          },
        },
        { includeSession: false, includeProtocolVersion: false },
      );
      const sid = headers.get("mcp-session-id");
      this.sessionId = sid && sid.trim() ? sid.trim() : null;
      // Server metadata is untrusted display text (it reaches doctor output
      // and --verbose lines): strip escapes at the boundary.
      const result = sanitizeExternalData((response.result ?? {}) as McpInitializeResult);
      this.serverInfo = result;
      this.initialized = true;
      this.log(
        `mcp: initialized ${this.url} (server ${result.serverInfo?.name ?? "?"} ${result.serverInfo?.version ?? ""}, session ${this.sessionId ? "issued" : "none"})`,
      );
      try {
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { expectNoBody: true });
      } catch (err) {
        // Auth/permission failures must not be swallowed — they are the answer.
        if (err instanceof CliError && err.code !== CliErrorCode.API_ERROR) throw err;
        this.log(`mcp: notifications/initialized not accepted (${err instanceof Error ? err.message : String(err)})`);
      }
      return result;
    })();
    try {
      return await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  /** `tools/list` — follows `nextCursor` pages when the server paginates. */
  async toolsList(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.rpc("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpToolDescriptor[];
        nextCursor?: string;
      };
      if (!result || !Array.isArray(result.tools)) {
        throw new CliError(CliErrorCode.API_ERROR, "MCP server returned no tool list.");
      }
      tools.push(...result.tools);
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    // Titles, descriptions, property descriptions and enum values become
    // Commander help, spinner labels and error messages, so they are
    // sanitized here. The NAME is identity: it is the RPC method that will be
    // called, so it is never rewritten — a name that fails the allowlist is
    // dropped as a whole descriptor instead. Rewriting it could turn a hostile
    // descriptor into a valid tool's name and then call the real tool with the
    // hostile schema.
    return tools.flatMap((raw) => {
      const clean = sanitizeToolDescriptor(raw);
      return clean ? [clean] : [];
    });
  }

  /**
   * `tools/call`. Throws API_ERROR (carrying the tool's error text) when the
   * result is flagged `isError`, so a resolved promise is always a success.
   */
  async toolsCall(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as McpToolResult | undefined;
    if (!result || !Array.isArray(result.content)) {
      throw new CliError(CliErrorCode.API_ERROR, `Tool ${name} returned no content.`);
    }
    if (result.isError) {
      const text = result.content
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
      throw toolErrorToCliError(name, text);
    }
    return result;
  }

  /**
   * Raw pass-through: send `method` with `params` and return the remote's
   * `result` untouched — no unwrapping, no isError mapping, pagination left to
   * the caller. This is what the stdio proxy (`voyagier mcp`) forwards on, so a
   * `tools/list` page or a `tools/call` result (including `structuredContent`
   * and `isError`) reaches the local client exactly as the remote sent it.
   * Transport-level failures (401/403/429/network/RPC errors) still throw the
   * mapped CliError.
   */
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.rpc(method, params);
  }

  // ── transport ─────────────────────────────────────────────────────────────

  /** Send one JSON-RPC request after ensuring the session is initialized. */
  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const send = async (): Promise<unknown> => {
      const { response } = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
      return response.result;
    };
    try {
      return await send();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // Stale session: re-initialize once and retry the same request.
        this.log("mcp: session no longer valid (404); re-initializing once");
        this.initialized = false;
        this.serverInfo = null;
        await this.initialize();
        return await send();
      }
      throw err;
    }
  }

  private async post(
    message: Record<string, unknown>,
    opts: { includeSession?: boolean; includeProtocolVersion?: boolean; expectNoBody?: boolean } = {},
  ): Promise<{ response: JsonRpcResponse; headers: Headers }> {
    const includeSession = opts.includeSession ?? true;
    const includeProtocolVersion = opts.includeProtocolVersion ?? true;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (includeProtocolVersion) headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    if (includeSession && this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.requestId) headers["x-request-id"] = this.requestId();

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof CliError) throw err;
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const detail = timedOut
        ? `timed out after ${Math.round(this.timeoutMs / 1000)}s`
        : sanitizeExternalText(err instanceof Error ? err.message : String(err));
      throw new CliError(
        CliErrorCode.NETWORK,
        `Network error: could not reach the Voyagier MCP server at ${this.url} (${detail}).\nHint: check your connection, then run: voyagier doctor`,
      );
    }

    if (res.status === 401) {
      throw new CliError(
        CliErrorCode.AUTH_FAILED,
        authFailedMessage("Authentication failed. Your token may be invalid or expired."),
      );
    }
    if (res.status === 403) {
      throw new CliError(
        CliErrorCode.PERMISSION_DENIED,
        "Permission denied: your token does not have access to this resource — or the resource does not exist (the server reports missing and forbidden identically).\n  Fix: double-check any resource id in the command, confirm the token belongs to the right account, or ask a workspace admin for access.",
      );
    }
    if (res.status === 429) {
      const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
      const when = retryAfterSeconds != null ? ` Retry after ${retryAfterSeconds}s.` : "";
      throw new CliError(
        CliErrorCode.RATE_LIMITED,
        `Rate limited by the Voyagier MCP server.${when}`,
        retryAfterSeconds != null ? { retryAfterSeconds } : undefined,
      );
    }
    if (res.status === 404 && includeSession && this.sessionId) {
      throw new SessionExpiredError();
    }
    if (opts.expectNoBody && (res.status === 202 || res.status === 204)) {
      return { response: {}, headers: res.headers };
    }
    if (!res.ok) {
      const snippet = sanitizeExternalText((await safeText(res)).slice(0, 300));
      throw new CliError(
        CliErrorCode.API_ERROR,
        `MCP server error: ${res.status} ${sanitizeExternalText(res.statusText)}${snippet ? ` — ${snippet}` : ""}`,
      );
    }
    if (res.status === 202 || res.status === 204) {
      return { response: {}, headers: res.headers };
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const raw = await safeText(res);
    const messages = contentType.includes("text/event-stream") ? parseSseMessages(raw) : parseJsonMessages(raw);
    const wantId = message.id;
    const reply =
      messages.find((m) => wantId !== undefined && m.id === wantId) ??
      messages.find((m) => m.result !== undefined || m.error !== undefined);
    if (!reply) {
      if (opts.expectNoBody) return { response: {}, headers: res.headers };
      throw new CliError(CliErrorCode.API_ERROR, "MCP server returned an empty or unreadable response.");
    }
    if (reply.error) throw rpcErrorToCliError(reply.error);
    return { response: reply, headers: res.headers };
  }
}

/** Marker for the 404-on-session path; never escapes `rpc()`. */
class SessionExpiredError extends Error {
  constructor() {
    super("MCP session expired");
    this.name = "SessionExpiredError";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse a JSON body holding one message or a batch. */
export function parseJsonMessages(raw: string): JsonRpcResponse[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(CliErrorCode.API_ERROR, "MCP server returned a response that is not valid JSON.");
  }
  if (Array.isArray(parsed)) return parsed.filter(isObject) as JsonRpcResponse[];
  return isObject(parsed) ? [parsed as JsonRpcResponse] : [];
}

/**
 * Parse an SSE body into JSON-RPC messages: events are separated by blank
 * lines, each event's payload is the `data:` lines joined with "\n". Comments
 * (`:` lines) and other fields are ignored.
 */
export function parseSseMessages(raw: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  const events = raw.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const event of events) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.trim()) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (Array.isArray(parsed)) out.push(...(parsed.filter(isObject) as JsonRpcResponse[]));
      else if (isObject(parsed)) out.push(parsed as JsonRpcResponse);
    } catch {
      // A non-JSON data line (keep-alive, progress text) is not a message.
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Retry-After: delta-seconds or an HTTP date. Null when absent/unparseable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** Map a JSON-RPC error object onto a CliError. */
export function rpcErrorToCliError(error: { code?: number; message?: string; data?: unknown }): CliError {
  const message = sanitizeExternalText(error.message ?? "Unknown MCP error");
  const details: Record<string, unknown> = {};
  if (typeof error.code === "number") details.rpcCode = error.code;
  if (error.data !== undefined) details.data = error.data;
  if (/unauthori[sz]ed|unauthenticated|invalid token/i.test(message)) {
    return new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage(`Authentication failed: ${message}`));
  }
  if (/forbidden/i.test(message)) {
    return new CliError(CliErrorCode.PERMISSION_DENIED, `Permission denied: ${message}`, details);
  }
  // -32602 invalid params: the server rejected the tool arguments.
  if (error.code === -32602) {
    return new CliError(CliErrorCode.VALIDATION, `Invalid arguments: ${message}`, details);
  }
  // -32601 method not found / unknown tool.
  if (error.code === -32601) {
    return new CliError(CliErrorCode.NOT_FOUND, message, details);
  }
  return new CliError(CliErrorCode.API_ERROR, `MCP error: ${message}`, details);
}

/**
 * Turn a tool's `isError` text into a CliError. When the text is a JSON
 * envelope carrying `code`/`message`, keep them; otherwise the whole text is
 * the message. Always API_ERROR unless the text itself signals auth/permission.
 */
export function toolErrorToCliError(tool: string, text: string): CliError {
  const clean = sanitizeExternalText(text).trim() || `Tool ${tool} failed.`;
  let code: CliErrorCode = CliErrorCode.API_ERROR;
  let message = clean;
  const details: Record<string, unknown> = { tool };
  try {
    const parsed = JSON.parse(clean) as unknown;
    if (isObject(parsed)) {
      const inner = isObject(parsed.error) ? parsed.error : parsed;
      if (typeof inner.message === "string") message = sanitizeExternalText(inner.message);
      if (typeof inner.code === "string" && inner.code in CliErrorCode) {
        code = inner.code as CliErrorCode;
      } else if (typeof inner.code === "string") {
        details.serverCode = inner.code;
      }
      if (inner.details !== undefined) details.serverDetails = inner.details;
    }
  } catch {
    // Plain text error — use it verbatim.
  }
  if (/unauthori[sz]ed|unauthenticated/i.test(message)) {
    return new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage(message));
  }
  if (/forbidden|permission denied/i.test(message)) {
    return new CliError(CliErrorCode.PERMISSION_DENIED, message, details);
  }
  return new CliError(code, message, details);
}
