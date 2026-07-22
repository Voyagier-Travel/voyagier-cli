/**
 * server.ts — in-memory integration tests.
 *
 * Uses the SDK's InMemoryTransport.createLinkedPair() + a real SDK Client so
 * the initialize handshake, tools/list, tools/call, isError propagation, and
 * schema validation all run end-to-end — with the exec seam mocked, so NO real
 * network and NO real child spawns.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type CliRunner, INSTRUCTIONS } from "./server.js";
import type { CliResult } from "./exec.js";

const EXPECTED_TOOL_NAMES = [
  "doctor", "create_client", "plan_trip", "add_traveller",
  "search_flights", "search_hotels", "search_activities",
  "get_selection_options", "select_option", "plan_status",
  "quote", "book_dry_run", "book", "booking_status", "agent_docs",
];

const okRun: CliRunner = async () => ({ stdout: "{}", stderr: "", exitCode: 0 });

async function connect(run: CliRunner = okRun): Promise<{ client: Client }> {
  const server = createServer({ version: "9.9.9", run });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client };
}

interface TextResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

describe("MCP server integration", () => {
  it("completes the initialize handshake advertising name 'voyagier' + instructions", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe("voyagier");
    expect(client.getServerVersion()?.version).toBe("9.9.9");
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it("tools/list returns exactly the 15 expected tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(15);
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("tools/call doctor: builds ['doctor','--json'] and returns the child JSON as text", async () => {
    const run = jest.fn<CliRunner>(async () => ({
      stdout: JSON.stringify({ ok: true, data: { overall: "PASS" } }),
      stderr: "",
      exitCode: 0,
    }));
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "doctor", arguments: {} })) as TextResult;

    expect(run).toHaveBeenCalledWith(["doctor", "--json"], 60_000);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.type).toBe("text");
    expect(res.content[0]?.text).toContain("PASS");
  });

  it("a failing child (non-zero exit) sets isError:true and passes the envelope through", async () => {
    const run: CliRunner = async () => ({
      stdout: JSON.stringify({ error: true, code: "AUTH_FAILED", message: "Token rejected." }),
      stderr: "",
      exitCode: 1,
    });
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "doctor", arguments: {} })) as TextResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("AUTH_FAILED");
  });

  it("forwards typed inputs to the correct argv (book price gate)", async () => {
    const run = jest.fn<CliRunner>(async () => ({ stdout: "{}", stderr: "", exitCode: 0 }));
    const { client } = await connect(run);
    await client.callTool({ name: "book", arguments: { plan_id: "P1", expect_total: 339.1, types: ["Activity", "Hotel"] } });
    expect(run).toHaveBeenCalledWith(
      ["book", "P1", "--expect-total", "339.1", "--types", "Activity,Hotel", "--json"],
      120_000,
    );
  });

  it("rejects schema-invalid args (book missing required expect_total) before reaching the CLI", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "book", arguments: { plan_id: "P1" } })) as TextResult;
    // The SDK validates inputSchema and returns a tool error rather than running the handler.
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects schema-invalid args (create_client missing required email) before reaching the CLI", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "create_client", arguments: { name: "Al" } })) as TextResult;
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
