import { Command } from "commander";
import chalk from "chalk";
import { createMcpClient, listTools, callTool } from "../mcp.js";

export function registerToolsCommands(program: Command): void {
  const tools = program.command("tools").description("MCP tools (advanced)");

  tools
    .command("list")
    .description("List available MCP tools")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      let client;
      try {
        client = await createMcpClient();
        const toolList = await listTools(client);

        if (opts.json) {
          process.stdout.write(JSON.stringify(toolList, null, 2) + "\n");
          return;
        }

        if (toolList.length === 0) {
          process.stderr.write(chalk.dim("No tools available.\n"));
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
            process.stderr.write(chalk.red("Invalid JSON. Wrap in single quotes: '{\"key\":\"value\"}'\n"));
            process.exit(1);
          }
        }

        if (!process.stdout.isTTY) {
          // Piped — skip the status message
        } else {
          process.stderr.write(chalk.dim(`Calling ${name}...\n`));
        }

        client = await createMcpClient();
        const result = await callTool(client, name, args);

        if (result.isError) {
          process.stderr.write(chalk.red("Tool returned an error:\n"));
        }

        for (const part of result.content) {
          if (part.type === "text" && part.text) {
            try {
              const parsed = JSON.parse(part.text);
              process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
            } catch {
              process.stdout.write(part.text + "\n");
            }
          }
        }

        if (result.isError) process.exit(1);
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
    process.stderr.write(chalk.red("Authentication failed. Run: voyagier auth setup\n"));
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    process.stderr.write(chalk.red("Could not connect to MCP endpoint. Run: voyagier auth status\n"));
  } else {
    process.stderr.write(chalk.red(`Error: ${message}\n`));
  }
  process.exit(1);
}
