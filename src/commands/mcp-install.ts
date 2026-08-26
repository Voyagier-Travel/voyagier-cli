/**
 * `voyagier mcp install <client>` — wire an AI client to the remote Voyagier
 * MCP server in one step (VOY-2043).
 *
 * Voyagier runs a hosted MCP server at https://mcp.voyagier.com/api/mcp
 * (streamable HTTP, Personal Access Token as a Bearer header). Pointing a
 * client at it is otherwise a hand-edited JSON exercise, and every client
 * keeps its config in a different place with a slightly different entry shape.
 * This command resolves the path, merges the `voyagier` entry into whatever is
 * already there, and leaves every other server untouched.
 *
 * Design constraints:
 *   - READ-MERGE-WRITE. The config files below belong to the user and usually
 *     hold other servers. We parse, set exactly one key under `mcpServers`,
 *     and re-serialize. An unparseable existing file aborts the run — never
 *     overwrite something we could not read.
 *   - The token is written INTO the config file (that is the point) but is
 *     never printed. Every stdout/stderr rendering goes through maskToken().
 *   - Path resolution is a pure function of an injected environment
 *     (home/cwd/platform), so specs can point it at a temp dir.
 *
 * Surface:
 *   voyagier mcp install <claude-code|cursor|claude-desktop>
 *     [--global] [--project] [--token <pat>] [--dry-run] [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { getToken } from "../config.js";
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";
import { jsonOutput } from "../output.js";

/** The hosted MCP endpoint every HTTP-capable client is pointed at. */
export const MCP_ENDPOINT = "https://mcp.voyagier.com/api/mcp";

/** The key our entry occupies under `mcpServers`. */
export const SERVER_KEY = "voyagier";

export type ClientId = "claude-code" | "cursor" | "claude-desktop";
export type Scope = "project" | "global";

export const CLIENT_IDS: readonly ClientId[] = ["claude-code", "cursor", "claude-desktop"] as const;

const CLIENT_LABELS: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
};

/**
 * Where the command reads its notion of "the machine" from. Injected rather
 * than read inline so specs can resolve paths inside a temp dir, including the
 * per-platform Claude Desktop locations, on any host OS.
 */
export interface InstallEnv {
  home: string;
  cwd: string;
  platform: string;
  /** `%APPDATA%` on Windows; ignored elsewhere. */
  appData?: string;
}

export function currentInstallEnv(): InstallEnv {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    appData: process.env.APPDATA,
  };
}

/** The scope used when the caller passes neither --global nor --project. */
export function defaultScope(client: ClientId): Scope {
  // Claude Code's own default is the project file; Cursor's is the user file.
  return client === "claude-code" ? "project" : "global";
}

export function parseClientId(raw: string): ClientId {
  const value = raw.trim().toLowerCase();
  if ((CLIENT_IDS as readonly string[]).includes(value)) return value as ClientId;
  throw new CliError(
    CliErrorCode.VALIDATION,
    `Unknown client "${raw}".\n  Supported: ${CLIENT_IDS.join(", ")}`,
  );
}

/**
 * Resolve the scope from the flags, rejecting combinations a client cannot
 * honor. Claude Desktop reads exactly one config file, so a project scope
 * would be a silent no-op — say so instead.
 */
export function resolveScope(
  client: ClientId,
  opts: { global?: boolean; project?: boolean },
): Scope {
  if (opts.global && opts.project) {
    throw new CliError(CliErrorCode.VALIDATION, "Pass either --global or --project, not both.");
  }
  if (client === "claude-desktop" && opts.project) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "Claude Desktop reads a single user-level config file; --project does not apply. Re-run without it.",
    );
  }
  if (opts.global) return "global";
  if (opts.project) return "project";
  return defaultScope(client);
}

/** Absolute path of the config file for a client + scope. Pure. */
export function resolveConfigPath(client: ClientId, scope: Scope, env: InstallEnv): string {
  if (client === "claude-code") {
    return scope === "project" ? join(env.cwd, ".mcp.json") : join(env.home, ".claude.json");
  }
  if (client === "cursor") {
    return scope === "project"
      ? join(env.cwd, ".cursor", "mcp.json")
      : join(env.home, ".cursor", "mcp.json");
  }
  // claude-desktop — one user-level file, location varies by platform.
  const file = "claude_desktop_config.json";
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "Claude", file);
  }
  if (env.platform === "win32") {
    const appData = env.appData ?? join(env.home, "AppData", "Roaming");
    return join(appData, "Claude", file);
  }
  return join(env.home, ".config", "Claude", file);
}

