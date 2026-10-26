import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliErrorCode } from "../errors.js";
import {
  detectInstall,
  registerUpdateCommand,
  resolveNpm,
  runUpdate,
  REGISTRY_LATEST_URL,
  type SpawnImpl,
  type SpawnedChild,
  type UpdateResult,
} from "./update.js";

/**
 * `voyagier update` against a scripted registry and a fake package-manager child.
 * Every collaborator is injected, so the spec never touches the network, a real
 * npm, or a real global prefix. Layouts that need the file system (symlink
 * check, package.json after an install) are built in a temp dir.
 */

const CURRENT = "4.4.0";
const LATEST = "4.5.0";
const FIXED_NOW = new Date("2026-10-26T12:00:00.000Z");

// ── Scripted registry ───────────────────────────────────────────────────────

function registryFetch(script: { status?: number; version?: string; throws?: Error } = { version: LATEST }) {
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

// ── Fake child: one script per command line ─────────────────────────────────

interface ChildScript {
  code?: number;
  stdout?: string;
  stderr?: string;
  onSpawn?: () => void;
  spawnError?: Error;
  /** A real child whose stderr was not piped (`child.stderr === null`). */
  noStderrStream?: boolean;
}

class FakeChild extends EventEmitter implements SpawnedChild {
  stdout = new EventEmitter() as SpawnedChild["stdout"];
  stderr = new EventEmitter() as SpawnedChild["stderr"];
}

/** Scripts keyed by the full command line (`cmd args…`); `default` covers the rest. */
function fakeSpawn(scripts: Record<string, ChildScript> = {}) {
  const calls: Array<{ cmd: string; args: string[]; opts: { shell: boolean; stdio: unknown } }> = [];
  const spawnImpl: SpawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts: { shell: opts.shell, stdio: opts.stdio } });
    const line = [cmd, ...args].join(" ");
    const script = scripts[line] ?? scripts.default ?? {};
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

// ── Layouts in a temp dir ───────────────────────────────────────────────────

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vu-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A global npm prefix: `<root>/lib/node_modules/@voyagier/cli` with `<root>/bin/npm`.
 * `alias` nests it under `<root>/lib/node_modules/voyagier/node_modules/` (`npm install -g voyagier`).
 */
function globalLayout(opts: { alias?: boolean; ownNpm?: boolean } = {}) {
  const root = tempDir();
  const globalRoot = join(root, "lib", "node_modules");
  const packageDir = opts.alias ? join(globalRoot, "voyagier", "node_modules", "@voyagier", "cli") : join(globalRoot, "@voyagier", "cli");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  if (opts.ownNpm !== false) {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "npm"), "");
  }
  const write = (version: string) => writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@voyagier/cli", version }));
  write(CURRENT);
  const scriptPath = join(packageDir, "dist", "index.js");
  writeFileSync(scriptPath, "");
  return { root, globalRoot, packageDir, scriptPath, ownNpm: join(root, "bin", "npm"), writeInstalledVersion: write };
}

/** A project dependency: `<project>/package.json` + `<project>/node_modules/@voyagier/cli`. */
function localLayout(opts: { alias?: boolean } = {}) {
  const project = tempDir();
  writeFileSync(join(project, "package.json"), "{}");
  const packageDir = opts.alias
    ? join(project, "node_modules", "voyagier", "node_modules", "@voyagier", "cli")
    : join(project, "node_modules", "@voyagier", "cli");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@voyagier/cli", version: CURRENT }));
  const scriptPath = join(packageDir, "dist", "index.js");
  writeFileSync(scriptPath, "");
  return { project, packageDir, scriptPath };
}

/** `npm link`: the package dir under node_modules is a symlink to a checkout. */
function linkedLayout() {
  const root = tempDir();
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "dist"), { recursive: true });
  writeFileSync(join(checkout, "dist", "index.js"), "");
  const nm = join(root, "lib", "node_modules", "@voyagier");
  mkdirSync(nm, { recursive: true });
  symlinkSync(checkout, join(nm, "cli"), "dir");
  return { scriptPath: join(nm, "cli", "dist", "index.js") };
}

