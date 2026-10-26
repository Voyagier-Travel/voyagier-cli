/**
 * `voyagier update` (alias `upgrade`).
 *
 * Brings a globally installed CLI to the latest npm release. The command
 * works out how this binary was installed from the path of the running dist
 * file and acts accordingly:
 *
 *   - npx      — `/_npx/` in the path: zero-install runs are always current,
 *                nothing to do (exit 0).
 *   - global   — inside a real (non-symlinked) node_modules package dir. Two
 *                layouts exist: `npm install -g @voyagier/cli` (the package
 *                sits directly under the prefix) and the documented alias
 *                `npm install -g voyagier` (this package is nested under
 *                `voyagier/node_modules`). The alias pins the matching
 *                @voyagier/cli release, so updating the OUTER package is what
 *                moves the code the alias `bin.js` loads. Runs npm's JS entry
 *                through node (no shell, no `.cmd`, same on every OS), pinned
 *                to the prefix the binary lives in with `--prefix`, then
 *                verifies the package.json this process was loaded from.
 *   - local    — a project's `node_modules` (`npm install @voyagier/cli` then
 *                `npx voyagier update`): refuse before touching npm and point
 *                at `npm install @voyagier/cli@latest` in that project (exit 1).
 *   - source   — anything else (git checkout, `npm link`): refuse and point
 *                at `git pull && npm run build` (exit 1).
 *
 * Surface:
 *   voyagier update [--check] [--json]
 *
 * `--check` reports current/latest without installing: exit 0 when current
 * is at or ahead of latest, exit 1 when outdated (for scripts and agents).
 * `--json` writes exactly one JSON document to stdout and nothing to stderr;
 * npm's own output is captured (and relayed to stderr only in text mode).
 */
import { Command } from "commander";
import chalk from "chalk";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gracefulExit } from "../exit.js";
import { CliErrorCode } from "../errors.js";
import { compareSemver } from "./doctor.js";

export const PACKAGE_NAME = "@voyagier/cli";
/** The convenience alias package (`npm install -g voyagier`); depends on the matching @voyagier/cli. */
export const ALIAS_PACKAGE_NAME = "voyagier";
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5000;
/** Lines of npm output surfaced when an install fails for a reason other than EACCES. */
const NPM_OUTPUT_TAIL_LINES = 20;

export type UpdateMode = "global" | "npx" | "local" | "source";
export type NpmSource = "prefix" | "execPath" | "PATH";
export type InstalledPackage = typeof PACKAGE_NAME | typeof ALIAS_PACKAGE_NAME;

/** Minimal child-process shape the command needs (tests pass an EventEmitter-based fake). */
export type SpawnedChild = Pick<ChildProcess, "on" | "stdout" | "stderr">;
export interface SpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  /** Only set on Windows when npm's JS entry cannot be found and `npm.cmd` must go through cmd.exe. */
  shell?: boolean;
}
export type SpawnImpl = (cmd: string, args: string[], opts: SpawnOptions) => SpawnedChild;

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
  platform?: NodeJS.Platform;
  /** Receives npm's stderr as it arrives (text mode only; never set under --json). */
  onNpmStderr?: (chunk: string) => void;
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
  /** Which global package the install targets: the alias when the binary was loaded through it. */
  package?: InstalledPackage;
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
export function localMessage(projectDir: string): string {
  return `This CLI is installed in a project at ${projectDir}, not globally; update it there with: npm install ${PACKAGE_NAME}@latest`;
}
export function eaccesMessage(prefix: string): string {
  return (
    `Permission denied writing to ${prefix}. Re-run with sudo, or install a copy you own: ` +
    `npm install -g --prefix ~/.npm-global ${PACKAGE_NAME} and put ~/.npm-global/bin first on PATH`
  );
}

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

