/**
 * `voyagier auth` — the Personal Access Token and nothing else.
 *
 * The CLI keeps one secret locally (the PAT). Everything about the account —
 * email, name, roles, home base — is read from the MCP server's `whoami` tool
 * on demand; traveller details (passport, frequent-flyer and hotel loyalty
 * numbers) live on the server and are edited on the web profile or through
 * the traveller tools the server publishes (`update_traveller`,
 * `add_traveller_document`). Nothing of that is cached on disk.
 *
 * Surface:
 *   voyagier auth login [--web-url <origin>]
 *   voyagier auth set-token <token|->
 *   voyagier auth status
 *   voyagier auth setup
 *   voyagier auth logout
 */
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { openBrowser, sanitizeExternalData, sanitizeExternalText } from "../utils.js";
import { saveCredentials, getToken, clearCredentials, credentialsExist } from "../config.js";
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";
import type { McpClient, McpToolDescriptor, McpToolResult } from "../mcp-client/client.js";
import { createDefaultClient, parseToolContent } from "../mcp-client/generated-commands.js";
import { getMcpUrl } from "../mcp-client/url.js";

/** The web app where tokens are minted and the profile is edited. */
export const DEFAULT_WEB_URL = "https://travel.voyagier.com";

/** Server tools that edit traveller details; named in `auth setup` when the live tool list has them. */
export const TRAVELLER_TOOL_NAMES: readonly string[] = ["update_traveller", "add_traveller_document"];

/** Injectable collaborators (tests pass a client with a scripted fetch). */
export interface AuthDeps {
  createClient?: () => McpClient;
  /** CLI version, sent as clientInfo.version on the remote handshake. */
  version?: string;
}

/** The fields of a `whoami` payload the CLI prints. Everything else is ignored. */
export interface Identity {
  email?: string;
  name?: string;
  roles: string[];
  role?: string;
  homeBase?: string;
  /** The token's audit label when the server reports it. */
  tokenName?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? sanitizeExternalText(value.trim()) : undefined;
}

/** Pick the identity fields out of a parsed `whoami` payload. Never throws. */
export function identityFromWhoami(payload: unknown): Identity {
  const rec = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const roles: string[] = [];
  if (rec.isTravelAdvisor === true) roles.push("travel advisor");
  if (rec.isTripPlanner === true) roles.push("trip planner");
  if (rec.isAdmin === true) roles.push("admin");

  const profile = rec.profile && typeof rec.profile === "object" ? (rec.profile as Record<string, unknown>) : {};
  const home = profile.homeLocation && typeof profile.homeLocation === "object" ? (profile.homeLocation as Record<string, unknown>) : {};
  const homeBase = [str(home.name), str(home.addressRegion), str(home.addressCountry)].filter((s): s is string => !!s).join(", ") || undefined;

  const token = rec.token && typeof rec.token === "object" ? (rec.token as Record<string, unknown>) : {};
  const tokenName = str(rec.tokenName) ?? str(token.name);

  const first = str(rec.firstName);
  const last = str(rec.lastName);
  const name = str(rec.name) ?? ([first, last].filter(Boolean).join(" ") || undefined);

  return { email: str(rec.email), name, roles, role: str(rec.role), homeBase, tokenName };
}

/** Human lines for an identity. Column-aligned for `auth status`. */
export function formatIdentity(id: Identity, webUrl: string = DEFAULT_WEB_URL): string[] {
  const who = id.name && id.email ? `${id.name} (${id.email})` : id.email ?? id.name ?? "unknown";
  const lines = [`  User:        ${chalk.green(who)}`];
  const roles = id.roles.length ? id.roles.join(", ") : "traveller";
  lines.push(`  Roles:       ${roles}${id.role ? chalk.dim(` · plans as ${id.role}`) : ""}`);
  lines.push(
    id.homeBase
      ? `  Home base:   ${id.homeBase}`
      : `  Home base:   ${chalk.dim(`not set — set it at ${webUrl}/me/settings`)}`,
  );
  lines.push(
    id.tokenName
      ? `  Audit label: ${id.tokenName}`
      : `  Audit label: ${chalk.dim(`the name you gave this token at ${webUrl}/me/settings/tokens (recorded on every call)`)}`,
  );
  return lines;
}

/**
 * The payload of a `whoami` result. Prefer `structuredContent` when the server
 * sends it (the text block may then be a human summary rather than JSON), and
 * fall back to the parsed text content otherwise. Same precedence as `runTool`.
 */
export function whoamiPayload(result: McpToolResult): unknown {
  return result.structuredContent !== undefined ? sanitizeExternalData(result.structuredContent) : parseToolContent(result);
}

/** Call `whoami` and parse it. Errors propagate as the client's CliErrors. */
export async function fetchIdentity(client: McpClient): Promise<Identity> {
  const result = await client.toolsCall("whoami", {});
  return identityFromWhoami(whoamiPayload(result));
}

/**
 * The one-line pointer that replaces the old local traveller profile: the
 * web profile, plus whichever traveller tools the live tool list publishes.
 */
export function travellerDataHint(tools: readonly McpToolDescriptor[] | null, webUrl: string = DEFAULT_WEB_URL): string {
  const names = tools ? TRAVELLER_TOOL_NAMES.filter((n) => tools.some((t) => t.name === n)) : [];
  const viaTools = names.length ? ` — or from here: ${names.map((n) => `voyagier ${n} --help`).join(" · ")}` : "";
  return `Traveller details (home base, passport, frequent-flyer and hotel loyalty numbers) live on your Voyagier profile: ${webUrl}/me/settings${viaTools}`;
}

