/**
 * The 3.x trip-planning command surface, and the MCP tool that replaces each
 * command in 4.0. Single source of truth: the runtime stubs that print the
 * removal message and the CHANGELOG migration table are both generated from
 * this table.
 *
 * In 4.0 the CLI is a client of the Voyagier MCP server: every trip-planning
 * verb is `voyagier <tool_name> --<param> …`, built from the server's
 * `tools/list`. Commands that held their own GraphQL are gone; each stub
 * exits non-zero and names the replacement.
 */
import { Command } from "commander";
import { CliError, CliErrorCode } from "./errors.js";

export interface RemovedCommand {
  /** Full 3.x command path, e.g. "plans list". */
  command: string;
  /** Replacement tool name(s). Empty when no tool covers it. */
  tools: string[];
  /** Short migration note (shown in the message and the CHANGELOG). */
  note?: string;
}

export const REMOVED_IN = "4.0";

export const REMOVED_COMMANDS: readonly RemovedCommand[] = [
  // Destinations / plans
  { command: "destinations search", tools: ["search_destinations"] },
  { command: "plan-trip", tools: ["plan_trip"], note: "Pass travellers as a JSON array with --travellers." },
  { command: "plan-status", tools: ["plan_status"] },
  { command: "plans create", tools: ["plan_trip"] },
  { command: "plans list", tools: ["plans_list"] },
  { command: "plans get", tools: ["plan_status", "itinerary", "choices_view"], note: "There is no raw plan read; use the read view you need." },
  { command: "plans summary", tools: ["itinerary"] },
  { command: "plans update", tools: ["plan_update"] },
  { command: "plans delete", tools: ["plan_delete"] },
  { command: "plans items", tools: ["plan_status", "choices_view"] },
  { command: "plans remove-item", tools: ["goal_delete"] },
  { command: "plans share", tools: ["share_plan", "invite_collaborator"], note: "share_plan grants the plan's client access; invite_collaborator adds another user." },
  { command: "plans collaborators", tools: ["collaborators_list"] },
  { command: "plans unshare", tools: ["collaborator_remove"] },
  { command: "plans shared", tools: ["plans_list"], note: "Use --relationship shared." },
  { command: "plans comments", tools: [] },
  { command: "plans vote", tools: [] },
  { command: "plans bookable", tools: ["quote"] },
  { command: "plans goals", tools: ["plan_status"] },
  { command: "plans goal", tools: ["plan_status"] },
  { command: "plans goal-add", tools: ["goal_add"] },
  { command: "plans goal-add-with-selection", tools: ["goal_add", "promote_search"] },
  { command: "plans goal-update", tools: ["goal_update"] },
  { command: "plans goal-remove", tools: ["goal_delete"] },
  { command: "plans goal-assign-travellers", tools: ["goal_update"] },
  { command: "plans goal-add-item", tools: ["promote_search"] },
  { command: "plans goal-add-item-with-selection", tools: ["promote_search"] },
  { command: "plans goal-reorder", tools: ["goal_update"] },
  // Travellers
  { command: "travellers add", tools: ["travellers_add"], note: "Takes a JSON array of travellers." },
  { command: "travellers list", tools: ["travellers_list"] },
  { command: "travellers remove", tools: ["travellers_remove"] },
  { command: "travellers update", tools: ["travellers_update"] },
  // Search → select
  { command: "search airports", tools: [], note: "search_flights accepts IATA codes or city names in --from / --to." },
  { command: "search flights", tools: ["search_flights", "promote_search"], note: "search_flights explores; promote_search puts a result on a plan goal." },
  { command: "search hotels", tools: ["search_hotels", "promote_search"], note: "As above." },
  { command: "search activities", tools: ["search_activities", "promote_search"], note: "As above." },
  { command: "select", tools: ["select_option"] },
  { command: "selection-options", tools: ["get_selection_options"] },
  { command: "refresh-options", tools: ["refresh_options"] },
  { command: "choices-view", tools: ["choices_view"] },
  { command: "choose-room-slot", tools: ["choose_room_slot"] },
  { command: "traveller-choices list", tools: ["choices_view"] },
  // Close
  { command: "cart", tools: ["quote"] },
  { command: "quote", tools: ["quote"] },
  { command: "send", tools: ["share_plan"], note: "share_plan returns the client link; you deliver it." },
  { command: "book", tools: ["book"], note: "The price gate is --expect_total_cents (integer cents) plus --item_ids from quote." },
  { command: "bookings list", tools: ["bookings_list"] },
  { command: "bookings get", tools: ["booking_get"] },
  // Account / clients
  { command: "whoami", tools: ["whoami"] },
  { command: "clients list", tools: ["clients_list"] },
  { command: "clients get", tools: ["client_get"] },
  { command: "clients create", tools: ["client_create"] },
  { command: "clients update", tools: ["client_update"] },
  { command: "clients archive", tools: [] },
  { command: "clients upsert", tools: ["clients_list", "client_create"], note: "Look up by name first, then create." },
  // Reads without a tool
  { command: "itinerary", tools: ["itinerary"] },
  { command: "listings list", tools: [] },
  { command: "listings recent", tools: [] },
  { command: "listings add-to-selection", tools: ["promote_search"], note: "Pass --listing_ids." },
  { command: "places search", tools: [] },
  { command: "places get", tools: [] },
  { command: "places attach", tools: [] },
  { command: "places list", tools: [] },
  { command: "places highlight", tools: [] },
  { command: "places unhighlight", tools: [] },
  { command: "places remove", tools: [] },
  { command: "traveller-groups list", tools: [] },
  { command: "traveller-groups get", tools: [] },
  { command: "traveller-groups create", tools: [] },
  { command: "traveller-groups update", tools: [] },
  { command: "traveller-groups delete", tools: [] },
  { command: "traveller-groups add-members", tools: [] },
  { command: "traveller-groups remove-members", tools: [] },
  { command: "traveller-groups upsert", tools: [] },
];

