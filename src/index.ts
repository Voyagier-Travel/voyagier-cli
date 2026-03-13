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
import { registerBookingsCommands } from "./commands/bookings.js";
import { trackCommand, getTraceId, isTelemetryEnabled } from "./telemetry.js";

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
registerBookingsCommands(program);

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

program.parse();
