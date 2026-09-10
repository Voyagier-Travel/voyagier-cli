#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { buildProgram, argvRequestsJson } from "./build-program.js";
import { trackCommand, getTraceId, isTelemetryEnabled, telemetryErrorCode } from "./telemetry.js";
import { gracefulExit } from "./exit.js";
import { credentialsExist } from "./config.js";
import { CliError, CliErrorCode } from "./errors.js";
import { resolveStartupTools, refreshToolsCache, type StartupTools } from "./mcp-client/startup.js";
import { createDefaultClient } from "./mcp-client/generated-commands.js";
import chalk from "chalk";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

// Instrument all commands with telemetry
function instrumentCommands(cmd: Command): void {
  cmd.commands.forEach((sub) => {
    instrumentCommands(sub);
    const originalAction = (sub as unknown as { _actionHandler?: (...args: unknown[]) => Promise<void> })._actionHandler;
    if (originalAction) {
      const commandPath = sub.parent?.name() ?? "";
      const subName = sub.name();
      (sub as unknown as { _actionHandler: (...args: unknown[]) => Promise<void> })._actionHandler = async (...args: unknown[]) => {
        const start = Date.now();
        const traceId = getTraceId();
        try {
          await originalAction.apply(sub, args);
          if (isTelemetryEnabled()) {
            trackCommand({ command: commandPath, subcommand: subName, durationMs: Date.now() - start, success: true, traceId });
          }
        } catch (err) {
          if (isTelemetryEnabled()) {
            trackCommand({ command: commandPath, subcommand: subName, durationMs: Date.now() - start, success: false, errorCode: telemetryErrorCode(err), traceId });
          }
          throw err;
        }
      };
    }
  });
}

// Top-level "login" shortcut → "auth login"
const userArgs = process.argv.slice(2);
if (userArgs[0] === "login") {
  process.argv.splice(2, 1, "auth", "login");
}

// Show welcome screen for unauthenticated users with no args
if (userArgs.length === 0 && !credentialsExist()) {
  console.log(chalk.bold("\n  Welcome to Voyagier CLI! 🌍\n"));
  console.log("  Plan and book travel from the command line.\n");
  console.log("  Get started:\n");
  console.log(chalk.cyan("    voyagier login") + chalk.dim("                     — log in (opens browser, keeps your token out of shell history)"));
  console.log();
  console.log(chalk.dim("  Scripting? Pipe a token via stdin (keeps it out of shell history):\n"));
  console.log(chalk.cyan('    echo "$VOYAGIER_PAT" | voyagier auth set-token -'));
  console.log();
  await gracefulExit(0);
}

function knowsCommand(program: Command, name: string): boolean {
  return program.commands.some((c) => c.name() === name || c.aliases().includes(name));
}

function buildFromStartup(startup: StartupTools): Command {
  const program = buildProgram(pkg.version, startup.tools);
  instrumentCommands(program);
  return program;
}

try {
  let startup = await resolveStartupTools(process.argv.slice(2), { version: pkg.version });
  let program = buildFromStartup(startup);

  // The first word is neither a local command, a generated tool, nor a
  // removed-command stub. Either the tool list could not be loaded (say why),
  // or the cache predates a newly published tool (refresh once and retry).
  const first = process.argv[2];
  if (first && !first.startsWith("-") && !knowsCommand(program, first)) {
    if (startup.error) {
      throw new CliError(
        startup.error.code,
        `Unknown command "${first}" — the tool list could not be loaded from ${startup.url}.\n${startup.error.message}`,
        startup.error.details,
      );
    }
    if (startup.source === "cache" || startup.source === "stale-cache") {
      const fresh = await refreshToolsCache(createDefaultClient(pkg.version), startup.url);
      startup = { ...startup, tools: fresh.tools, source: "network", cache: fresh };
      program = buildFromStartup(startup);
    }
    if (!knowsCommand(program, first)) {
      const names = startup.tools.map((t) => t.name).sort();
      throw new CliError(
        CliErrorCode.NOT_FOUND,
        `Unknown command "${first}". The Voyagier MCP server at ${startup.url} publishes ${names.length} tool(s):\n  ${names.join(", ")}\n  Run: voyagier --help`,
        { available: names },
      );
    }
  }

  await program.parseAsync();
} catch (err) {
  if (err instanceof CliError) {
    // Same terminator-aware scan as the parse-error path in build-program.ts:
    // `--json` after a bare `--` is positional data, not the output flag.
    const isJson = argvRequestsJson(process.argv);
    if (isJson) {
      const payload: Record<string, unknown> = { error: true, code: err.code, message: err.message };
      if (err.details) payload.details = err.details;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      process.stderr.write(chalk.red(err.message + "\n"));
    }
    if (process.argv.includes("--stacktrace") && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    await gracefulExit(1);
  } else {
    const stack = err instanceof Error ? (err.stack ?? String(err)) : String(err);
    process.stderr.write(stack + "\n");
    await gracefulExit(2);
  }
}
