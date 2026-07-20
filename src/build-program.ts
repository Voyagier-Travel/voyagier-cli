import { Command } from "commander";

import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommands } from "./commands/chat.js";
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
  registerBookCommands(program);
  registerBookingsCommands(program);
  registerChatCommands(program);
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

  return program;
}
