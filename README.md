# @voyagier/cli

Search flights, book activities, manage trip plans — from your terminal. Everything syncs to [voyagier.com](https://voyagier.com).

```bash
npm install -g @voyagier/cli@alpha
voyagier auth set-token <your-token>
voyagier doctor   # confirm auth + schema reachability
```

> **v2.0.0-alpha** is a clean rebuild against Voyagier's advisor-first / Blueprint trip-plan model. v1.x is broken against the current backend and is deprecated. See [CHANGELOG.md](./CHANGELOG.md) for the breaking-changes summary.

## Quick Start (the manual flow agents should use today)

> ⚠️ `plan-trip --auto-select` is currently broken on the v2 schema (tracked as VOY-1189). Use the manual flow below until that lands.

```bash
# 1) Resolve a client (idempotent by email)
voyagier clients upsert --email "smith@example.com" --name "Smith Family" \
  --type Individual --json

# 2) Create the plan with that client
voyagier plans create --client <CLIENT_ID> --title "Smith — Tokyo" --json

# 3) Add a traveller
voyagier travellers add --plan <PLAN_ID> --first John --last Smith \
  --type Adult --json

# 4) Search → select → pick → book (manual flow)
voyagier search flights --plan <PLAN_ID> --from JFK --to NRT \
  --date <DEPART_DATE> --return <RETURN_DATE> --json
voyagier select 1 --plan <PLAN_ID> --json    # outbound
voyagier select 1 --plan <PLAN_ID> --json    # return
voyagier options <PLAN_ID> --json
voyagier pick 1 --plan <PLAN_ID> --json      # cabin class

voyagier search activities --plan <PLAN_ID> --destination Tokyo \
  --date <DEPART_DATE> --query "sushi tour" --json
voyagier select 1 --plan <PLAN_ID> --json

# 5) Pre-flight bookability + checkout
voyagier book <PLAN_ID> --validate --json
voyagier book <PLAN_ID> --only-bookable --json
```

## What's Bookable (v2)

| Selection | Bookable? | Source |
|-----------|-----------|--------|
| Activity | ✅ per slot | Viator |
| Hotel | ⚠️ partial | Blueprint Listings (checkout coverage incomplete) |
| Flight | ❌ display only | Sabre (itinerary view only — `is_bookable = false`) |

Run `voyagier book --validate <planId>` for pre-flight checks. Use `--types ACTIVITY,HOTEL` to scope checkout.

## Commands

| Command | Description |
|---------|-------------|
| `voyagier doctor` | Self-check: auth, schema, reachability, state, version |
| `voyagier clients` | Advisor CRM (list, get, create, update, archive, upsert) |
| `voyagier plans` | Create, list, get, summary, delete; `plans bookable` for pre-flight |
| `voyagier travellers` | Add, list, update, remove travellers |
| `voyagier search` | Flights, hotels, activities, airports |
| `voyagier select <n>` | Select from last search results |
| `voyagier options` / `pick` | Sub-options (cabin class, room type) |
| `voyagier itinerary` | Computed itinerary (sourced from `tripPlanEvents`) |
| `voyagier listings` | Blueprint Listings — recent change events, add to selection |
| `voyagier places` | Search / get / attach / list / highlight (Google Places + internal) |
| `voyagier cart` | View cart with by-goal grouping and per-item bookability |
| `voyagier book` | Stripe checkout with `--validate` / `--only-bookable` / `--types` / `--idempotency-key` |
| `voyagier bookings` | View booking records |
| `voyagier chat` | Interactive AI trip planning |
| `voyagier auth` | Manage PAT / API URL |
| `voyagier agent-docs` | Print full AI agent integration reference |

Every command supports `--json` for stable structured output. Use `--plan <id>` on `select` and `pick` to prevent cross-plan state corruption.

## For AI Agents

```bash
voyagier agent-docs         # full reference (AGENT.md)
```

Or read [AGENT.md](./AGENT.md) directly — covers JSON envelope contract, error code branching, the bookability matrix, and the canonical manual flow for v2.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGIER_TOKEN` | Personal access token (overrides config) |
| `VOYAGIER_API_URL` | API base URL (default: `https://travel.voyagier.com`) |

## How It Works

Thin client over Voyagier's GraphQL API — the same API the web app uses. Everything syncs both ways. Blueprint Listings, Viator, Google Places, and Sabre are all surfaced through the unified selection model.

## License

UNLICENSED — proprietary.