export type ServerEntry = Record<string, unknown>;

/**
 * The `mcpServers.voyagier` value for a client.
 *
 * Claude Code and Cursor both speak streamable HTTP and get the remote
 * endpoint directly; Claude Code labels the transport with `type`, Cursor
 * infers it from the presence of `url`. Claude Desktop's config format only
 * describes stdio servers, so it gets the local CLI bridge with the token in
 * the environment instead.
 */
export function buildServerEntry(client: ClientId, token: string): ServerEntry {
  if (client === "claude-desktop") {
    return {
      command: "npx",
      args: ["-y", "@voyagier/cli", "mcp"],
      env: { VOYAGIER_TOKEN: token },
    };
  }
  const http: ServerEntry = {
    url: MCP_ENDPOINT,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (client === "claude-code") return { type: "http", ...http };
  return http;
}

/**
 * Display form of a token: enough to recognize which credential was used,
 * never enough to use it. The full value only ever reaches the config file.
 */
export function maskToken(token: string): string {
  if (token.length <= 8) return "…";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MergeResult {
  config: Record<string, unknown>;
  /** True when a `voyagier` entry was already present and got overwritten. */
  replaced: boolean;
}

/**
 * Merge our entry into an existing config document.
 *
 * `raw` is the file's current contents, or null when the file does not exist.
 * Everything outside `mcpServers.voyagier` is carried across untouched. A file
 * we cannot parse (or whose shape we do not recognize) aborts with
 * STATE_CORRUPT rather than being replaced — it may hold the user's only copy
 * of a config we did not write.
 */
export function mergeServerEntry(
  raw: string | null,
  entry: ServerEntry,
  path: string,
): MergeResult {
  let config: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CliError(
        CliErrorCode.STATE_CORRUPT,
        `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n` +
          `  Nothing was written. Fix or move the file, then re-run.`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new CliError(
        CliErrorCode.STATE_CORRUPT,
        `${path} does not contain a JSON object at the top level.\n` +
          `  Nothing was written. Fix or move the file, then re-run.`,
      );
    }
    config = parsed;
  }

  const existingServers = config.mcpServers;
  if (existingServers !== undefined && !isPlainObject(existingServers)) {
    throw new CliError(
      CliErrorCode.STATE_CORRUPT,
      `${path} has an "mcpServers" key that is not a JSON object.\n` +
        `  Nothing was written. Fix or move the file, then re-run.`,
    );
  }

  const servers: Record<string, unknown> = { ...(existingServers ?? {}) };
  const replaced = Object.prototype.hasOwnProperty.call(servers, SERVER_KEY);
  servers[SERVER_KEY] = entry;
  return { config: { ...config, mcpServers: servers }, replaced };
}

/**
 * Indentation of an existing document, so a merge does not reformat the whole
 * file. Files we create get two spaces; a document that carries no
 * indentation at all (`~/.claude.json` is normally one long compact line, and
 * can be large) stays compact, i.e. indent 0.
 */
export function detectIndent(raw: string | null): string | number {
  if (!raw || raw.trim() === "") return 2;
  const match = raw.match(/\n([ \t]+)\S/);
  return match ? match[1] : 0;
}

export interface InstallPlan {
  client: ClientId;
  scope: Scope;
  path: string;
  /** Entry with the real token — written to disk, never rendered. */
  entry: ServerEntry;
  /** Entry with the token masked — safe for stdout. */
  maskedEntry: ServerEntry;
  config: Record<string, unknown>;
  indent: string | number;
  fileExists: boolean;
  replaced: boolean;
}

/** Everything up to (but excluding) the write. Pure apart from reading the file. */
export function planInstall(
  client: ClientId,
  scope: Scope,
  token: string,
  env: InstallEnv,
): InstallPlan {
  const path = resolveConfigPath(client, scope, env);
  const fileExists = existsSync(path);
  const raw = fileExists ? readFileSync(path, "utf-8") : null;
  const entry = buildServerEntry(client, token);
  const { config, replaced } = mergeServerEntry(raw, entry, path);
  return {
    client,
    scope,
    path,
    entry,
    maskedEntry: buildServerEntry(client, maskToken(token)),
    config,
    indent: detectIndent(raw),
    fileExists,
    replaced,
  };
}

/**
 * Persist the merged document. New files are created 0600 because they hold a
 * Personal Access Token; a pre-existing file keeps whatever mode the user gave
 * it (we are a guest in someone else's config).
 */
export function writeInstallPlan(plan: InstallPlan): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  const body = JSON.stringify(plan.config, null, plan.indent) + "\n";
  if (plan.fileExists) {
    writeFileSync(plan.path, body);
  } else {
    writeFileSync(plan.path, body, { mode: 0o600 });
  }
}

