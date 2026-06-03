import { Command } from "commander";
import chalk from "chalk";
import { jsonOutput } from "../output.js";

/**
 * `options <planId>` / `pick <number>` are RETIRED (VOY-1414).
 *
 * They were built on the deleted "sub-selection" model
 * (setTripPlanSubSelectionOption / refreshTripPlanSubSelectionOptions) and a
 * pick-by-index state file. The Goals/Blueprint architecture replaced that with
 * ordinary selections + an explicit async option-fetch status, surfaced by
 * `selection-options <selectionId>` (VOY-1415):
 *
 *   - read/poll options for a selection:  voyagier selection-options <selectionId> [--wait]
 *   - choose an option:                    voyagier select --selection-id <id> --option-id <id>
 *
 * These stubs stay only to give a clear, machine-readable migration message
 * instead of a confusing "unknown command" — they perform no API calls.
 */

const MIGRATION = {
  retired: true,
  replacement: {
    readOptions: "voyagier selection-options <selectionId> [--wait]",
    chooseOption: "voyagier select --selection-id <id> --option-id <id>",
  },
  reason:
    "The sub-selection model was removed in the Goals/Blueprint migration. Use selection-options (VOY-1415) for option fetch/status and select for choosing.",
};

function emitRetired(commandLabel: string, json: boolean): void {
  if (json) {
    jsonOutput({ command: commandLabel, ...MIGRATION });
    return;
  }
  console.log(chalk.yellow(`\n  '${commandLabel}' has been retired.`));
  console.log(chalk.dim("  The sub-selection model was removed in the Goals/Blueprint migration."));
  console.log("\n  Use instead:");
  console.log(`    Read / poll options:  ${chalk.cyan(MIGRATION.replacement.readOptions)}`);
  console.log(`    Choose an option:     ${chalk.cyan(MIGRATION.replacement.chooseOption)}`);
  console.log();
}

export function registerOptionsCommands(program: Command): void {
  program
    .command("options <planId>")
    .description("[retired] Use 'selection-options <selectionId>' instead")
    .option("--json", "Output raw JSON")
    .action((_planId: string, opts) => {
      emitRetired("options", !!opts.json);
    });

  program
    .command("pick <number>")
    .description("[retired] Use 'select --selection-id <id> --option-id <id>' instead")
    .option("--json", "Output raw JSON")
    .action((_number: string, opts) => {
      emitRetired("pick", !!opts.json);
    });
}
