import { Command } from "commander";

import { CliErrorCode } from "./errors.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerTelemetryCommands } from "./commands/telemetry.js";
import { registerAgentDocsCommand } from "./commands/agent-docs.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerGeneratedCommands, type GeneratedCommandContext } from "./mcp-client/generated-commands.js";
import type { McpToolDescriptor } from "./mcp-client/client.js";
import { registerRemovedCommandStubs } from "./removed-commands.js";

/**
 * Route Commander's own argument-parse failures (unknown option, missing
 * required option/argument, invalid argument value) through the CLI's uniform
 * JSON error contract WHEN the caller asked for --json (VOY-1829).
 *
 * Agents drive the CLI with --json and parse stdout as JSON. Without this,
 * Commander writes a bare `error: ...` line to stderr and exits 1 the moment
 * the parser trips — a parse mistake yields non-JSON, breaking the contract
 * that says the error envelope is uniform across commands.
 *
 * We override ONLY `outputError`, the single sink Commander uses for
 * parse-error text (never help or version output, which go through
 * writeOut/writeErr). So:
 *   - with --json in argv → emit { error, code: "VALIDATION", message } on
 *     stdout; the exit code stays 1 (Commander's default `_exit` is untouched).
 *   - without --json      → byte-identical to before (text on stderr, exit 1).
 *
 * --json is detected by scanning process.argv, because options are not parsed
 * yet when the parser errors. Leaving `_exit`/exitOverride alone means
 * CommanderError propagation under test (exitOverride) and help/version
 * rendering both keep working exactly as before.
 *
 * Applied to the root AND every descendant command: Commander calls `error()`
 * on the command where the failure occurred (usually a subcommand), and each
 * command carries its own `_outputConfiguration` reference.
 */
export function routeParseErrorsToJson(cmd: Command): void {
  cmd.configureOutput({
    outputError: (str, write) => {
      if (argvRequestsJson(process.argv)) {
        const message = str.replace(/\n+$/, "");
        process.stdout.write(
          JSON.stringify({ error: true, code: CliErrorCode.VALIDATION, message }, null, 2) + "\n",
        );
      } else {
        write(str);
      }
    },
  });
  cmd.commands.forEach(routeParseErrorsToJson);
}

/**
 * True when `--json` is an OPTION token in argv — i.e. it appears before any
 * bare `--` terminator. Everything after a lone `--` is a positional value, so
 * a trailing `... -- --json` passes `--json` as data, not the output flag, and
 * must NOT switch us onto the JSON error path.
 *
 * Exported and shared with the entrypoint's top-level CliError handler so
 * JSON-mode detection is consistent across ALL error paths (parse failures
 * here, runtime CliErrors in src/index.ts).
 */
export function argvRequestsJson(argv: readonly string[]): boolean {
  const terminator = argv.indexOf("--");
  const options = terminator === -1 ? argv : argv.slice(0, terminator);
  return options.includes("--json");
}

export interface BuildProgramOptions {
  /** Hooks for the generated tool commands (tests inject a mocked client). */
  generated?: Omit<GeneratedCommandContext, "version">;
}

/**
 * Build the full Voyagier CLI command tree onto a fresh Command instance.
 *
 * Local commands (auth, doctor, mcp, agent-docs, telemetry) are fixed. Every
 * trip-planning command is generated from `tools`: the MCP server's
 * `tools/list`, one command per tool. Commands the 3.x CLI shipped and 4.0
 * removed are registered as hidden stubs that exit with the replacement.
 *
 * Pure construction: NO argv parsing, NO side effects (welcome screen,
 * telemetry instrumentation, process.exit). The entrypoint (index.ts) loads
 * the tool list and wires those around the returned program; tests pass a
 * fixture tool list to introspect the real command/flag surface.
 */
export function buildProgram(version: string, tools: McpToolDescriptor[] = [], opts: BuildProgramOptions = {}): Command {
  const program = new Command();
  program
    .name("voyagier")
    .description("Voyagier CLI — a shell for the Voyagier MCP server: one command per tool")
    .version(version)
    .option("--stacktrace", "show full error stack traces")
    .addHelpText(
      "after",
      `
Every trip-planning command is an MCP tool: voyagier <tool_name> --<param> <value> … [--json]
Flags follow the tool's input schema; see: voyagier <tool_name> --help

AI Agent Quick Start:
  voyagier plans_list --json
  voyagier search_destinations --query "Lisbon" --json
  voyagier plan_trip --client_id <CLIENT_ID> --title "Trip" --travel_destination_id <DEST_ID> --json
  voyagier plan_status --plan_id <PLAN_ID> --json
  voyagier quote --plan_id <PLAN_ID> --json

Full reference: voyagier agent-docs`,
    );

  // Local commands first: they never need the remote tool list.
  registerAuthCommands(program);
  registerDoctorCommand(program, version);
  registerAgentDocsCommand(program);
  registerTelemetryCommands(program);
  registerMcpCommand(program);

  // One command per MCP tool.
  registerGeneratedCommands(program, tools, { version, ...(opts.generated ?? {}) });

  // 3.x commands that no longer exist: hidden stubs with the replacement.
  registerRemovedCommandStubs(program, new Set(tools.map((t) => t.name)));

  // Applied after the whole tree is built so every subcommand is covered
  // (each command holds its own output configuration).
  routeParseErrorsToJson(program);

  return program;
}