/** Scripts `npm root -g` to report `root`, and the install to bump the layout. */
function npmScripts(layout: ReturnType<typeof globalLayout>, opts: { root?: string; install?: ChildScript; rootCode?: number } = {}) {
  return {
    "npm root -g": { stdout: (opts.root ?? layout.globalRoot) + "\n", code: opts.rootCode ?? 0 },
    default: opts.install ?? { onSpawn: () => layout.writeInstalledVersion(LATEST), stdout: "changed 1 package\n" },
  };
}

const deps = (scriptPath: string, extra: Partial<Parameters<typeof runUpdate>[2]> = {}) => ({
  scriptPath,
  env: { PATH: "/usr/bin" },
  platform: "linux" as NodeJS.Platform,
  now: () => FIXED_NOW,
  ...extra,
});

// ── detectInstall ───────────────────────────────────────────────────────────

describe("detectInstall", () => {
  it("recognises every package manager from the script's real path (POSIX and Windows separators)", () => {
    const cases: Array<[string, string, string | undefined]> = [
      ["/home/me/.npm/_npx/abc/node_modules/@voyagier/cli/dist/index.js", "npx", undefined],
      ["/home/me/.cache/pnpm/dlx/abc/node_modules/@voyagier/cli/dist/index.js", "pnpx", undefined],
      ["/home/me/.bun/install/cache/@voyagier/cli@4.4.0/dist/index.js", "bunx", undefined],
      ["/home/me/.local/share/pnpm/global/5/node_modules/@voyagier/cli/dist/index.js", "pnpm", "pnpm add -g @voyagier/cli@latest"],
      ["/home/me/.yarn/global/node_modules/@voyagier/cli/dist/index.js", "yarn", "yarn global add @voyagier/cli@latest"],
      ["/home/me/.bun/install/global/node_modules/@voyagier/cli/dist/index.js", "bun", "bun add -g @voyagier/cli@latest"],
      ["/home/me/.volta/tools/image/packages/@voyagier/cli/lib/node_modules/@voyagier/cli/dist/index.js", "volta", "volta install @voyagier/cli@latest"],
      ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@voyagier\\cli\\dist\\index.js", "npm", "npm install -g @voyagier/cli@latest"],
      ["\\\\server\\share\\npm\\node_modules\\@voyagier\\cli\\dist\\index.js", "npm", "npm install -g @voyagier/cli@latest"],
      ["/home/me/code/voyagier-cli/dist/index.js", "git", undefined],
    ];
    for (const [path, kind, command] of cases) {
      const info = detectInstall(path, {});
      expect({ path, kind: info.kind, command: info.command }).toEqual({ path, kind, command });
    }
  });

  it("names the alias package when loaded through npm install -g voyagier", () => {
    expect(detectInstall("/usr/local/lib/node_modules/voyagier/node_modules/@voyagier/cli/dist/index.js", {})).toMatchObject({
      kind: "npm",
      package: "voyagier",
      command: "npm install -g voyagier@latest",
    });
    expect(detectInstall("/home/me/.yarn/global/node_modules/voyagier/node_modules/@voyagier/cli/dist/index.js", {})).toMatchObject({
      kind: "yarn",
      command: "yarn global add voyagier@latest",
    });
  });

  it("honours PNPM_HOME", () => {
    expect(detectInstall("/opt/pnpm-home/global/5/node_modules/@voyagier/cli/dist/index.js", { PNPM_HOME: "/opt/pnpm-home/" }).kind).toBe("pnpm");
  });

  it("classifies a project dependency as local (plain and alias) and npm link as git", () => {
    expect(detectInstall(localLayout().scriptPath, {})).toMatchObject({ kind: "local", package: "@voyagier/cli" });
    expect(detectInstall(localLayout({ alias: true }).scriptPath, {})).toMatchObject({ kind: "local", package: "voyagier" });
    expect(detectInstall(linkedLayout().scriptPath, {}).kind).toBe("git");
    expect(detectInstall(globalLayout().scriptPath, {}).kind).toBe("npm");
  });
});

// ── resolveNpm: which npm owns this copy ────────────────────────────────────

