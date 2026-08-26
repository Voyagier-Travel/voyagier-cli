/**
 * `voyagier mcp` — run the Model Context Protocol stdio server.
 *
 * The command doubles as a group: `voyagier mcp install <client>` (see
 * mcp-install.ts) wires an AI client to the hosted MCP server. Running `mcp`
 * with no subcommand still starts the stdio server, which is what the client
 * configs written by `install` invoke.
 *
 * stdout discipline: in this process stdout belongs to JSON-RPC. Nothing else
 * may write to it — diagnostics go to stderr. (The welcome banner in index.ts
 * only fires for zero-arg unauthenticated invocations, which `mcp` is not; and
 * every tool handler runs the CLI as a PIPED child, so its spinner/progress
 * output is silent-safe.)
 */
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp/server.js";
import { TOOLS } from "../mcp/tools.js";
import { gracefulExit } from "../exit.js";
import { registerMcpInstallCommand } from "./mcp-install.js";

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Run the Model Context Protocol (MCP) stdio server exposing the agent surface")
    .action(async () => {
      const server = createServer();
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
        // Let the event loop drain (buffered stdio flushes, in-flight child
        // processes reap) instead of truncating output with a hard exit.
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
      server.server.onclose = () => void shutdown();

      await server.connect(transport);
      // Diagnostics to stderr ONLY — stdout is reserved for JSON-RPC.
      process.stderr.write(`voyagier mcp: stdio server ready (${TOOLS.length} tools)\n`);
    });

  registerMcpInstallCommand(mcp);
}
