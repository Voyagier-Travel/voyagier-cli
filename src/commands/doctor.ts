/**
 * `voyagier doctor`.
 *
 * Single self-check command for agents/humans to verify the CLI environment
 * before doing real work. In 4.0 the CLI is a client of the Voyagier MCP
 * server, so the checks are about that connection:
 *
 *   1. auth         — credentials exist
 *   2. mcp          — `initialize` + `tools/list` succeed; tool count; the
 *                     local tool cache is refreshed (this is how the command
 *                     surface picks up new server tools)
 *   3. whoami       — the `whoami` tool, when the server publishes it,
 *                     confirms the token resolves to an identity
 *   4. state-files  — <CONFIG_DIR>/last-*.json are valid + not stale
 *   5. version      — CLI vs latest npm release (best-effort, soft-fail)
 *
 * Exit code: 0 if all PASS or WARN; 1 if any FAIL.
 *
 * Surface:
 *   voyagier doctor [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { gracefulExit } from "../exit.js";
import { CONFIG_DIR, credentialsExist } from "../config.js";
import { sanitizeExternalText } from "../utils.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import type { McpClient, McpToolDescriptor } from "../mcp-client/client.js";
import { createDefaultClient, parseToolContent } from "../mcp-client/generated-commands.js";
import { readToolsCache, toolsCacheAgeMs, TOOLS_CACHE_TTL_MS } from "../mcp-client/tools-cache.js";
import { refreshToolsCache } from "../mcp-client/startup.js";
import { getMcpUrl } from "../mcp-client/url.js";
import { unwrapToolPayload } from "../mcp-client/render.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  overall: CheckStatus;
}

/** Injectable collaborators (tests pass a client with a mocked fetch). */
export interface DoctorDeps {
  createClient?: () => McpClient;
  credentialsExist?: () => boolean;
  /** Used for the npm registry probe only. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * State directory under inspection. Override via env (`VOYAGIER_STATE_DIR`) for
 * doctor-specific tests; otherwise follows CONFIG_DIR (which itself honors
 * `VOYAGIER_CONFIG_DIR`). In normal use, this is `~/.voyagier/`.
 */
function stateDir(): string {
  return process.env.VOYAGIER_STATE_DIR ?? CONFIG_DIR;
}
const STATE_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Compute the overall status from individual checks.
 * FAIL > WARN > PASS.
 */
export function rollUpStatus(checks: DoctorCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  return "PASS";
}

function checkAuth(deps: DoctorDeps): DoctorCheck {
  const exists = (deps.credentialsExist ?? credentialsExist)();
  if (!exists) {
    return {
      name: "auth",
      status: "FAIL",
      message: "No credentials. Run: voyagier auth login (or: echo \"$VOYAGIER_PAT\" | voyagier auth set-token -)",
    };
  }
  return { name: "auth", status: "PASS", message: "Credentials present" };
}

function humanAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Initialize against the MCP server and list its tools. Refreshes the local
 * tool cache on success so the command surface matches the server.
 */
async function checkMcp(deps: DoctorDeps, url: string): Promise<{ check: DoctorCheck; tools: McpToolDescriptor[]; client: McpClient | null }> {
  const now = (deps.now ?? Date.now)();
  const previous = readToolsCache();
  const previousNote =
    previous && previous.url === url
      ? `cache was ${humanAge(toolsCacheAgeMs(previous, now))}${toolsCacheAgeMs(previous, now) >= TOOLS_CACHE_TTL_MS ? " (expired)" : ""}`
      : "no cache before this run";
  let client: McpClient;
  try {
    client = (deps.createClient ?? (() => createDefaultClient("0.0.0")))();
  } catch (err) {
    return {
      check: { name: "mcp", status: "FAIL", message: sanitizeExternalText(err instanceof Error ? err.message : String(err)) },
      tools: [],
      client: null,
    };
  }
  try {
    const cache = await refreshToolsCache(client, url, now);
    const server = cache.server?.name ? ` · server ${cache.server.name}${cache.server.version ? ` ${cache.server.version}` : ""}` : "";
    return {
      check: {
        name: "mcp",
        status: "PASS",
        message: `${url} · ${cache.tools.length} tools${server} · tool cache refreshed (${previousNote})`,
        details: { url, toolCount: cache.tools.length, tools: cache.tools.map((t) => t.name).sort() },
      },
      tools: cache.tools,
      client,
    };
  } catch (err) {
    const message = sanitizeExternalText(err instanceof Error ? err.message : String(err));
    if (err instanceof CliError && err.code === CliErrorCode.AUTH_FAILED) {
      return {
        check: { name: "mcp", status: "FAIL", message: `Token rejected by ${url}. Run: voyagier auth login` },
        tools: previous?.url === url ? previous.tools : [],
        client: null,
      };
    }
    if (err instanceof CliError && err.code === CliErrorCode.NETWORK) {
      return { check: { name: "mcp", status: "FAIL", message }, tools: previous?.url === url ? previous.tools : [], client: null };
    }
    return {
      check: { name: "mcp", status: "WARN", message: `MCP check could not complete: ${message}` },
      tools: previous?.url === url ? previous.tools : [],
      client: null,
    };
  }
}

/** Call `whoami` when the server has it; otherwise report the skip. */
async function checkWhoami(client: McpClient | null, tools: McpToolDescriptor[]): Promise<DoctorCheck> {
  if (!client) {
    return { name: "whoami", status: "WARN", message: "Identity check skipped (MCP connection failed)" };
  }
  if (!tools.some((t) => t.name === "whoami")) {
    return {
      name: "whoami",
      status: "PASS",
      message: "Identity check skipped: this server does not publish a whoami tool yet (auth was verified by tools/list)",
    };
  }
  try {
    const result = await client.toolsCall("whoami", {});
    const payload = unwrapToolPayload(parseToolContent(result));
    const rec = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const who =
      (typeof rec.email === "string" && rec.email) ||
      (typeof rec.name === "string" && rec.name) ||
      (typeof rec.username === "string" && rec.username) ||
      "unknown";
    const roles = ["isTravelAdvisor", "isTripPlanner", "isAdmin"].filter((k) => rec[k] === true).map((k) => k.replace(/^is/, "").toLowerCase());
    return {
      name: "whoami",
      status: "PASS",
      message: `Authenticated as ${sanitizeExternalText(String(who))}${roles.length ? ` (${roles.join(", ")})` : ""}`,
    };
  } catch (err) {
    const message = sanitizeExternalText(err instanceof Error ? err.message : String(err));
    if (err instanceof CliError && err.code === CliErrorCode.AUTH_FAILED) {
      return { name: "whoami", status: "FAIL", message: "Token rejected. Run: voyagier auth login" };
    }
    return { name: "whoami", status: "WARN", message: `whoami could not complete: ${message}` };
  }
}

/**
 * Verify state files: parseable JSON, not stale beyond 24h.
 */
function checkStateFiles(): DoctorCheck {
  const STATE_DIR = stateDir();
  if (!existsSync(STATE_DIR)) {
    return {
      name: "state-files",
      status: "PASS",
      message: "No state directory yet (clean install)",
    };
  }

  const files = readdirSync(STATE_DIR).filter((f) => f.startsWith("last-") && f.endsWith(".json"));
  if (files.length === 0) {
    return {
      name: "state-files",
      status: "PASS",
      message: "No cached state",
    };
  }

  const issues: string[] = [];
  const stale: string[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content) as { timestamp?: string | number };
      // Prefer the embedded `timestamp` written by the 3.x state layer (ISO
      // strings; older payloads may omit it). Fall back to mtime.
      let baseMs: number | null = null;
      if (typeof parsed.timestamp === "string") {
        const ms = new Date(parsed.timestamp).getTime();
        if (Number.isFinite(ms)) baseMs = ms;
      } else if (typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)) {
        baseMs = parsed.timestamp;
      }
      if (baseMs === null) baseMs = statSync(path).mtimeMs;
      const age = Date.now() - baseMs;
      if (age > STATE_STALE_MS) stale.push(f);
    } catch {
      issues.push(f);
    }
  }

  if (issues.length > 0) {
    return {
      name: "state-files",
      status: "WARN",
      message: `${issues.length} corrupt state file(s); consider clearing ~/.voyagier/`,
      details: { corrupt: issues },
    };
  }
  if (stale.length > 0) {
    return {
      name: "state-files",
      status: "WARN",
      message: `${stale.length} cached file(s) older than 24h`,
      details: { stale },
    };
  }
  return {
    name: "state-files",
    status: "PASS",
    message: `${files.length} cached file(s), all valid`,
  };
}

