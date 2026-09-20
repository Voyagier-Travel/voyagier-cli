import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import type { McpToolDescriptor } from "./mcp-client/client.js";
import {
  REMOVED_COMMANDS,
  findRemovedCommand,
  removedCommandMessage,
  removedCommandsMarkdownTable,
  removedTopLevelNames,
} from "./removed-commands.js";

const FIXTURE_TOOLS: McpToolDescriptor[] = JSON.parse(
  readFileSync(new URL("./mcp/fixtures/remote-tools.json", import.meta.url), "utf-8"),
) as McpToolDescriptor[];
const LIVE = new Set(FIXTURE_TOOLS.map((t) => t.name));

describe("removed-commands table", () => {
  it("has unique command paths and every replacement tool is live in the registry snapshot", () => {
    const paths = REMOVED_COMMANDS.map((r) => r.command);
    expect(new Set(paths).size).toBe(paths.length);
    // Every replacement the table names must exist in the fixture. A tool the
    // server has not published yet is not a migration target; add it to the
    // table when it appears in a refreshed snapshot, not before.
    const missing = REMOVED_COMMANDS.flatMap((r) => r.tools.filter((t) => !LIVE.has(t)).map((t) => `${r.command} → ${t}`));
    expect(missing).toEqual([]);
  });

  it("uses the verb-first tool names, never the pre-rename ones", () => {
    const retired = [
      "plan_trip",
      "book",
      "quote",
      "itinerary",
      "plan_status",
      "search_status",
      "get_selection_options",
      "choices_view",
      "choose_room_slot",
      "goal_add",
      "goal_delete",
      "plans_list",
      "clients_list",
      "client_create",
      "bookings_list",
      "travellers_add",
      "travellers_list",
      "travellers_update",
      "travellers_remove",
      "set_date_range",
    ];
    const used = new Set(REMOVED_COMMANDS.flatMap((r) => r.tools));
    expect(retired.filter((t) => used.has(t))).toEqual([]);
    expect(findRemovedCommand(["plan-trip"])?.tools).toEqual(["create_plan"]);
    expect(findRemovedCommand(["travellers", "remove"])?.tools).toEqual(["delete_traveller"]);
    expect(findRemovedCommand(["choose-room-slot"])?.tools).toEqual(["set_room_count", "set_room_rates"]);
  });

  it("finds the longest matching path and ignores flags", () => {
    expect(findRemovedCommand(["plans", "list", "--json"])?.command).toBe("plans list");
    expect(findRemovedCommand(["plans", "--json", "list"])?.command).toBe("plans list");
    expect(findRemovedCommand(["plans", "nonsense"])).toBeUndefined();
    expect(findRemovedCommand(["book", "plan-1", "--json"])?.command).toBe("book");
    expect(findRemovedCommand(["nope"])).toBeUndefined();
  });

  it("names live tools as Use:, planned tools as not yet published, and says when none exists", () => {
    const live = removedCommandMessage(findRemovedCommand(["select"])!, LIVE);
    expect(live).toContain("This command was removed in 4.0.");
    expect(live).toContain("Use: voyagier select_option [flags]");
    expect(live).toContain("Flags: voyagier select_option --help");
    // Every mapped tool is live in the snapshot, so simulate a server that has
    // not published some of them yet: the message must not send the user to a
    // command that does not exist there.
    const withoutTraveller = new Set([...LIVE].filter((t) => t !== "delete_traveller"));
    const planned = removedCommandMessage(findRemovedCommand(["travellers", "remove"])!, withoutTraveller);
    expect(planned).toContain("Planned replacement: voyagier delete_traveller");
    expect(planned).toContain("not yet published");
    // Never point at --help for a command this server does not have.
    expect(planned).not.toContain("Flags:");
    const withoutInvite = new Set([...LIVE].filter((t) => t !== "invite_collaborator"));
    const mixed = removedCommandMessage(findRemovedCommand(["plans", "share"])!, withoutInvite);
    expect(mixed).toContain("Use: voyagier share_plan [flags]");
    expect(mixed).toContain("Also planned: voyagier invite_collaborator");
    expect(mixed).toContain("Flags: voyagier share_plan --help");
    const bothLive = removedCommandMessage(findRemovedCommand(["plans", "share"])!, LIVE);
    expect(bothLive).toContain("Use: voyagier share_plan [flags]  or  voyagier invite_collaborator [flags]");
    expect(bothLive).not.toContain("planned");
    const none = removedCommandMessage(findRemovedCommand(["places", "search"])!, LIVE);
    expect(none).toContain("There is no MCP tool for it.");
  });

  it("lists the top-level words once", () => {
    const names = removedTopLevelNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["plans", "search", "travellers", "clients", "book", "quote", "whoami"]));
  });

  it("the CHANGELOG 4.0.0 section carries the generated migration table verbatim, once", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf-8");
    const table = removedCommandsMarkdownTable();
    const section = changelog.split(/^## \[4\.0\.0\]/m)[1]?.split(/^## \[/m)[0] ?? "";
    expect(section).toContain("#### Migration table");
    expect(section).toContain(table);
    expect(changelog.split(table).length - 1).toBe(1);
    // Every 3.x command is a row; no row exists that the table does not know.
    const rows = section.split("\n").filter((l) => /^\| `voyagier /.test(l));
    expect(rows.length).toBe(REMOVED_COMMANDS.length);
  });

  it("renders a markdown table with one row per command", () => {
    const table = removedCommandsMarkdownTable();
    const rows = table.split("\n");
    expect(rows[0]).toBe("| 3.x command | 4.0 replacement | Note |");
    expect(rows.length).toBe(REMOVED_COMMANDS.length + 2);
    expect(table).toContain("| `voyagier plans list` | `voyagier list_plans` |");
  });
});
