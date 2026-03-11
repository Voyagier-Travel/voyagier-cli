#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerPlanCommands } from "./commands/plans.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerSelectCommands } from "./commands/select.js";
import { registerTravellerCommands } from "./commands/travellers.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const program = new Command();
program.name("voyagier").description("Voyagier CLI — search, plan, and book travel").version(pkg.version);

registerAuthCommands(program);
registerChatCommands(program);
registerPlanCommands(program);
registerSearchCommands(program);
registerSelectCommands(program);
registerTravellerCommands(program);

program.parse();