/** Read all of stdin as UTF-8 (used by `set-token -`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function webOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(CliErrorCode.VALIDATION, `Invalid --web-url "${raw}". Expected an absolute https:// URL (e.g. ${DEFAULT_WEB_URL}).`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CliError(CliErrorCode.VALIDATION, `Invalid --web-url "${raw}". Only http(s) URLs are opened in the browser.`);
  }
  return parsed.origin;
}

export function registerAuthCommands(program: Command, deps: AuthDeps = {}): void {
  const auth = program.command("auth").description("Manage authentication");
  const makeClient = (): McpClient => (deps.createClient ?? (() => createDefaultClient(deps.version ?? "0.0.0")))();

  auth
    .command("set-token <token>")
    .description("Save a personal access token (use '-' to read the token from stdin, keeping it out of shell history)")
    .action(async (token: string) => {
      // M4: `set-token -` reads the token from stdin (trimmed) so scripts can
      // pipe it in without it landing in argv (shell history / `ps`).
      let tokenValue = token;
      if (token === "-") {
        tokenValue = (await readStdin()).trim();
        if (!tokenValue) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            'No token received on stdin.\n  Pipe a token: echo "$VOYAGIER_PAT" | voyagier auth set-token -',
          );
        }
      }
      saveCredentials(tokenValue);
      console.log(chalk.green("✓ Token saved."));
      console.log(chalk.dim("  Next: voyagier auth status"));
    });

  auth
    .command("status")
    .description("Check authentication status and identity (via the MCP whoami tool)")
    .action(async () => {
      if (!credentialsExist()) {
        console.log(chalk.red(authFailedMessage("Not authenticated.")));
        return;
      }

      const token = getToken();
      const masked = token.length > 12 ? token.slice(0, 8) + "••••" + token.slice(-4) : "••••";

      console.log(chalk.bold("\nVoyagier CLI Status\n"));
      console.log(`  Token:       ${chalk.dim(masked)}`);

      let url: string;
      try {
        url = getMcpUrl();
      } catch (err) {
        console.log(`\n  ${chalk.red("✗")} MCP URL: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }
      console.log(`  MCP URL:     ${chalk.dim(url)}`);

      try {
        const identity = await fetchIdentity(makeClient());
        console.log();
        for (const line of formatIdentity(identity)) console.log(line);
        console.log(`\n  ${chalk.green("✓")} MCP: connected\n`);
      } catch (err) {
        if (err instanceof CliError && err.code === CliErrorCode.AUTH_FAILED) {
          console.log(`\n  ${chalk.red("✗")} MCP: token rejected by ${url}. Run: voyagier auth login\n`);
        } else {
          const message = sanitizeExternalText(err instanceof Error ? err.message : String(err));
          console.log(`\n  ${chalk.red("✗")} MCP: ${message}\n`);
        }
      }
    });

  auth
    .command("login")
    .description("Log in to Voyagier")
    .option("--web-url <origin>", "Voyagier web app where tokens are minted", DEFAULT_WEB_URL)
    .action(async (opts) => {
      const webUrl = webOrigin(opts.webUrl as string);
      const settingsUrl = `${webUrl}/me/settings/tokens`;
      const isInteractive = process.stdin.isTTY === true && !process.env.CI;

      console.log(chalk.bold("\nVoyagier CLI Login\n"));

      if (!isInteractive) {
        // Non-interactive: just show instructions
        console.log("  Generate a Personal Access Token at:\n");
        console.log(chalk.cyan(`    ${settingsUrl}\n`));
        console.log(chalk.dim("  Name the token for this machine (e.g. cli-laptop): that name is the audit label on every call it makes.\n"));
        console.log("  Then run:\n");
        console.log(chalk.cyan('    echo "$VOYAGIER_PAT" | voyagier auth set-token -\n'));
        return;
      }

      // Interactive: open browser + prompt for token
      console.log(`  1. Go to ${chalk.cyan(settingsUrl)}`);
      console.log(`  2. Generate a Personal Access Token ${chalk.dim("(name it for this machine, e.g. cli-laptop — that name is its audit label)")}`);
      console.log(`  3. Paste it below\n`);
      openBrowser(settingsUrl);

      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const token = (await rl.question(chalk.bold("  Token: "))).trim();
        if (!token) {
          console.log(chalk.dim("\n  Cancelled.\n"));
          return;
        }

        saveCredentials(token);

        try {
          const identity = await fetchIdentity(makeClient());
          const who = identity.name ?? identity.email ?? "you";
          console.log(chalk.green(`\n  ✓ Logged in as ${chalk.bold(who)}${identity.email && identity.name ? ` (${identity.email})` : ""}\n`));
          for (const line of formatIdentity(identity, webUrl)) console.log(line);
          console.log(chalk.dim(`\n  Ready! Try: voyagier doctor · voyagier agent-docs · voyagier whoami --json\n`));
        } catch {
          console.log(chalk.green("\n  ✓ Token saved.\n"));
          console.log(chalk.yellow("  ⚠ Could not verify — token may be invalid. Check: voyagier auth status\n"));
        }
      } finally {
        rl.close();
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
    .description("Where traveller details are managed (the CLI keeps only your token)")
    .action(async () => {
      let tools: McpToolDescriptor[] | null = null;
      if (credentialsExist()) {
        try {
          tools = await makeClient().toolsList();
        } catch {
          tools = null;
        }
      }
      console.log(travellerDataHint(tools));
    });
}
