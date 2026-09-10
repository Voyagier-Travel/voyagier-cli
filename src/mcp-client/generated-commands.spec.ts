import { describe, it, expect } from "@jest/globals";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { CliErrorCode } from "../errors.js";
import { McpClient, type McpToolDescriptor, type McpToolResult } from "./client.js";
import { parseToolContent, registerGeneratedCommands } from "./generated-commands.js";

/**
 * End-to-end on a bare Commander program: argv → tool arguments → tools/call →
 * output, with a client whose fetch is scripted.
 */

const FIXTURE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("../mcp/fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as McpToolDescriptor[];

function clientReturning(resultFor: (name: string, args: Record<string, unknown>) => McpToolResult | { error: { code: number; message: string } }, headers: Record<string, string> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: number; params?: { name: string; arguments: Record<string, unknown> } };
    const respond = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (body.method === "initialize") return respond({ jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "voyagier" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") {
      calls.push({ name: body.params!.name, args: body.params!.arguments });
      const r = resultFor(body.params!.name, body.params!.arguments);
      if ("error" in r) return respond({ jsonrpc: "2.0", id: body.id, error: r.error });
      return respond({ jsonrpc: "2.0", id: body.id, result: r });
    }
    return respond({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
  }) as unknown as typeof fetch;
  return { client: new McpClient({ url: "https://mcp.example.test/api/mcp", token: "t", fetchImpl }), calls };
}

function harness(client: McpClient) {
  const json: unknown[] = [];
  const human: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerGeneratedCommands(program, FIXTURE_TOOLS, {
    version: "0.0.0-test",
    createClient: () => client,
    writeJson: (d) => json.push(d),
    writeHuman: (t) => human.push(t),
  });
  program.commands.forEach((c) => c.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} }));
  return { program, json, human, run: (argv: string[]) => program.parseAsync(["node", "voyagier", ...argv]) };
}

const text = (obj: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

describe("generated commands", () => {
  it("registers every fixture tool once and skips names already taken", () => {
    const program = new Command();
    program.command("quote").action(() => {});
    const names = registerGeneratedCommands(program, FIXTURE_TOOLS, { version: "0" });
    expect(names).not.toContain("quote");
    expect(names).toContain("plans_list");
    expect(names.length).toBe(FIXTURE_TOOLS.length - 1);
  });

  it("--json prints the parsed text block content, sanitized", async () => {
    const { client, calls } = clientReturning(() => text({ myTripPlans: { items: [{ id: "p1", title: "Trip \u001b[31mred\u001b[0m" }], count: 1 } }));
    const { run, json, human } = harness(client);
    await run(["plans_list", "--limit", "1", "--relationship", "owner", "--json"]);
    expect(calls).toEqual([{ name: "plans_list", args: { limit: 1, relationship: "owner" } }]);
    expect(json).toEqual([{ myTripPlans: { items: [{ id: "p1", title: "Trip red" }], count: 1 } }]);
    expect(human).toEqual([]);
  });

  it("renders a human view for tools that have one, JSON otherwise", async () => {
    const { client } = clientReturning((name) =>
      name === "plan_status"
        ? text({ tripPlanStatus: { tripPlanId: "p1", title: "Doe", readiness: "ReadyToBook", goals: [] } })
        : text({ tripPlanClients: [{ id: "c1", name: "Jane Doe" }] }),
    );
    const { run, human } = harness(client);
    await run(["plan_status", "--plan_id", "p1"]);
    expect(human[0]).toContain("Doe");
    expect(human[0]).toContain("ReadyToBook");
    await run(["clients_list"]);
    expect(JSON.parse(human[1])).toEqual({ tripPlanClients: [{ id: "c1", name: "Jane Doe" }] });
  });

  it("prefers structuredContent for rendering when the server sends it", async () => {
    const { client } = clientReturning(() => ({
      content: [{ type: "text", text: "unstructured" }],
      structuredContent: { tripPlanStatus: { readiness: "Booked", title: "Structured" } },
    }));
    const { run, human } = harness(client);
    await run(["plan_status", "--plan_id", "p1"]);
    expect(human[0]).toContain("Structured");
  });

  it("surfaces an isError result as API_ERROR with the tool's text", async () => {
    const { client } = clientReturning(() => ({ isError: true, content: [{ type: "text", text: "Trip plan p1 not found" }] }));
    const { run } = harness(client);
    await expect(run(["plan_status", "--plan_id", "p1", "--json"])).rejects.toMatchObject({ code: CliErrorCode.API_ERROR, message: "Trip plan p1 not found" });
  });

  it("passes JSON and array flags through as structured arguments", async () => {
    const travellers = [{ first_name: "Jane", last_name: "Doe", declared_type: "Adult" }];
    const { client, calls } = clientReturning(() => text({ addTripPlanTravellers: { added: 1 } }));
    const { run } = harness(client);
    await run(["travellers_add", "--plan_id", "p1", "--travellers", JSON.stringify(travellers), "--json"]);
    expect(calls[0].args).toEqual({ plan_id: "p1", travellers });
  });

  it("parseToolContent: one block → value, several → array, non-JSON text stays a string", () => {
    expect(parseToolContent({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(parseToolContent({ content: [{ type: "text", text: "plain" }, { type: "text", text: "[1]" }] })).toEqual(["plain", [1]]);
    expect(parseToolContent({ content: [{ type: "image", data: "…", mimeType: "image/png" }] })).toEqual({ type: "image", data: "…", mimeType: "image/png" });
  });
});
