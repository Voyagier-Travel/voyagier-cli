import { Command } from "commander";
import chalk from "chalk";
import { saveCredentials, loadCredentials, clearCredentials } from "../config.js";

const TOKEN_HELP = `
${chalk.bold("How to get your Personal Access Token:")}

  1. Go to ${chalk.cyan("https://voyagier.com/me/settings/tokens")}
     (or ${chalk.cyan("https://dev.voyagier.com/me/settings/tokens")} for sandbox)
  2. Click ${chalk.bold("Create Token")} and give it a name
  3. Copy the token (starts with ${chalk.yellow("voy_pat_")})
  4. Run: ${chalk.green("voyagier auth set-token <token>")}

${chalk.dim("Sandbox (Sabre test data, free):")}
  voyagier auth set-token voy_pat_xxx --url https://dev.voyagier.com

${chalk.dim("Production (real flights/hotels):")}
  voyagier auth set-token voy_pat_xxx --url https://voyagier.com
`;

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("set-token <token>")
    .description("Set your Personal Access Token")
    .option("-u, --url <url>", "API URL (default: https://voyagier.com)")
    .action((token: string, opts: { url?: string }) => {
      if (!token.startsWith("voy_pat_")) {
        console.error(chalk.red("Token must start with voy_pat_\n"));
        console.log(TOKEN_HELP);
        process.exit(1);
      }
      const apiUrl = opts.url ?? "https://voyagier.com";
      saveCredentials(token, apiUrl);
      console.log(chalk.green("✓ Token saved."));
      console.log(`  ${chalk.dim("API:")} ${apiUrl}`);
      console.log(chalk.dim("\n  Check connection: voyagier auth status"));
    });

  auth
    .command("setup")
    .description("Show how to get started with the CLI")
    .action(() => {
      console.log(TOKEN_HELP);
    });

  auth
    .command("status")
    .description("Check authentication and connectivity")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds?.token) {
        console.log(chalk.red("✗ Not authenticated.\n"));
        console.log(TOKEN_HELP);
        return;
      }

      const isSandbox = creds.apiUrl.includes("dev.");
      const env = isSandbox ? chalk.yellow("sandbox") : chalk.green("production");

      console.log(chalk.green("✓ Token configured"));
      console.log(`  ${chalk.dim("Token:")}  voy_pat_...${creds.token.slice(-4)}`);
      console.log(`  ${chalk.dim("API:")}    ${creds.apiUrl}`);
      console.log(`  ${chalk.dim("Env:")}    ${env}`);
      console.log(`  ${chalk.dim("Manage:")} ${creds.apiUrl}/me/settings/tokens`);

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
          console.log(`  ${chalk.dim("GraphQL:")} ${chalk.green("✓ connected")}`);
        } else if (res.status === 401) {
          console.log(`  ${chalk.dim("GraphQL:")} ${chalk.red("✗ token rejected — regenerate at")} ${creds.apiUrl}/me/settings/tokens`);
        } else {
          console.log(`  ${chalk.dim("GraphQL:")} ${chalk.yellow(`⚠ HTTP ${res.status}`)}`);
        }
      } catch {
        console.log(`  ${chalk.dim("GraphQL:")} ${chalk.red("✗ unreachable")}`);
      }

      // Check MCP connectivity
      try {
        const res = await fetch(`${creds.apiUrl}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0", method: "initialize", id: 1,
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "voyagier-cli", version: "0.2.0" } },
          }),
        });
        if (res.ok) {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.green("✓ connected")}`);
        } else if (res.status === 401) {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.red("✗ token rejected")}`);
        } else if (res.status === 404) {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.yellow("⚠ not available (MCP module not deployed yet)")}`);
        } else {
          console.log(`  ${chalk.dim("MCP:")}     ${chalk.yellow(`⚠ HTTP ${res.status}`)}`);
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
