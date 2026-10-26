/**
 * `voyagier update` (alias `upgrade`).
 *
 * Brings a globally installed CLI to the latest npm release. The command
 * works out how this binary was installed from the path of the running dist
 * file and acts accordingly:
 *
 *   - npx      — `/_npx/` in the path: zero-install runs are always current,
 *                nothing to do (exit 0).
 *   - global   — inside a real (non-symlinked) node_modules package dir: run
 *                `npm install -g @voyagier/cli@latest` with the npm that
 *                belongs to the running node, then verify the installed
 *                package.json reports the latest version.
 *   - source   — anything else (git checkout, `npm link`): refuse and point
 *                at `git pull && npm run build` (exit 1).
 *
 * Surface:
 *   voyagier update [--check] [--json]
 *
 * `--check` reports current/latest without installing: exit 0 when current
 * is at or ahead of latest, exit 1 when outdated (for scripts and agents).
 * `--json` writes exactly one JSON document to stdout and nothing to stderr
 * (npm's own stderr is inherited during an install).
 */
import { Command } from "commander";
import chalk from "chalk";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gracefulExit } from "../exit.js";
import { CliErrorCode } from "../errors.js";
import { compareSemver } from "./doctor.js";

export const PACKAGE_NAME = "@voyagier/cli";
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5000;
/** Lines of npm output surfaced when an install fails for a reason other than EACCES. */
const NPM_OUTPUT_TAIL_LINES = 20;

export type UpdateMode = "global" | "npx" | "source";
export type NpmSource = "prefix" | "execPath" | "PATH";

/** Minimal child-process shape the command needs (tests pass an EventEmitter-based fake). */
export type SpawnedChild = Pick<ChildProcess, "on" | "stdout" | "stderr">;
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { stdio: ["ignore", "pipe", "inherit"]; env: NodeJS.ProcessEnv },
) => SpawnedChild;

/** Injectable collaborators (tests script the registry and the npm child). */
export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnImpl;
  /** The node binary running this CLI (default: process.execPath). */
  execPath?: string;
  /** Resolved path of the running dist file (default: this module's own path). */
  modulePath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface UpdateOptions {
  check?: boolean;
  json?: boolean;
}

export interface UpdateResult {
  ok: boolean;
  mode: UpdateMode;
  current: string;
  latest: string | null;
  updated: boolean;
  prefix?: string;
  npmSource?: NpmSource;
  checkedAt: string;
  error?: { code: CliErrorCode; message: string };
  /** Process exit code for this outcome (not part of the JSON document). */
  exitCode: number;
  /** Human-readable lines (not part of the JSON document). */
  lines: string[];
}

export const NPX_MESSAGE = `Zero-install runs always use the latest version: npx ${PACKAGE_NAME}@latest`;
export const SOURCE_MESSAGE = "This CLI runs from a source checkout; update it with: git pull && npm run build";
export const EACCES_MESSAGE =
  "Permission denied writing to the npm global prefix. Re-run with sudo, or point npm at a user-writable prefix (npm config set prefix ~/.npm-global)";

/** The `@voyagier/cli` package directory that contains `modulePath`, or null when it is not under node_modules. */
export function packageDirFromModulePath(modulePath: string): string | null {
  const parts = modulePath.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 2; i--) {
    if (parts[i - 2] === "node_modules" && parts[i - 1] === "@voyagier" && parts[i] === "cli") {
      return parts.slice(0, i + 1).join(sep);
    }
  }
  return null;
}

/** Classify how the running binary was installed. */
export function detectInstallMode(modulePath: string): { mode: UpdateMode; packageDir: string | null } {
  if (modulePath.includes("/_npx/") || modulePath.includes("\\_npx\\")) return { mode: "npx", packageDir: null };
  const packageDir = packageDirFromModulePath(modulePath);
  if (!packageDir) return { mode: "source", packageDir: null };
  try {
    if (lstatSync(packageDir).isSymbolicLink()) return { mode: "source", packageDir };
  } catch {
    return { mode: "source", packageDir };
  }
  return { mode: "global", packageDir };
}

/** The global prefix npm installed into: `<prefix>/lib/node_modules/@voyagier/cli` or `<prefix>/node_modules/@voyagier/cli` (win32). */
function prefixFromPackageDir(packageDir: string): string {
  const nodeModules = dirname(dirname(packageDir));
  return basename(dirname(nodeModules)) === "lib" ? dirname(dirname(nodeModules)) : dirname(nodeModules);
}

/**
 * The npm to run the install with. Preference order:
 *   1. `<prefix>/bin/npm` — the npm that owns the prefix this CLI is installed
 *      in. `#!/usr/bin/env node` means the running node may belong to a
 *      different install (two node toolchains on PATH), so the running node's
 *      npm is not a safe guess.
 *   2. the npm next to the running node (`process.execPath`).
 *   3. `npm` on PATH.
 * Whichever is chosen, the install is pinned to the prefix with `--prefix`.
 */
