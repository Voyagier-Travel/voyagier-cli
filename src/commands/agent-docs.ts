/**
 * `voyagier agent-docs` — the agent reference, in two parts:
 *
 *  1. The Voyagier MCP server's own `instructions` (returned on `initialize`).
 *     That text owns everything about trip planning — tool order, search
 *     completion, booking gates — so the CLI stops carrying its own copy. It is
 *     read from the tools cache when fresh and fetched (and cached) otherwise.
 *  2. AGENT.md: the CLI-specific usage notes (auth, flags-from-schema, --json,
 *     exit codes, error envelope, migration).
 */
import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { credentialsExist } from "../config.js";
import { CliError } from "../errors.js";
import type { McpClient } from "../mcp-client/client.js";
import { createDefaultClient } from "../mcp-client/generated-commands.js";
import { refreshToolsCache } from "../mcp-client/startup.js";
import { isToolsCacheFresh, readToolsCache } from "../mcp-client/tools-cache.js";
import { getMcpUrl } from "../mcp-client/url.js";
import { jsonOutput } from "../output.js";

const FALLBACK = [
  "# Voyagier CLI — Agent Usage Notes",
  "",
  "The CLI is a shell for the Voyagier MCP server: one command per tool.",
  "",
  "  voyagier doctor --json                 # credentials, MCP connection, tool count",
  "  voyagier --help                        # local commands + one command per server tool",
  "  voyagier <tool_name> --help            # the tool's description and one flag per input",
  "  voyagier <tool_name> --<param> <value> --json",
  "",
  "Full notes: https://github.com/Voyagier-Travel/voyagier-cli/blob/main/AGENT.md",
  "",
].join("\n");

export type InstructionsSource = "cache" | "network" | "stale-cache" | "unavailable";

export interface ServerInstructions {
  /** The server's `instructions` text; null when unavailable. */
  instructions: string | null;
  source: InstructionsSource;
  /** Why the text is stale or missing. */
  note?: string;
}

export interface AgentDocsDeps {
  createClient?: () => McpClient;
  version?: string;
  now?: number;
}

export function resolveAgentMdPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "..", "..", "AGENT.md");
}

export function loadAgentDocs(): { content: string; fromFallback: boolean } {
  try {
    const content = readFileSync(resolveAgentMdPath(), "utf-8");
    return { content, fromFallback: false };
  } catch {
    return { content: FALLBACK, fromFallback: true };
  }
}

/**
 * The server's `instructions`: fresh cache → as is; otherwise fetch through
 * the client (which also refreshes the tools cache); on failure fall back to a
 * stale cache entry, else report why it is unavailable. Never throws.
 */
export async function loadServerInstructions(deps: AgentDocsDeps = {}): Promise<ServerInstructions> {
  const url = getMcpUrl();
  const now = deps.now ?? Date.now();
  const cache = readToolsCache();
  const stale = cache && cache.url === url && typeof cache.instructions === "string" ? cache.instructions : null;

  if (isToolsCacheFresh(cache, url, now) && typeof cache.instructions === "string" && cache.instructions.trim()) {
    return { instructions: cache.instructions, source: "cache" };
  }

  if (!credentialsExist()) {
    const note = "Not authenticated: run `voyagier login` (or set VOYAGIER_TOKEN) to fetch the server's guidance.";
    return stale ? { instructions: stale, source: "stale-cache", note } : { instructions: null, source: "unavailable", note };
  }

  try {
    const client = (deps.createClient ?? (() => createDefaultClient(deps.version ?? "0.0.0")))();
    const fresh = await refreshToolsCache(client, url, now);
    if (typeof fresh.instructions === "string" && fresh.instructions.trim()) {
      return { instructions: fresh.instructions, source: "network" };
    }
    return { instructions: null, source: "unavailable", note: `The server at ${url} publishes no instructions.` };
  } catch (err) {
    const reason = err instanceof CliError ? `${err.code}: ${err.message.split("\n")[0]}` : err instanceof Error ? err.message : String(err);
    const note = `Could not fetch the server's guidance from ${url} (${reason}).`;
    return stale ? { instructions: stale, source: "stale-cache", note } : { instructions: null, source: "unavailable", note };
  }
}

/** Human rendering: server section first, then the CLI notes. */
export function renderAgentDocs(server: ServerInstructions, content: string): string {
  const header = "# Voyagier MCP — server guidance";
  const serverBlock = server.instructions
    ? `${header}\n\n${server.instructions.trimEnd()}\n${server.note ? `\n> ${server.note}\n` : ""}`
    : `${header}\n\n_Unavailable._ ${server.note ?? ""}\n`;
  return `${serverBlock}\n---\n\n${content.endsWith("\n") ? content : `${content}\n`}`;
}

export function registerAgentDocsCommand(program: Command, deps: AgentDocsDeps = {}): void {
  program
    .command("agent-docs")
    .description("Print the agent reference: the MCP server's guidance, then the CLI usage notes (AGENT.md)")
    .option("--json", "Output as JSON with instructions and content fields")
    .action(async (opts: { json?: boolean }) => {
      const { content, fromFallback } = loadAgentDocs();
      const server = await loadServerInstructions(deps);

      if (opts.json) {
        jsonOutput({
          instructions: server.instructions,
          instructionsSource: server.source,
          content,
          format: "markdown",
          ...(server.note ? { note: server.note } : {}),
          ...(fromFallback ? { contentNote: "AGENT.md not found, showing fallback" } : {}),
        });
      } else {
        process.stdout.write(renderAgentDocs(server, content));
      }
    });
}