export interface InstallInfo {
  mode: UpdateMode;
  /** For `local`: the project directory that owns the node_modules. */
  projectDir?: string;
  /** The @voyagier/cli dir this process was loaded from (what gets verified after an install). */
  packageDir: string | null;
  /** The package npm installed at the prefix: @voyagier/cli itself, or the alias that depends on it. */
  package: InstalledPackage | null;
  /** That package's directory (what the prefix is derived from). */
  ownerDir: string | null;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true; // unreadable → treat as not a clean global install
  }
}

/** The `node_modules` directory that directly holds `ownerDir` (scoped or not). */
function nodeModulesOf(ownerDir: string): string | null {
  let dir = ownerDir;
  while (basename(dir) !== "node_modules") {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return dir;
}

/**
 * A global prefix has no package.json beside its node_modules, and on POSIX
 * npm always lays it out as `<prefix>/lib/node_modules`. Anything else is a
 * project's dependency tree, which `npm install -g --prefix` would not touch.
 */
function isProjectLocal(ownerDir: string, platform: NodeJS.Platform): { local: boolean; projectDir: string } {
  const nodeModules = nodeModulesOf(ownerDir);
  const above = nodeModules ? dirname(nodeModules) : dirname(ownerDir);
  if (existsSync(join(above, "package.json"))) return { local: true, projectDir: above };
  if (platform !== "win32" && basename(above) !== "lib") return { local: true, projectDir: above };
  return { local: false, projectDir: above };
}

/** Classify how the running binary was installed. */
export function detectInstallMode(modulePath: string, platform: NodeJS.Platform = process.platform): InstallInfo {
  const none = { packageDir: null, package: null, ownerDir: null };
  if (modulePath.includes("/_npx/") || modulePath.includes("\\_npx\\")) return { mode: "npx", ...none };
  const packageDir = packageDirFromModulePath(modulePath);
  if (!packageDir) return { mode: "source", ...none };
  if (isSymlink(packageDir)) return { mode: "source", packageDir, package: null, ownerDir: null };

  // Alias layout: <prefix>/lib/node_modules/voyagier/node_modules/@voyagier/cli
  const nodeModules = dirname(dirname(packageDir));
  const maybeAlias = dirname(nodeModules);
  let pkg: InstalledPackage = PACKAGE_NAME;
  let ownerDir = packageDir;
  if (basename(maybeAlias) === ALIAS_PACKAGE_NAME && basename(dirname(maybeAlias)) === "node_modules") {
    if (isSymlink(maybeAlias)) return { mode: "source", packageDir, package: null, ownerDir: null };
    pkg = ALIAS_PACKAGE_NAME;
    ownerDir = maybeAlias;
  }
  const { local, projectDir } = isProjectLocal(ownerDir, platform);
  if (local) return { mode: "local", packageDir, package: pkg, ownerDir, projectDir };
  return { mode: "global", packageDir, package: pkg, ownerDir };
}

/**
 * The global prefix npm installed `ownerDir` into:
 * `<prefix>/lib/node_modules/<pkg>` on POSIX, `<prefix>/node_modules/<pkg>` on Windows.
 */
export function prefixFromPackageDir(ownerDir: string): string {
  let dir = ownerDir;
  while (basename(dir) !== "node_modules") {
    const parent = dirname(dir);
    if (parent === dir) return dirname(ownerDir);
    dir = parent;
  }
  const above = dirname(dir);
  return basename(above) === "lib" ? dirname(above) : above;
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

/** The exact npm argv used for the install; exported so specs and docs pin it. */
export function npmInstallArgs(prefix: string, pkg: InstalledPackage): string[] {
  return ["install", "-g", "--prefix", prefix, `${pkg}@latest`];
}

/**
 * How to invoke `npm`. Prefer npm's JavaScript entry (`npm-cli.js`) run by
 * node: no shell, no `.cmd` wrapper (which `spawn` refuses without a shell on
 * current Node), no quoting of prefixes with spaces. On POSIX `npm` is a
 * symlink to it; on Windows it sits in `node_modules/npm/bin` next to
 * `npm.cmd`. Only when neither is found does Windows fall back to `npm.cmd`
 * through the command interpreter.
 */
export function npmInvocation(
  npm: string,
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; argsPrefix: string[]; shell: boolean } {
  const candidates: string[] = [];
  if (npm.includes(sep) || npm.includes("/")) {
    try {
      const real = realpathSync(npm);
      if (basename(real) === "npm-cli.js") candidates.push(real);
    } catch {
      /* not resolvable — try the sibling layout */
    }
    candidates.push(join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js"));
    candidates.push(join(dirname(npm), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  }
  const cli = candidates.find((c) => existsSync(c));
  if (cli) {
    // Run with the node that ships beside that npm when there is one, else ourselves.
    const nodeName = platform === "win32" ? "node.exe" : "node";
    const siblingNode = join(dirname(npm), nodeName);
    return { cmd: existsSync(siblingNode) ? siblingNode : execPath, argsPrefix: [cli], shell: false };
  }
  return { cmd: npm, argsPrefix: [], shell: platform === "win32" };
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

function runNpmInstall(
  spawnImpl: SpawnImpl,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  shell: boolean,
  onStderr?: (chunk: string) => void,
): Promise<{ code: number; output: string }> {
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
      const opts: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"], env };
      if (shell) opts.shell = true;
      child = spawnImpl(cmd, args, opts);
    } catch (err) {
      done(-1, err instanceof Error ? err.message : String(err));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      chunks.push(text);
      onStderr?.(text);
    });
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
  const platform = deps.platform ?? process.platform;
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();

  const info = detectInstallMode(modulePath, platform);
  const { mode } = info;
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
  if (mode === "local") {
    return fail(CliErrorCode.VALIDATION, localMessage(info.projectDir as string), { latest, package: info.package as InstalledPackage });
  }

  // mode === "global"
  const packageDir = info.packageDir as string;
  const pkg = info.package as InstalledPackage;
  const prefix = prefixFromPackageDir(info.ownerDir as string);
  const { npm, npmSource } = resolveNpm(execPath, prefix, platform);
  const withInstall = { ...withLatest, package: pkg, prefix, npmSource };

  if (!outdated) {
    return { ...withInstall, ok: true, exitCode: 0, lines: [`Already on the latest version (v${currentVersion})`] };
  }

  const { cmd, argsPrefix, shell } = npmInvocation(npm, execPath, platform);
  const args = [...argsPrefix, ...npmInstallArgs(prefix, pkg)];
  const install = await runNpmInstall(spawnImpl, cmd, args, env, shell, deps.onNpmStderr);
  if (install.code !== 0) {
    if (/EACCES/.test(install.output)) return fail(CliErrorCode.PERMISSION_DENIED, eaccesMessage(prefix), withInstall);
    const detail = tail(install.output, NPM_OUTPUT_TAIL_LINES);
    return fail(CliErrorCode.API_ERROR, `npm install -g ${pkg}@latest exited with code ${install.code}${detail ? `\n${detail}` : ""}`, withInstall);
  }

  const installed = readInstalledVersion(packageDir);
  if (installed !== latest) {
    return fail(
      CliErrorCode.API_ERROR,
      `Installed ${pkg} v${latest} at ${prefix} but the running binary (${modulePath}) still reports v${installed ?? "unknown"}; two npm prefixes may be in PATH`,
      withInstall,
    );
  }

  const label = pkg === PACKAGE_NAME ? PACKAGE_NAME : `${ALIAS_PACKAGE_NAME} (${PACKAGE_NAME})`;
  const lines = [`Updated ${label} v${currentVersion} → v${latest} (${prefix})`];
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
      // Text mode relays npm's progress/diagnostics as they happen; --json keeps stderr silent.
      const onNpmStderr = opts.json ? undefined : (chunk: string) => process.stderr.write(chunk);
      const result = await runUpdate(currentVersion, opts, { onNpmStderr, ...deps });
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
