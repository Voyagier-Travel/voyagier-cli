/**
 * Decide which tool list the command tree is built from at startup.
 *
 *  1. Fresh cache for the configured endpoint, written by this CLI version →
 *     use it, no network.
 *  2. Local command (auth, doctor, mcp, …), help/version, or no args → use a
 *     stale cache if one exists for the endpoint, else no tools; never hit the
 *     network just to print help (help then says how to populate the list).
 *
 * A cache written by another CLI version (or by a release before 4.1, which
 * recorded none) is never used, not even as the stale fallback: the previous
 * release's tool table can name tools this release has retired, so `--help`
 * would list them and a command would call a tool the server no longer has.
 *  3. Otherwise fetch `tools/list` (initialize + list), write the cache, use
 *     it. When the fetch fails, fall back to a stale cache and keep the error
 *     so the entrypoint can explain an unknown command.
 */
import { credentialsExist } from "../config.js";
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";
import { McpClient, type McpToolDescriptor } from "./client.js";
import { createDefaultClient } from "./generated-commands.js";
import { isToolsCacheForCli, isToolsCacheFresh, readToolsCache, toolsSurfaceHash, writeToolsCache, type ToolsCache } from "./tools-cache.js";
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
  /** A cache entry for the endpoint that was ignored because another CLI version wrote it. */
  ignoredCache?: { fetchedAt: string; cliVersion: string | null };
}

export interface StartupOptions {
  /** Ignore a fresh cache and refetch. */
  force?: boolean;
  createClient?: () => McpClient;
  /** The CLI's `package.json` version: sent as clientInfo.version and recorded on the cache entry it writes. */
  version?: string;
  now?: number;
}

/** Version used when the caller passes none (specs, ad-hoc scripts). */
const UNVERSIONED_CLI = "0.0.0";

/** Flags that end the run by themselves: no command token follows. */
const HELP_OR_VERSION_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

/**
 * The command word in argv, skipping leading global flags
 * (`voyagier --verbose list_plans` → `list_plans`). Null when there is no
 * command word, or when a help/version flag comes first (Commander answers
 * those without running a command).
 */
export function commandToken(userArgs: readonly string[]): string | null {
  for (const token of userArgs) {
    if (HELP_OR_VERSION_FLAGS.has(token)) return null;
    if (token.startsWith("-")) continue; // --verbose, --stacktrace, --json …
    return token;
  }
  return null;
}

/** True when argv means "no remote tools needed to run this". */
export function isLocalInvocation(userArgs: readonly string[]): boolean {
  const command = commandToken(userArgs);
  if (command === null) return true; // bare help/version/flags-only
  return LOCAL_COMMANDS.has(command);
}


/** Fetch `tools/list` from the server and persist it, stamped with the CLI version that wrote it. */
export async function refreshToolsCache(
  client: McpClient,
  url: string,
  cliVersion: string,
  now: number = Date.now(),
): Promise<ToolsCache> {
  const init = await client.initialize();
  const tools = await client.toolsList();
  const cache: ToolsCache = {
    url,
    fetchedAt: new Date(now).toISOString(),
    cliVersion,
    server: init.serverInfo ? { name: init.serverInfo.name, version: init.serverInfo.version } : undefined,
    surfaceHash: toolsSurfaceHash(tools),
    ...(typeof init.instructions === "string" && init.instructions.trim() ? { instructions: init.instructions } : {}),
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
  const cliVersion = opts.version ?? UNVERSIONED_CLI;
  const cache = readToolsCache();
  // Reusable past its TTL: same endpoint, same CLI version. An entry another
  // version wrote is reported (for --verbose) and otherwise treated as absent.
  const staleForUrl = isToolsCacheForCli(cache, url, cliVersion) ? cache : null;
  const ignoredCache =
    cache && cache.url === url && !staleForUrl ? { fetchedAt: cache.fetchedAt, cliVersion: cache.cliVersion ?? null } : undefined;

  if (!opts.force && isToolsCacheFresh(cache, url, cliVersion, now)) {
    return { url, tools: cache.tools, source: "cache", cache };
  }

  if (!opts.force && isLocalInvocation(userArgs)) {
    return staleForUrl
      ? { url, tools: staleForUrl.tools, source: "stale-cache", cache: staleForUrl }
      : { url, tools: [], source: "none", cache: null, ignoredCache };
  }

  if (!credentialsExist()) {
    const error = new CliError(
      CliErrorCode.AUTH_FAILED,
      authFailedMessage("Not authenticated — the command list comes from the Voyagier MCP server and needs a token."),
    );
    return staleForUrl
      ? { url, tools: staleForUrl.tools, source: "stale-cache", error, cache: staleForUrl }
      : { url, tools: [], source: "none", error, cache: null, ignoredCache };
  }

  try {
    const client = (opts.createClient ?? (() => createDefaultClient(cliVersion)))();
    const fresh = await refreshToolsCache(client, url, cliVersion, now);
    return { url, tools: fresh.tools, source: "network", cache: fresh, ignoredCache };
  } catch (err) {
    const error =
      err instanceof CliError
        ? err
        : new CliError(CliErrorCode.NETWORK, `Could not load the tool list: ${err instanceof Error ? err.message : String(err)}`);
    return staleForUrl
      ? { url, tools: staleForUrl.tools, source: "stale-cache", error, cache: staleForUrl }
      : { url, tools: [], source: "none", error, cache: null, ignoredCache };
  }
}
