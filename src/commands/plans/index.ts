import { Command } from "commander";
import { registerCrudCommands } from "./crud.js";
import { registerItemCommands } from "./items.js";
import { registerSharingCommands } from "./sharing.js";
import { registerSocialCommands } from "./social.js";
import { registerBookableCommand } from "./bookable.js";

export function registerPlanCommands(program: Command): void {
  const plans = program.command("plans").description("Manage trip plans");

  registerCrudCommands(plans);
  registerItemCommands(plans);
  registerSharingCommands(plans);
  registerSocialCommands(plans);
  registerBookableCommand(plans);
}
