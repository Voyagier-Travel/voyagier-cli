import { Command } from "commander";
import chalk from "chalk";
import { saveCredentials, loadCredentials, clearCredentials, getApiUrl } from "../config.js";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("set-token <token>")
    .description("Set your Personal Access Token")
    .option("-u, --url <url>", "API URL", "https://api.voyagier.com")
    .action((token: string, opts: { url: string }) => {
      if (!token.startsWith("voy_pat_")) {
        console.error(chalk.red("Token must start with voy_pat_"));
        process.exit(1);
      }
      saveCredentials(token, opts.url);
      console.log(chalk.green("✓ Token saved."));
      console.log(chalk.dim(`  API: ${opts.url}`));
    });

  auth
    .command("status")
    .description("Check authentication status")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds?.token) {
        console.log(chalk.red("✗ Not authenticated."));
        console.log(chalk.dim("  Run: voyagier auth set-token <token>"));
        return;
      }

      console.log(chalk.green("✓ Token configured"));
      console.log(`  ${chalk.dim("Token:")} voy_pat_...${creds.token.slice(-4)}`);
      console.log(`  ${chalk.dim("API:")}   ${creds.apiUrl}`);

      // Check GraphQL connectivity
      try {
        const res = await fetch(`${creds.apiUrl}/graphql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.token}`,
          },
          body: JSON.stringify({ query: "{ __typename }" }),
        });
        if (res.ok) {
          console.log(`  ${chalk.dim("GraphQL:")} ${chalk.green("✓ reachable")}`);
        } else if (res.status === 401) {
          console.log(`  ${chalk.dim("GraphQL:")} ${chalk.red("✗ token rejected (401)")}`);
        } else {
          console.log(`  ${chalk.dim("GraphQL:")} ${chalk.yellow(`⚠ ${res.status}`)}`);
        }
      } catch {
        console.log(`  ${chalk.dim("GraphQL:")} ${chalk.red("✗ unreachable")}`);
      }

      // Check MCP connectivity
      const mcpUrl = `${creds.apiUrl}/mcp`;
      try {
        const res = await fetch(mcpUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "voyagier-cli", version: "0.2.0" } } }),
        });
        if (res.ok) {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.green("✓ reachable")}`);
        } else if (res.status === 401) {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.red("✗ token rejected (401)")}`);
        } else if (res.status === 404) {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.yellow("⚠ endpoint not found (MCP module not deployed?)")}`);
        } else {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.yellow(`⚠ ${res.status}`)}`);
        }
      } catch {
        console.log(`  ${chalk.dim("MCP:")}     ${chalk.red("✗ unreachable")}`);
      }
    });

  auth
    .command("logout")
    .description("Clear saved credentials")
    .action(() => {
      clearCredentials();
      console.log(chalk.dim("Credentials cleared."));
    });
}
