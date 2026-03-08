#!/usr/bin/env node
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerPlanCommands } from "./commands/plans.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerToolsCommands } from "./commands/tools.js";

const program = new Command();

program
  .name("voyagier")
  .description("Voyagier CLI — AI trip planning from your terminal")
  .version("0.2.0");

registerAuthCommands(program);
registerChatCommands(program);
registerPlanCommands(program);
registerSearchCommands(program);
registerToolsCommands(program);

program.parse();
