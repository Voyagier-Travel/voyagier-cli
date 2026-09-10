/**
 * `voyagier mcp` — run the stdio proxy for the hosted Voyagier MCP server.
 *
 * The command doubles as a group: `voyagier mcp install <client>` (see
 * mcp-install.ts) wires an AI client to the hosted MCP server. Running `mcp`
 * with no subcommand starts the stdio proxy (src/mcp/server.ts), which is what
 * stdio-only hosts (Claude Desktop, the MCPB bundle) invoke.
 *
 * stdout discipline: while the proxy is running, stdout belongs to JSON-RPC and
 * nothing else may write to it — diagnostics go to stderr. Subcommands like
 * `mcp install` are ordinary CLI commands and print to stdout normally; the
 * restriction is the server's, not the command group's.
 */
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProxyServer } from "../mcp/server.js";
import { gracefulExit } from "../exit.js";
import { verbose } from "../verbose.js";
import { registerMcpInstallCommand } from "./mcp-install.js";

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Run a stdio MCP server that proxies the hosted Voyagier MCP server (for stdio-only hosts)")
    .action(async () => {
      const { server, url, remote, startupError } = await createProxyServer({
        log: verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
      });
      const transport = new StdioServerTransport();

      let closing = false;
      const shutdown = async (): Promise<void> => {
        if (closing) return;
        closing = true;
        try {
          await server.close();
        } catch {
          // best-effort — we're exiting anyway
        }
        // Let the event loop drain (buffered stdio flushes) instead of
        // truncating output with a hard exit.
        process.exitCode = 0;
        // Failsafe: if something keeps the loop alive (leaked handle), force
        // the exit after a grace period. unref() so the timer itself never
        // holds the process open. gracefulExit drains in-flight telemetry
        // first (VOY-1765).
        setTimeout(() => void gracefulExit(0), 2000).unref();
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      // Client disconnect (stdin EOF) closes the transport → shut down cleanly.
      server.onclose = () => void shutdown();

      await server.connect(transport);
      // Diagnostics to stderr ONLY — stdout is reserved for JSON-RPC.
      if (startupError) {
        process.stderr.write(`voyagier mcp: proxy for ${url} ready, but the remote handshake failed (${startupError.code}); requests will retry.\n`);
      } else {
        const who = remote?.serverInfo
          ? ` (server ${[remote.serverInfo.name ?? "?", remote.serverInfo.version ?? ""].join(" ").trim()})`
          : "";
        process.stderr.write(`voyagier mcp: proxy for ${url} ready${who}\n`);
      }
    });

  registerMcpInstallCommand(mcp);
}
