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
  it("has unique command paths and no replacement tool that is a typo of a live one", () => {
    const paths = REMOVED_COMMANDS.map((r) => r.command);
    expect(new Set(paths).size).toBe(paths.length);
    // Every replacement is either live on the server today or one of the
    // planned tools named in the migration plan.
    const planned = new Set([
      "whoami",
      "plan_update",
      "plan_delete",
      "goal_update",
      "travellers_remove",
      "client_get",
      "client_update",
      "collaborators_list",
      "collaborator_remove",
      "booking_get",
      "invite_collaborator",
    ]);
    for (const r of REMOVED_COMMANDS) {
      for (const t of r.tools) expect(LIVE.has(t) || planned.has(t)).toBe(true);
    }
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
    const planned = removedCommandMessage(findRemovedCommand(["travellers", "remove"])!, LIVE);
    expect(planned).toContain("Planned replacement: voyagier travellers_remove");
    expect(planned).toContain("not yet published");
    // Never point at --help for a command this server does not have.
    expect(planned).not.toContain("Flags:");
    const mixed = removedCommandMessage(findRemovedCommand(["plans", "share"])!, LIVE);
    expect(mixed).toContain("Use: voyagier share_plan [flags]");
    expect(mixed).toContain("Also planned: voyagier invite_collaborator");
    expect(mixed).toContain("Flags: voyagier share_plan --help");
    const none = removedCommandMessage(findRemovedCommand(["places", "search"])!, LIVE);
    expect(none).toContain("There is no MCP tool for it.");
  });

  it("lists the top-level words once", () => {
    const names = removedTopLevelNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["plans", "search", "travellers", "clients", "book", "quote", "whoami"]));
  });

  it("the CHANGELOG carries the generated migration table verbatim", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf-8");
    expect(changelog).toContain(removedCommandsMarkdownTable());
  });

  it("renders a markdown table with one row per command", () => {
    const table = removedCommandsMarkdownTable();
    const rows = table.split("\n");
    expect(rows[0]).toBe("| 3.x command | 4.0 replacement | Note |");
    expect(rows.length).toBe(REMOVED_COMMANDS.length + 2);
    expect(table).toContain("| `voyagier plans list` | `voyagier plans_list` |");
  });
});