/** Resolve the token to write: --token wins, otherwise the stored credential. */
export function resolveToken(explicit?: string): string {
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    if (trimmed === "") {
      throw new CliError(CliErrorCode.VALIDATION, "--token was empty. Pass the token value.");
    }
    return trimmed;
  }
  try {
    return getToken();
  } catch {
    throw new CliError(
      CliErrorCode.AUTH_FAILED,
      authFailedMessage("No access token available to write into the client config."),
    );
  }
}

/**
 * Extra guidance printed alongside the result, per client. Claude Desktop's
 * config format cannot express the remote endpoint, so point at the in-app
 * route that can.
 */
export function clientNotes(client: ClientId, scope: Scope): string[] {
  const notes: string[] = [];
  if (client === "claude-desktop") {
    notes.push(
      "Claude Desktop can also reach Voyagier through a remote connector in the app's settings, which uses the hosted endpoint directly.",
    );
  }
  if (scope === "project") {
    notes.push("This file holds your access token — keep it out of version control.");
  }
  return notes;
}

/**
 * @param envProvider overrides how the machine is discovered (home, cwd,
 * platform). Production passes nothing and gets the real environment; specs
 * pass a provider rooted in a temp dir so no test can touch a real client
 * config.
 */
export function registerMcpInstallCommand(
  mcp: Command,
  envProvider: () => InstallEnv = currentInstallEnv,
): void {
  mcp
    .command("install")
    .argument("<client>", `client to configure: ${CLIENT_IDS.join(" | ")}`)
    .description("Configure an AI client to use the hosted Voyagier MCP server")
    .option("--global", "write the user-level config")
    .option("--project", "write the project-level config")
    .option("--token <pat>", "token to write (defaults to the stored credential)")
    .option("--dry-run", "show the path and entry without writing")
    .option("--json", "Output raw JSON")
    .addHelpText(
      "after",
      `
Defaults:
  claude-code     --project  → ./.mcp.json            (--global → ~/.claude.json)
  cursor          --global   → ~/.cursor/mcp.json     (--project → ./.cursor/mcp.json)
  claude-desktop  --global   → claude_desktop_config.json

Existing servers in the file are preserved; only the "${SERVER_KEY}" entry is added or updated.`,
    )
    .action(
      async (
        clientArg: string,
        opts: {
          global?: boolean;
          project?: boolean;
          token?: string;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        const client = parseClientId(clientArg);
        const scope = resolveScope(client, opts);
        const token = resolveToken(opts.token);
        const plan = planInstall(client, scope, token, envProvider());
        const dryRun = opts.dryRun === true;

        if (!dryRun) writeInstallPlan(plan);

        const label = CLIENT_LABELS[client];
        const restart = `Restart ${label} to pick up the change.`;
        const notes = clientNotes(client, scope);

        if (opts.json) {
          jsonOutput({
            ok: true,
            data: {
              client,
              scope,
              path: plan.path,
              serverKey: SERVER_KEY,
              entry: plan.maskedEntry,
              token: maskToken(token),
              action: dryRun ? "none" : plan.replaced ? "updated" : "added",
              dryRun,
              restart,
              notes,
            },
          });
          return;
        }

        // The masked entry is the ONLY entry that reaches stdout.
        const fragment = JSON.stringify({ mcpServers: { [SERVER_KEY]: plan.maskedEntry } }, null, 2);

        if (dryRun) {
          console.log(chalk.bold("\nDry run — nothing written.\n"));
          console.log(`  file:  ${plan.path}`);
          console.log(`  token: ${chalk.dim(maskToken(token))}`);
          console.log(`  entry:`);
          for (const line of fragment.split("\n")) console.log(chalk.dim(`    ${line}`));
          for (const note of notes) console.log(`\n  ${chalk.dim(note)}`);
          console.log();
          return;
        }

        const verb = plan.replaced ? "Updated" : "Added";
        console.log(
          `\n${chalk.green("✓")} ${verb} the "${SERVER_KEY}" MCP server in ${chalk.bold(plan.path)}`,
        );
        console.log(`  token: ${chalk.dim(maskToken(token))}`);
        for (const note of notes) console.log(`  ${chalk.dim(note)}`);
        console.log(`\n  ${restart}\n`);
      },
    );
}
