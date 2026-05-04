# @voyagier/cli

Search flights, book activities, manage trip plans — from your terminal. Everything syncs to [voyagier.com](https://voyagier.com).

```bash
npm install -g @voyagier/cli@alpha
voyagier auth set-token <your-token>
voyagier doctor   # confirm auth + schema reachability
```

> **v2.0.0-alpha** is a clean rebuild against Voyagier's advisor-first / Blueprint trip-plan model. v1.x is broken against the current backend and is deprecated. See [CHANGELOG.md](./CHANGELOG.md) for the breaking-changes summary and known gaps.

## Quick Start

> ⚠️ The composite agent fast path (`plan-trip --auto-select`) is broken on the v2 schema (tracked as VOY-1189). The flow below is the manual path that works today.

```bash
# 1) Resolve a client (idempotent by email)
voyagier clients upsert --email "smith@example.com" --name "Smith Family" \
  --type Individual --json
# Returns: { client: { id, name, ... }, ok: true, created: true|false }

# 2) Create a plan
voyagier plans create --title "Smith — Tokyo" \
  --start 2026-09-15 --end 2026-09-22 --json
# Returns: { ...plan, url, planSummary }
# (server-side requires clientId; CLI wiring is tracked as VOY-1193)

# 3) Add a traveller
voyagier travellers add --plan <PLAN_ID> --first John --last Smith \
  --type Adult --json

# 4) Search → select → pick
voyagier search flights --plan <PLAN_ID> --from JFK --to NRT \
  --date 2026-09-15 --return 2026-09-22 --json
voyagier select 1 --plan <PLAN_ID> --json    # outbound
voyagier select 1 --plan <PLAN_ID> --json    # return
voyagier options <PLAN_ID> --json
voyagier pick 1 --plan <PLAN_ID> --json      # cabin

voyagier search activities --plan <PLAN_ID> --destination Tokyo \
  --date 2026-09-16 --query "sushi tour" --json
voyagier select 1 --plan <PLAN_ID> --json

# 5) Pre-flight bookability check, then checkout
voyagier book <PLAN_ID> --validate --json
# Build a clean cart (only items you actually want to charge) before this:
voyagier book <PLAN_ID> --json
```

## What's Bookable (v2)

| Selection | Bookable? | Source |
|-----------|-----------|--------|
| Activity | ✅ per slot | Viator |
| Hotel | ⚠️ partial | Blueprint Listings (checkout coverage incomplete) |
| Flight | ❌ display only | Sabre (itinerary view only — `is_bookable = false`) |

Always run `voyagier book --validate <planId>` for pre-flight checks. To control what gets charged, **curate the cart** (don't add display-only items) before invoking `book` — `--types` and `--only-bookable` are client-side preflight gates today, not server-side filters.

## Commands

| Command | Description |
|---------|-------------|
| `voyagier doctor` | Self-check: auth, schema, reachability, state, version |
| `voyagier clients` | Advisor CRM (`list`, `get`, `create`, `update`, `archive`, `upsert`) |
| `voyagier plans` | `create`, `list`, `get`, `summary`, `delete`; `plans bookable` for pre-flight |
| `voyagier travellers` | Add, list, update, remove travellers |
| `voyagier search` | Flights, hotels, activities, airports |
| `voyagier select <n>` | Select from last search results (1-indexed) |
| `voyagier options` / `pick` | Sub-options (cabin class, room type) |
| `voyagier itinerary` | Computed itinerary (sourced from `tripPlanEvents`) |
| `voyagier listings` | Blueprint Listings — recent change events, add to selection |
| `voyagier places` | Search / get / attach / list / highlight (Google Places + internal catalog) |
| `voyagier cart` | View cart with by-goal grouping and per-item bookability |
| `voyagier book` | Stripe checkout with `--validate` / `--only-bookable` / `--types` / `--idempotency-key` (preflight gates today) |
| `voyagier bookings` | View booking records |
| `voyagier chat` | Interactive AI trip planning |
| `voyagier auth` | Manage PAT / API URL |
| `voyagier agent-docs` | Print full AI agent integration reference |

Every command supports `--json` for structured output. Use `--plan <id>` on `select` and `pick` to prevent cross-plan state corruption when running parallel workflows.

## For AI Agents

```bash
voyagier agent-docs    # full reference (AGENT.md)
```

Or read [AGENT.md](./AGENT.md) directly. It covers per-command JSON shapes (the v2 alpha is not yet uniform — VOY-1192), the error code table, the bookability matrix, and the canonical manual flow.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGIER_TOKEN` | Personal access token (overrides config) |
| `VOYAGIER_API_URL` | API base URL (default: `https://travel.voyagier.com`) |

## How It Works

Thin client over Voyagier's GraphQL API — the same API the web app uses. Everything syncs both ways. Blueprint Listings, Viator, Google Places, and Sabre are all surfaced through the unified selection model.

## License

UNLICENSED — proprietary.
