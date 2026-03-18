# @voyagier/cli

Search flights, book hotels, add activities — from your terminal. Everything syncs to [voyagier.com](https://voyagier.com).

```bash
npm install -g @voyagier/cli
voyagier auth set-token <your-token>
```

## Two Commands to Book a Trip

```bash
voyagier plan-trip --title "Tokyo Trip" --from LAX --to NRT \
  --depart 2026-04-15 --return 2026-04-22 --hotel Tokyo \
  --travellers "John Smith" --auto-select navigator --json

voyagier book <PLAN_ID> --json
```

## Add Activities

```bash
voyagier search activities --plan <PLAN_ID> --destination Tokyo \
  --date 2026-04-16 --query "sushi tour" --json
voyagier select 1 --plan <PLAN_ID> --json
voyagier book <PLAN_ID> --json
```

## Multi-Leg Trips

A plan is a shopping cart. Keep adding to it:

```bash
# Leg 1 — creates plan + travellers
voyagier plan-trip --title "Island Hop" --from DCA --to LIH \
  --depart 2026-03-25 --hotel Poipu --travellers "John, Jane" \
  --auto-select navigator --json

# Leg 2 — reuses travellers (omit --travellers)
voyagier plan-trip --plan <PLAN_ID> --from LIH --to HNL \
  --depart 2026-03-30 --hotel Waikiki --auto-select navigator --json

# Return
voyagier plan-trip --plan <PLAN_ID> --from HNL --to DCA \
  --depart 2026-04-03 --auto-select navigator --json

voyagier book <PLAN_ID> --json
```

## Commands

| Command | Description |
|---------|-------------|
| `plan-trip` | Create or extend a plan (flights + hotels) |
| `search flights` | Search flights by route and date |
| `search hotels` | Search hotels by location and dates |
| `search activities` | Search Viator experiences and tours |
| `search airports` | Look up airport codes |
| `select <n>` | Select from last search results |
| `options <planId>` | View sub-options (cabin class, room type) |
| `pick <n>` | Select a sub-option |
| `cart <planId>` | View shopping cart |
| `book <planId>` | Checkout via Stripe |
| `plans` | Create, list, get, delete plans |
| `travellers` | Add, list, remove travellers |
| `bookings` | View booking records |
| `chat` | Interactive AI trip planning |
| `auth` | Manage authentication |
| `agent-docs` | Full AI agent integration reference |

Every command supports `--json` for structured output and `--plan <id>` where applicable.

## AI Agents

```bash
voyagier agent-docs         # full integration reference
voyagier agent-docs --json  # machine-readable
```

Or read [AGENT.md](./AGENT.md) directly — covers auto-select strategies, JSON response contracts, composability patterns, error handling, and known quirks.

## Auto-Select Strategies

| Strategy | What it optimizes |
|----------|-------------------|
| `navigator` | Best overall value (price + duration + stops) |
| `cheapest` | Lowest price |
| `fastest` | Shortest duration |
| `fewest-stops` | Minimum layovers |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOYAGIER_TOKEN` | Personal access token (overrides config) |
| `VOYAGIER_API_URL` | API base URL (default: `https://travel.voyagier.com`) |

## How It Works

Thin client over Voyagier's GraphQL API — same API the web app uses. Everything syncs both ways.

## License

UNLICENSED — proprietary.
