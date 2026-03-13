#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerPlanCommands } from "./commands/plans.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerSelectCommands } from "./commands/select.js";
import { registerTravellerCommands } from "./commands/travellers.js";
import { registerCartCommands } from "./commands/cart.js";
import { registerOptionsCommands } from "./commands/options.js";
import { registerBookCommands } from "./commands/book.js";
import { registerTelemetryCommands } from "./commands/telemetry.js";
import { trackCommand, getTraceId, isTelemetryEnabled } from "./telemetry.js";
import { credentialsExist } from "./config.js";
import chalk from "chalk";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const program = new Command();
program.name("voyagier").description("Voyagier CLI — search, plan, and book travel").version(pkg.version);

registerAuthCommands(program);
registerChatCommands(program);
registerPlanCommands(program);
registerSearchCommands(program);
registerSelectCommands(program);
registerTravellerCommands(program);
registerCartCommands(program);
registerOptionsCommands(program);
registerBookCommands(program);
registerTelemetryCommands(program);

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
            const msg = err instanceof Error ? err.message : String(err);
            trackCommand({ command: commandPath, subcommand: subName, durationMs: Date.now() - start, success: false, error: msg, traceId });
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
  console.log(chalk.cyan("    voyagier login") + chalk.dim("                     — log in (opens browser)"));
  console.log();
  console.log(chalk.dim("  Already have a token?\n"));
  console.log(chalk.cyan("    voyagier auth set-token <token>"));
  console.log();
  process.exit(0);
}

program.parse();
