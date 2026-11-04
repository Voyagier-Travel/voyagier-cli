import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";
// config.js is NOT mocked — it writes to the sandboxed VOYAGIER_CONFIG_DIR set by
// test/setup-env.ts, so we exercise the real credential persistence and assert
// on it via the same config API auth.ts uses.
import { saveCredentials, clearCredentials, credentialsExist, loadCredentials } from "../config.js";
import { makeMockRemote, jsonResponse, type Sent } from "../../test/mock-remote.js";
import type { McpToolDescriptor } from "../mcp-client/client.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockOpenBrowser = jest.fn();

jest.unstable_mockModule("../utils.js", () => ({
  // openBrowser is stubbed so no browser launches; sanitizeExternalText keeps
  // its real behaviour so the control-character assertions exercise it.
  openBrowser: mockOpenBrowser,
  sanitizeExternalText: (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""),
  sanitizeExternalData: (value: unknown) => value,
}));

// readline/promises drives the interactive prompt flows. The fake createInterface
// hands back a question() that pops scripted answers, so we can walk the login
// prompt sequence without a real TTY.
let scriptedAnswers: string[] = [];
const mockClose = jest.fn();
const mockQuestion = jest.fn(async () => scriptedAnswers.shift() ?? "");
jest.unstable_mockModule("readline/promises", () => ({
  createInterface: jest.fn(() => ({ question: mockQuestion, close: mockClose })),
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

type AuthModule = typeof import("./auth.js");
let authModule: AuthModule;

beforeAll(async () => {
  authModule = await import("./auth.js");
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const TEST_TOKEN = "voy_pat_test123";

const WHOAMI_TOOL: McpToolDescriptor = { name: "whoami", description: "Who am I", inputSchema: { type: "object", properties: {} } };
const TRAVELLER_TOOLS: McpToolDescriptor[] = [
  { name: "update_traveller", description: "Update a traveller", inputSchema: { type: "object", properties: {} } },
  { name: "add_traveller_document", description: "Add a document", inputSchema: { type: "object", properties: {} } },
  { name: "list_travellers", description: "List", inputSchema: { type: "object", properties: {} } },
];

function whoamiPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "u-1",
    email: "ada@voyagier.com",
    name: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    isAdmin: false,
    isTravelAdvisor: true,
    isTripPlanner: false,
    canMintPats: true,
    profile: { homeLocation: { name: "Boston", addressRegion: "MA", addressCountry: "US" } },
    role: "advisor",
    guidance: "rules…",
    ...overrides,
  };
}

function textResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** A whoami result the way a server with an outputSchema sends it: a human text block plus `structuredContent`. */
function structuredResult(payload: unknown) {
  return { content: [{ type: "text", text: "You are signed in." }], structuredContent: payload };
}

/** A scripted remote: whoami answers with `payload`; `tools` is the published list. */
function remote(
  opts: { payload?: unknown; tools?: McpToolDescriptor[]; structured?: boolean; intercept?: (sent: Sent, index: number) => Response | undefined } = {},
) {
  const whoami = () => (opts.structured ? structuredResult(opts.payload ?? whoamiPayload()) : textResult(opts.payload ?? whoamiPayload()));
  return makeMockRemote({
    tools: opts.tools ?? [WHOAMI_TOOL],
    onCall: (name) => (name === "whoami" ? whoami() : textResult({})),
    intercept: opts.intercept,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

let logs: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;
let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalCI = process.env.CI;

function buildProgram(deps: Parameters<AuthModule["registerAuthCommands"]>[1] = {}): Command {
  const p = new Command();
  p.exitOverride();
  authModule.registerAuthCommands(p, deps);
  return p;
}

function out(): string {
  return logs.join("\n");
}

function setInteractive(on: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  if (on) delete process.env.CI;
}

// `set-token -` reads via `for await (const chunk of stdin)`, where `stdin` is
// the `process.stdin` object captured by auth.ts's `import { stdin } from
// "process"`. Overriding its async iterator lets us feed scripted bytes without
// a real pipe. Returns a restore fn.
function mockStdin(data: string): () => void {
  const prev = Object.getOwnPropertyDescriptor(process.stdin, Symbol.asyncIterator);
  Object.defineProperty(process.stdin, Symbol.asyncIterator, {
    configurable: true,
    value: function () {
      const chunks = [Buffer.from(data, "utf-8")];
      let i = 0;
      return {
        next: async () =>
          i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  });
  return () => {
    if (prev) Object.defineProperty(process.stdin, Symbol.asyncIterator, prev);
    else delete (process.stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator];
  };
}

beforeEach(() => {
  mockOpenBrowser.mockReset();
  mockQuestion.mockClear();
  mockClose.mockClear();
  scriptedAnswers = [];
  clearCredentials();
  logs = [];
  logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  // Default non-interactive (matches jest's real environment).
  setInteractive(false);
});

afterEach(() => {
  logSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  clearCredentials();
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
});

// ── identityFromWhoami / formatIdentity ─────────────────────────────────────

describe("identityFromWhoami", () => {
  it("picks email, name, role flags, home base and role out of the whoami payload", () => {
    const id = authModule.identityFromWhoami(whoamiPayload({ isTripPlanner: true }));
    expect(id).toEqual({
      email: "ada@voyagier.com",
      name: "Ada Lovelace",
      roles: ["travel advisor", "trip planner"],
      role: "advisor",
      homeBase: "Boston, MA, US",
      tokenName: undefined,
    });
  });

  it("falls back to firstName + lastName, leaves home base undefined when the profile has none", () => {
    const id = authModule.identityFromWhoami(whoamiPayload({ name: undefined, profile: { homeLocation: null } }));
    expect(id.name).toBe("Ada Lovelace");
    expect(id.homeBase).toBeUndefined();
    expect(id.roles).toEqual(["travel advisor"]);
  });

  it("reads the token's audit label when the server reports it (tokenName or token.name)", () => {
    expect(authModule.identityFromWhoami(whoamiPayload({ tokenName: "cli-laptop" })).tokenName).toBe("cli-laptop");
    expect(authModule.identityFromWhoami(whoamiPayload({ token: { name: "ci-runner" } })).tokenName).toBe("ci-runner");
  });

  it("whoamiPayload prefers structuredContent over the text block, and falls back to parsed text", () => {
    const { whoamiPayload: pick } = authModule;
    const payload = whoamiPayload();
    expect(pick({ content: [{ type: "text", text: "You are signed in." }], structuredContent: payload })).toEqual(payload);
    // structuredContent wins even when the text block is JSON for someone else.
    expect(pick({ content: [{ type: "text", text: JSON.stringify(whoamiPayload({ email: "other@x.com" })) }], structuredContent: payload })).toEqual(payload);
    expect(pick({ content: [{ type: "text", text: JSON.stringify(payload) }] })).toEqual(payload);
  });

  it("never throws on a non-object payload", () => {
    expect(authModule.identityFromWhoami(null)).toEqual({ email: undefined, name: undefined, roles: [], role: undefined, homeBase: undefined, tokenName: undefined });
    expect(authModule.identityFromWhoami(["x"]).roles).toEqual([]);
    expect(authModule.identityFromWhoami("text").email).toBeUndefined();
  });
});

describe("formatIdentity", () => {
  it("prints user, roles, home base and the audit label", () => {
    const text = authModule.formatIdentity(authModule.identityFromWhoami(whoamiPayload({ tokenName: "cli-laptop" }))).join("\n");
    expect(text).toMatch(/User:\s+Ada Lovelace \(ada@voyagier\.com\)/);
    expect(text).toMatch(/Roles:\s+travel advisor · plans as advisor/);
    expect(text).toMatch(/Home base:\s+Boston, MA, US/);
    expect(text).toMatch(/Audit label:\s+cli-laptop/);
  });

  it("points at the web profile when no home base is set, and explains the audit label when the server omits it", () => {
    const text = authModule.formatIdentity(authModule.identityFromWhoami(whoamiPayload({ profile: {}, isTravelAdvisor: false }))).join("\n");
    expect(text).toMatch(/Roles:\s+traveller/);
    expect(text).toMatch(/Home base:\s+not set — set it at https:\/\/travel\.voyagier\.com\/me\/settings/);
    expect(text).toMatch(/Audit label:\s+the name you gave this token at https:\/\/travel\.voyagier\.com\/me\/settings\/tokens/);
  });
});

// ── travellerDataHint ────────────────────────────────────────────────────────

describe("travellerDataHint", () => {
  it("names the traveller tools that the live tool list publishes", () => {
    const hint = authModule.travellerDataHint(TRAVELLER_TOOLS);
    expect(hint).toContain("https://travel.voyagier.com/me/settings");
    expect(hint).toContain("voyagier update_traveller --help");
    expect(hint).toContain("voyagier add_traveller_document --help");
    expect(hint).not.toContain("list_travellers");
  });

  it("names only the tools that exist, and only the web profile when the list is unavailable", () => {
    expect(authModule.travellerDataHint([TRAVELLER_TOOLS[1]])).not.toContain("update_traveller");
    expect(authModule.travellerDataHint([TRAVELLER_TOOLS[1]])).toContain("add_traveller_document");
    const noList = authModule.travellerDataHint(null);
    expect(noList).toContain("https://travel.voyagier.com/me/settings");
    expect(noList).not.toContain("voyagier ");
  });
});

// ── set-token ────────────────────────────────────────────────────────────────

describe("auth set-token", () => {
  it("saves the token to the sandboxed config and stores nothing else", async () => {
    await buildProgram().parseAsync(["node", "v", "auth", "set-token", TEST_TOKEN]);
    expect(credentialsExist()).toBe(true);
    expect(loadCredentials()).toEqual({ token: TEST_TOKEN });
    expect(out()).toMatch(/Token saved/);
    expect(out()).toMatch(/voyagier auth status/);
  });

  it("no longer takes --url", async () => {
    await expect(
      buildProgram().parseAsync(["node", "v", "auth", "set-token", TEST_TOKEN, "--url", "https://dev.voyagier.com/api"]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
  });

  it("set-token -: reads the token from stdin, trims it, and saves it (M4)", async () => {
    // Leading/trailing whitespace + trailing newline must be stripped so the
    // saved token matches what was piped.
    const restore = mockStdin("  voy_pat_piped123\n");
    try {
      await buildProgram().parseAsync(["node", "v", "auth", "set-token", "-"]);
    } finally {
      restore();
    }
    expect(credentialsExist()).toBe(true);
    expect(loadCredentials()?.token).toBe("voy_pat_piped123");
  });

  it("set-token -: rejects empty/whitespace-only stdin with a VALIDATION error (M4)", async () => {
    const restore = mockStdin("   \n");
    let caught: unknown;
    try {
      await buildProgram().parseAsync(["node", "v", "auth", "set-token", "-"]);
    } catch (err) {
      caught = err;
    } finally {
      restore();
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((caught as CliError).message).toMatch(/No token received on stdin/);
    expect(credentialsExist()).toBe(false);
  });
});

// ── logout ─────────────────────────────────────────────────────────────────

describe("auth logout", () => {
  it("clears saved credentials", async () => {
    saveCredentials(TEST_TOKEN);
    expect(credentialsExist()).toBe(true);
    await buildProgram().parseAsync(["node", "v", "auth", "logout"]);
    expect(credentialsExist()).toBe(false);
    expect(out()).toMatch(/Credentials cleared/);
  });
});

// ── status ────────────────────────────────────────────────────────────────

describe("auth status", () => {
  it("reports not-authenticated when no credentials exist, without touching the network", async () => {
    const { client, sent } = remote();
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/Not authenticated/);
    expect(sent).toHaveLength(0);
  });

  it("shows a masked token, the MCP URL and the whoami identity", async () => {
    saveCredentials(TEST_TOKEN);
    const { client, sent } = remote({ payload: whoamiPayload({ isTripPlanner: true, tokenName: "cli-laptop" }) });

    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    const text = out();
    expect(text).toMatch(/MCP URL:\s+https:\/\/mcp\.voyagier\.com\/api\/mcp/);
    expect(text).toMatch(/User:\s+Ada Lovelace \(ada@voyagier\.com\)/);
    expect(text).toMatch(/Roles:\s+travel advisor, trip planner/);
    expect(text).toMatch(/Home base:\s+Boston, MA, US/);
    expect(text).toMatch(/Audit label:\s+cli-laptop/);
    expect(text).toMatch(/MCP: connected/);
    // Token is masked, never printed in full.
    expect(text).not.toContain(TEST_TOKEN);
    // Identity came from the whoami tool, not a GraphQL query.
    const call = sent.find((s) => s.body.method === "tools/call");
    expect(call?.body.params).toEqual({ name: "whoami", arguments: {} });
    // Nothing about the identity is cached on disk.
    expect(loadCredentials()).toEqual({ token: TEST_TOKEN });
  });

  it("reads the identity from structuredContent when the server sends a text summary plus structured fields", async () => {
    saveCredentials(TEST_TOKEN);
    const { client } = remote({ structured: true, payload: whoamiPayload({ isTripPlanner: true, tokenName: "cli-laptop" }) });
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    const text = out();
    expect(text).toMatch(/User:\s+Ada Lovelace \(ada@voyagier\.com\)/);
    expect(text).toMatch(/Roles:\s+travel advisor, trip planner/);
    expect(text).toMatch(/Home base:\s+Boston, MA, US/);
    expect(text).toMatch(/Audit label:\s+cli-laptop/);
    expect(text).not.toMatch(/User:\s+unknown/);
  });

  it("strips control characters from server-supplied identity text", async () => {
    saveCredentials(TEST_TOKEN);
    const { client } = remote({ payload: whoamiPayload({ name: "Ada\u001b[31m Lovelace", profile: { homeLocation: { name: "Bos\u0007ton" } } }) });
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    expect(out()).not.toContain("\u001b");
    expect(out()).not.toContain("\u0007");
    expect(out()).toMatch(/Home base:\s+Boston/);
  });

  it("reports a rejected token when the server answers 401", async () => {
    saveCredentials(TEST_TOKEN);
    const { client } = remote({ intercept: () => jsonResponse({ error: "unauthorized" }, { status: 401 }) });
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/MCP: token rejected by https:\/\/mcp\.voyagier\.com\/api\/mcp/);
    expect(out()).toMatch(/voyagier auth login/);
  });

  it("surfaces a non-auth MCP error message", async () => {
    saveCredentials(TEST_TOKEN);
    const { client } = remote({
      intercept: (sent) =>
        sent.body.method === "tools/call"
          ? jsonResponse({ jsonrpc: "2.0", id: sent.body.id, error: { code: -32603, message: "boom upstream" } })
          : undefined,
    });
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    expect(out()).toMatch(/MCP: .*boom upstream/);
  });

  it("reports an insecure VOYAGIER_MCP_URL instead of sending the token", async () => {
    saveCredentials(TEST_TOKEN);
    const prev = process.env.VOYAGIER_MCP_URL;
    process.env.VOYAGIER_MCP_URL = "http://evil.example.com/mcp";
    const { client, sent } = remote();
    try {
      await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "status"]);
    } finally {
      if (prev === undefined) delete process.env.VOYAGIER_MCP_URL;
      else process.env.VOYAGIER_MCP_URL = prev;
    }
    expect(out()).toMatch(/MCP URL: .*Insecure URL/);
    expect(sent).toHaveLength(0);
  });
});

// ── login ────────────────────────────────────────────────────────────────

describe("auth login", () => {
  it("non-interactive: prints PAT instructions (with the audit-label note) and does not save", async () => {
    setInteractive(false);
    await buildProgram().parseAsync(["node", "v", "auth", "login"]);
    expect(out()).toMatch(/Generate a Personal Access Token/);
    expect(out()).toMatch(/https:\/\/travel\.voyagier\.com\/me\/settings\/tokens/);
    expect(out()).toMatch(/audit label/);
    expect(out()).toMatch(/voyagier auth set-token -/);
    expect(credentialsExist()).toBe(false);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  it("non-interactive: --web-url changes the web origin the tokens page is derived from", async () => {
    setInteractive(false);
    await buildProgram().parseAsync(["node", "v", "auth", "login", "--web-url", "https://dev.voyagier.com/some/path"]);
    expect(out()).toMatch(/https:\/\/dev\.voyagier\.com\/me\/settings\/tokens/);
    expect(out()).not.toMatch(/some\/path/);
  });

  it("rejects a non-http(s) --web-url", async () => {
    await expect(buildProgram().parseAsync(["node", "v", "auth", "login", "--web-url", "file:///etc/passwd"])).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    await expect(buildProgram().parseAsync(["node", "v", "auth", "login", "--web-url", "not a url"])).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("interactive: opens the browser, saves the pasted token, verifies it via whoami and prints the identity", async () => {
    setInteractive(true);
    scriptedAnswers = [TEST_TOKEN];
    const { client, sent } = remote();

    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "login"]);

    expect(mockOpenBrowser).toHaveBeenCalledWith("https://travel.voyagier.com/me/settings/tokens");
    expect(credentialsExist()).toBe(true);
    expect(loadCredentials()).toEqual({ token: TEST_TOKEN });
    expect(out()).toMatch(/Logged in as .*Ada Lovelace.* \(ada@voyagier\.com\)/);
    expect(out()).toMatch(/Home base:\s+Boston, MA, US/);
    expect(out()).not.toMatch(/airport/i);
    expect(sent.find((s) => s.body.method === "tools/call")?.body.params).toEqual({ name: "whoami", arguments: {} });
  });

  it("interactive: cancels cleanly on an empty token", async () => {
    setInteractive(true);
    scriptedAnswers = [""];
    const { client, sent } = remote();
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "login"]);
    expect(out()).toMatch(/Cancelled/);
    expect(credentialsExist()).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("interactive: saves the token but warns when verification fails", async () => {
    setInteractive(true);
    scriptedAnswers = [TEST_TOKEN];
    const { client } = remote({ intercept: () => jsonResponse({ error: "unauthorized" }, { status: 401 }) });
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "login"]);
    expect(credentialsExist()).toBe(true);
    expect(out()).toMatch(/Token saved/);
    expect(out()).toMatch(/Could not verify/);
  });
});

// ── setup ────────────────────────────────────────────────────────────────

describe("auth setup", () => {
  it("points at the web profile and the traveller tools the server publishes", async () => {
    saveCredentials(TEST_TOKEN);
    const { client } = remote({ tools: [WHOAMI_TOOL, ...TRAVELLER_TOOLS] });
    await buildProgram({ createClient: () => client }).parseAsync(["node", "v", "auth", "setup"]);
    expect(logs).toHaveLength(1);
    expect(out()).toContain("https://travel.voyagier.com/me/settings");
    expect(out()).toContain("voyagier update_traveller --help");
    expect(out()).toContain("voyagier add_traveller_document --help");
    // Nothing is collected or stored locally.
    expect(mockQuestion).not.toHaveBeenCalled();
    expect(loadCredentials()).toEqual({ token: TEST_TOKEN });
  });

  it("prints only the web profile when not authenticated or when the tool list cannot be fetched", async () => {
    const { client: idle, sent } = remote();
    await buildProgram({ createClient: () => idle }).parseAsync(["node", "v", "auth", "setup"]);
    expect(sent).toHaveLength(0);
    expect(out()).toContain("https://travel.voyagier.com/me/settings");
    expect(out()).not.toContain("voyagier update_traveller");

    logs.length = 0;
    saveCredentials(TEST_TOKEN);
    const { client: failing } = remote({ intercept: () => jsonResponse({ error: "down" }, { status: 503 }) });
    await buildProgram({ createClient: () => failing }).parseAsync(["node", "v", "auth", "setup"]);
    expect(out()).toContain("https://travel.voyagier.com/me/settings");
    expect(out()).not.toContain("voyagier update_traveller");
  });

  it("no longer takes the traveller-profile flags", async () => {
    saveCredentials(TEST_TOKEN);
    for (const flag of ["--airports", "--cabin", "--skip-passport", "--skip-ff"]) {
      await expect(buildProgram().parseAsync(["node", "v", "auth", "setup", flag, "x"])).rejects.toMatchObject({ code: "commander.unknownOption" });
    }
  });
});
