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
  "travellers_update", "goal_add",
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

  it("tools/list returns exactly the 17 expected tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("tools/list never exposes `send` (emails a real client — CLI-only)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("send");
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
      ["book", "P1", "--expect-total", "339.10", "--types", "Activity,Hotel", "--json"],
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

  it("travellers_update: forwards typed inputs to the `travellers update` argv (happy path)", async () => {
    const run = jest.fn<CliRunner>(async () => ({
      stdout: JSON.stringify({ id: "t1", firstName: "Jane", lastName: "Doe" }),
      stderr: "",
      exitCode: 0,
    }));
    const { client } = await connect(run);
    const res = (await client.callTool({
      name: "travellers_update",
      arguments: { traveller_id: "t1", gender: "F", dob: "1990-01-02" },
    })) as TextResult;
    expect(run).toHaveBeenCalledWith(
      ["travellers", "update", "t1", "--gender", "F", "--dob", "1990-01-02", "--json"],
      60_000,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("t1");
  });

  it("travellers_update: a CLI error envelope maps to isError:true", async () => {
    const run: CliRunner = async () => ({
      stdout: JSON.stringify({ error: true, code: "VALIDATION", message: "Nothing to update." }),
      stderr: "",
      exitCode: 1,
    });
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "travellers_update", arguments: { traveller_id: "t1" } })) as TextResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("VALIDATION");
  });

  it("travellers_update: rejects schema-invalid args (missing traveller_id) before reaching the CLI", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "travellers_update", arguments: { first: "Jane" } })) as TextResult;
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("goal_add: forwards typed inputs to the `plans goal-add` argv (happy path)", async () => {
    const run = jest.fn<CliRunner>(async () => ({
      stdout: JSON.stringify({ ok: true, data: { goal: { id: "g1", type: "Activity" } } }),
      stderr: "",
      exitCode: 0,
    }));
    const { client } = await connect(run);
    const res = (await client.callTool({
      name: "goal_add",
      arguments: { plan_id: "pl1", type: "Activity", name: "Sushi tour" },
    })) as TextResult;
    expect(run).toHaveBeenCalledWith(
      ["plans", "goal-add", "pl1", "--type", "Activity", "--name", "Sushi tour", "--json"],
      60_000,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain("g1");
  });

  it("goal_add: a CLI error envelope (bad type) maps to isError:true", async () => {
    const run: CliRunner = async () => ({
      stdout: JSON.stringify({ error: true, code: "VALIDATION", message: 'Invalid --type "Widget".' }),
      stderr: "",
      exitCode: 1,
    });
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "goal_add", arguments: { plan_id: "pl1", type: "Widget" } })) as TextResult;
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("VALIDATION");
  });

  it("goal_add: rejects schema-invalid args (missing type) before reaching the CLI", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    const res = (await client.callTool({ name: "goal_add", arguments: { plan_id: "pl1" } })) as TextResult;
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("search_flights: sort input maps to --sort; omitting it preserves server order", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    await client.callTool({ name: "search_flights", arguments: { plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15", sort: "duration" } });
    expect(run).toHaveBeenCalledWith(
      ["search", "flights", "--plan", "p", "--from", "JFK", "--to", "NRT", "--date", "2026-09-15", "--sort", "duration", "--json"],
      300_000,
    );
    run.mockClear();
    await client.callTool({ name: "search_flights", arguments: { plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15" } });
    expect(run.mock.calls[0][0]).not.toContain("--sort");
  });

  it("search_flights: rejects an out-of-enum sort value before reaching the CLI", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    const res = (await client.callTool({
      name: "search_flights",
      arguments: { plan_id: "p", from: "JFK", to: "NRT", date: "2026-09-15", sort: "best" },
    })) as TextResult;
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("search_hotels: sort=price maps to --sort price", async () => {
    const run = jest.fn<CliRunner>(okRun);
    const { client } = await connect(run);
    await client.callTool({ name: "search_hotels", arguments: { plan_id: "p", location: "Paris", checkin: "2026-09-01", checkout: "2026-09-05", sort: "price" } });
    expect(run).toHaveBeenCalledWith(
      ["search", "hotels", "--plan", "p", "--location", "Paris", "--checkin", "2026-09-01", "--checkout", "2026-09-05", "--sort", "price", "--json"],
      300_000,
    );
  });
});
