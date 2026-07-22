import { Command } from "commander";
import chalk from "chalk";
import { setTelemetryEnabled, getTelemetryStatus } from "../telemetry.js";

export function registerTelemetryCommands(program: Command): void {
  const telemetry = program.command("telemetry").description("Manage anonymous usage telemetry");

  telemetry
    .command("on")
    .description("Enable anonymous telemetry (requires DD_API_KEY env var)")
    .action(() => {
      setTelemetryEnabled(true);
      const status = getTelemetryStatus();

      console.log(chalk.green("\n  ✓ Telemetry enabled.\n"));

      if (!status.hasApiKey) {
        console.log(chalk.yellow("  ⚠ DD_API_KEY not set — telemetry won't send until it is."));
        console.log(chalk.dim("    export DD_API_KEY=your-datadog-api-key\n"));
      } else {
        console.log(chalk.dim("  Command usage, latency, and error codes will be sent to Datadog."));
        console.log(chalk.dim("  No personal data is included — command names, timing, error codes only.\n"));
      }
    });

  telemetry
    .command("off")
    .description("Disable telemetry")
    .action(() => {
      setTelemetryEnabled(false);
      console.log(chalk.green("\n  ✓ Telemetry disabled. No data will be sent.\n"));
    });

  telemetry
    .command("status")
    .description("Check telemetry status")
    .action(() => {
      const status = getTelemetryStatus();

      console.log(chalk.bold("\n  Telemetry Status\n"));
      console.log(`  Opted in:    ${status.enabled ? chalk.green("yes") : chalk.dim("no")}`);
      console.log(`  DD_API_KEY:  ${status.hasApiKey ? chalk.green("set") : chalk.red("not set")}`);
      console.log(`  Active:      ${status.enabled && status.hasApiKey ? chalk.green("✓ sending") : chalk.dim("✗ not sending")}`);

      if (!status.enabled) {
        console.log(chalk.dim("\n  Enable with: voyagier telemetry on"));
      } else if (!status.hasApiKey) {
        console.log(chalk.dim("\n  Set your key: export DD_API_KEY=your-datadog-api-key"));
      }

      console.log(chalk.dim("\n  Data sent: command name, duration, success/failure, error code, CLI version."));
      console.log(chalk.dim("  Not sent: tokens, hostname, user id, error messages, search queries, personal info, trip data.\n"));
    });
}
