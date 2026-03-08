import { Command } from "commander";
import chalk from "chalk";
import { createMcpClient, listTools, callTool } from "../mcp.js";

export function registerToolsCommands(program: Command): void {
  const tools = program.command("tools").description("MCP tools (advanced)");

  tools
    .command("list")
    .description("List available MCP tools")
    .action(async () => {
      let client;
      try {
        client = await createMcpClient();
        const toolList = await listTools(client);

        if (toolList.length === 0) {
          console.log(chalk.dim("No tools available."));
          return;
        }

        console.log(chalk.bold(`\nAvailable Tools (${toolList.length}):\n`));

        for (const tool of toolList) {
          console.log(`  ${chalk.cyan(tool.name)}`);
          if (tool.description) {
            console.log(`  ${chalk.dim(tool.description)}`);
          }
          console.log();
        }

        console.log(chalk.dim(`Call a tool: voyagier tools call <name> '<json args>'`));
      } catch (err) {
        handleToolsError(err);
      } finally {
        await client?.close();
      }
    });

  tools
    .command("call <name> [argsJson]")
    .description("Call an MCP tool with JSON arguments")
    .action(async (name: string, argsJson?: string) => {
      let client;
      try {
        let args: Record<string, unknown> = {};
        if (argsJson) {
          try {
            args = JSON.parse(argsJson) as Record<string, unknown>;
          } catch {
            console.error(chalk.red("Invalid JSON arguments. Wrap in single quotes: '{\"key\":\"value\"}'"));
            process.exit(1);
          }
        }

        console.log(chalk.dim(`Calling ${name}...`));
        client = await createMcpClient();
        const result = await callTool(client, name, args);

        if (result.isError) {
          console.error(chalk.red("\nTool returned an error:"));
        }

        for (const part of result.content) {
          if (part.type === "text" && part.text) {
            try {
              const parsed = JSON.parse(part.text);
              console.log(JSON.stringify(parsed, null, 2));
            } catch {
              console.log(part.text);
            }
          }
        }

      } catch (err) {
        handleToolsError(err);
      } finally {
        await client?.close();
      }
    });
}

function handleToolsError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("401") || message.includes("Unauthorized")) {
    console.error(chalk.red("Authentication failed. Run: voyagier auth setup"));
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    console.error(chalk.red("Could not connect to MCP endpoint. Check: voyagier auth status\n  Need a token? Run: voyagier auth setup"));
  } else {
    console.error(chalk.red(`Error: ${message}`));
  }
}
