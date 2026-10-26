import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { CliErrorCode } from "../errors.js";
import {
  detectInstallMode,
  packageDirFromModulePath,
  registerUpdateCommand,
  resolveNpm,
  runUpdate,
  eaccesMessage,
  npmInvocation,
  prefixFromPackageDir,
  NPX_MESSAGE,
  REGISTRY_LATEST_URL,
  SOURCE_MESSAGE,
  localMessage,
  type SpawnImpl,
  type SpawnedChild,
  type UpdateResult,
} from "./update.js";

/**
 * `voyagier update` against a scripted registry and a fake npm child. Every
 * collaborator is injected (fetch, spawn, execPath, modulePath), so the spec
 * never touches the network, the real npm, or a real global prefix. Install
 * layouts are built in a temp dir because mode detection reads the file
 * system (symlink check for `npm link`, package.json after an install).
 */

const CURRENT = "4.4.0";
const LATEST = "4.5.0";

// ── Scripted registry ───────────────────────────────────────────────────────

interface RegistryScript {
  status?: number;
  version?: string;
  throws?: Error;
}

function registryFetch(script: RegistryScript = { version: LATEST }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (script.throws) throw script.throws;
    const status = script.status ?? 200;
    const body = status === 200 ? JSON.stringify({ version: script.version ?? LATEST }) : "nope";
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ── Fake npm child ──────────────────────────────────────────────────────────

interface ChildScript {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Run when npm is "invoked" — simulates what the install leaves on disk. */
  onSpawn?: () => void;
  /** Emit `error` instead of running (spawn ENOENT etc.). */
  spawnError?: Error;
  /** Simulate a child whose stderr was not piped (`child.stderr === null`). */
  noStderrStream?: boolean;
}

class FakeChild extends EventEmitter implements SpawnedChild {
  stdout = new EventEmitter() as SpawnedChild["stdout"];
  stderr = new EventEmitter() as SpawnedChild["stderr"];
}

function fakeSpawn(script: ChildScript = {}) {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const spawnImpl: SpawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new FakeChild();
    if (script.noStderrStream) (child as { stderr: unknown }).stderr = null;
    setImmediate(() => {
      if (script.spawnError) {
        child.emit("error", script.spawnError);
        return;
      }
      script.onSpawn?.();
      if (script.stdout) child.stdout!.emit("data", Buffer.from(script.stdout));
      if (script.stderr && child.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
      child.emit("close", script.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

// ── Install layouts in a temp dir ───────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vu-"));
  tempDirs.push(dir);
  return dir;
}

interface GlobalLayout {
  root: string;
  prefix: string;
  /** The @voyagier/cli dir the process runs from (nested under the alias when `alias` is set). */
  packageDir: string;
  /** The package npm installed at the prefix (`voyagier` when `alias`, else `@voyagier/cli`). */
  ownerDir: string;
  modulePath: string;
  execPath: string;
  npmPath: string;
  /** npm's JS entry the symlinked `bin/npm` resolves to. */
  npmCli: string;
  writeInstalledVersion: (version: string) => void;
}

/**
 * `<root>/bin/node` + `<root>/bin/npm` (a symlink to `lib/node_modules/npm/bin/npm-cli.js`,
 * as npm ships it), package at `<root>/lib/node_modules/@voyagier/cli` — or, with `alias`,
 * at `<root>/lib/node_modules/voyagier/node_modules/@voyagier/cli` (`npm install -g voyagier`).
 */
function globalLayout(opts: { siblingNpm?: boolean; installedVersion?: string; alias?: boolean } = {}): GlobalLayout {
  const root = tempDir();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const execPath = join(bin, "node");
  writeFileSync(execPath, "");
  const npmPath = join(bin, "npm");
  const npmCli = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (opts.siblingNpm !== false) {
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "");
    symlinkSync(npmCli, npmPath);
  }
  const ownerDir = opts.alias ? join(root, "lib", "node_modules", "voyagier") : join(root, "lib", "node_modules", "@voyagier", "cli");
  const packageDir = opts.alias ? join(ownerDir, "node_modules", "@voyagier", "cli") : ownerDir;
  if (opts.alias) writeFileSync(join(mkdirSync(ownerDir, { recursive: true }) ?? ownerDir, "package.json"), JSON.stringify({ name: "voyagier", version: opts.installedVersion ?? CURRENT }));
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  const writeInstalledVersion = (version: string) =>
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@voyagier/cli", version }));
  writeInstalledVersion(opts.installedVersion ?? CURRENT);
  const modulePath = join(packageDir, "dist", "index.js");
  writeFileSync(modulePath, "");
  return { root, prefix: root, packageDir, ownerDir, modulePath, execPath, npmPath, npmCli, writeInstalledVersion };
}

/** `npm link` layout: the package dir under node_modules is a symlink to a checkout. */
function linkedLayout(): { modulePath: string; packageDir: string } {
  const root = tempDir();
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "dist"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@voyagier/cli", version: CURRENT }));
  writeFileSync(join(checkout, "dist", "index.js"), "");
  const scope = join(root, "lib", "node_modules", "@voyagier");
  mkdirSync(scope, { recursive: true });
  const packageDir = join(scope, "cli");
  symlinkSync(checkout, packageDir, "dir");
  return { modulePath: join(packageDir, "dist", "index.js"), packageDir };
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tempDirs.length = 0;
});

const FIXED_NOW = new Date("2026-10-26T12:00:00.000Z");
const baseDeps = (layout: Pick<GlobalLayout, "modulePath" | "execPath">) => ({
  modulePath: layout.modulePath,
  execPath: layout.execPath,
  env: { PATH: "/usr/bin" },
  now: () => FIXED_NOW,
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("packageDirFromModulePath / detectInstallMode", () => {
  it("finds the @voyagier/cli package dir under node_modules (posix and win32 separators)", () => {
    expect(packageDirFromModulePath("/usr/lib/node_modules/@voyagier/cli/dist/index.js")).toBe(
      ["", "usr", "lib", "node_modules", "@voyagier", "cli"].join(sep),
    );
    expect(packageDirFromModulePath("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@voyagier\\cli\\dist\\index.js")).not.toBeNull();
    expect(packageDirFromModulePath("/home/me/code/voyagier-cli/dist/index.js")).toBeNull();
    // A nested dependency named differently is not our package.
    expect(packageDirFromModulePath("/usr/lib/node_modules/other/node_modules/@voyagier/cli/dist/index.js")).not.toBeNull();
  });

  it("classifies npx cache paths as npx (posix and win32)", () => {
    expect(detectInstallMode("/home/me/.npm/_npx/abc123/node_modules/@voyagier/cli/dist/index.js").mode).toBe("npx");
    expect(detectInstallMode("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@voyagier\\cli\\dist\\index.js").mode).toBe("npx");
  });

  it("classifies a git checkout (dist not under node_modules) as source", () => {
    expect(detectInstallMode("/home/me/code/voyagier-cli/dist/index.js")).toEqual({ mode: "source", packageDir: null, package: null, ownerDir: null });
  });

  it("classifies a symlinked package dir (npm link) as source and a real one as global", () => {
    const linked = linkedLayout();
    expect(detectInstallMode(linked.modulePath)).toEqual({ mode: "source", packageDir: linked.packageDir, package: null, ownerDir: null });
    const real = globalLayout();
    expect(detectInstallMode(real.modulePath)).toEqual({ mode: "global", packageDir: real.packageDir, package: "@voyagier/cli", ownerDir: real.packageDir });
  });
});

describe("resolveNpm", () => {
  it("prefers the prefix's own npm, then the npm next to the running node, then PATH", () => {
    // Two toolchains: the CLI is installed under `prefix` but runs on `other`'s node
    // (`#!/usr/bin/env node`). The prefix's npm must win so the install lands where the binary lives.
    const prefix = globalLayout();
    const other = globalLayout();
    expect(resolveNpm(other.execPath, prefix.prefix, "linux")).toEqual({ npm: prefix.npmPath, npmSource: "prefix" });

    const bare = globalLayout({ siblingNpm: false });
    expect(resolveNpm(other.execPath, bare.prefix, "linux")).toEqual({ npm: other.npmPath, npmSource: "execPath" });

    const otherBare = globalLayout({ siblingNpm: false });
    expect(resolveNpm(otherBare.execPath, bare.prefix, "linux")).toEqual({ npm: "npm", npmSource: "PATH" });
    expect(resolveNpm(otherBare.execPath, bare.prefix, "win32")).toEqual({ npm: "npm.cmd", npmSource: "PATH" });
    expect(resolveNpm(otherBare.execPath, null, "linux")).toEqual({ npm: "npm", npmSource: "PATH" });
  });
});

describe("npmInvocation", () => {
  it("runs npm-cli.js with the node beside that npm (POSIX symlink layout)", () => {
    const layout = globalLayout();
    expect(npmInvocation(layout.npmPath, "/elsewhere/node", "linux")).toEqual({ cmd: layout.execPath, argsPrefix: [layout.npmCli], shell: false });
  });

  it("finds npm-cli.js beside npm.cmd on Windows and never needs a shell", () => {
    const root = tempDir();
    const npmCmd = join(root, "npm.cmd");
    writeFileSync(npmCmd, "");
    const cli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "");
    expect(npmInvocation(npmCmd, "/elsewhere/node.exe", "win32")).toEqual({ cmd: "/elsewhere/node.exe", argsPrefix: [cli], shell: false });
  });

  it("falls back to npm.cmd through the shell only on Windows when no JS entry exists", () => {
    expect(npmInvocation("npm.cmd", "/n/node.exe", "win32")).toEqual({ cmd: "npm.cmd", argsPrefix: [], shell: true });
    expect(npmInvocation("npm", "/n/node", "linux")).toEqual({ cmd: "npm", argsPrefix: [], shell: false });
  });
});

describe("detectInstallMode: project-local installs", () => {
  /** `<project>/package.json` + `<project>/node_modules/@voyagier/cli` (`npm install @voyagier/cli`), optionally through the alias. */
  function localLayout(opts: { alias?: boolean; packageJson?: boolean } = {}) {
    const project = tempDir();
    if (opts.packageJson !== false) writeFileSync(join(project, "package.json"), "{}");
    const ownerDir = opts.alias ? join(project, "node_modules", "voyagier") : join(project, "node_modules", "@voyagier", "cli");
    const packageDir = opts.alias ? join(ownerDir, "node_modules", "@voyagier", "cli") : ownerDir;
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@voyagier/cli", version: CURRENT }));
    const modulePath = join(packageDir, "dist", "index.js");
    writeFileSync(modulePath, "");
    return { project, ownerDir, packageDir, modulePath };
  }

  it("classifies a project dependency as local, with the project dir, for the plain and alias layouts", () => {
    const plain = localLayout();
    expect(detectInstallMode(plain.modulePath, "linux")).toEqual({ mode: "local", packageDir: plain.packageDir, package: "@voyagier/cli", ownerDir: plain.ownerDir, projectDir: plain.project });
    const alias = localLayout({ alias: true });
    expect(detectInstallMode(alias.modulePath, "win32")).toMatchObject({ mode: "local", package: "voyagier", ownerDir: alias.ownerDir, projectDir: alias.project });
  });

  it("on POSIX a node_modules outside lib/ is local even without a package.json; on Windows the package.json decides", () => {
    const noPkg = localLayout({ packageJson: false });
    expect(detectInstallMode(noPkg.modulePath, "linux").mode).toBe("local");
    expect(detectInstallMode(noPkg.modulePath, "win32").mode).toBe("global"); // %APPDATA%\\npm\\node_modules shape
  });

  it("refuses to spawn npm for a local install and points at the project", async () => {
    const plain = localLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(CURRENT, {}, { modulePath: plain.modulePath, execPath: "/usr/bin/node", platform: "linux", fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, mode: "local", package: "@voyagier/cli", latest: LATEST, updated: false, exitCode: 1, error: { code: CliErrorCode.VALIDATION, message: localMessage(plain.project) } });
    expect(result.error?.message).toContain("npm install @voyagier/cli@latest");
  });

  it("--check still reports for a local install", async () => {
    const plain = localLayout();
    const result = await runUpdate(CURRENT, { check: true }, { modulePath: plain.modulePath, execPath: "/usr/bin/node", platform: "linux", fetchImpl: registryFetch().fetchImpl, spawnImpl: fakeSpawn().spawnImpl });
    expect(result).toMatchObject({ ok: false, mode: "local", latest: LATEST, exitCode: 1 });
    expect(result.error).toBeUndefined();
  });
});

describe("prefixFromPackageDir", () => {
  it("derives the global prefix for POSIX, Windows and alias layouts", () => {
    expect(prefixFromPackageDir(["", "usr", "local", "lib", "node_modules", "@voyagier", "cli"].join(sep))).toBe(["", "usr", "local"].join(sep));
    expect(prefixFromPackageDir(["", "usr", "local", "lib", "node_modules", "voyagier"].join(sep))).toBe(["", "usr", "local"].join(sep));
    expect(prefixFromPackageDir(["C:", "npm", "node_modules", "@voyagier", "cli"].join(sep))).toBe(["C:", "npm"].join(sep));
  });
});

// ── runUpdate ───────────────────────────────────────────────────────────────

describe("runUpdate", () => {
  it("global + outdated: spawns the prefix's npm pinned with --prefix and reports updated:true", async () => {
    const layout = globalLayout();
    const registry = registryFetch();
    const npm = fakeSpawn({ stdout: "changed 1 package\n", onSpawn: () => layout.writeInstalledVersion(LATEST) });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registry.fetchImpl, spawnImpl: npm.spawnImpl });

    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0].url).toBe(REGISTRY_LATEST_URL);
    expect(registry.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(npm.calls).toEqual([
      {
        cmd: layout.execPath, // node beside the prefix's npm runs npm-cli.js: no shell, no .cmd wrapper
        args: [layout.npmCli, "install", "-g", "--prefix", layout.prefix, "@voyagier/cli@latest"],
        opts: { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin" } },
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      mode: "global",
      current: CURRENT,
      latest: LATEST,
      updated: true,
      prefix: layout.prefix,
      npmSource: "prefix",
      checkedAt: "2026-10-26T12:00:00.000Z",
      exitCode: 0,
    });
    expect(result.error).toBeUndefined();
    expect(result.lines[0]).toContain(`v${CURRENT} → v${LATEST}`);
  });

  it("global + outdated without a sibling npm: uses npm from PATH and says so", async () => {
    const layout = globalLayout({ siblingNpm: false });
    const npm = fakeSpawn({ onSpawn: () => layout.writeInstalledVersion(LATEST) });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls[0].cmd).toBe("npm");
    expect(result).toMatchObject({ ok: true, updated: true, npmSource: "PATH" });
    expect(result.lines.join("\n")).toContain("Used npm from PATH");
  });

  it("global + outdated on a mixed toolchain: uses the prefix's npm, not the running node's", async () => {
    const layout = globalLayout();
    const other = globalLayout();
    const npm = fakeSpawn({ onSpawn: () => layout.writeInstalledVersion(LATEST) });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), execPath: other.execPath, fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls[0].cmd).toBe(layout.execPath);
    expect(npm.calls[0].args).toEqual([layout.npmCli, "install", "-g", "--prefix", layout.prefix, "@voyagier/cli@latest"]);
    expect(result).toMatchObject({ ok: true, updated: true, prefix: layout.prefix, npmSource: "prefix" });
  });

  it("alias layout (npm install -g voyagier): updates the outer alias at the real prefix and verifies the nested cli", async () => {
    const layout = globalLayout({ alias: true });
    expect(detectInstallMode(layout.modulePath)).toEqual({ mode: "global", packageDir: layout.packageDir, package: "voyagier", ownerDir: layout.ownerDir });
    const npm = fakeSpawn({ onSpawn: () => layout.writeInstalledVersion(LATEST) });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls[0].args).toEqual([layout.npmCli, "install", "-g", "--prefix", layout.prefix, "voyagier@latest"]);
    expect(result).toMatchObject({ ok: true, updated: true, package: "voyagier", prefix: layout.prefix, npmSource: "prefix" });
    expect(result.lines[0]).toContain("voyagier (@voyagier/cli)");
  });

  it("alias layout: a nested cli left on the old version after the install is reported, not claimed as updated", async () => {
    const layout = globalLayout({ alias: true });
    const npm = fakeSpawn(); // npm "succeeds" but nothing changes on disk
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(result).toMatchObject({ ok: false, updated: false, package: "voyagier", exitCode: 1, error: { code: CliErrorCode.API_ERROR } });
    expect(result.error?.message).toContain(`still reports v${CURRENT}`);
  });

  it("EACCES arrives on npm's stderr only: still classified as a permission failure", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn({ code: 243, stderr: "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied\n" });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls[0].opts).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    expect(result).toMatchObject({ ok: false, error: { code: CliErrorCode.PERMISSION_DENIED, message: eaccesMessage(layout.prefix) } });
  });

  it("a child without a stderr stream cannot hide the failure detail: stdout is still captured", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn({ code: 1, stdout: "npm ERR! something else\n", noStderrStream: true });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(result.error?.message).toContain("something else");
  });

  it("relays npm's stderr through onNpmStderr as it arrives", async () => {
    const layout = globalLayout();
    const relayed: string[] = [];
    const npm = fakeSpawn({ stderr: "npm WARN deprecated foo\n", onSpawn: () => layout.writeInstalledVersion(LATEST) });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl, onNpmStderr: (c) => relayed.push(c) });
    expect(result.updated).toBe(true);
    expect(relayed.join("")).toBe("npm WARN deprecated foo\n");
  });

  it("global + already latest: no spawn, updated:false, exit 0", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(LATEST, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, mode: "global", updated: false, exitCode: 0, lines: [`Already on the latest version (v${LATEST})`] });
  });

  it("global + ahead of npm (dev build): no spawn, exit 0", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const result = await runUpdate("9.9.9", {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, updated: false, exitCode: 0 });
  });

  it("--check + outdated: no spawn, exit 1, latest reported", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(CURRENT, { check: true }, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: false, mode: "global", current: CURRENT, latest: LATEST, updated: false, exitCode: 1 });
    expect(result.error).toBeUndefined();
    expect(result.lines[0]).toContain("Run: voyagier update");
  });

  it("--check + latest: exit 0", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(LATEST, { check: true }, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, updated: false, exitCode: 0 });
  });

  it("--check from a source checkout still reports (no refusal, no install)", async () => {
    const npm = fakeSpawn();
    const result = await runUpdate(CURRENT, { check: true }, {
      modulePath: "/home/me/code/voyagier-cli/dist/index.js",
      execPath: "/usr/bin/node",
      fetchImpl: registryFetch().fetchImpl,
      spawnImpl: npm.spawnImpl,
    });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ mode: "source", latest: LATEST, exitCode: 1 });
    expect(result.error).toBeUndefined();
  });

  it("npx mode: nothing to update, no registry call, exit 0", async () => {
    const registry = registryFetch();
    const npm = fakeSpawn();
    const result = await runUpdate(CURRENT, {}, {
      modulePath: "/home/me/.npm/_npx/abc123/node_modules/@voyagier/cli/dist/index.js",
      execPath: "/usr/bin/node",
      fetchImpl: registry.fetchImpl,
      spawnImpl: npm.spawnImpl,
    });
    expect(registry.calls).toEqual([]);
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, mode: "npx", latest: null, updated: false, exitCode: 0, lines: [NPX_MESSAGE] });
  });

  it("source mode (symlinked package dir): refuses with the git pull hint, exit 1, no spawn", async () => {
    const linked = linkedLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(CURRENT, {}, { modulePath: linked.modulePath, execPath: "/usr/bin/node", fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      mode: "source",
      latest: LATEST,
      updated: false,
      exitCode: 1,
      error: { code: CliErrorCode.VALIDATION, message: SOURCE_MESSAGE },
    });
  });

  it("source mode (git checkout, dist not under node_modules): refuses", async () => {
    const result = await runUpdate(CURRENT, {}, {
      modulePath: "/home/me/code/voyagier-cli/dist/index.js",
      execPath: "/usr/bin/node",
      fetchImpl: registryFetch().fetchImpl,
      spawnImpl: fakeSpawn().spawnImpl,
    });
    expect(result).toMatchObject({ ok: false, mode: "source", exitCode: 1, error: { code: CliErrorCode.VALIDATION } });
  });

  it("maps EACCES in npm's output to the permission hint", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn({ code: 243, stderr: "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/@voyagier'\n" });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(result).toMatchObject({
      ok: false,
      mode: "global",
      updated: false,
      prefix: layout.prefix,
      npmSource: "prefix",
      exitCode: 1,
      error: { code: CliErrorCode.PERMISSION_DENIED, message: eaccesMessage(layout.prefix) },
    });
  });

  it("surfaces npm's exit code and the last 20 lines of its output on other failures", async () => {
    const layout = globalLayout();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const npm = fakeSpawn({ code: 7, stdout: lines.slice(0, 10).join("\n") + "\n", stderr: lines.slice(10).join("\n") + "\n" });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe(CliErrorCode.API_ERROR);
    expect(result.error?.message).toContain("exited with code 7");
    expect(result.error?.message).toContain("line 30");
    expect(result.error?.message).toContain("line 11");
    expect(result.error?.message).not.toContain("line 10\n");
  });

  it("reports a spawn error (npm missing) as a failed install", async () => {
    const layout = globalLayout({ siblingNpm: false });
    const npm = fakeSpawn({ spawnError: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(result).toMatchObject({ ok: false, exitCode: 1, error: { code: CliErrorCode.API_ERROR } });
    expect(result.error?.message).toContain("ENOENT");
  });

  it("registry 500: NETWORK error, exit 1, no spawn", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch({ status: 500 }).fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: false, mode: "global", latest: null, updated: false, exitCode: 1, error: { code: CliErrorCode.NETWORK } });
    expect(result.error?.message).toContain("registry returned 500");
  });

  it("registry unreachable (fetch throws): NETWORK error with the cause", async () => {
    const layout = globalLayout();
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch({ throws: new TypeError("fetch failed") }).fetchImpl, spawnImpl: fakeSpawn().spawnImpl });
    expect(result).toMatchObject({ ok: false, exitCode: 1, error: { code: CliErrorCode.NETWORK } });
    expect(result.error?.message).toContain("fetch failed");
  });

  it("post-install version mismatch (install landed in another prefix): exit 1 with the two-prefix hint", async () => {
    const layout = globalLayout();
    // npm exits 0 but the package next to the running binary is untouched.
    const npm = fakeSpawn({ code: 0, stdout: "changed 1 package\n" });
    const result = await runUpdate(CURRENT, {}, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    expect(npm.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, mode: "global", latest: LATEST, updated: false, prefix: layout.prefix, exitCode: 1, error: { code: CliErrorCode.API_ERROR } });
    expect(result.error?.message).toBe(
      `Installed @voyagier/cli v${LATEST} at ${layout.prefix} but the running binary (${layout.modulePath}) still reports v${CURRENT}; two npm prefixes may be in PATH`,
    );
  });
});

