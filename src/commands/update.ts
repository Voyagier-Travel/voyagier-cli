/**
 * `voyagier update` (alias `upgrade`).
 *
 * Brings an installed CLI to the latest npm release the way other CLIs do
 * (Gemini CLI, Vercel CLI, OpenClaw): work out WHICH PACKAGE MANAGER installed
 * this copy from the real path of the running script, then run that manager's
 * own canonical global-install command. No prefix is derived or passed: where
 * the global root lives is the package manager's business. Afterwards the
 * package.json this process was loaded from is re-read; if it did not move,
 * the copy on PATH is shadowed by another install and the user is told the
 * exact command to run.
 *
 * Detection (first match wins):
 *   npx / pnpx / bunx   zero-install caches: nothing to update
 *   git                 not under node_modules, or an `npm link` symlink: git pull
 *   pnpm / yarn / bun / volta   their global dirs: `pnpm add -g`, `yarn global add`, …
 *   local               a project's node_modules (package.json beside it): edit the project
 *   npm                 everything else: `npm install -g <pkg>@latest`
 *
 * The package is `voyagier` when the script was loaded through the alias
 * (`npm install -g voyagier` nests @voyagier/cli under it), else `@voyagier/cli`.
 *
 * Two node toolchains on PATH: before running npm, `npm root -g` is consulted
 * once. If this copy is not inside that root it belongs to another npm; on
 * POSIX that npm (`<root>/../../bin/npm`) is run directly, on Windows the
 * command is printed instead (a path is never passed through cmd.exe).
 *
 *   voyagier update [--check] [--json]
 *
 * `--check` consults the registry for every install kind and exits 1 when
 * outdated. `--json` writes one document to stdout and nothing to stderr.
 */
import { Command } from "commander";
import chalk from "chalk";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gracefulExit } from "../exit.js";
import { CliErrorCode } from "../errors.js";
import { compareSemver } from "./doctor.js";

export const PACKAGE_NAME = "@voyagier/cli";
export const ALIAS_PACKAGE_NAME = "voyagier";
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5000;
const NPM_ROOT_TIMEOUT_MS = 15000;
const OUTPUT_TAIL_LINES = 20;

export type InstalledPackage = typeof PACKAGE_NAME | typeof ALIAS_PACKAGE_NAME;
export type InstallKind = "npm" | "pnpm" | "yarn" | "bun" | "volta" | "npx" | "pnpx" | "bunx" | "local" | "git";

export interface InstallInfo {
  kind: InstallKind;
  package: InstalledPackage;
  /** The @voyagier/cli directory this process runs from (null for git checkouts). */
  packageDir: string | null;
  /** The node_modules that holds the installed package (the alias's parent for the alias layout). */
  globalRoot: string | null;
  /** The manager command that updates this copy, when one exists. */
  command?: string;
  /** What to do instead, when it does not. */
  hint?: string;
}

/** Minimal child-process shape (tests pass an EventEmitter-based fake). */
export type SpawnedChild = Pick<ChildProcess, "on" | "stdout" | "stderr">;
export interface SpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
  /** True when `cmd` is a complete command line (a literal with no paths in it). */
  shell: boolean;
}
export type SpawnImpl = (cmd: string, args: string[], opts: SpawnOptions) => SpawnedChild;

export interface UpdateDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnImpl;
  /** Real path of the running script (default: this module's own, realpath'd). */
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Receives the package manager's stderr as it arrives (text mode only). */
  onStderr?: (chunk: string) => void;
}

export interface UpdateOptions {
  check?: boolean;
  json?: boolean;
}

export interface UpdateResult {
  ok: boolean;
  kind: InstallKind;
  package: InstalledPackage;
  current: string;
  latest: string | null;
  updated: boolean;
  /** The command that was run, or that the user should run. */
  command?: string;
  checkedAt: string;
  error?: { code: CliErrorCode; message: string };
  exitCode: number;
  lines: string[];
}

