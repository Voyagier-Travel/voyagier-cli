import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { McpClient } from "../mcp-client/client.js";
import { clearToolsCache, readToolsCache, writeToolsCache } from "../mcp-client/tools-cache.js";
import { compareSemver, registerDoctorCommand, rollUpStatus, runDoctor, type DoctorReport } from "./doctor.js";

/**
 * `voyagier doctor` against a scripted MCP server. Every collaborator is
 * injected (client factory, credentials, registry fetch), so no module mocks.
 */

const URL = "https://mcp.example.test/api/mcp";
const TOOLS = [{ name: "plans_list" }, { name: "plan_status" }];

type Mode = "ok" | "ok-with-whoami" | "auth" | "network" | "server-error" | "whoami-fails";

function scriptedClient(mode: Mode): McpClient {
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number; params?: { name?: string } };
    const respond = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode === "auth") return new Response("", { status: 401 });
    if (mode === "server-error") return new Response("oops", { status: 500, statusText: "Internal Server Error" });
    if (body.method === "initialize") return respond({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "voyagier", version: "1.2.3" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      const tools = mode === "ok" ? TOOLS : [...TOOLS, { name: "whoami" }];
      return respond({ jsonrpc: "2.0", id: body.id, result: { tools } });
    }
    if (body.method === "tools/call" && body.params?.name === "whoami") {
      if (mode === "whoami-fails") return respond({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "profile unavailable" }] } });
      return respond({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ me: { email: "jane@example.com", isTravelAdvisor: true } }) }] } });
    }
    return respond({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
  }) as unknown as typeof fetch;
  return new McpClient({ url: URL, token: "t", fetchImpl });
}

