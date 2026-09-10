/**
 * `voyagier mcp` — a stdio proxy for the hosted Voyagier MCP server.
 *
 * The stdio server (and the MCPB bundle built from it) holds no tool table of
 * its own. Every `tools/list` and `tools/call` it receives on stdin is
 * forwarded to `https://mcp.voyagier.com/api/mcp` (or `VOYAGIER_MCP_URL`)
 * through src/mcp-client with the Personal Access Token from `VOYAGIER_TOKEN`
 * or the stored credentials, and the remote result is returned to the local
 * client exactly as the remote sent it: the same tool descriptors, the same
 * content blocks, `structuredContent` and `isError` untouched. The remote's
 * `instructions` and `tools` capability from `initialize` are passed through
 * as this server's own.
 *
 * Failure policy: the local handshake always succeeds, so an MCP host can
 * connect and show the user what is wrong. When the remote cannot be reached
 * (no token, 401, network), `instructions` carries the explanation and every
 * `tools/list` / `tools/call` answers with a JSON-RPC error whose message says
 * how to fix it (set `VOYAGIER_TOKEN`, wait `Retry-After`, …). Each request
 * re-attempts the remote handshake, so fixing the environment and retrying
 * needs no restart of the host.
 */
import { readFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CliError, CliErrorCode } from "../errors.js";
import { McpClient, type McpInitializeResult } from "../mcp-client/client.js";
import { createDefaultClient } from "../mcp-client/generated-commands.js";
import { getMcpUrl } from "../mcp-client/url.js";

export interface CreateProxyServerDeps {
  /** MCP client to forward through; defaults to the hosted URL + stored PAT. */
  client?: McpClient;
  /**
   * Client factory, called at startup and again on the first request after a
   * startup without a client (e.g. no token yet). Defaults to the hosted
   * URL + the credentials on disk at call time, so `voyagier auth login`
   * while the host stays open takes effect on the next request.
   */
  createClient?: () => McpClient;
  /** Server version; defaults to package.json version. */
  version?: string;
  /** Diagnostic sink; never stdout (stdout is the JSON-RPC channel). */
  log?: (line: string) => void;
}

export interface ProxyServer {
  server: Server;
  /** Endpoint being proxied. */
  url: string;
  /** The remote's initialize result, when the startup handshake succeeded. */
  remote: McpInitializeResult | null;
  /** Why the startup handshake did not succeed (requests still retry). */
  startupError: CliError | null;
}

/** JSON-RPC error codes the proxy uses for transport-level failures. */
export const PROXY_ERROR_CODES = {
  /** Reserved JSON-RPC range: connection closed / unreachable. */
  NETWORK: -32000,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** Application range, mirrors the HTTP status the remote answered with. */
  AUTH_FAILED: 401,
  PERMISSION_DENIED: 403,
  RATE_LIMITED: 429,
} as const;

export const SET_TOKEN_HINT =
  "Set VOYAGIER_TOKEN to a Voyagier Personal Access Token (travel.voyagier.com → Settings → Personal Access Tokens) in this MCP server's environment, or run `voyagier auth login` on this machine, then retry.";

/** Read the CLI version from package.json (same mechanism as src/index.ts). */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

/**
 * Map a CliError from the client onto the JSON-RPC error the local host sees.
 * The message is the user-facing fix; `data` carries the CLI error code and
 * details (retryAfterSeconds for 429) for hosts that read structured errors.
 */
export function cliErrorToMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (!(err instanceof CliError)) {
    const message = err instanceof Error ? err.message : String(err);
    return new McpError(PROXY_ERROR_CODES.INTERNAL, `Voyagier MCP proxy: ${message}`);
  }
  const data: Record<string, unknown> = { code: err.code, ...(err.details ?? {}) };
  switch (err.code) {
    case CliErrorCode.AUTH_FAILED:
      return new McpError(
        PROXY_ERROR_CODES.AUTH_FAILED,
        `Voyagier MCP: authentication failed — the hosted server rejected the token (or none was provided). ${SET_TOKEN_HINT}`,
        data,
      );
    case CliErrorCode.PERMISSION_DENIED:
      return new McpError(PROXY_ERROR_CODES.PERMISSION_DENIED, `Voyagier MCP: ${err.message}`, data);
    case CliErrorCode.RATE_LIMITED: {
      const retry = err.details?.retryAfterSeconds;
      const when = typeof retry === "number" ? ` Retry after ${retry}s.` : "";
      return new McpError(
        PROXY_ERROR_CODES.RATE_LIMITED,
        `Voyagier MCP: rate limited by the hosted server.${when} Space out requests; the endpoint is limited per token.`,
        data,
      );
    }
    case CliErrorCode.NETWORK:
      return new McpError(PROXY_ERROR_CODES.NETWORK, `Voyagier MCP: ${err.message}`, data);
    case CliErrorCode.VALIDATION:
      return new McpError(PROXY_ERROR_CODES.INVALID_PARAMS, err.message, data);
    case CliErrorCode.NOT_FOUND:
      return new McpError(PROXY_ERROR_CODES.METHOD_NOT_FOUND, err.message, data);
    default:
      return new McpError(PROXY_ERROR_CODES.INTERNAL, `Voyagier MCP: ${err.message}`, data);
  }
}