const NOT_UPDATABLE: Record<"npx" | "pnpx" | "bunx" | "git" | "local", string> = {
  npx: `Running via npx: every run already uses the latest release (npx ${PACKAGE_NAME}@latest)`,
  pnpx: "Running via pnpx: every run already uses the latest release",
  bunx: "Running via bunx: every run already uses the latest release",
  git: "Running from a source checkout; update it with: git pull && npm run build",
  local: `Installed in a project, not globally; update it there with: npm install ${PACKAGE_NAME}@latest`,
};

function globalAddCommand(kind: "npm" | "pnpm" | "yarn" | "bun" | "volta", pkg: InstalledPackage): string {
  const spec = `${pkg}@latest`;
  switch (kind) {
    case "npm":
      return `npm install -g ${spec}`;
    case "pnpm":
      return `pnpm add -g ${spec}`;
    case "yarn":
      return `yarn global add ${spec}`;
    case "bun":
      return `bun add -g ${spec}`;
    case "volta":
      return `volta install ${spec}`;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Classify the install from the real path of the running script. Pure apart from two lstat/exists probes. */
export function detectInstall(scriptPath: string, env: NodeJS.ProcessEnv = process.env): InstallInfo {
  // Separators are normalised only for matching; slices are taken from the original string.
  // All slicing is by index on the normalised string, so separators and UNC roots in the original are untouched.
  const p = scriptPath.replace(/\\/g, "/");
  const CLI = "/node_modules/@voyagier/cli";
  const ALIAS = "/node_modules/voyagier";
  const cliIdx = p.lastIndexOf(CLI + "/");
  const packageDir = cliIdx >= 0 ? scriptPath.slice(0, cliIdx + CLI.length) : null;
  const viaAlias = cliIdx >= 0 && p.slice(0, cliIdx).endsWith(ALIAS);
  const pkg: InstalledPackage = viaAlias ? ALIAS_PACKAGE_NAME : PACKAGE_NAME;
  // The node_modules that holds the installed package: strip "/voyagier" for the alias, "/@voyagier/cli" otherwise.
  const globalRoot = cliIdx < 0 ? null : viaAlias ? scriptPath.slice(0, cliIdx - "/voyagier".length) : scriptPath.slice(0, cliIdx + "/node_modules".length);
  const info = (kind: InstallKind): InstallInfo => {
    if (kind in NOT_UPDATABLE) return { kind, package: pkg, packageDir, globalRoot, hint: NOT_UPDATABLE[kind as keyof typeof NOT_UPDATABLE] };
    return { kind, package: pkg, packageDir, globalRoot, command: globalAddCommand(kind as "npm" | "pnpm" | "yarn" | "bun" | "volta", pkg) };
  };

  if (p.includes("/_npx/")) return info("npx");
  if (p.includes("/.pnpm/_pnpx") || p.includes("/.cache/pnpm/dlx")) return info("pnpx");
  if (p.includes("/.bun/install/cache/")) return info("bunx");
  if (!packageDir || isSymlink(packageDir)) return info("git");
  const pnpmHome = env.PNPM_HOME?.replace(/\\/g, "/");
  if (
    p.includes("/.pnpm/global") ||
    p.includes("/.local/share/pnpm") ||
    p.includes("/Library/pnpm/global/") ||
    p.includes("/AppData/Local/pnpm/global/") ||
    (pnpmHome && p.startsWith(pnpmHome.replace(/\/$/, "") + "/"))
  ) {
    return info("pnpm");
  }
  if (p.includes("/.yarn/global")) return info("yarn");
  if (p.includes("/.bun/install/global")) return info("bun");
  if (p.includes("/.volta/") || p.includes("/Volta/")) return info("volta");
  // A project dependency: the node_modules that holds the package sits beside a package.json.
  const projectDir = (globalRoot as string).slice(0, -"/node_modules".length);
  if (projectDir && existsSync(join(projectDir, "package.json"))) return info("local");
  return info("npm");
}

function runCommand(
  spawnImpl: SpawnImpl,
  cmd: string,
  args: string[],
  shell: boolean,
  env: NodeJS.ProcessEnv,
  onStderr?: (chunk: string) => void,
): Promise<{ code: number; stdout: string; output: string }> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const all: string[] = [];
    let settled = false;
    const done = (code: number, extra?: string) => {
      if (settled) return;
      settled = true;
      if (extra) all.push(extra);
      resolve({ code, stdout: out.join(""), output: all.join("") });
    };
    let child: SpawnedChild;
    try {
      child = spawnImpl(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env, shell });
    } catch (err) {
      done(-1, err instanceof Error ? err.message : String(err));
      return;
    }
    child.stdout?.on("data", (c: Buffer | string) => {
      out.push(String(c));
      all.push(String(c));
    });
    child.stderr?.on("data", (c: Buffer | string) => {
      all.push(String(c));
      onStderr?.(String(c));
    });
    child.on("error", (err: Error) => done(-1, err.message));
    child.on("close", (code: number | null) => done(code ?? -1));
  });
}

