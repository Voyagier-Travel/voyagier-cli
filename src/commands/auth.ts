import { Command } from "commander";
import chalk from "chalk";
import { saveCredentials, getToken, getApiUrl, clearCredentials, credentialsExist } from "../config.js";
import { graphql } from "../api.js";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("set-token <token>")
    .description("Save a personal access token")
    .option("--url <apiUrl>", "API base URL", "https://voyagier.com")
    .action((token: string, opts) => {
      if (!token.startsWith("voy_pat_")) {
        process.stderr.write(
          chalk.yellow("⚠ Token doesn't start with voy_pat_ — this may not be a valid Voyagier PAT.\n")
        );
      }

      saveCredentials(token, opts.url);
      console.log(chalk.green("✓ Token saved."));
      console.log(chalk.dim(`  API URL: ${opts.url}`));
      console.log(chalk.dim("  Run: voyagier auth status"));
    });

  auth
    .command("status")
    .description("Check authentication status")
    .action(async () => {
      if (!credentialsExist()) {
        console.log(chalk.red("✗ Not authenticated."));
        console.log(chalk.dim("  Run: voyagier auth setup"));
        return;
      }

      const apiUrl = getApiUrl();
      const token = getToken();
      const masked = token.length > 12 ? token.slice(0, 8) + "••••" + token.slice(-4) : "••••";

      console.log(chalk.bold("\nVoyagier CLI Status\n"));
      console.log(`  Token:   ${chalk.dim(masked)}`);
      console.log(`  API URL: ${chalk.dim(apiUrl)}`);

      // Test GraphQL connectivity + get user info
      try {
        const data = await graphql<{ me: { email: string; name?: string } }>(
          `{ me { email name } }`
        );
        const user = data.me;
        const displayName = user.name ? `${user.name} (${user.email})` : user.email;
        console.log(`  User:    ${chalk.green(displayName)}`);
        console.log(`\n  ${chalk.green("✓")} GraphQL: connected`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("401") || message.includes("Authentication")) {
          console.log(`\n  ${chalk.red("✗")} GraphQL: authentication failed`);
        } else {
          console.log(`\n  ${chalk.red("✗")} GraphQL: ${message}`);
        }
      }
      console.log();
    });

  auth
    .command("logout")
    .description("Clear saved credentials")
    .action(() => {
      clearCredentials();
      console.log(chalk.green("✓ Credentials cleared."));
    });

  auth
    .command("setup")
    .description("How to get started")
    .action(() => {
      console.log(chalk.bold("\nVoyagier CLI Setup\n"));
      console.log("  1. Log in to voyagier.com");
      console.log("  2. Go to Settings → Personal Access Tokens");
      console.log("  3. Create a new token");
      console.log("  4. Run:\n");
      console.log(chalk.cyan("     voyagier auth set-token <your-token>\n"));
      console.log("  Or set environment variables:\n");
      console.log(chalk.dim("     export VOYAGIER_TOKEN=voy_pat_xxxxx"));
      console.log(chalk.dim("     export VOYAGIER_API_URL=https://voyagier.com  # optional\n"));
    });
}
