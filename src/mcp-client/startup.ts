/**
 * Decide which tool list the command tree is built from at startup.
 *
 *  1. Fresh cache for the configured endpoint → use it, no network.
 *  2. Local command (auth, doctor, mcp, …), help/version, or no args → use a
 *     stale cache if one exists for the endpoint, else no tools; never hit the
 *     network just to print help (help then says how to populate the list).
 *  3. Otherwise fetch `tools/list` (initialize + list), write the cache, use
 *     it. When the fetch fails, fall back to a stale cache and keep the error
 *     so the entrypoint can explain an unknown command.
 */
import { credentialsExist } from "../config.js";
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";
import { McpClient, type McpToolDescriptor } from "./client.js";
import { createDefaultClient } from "./generated-commands.js";
import { isToolsCacheFresh, readToolsCache, toolsSurfaceHash, writeToolsCache, type ToolsCache } from "./tools-cache.js";
import { getMcpUrl } from "./url.js";

/** Commands that never need the remote tool list. */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "auth",
  "login",
  "doctor",
  "mcp",
  "agent-docs",
  "telemetry",
  "help",
]);

export type StartupSource = "cache" | "network" | "stale-cache" | "none";

export interface StartupTools {
  url: string;
  tools: McpToolDescriptor[];
  source: StartupSource;
  /** Why the network fetch did not happen or failed (only when source ≠ network/cache). */
  error?: CliError;
  cache?: ToolsCache | null;
}

export interface StartupOptions {
  /** Ignore a fresh cache and refetch. */
  force?: boolean;
  createClient?: () => McpClient;
  version?: string;
  now?: number;
}

/** True when argv means "no remote tools needed to run this". */
export function isLocalInvocation(userArgs: readonly string[]): boolean {
  const first = userArgs[0];
  if (!first) return true;
  if (first.startsWith("-")) return true; // --help, --version, -V …
  return LOCAL_COMMANDS.has(first);
}


/** Fetch `tools/list` from the server and persist it. */
export async function refreshToolsCache(
  client: McpClient,
  url: string,
  now: number = Date.now(),
): Promise<ToolsCache> {
  const init = await client.initialize();
  const tools = await client.toolsList();
  const cache: ToolsCache = {
    url,
    fetchedAt: new Date(now).toISOString(),
    server: init.serverInfo ? { name: init.serverInfo.name, version: init.serverInfo.version } : undefined,
    surfaceHash: toolsSurfaceHash(tools),
    tools,
  };
  writeToolsCache(cache);
  return cache;
}

export async function resolveStartupTools(
  userArgs: readonly string[],
  opts: StartupOptions = {},
): Promise<StartupTools> {
  const url = getMcpUrl();
  const now = opts.now ?? Date.now();
  const cache = readToolsCache();
  const staleForUrl = cache && cache.url === url ? cache : null;

  if (!opts.force && isToolsCacheFresh(cache, url, now)) {
    return { url, tools: cache.tools, source: "cache", cache };
  }

  if (!opts.force && isLocalInvocation(userArgs)) {
    return staleForUrl
      ? { url, tools: staleForUrl.tools, source: "stale-cache", cache: staleForUrl }
      : { url, tools: [], source: "none", cache: null };
  }

  if (!credentialsExist()) {
    const error = new CliError(
      CliErrorCode.AUTH_FAILED,
      authFailedMessage("Not authenticated — the command list comes from the Voyagier MCP server and needs a token."),
    );
    return staleForUrl
      ? { url, tools: staleForUrl.tools, source: "stale-cache", error, cache: staleForUrl }
      : { url, tools: [], source: "none", error, cache: null };
  }

  try {
    const client = (opts.createClient ?? (() => createDefaultClient(opts.version ?? "0.0.0")))();
    const fresh = await refreshToolsCache(client, url, now);
    return { url, tools: fresh.tools, source: "network", cache: fresh };
  } catch (err) {
    const error =
      err instanceof CliError
        ? err
        : new CliError(CliErrorCode.NETWORK, `Could not load the tool list: ${err instanceof Error ? err.message : String(err)}`);
    return staleForUrl
      ? { url, tools: staleForUrl.tools, source: "stale-cache", error, cache: staleForUrl }
      : { url, tools: [], source: "none", error, cache: null };
  }
}