describe("resolveNpm", () => {
  it("uses the npm on PATH when npm root -g contains this copy", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout));
    const r = await resolveNpm(detectInstall(layout.scriptPath, {}), npm.spawnImpl, {}, "linux");
    expect(r).toEqual({ cmd: "npm install -g @voyagier/cli@latest", args: [], shell: true, display: "npm install -g @voyagier/cli@latest" });
    expect(npm.calls).toEqual([{ cmd: "npm root -g", args: [], opts: { shell: true, stdio: ["ignore", "pipe", "pipe"] } }]);
  });

  it("runs the prefix's own npm directly (no shell) when PATH's npm owns a different root", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { root: "/somewhere/else/lib/node_modules" }));
    const r = await resolveNpm(detectInstall(layout.scriptPath, {}), npm.spawnImpl, {}, "linux");
    expect(r).toEqual({ cmd: layout.ownNpm, args: ["install", "-g", "@voyagier/cli@latest"], shell: false, display: `${layout.ownNpm} install -g @voyagier/cli@latest` });
  });

  it("falls back to PATH's npm when npm root -g fails, and reports when no owning npm exists", async () => {
    const layout = globalLayout({ ownNpm: false });
    const failed = fakeSpawn(npmScripts(layout, { rootCode: 1 }));
    expect(await resolveNpm(detectInstall(layout.scriptPath, {}), failed.spawnImpl, {}, "linux")).toMatchObject({ shell: true });
    const other = fakeSpawn(npmScripts(layout, { root: "/elsewhere/lib/node_modules" }));
    const r = await resolveNpm(detectInstall(layout.scriptPath, {}), other.spawnImpl, {}, "linux");
    expect(r).toMatchObject({ unreachable: expect.stringContaining(layout.ownNpm) });
  });

  it("on Windows never passes a path through the shell: it reports the command instead", async () => {
    const root = tempDir();
    const packageDir = join(root, "node_modules", "@voyagier", "cli");
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(join(root, "npm.cmd"), "");
    const scriptPath = join(packageDir, "dist", "index.js");
    writeFileSync(scriptPath, "");
    const npm = fakeSpawn({ "npm root -g": { stdout: "C:\\elsewhere\\node_modules\n" } });
    const r = await resolveNpm(detectInstall(scriptPath, {}), npm.spawnImpl, {}, "win32");
    expect(r).toMatchObject({ unreachable: expect.stringContaining(join(root, "npm.cmd") + " install -g @voyagier/cli@latest") });
  });
});

// ── runUpdate ───────────────────────────────────────────────────────────────

