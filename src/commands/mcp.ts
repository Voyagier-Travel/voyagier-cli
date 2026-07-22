/**
 * `voyagier mcp` — run the Model Context Protocol stdio server.
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

export function registerMcpCommand(program: Command): void {
  program
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
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      // Client disconnect (stdin EOF) closes the transport → shut down cleanly.
      server.server.onclose = () => void shutdown();

      await server.connect(transport);
      // Diagnostics to stderr ONLY — stdout is reserved for JSON-RPC.
      process.stderr.write(`voyagier mcp: stdio server ready (${TOOLS.length} tools)\n`);
    });
}
