import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";
import type { StreamCallbacks } from "../api.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockStreamChat = jest.fn<(sessionId: string, message: string, cb: StreamCallbacks) => Promise<void>>();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  streamChat: mockStreamChat,
}));

// The REPL uses readline.createInterface. The fake captures the "line"/"close"
// handlers so tests can drive a turn (and close) without a real TTY.
let rlHandlers: Record<string, (arg?: unknown) => unknown>;
const fakeRl = {
  prompt: jest.fn(),
  on: jest.fn((event: string, cb: (arg?: unknown) => unknown) => {
    rlHandlers[event] = cb;
    return fakeRl;
  }),
  close: jest.fn(),
};
jest.unstable_mockModule("readline", () => ({
  createInterface: jest.fn(() => fakeRl),
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerChatCommands: (program: Command) => void;

beforeAll(async () => {
  ({ registerChatCommands } = await import("./chat.js"));
});

// ── Helpers ────────────────────────────────────────────────────────────────

let logs: string[];
let stdoutOut: string[];
let stderrOut: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;
let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let exitSpy: jest.SpiedFunction<typeof process.exit>;
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerChatCommands(p);
  return p;
}

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockStreamChat.mockReset();
  fakeRl.prompt.mockClear();
  fakeRl.on.mockClear();
  fakeRl.close.mockClear();
  rlHandlers = {};
  logs = [];
  stdoutOut = [];
  stderrOut = [];
  logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((b: string | Uint8Array) => {
    stdoutOut.push(typeof b === "string" ? b : Buffer.from(b).toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((b: string | Uint8Array) => {
    stderrOut.push(typeof b === "string" ? b : Buffer.from(b).toString());
    return true;
  });
  exitSpy = jest.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined as never) as typeof process.exit);
  // Default to a TTY so no test accidentally blocks on readStdin.
  setTty(true);
});

afterEach(() => {
  logSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
});

// ── chat --list ────────────────────────────────────────────────────────────

describe("chat --list", () => {
  it("lists sessions with id, title, and paginates page=1 limit=20", async () => {
    mockGraphql.mockResolvedValueOnce({
      chatSessions: {
        items: [
          { id: "sess-12345678abc", title: "Japan trip", updatedAt: "2026-05-01T00:00:00Z" },
          { id: "sess-99", title: "", updatedAt: "2026-05-02T00:00:00Z" },
        ],
        count: 2,
      },
    });
    await buildProgram().parseAsync(["node", "v", "chat", "--list"]);
    const [query, vars] = mockGraphql.mock.calls[0];
    expect(String(query)).toContain("chatSessions");
    expect(vars).toEqual({ page: 1, limit: 20 });
    const text = logs.join("\n");
    expect(text).toMatch(/Chat Sessions \(2 total\)/);
    expect(text).toMatch(/sess-123/); // first 8 chars of the id
    expect(text).toMatch(/\(untitled\)/); // empty title fallback
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it("prints a friendly message when there are no sessions", async () => {
    mockGraphql.mockResolvedValueOnce({ chatSessions: { items: [], count: 0 } });
    await buildProgram().parseAsync(["node", "v", "chat", "--list"]);
    expect(logs.join("\n")).toMatch(/No chat sessions found/);
  });

  it("reports a listing failure on stderr without throwing", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("list boom"));
    await buildProgram().parseAsync(["node", "v", "chat", "--list"]);
    expect(stderrOut.join("")).toMatch(/Failed to list sessions/);
  });
});

// ── chat --message (non-interactive single turn) ─────────────────────────────

describe("chat --message (single turn)", () => {
  it("creates a session then streams the reply, printing text + tool markers", async () => {
    mockGraphql.mockResolvedValueOnce({ createChatSession: { id: "sess-new", title: "" } });
    mockStreamChat.mockImplementation(async (_sessionId, _message, cb) => {
      cb.onTextDelta("Here are some flights");
      cb.onToolCall?.("search_flights");
      cb.onError?.("minor hiccup");
    });

    await buildProgram().parseAsync(["node", "v", "chat", "--message", "find flights to Tokyo"]);

    // No tripPlanId in the create input (none supplied).
    expect(mockGraphql.mock.calls[0][1]).toBeUndefined();
    expect(mockStreamChat).toHaveBeenCalledWith("sess-new", "find flights to Tokyo", expect.any(Object));
    expect(stdoutOut.join("")).toMatch(/Here are some flights/);
    expect(stderrOut.join("")).toMatch(/\[search_flights\]/);
    expect(stderrOut.join("")).toMatch(/Error: minor hiccup/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("passes the plan id into the session input with -p", async () => {
    mockGraphql.mockResolvedValueOnce({ createChatSession: { id: "sess-plan", title: "" } });
    mockStreamChat.mockResolvedValue(undefined);
    await buildProgram().parseAsync(["node", "v", "chat", "-p", "plan-1", "-m", "hi"]);
    expect(mockGraphql.mock.calls[0][1]).toEqual({ input: { tripPlanId: "plan-1" } });
  });

  it("reuses an explicit --session without creating a new one", async () => {
    mockStreamChat.mockResolvedValue(undefined);
    await buildProgram().parseAsync(["node", "v", "chat", "--session", "sess-existing", "-m", "hi"]);
    expect(mockGraphql).not.toHaveBeenCalled(); // no createChatSession
    expect(mockStreamChat).toHaveBeenCalledWith("sess-existing", "hi", expect.any(Object));
  });

  it("wraps a non-CliError session-create failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("create boom"));
    await expect(
      buildProgram().parseAsync(["node", "v", "chat", "-m", "hi"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it("propagates a CliError from session-create unchanged", async () => {
    mockGraphql.mockRejectedValueOnce(new CliError(CliErrorCode.AUTH_FAILED, "nope"));
    await expect(
      buildProgram().parseAsync(["node", "v", "chat", "-m", "hi"]),
    ).rejects.toMatchObject({ code: CliErrorCode.AUTH_FAILED });
  });

  it("wraps a streaming failure as API_ERROR", async () => {
    mockGraphql.mockResolvedValueOnce({ createChatSession: { id: "sess-new", title: "" } });
    mockStreamChat.mockRejectedValueOnce(new Error("stream boom"));
    await expect(
      buildProgram().parseAsync(["node", "v", "chat", "-m", "hi"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

// ── chat --model (per-session model selection) ───────────────────────────────

describe("chat --model", () => {
  const CATALOG = {
    availableChatModels: [
      { provider: "Anthropic", modelId: "claude-opus-4-8", displayName: "Opus", isProviderDefault: true, isUserDefault: false, source: "user" },
      { provider: "Gemini", modelId: "gemini-2.5-pro", displayName: "Gemini", isProviderDefault: true, isUserDefault: false, source: "house-env" },
    ],
  };

  it("resolves provider from the catalog BEFORE creating the session, then updates it", async () => {
    mockGraphql
      .mockResolvedValueOnce(CATALOG) // availableChatModels (resolve — must precede create)
      .mockResolvedValueOnce({ createChatSession: { id: "sess-new", title: "" } }) // create
      .mockResolvedValueOnce({ updateChatSessionModel: { id: "sess-new", aiProvider: "Gemini", aiModelId: "gemini-2.5-pro" } });
    mockStreamChat.mockResolvedValue(undefined);

    await buildProgram().parseAsync(["node", "v", "chat", "-m", "hi", "--model", "gemini-2.5-pro"]);

    // Catalog lookup first, session create second — an invalid id must fail
    // before any session exists.
    expect(String(mockGraphql.mock.calls[0][0])).toContain("availableChatModels");
    expect(String(mockGraphql.mock.calls[1][0])).toContain("createChatSession");
    const [query, vars] = mockGraphql.mock.calls[2];
    expect(String(query)).toContain("updateChatSessionModel");
    expect(vars).toEqual({ sessionId: "sess-new", provider: "Gemini", modelId: "gemini-2.5-pro" });
    expect(mockStreamChat).toHaveBeenCalledWith("sess-new", "hi", expect.any(Object));
  });

  it("applies the model on a resumed --session without creating one", async () => {
    mockGraphql
      .mockResolvedValueOnce(CATALOG) // availableChatModels
      .mockResolvedValueOnce({ updateChatSessionModel: { id: "sess-x", aiProvider: "Anthropic", aiModelId: "claude-opus-4-8" } });
    mockStreamChat.mockResolvedValue(undefined);

    await buildProgram().parseAsync(["node", "v", "chat", "--session", "sess-x", "-m", "hi", "--model", "claude-opus-4-8"]);

    // First call is the catalog lookup (no createChatSession), second the update.
    expect(String(mockGraphql.mock.calls[0][0])).toContain("availableChatModels");
    expect(mockGraphql.mock.calls[1][1]).toEqual({ sessionId: "sess-x", provider: "Anthropic", modelId: "claude-opus-4-8" });
  });

  it("errors with valid ids, never streams, and never creates a session when the model is unknown", async () => {
    mockGraphql.mockResolvedValueOnce(CATALOG);
    await expect(
      buildProgram().parseAsync(["node", "v", "chat", "-m", "hi", "--model", "bogus"]),
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND, message: expect.stringContaining("claude-opus-4-8") });
    expect(mockStreamChat).not.toHaveBeenCalled();
    // No orphaned session: createChatSession must never have been attempted.
    for (const call of mockGraphql.mock.calls) {
      expect(String(call[0])).not.toContain("createChatSession");
    }
  });

  it("surfaces an older-server rejection as a clear unsupported error (before any session is created)", async () => {
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.SCHEMA_DRIFT, 'Cannot query field "availableChatModels" on type "Query".'),
    );
    await expect(
      buildProgram().parseAsync(["node", "v", "chat", "-m", "hi", "--model", "gemini-2.5-pro"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR, message: expect.stringContaining("not supported by this server yet") });
    expect(mockStreamChat).not.toHaveBeenCalled();
    for (const call of mockGraphql.mock.calls) {
      expect(String(call[0])).not.toContain("createChatSession");
    }
  });
});

// ── piped stdin (non-TTY, no --message) ──────────────────────────────────────

describe("chat via piped stdin", () => {
  it("reads the message from stdin when not a TTY and no --message", async () => {
    setTty(false);
    const stdinOnSpy = jest
      .spyOn(process.stdin, "on")
      .mockImplementation(((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === "data") cb(Buffer.from("piped question"));
        if (event === "end") cb();
        return process.stdin;
      }) as typeof process.stdin.on);

    mockGraphql.mockResolvedValueOnce({ createChatSession: { id: "sess-piped", title: "" } });
    mockStreamChat.mockResolvedValue(undefined);

    await buildProgram().parseAsync(["node", "v", "chat"]);

    expect(mockStreamChat).toHaveBeenCalledWith("sess-piped", "piped question", expect.any(Object));
    stdinOnSpy.mockRestore();
  });
});

// ── interactive REPL (readline mocked) ───────────────────────────────────────

describe("chat interactive REPL", () => {
  async function startRepl(): Promise<void> {
    setTty(true); // TTY + no --message → REPL (skips readStdin)
    mockGraphql.mockResolvedValueOnce({ createChatSession: { id: "sess-repl", title: "New chat" } });
    await buildProgram().parseAsync(["node", "v", "chat"]);
  }

  it("announces a new session and starts prompting", async () => {
    await startRepl();
    expect(logs.join("\n")).toMatch(/New session: sess-repl/);
    expect(logs.join("\n")).toMatch(/Voyagier AI Trip Planner/);
    expect(fakeRl.prompt).toHaveBeenCalled();
    expect(typeof rlHandlers.line).toBe("function");
    expect(typeof rlHandlers.close).toBe("function");
  });

  it("streams a turn and summarizes tool results inline", async () => {
    await startRepl();
    mockStreamChat.mockImplementation(async (_s, _m, cb) => {
      cb.onTextDelta("Sure!");
      cb.onToolCall?.("search_flights");
      cb.onToolResult?.("search_flights", JSON.stringify({ options: [1, 2, 3] }));
      cb.onToolResult?.("search_hotels", { options: [1] });
      cb.onToolResult?.("createTripPlan", { title: "Japan" });
      cb.onToolResult?.("addTraveller", { firstName: "Ada", lastName: "Lovelace" });
      cb.onToolResult?.("listTravellers", { travellers: [1, 2] });
      cb.onToolResult?.("updateTraveller", {}); // default "traveller updated"
      cb.onToolResult?.("noop", {}); // returns null → no line
      cb.onToolResult?.("search_flights", "{not-json"); // parse error → skipped
      cb.onError?.("something off");
    });

    await rlHandlers.line("plan a trip to Japan");

    const out = stdoutOut.join("");
    expect(out).toMatch(/Sure!/);
    expect(out).toMatch(/\[calling search_flights\.\.\.\]/);
    expect(out).toMatch(/3 flight options found/);
    expect(out).toMatch(/1 hotel options found/);
    expect(out).toMatch(/plan created: Japan/);
    expect(out).toMatch(/added Ada Lovelace/);
    expect(out).toMatch(/2 travellers/);
    expect(out).toMatch(/traveller updated/);
    expect(out).toMatch(/Error: something off/);
    // Re-prompts after the turn (initial prompt + this one).
    expect(fakeRl.prompt.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores an empty line and just re-prompts", async () => {
    await startRepl();
    const before = fakeRl.prompt.mock.calls.length;
    await rlHandlers.line("   ");
    expect(mockStreamChat).not.toHaveBeenCalled();
    expect(fakeRl.prompt.mock.calls.length).toBe(before + 1);
  });

  it("surfaces a streaming error inside the REPL turn", async () => {
    await startRepl();
    mockStreamChat.mockRejectedValueOnce(new Error("repl stream boom"));
    await rlHandlers.line("hello");
    expect(stderrOut.join("")).toMatch(/Error: repl stream boom/);
  });

  it("ends the session and exits on close", async () => {
    await startRepl();
    // The close handler is async now (it drains telemetry via gracefulExit
    // before exit, VOY-1765), so await it before asserting the exit happened.
    await rlHandlers.close();
    expect(logs.join("\n")).toMatch(/Session ended/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