describe("runUpdate", () => {
  it("npm global + outdated: runs the literal npm command through the shell, verifies, reports updated:true", async () => {
    const layout = globalLayout();
    const registry = registryFetch();
    const npm = fakeSpawn(npmScripts(layout));
    const result = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registry.fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(registry.calls[0].url).toBe(REGISTRY_LATEST_URL);
    expect(registry.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(npm.calls.map((c) => c.cmd)).toEqual(["npm root -g", "npm install -g @voyagier/cli@latest"]);
    expect(npm.calls[1]).toEqual({ cmd: "npm install -g @voyagier/cli@latest", args: [], opts: { shell: true, stdio: ["ignore", "pipe", "pipe"] } });
    expect(result).toMatchObject({ ok: true, kind: "npm", package: "@voyagier/cli", current: CURRENT, latest: LATEST, updated: true, command: "npm install -g @voyagier/cli@latest", checkedAt: FIXED_NOW.toISOString(), exitCode: 0 });
    expect(result.error).toBeUndefined();
  });

  it("alias layout: updates the outer voyagier package and verifies the nested cli it loads", async () => {
    const layout = globalLayout({ alias: true });
    const npm = fakeSpawn(npmScripts(layout));
    const result = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(npm.calls[1].cmd).toBe("npm install -g voyagier@latest");
    expect(result).toMatchObject({ ok: true, package: "voyagier", updated: true });
  });

  it("two toolchains: PATH's npm owns another root, so the prefix's own npm is run directly", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { root: "/other/lib/node_modules" }));
    const result = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(npm.calls[1]).toMatchObject({ cmd: layout.ownNpm, args: ["install", "-g", "@voyagier/cli@latest"], opts: { shell: false } });
    expect(result).toMatchObject({ ok: true, updated: true, command: `${layout.ownNpm} install -g @voyagier/cli@latest` });
  });

  it("pnpm / yarn / bun / volta: runs that manager's command, no npm root probe", async () => {
    for (const [path, command] of [
      ["/home/me/.local/share/pnpm/global/5/node_modules/@voyagier/cli/dist/index.js", "pnpm add -g @voyagier/cli@latest"],
      ["/home/me/.yarn/global/node_modules/@voyagier/cli/dist/index.js", "yarn global add @voyagier/cli@latest"],
    ]) {
      // These paths do not exist on disk, so the verify step reads no package.json: assert the spawn, not the outcome.
      const npm = fakeSpawn();
      await runUpdate(CURRENT, {}, deps(path, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
      expect(npm.calls).toEqual([{ cmd: command, args: [], opts: { shell: true, stdio: ["ignore", "pipe", "pipe"] } }]);
    }
  });

  it("already latest: no spawn at all, exit 0", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const result = await runUpdate(LATEST, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(npm.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, updated: false, exitCode: 0 });
  });

  it("--check: exit 1 when outdated, 0 when current, never spawns; works for npx, git and local too", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    expect(await runUpdate(CURRENT, { check: true }, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }))).toMatchObject({ ok: false, latest: LATEST, exitCode: 1 });
    expect(await runUpdate(LATEST, { check: true }, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }))).toMatchObject({ ok: true, exitCode: 0 });
    for (const path of ["/home/me/.npm/_npx/abc/node_modules/@voyagier/cli/dist/index.js", linkedLayout().scriptPath, localLayout().scriptPath]) {
      const registry = registryFetch();
      const r = await runUpdate(CURRENT, { check: true }, deps(path, { fetchImpl: registry.fetchImpl, spawnImpl: npm.spawnImpl }));
      expect(registry.calls).toHaveLength(1);
      expect(r).toMatchObject({ ok: false, latest: LATEST, exitCode: 1 });
      expect(r.error).toBeUndefined();
    }
    expect(npm.calls).toEqual([]);
  });

  it("npx: nothing to update, exit 0, no registry call", async () => {
    const registry = registryFetch();
    const r = await runUpdate(CURRENT, {}, deps("/home/me/.npm/_npx/abc/node_modules/@voyagier/cli/dist/index.js", { fetchImpl: registry.fetchImpl, spawnImpl: fakeSpawn().spawnImpl }));
    expect(registry.calls).toEqual([]);
    expect(r).toMatchObject({ ok: true, kind: "npx", latest: null, exitCode: 0 });
    expect(r.lines[0]).toContain("npx @voyagier/cli@latest");
  });

  it("git checkout and project-local: refused before any registry call, exit 1", async () => {
    for (const [path, snippet] of [
      [linkedLayout().scriptPath, "git pull && npm run build"],
      [localLayout().scriptPath, "npm install @voyagier/cli@latest"],
    ]) {
      const registry = registryFetch({ status: 503 });
      const npm = fakeSpawn();
      const r = await runUpdate(CURRENT, {}, deps(path, { fetchImpl: registry.fetchImpl, spawnImpl: npm.spawnImpl }));
      expect(registry.calls).toEqual([]);
      expect(npm.calls).toEqual([]);
      expect(r).toMatchObject({ ok: false, latest: null, exitCode: 1, error: { code: CliErrorCode.VALIDATION } });
      expect(r.error?.message).toContain(snippet);
    }
  });

  it("registry failure: NETWORK error, exit 1, no spawn", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn();
    const r = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch({ status: 500 }).fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(npm.calls).toEqual([]);
    expect(r).toMatchObject({ ok: false, exitCode: 1, error: { code: CliErrorCode.NETWORK } });
  });

  it("EACCES on the manager's stderr: classified as a permission failure naming the command", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { install: { code: 243, stderr: "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied\n" } }));
    const r = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(npm.calls[1].opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(r).toMatchObject({ ok: false, exitCode: 1, error: { code: CliErrorCode.PERMISSION_DENIED } });
    expect(r.error?.message).toContain("npm install -g @voyagier/cli@latest");
  });

  it("other failure: API_ERROR with the exit code and the output tail (stdout still captured when stderr is not a stream)", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { install: { code: 1, stdout: "npm ERR! something else\n", noStderrStream: true } }));
    const r = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(r).toMatchObject({ ok: false, error: { code: CliErrorCode.API_ERROR } });
    expect(r.error?.message).toContain("exited with code 1");
    expect(r.error?.message).toContain("something else");
  });

  it("spawn error (ENOENT): API_ERROR, exit 1", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { install: { spawnError: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }) } }));
    const r = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(r).toMatchObject({ ok: false, exitCode: 1, error: { code: CliErrorCode.API_ERROR } });
    expect(r.error?.message).toContain("ENOENT");
  });

  it("install succeeded but the copy on PATH did not move: shadowed-install error, not a false success", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { install: {} })); // npm 'succeeds', nothing changes on disk
    const r = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    expect(r).toMatchObject({ ok: false, updated: false, exitCode: 1, error: { code: CliErrorCode.API_ERROR } });
    expect(r.error?.message).toContain("shadowed by another installation");
    expect(r.error?.message).toContain(`still reports v${CURRENT}`);
  });

  it("relays the manager's stderr through onStderr as it arrives", async () => {
    const layout = globalLayout();
    const relayed: string[] = [];
    const npm = fakeSpawn(npmScripts(layout, { install: { stderr: "npm WARN deprecated foo\n", onSpawn: () => layout.writeInstalledVersion(LATEST) } }));
    const r = await runUpdate(CURRENT, {}, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl, onStderr: (c) => relayed.push(c) }));
    expect(r.updated).toBe(true);
    expect(relayed.join("")).toBe("npm WARN deprecated foo\n");
  });
});

