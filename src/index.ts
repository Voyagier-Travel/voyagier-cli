#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerPlanCommands } from "./commands/plans/index.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerSelectCommands } from "./commands/select.js";
import { registerTravellerCommands } from "./commands/travellers.js";
import { registerCartCommands } from "./commands/cart.js";
import { registerOptionsCommands } from "./commands/options.js";
import { registerBookCommands } from "./commands/book.js";
import { registerTelemetryCommands } from "./commands/telemetry.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerBookingsCommands } from "./commands/bookings.js";
import { registerPlanTripCommand } from "./commands/plan-trip.js";
import { registerAgentDocsCommand } from "./commands/agent-docs.js";
import { registerClientsCommands } from "./commands/clients.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { trackCommand, getTraceId, isTelemetryEnabled } from "./telemetry.js";
import { credentialsExist } from "./config.js";
import { CliError } from "./errors.js";
import chalk from "chalk";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const program = new Command();
program
  .name("voyagier")
  .description("Voyagier CLI — search, plan, and book travel")
  .version(pkg.version)
  .option("--stacktrace", "show full error stack traces")
  .addHelpText("after", `
AI Agent Quick Start:
  voyagier plan-trip --title "Trip" --from DCA --to CDG --depart <DATE> --return <DATE> --hotel Paris --travellers "Name" --auto-select navigator --json
  voyagier search activities --plan <ID> --destination Paris --date <DATE> --query "wine tour" --json
  voyagier select 1 --plan <ID> --json
  voyagier book <ID> --json

Full reference: voyagier agent-docs`);

// Commands ordered by workflow: auth → plan → search → select → book
registerAuthCommands(program);
registerPlanTripCommand(program);
registerPlanCommands(program);
registerTravellerCommands(program);
registerSearchCommands(program);
registerSelectCommands(program);
registerOptionsCommands(program);
registerCartCommands(program);
registerBookCommands(program);
registerBookingsCommands(program);
registerChatCommands(program);
registerWhoamiCommand(program);
registerTelemetryCommands(program);
registerAgentDocsCommand(program);
registerClientsCommands(program);
registerDoctorCommand(program, pkg.version);

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
    process.exit(1);
  } else {
    const stack = err instanceof Error ? (err.stack ?? String(err)) : String(err);
    process.stderr.write(stack + "\n");
    process.exit(2);
  }
}