// ── Command surface (--json contract, exits, alias) ─────────────────────────

describe("voyagier update (command)", () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let outSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let errSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    outSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    errSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  function program(currentVersion: string, deps: Parameters<typeof registerUpdateCommand>[2]): Command {
    const p = new Command().exitOverride();
    registerUpdateCommand(p, currentVersion, deps);
    return p;
  }

  it("registers `update` with the `upgrade` alias and both flags", () => {
    const p = program(CURRENT, {});
    const cmd = p.commands.find((c) => c.name() === "update")!;
    expect(cmd).toBeDefined();
    expect(cmd.aliases()).toEqual(["upgrade"]);
    expect(cmd.options.map((o) => o.long).sort()).toEqual(["--check", "--json"]);
  });

  it("--json emits exactly one stdout document, nothing on stderr, and exits via gracefulExit(0)", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn({ onSpawn: () => layout.writeInstalledVersion(LATEST) });
    const p = program(CURRENT, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl });
    await p.parseAsync(["node", "test", "update", "--json"]);

    expect(stderrWrites).toEqual([]);
    expect(stdoutWrites).toHaveLength(1);
    const doc = JSON.parse(stdoutWrites[0]) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["checkedAt", "current", "latest", "mode", "npmSource", "ok", "package", "prefix", "updated"]);
    expect(doc).toEqual({
      ok: true,
      mode: "global",
      current: CURRENT,
      latest: LATEST,
      updated: true,
      package: "@voyagier/cli",
      prefix: layout.prefix,
      npmSource: "prefix",
      checkedAt: "2026-10-26T12:00:00.000Z",
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--json on failure carries { code, message } under error and exits 1", async () => {
    const linked = linkedLayout();
    const p = program(CURRENT, { modulePath: linked.modulePath, execPath: "/usr/bin/node", fetchImpl: registryFetch().fetchImpl, spawnImpl: fakeSpawn().spawnImpl, now: () => FIXED_NOW });
    await p.parseAsync(["node", "test", "upgrade", "--json"]);
    expect(stderrWrites).toEqual([]);
    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0])).toEqual({
      ok: false,
      mode: "source",
      current: CURRENT,
      latest: LATEST,
      updated: false,
      checkedAt: "2026-10-26T12:00:00.000Z",
      error: { code: CliErrorCode.VALIDATION, message: SOURCE_MESSAGE },
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--check --json: exit 1 when outdated, exit 0 when current, never spawns", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    await program(CURRENT, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }).parseAsync(["node", "test", "update", "--check", "--json"]);
    expect(exitSpy).toHaveBeenLastCalledWith(1);
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({ ok: false, current: CURRENT, latest: LATEST, updated: false });

    await program(LATEST, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }).parseAsync(["node", "test", "update", "--check", "--json"]);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
    expect(JSON.parse(stdoutWrites[1])).toMatchObject({ ok: true, current: LATEST, latest: LATEST, updated: false });
    expect(npm.calls).toEqual([]);
    expect(stderrWrites).toEqual([]);
  });

  it("human output: npx mode prints the zero-install note on stdout and exits 0", async () => {
    const p = program(CURRENT, { modulePath: "/home/me/.npm/_npx/abc/node_modules/@voyagier/cli/dist/index.js", execPath: "/usr/bin/node", fetchImpl: registryFetch().fetchImpl, spawnImpl: fakeSpawn().spawnImpl });
    await p.parseAsync(["node", "test", "update"]);
    expect(stdoutWrites.join("")).toContain(NPX_MESSAGE);
    expect(stderrWrites).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("human output: errors go to stderr and exit 1", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn({ code: 243, stderr: "npm ERR! EACCES: permission denied\n" });
    await program(CURRENT, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }).parseAsync(["node", "test", "update"]);
    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites.join("")).toContain(eaccesMessage(layout.prefix));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("human output: a successful update prints the version transition", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn({ onSpawn: () => layout.writeInstalledVersion(LATEST) });
    await program(CURRENT, { ...baseDeps(layout), fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }).parseAsync(["node", "test", "update"]);
    expect(stdoutWrites.join("")).toContain(`v${CURRENT} → v${LATEST}`);
    expect(stderrWrites).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// Type-level guard: the result's JSON fields are the documented set.
const _shape: Omit<UpdateResult, "exitCode" | "lines"> = {
  ok: true, mode: "global", current: "1", latest: "1", updated: false, checkedAt: "", prefix: "", npmSource: "PATH",
};
void _shape;