// ── Registered command: output contract ─────────────────────────────────────

describe("registerUpdateCommand", () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    jest.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });
  afterEach(() => jest.restoreAllMocks());

  function program(version: string, d: Parameters<typeof registerUpdateCommand>[2]) {
    const p = new Command();
    p.exitOverride();
    registerUpdateCommand(p, version, d);
    return p;
  }

  it("--json: exactly one stdout document, zero stderr writes, documented keys, exit 0", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { install: { stderr: "npm WARN noisy\n", onSpawn: () => layout.writeInstalledVersion(LATEST) } }));
    const p = program(CURRENT, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    await p.parseAsync(["node", "test", "update", "--json"]);
    expect(stderrWrites).toEqual([]);
    expect(stdoutWrites).toHaveLength(1);
    const doc = JSON.parse(stdoutWrites[0]) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["checkedAt", "command", "current", "kind", "latest", "ok", "package", "updated"]);
    expect(doc).toEqual({ ok: true, kind: "npm", package: "@voyagier/cli", current: CURRENT, latest: LATEST, updated: true, command: "npm install -g @voyagier/cli@latest", checkedAt: FIXED_NOW.toISOString() });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--json on failure: error { code, message } inside the one document, exit 1", async () => {
    const linked = linkedLayout();
    const p = program(CURRENT, deps(linked.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: fakeSpawn().spawnImpl }));
    await p.parseAsync(["node", "test", "upgrade", "--json"]);
    expect(stderrWrites).toEqual([]);
    expect(stdoutWrites).toHaveLength(1);
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({ ok: false, kind: "git", latest: null, error: { code: CliErrorCode.VALIDATION } });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("text mode: relays npm stderr live, prints the result line, exit code follows the result", async () => {
    const layout = globalLayout();
    const npm = fakeSpawn(npmScripts(layout, { install: { stderr: "npm WARN noisy\n", onSpawn: () => layout.writeInstalledVersion(LATEST) } }));
    const p = program(CURRENT, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: npm.spawnImpl }));
    await p.parseAsync(["node", "test", "update"]);
    expect(stderrWrites.join("")).toContain("npm WARN noisy");
    expect(stdoutWrites.join("")).toContain(`Updated @voyagier/cli v${CURRENT} → v${LATEST}`);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--check --json: one document, exit 1 when outdated then 0 when current", async () => {
    const layout = globalLayout();
    const p = program(CURRENT, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: fakeSpawn().spawnImpl }));
    await p.parseAsync(["node", "test", "update", "--check", "--json"]);
    expect(JSON.parse(stdoutWrites[0])).toMatchObject({ ok: false, current: CURRENT, latest: LATEST, updated: false });
    expect(exitSpy).toHaveBeenLastCalledWith(1);
    const p2 = program(LATEST, deps(layout.scriptPath, { fetchImpl: registryFetch().fetchImpl, spawnImpl: fakeSpawn().spawnImpl }));
    await p2.parseAsync(["node", "test", "update", "--check", "--json"]);
    expect(JSON.parse(stdoutWrites[1])).toMatchObject({ ok: true, current: LATEST, latest: LATEST, updated: false });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
    expect(stderrWrites).toEqual([]);
  });
});

// Type-level: the result shape is what --json documents.
const _shape: UpdateResult = { ok: true, kind: "npm", package: "@voyagier/cli", current: "1", latest: "1", updated: false, checkedAt: "", exitCode: 0, lines: [] };
void _shape;
