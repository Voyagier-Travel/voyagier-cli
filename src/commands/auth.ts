import { Command } from "commander";
import chalk from "chalk";
import { createServer } from "http";
import { openBrowser } from "../utils.js";

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
    .command("login")
    .description("Log in via browser (opens browser, receives token via callback)")
    .option("--url <apiUrl>", "API base URL", "https://voyagier.com")
    .option("--port <port>", "Local callback port", "9876")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const apiUrl = opts.url as string;

      console.log(chalk.bold("\nVoyagier CLI Login\n"));
      console.log(chalk.dim("Starting local server to receive auth callback...\n"));

      const tokenPromise = new Promise<string>((resolve, reject) => {
        // Declare server before timeout so the reference is valid in the callback
        let server: ReturnType<typeof createServer>;

        const timeout = setTimeout(() => {
          server?.close();
          reject(new Error("Login timed out after 5 minutes."));
        }, 5 * 60 * 1000);

        server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://localhost:${port}`);

          // Handle the callback with token
          // TODO: Token-in-URL is a temporary approach. When the backend supports it,
          // switch to auth-code exchange (code in URL → POST to /auth/token → receive PAT)
          // and add CSRF state param validation. See: https://datatracker.ietf.org/doc/html/rfc6749#section-4.1
          if (url.pathname === "/callback") {
            const token = url.searchParams.get("token");

            if (token) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(`
                <html><body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                  <div style="text-align: center;">
                    <h1>✓ Authenticated</h1>
                    <p>You can close this window and return to the terminal.</p>
                  </div>
                </body></html>
              `);
              clearTimeout(timeout);
              server.close();
              resolve(token);
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Missing token parameter.");
            }
            return;
          }

          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        });

        server.listen(port, () => {
          const loginUrl = `${apiUrl}/auth/cli?callback=http://localhost:${port}/callback`;
          console.log(`  Open this URL in your browser:\n`);
          console.log(chalk.cyan(`  ${loginUrl}\n`));
          console.log(chalk.dim("  Waiting for authentication...\n"));

          // Try to open browser automatically
          openBrowser(loginUrl);
        });

        server.on("error", (err) => {
          clearTimeout(timeout);
          reject(new Error(`Could not start local server on port ${port}: ${err.message}`));
        });
      });

      try {
        const token = await tokenPromise;
        saveCredentials(token, apiUrl);
        console.log(chalk.green("✓ Login successful! Token saved.\n"));

        // Verify
        try {
          const data = await graphql<{ me: { email: string; name?: string } }>(
            `{ me { email name } }`
          );
          const user = data.me;
          const displayName = user.name ? `${user.name} (${user.email})` : user.email;
          console.log(`  Authenticated as: ${chalk.green(displayName)}`);
        } catch {
          console.log(chalk.dim("  Token saved. Run: voyagier auth status"));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Login failed: ${message}\n`));
        process.exit(1);
      }
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
      console.log("  Option 1: Browser login (recommended)\n");
      console.log(chalk.cyan("     voyagier auth login\n"));
      console.log("  Option 2: Personal Access Token\n");
      console.log("  1. Log in to voyagier.com");
      console.log("  2. Go to Settings → Personal Access Tokens");
      console.log("  3. Create a new token");
      console.log("  4. Run:\n");
      console.log(chalk.cyan("     voyagier auth set-token <your-token>\n"));
      console.log("  Option 3: Environment variables (CI/scripts)\n");
      console.log(chalk.dim("     export VOYAGIER_TOKEN=voy_pat_xxxxx"));
      console.log(chalk.dim("     export VOYAGIER_API_URL=https://voyagier.com  # optional\n"));
    });
}
