import { Command } from "commander";
import chalk from "chalk";
import { saveCredentials, loadCredentials, clearCredentials } from "../config.js";
import { graphql } from "../api.js";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("set-token <token>")
    .description("Store a Personal Access Token")
    .option("--api-url <url>", "API base URL", "https://api.voyagier.com")
    .action(async (token: string, opts: { apiUrl: string }) => {
      if (!token.startsWith("voy_pat_")) {
        console.error(chalk.red("Invalid token format. Expected: voy_pat_..."));
        process.exit(1);
      }

      saveCredentials(token, opts.apiUrl);
      console.log(chalk.green("✓ Token saved to ~/.voyagier/credentials.json"));

      // Verify it works
      try {
        const data = await graphql<{ me: { name: string; email: string; isAdmin: boolean } }>(
          `query { me { name email isAdmin } }`
        );
        if (data.me) {
          console.log(chalk.dim(`  Authenticated as ${data.me.name} (${data.me.email})`));
          if (data.me.isAdmin) {
            console.log(chalk.dim("  Admin access: ✓"));
          }
        }
      } catch {
        console.warn(chalk.yellow("  ⚠ Could not verify token (API may be unreachable)"));
      }
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds) {
        console.log(chalk.yellow("Not authenticated."));
        console.log(chalk.dim("Run: voyagier auth set-token <token>"));
        return;
      }

      console.log(chalk.dim(`API: ${creds.apiUrl}`));
      console.log(chalk.dim(`Token: ••••${creds.token.slice(-4)}`));

      try {
        const data = await graphql<{ me: { name: string; email: string; isAdmin: boolean } }>(
          `query { me { name email isAdmin } }`
        );
        if (data.me) {
          console.log(chalk.green(`✓ ${data.me.name} (${data.me.email})`));
          console.log(chalk.dim(`  Admin: ${data.me.isAdmin ? "yes" : "no"}`));
        }
      } catch {
        console.error(chalk.red("✗ Token is invalid or API is unreachable"));
      }
    });

  auth
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      clearCredentials();
      console.log(chalk.green("✓ Credentials cleared."));
    });
}