/** What to do about a failed remote handshake, by the error the client raised. */
export function startupFixHint(err: CliError): string {
  switch (err.code) {
    case CliErrorCode.AUTH_FAILED:
      return SET_TOKEN_HINT;
    case CliErrorCode.PERMISSION_DENIED:
      return "The token is valid but this account is not allowed to use the MCP server. Ask a workspace admin for access, or use a token from an account that has it, then retry.";
    case CliErrorCode.RATE_LIMITED: {
      const wait = typeof err.details?.retryAfterSeconds === "number" ? ` Wait ${err.details.retryAfterSeconds}s` : " Wait";
      return `The hosted server is rate limiting this token.${wait}, then retry; requests re-attempt the handshake.`;
    }
    case CliErrorCode.NETWORK:
      return "Check the network connection and VOYAGIER_MCP_URL, then retry; each request re-attempts the handshake.";
    default:
      return "Retry; each request re-attempts the handshake. Run `voyagier doctor` on this machine for details.";
  }
}

/** The `instructions` the local host sees when the remote handshake failed. */
export function unavailableInstructions(url: string, err: CliError): string {
  return `This proxy could not complete the handshake with the Voyagier MCP server at ${url}: ${err.message}\n${startupFixHint(err)}`;
}

/**
 * Build the proxy. Performs the remote `initialize` first so the local
 * handshake can carry the remote's instructions and tools capability; connects
 * no transport.
 */
export async function createProxyServer(deps: CreateProxyServerDeps = {}): Promise<ProxyServer> {
  const version = deps.version ?? readVersion();
  const log = deps.log ?? (() => {});
  const url = getMcpUrl();

  const createClient = deps.createClient ?? (deps.client ? () => deps.client as McpClient : () => createDefaultClient(version));
  const toCliError = (err: unknown): CliError =>
    err instanceof CliError ? err : new CliError(CliErrorCode.NETWORK, err instanceof Error ? err.message : String(err));

  let client: McpClient | null = null;
  let remote: McpInitializeResult | null = null;
  let startupError: CliError | null = null;
  try {
    client = createClient();
    remote = await client.initialize();
  } catch (err) {
    startupError = toCliError(err);
    log(`mcp proxy: remote initialize failed (${startupError.code}): ${startupError.message}`);
  }

  // The remote advertises `tools.listChanged`, but this proxy speaks to a
  // stateless HTTP upstream and receives no server notifications, so it could
  // never relay `notifications/tools/list_changed`. Advertising a capability
  // that never fires would make hosts wait for it: advertise plain `tools`.
  const capabilities = { tools: {} };
  const instructions = remote
    ? typeof remote.instructions === "string" && remote.instructions.trim()
      ? remote.instructions
      : undefined
    : unavailableInstructions(url, startupError as CliError);

  const server = new Server({ name: "voyagier", version }, { capabilities, ...(instructions ? { instructions } : {}) });

  const forward = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!client) {
      // Startup had no client (typically: no token yet). Re-read credentials
      // now, so a login performed while the host stays open is picked up.
      try {
        client = createClient();
        log("mcp proxy: client created on first request");
      } catch (err) {
        throw cliErrorToMcpError(toCliError(err));
      }
    }
    try {
      return await client.request(method, params);
    } catch (err) {
      throw cliErrorToMcpError(err);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const result = await forward("tools/list", typeof cursor === "string" ? { cursor } : {});
    if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) {
      throw new McpError(PROXY_ERROR_CODES.INTERNAL, "Voyagier MCP: the hosted server returned no tool list.");
    }
    return result as { tools: never[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await forward("tools/call", { name, arguments: args ?? {} });
    if (!result || typeof result !== "object") {
      throw new McpError(PROXY_ERROR_CODES.INTERNAL, `Voyagier MCP: tool ${name} returned no result.`);
    }
    // Forwarded verbatim: content, structuredContent, isError, _meta.
    return result as { content: never[] };
  });

  return { server, url, remote, startupError };
}