/**
 * Which npm owns this copy. Asks the npm on PATH for its global root once
 * (Vercel's check). Inside it → `npm`. Outside it → the npm that ships with
 * this copy's prefix, run directly on POSIX; on Windows only reported, because
 * a path is never handed to cmd.exe.
 */
export async function resolveNpm(
  info: InstallInfo,
  spawnImpl: SpawnImpl,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ cmd: string; args: string[]; shell: boolean; display: string } | { unreachable: string }> {
  const onPath = { cmd: info.command as string, args: [], shell: true, display: info.command as string };
  const root = info.globalRoot as string;
  const probe = await Promise.race([
    runCommand(spawnImpl, "npm root -g", [], true, env),
    new Promise<{ code: number; stdout: string; output: string }>((r) => setTimeout(() => r({ code: -1, stdout: "", output: "timeout" }), NPM_ROOT_TIMEOUT_MS).unref?.()),
  ]);
  const reported = probe.code === 0 ? probe.stdout.trim() : "";
  if (!reported) return onPath; // no npm on PATH or it failed: let the real command speak
  let same = false;
  try {
    same = realpathSync(reported) === realpathSync(root);
  } catch {
    same = reported === root;
  }
  if (same) return onPath;

  const above = dirname(root);
  const prefix = platform !== "win32" && basename(above) === "lib" ? dirname(above) : above;
  const ownNpm = platform === "win32" ? join(prefix, "npm.cmd") : join(prefix, "bin", "npm");
  const args = ["install", "-g", `${info.package}@latest`];
  const display = `${ownNpm} ${args.join(" ")}`;
  if (!existsSync(ownNpm)) {
    return { unreachable: `This copy (${root}) is not managed by the npm on PATH (${reported}) and no npm was found at ${ownNpm}. Update it with the npm that installed it: ${display}` };
  }
  if (platform === "win32") {
    return { unreachable: `This copy (${root}) is not managed by the npm on PATH (${reported}). Run: ${display}` };
  }
  return { cmd: ownNpm, args, shell: false, display };
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

function readVersion(packageDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function tail(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-n)
    .join("\n");
}

function defaultScriptPath(): string {
  const own = fileURLToPath(import.meta.url);
  try {
    return realpathSync(own);
  } catch {
    return own;
  }
}

/** Pure core: never writes output or exits. */
export async function runUpdate(currentVersion: string, opts: UpdateOptions = {}, deps: UpdateDeps = {}): Promise<UpdateResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  const info = detectInstall(deps.scriptPath ?? defaultScriptPath(), env);

  const base = { kind: info.kind, package: info.package, current: currentVersion, latest: null as string | null, updated: false, checkedAt };
  const fail = (code: CliErrorCode, message: string, extra: Partial<UpdateResult> = {}): UpdateResult => ({
    ...base,
    ...extra,
    ok: false,
    error: { code, message },
    exitCode: 1,
    lines: [message],
  });

  // Copies that cannot be updated from here are answered before any network call.
  if (!opts.check && info.hint) {
    const zeroInstall = info.kind === "npx" || info.kind === "pnpx" || info.kind === "bunx";
    return zeroInstall ? { ...base, ok: true, exitCode: 0, lines: [info.hint] } : fail(CliErrorCode.VALIDATION, info.hint);
  }

  const registry = await fetchLatest(fetchImpl);
  if ("error" in registry) return fail(CliErrorCode.NETWORK, registry.error, { command: info.command });
  const latest = registry.latest;
  const cmp = compareSemver(currentVersion, latest);
  const outdated = cmp < 0;
  const withLatest = { ...base, latest, command: info.command };

  if (opts.check) {
    const line = outdated
      ? `v${latest} available; running v${currentVersion}. ${info.command ? "Run: voyagier update" : info.hint}`
      : `Already on the latest version (v${currentVersion}${cmp > 0 ? `, ahead of npm latest v${latest}` : ""})`;
    return { ...withLatest, ok: !outdated, exitCode: outdated ? 1 : 0, lines: [line] };
  }
  if (!outdated) return { ...withLatest, ok: true, exitCode: 0, lines: [`Already on the latest version (v${currentVersion})`] };

  let run: { cmd: string; args: string[]; shell: boolean; display: string };
  if (info.kind === "npm") {
    const resolved = await resolveNpm(info, spawnImpl, env, platform);
    if ("unreachable" in resolved) return fail(CliErrorCode.VALIDATION, resolved.unreachable, { latest });
    run = resolved;
  } else {
    run = { cmd: info.command as string, args: [], shell: true, display: info.command as string };
  }
  const withCommand = { ...withLatest, command: run.display };

  const result = await runCommand(spawnImpl, run.cmd, run.args, run.shell, env, deps.onStderr);
  if (result.code !== 0) {
    if (/EACCES|EPERM/.test(result.output)) {
      return fail(CliErrorCode.PERMISSION_DENIED, `Permission denied while running: ${run.display}. Re-run it with the permissions your install needs (for example with sudo).`, withCommand);
    }
    const detail = tail(result.output, OUTPUT_TAIL_LINES);
    return fail(CliErrorCode.API_ERROR, `${run.display} exited with code ${result.code}${detail ? `\n${detail}` : ""}`, withCommand);
  }

  const installed = readVersion(info.packageDir as string);
  if (installed !== latest) {
    return fail(
      CliErrorCode.API_ERROR,
      `${run.display} succeeded, but the copy on PATH (${info.packageDir}) still reports v${installed ?? "unknown"}: it is shadowed by another installation. Remove one of them, or update that one directly.`,
      withCommand,
    );
  }
  return { ...withCommand, ok: true, updated: true, exitCode: 0, lines: [`Updated ${info.package} v${currentVersion} → v${latest} (${run.display})`] };
}

export function toJsonDocument(result: UpdateResult): Record<string, unknown> {
  const { exitCode: _exitCode, lines: _lines, ...doc } = result;
  return doc;
}

export function registerUpdateCommand(program: Command, currentVersion: string, deps: UpdateDeps = {}): void {
  program
    .command("update")
    .alias("upgrade")
    .description(`Update this install of ${PACKAGE_NAME} to the latest release`)
    .option("--check", "Report current/latest without installing (exit 1 when outdated)")
    .option("--json", "Output raw JSON")
    .action(async (opts: UpdateOptions) => {
      const onStderr = opts.json ? undefined : (chunk: string) => process.stderr.write(chunk);
      const result = await runUpdate(currentVersion, opts, { onStderr, ...deps });
      if (opts.json) {
        process.stdout.write(JSON.stringify(toJsonDocument(result), null, 2) + "\n");
        await gracefulExit(result.exitCode);
        return;
      }
      const text = result.lines.join("\n") + "\n";
      if (result.ok) process.stdout.write(result.updated ? chalk.green(text) : text);
      else process.stderr.write(chalk.red(text));
      await gracefulExit(result.exitCode);
    });
}
