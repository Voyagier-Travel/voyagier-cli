/**
 * One Commander command per MCP tool.
 *
 * `voyagier <tool_name> --<param> value …` calls `tools/call` on the Voyagier
 * MCP server and prints the result. Flags come from the tool's inputSchema
 * (see schema-flags.ts); `--json` prints the tool's text content parsed as
 * JSON; without it a handful of tools get a human renderer (render.ts) and
 * the rest print pretty JSON.
 */
import { Command } from "commander";
import { getToken } from "../config.js";
import { jsonOutput } from "../output.js";
import { startSpinner } from "../spinner.js";
import { getTraceId } from "../telemetry.js";
import { sanitizeExternalData, sanitizeExternalText } from "../utils.js";
import { verbose } from "../verbose.js";
import { McpClient, type McpToolDescriptor, type McpToolResult } from "./client.js";
import { renderToolPayload } from "./render.js";
import { applyFlagsToCommand, buildToolArguments, flagSpecsFromSchema, type FlagSpec } from "./schema-flags.js";
import { getMcpUrl } from "./url.js";

export interface GeneratedCommandContext {
  /** CLI version, sent as clientInfo.version on initialize. */
  version: string;
  /** Client factory (tests inject a mocked-fetch client). */
  createClient?: () => McpClient;
  /** Output sinks (tests capture). */
  writeJson?: (data: unknown) => void;
  writeHuman?: (text: string) => void;
}

/** Default client: hosted URL (or VOYAGIER_MCP_URL), stored PAT, trace header. */
export function createDefaultClient(version: string): McpClient {
  return new McpClient({
    url: getMcpUrl(),
    token: getToken(),
    clientInfo: { name: "voyagier-cli", version },
    requestId: getTraceId,
    log: verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
  });
}

/**
 * Parse a tool result's content blocks: text blocks that hold JSON become
 * values; other text stays a (sanitized) string; non-text blocks pass through.
 * One block → the value itself; several → an array.
 */
export function parseToolContent(result: McpToolResult): unknown {
  const blocks = result.content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text;
      try {
        return sanitizeExternalData(JSON.parse(text) as unknown);
      } catch {
        return sanitizeExternalText(text);
      }
    }
    return sanitizeExternalData(block);
  });
  if (blocks.length === 1) return blocks[0];
  return blocks;
}

/** Generated command names, in registration order. */
export function registerGeneratedCommands(
  program: Command,
  tools: McpToolDescriptor[],
  ctx: GeneratedCommandContext,
): string[] {
  const registered: string[] = [];
  const taken = new Set(program.commands.map((c) => c.name()));
  for (const tool of tools) {
    if (!tool.name || taken.has(tool.name)) continue;
    const specs = flagSpecsFromSchema(tool.inputSchema);
    const cmd = new Command(tool.name);
    const title = tool.title?.trim() || tool.name;
    const description = tool.description?.trim() || title;
    cmd.summary(title).description(description);
    applyFlagsToCommand(cmd, specs);
    cmd.option("--json", "Output the tool result as JSON");
    if (tool.annotations?.destructiveHint) {
      cmd.addHelpText("after", "\nThis tool changes or removes data on the server.");
    }
    cmd.action(async (opts: Record<string, unknown>) => {
      await runTool(tool, specs, opts, ctx);
    });
    program.addCommand(cmd);
    taken.add(tool.name);
    registered.push(tool.name);
  }
  return registered;
}

/** Call the tool with the parsed flags and print the result. */
export async function runTool(
  tool: McpToolDescriptor,
  specs: FlagSpec[],
  opts: Record<string, unknown>,
  ctx: GeneratedCommandContext,
): Promise<void> {
  const args = buildToolArguments(specs, opts);
  const json = opts.json === true;
  const client = (ctx.createClient ?? (() => createDefaultClient(ctx.version)))();
  const writeJson = ctx.writeJson ?? jsonOutput;
  const writeHuman = ctx.writeHuman ?? ((text: string) => process.stdout.write(text + "\n"));

  // stderr only, and only for humans — agents parse stdout and want a quiet run.
  const spinner = json ? null : startSpinner(`${tool.title ?? tool.name}…`);
  let result: McpToolResult;
  try {
    result = await client.toolsCall(tool.name, args);
  } finally {
    spinner?.stop();
  }

  const parsed = parseToolContent(result);
  if (json) {
    writeJson(parsed);
    return;
  }
  const planIdHint = typeof args.plan_id === "string" ? args.plan_id : undefined;
  const rendered = renderToolPayload(tool.name, result.structuredContent ?? parsed, planIdHint);
  if (rendered !== null && rendered.trim() !== "") {
    writeHuman(rendered);
    return;
  }
  writeHuman(JSON.stringify(parsed, null, 2));
}