/**
 * Best-effort version check against npm registry.
 * WARN-only; never fails the report.
 */
async function checkVersion(currentVersion: string, fetchImpl: typeof fetch): Promise<DoctorCheck> {
  try {
    const res = await fetchImpl("https://registry.npmjs.org/@voyagier/cli/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        name: "version",
        status: "WARN",
        message: `Could not fetch latest version (registry returned ${res.status})`,
      };
    }
    const data = (await res.json()) as { version?: string };
    if (!data.version) {
      return {
        name: "version",
        status: "WARN",
        message: "Could not parse latest version from registry",
      };
    }
    const cmp = compareSemver(currentVersion, data.version);
    if (cmp === 0) {
      return {
        name: "version",
        status: "PASS",
        message: `Running latest (v${currentVersion})`,
      };
    }
    if (cmp > 0) {
      // Local build is ahead of npm latest — dev/prerelease build, not outdated.
      return {
        name: "version",
        status: "PASS",
        message: `Running v${currentVersion} (ahead of npm latest v${data.version} — likely a dev/prerelease build)`,
        details: { current: currentVersion, latest: data.version },
      };
    }
    return {
      name: "version",
      status: "WARN",
      message: `v${data.version} available; running v${currentVersion}. Update: npm i -g @voyagier/cli@latest`,
      details: { current: currentVersion, latest: data.version },
    };
  } catch (err) {
    return {
      name: "version",
      status: "WARN",
      message: `Version check skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Minimal semver comparator.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Pre-release segments (e.g. `2.0.0-next.0`) are *less than* their release counterpart
 * (`2.0.0`), per https://semver.org/#spec-item-11.
 * If either input fails to parse, returns 0 (treat as equal — no false positives).
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return null;
    return {
      core: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ? m[4].split(".") : [],
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  // Cores equal. A version with pre-release is < the same version without.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  // Compare pre-release segments per semver rules
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xn !== null) {
      return -1; // numeric < alpha per spec
    } else if (yn !== null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function statusIcon(s: CheckStatus): string {
  if (s === "PASS") return chalk.green("✓");
  if (s === "WARN") return chalk.yellow("⚠");
  return chalk.red("✗");
}

/** Run every check and roll them up. Exported for tests and for the MCP proxy. */
export async function runDoctor(currentVersion: string, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const auth = checkAuth(deps);
  let url: string | null = null;
  let urlError: DoctorCheck | null = null;
  try {
    url = getMcpUrl();
  } catch (err) {
    urlError = { name: "mcp", status: "FAIL", message: sanitizeExternalText(err instanceof Error ? err.message : String(err)) };
  }

  let mcp: DoctorCheck;
  let whoami: DoctorCheck;
  if (urlError) {
    mcp = urlError;
    whoami = { name: "whoami", status: "WARN", message: "Identity check skipped (MCP URL invalid)" };
  } else if (auth.status !== "PASS") {
    mcp = { name: "mcp", status: "WARN", message: `MCP check skipped (no credentials; endpoint ${url})` };
    whoami = { name: "whoami", status: "WARN", message: "Identity check skipped (no credentials)" };
  } else {
    const probe = await checkMcp(deps, url as string);
    mcp = probe.check;
    whoami = await checkWhoami(probe.client, probe.tools);
  }
  const stateFiles = checkStateFiles();
  const version = await checkVersion(currentVersion, deps.fetchImpl ?? fetch);

  const checks = [auth, mcp, whoami, stateFiles, version];
  return { checks, overall: rollUpStatus(checks) };
}

export function registerDoctorCommand(program: Command, currentVersion: string, deps: DoctorDeps = {}): void {
  program
    .command("doctor")
    .description("Self-check: credentials, MCP server connection + tool list, identity, state, version")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const effectiveDeps: DoctorDeps = {
        ...deps,
        createClient: deps.createClient ?? (() => createDefaultClient(currentVersion)),
      };
      const report = await runDoctor(currentVersion, effectiveDeps);
      const { checks, overall } = report;

      if (opts.json) {
        jsonOutput({ ok: overall !== "FAIL", data: report });
        if (overall === "FAIL") await gracefulExit(1);
        return;
      }

      console.log(chalk.bold("\nVoyagier CLI Doctor\n"));
      for (const c of checks) {
        console.log(`  ${statusIcon(c.status)} ${chalk.bold(c.name.padEnd(14))} ${c.message}`);
        if (c.details && (c.status === "FAIL" || c.status === "WARN")) {
          for (const [k, v] of Object.entries(c.details)) {
            if (Array.isArray(v)) {
              console.log(chalk.dim(`      ${k}:`));
              for (const entry of v) console.log(chalk.dim(`        - ${String(entry)}`));
            } else {
              console.log(chalk.dim(`      ${k}: ${String(v)}`));
            }
          }
        }
      }
      const summaryLabel =
        overall === "PASS" ? chalk.green("All checks passed.") :
        overall === "WARN" ? chalk.yellow("Some warnings.") :
        chalk.red("One or more checks failed.");
      console.log(`\n  ${summaryLabel}\n`);

      if (overall === "FAIL") await gracefulExit(1);
    });
}
