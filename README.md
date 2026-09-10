# @voyagier/cli

[![CI](https://github.com/Voyagier-Travel/voyagier-cli/actions/workflows/tests-and-coverage.yaml/badge.svg?branch=main)](https://github.com/Voyagier-Travel/voyagier-cli/actions/workflows/tests-and-coverage.yaml)
[![npm version](https://img.shields.io/npm/v/%40voyagier%2Fcli)](https://www.npmjs.com/package/@voyagier/cli)
[![node](https://img.shields.io/node/v/%40voyagier%2Fcli)](https://www.npmjs.com/package/@voyagier/cli)
[![MCP](https://img.shields.io/badge/MCP-client%20%2B%20stdio%20server-black)](https://github.com/Voyagier-Travel/voyagier-cli#connect-an-ai-agent)
[![license](https://img.shields.io/npm/l/%40voyagier%2Fcli)](https://github.com/Voyagier-Travel/voyagier-cli/blob/main/LICENSE)

Plan, price and book real trips from your terminal. Everything syncs to [voyagier.com](https://voyagier.com).

**The CLI is a shell for the Voyagier MCP server.** Every trip-planning command is one MCP tool — `voyagier <tool_name> --<param> <value>` — built at runtime from the server's tool list. The same tools power claude.ai, Claude Desktop and every other MCP client, so there is one implementation of every verb and a tool published on the server shows up in your terminal without an upgrade.

```bash
npm install -g voyagier        # or the canonical package: @voyagier/cli
voyagier login                 # browser flow; keeps the token out of shell history
voyagier doctor                # credentials, MCP connection, tool count, version
```

`voyagier` is a convenience alias that tracks the latest compatible `@voyagier/cli` release. Pinning an exact version? Use the canonical package: `npm install -g @voyagier/cli@<version>`.

No install permissions (sandboxed agent, CI)? Every command works zero-install via `npx`:

```bash
VOYAGIER_TOKEN=<your-token> npx @voyagier/cli doctor --json
```

## Quick Start

A trip plan is a **goal graph**: the plan ships with goals (flights, hotel, dates, destination, travellers) and you compose the trip by exploring inventory, promoting a search onto a goal, and selecting options. Searches are **asynchronous** — poll until the status is terminal.

```bash
# 1) Find or create the client
voyagier clients_list --query "Doe" --json
voyagier client_create --name "Doe Family" --client_type Individual --email "doe@example.com" --json

# 2) Resolve the destination, then scaffold the plan with its party
voyagier search_destinations --query "Lisbon" --json
voyagier plan_trip --client_id <CLIENT_ID> --title "Doe — Lisbon" \
  --travel_destination_id <DESTINATION_ID> --start_date 2026-11-20 --end_date 2026-11-27 \
  --travellers '[{"first_name":"Jane","last_name":"Doe","type":"Adult"}]' --json

# 3) Explore flights (no plan is touched), poll, then promote the result onto the plan's goal
voyagier search_flights --from BWI --to LIS --date 2026-11-20 --return 2026-11-27
voyagier search_status --search_id <SEARCH_ID>
voyagier promote_search --plan_id <PLAN_ID> --search_id <SEARCH_ID> --goal_id <GOAL_ID> --json

# 4) Options → pick
voyagier get_selection_options --selection_id <SELECTION_ID>
voyagier select_option --selection_id <SELECTION_ID> --option_id <OPTION_ID> --json

# 5) Readiness, quote, book at exactly the quoted price
voyagier plan_status --plan_id <PLAN_ID>
voyagier quote --plan_id <PLAN_ID>
voyagier book --plan_id <PLAN_ID> --expect_total_cents <CENTS> --item_ids <ID> <ID> --json
```

`voyagier <tool_name> --help` prints the server's description of the tool and one flag per input, with types and required-ness.

## How the command surface works

- **`voyagier --help`** lists the local commands and one command per tool the server publishes.
- **Flags mirror the tool's input schema.** `plan_id` is `--plan_id`; required inputs are required flags. Strings, integers, numbers, booleans (`--force` / `--force false`), enums (allowed values in `--help`), arrays (`--item_ids a b`, or repeat the flag) and JSON literals for objects (`--travellers '[…]'`).
- **Output.** `--json` prints the tool's result as JSON: `{ "<operation>": <payload> }`. Without it, `plan_status`, the `search_*` tools, `get_selection_options`, `itinerary` and `quote` render a compact human view; other tools pretty-print the JSON.
- **Errors** use one envelope everywhere: `{ "error": true, "code", "message", "details"? }`, exit 1. `AUTH_FAILED`, `PERMISSION_DENIED`, `RATE_LIMITED` (with `details.retryAfterSeconds`), `VALIDATION`, `API_ERROR` (the tool's own error text), `NETWORK`, `COMMAND_REMOVED`.
- **Tool cache.** The server's tool list is cached in `~/.voyagier/tools-cache.json` for 24 hours. `voyagier doctor` refreshes it, and so does running a tool name the cache does not know yet.

## Commands

| Command | Description |
|---------|-------------|
| `voyagier <tool_name>` | One command per MCP tool. Today: `clients_list`, `client_create`, `plans_list`, `search_destinations`, `plan_trip`, `set_date_range`, `set_destination`, `set_airport`, `goal_add`, `goal_delete`, `travellers_add`, `travellers_list`, `travellers_update`, `search_flights`, `search_hotels`, `search_activities`, `search_status`, `promote_search`, `get_selection_options`, `refresh_options`, `select_option`, `curate_options`, `choose_room_slot`, `choices_view`, `plan_status`, `itinerary`, `quote`, `book`, `bookings_list`, `share_plan` |
| `voyagier doctor` | Self-check: credentials, MCP server connection + tool list, identity, state, version |
| `voyagier auth` | Manage the Personal Access Token (`login`, `set-token`, `status`, `logout`, `setup`) |
| `voyagier mcp install <client>` | Point an MCP client (Claude Code, Cursor, Claude Desktop) at the Voyagier MCP server |
| `voyagier mcp` | Run the stdio MCP server |
| `voyagier agent-docs` | Print the full AI agent integration reference (AGENT.md) |
| `voyagier telemetry` | Anonymous usage telemetry (`status`, `on`, `off`) |

Every 3.x trip-planning command (`plan-trip`, `search flights`, `select`, `plans …`, `clients …`, …) is replaced by a tool. Running one prints the replacement and exits 1; the full table is in the [CHANGELOG](./CHANGELOG.md).

## For AI Agents

```bash
voyagier agent-docs    # full reference (AGENT.md)
npx @voyagier/cli agent-docs   # zero-install variant
```

Or read [AGENT.md](./AGENT.md) directly. It covers the tool model, flag typing, JSON shapes, the error code table and the 3.x migration.

## Connect an AI agent

Voyagier runs a hosted MCP server at `https://mcp.voyagier.com/api/mcp`. It is the recommended way for AI agents and assistants to use Voyagier: the client connects over HTTP with your Personal Access Token and gets the whole tool surface, with no local install to manage. The CLI itself is the same surface for command-line workflows, scripting and CI.

`voyagier mcp install <client>` sets this up in one step:

```bash
voyagier mcp install claude-code      # writes ./.mcp.json (--global writes ~/.claude.json)
voyagier mcp install cursor           # writes ~/.cursor/mcp.json (--project writes ./.cursor/mcp.json)
voyagier mcp install claude-desktop   # writes claude_desktop_config.json
```

It uses your saved token (`voyagier login`), merges a `voyagier` entry into the client's existing config, and leaves every other server in that file untouched. Pass `--dry-run` to see the resolved path and the exact entry before anything is written, or `--token <pat>` to install a specific token. The token is masked in all output and is only ever written into the config file. Restart the client afterwards to pick up the change.

Claude Desktop's config format describes stdio servers only, so that client is pointed at the CLI's local server (`voyagier mcp`) instead. Voyagier can also be added through the remote connectors section of the app settings, which uses the hosted endpoint directly.

## MCP server

The CLI ships an [MCP](https://modelcontextprotocol.io) stdio server for hosts that only speak stdio:

```bash
voyagier mcp          # run the stdio server (JSON-RPC on stdout)
```

Authentication flows through the environment (`VOYAGIER_TOKEN`). The stdio server is being aligned with the hosted server's tool list so both expose the identical surface; until that lands, prefer the hosted endpoint wherever your client supports remote MCP servers.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "voyagier": {
      "command": "npx",
      "args": ["-y", "@voyagier/cli", "mcp"],
      "env": { "VOYAGIER_TOKEN": "voy_pat_xxxxx" }
    }
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGIER_TOKEN` | Personal access token (overrides the saved one) |
| `VOYAGIER_MCP_URL` | MCP endpoint every tool command calls (default: `https://mcp.voyagier.com/api/mcp`). Must be `https://`; plain `http://` is accepted only for `localhost` / `127.0.0.1` / `::1` during local development |
| `VOYAGIER_API_URL` | GraphQL base URL used by `voyagier auth setup` profile updates (default: `https://travel.voyagier.com/api`); honored together with `VOYAGIER_TOKEN` |
| `VOYAGIER_CONFIG_DIR` | Directory for credentials and the tool cache (default: `~/.voyagier`) |

## How It Works

The CLI is an MCP client. On startup it loads the server's `tools/list` (from the local cache when fresh) and registers one Commander command per tool, with flags generated from each tool's JSON input schema. Running a command sends `tools/call` over Streamable HTTP with your token as a Bearer header, honours the server's session and rate-limit headers, and prints the result. Trip-level state changes only through explicit tools (`set_date_range`, `set_destination`, `set_airport`, `plan_trip`); searches explore inventory and never write to a plan.

## Getting Access

Voyagier access is granted, not open signup — **request access at [voyagier.com/agents](https://voyagier.com/agents)**. That's the gate for advisors, trip-planner customers, and agent builders alike.

Once your account is granted API access, mint a personal access token at [travel.voyagier.com/me/settings/tokens](https://travel.voyagier.com/me/settings/tokens) and you're in. Two account tiers use the CLI today:

- **Travel advisors** — manage a book of clients (`clients_list`, `client_create`); plans are created against a client (`--client_id`).
- **Trip planners** — customers planning their own travel. `clients_list` returns your own record with `isSelf: true`; pass its id as `--client_id`.

Non-admin tokens expire (90 days max, 30 by default) — mint a fresh one when yours lapses.

> **Tip:** prefer `voyagier login` (interactive prompt) over `voyagier auth set-token <token>` — it keeps your token out of shell history. For scripts, pipe the token via stdin (`echo "$VOYAGIER_PAT" | voyagier auth set-token -`) or use the `VOYAGIER_TOKEN` env var.

## Claude Desktop Extension (MCPB)

The stdio server is also packaged as a Claude Desktop extension bundle (MCPB). Build it from the repo with `scripts/build-mcpb.sh`, which produces `dist-mcpb/voyagier-<version>.mcpb`. To install, drag the `.mcpb` file into Claude Desktop → Settings → Extensions, then enter your Personal Access Token when prompted.

## Privacy Policy

Data processed through the CLI and Voyagier services is handled per the [Voyagier privacy policy](https://www.voyagier.com/privacy-policy).

## License

[Apache-2.0](LICENSE) — Copyright 2026 Voyagier, Inc. Use of Voyagier services through the CLI is subject to the [Voyagier Terms of Service](https://voyagier.com/terms). "Voyagier" and the Voyagier logo are trademarks of Voyagier, Inc.; the Apache-2.0 license does not grant trademark rights.