const registryFetch = (version = "1.8.1") =>
  (async () => new Response(JSON.stringify({ version }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

function check(report: DoctorReport, name: string) {
  return report.checks.find((c) => c.name === name)!;
}

const stateDirsCreated: string[] = [];
function setStateDir(dir: string): string {
  process.env.VOYAGIER_STATE_DIR = dir;
  stateDirsCreated.push(dir);
  return dir;
}
function makeStateDir(payloads: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "vd-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(payloads)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return setStateDir(dir);
}

describe("rollUpStatus", () => {
  it("returns PASS when all checks pass", () => {
    expect(rollUpStatus([{ name: "a", status: "PASS", message: "" }])).toBe("PASS");
  });
  it("returns WARN when any check warns and none fail", () => {
    expect(rollUpStatus([{ name: "a", status: "PASS", message: "" }, { name: "b", status: "WARN", message: "" }])).toBe("WARN");
  });
  it("returns FAIL when any check fails (overrides WARN)", () => {
    expect(rollUpStatus([{ name: "a", status: "WARN", message: "" }, { name: "b", status: "FAIL", message: "" }])).toBe("FAIL");
  });
});

describe("runDoctor", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.VOYAGIER_MCP_URL = URL;
    clearToolsCache();
    setStateDir(mkdtempSync(join(tmpdir(), "vd-empty-")));
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    clearToolsCache();
    for (const dir of stateDirsCreated) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    stateDirsCreated.length = 0;
  });

  it("PASSes auth + mcp (tool count, refreshed cache) and skips whoami when the server lacks the tool", async () => {
    writeToolsCache({ url: URL, fetchedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), tools: [{ name: "old" }] });
    const report = await runDoctor("1.8.1", { createClient: () => scriptedClient("ok"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(report, "auth").status).toBe("PASS");
    const mcp = check(report, "mcp");
    expect(mcp.status).toBe("PASS");
    expect(mcp.message).toContain(`${URL} · 2 tools · server voyagier 1.2.3`);
    expect(mcp.message).toMatch(/cache was 3h ago/);
    expect(mcp.details).toMatchObject({ toolCount: 2, tools: ["plan_status", "plans_list"] });
    expect(readToolsCache()?.tools).toEqual(TOOLS);
    const whoami = check(report, "whoami");
    expect(whoami.status).toBe("PASS");
    expect(whoami.message).toMatch(/does not publish a whoami tool yet/);
    expect(check(report, "version")).toMatchObject({ status: "PASS", message: "Running latest (v1.8.1)" });
    expect(report.overall).toBe("PASS");
  });

  it("calls whoami when the server publishes it and reports the identity", async () => {
    const report = await runDoctor("1.8.1", { createClient: () => scriptedClient("ok-with-whoami"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(report, "whoami")).toMatchObject({ status: "PASS", message: "Authenticated as jane@example.com (traveladvisor)" });
  });

  it("WARNs (not FAILs) when whoami itself errors", async () => {
    const report = await runDoctor("1.8.1", { createClient: () => scriptedClient("whoami-fails"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(report, "whoami")).toMatchObject({ status: "WARN", message: expect.stringContaining("profile unavailable") });
    expect(report.overall).toBe("WARN");
  });

  it("FAILs auth when no credentials exist and skips the network checks", async () => {
    let touched = false;
    const report = await runDoctor("1.8.1", {
      createClient: () => {
        touched = true;
        return scriptedClient("ok");
      },
      credentialsExist: () => false,
      fetchImpl: registryFetch(),
    });
    expect(check(report, "auth").status).toBe("FAIL");
    expect(check(report, "auth").message).toMatch(/voyagier auth login/);
    expect(check(report, "mcp").status).toBe("WARN");
    expect(check(report, "whoami").status).toBe("WARN");
    expect(touched).toBe(false);
    expect(report.overall).toBe("FAIL");
  });

  it("FAILs mcp when the token is rejected", async () => {
    const report = await runDoctor("1.8.1", { createClient: () => scriptedClient("auth"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(report, "mcp")).toMatchObject({ status: "FAIL", message: expect.stringContaining("Token rejected") });
    expect(check(report, "whoami").status).toBe("WARN");
    expect(report.overall).toBe("FAIL");
  });

  it("FAILs mcp on a network error and WARNs on other server errors", async () => {
    const net = await runDoctor("1.8.1", { createClient: () => scriptedClient("network"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(net, "mcp")).toMatchObject({ status: "FAIL", message: expect.stringContaining("could not reach") });
    const srv = await runDoctor("1.8.1", { createClient: () => scriptedClient("server-error"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(srv, "mcp")).toMatchObject({ status: "WARN", message: expect.stringContaining("500") });
  });

  it("FAILs mcp when VOYAGIER_MCP_URL is insecure", async () => {
    process.env.VOYAGIER_MCP_URL = "http://mcp.example.test/api/mcp";
    const report = await runDoctor("1.8.1", { createClient: () => scriptedClient("ok"), credentialsExist: () => true, fetchImpl: registryFetch() });
    expect(check(report, "mcp")).toMatchObject({ status: "FAIL", message: expect.stringContaining("Insecure") });
  });

  it("WARNs when a newer version is on npm, and when the registry is unreachable", async () => {
    const outdated = await runDoctor("1.8.1", { createClient: () => scriptedClient("ok"), credentialsExist: () => true, fetchImpl: registryFetch("1.9.0") });
    expect(check(outdated, "version")).toMatchObject({ status: "WARN", details: { current: "1.8.1", latest: "1.9.0" } });
    const offline = await runDoctor("1.8.1", {
      createClient: () => scriptedClient("ok"),
      credentialsExist: () => true,
      fetchImpl: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    });
    expect(check(offline, "version")).toMatchObject({ status: "WARN", message: expect.stringContaining("offline") });
    expect(offline.overall).toBe("WARN");
  });

  describe("state-files", () => {
    const deps = () => ({ createClient: () => scriptedClient("ok"), credentialsExist: () => true, fetchImpl: registryFetch() });

    it("reports PASS when no state dir exists (clean install)", async () => {
      process.env.VOYAGIER_STATE_DIR = join(tmpdir(), "vd-nonexistent-" + Date.now());
      const r = await runDoctor("1.8.1", deps());
      expect(check(r, "state-files")).toMatchObject({ status: "PASS", message: expect.stringContaining("clean install") });
    });

    it("reports PASS when state dir is empty", async () => {
      makeStateDir({});
      expect(check(await runDoctor("1.8.1", deps()), "state-files").status).toBe("PASS");
    });

    it("reports PASS for fresh JSON with embedded ISO timestamp", async () => {
      makeStateDir({ "last-search.json": { timestamp: new Date().toISOString(), data: {} } });
      expect(check(await runDoctor("1.8.1", deps()), "state-files").status).toBe("PASS");
    });

    it("reports WARN when embedded timestamp is older than 24h (even if file mtime is fresh)", async () => {
      makeStateDir({ "last-search.json": { timestamp: new Date(Date.now() - 48 * 3600_000).toISOString(), data: {} } });
      const r = await runDoctor("1.8.1", deps());
      expect(check(r, "state-files")).toMatchObject({ status: "WARN", message: expect.stringMatching(/older than 24h/) });
      expect(r.overall).toBe("WARN");
    });

    it("reports WARN when a state file is corrupt JSON", async () => {
      makeStateDir({ "last-search.json": "{ this is not json" });
      expect(check(await runDoctor("1.8.1", deps()), "state-files")).toMatchObject({ status: "WARN", details: { corrupt: ["last-search.json"] } });
    });

    it("falls back to mtime when payload omits timestamp (legacy file)", async () => {
      makeStateDir({ "last-search.json": { data: { foo: "bar" } } });
      expect(check(await runDoctor("1.8.1", deps()), "state-files").status).toBe("PASS");
    });
  });
});

describe("voyagier doctor (command)", () => {
  const savedEnv = { ...process.env };
  let stdoutSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let out: string[];
  beforeEach(() => {
    process.env.VOYAGIER_MCP_URL = URL;
    clearToolsCache();
    setStateDir(mkdtempSync(join(tmpdir(), "vd-empty-")));
    out = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    clearToolsCache();
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
    for (const dir of stateDirsCreated) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    stateDirsCreated.length = 0;
  });

  it("--json emits { ok, data } and exits 0 on PASS/WARN", async () => {
    const p = new Command().exitOverride();
    registerDoctorCommand(p, "1.8.1", { createClient: () => scriptedClient("ok"), credentialsExist: () => true, fetchImpl: registryFetch() });
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const payload = JSON.parse(out.join("")) as { ok: boolean; data: DoctorReport };
    expect(payload.ok).toBe(true);
    expect(payload.data.checks.map((c) => c.name)).toEqual(["auth", "mcp", "whoami", "state-files", "version"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("--json reports ok:false and exits 1 on FAIL", async () => {
    const p = new Command().exitOverride();
    registerDoctorCommand(p, "1.8.1", { createClient: () => scriptedClient("auth"), credentialsExist: () => true, fetchImpl: registryFetch() });
    await p.parseAsync(["node", "test", "doctor", "--json"]);
    const payload = JSON.parse(out.join("")) as { ok: boolean; data: DoctorReport };
    expect(payload.ok).toBe(false);
    expect(payload.data.overall).toBe("FAIL");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("human output lists every check with its message", async () => {
    const p = new Command().exitOverride();
    registerDoctorCommand(p, "1.8.1", { createClient: () => scriptedClient("ok"), credentialsExist: () => true, fetchImpl: registryFetch() });
    await p.parseAsync(["node", "test", "doctor"]);
    const text = out.join("\n");
    expect(text).toContain("Voyagier CLI Doctor");
    expect(text).toContain("2 tools");
    expect(text).toContain("All checks passed.");
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("2.0.0", "2.0.0")).toBe(0);
  });
  it("returns -1 when current < latest", () => {
    expect(compareSemver("1.8.1", "1.9.0")).toBe(-1);
    expect(compareSemver("1.8.1", "2.0.0")).toBe(-1);
  });
  it("returns 1 when current > latest (dev/prerelease ahead of npm)", () => {
    expect(compareSemver("2.1.0", "2.0.0")).toBe(1);
  });
  it("treats prerelease versions as < their release counterpart per semver spec", () => {
    expect(compareSemver("2.0.0-next.0", "2.0.0")).toBe(-1);
    expect(compareSemver("2.0.0", "2.0.0-next.0")).toBe(1);
  });
  it("2.0.1-next.0 is ahead of 2.0.0", () => {
    expect(compareSemver("2.0.1-next.0", "2.0.0")).toBe(1);
  });
  it("returns 0 (no false positive) when either input is unparseable", () => {
    expect(compareSemver("garbage", "2.0.0")).toBe(0);
    expect(compareSemver("2.0.0", "")).toBe(0);
  });
});
