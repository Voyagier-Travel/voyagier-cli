import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CliError, CliErrorCode } from "./errors.js";
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
    saveCredentials("test-token-abc", "https://api.test.voyagier.com/api");
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
      "https://api.test.voyagier.com/api/graphql",
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

  it("404 with no GraphQL body points at the API URL config, not permissions", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ message: "Cannot POST /api/mcp/graphql", statusCode: 404 }),
    } as any);

    try {
      await graphql("query { me { id } }");
      fail("Expected CliError");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.API_ERROR);
      expect((err as CliError).message).toContain("No GraphQL endpoint at");
      expect((err as CliError).message).toContain("Check the configured API URL");
      expect((err as CliError).message).not.toContain("permissions issue");
    }
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
});
