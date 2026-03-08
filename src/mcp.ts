import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getApiUrl, getToken } from "./config.js";

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export async function createMcpClient(): Promise<Client> {
  const apiUrl = getApiUrl();
  const token = getToken();

  const client = new Client({ name: "voyagier-cli", version: "0.2.0" });

  const transport = new StreamableHTTPClientTransport(
    new URL(`${apiUrl}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  );

  await client.connect(transport);
  return client;
}

export async function listTools(client: Client): Promise<McpToolInfo[]> {
  const result = await client.listTools();
  return result.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const result = await client.callTool({ name: toolName, arguments: args });
  return {
    content: (result.content ?? []) as McpToolResult["content"],
    isError: result.isError as boolean | undefined,
  };
}
