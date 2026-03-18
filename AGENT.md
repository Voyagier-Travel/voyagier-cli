# Voyagier CLI — Agent Reference

> Two commands to book a trip. No state management. No multi-step flows.

## Quick Start

```bash
# Step 1: Plan, search, and auto-select — one command
voyagier plan-trip \
  --title "Client Name — Paris" \
  --from DCA --to Paris \
  --depart 2026-03-23 --return 2026-03-25 \
  --hotel Paris \
  --travellers "John Doe" \
  --auto-select navigator \
  --json

# Step 2: Book
voyagier book <PLAN_ID> --json
```

Always use `--json` for machine-readable output.

## Auto-Select Strategies

| Strategy | Flag | What it optimizes |
|----------|------|-------------------|
| **Navigator's Pick** | `navigator` | Composite: 50% price, 30% duration, 20% stops. Best overall value. **Default.** |
| Cheapest | `cheapest` | Lowest total price |
| Fastest | `fastest` | Shortest total duration |
| Fewest stops | `fewest-stops` | Minimum layovers, then cheapest |

## JSON Response (with --auto-select)

```json
{
  "planContext": { "planId": "...", "title": "Paris Trip" },
  "plan": {
    "id": "e69aa3b3-...",
    "title": "Paris Trip",
    "url": "https://voyagier.com/plans/e69aa3b3-..."
  },
  "travellers": [{ "id": "...", "firstName": "John", "lastName": "Doe" }],
  "selected": {
    "departure": { "summary": "B6 · DCA→BOS→CDG · 10h5m", "price": 268, "airline": "B6", "duration": "PT10H5M" },
    "return": { "summary": "B6 · CDG→BOS→DCA · 12h40m", "price": 330, "airline": "B6", "duration": "PT12H40M" },
    "cabin": { "name": "Economy", "price": 444.88 },
    "hotel": { "name": "Hotel Le Marais", "price": 150 },
    "strategy": "navigator",
    "rank": 1,
    "rankReason": "Best overall value based on price, duration, and stops"
  },
  "alternatives": [
    { "rank": 2, "summary": "UA via EWR · 9h55m · $2,870", "reason": "Faster but 2.8x price" },
    { "rank": 3, "summary": "AF via RDU · 10h45m · $2,876", "reason": "Air France service" }
  ],
  "cart": { "command": "voyagier cart <planId>" },
  "nextSteps": {
    "review": "voyagier cart <planId> --json",
    "book": "voyagier book <planId> --json",
    "bookDryRun": "voyagier book <planId> --dry-run --json"
  }
}
```

## Common Patterns

### Round-trip flight + hotel (most common)

```bash
voyagier plan-trip --title "Smith — Tokyo" \
  --from JFK --to Tokyo --depart 2026-05-01 --return 2026-05-08 \
  --hotel Tokyo --travellers "John Smith" \
  --auto-select navigator --json
```

### One-way flight

```bash
voyagier plan-trip --title "One-Way to London" \
  --from JFK --to London --depart 2026-04-10 \
  --travellers "Jane Smith" --auto-select cheapest --json
```

### Add to an existing plan

```bash
voyagier plan-trip --plan <EXISTING_PLAN_ID> \
  --from DCA --to Paris --depart 2026-03-23 --return 2026-03-25 \
  --auto-select navigator --json
```

### Check booking status after payment

```bash
voyagier book <PLAN_ID> --status --json
```

### List existing plans

```bash
voyagier plans list --active --json
```

## Step-by-Step Flow (when you need manual control)

Use when the user wants a specific flight or hotel. **Always pass `--plan` on `select` and `pick`.**

```bash
voyagier plans create --title "Custom Trip" --start 2026-05-01 --end 2026-05-08 --json
voyagier travellers add --plan <ID> --first John --last Smith --type ADULT --json
voyagier search flights --plan <ID> --from JFK --to NRT --date 2026-05-01 --return 2026-05-08 --json
voyagier select 1 --plan <ID> --json          # departure (response includes actionRequired for return)
voyagier select 1 --plan <ID> --json          # return
voyagier options <ID> --json
voyagier pick 1 --plan <ID> --json            # cabin class
voyagier search hotels --plan <ID> --location Tokyo --checkin 2026-05-01 --checkout 2026-05-08 --json
voyagier select 1 --plan <ID> --json          # hotel
voyagier options <ID> --json
voyagier pick 1 --plan <ID> --json            # room type
voyagier cart <ID> --json
voyagier book <ID> --json
```

### Safety rails

- **`--plan <id>`** on `select` and `pick`: Hard error if cached state belongs to a different plan. Prevents cross-plan mistakes.
- **`planContext`** in every JSON response: `{ planId, title }` — verify you're working on the right plan.
- **`actionRequired`** in departure-selected response: Tells you exactly which command to run next.

## Error Handling

All errors return:
```json
{ "error": true, "code": "VALIDATION", "message": "..." }
```

Error codes: `AUTH_FAILED`, `NOT_FOUND`, `VALIDATION`, `API_ERROR`, `NETWORK`, `STATE_CORRUPT`

Exit codes: 0 = success, 1 = handled error, 2 = unexpected error

## Airport Resolution

`--from` and `--to` accept city names:
- `--from Baltimore` → BWI
- `--from "Washington DC"` → DCA (primary)
- `--to Paris` → CDG
- `--to Tokyo` → NRT

Lookup: `voyagier search airports "tokyo" --json`

## Auth

```bash
voyagier auth set-token <PAT>    # Personal Access Token
voyagier auth status --json      # verify connection
```

Env vars (CI/scripts): `VOYAGIER_TOKEN`, `VOYAGIER_API_URL`

## Known Quirks

- Flight prices are **per-person** — multiply by traveller count for total
- Travel fee (6%) added at checkout, not in cart subtotal
- Hotel search coverage is limited (Sabre GDS)
- Search results expire ~2h — re-search for current pricing
- PNR reserved at checkout time, not at selection time
