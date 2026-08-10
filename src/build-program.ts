import { Command } from "commander";

import { CliErrorCode } from "./errors.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerPlanCommands } from "./commands/plans/index.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerSelectCommands } from "./commands/select.js";
import { registerTravellerCommands } from "./commands/travellers.js";
import { registerCartCommands } from "./commands/cart.js";
import { registerSelectionOptionsCommands } from "./commands/selection-options.js";
import { registerBookCommands } from "./commands/book.js";
import { registerTelemetryCommands } from "./commands/telemetry.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerBookingsCommands } from "./commands/bookings.js";
import { registerPlanTripCommand } from "./commands/plan-trip.js";
import { registerPlanStatusCommand } from "./commands/plan-status.js";
import { registerAgentDocsCommand } from "./commands/agent-docs.js";
import { registerClientsCommands } from "./commands/clients.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerItineraryCommand } from "./commands/itinerary.js";
import { registerListingsCommands } from "./commands/listings.js";
import { registerPlacesCommands } from "./commands/places.js";
import { registerTravellerGroupsCommands } from "./commands/traveller-groups.js";
import { registerTravellerChoicesCommands } from "./commands/traveller-choices.js";
import { registerParticipantChoicesCommands } from "./commands/participant-choices.js";
import { registerQuoteCommand } from "./commands/quote.js";
import { registerSendCommand } from "./commands/send.js";
import { registerMcpCommand } from "./commands/mcp.js";

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
 *
 * Exported so command-level specs can wire the real hook onto their bare test
 * programs and exercise both branches (see search.spec / plans/crud.spec).
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

/**
 * Build the full Voyagier CLI command tree onto a fresh Command instance.
 *
 * Pure construction: NO argv parsing, NO side effects (welcome screen,
 * telemetry instrumentation, process.exit). The entrypoint (index.ts) wires
 * those around the returned program; tests use this to introspect the real
 * command/flag surface (see agent-docs doc-drift guard).
 */
export function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("voyagier")
    .description("Voyagier CLI — search, plan, and book travel")
    .version(version)
    .option("--stacktrace", "show full error stack traces")
    .addHelpText(
      "after",
      `
AI Agent Quick Start (scaffold, then compose — search is async):
  voyagier plan-trip --client "Client Name" --title "Trip" --from DCA --to CDG --depart <DATE> --return <DATE> --hotel Paris --travellers "Name" --json
  voyagier search flights --plan <ID> --from DCA --to CDG --date <DATE> --return <DATE> --json
  voyagier selection-options <SELECTION_ID> --wait --json
  voyagier select --selection-id <SELECTION_ID> --option-id <OPTION_ID> --json
  voyagier book <PLAN_ID> --json

Full reference: voyagier agent-docs`,
    );

  // Commands ordered by workflow: auth → plan → search → select → book
  registerAuthCommands(program);
  registerPlanTripCommand(program);
  registerPlanStatusCommand(program);
  registerPlanCommands(program);
  registerTravellerCommands(program);
  registerSearchCommands(program);
  registerSelectCommands(program);
  registerSelectionOptionsCommands(program);
  registerCartCommands(program);
  registerQuoteCommand(program);
  registerSendCommand(program);
  registerBookCommands(program);
  registerBookingsCommands(program);
  registerWhoamiCommand(program);
  registerTelemetryCommands(program);
  registerAgentDocsCommand(program);
  registerClientsCommands(program);
  registerDoctorCommand(program, version);
  registerItineraryCommand(program);
  registerListingsCommands(program);
  registerPlacesCommands(program);
  registerTravellerGroupsCommands(program);
  registerTravellerChoicesCommands(program);
  registerParticipantChoicesCommands(program);
  registerMcpCommand(program);

  // Applied after the whole tree is built so every subcommand is covered
  // (each command holds its own output configuration).
  routeParseErrorsToJson(program);

  return program;
}
