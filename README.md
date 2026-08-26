# @voyagier/cli

[![CI](https://github.com/Voyagier-Travel/voyagier-cli/actions/workflows/tests-and-coverage.yaml/badge.svg?branch=main)](https://github.com/Voyagier-Travel/voyagier-cli/actions/workflows/tests-and-coverage.yaml)
[![npm version](https://img.shields.io/npm/v/%40voyagier%2Fcli)](https://www.npmjs.com/package/@voyagier/cli)
[![node](https://img.shields.io/node/v/%40voyagier%2Fcli)](https://www.npmjs.com/package/@voyagier/cli)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-black)](https://github.com/Voyagier-Travel/voyagier-cli#mcp-server)
[![license](https://img.shields.io/npm/l/%40voyagier%2Fcli)](https://github.com/Voyagier-Travel/voyagier-cli/blob/main/LICENSE)

Search flights, book activities, manage trip plans — from your terminal. Everything syncs to [voyagier.com](https://voyagier.com).

```bash
npm install -g voyagier        # or the canonical package: @voyagier/cli
voyagier auth set-token <your-token>
voyagier doctor   # confirm auth + schema reachability
```

`voyagier` is a convenience alias that tracks the latest compatible `@voyagier/cli` release (currently `^2`). Pinning an exact version? Use the canonical package: `npm install -g @voyagier/cli@<version>`.

No install permissions (sandboxed agent, CI)? Every command works zero-install via `npx`:

```bash
VOYAGIER_TOKEN=<your-token> npx @voyagier/cli doctor --json
```

## Quick Start

A trip plan is a **goal graph**: the plan ships with goals (flights, hotel, dates, destination, travellers) and you compose the trip by searching against those goals and selecting options. Searches are **asynchronous** — a search creates a selection, and options arrive shortly after, so you poll for them.

```bash
# 1) Resolve a client (idempotent by email)
voyagier clients upsert --email "smith@example.com" --name "Smith Family" \
  --type Individual --json

# 2) Scaffold a plan (creates the plan + the goal graph its template names;
#    optionally adds the party if you pass --travellers)
voyagier plan-trip --client "Smith Family" --title "Smith — Tokyo" --json
# --template picks the shape: RoundTripFlightAndHotel (default) | RoundTripFlight
#   | OneWayFlight | OneWayFlightAndHotel | HotelOnly | Blank
# Returns a scaffold summary: { ok, tripPlanId, title, travellerIds, scaffolded,
# template, goals, note, url, nextSteps } — nextSteps are the compose commands.

# 3) Add a traveller
voyagier travellers add --plan <PLAN_ID> --first John --last Smith \
  --type Adult --json

# 4) Search flights → poll for options → select
voyagier search flights --plan <PLAN_ID> --from JFK --to NRT \
  --date 2026-09-15 --return 2026-09-22 --json
# Returns a selectionId. Options are fetched asynchronously:
voyagier selection-options <SELECTION_ID> --wait --json
voyagier select --selection-id <SELECTION_ID> --option-id <OPTION_ID> --wait --json

# 5) Search a hotel → poll → select
voyagier search hotels --plan <PLAN_ID> --location Tokyo \
  --checkin 2026-09-15 --checkout 2026-09-22 --json
voyagier selection-options <SELECTION_ID> --wait --json
voyagier select --selection-id <SELECTION_ID> --option-id <OPTION_ID> --json

# 6) Inspect readiness at any time — one call: what's blocked, what's next
voyagier plan-status <PLAN_ID> --json

# 7) Pre-flight (dry-run: blockers + chargeable subtotal), then checkout (price gate required)
voyagier book <PLAN_ID> --dry-run --json                   # preview: blockers + chargeable subtotal; no gate needed
voyagier book <PLAN_ID> --expect-total <subtotal> --json   # checkout only at that exact price
voyagier book <PLAN_ID> --validate --expect-total <subtotal> --json  # strict: also abort if ANY item is non-bookable
```

## What's Bookable

| Selection | Bookable? | Source |
|-----------|-----------|--------|
| Activity | ✅ per slot | Activity supplier |
| Hotel | ✅ via room-rate item | Accommodation supplier / advisor inventory (pick hotel → pick room; baseline rate auto-carted; rate-less listings stay display-only) |
| Flight | ✅ via Fare & Cabin item | Air supplier / GDS (fare-level item carted once all legs are picked; defaults to Economy) |

The cart materializes only bookable, fare/room-level options — the per-item `isBookable` flag is the live truth. Always run `voyagier book <planId> --dry-run` first for pre-flight checks (blockers + chargeable subtotal, no gate needed); `--validate` is a strictness modifier on the real booking that aborts if any item is non-bookable. A real checkout requires a **price gate** (`--expect-total` or `--max-total`) against the chargeable subtotal, and the checkout is always pinned to that gated set via `itemIds` — `--types` / `--only-bookable` narrow it server-side. Note: unpaid (Pending) checkout sessions are not visible to the CLI, so never retry a successful `book`. Cart items sourced from live-rate suppliers may report `source: "OTHER"` — that's normal, not an error.

## Commands

| Command | Description |
|---------|-------------|
| `voyagier doctor` | Self-check: auth, schema, reachability, state, version |
| `voyagier clients` | Advisor CRM (`list`, `get`, `create`, `update`, `archive`, `upsert`) |
| `voyagier plans` | `create`, `list`, `get`, `summary`, `delete`; `plans goals` for the goal graph + readiness; `plans bookable` for pre-flight |
| `voyagier plan-trip` | Scaffold a plan (plan + the goal graph its `--template` names; adds the party only if `--travellers` is given) and print compose next-steps |
| `voyagier plan-status <planId>` | One-shot readiness: BOOKED / READY_TO_BOOK / BLOCKED / IN_PROGRESS, ordered blockers, runnable next steps |
| `voyagier travellers` | Add, list, update, remove travellers |
| `voyagier traveller-groups` | Manage traveller groups (list, create, update, delete, members) |
| `voyagier traveller-choices` | Inspect per-traveller selection choices for a plan |
| `voyagier search` | Flights, hotels, activities, airports — creates a selection; options arrive async |
| `voyagier selection-options <selectionId>` | Read / poll a selection's options (`--wait` to poll until ready) |
| `voyagier select` | Choose an option (`--selection-id <id> --option-id <id>`, or by index; `--wait` to settle readiness after the pick) |
| `voyagier itinerary` | Computed itinerary (sourced from `tripPlanEvents`) |
| `voyagier listings` | Advisor inventory listings — recent change events, add to selection |
| `voyagier places` | Search / get / attach / list / highlight (external places + internal catalog) |
| `voyagier cart` | View cart with by-goal grouping and per-item bookability |
| `voyagier quote` | Offer snapshot: itemized bookables + the exact total a gated `book` will enforce (`--json` includes the acceptance command) |
| `voyagier send` | Email the client an invite link to the live trip (self-serve close; requires confirmation / `--yes`) |
| `voyagier book` | Stripe checkout gated by `--expect-total` / `--max-total`; `--validate`, server-side `--only-bookable` / `--types`, `--rebook` |
| `voyagier bookings` | View booking records |
| `voyagier whoami` | Identity + profile (live-verifies the token; `--cached` for offline reads) |
| `voyagier auth` | Manage PAT / API URL |
| `voyagier agent-docs` | Print full AI agent integration reference |

Most data-bearing commands accept `--json` for structured output (notable exceptions: `telemetry`, several `auth` subcommands). Use `--plan <id>` on `select` to prevent cross-plan state corruption when running parallel workflows.

## For AI Agents

```bash
voyagier agent-docs    # full reference (AGENT.md)
npx @voyagier/cli agent-docs   # zero-install variant
```

Or read [AGENT.md](./AGENT.md) directly. It covers the goal-graph compose model, async option fetch, per-command JSON shapes, the error code table, and the bookability matrix.

## MCP server

The CLI ships an [MCP](https://modelcontextprotocol.io) stdio server that exposes the agent surface as tools, for hosts that speak the Model Context Protocol (Claude Desktop, Cursor, etc.):

```bash
voyagier mcp          # run the stdio server (JSON-RPC on stdout)
```

It's a thin adapter: each tool call self-spawns the CLI as a subprocess with `--json` (the one exception is `agent_docs`, which runs without it), so the tools inherit the CLI's uniform error codes and price-gated checkout — zero behaviour drift. The MCP layer normalises every result into ONE canonical envelope: on success `{ ok: true, data: <object>, planContext? }` (agent_docs markdown arrives as `data.content`), and on failure `{ ok: false, error: { code, message, details? } }` with `isError: true`. Authentication flows through the environment (`VOYAGIER_TOKEN` / `VOYAGIER_API_URL`); the MCP layer never sees your token.

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

**Cursor** (`.cursor/mcp.json`):

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

### Tools

| Tool | Maps to | Notes |
|------|---------|-------|
| `doctor` | `doctor` | Health check: auth, schema, state, version. |
| `clients_list` | `clients list` | Roster of CRM clients; `page`/`limit` page through it. |
| `client_create` | `clients upsert` | Idempotent by email; a plan needs a client. |
| `plans_list` | `plans list` | Owned + shared plans in one list, each tagged `relationship` `owner`/`shared`; the plan-discovery entry point. `relationship`/`active`/`page`/`limit` filter and page it. |
| `plan_trip` | `plan-trip` | Scaffold a plan + goal graph from a `template`; returns `nextSteps`. |
| `travellers_add` | `travellers add` | Adds the whole party in one call; required before search. |
| `search_flights` | `search flights` | Async — `optionCount 0` means poll options. |
| `search_hotels` | `search hotels` | Prices are stay totals, not nightly. |
| `search_activities` | `search activities` | Bookable per slot. |
| `get_selection_options` | `selection-options` | `wait` (default true) polls the async fetch to completion. |
| `refresh_options` | `refresh-options` | Re-fetch a selection's options; `force` after a fetch error. |
| `select_option` | `select` | Explicit-id mode; `wait` (default true) settles readiness. |
| `choices_view` | `choices-view` | Flat participant-choice view; source of room-slot ids. |
| `choose_room_slot` | `choose-room-slot` | Upsert a room/rate participant choice. |
| `plan_status` | `plan-status` | One-call "what's left before booking?". |
| `quote` | `quote` | Advisor offer snapshot + acceptance block. |
| `book_dry_run` | `book --dry-run` | Chargeable subtotal + blockers; no gate needed. |
| `book` | `book` | **Requires a price gate** — `expect_total_cents` (integer cents, preferred) or `expect_total` (dollars), or `max_total` alone as a cap; fails closed with `PRICE_CHANGED`. |
| `booking_status` | `book --status` | Post-payment confirmation lookup. |
| `agent_docs` | `agent-docs` | The full agent reference as markdown. |

> **Deprecated aliases.** `create_client` and `add_traveller` remain registered as deprecated aliases of `client_create` and `travellers_add` (same behaviour) for one release. Prefer the canonical names, which align with the Voyagier platform's first-party MCP tool registry.
>
> **`send` is intentionally excluded from the MCP surface.** `voyagier send` emails a real client an invite link and is not idempotent — every call re-emails. That side effect is too consequential to expose behind an autonomous tool call; use the CLI directly (`voyagier send <planId> --yes`) when you mean it. The MCP close path is `quote` → `book`.
>
> **`book` cannot be retried safely.** Unpaid Stripe sessions are invisible to the pre-flight, so a retry mints a duplicate payable link. Treat a successful `book` as terminal.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGIER_TOKEN` | Personal access token (overrides config) |
| `VOYAGIER_API_URL` | API base URL (default: `https://travel.voyagier.com/api`; the CLI appends `/graphql`) |

## How It Works

Thin client over Voyagier's GraphQL API — the same API the web app uses. Everything syncs both ways. A plan is a goal graph; searching composes selections against goals, and air, accommodation, activity, and places suppliers are all surfaced through one unified selection model.

## Getting Access

Voyagier access is granted, not open signup — **request access at [voyagier.com/agents](https://voyagier.com/agents)**. That's the gate for advisors, trip-planner customers, and agent builders alike.

Once your account is granted API access, mint a personal access token at [travel.voyagier.com/me/settings/tokens](https://travel.voyagier.com/me/settings/tokens) and you're in. Two account tiers use the CLI today:

- **Travel advisors** — manage a book of clients (`voyagier clients`); plans are created against a client (`--client`).
- **Trip planners** — paying customers planning their own travel. Just run `voyagier plan-trip` — no client setup, no `--client` flag. (`voyagier whoami` shows your tier.)

Non-admin tokens expire (90 days max, 30 by default) — mint a fresh one when yours lapses.

> **Tip:** prefer `voyagier login` (interactive prompt) over `voyagier auth set-token <token>` — it keeps your token out of shell history. For scripts, use the `VOYAGIER_TOKEN` env var.

## Claude Desktop Extension (MCPB)

The MCP server is also packaged as a Claude Desktop extension bundle (MCPB). Build it from the repo with `scripts/build-mcpb.sh`, which produces `dist-mcpb/voyagier-<version>.mcpb`. To install, drag the `.mcpb` file into Claude Desktop → Settings → Extensions, then enter your Personal Access Token when prompted.

## Privacy Policy

Data processed through the CLI and Voyagier services is handled per the [Voyagier privacy policy](https://www.voyagier.com/privacy-policy).

## License

[Apache-2.0](LICENSE) — Copyright 2026 Voyagier, Inc. Use of Voyagier services through the CLI is subject to the [Voyagier Terms of Service](https://voyagier.com/terms). "Voyagier" and the Voyagier logo are trademarks of Voyagier, Inc.; the Apache-2.0 license does not grant trademark rights.
