import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CliError, CliErrorCode } from "./errors.js";
import { saveCredentials, CONFIG_DIR } from "./config.js";
import { graphql, graphqlWithFieldFallback, __resetFieldFallbackCache } from "./api.js";

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

  it("sanitizes ANSI escapes and control chars in response data at the API boundary (VOY-1709)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          options: [
            { id: "opt-1", name: "\u001b[2J\u001b[31mEvil Hotel\u001b[0m" },
            { id: "opt-2", name: "Clean\u0007 Hotel" },
          ],
        },
      }),
    } as any);

    const result = await graphql<{ options: Array<{ id: string; name: string }> }>(
      "query { options { id name } }"
    );

    expect(result.options[0].name).toBe("Evil Hotel");
    expect(result.options[1].name).toBe("Clean Hotel");
  });

  it("sanitizes server-provided GraphQL error messages before rendering (VOY-1709)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ message: "\u001b[31mBad input\u0007 rejected" }],
      }),
    } as any);

    await expect(graphql("query { x }")).rejects.toThrow("GraphQL error: Bad input rejected");
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

  it("should throw AuthError on 401 unauthorized", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as any);

    try {
      await graphql("query { me { id } }");
      fail("Expected CliError");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.AUTH_FAILED);
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("PERMISSION_DENIED on 403 mentions the not-found ambiguity (server conflates them)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as any);

    try {
      await graphql("query { me { id } }");
      fail("Expected CliError");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.PERMISSION_DENIED);
      expect((err as CliError).message).toContain("or the resource does not exist");
    }
  });

  it("PERMISSION_DENIED on GraphQL FORBIDDEN mentions the not-found ambiguity", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: "Forbidden resource", extensions: { code: "FORBIDDEN" } }] }),
    } as any);

    try {
      await graphql("query { me { id } }");
      fail("Expected CliError");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.PERMISSION_DENIED);
      expect((err as CliError).message).toContain("the requested resource does not exist");
    }
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


  describe("graphqlWithFieldFallback (VOY-1748 backward compat)", () => {
    beforeEach(() => {
      __resetFieldFallbackCache();
    });

    it("retries the legacy query when the enriched field is rejected as unknown", async () => {
      // Old backend: the isSelf-enriched query fails GraphQL validation. graphql()
      // surfaces this as CliError(SCHEMA_DRIFT) preserving the "Cannot query field"
      // text, so the helper's strict match (code + field pattern) fires and it
      // retries the legacy field set.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            errors: [{ message: 'Cannot query field "isSelf" on type "TripPlanClient".' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { tripPlanClients: { items: [] } } }),
        } as any);

      const res = await graphqlWithFieldFallback(
        "query WithSelf { tripPlanClients { items { id isSelf } } }",
        "query Legacy { tripPlanClients { items { id } } }",
        /isSelf/,
      );

      expect(res).toEqual({ tripPlanClients: { items: [] } });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const body2 = JSON.parse((mockFetch.mock.calls[1][1] as any).body);
      expect(body2.query).toContain("Legacy");
      expect(body2.query).not.toContain("isSelf");
    });

    it("also matches the 'Unknown field' phrasing for isTripPlanner", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ errors: [{ message: "Unknown field isTripPlanner on type User" }] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { me: { id: "u1" } } }),
        } as any);

      const res = await graphqlWithFieldFallback(
        "{ me { id isTripPlanner } }",
        "{ me { id } }",
        /isTripPlanner|canMintPats/,
      );

      expect(res).toEqual({ me: { id: "u1" } });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("remembers the downgrade: subsequent calls go straight to the legacy query", async () => {
      // Paginated callers (fetchAllClients) must not pay a doubled round-trip
      // on every page against an old backend — the first fallback is sticky
      // for the rest of the process.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            errors: [{ message: 'Cannot query field "isSelf" on type "TripPlanClient".' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { tripPlanClients: { items: [], page: 1 } } }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { tripPlanClients: { items: [], page: 2 } } }),
        } as any);

      const enriched = "query WithSelf { tripPlanClients { items { id isSelf } } }";
      const legacy = "query Legacy { tripPlanClients { items { id } } }";

      await graphqlWithFieldFallback(enriched, legacy, /isSelf/, { page: 1 });
      const res2 = await graphqlWithFieldFallback(enriched, legacy, /isSelf/, { page: 2 });

      expect(res2).toEqual({ tripPlanClients: { items: [], page: 2 } });
      // 3 fetches total: enriched-fail + legacy (page 1), then legacy ONLY (page 2)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const body3 = JSON.parse((mockFetch.mock.calls[2][1] as any).body);
      expect(body3.query).toContain("Legacy");
      expect(body3.query).not.toContain("isSelf");
    });

    it("does not fall back on a non-SCHEMA_DRIFT error even if the message mentions the field", async () => {
      // Strictness check: the fallback requires CliError(SCHEMA_DRIFT), not
      // just suggestive phrasing in an arbitrary error. A server error that
      // happens to name the field must propagate.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({ error: 'resolver crashed while reading isSelf' }),
        text: async () => 'resolver crashed while reading isSelf',
      } as any);

      await expect(
        graphqlWithFieldFallback("query { x isSelf }", "query { x }", /isSelf/),
      ).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("propagates unrelated errors without a retry (no false fallback)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errors: [{ message: "Trip plan not found" }] }),
      } as any);

      await expect(
        graphqlWithFieldFallback("query { x isSelf }", "query { x }", /isSelf/),
      ).rejects.toThrow(/Trip plan not found/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not fall back when a different field is the one rejected", async () => {
      // "Cannot query field" but NOT one of ours — must propagate, not silently
      // downgrade to the legacy query and swallow a genuine schema problem.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errors: [{ message: 'Cannot query field "someOtherField" on type "User".' }] }),
      } as any);

      await expect(
        graphqlWithFieldFallback("{ me { someOtherField } }", "{ me { id } }", /isTripPlanner/),
      ).rejects.toThrow(/Cannot query field/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns the enriched result with no retry when the field is supported", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { tripPlanClients: { items: [{ id: "c1", isSelf: true }] } } }),
      } as any);

      const res = await graphqlWithFieldFallback(
        "query { tripPlanClients { items { id isSelf } } }",
        "query { tripPlanClients { items { id } } }",
        /isSelf/,
      );

      expect(res).toEqual({ tripPlanClients: { items: [{ id: "c1", isSelf: true }] } });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
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

    it("should throw CliError on 401", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as any);

      try {
        await streamChatFn("s1", "test", { onTextDelta() {} });
        fail("Expected CliError");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(CliErrorCode.AUTH_FAILED);
      }
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