/** Top-level command words the table covers (`plans`, `search`, `book`, …). */
export function removedTopLevelNames(): string[] {
  return [...new Set(REMOVED_COMMANDS.map((r) => r.command.split(" ")[0]))];
}

/** Find the table entry for a command path, trying the longest match first. */
export function findRemovedCommand(words: readonly string[]): RemovedCommand | undefined {
  const positional = words.filter((w) => !w.startsWith("-"));
  for (let n = Math.min(positional.length, 2); n >= 1; n--) {
    const path = positional.slice(0, n).join(" ");
    const hit = REMOVED_COMMANDS.find((r) => r.command === path);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The removal message. `available` is the set of tool names the server
 * publishes right now, so a replacement the server has not shipped yet is
 * described as upcoming instead of as a command that exists.
 */
export function removedCommandMessage(entry: RemovedCommand, available: ReadonlySet<string>): string {
  const head = `This command was removed in ${REMOVED_IN}.`;
  if (entry.tools.length === 0) {
    return `${head} There is no MCP tool for it.${entry.note ? ` ${entry.note}` : ""}\n  See: voyagier --help`;
  }
  const live = entry.tools.filter((t) => available.has(t));
  const upcoming = entry.tools.filter((t) => !available.has(t));
  const lines = [head];
  if (live.length) lines.push(`Use: ${live.map((t) => `voyagier ${t} [flags]`).join("  or  ")}`);
  if (upcoming.length) {
    lines.push(
      `${live.length ? "Also planned" : "Planned replacement"}: ${upcoming.map((t) => `voyagier ${t}`).join(", ")} (not yet published by the server; run voyagier doctor to refresh the tool list)`,
    );
  }
  if (entry.note) lines.push(entry.note);
  // Only point at --help for a command that exists on this server today.
  if (live.length) lines.push(`Flags: voyagier ${live[0]} --help`);
  return lines.join("\n  ");
}

/**
 * Register hidden stubs for every removed top-level command word that is
 * not already a live command. Each stub accepts anything and exits 1 with
 * the removal message (COMMAND_REMOVED; JSON envelope under --json).
 */
export function registerRemovedCommandStubs(program: Command, availableTools: ReadonlySet<string>): string[] {
  const taken = new Set(program.commands.map((c) => c.name()));
  const registered: string[] = [];
  for (const name of removedTopLevelNames()) {
    if (taken.has(name)) continue;
    const stub = new Command(name)
      .description(`Removed in ${REMOVED_IN}`)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument("[args...]")
      .helpOption(false)
      .action((args: string[]) => {
        const entry = findRemovedCommand([name, ...args]) ?? { command: name, tools: [] };
        throw new CliError(CliErrorCode.COMMAND_REMOVED, removedCommandMessage(entry, availableTools), {
          command: entry.command,
          replacement: entry.tools,
        });
      });
    program.addCommand(stub, { hidden: true });
    taken.add(name);
    registered.push(name);
  }
  return registered;
}

/** Markdown migration table for the CHANGELOG. */
export function removedCommandsMarkdownTable(): string {
  const rows = REMOVED_COMMANDS.map((r) => {
    const tools = r.tools.length ? r.tools.map((t) => `\`voyagier ${t}\``).join(", ") : "—";
    return `| \`voyagier ${r.command}\` | ${tools} | ${r.note ?? ""} |`;
  });
  return ["| 3.x command | 4.0 replacement | Note |", "|---|---|---|", ...rows].join("\n");
}
