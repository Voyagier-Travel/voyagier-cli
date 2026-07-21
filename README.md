# @voyagier/cli

Search flights, book activities, manage trip plans — from your terminal. Everything syncs to [voyagier.com](https://voyagier.com).

```bash
npm install -g @voyagier/cli
voyagier auth set-token <your-token>
voyagier doctor   # confirm auth + schema reachability
```

## Quick Start

A trip plan is a **goal graph**: the plan ships with goals (flights, hotel, dates, destination, travellers) and you compose the trip by searching against those goals and selecting options. Searches are **asynchronous** — a search creates a selection, and options arrive shortly after, so you poll for them.

```bash
# 1) Resolve a client (idempotent by email)
voyagier clients upsert --email "smith@example.com" --name "Smith Family" \
  --type Individual --json

# 2) Scaffold a plan (creates the plan + default goal graph; optionally adds
#    travellers if you pass --travellers)
voyagier plan-trip --client "Smith Family" --title "Smith — Tokyo" --json
# Returns a scaffold summary: { ok, tripPlanId, title, travellerIds, scaffolded,
# note, url, nextSteps } — the nextSteps are the compose commands for this plan.

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
| Hotel | ⚠️ partial | Accommodation supplier / advisor inventory (checkout coverage incomplete) |
| Flight | ✅ via Fare & Cabin item | Air supplier / GDS (fare-level item carted once all legs are picked; defaults to Economy) |

The cart materializes only bookable, fare/room-level options — the per-item `isBookable` flag is the live truth. Always run `voyagier book <planId> --dry-run` first for pre-flight checks (blockers + chargeable subtotal, no gate needed); `--validate` is a strictness modifier on the real booking that aborts if any item is non-bookable. A real checkout requires a **price gate** (`--expect-total` or `--max-total`) against the chargeable subtotal, and the checkout is always pinned to that gated set via `itemIds` — `--types` / `--only-bookable` narrow it server-side. Note: unpaid (Pending) checkout sessions are not visible to the CLI, so never retry a successful `book`.

## Commands

| Command | Description |
|---------|-------------|
| `voyagier doctor` | Self-check: auth, schema, reachability, state, version |
| `voyagier clients` | Advisor CRM (`list`, `get`, `create`, `update`, `archive`, `upsert`) |
| `voyagier plans` | `create`, `list`, `get`, `summary`, `delete`; `plans goals` for the goal graph + readiness; `plans bookable` for pre-flight |
| `voyagier plan-trip` | Scaffold a plan (plan + default goal graph; adds travellers only if `--travellers` is given) and print compose next-steps |
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
| `voyagier chat` | Interactive AI trip planning |
| `voyagier whoami` | Identity + profile (live-verifies the token; `--cached` for offline reads) |
| `voyagier auth` | Manage PAT / API URL |
| `voyagier agent-docs` | Print full AI agent integration reference |

Most data-bearing commands accept `--json` for structured output (notable exceptions: `chat`, `telemetry`, several `auth` subcommands). Use `--plan <id>` on `select` to prevent cross-plan state corruption when running parallel workflows.

## For AI Agents

```bash
voyagier agent-docs    # full reference (AGENT.md)
```

Or read [AGENT.md](./AGENT.md) directly. It covers the goal-graph compose model, async option fetch, per-command JSON shapes, the error code table, and the bookability matrix.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGIER_TOKEN` | Personal access token (overrides config) |
| `VOYAGIER_API_URL` | API base URL (default: `https://travel.voyagier.com/api`; the CLI appends `/graphql`) |

## How It Works

Thin client over Voyagier's GraphQL API — the same API the web app uses. Everything syncs both ways. A plan is a goal graph; searching composes selections against goals, and air, accommodation, activity, and places suppliers are all surfaced through one unified selection model.

## License

UNLICENSED — proprietary.