export function resolveNpm(
  execPath: string,
  prefix: string | null = null,
  platform: NodeJS.Platform = process.platform,
): { npm: string; npmSource: NpmSource } {
  const npmName = platform === "win32" ? "npm.cmd" : "npm";
  if (prefix) {
    const own = platform === "win32" ? join(prefix, npmName) : join(prefix, "bin", npmName);
    if (existsSync(own)) return { npm: own, npmSource: "prefix" };
  }
  const sibling = join(dirname(execPath), npmName);
  if (existsSync(sibling)) return { npm: sibling, npmSource: "execPath" };
  return { npm: npmName, npmSource: "PATH" };
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<{ latest: string } | { error: string }> {
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return { error: `Could not fetch the latest version (registry returned ${res.status})` };
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== "string" || !data.version) return { error: "Could not parse the latest version from the registry" };
    return { latest: data.version };
  } catch (err) {
    return { error: `Could not reach the npm registry: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The exact npm argv used for the install; exported so specs and docs pin it. */
export function npmInstallArgs(prefix: string): string[] {
  return ["install", "-g", "--prefix", prefix, `${PACKAGE_NAME}@latest`];
}

function runNpmInstall(spawnImpl: SpawnImpl, npm: string, prefix: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let settled = false;
    const done = (code: number, extra?: string) => {
      if (settled) return;
      settled = true;
      if (extra) chunks.push(extra);
      resolve({ code, output: chunks.join("") });
    };
    let child: SpawnedChild;
    try {
      child = spawnImpl(npm, npmInstallArgs(prefix), { stdio: ["ignore", "pipe", "inherit"], env });
    } catch (err) {
      done(-1, err instanceof Error ? err.message : String(err));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
    child.on("error", (err: Error) => done(-1, err.message));
    child.on("close", (code: number | null) => done(code ?? -1));
  });
}

function readInstalledVersion(packageDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function tail(text: string, n: number): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
}

/**
 * Pure core: resolve mode, compare with the registry and (unless --check or
 * already current) run the install. Never writes output or exits; the
 * registered command turns the result into text/JSON and an exit code.
 */
export async function runUpdate(currentVersion: string, opts: UpdateOptions = {}, deps: UpdateDeps = {}): Promise<UpdateResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  const execPath = deps.execPath ?? process.execPath;
  const modulePath = deps.modulePath ?? fileURLToPath(import.meta.url);
  const env = deps.env ?? process.env;
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();

  const { mode, packageDir } = detectInstallMode(modulePath);
  const base = { mode, current: currentVersion, latest: null as string | null, updated: false, checkedAt };
  const fail = (code: CliErrorCode, message: string, extra: Partial<UpdateResult> = {}): UpdateResult => ({
    ...base,
    ...extra,
    ok: false,
    error: { code, message },
    exitCode: 1,
    lines: [message],
  });

  if (mode === "npx") {
    return { ...base, ok: true, exitCode: 0, lines: [NPX_MESSAGE] };
  }

  const registry = await fetchLatest(fetchImpl);
  if ("error" in registry) return fail(CliErrorCode.NETWORK, registry.error);
  const latest = registry.latest;
  const outdated = compareSemver(currentVersion, latest) < 0;
  const withLatest = { ...base, latest };

  if (opts.check) {
    const line = outdated
      ? `v${latest} available; running v${currentVersion}. Run: voyagier update`
      : `Already on the latest version (v${currentVersion}${compareSemver(currentVersion, latest) > 0 ? `, ahead of npm latest v${latest}` : ""})`;
    // `ok` mirrors the exit code (as doctor does): false means an update is available.
    return { ...withLatest, ok: !outdated, exitCode: outdated ? 1 : 0, lines: [line] };
  }

  if (mode === "source") {
    return fail(CliErrorCode.VALIDATION, SOURCE_MESSAGE, { latest });
  }

  // mode === "global"
  const prefix = prefixFromPackageDir(packageDir as string);
  const { npm, npmSource } = resolveNpm(execPath, prefix);
  const withInstall = { ...withLatest, prefix, npmSource };

  if (!outdated) {
    return { ...withInstall, ok: true, exitCode: 0, lines: [`Already on the latest version (v${currentVersion})`] };
  }

  const install = await runNpmInstall(spawnImpl, npm, prefix, env);
  if (install.code !== 0) {
    if (/EACCES/.test(install.output)) return fail(CliErrorCode.PERMISSION_DENIED, EACCES_MESSAGE, withInstall);
    const detail = tail(install.output, NPM_OUTPUT_TAIL_LINES);
    return fail(CliErrorCode.API_ERROR, `npm install -g ${PACKAGE_NAME}@latest exited with code ${install.code}${detail ? `\n${detail}` : ""}`, withInstall);
  }

  const installed = readInstalledVersion(packageDir as string);
  if (installed !== latest) {
    return fail(
      CliErrorCode.API_ERROR,
      `Installed v${latest} at ${prefix} but the running binary resolves to ${modulePath}; two npm prefixes may be in PATH`,
      withInstall,
    );
  }

  const lines = [`Updated ${PACKAGE_NAME} v${currentVersion} → v${latest} (${prefix})`];
  if (npmSource === "PATH") lines.push(`Used npm from PATH (no npm under ${prefix} or next to ${execPath})`);
  return { ...withInstall, ok: true, updated: true, exitCode: 0, lines };
}

/** Strip the fields that are not part of the --json contract. */
export function toJsonDocument(result: UpdateResult): Record<string, unknown> {
  const { exitCode: _exitCode, lines: _lines, ...doc } = result;
  return doc;
}

export function registerUpdateCommand(program: Command, currentVersion: string, deps: UpdateDeps = {}): void {
  program
    .command("update")
    .alias("upgrade")
    .description(`Update a global npm install of ${PACKAGE_NAME} to the latest release`)
    .option("--check", "Report current/latest without installing (exit 1 when outdated)")
    .option("--json", "Output raw JSON")
    .action(async (opts: UpdateOptions) => {
      const result = await runUpdate(currentVersion, opts, deps);
      if (opts.json) {
        process.stdout.write(JSON.stringify(toJsonDocument(result), null, 2) + "\n");
        await gracefulExit(result.exitCode);
        return;
      }
      const text = result.lines.join("\n") + "\n";
      if (result.ok) {
        process.stdout.write(result.updated ? chalk.green(text) : text);
      } else {
        process.stderr.write(chalk.red(text));
      }
      await gracefulExit(result.exitCode);
    });
}
