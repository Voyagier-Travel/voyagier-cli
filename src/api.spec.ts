import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { saveCredentials, CONFIG_DIR } from "./config.js";
import { graphql } from "./api.js";

const credFile = join(CONFIG_DIR, "credentials.json");

// Mock global fetch — reassigned in beforeEach since clearMocks resets it
let mockFetch: jest.MockedFunction<typeof fetch>;

describe("graphql", () => {
  let originalCreds: string | null = null;

  beforeEach(() => {
    mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = mockFetch;
    // Back up and set test credentials
    if (existsSync(credFile)) {
      originalCreds = readFileSync(credFile, "utf-8");
    } else {
      originalCreds = null;
    }
    saveCredentials("test-token-abc", "https://api.test.voyagier.com");
  });

  afterEach(() => {
    // Restore
    if (originalCreds !== null) {
      writeFileSync(credFile, originalCreds, { mode: 0o600 });
    } else if (existsSync(credFile)) {
      unlinkSync(credFile);
    }
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  it("should send correct GraphQL request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { user: { id: "1", name: "Test" } } }),
    } as any);

    const result = await graphql<{ user: { id: string; name: string } }>(
      "query { user { id name } }",
      { id: "1" }
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.test.voyagier.com/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-abc",
        }),
      })
    );
    expect(result).toEqual({ user: { id: "1", name: "Test" } });
  });

  it("should include variables in request body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { createTripPlan: { id: "new-plan" } } }),
    } as any);

    await graphql(
      "mutation CreatePlan($input: CreateTripPlanInput!) { createTripPlan(input: $input) { id } }",
      { input: { title: "Punta Cana Trip", startDate: "2026-05-01" } }
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.variables.input.title).toBe("Punta Cana Trip");
    expect(body.variables.input.startDate).toBe("2026-05-01");
  });

  it("should throw on GraphQL errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: "Trip plan not found" }] }),
    } as any);

    await expect(graphql("query { tripPlan(id: \"bad\") { id } }"))
      .rejects.toThrow("GraphQL error: Trip plan not found");
  });

  it("should throw on missing data", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as any);

    await expect(graphql("query { something }"))
      .rejects.toThrow("No data returned from API");
  });

  it("should throw on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as any);

    await expect(graphql("query { anything }"))
      .rejects.toThrow("API error: 500 Internal Server Error");
  });

  it("should exit on 401 unauthorized", async () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(1)");
    });
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as any);

    await expect(graphql("query { me { id } }")).rejects.toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("should handle dry-run mode without calling fetch", async () => {
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit(0)");
    });
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      graphql("mutation { createPlan { id } }", { title: "Test" }, { dryRun: true })
    ).rejects.toThrow("process.exit(0)");

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockFetch).not.toHaveBeenCalled();

    const allWrites = (stderrSpy.mock.calls as any[]).map(c => c[0]).join("");
    expect(allWrites).toContain("DRY RUN");
    expect(allWrites).toContain("createPlan");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });


  describe("streamChat", () => {
    // Import streamChat  
    let streamChatFn: typeof import("./api.js").streamChat;
    
    beforeEach(async () => {
      saveCredentials("test-token-abc", "https://api.test.voyagier.com");
      mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
      global.fetch = mockFetch;
      const mod = await import("./api.js");
      streamChatFn = mod.streamChat;
    });

    it("should parse SSE text-delta events", async () => {
      const chunks: string[] = [];
      const sseData = [
        'data: {"type":"text-delta","textDelta":"Hello"}',
        'data: {"type":"text-delta","textDelta":" world"}',
        'data: [DONE]',
        '',
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      } as any);

      await streamChatFn("session-1", "test message", {
        onTextDelta(text) { chunks.push(text); },
      });

      expect(chunks).toEqual(["Hello", " world"]);
    });

    it("should handle tool-call and tool-result events", async () => {
      const toolCalls: string[] = [];
      const toolResults: Array<{ name: string; result: unknown }> = [];

      const sseData = [
        'data: {"type":"tool-call","toolCallId":"tc1","toolName":"searchFlights","args":{"from":"LAX"}}',
        'data: {"type":"tool-result","toolCallId":"tc1","result":{"count":5}}',
        'data: [DONE]',
        '',
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      } as any);

      await streamChatFn("session-1", "find flights", {
        onTextDelta() {},
        onToolCall(name) { toolCalls.push(name); },
        onToolResult(name, result) { toolResults.push({ name, result }); },
      });

      expect(toolCalls).toEqual(["searchFlights"]);
      expect(toolResults).toEqual([{ name: "searchFlights", result: { count: 5 } }]);
    });

    it("should handle error events", async () => {
      const errors: string[] = [];
      const sseData = [
        'data: {"type":"error","errorText":"Rate limited"}',
        'data: [DONE]',
        '',
      ].join("\n");

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      } as any);

      await streamChatFn("session-1", "test", {
        onTextDelta() {},
        onError(text) { errors.push(text); },
      });

      expect(errors).toEqual(["Rate limited"]);
    });

    it("should handle Vercel AI SDK format (0: prefix)", async () => {
      const chunks: string[] = [];
      const data = '0:"Hello from AI"\n';

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(data));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      } as any);

      await streamChatFn("session-1", "hi", {
        onTextDelta(text) { chunks.push(text); },
      });

      expect(chunks).toEqual(["Hello from AI"]);
    });

    it("should exit on 401", async () => {
      const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit(1)");
      });
      const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      await expect(streamChatFn("s1", "test", { onTextDelta() {} }))
        .rejects.toThrow("process.exit(1)");

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });

    it("should throw on non-401 error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as any);

      await expect(streamChatFn("s1", "test", { onTextDelta() {} }))
        .rejects.toThrow("Stream error: 500");
    });

    it("should throw when no response body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: null,
      } as any);

      await expect(streamChatFn("s1", "test", { onTextDelta() {} }))
        .rejects.toThrow("No response body");
    });
  });
});
