#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { buildProgram } from "./build-program.js";
import { trackCommand, getTraceId, isTelemetryEnabled, telemetryErrorCode } from "./telemetry.js";
import { gracefulExit } from "./exit.js";
import { credentialsExist } from "./config.js";
import { CliError } from "./errors.js";
import chalk from "chalk";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const program = buildProgram(pkg.version);

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

instrumentCommands(program);

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

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof CliError) {
    const isJson = process.argv.includes("--json");
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
