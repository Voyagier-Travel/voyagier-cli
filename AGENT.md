# Voyagier CLI — Agent Reference

> Canonical integration guide for AI agents driving `@voyagier/cli`.
> Print this at runtime: `voyagier agent-docs`.
> Always pass `--json` for machine-readable output.

---

## What changed in v2.0.0

This is a **clean rebuild** against the new advisor-first / Blueprint trip-plan model. v1.x is broken against the current backend schema and is deprecated. Highlights:

- Every trip plan now belongs to a **client** (advisor CRM). `--client <id>` is required on plan creation.
- The **itinerary is computed**, not authored. Use `voyagier itinerary <planId>` to read the time-sorted view.
- **Bookability is per-option.** Flights are display-only. Activities (Viator) are bookable. Hotels (Blueprint Listings) are searchable but checkout coverage is partial.
- New command groups: `clients`, `itinerary`, `listings`, `places`, `doctor`, `plans bookable`.

> ⚠️ **Known gap (VOY-1189):** `voyagier plan-trip --auto-select navigator` is currently broken on the v2 schema. Use the manual flow described in [Building a Plan](#building-a-plan) until VOY-1189 lands.

For the full breaking-changes table see [`CHANGELOG.md`](./CHANGELOG.md).

---

## Quick Start

The fastest grounded loop for an agent:

```bash
# 0) Make sure auth + schema + state are healthy
voyagier doctor --json

# 1) Resolve a client (idempotent by email)
voyagier clients upsert --email "smith@example.com" --name "Smith Family" --type Individual --json

# 2) Create the plan with that client
voyagier plans create --client <CLIENT_ID> --title "Smith — Tokyo" --json

# 3) Add travellers
voyagier travellers add --plan <PLAN_ID> --first John --last Smith --type Adult --json

# 4) Search → select → pick → cart → book
voyagier search flights --plan <PLAN_ID> --from JFK --to NRT \
  --date <DEPART_DATE> --return <RETURN_DATE> --json
voyagier select 1 --plan <PLAN_ID> --json
voyagier select 1 --plan <PLAN_ID> --json    # return leg
voyagier options <PLAN_ID> --json
voyagier pick 1 --plan <PLAN_ID> --json      # cabin

voyagier search hotels --plan <PLAN_ID> --location Tokyo \
  --checkin <DEPART_DATE> --checkout <RETURN_DATE> --json
voyagier select 1 --plan <PLAN_ID> --json
voyagier options <PLAN_ID> --json
voyagier pick 1 --plan <PLAN_ID> --json      # room type

voyagier search activities --plan <PLAN_ID> --destination Tokyo \
  --date <DEPART_DATE> --query "sushi tour" --json
voyagier select 1 --plan <PLAN_ID> --json    # the actually-bookable one

# 5) Pre-flight bookability + book
voyagier book <PLAN_ID> --validate --json    # see what's actually bookable
voyagier book <PLAN_ID> --types ACTIVITY,HOTEL --json
```

`--plan <id>` on `select` and `pick` is mandatory. It prevents cross-plan state corruption when an agent runs multiple workflows in parallel.

---

## Universal Conventions

### Output modes
- `--json` — agent-targeted, stable shape with `planContext` envelope. Default for non-TTY.
- `--agent` — markdown for AI → human display.
- (default) — chalk-colored TTY for humans.

### JSON envelope (success)
```json
{
  "ok": true,
  "data": { /* command-specific */ },
  "planContext": {
    "planId": "...",
    "title": "...",
    "url": "https://app.voyagier.com/plans/...",
    "client": { "id": "...", "name": "...", "type": "Individual" },
    "isBookable": false
  }
}
```

### JSON envelope (error)
```json
{
  "ok": false,
  "error": true,
  "code": "ERROR_CODE",
  "message": "Human-readable explanation.",
  "fix": "voyagier <command> --flag value",
  "details": { /* optional structured context */ }
}
```

`fix` is meant to be machine-readable: branch on `code`, surface or run the suggested command.

### Error codes (agents should branch on these)

| Code | Meaning | Typical fix |
|---|---|---|
| `AUTH_REQUIRED` | No PAT or expired | `voyagier auth login` |
| `AUTH_FAILED` | PAT rejected | `voyagier auth set-token <PAT>` |
| `NOT_FOUND` | Resource doesn't exist | (resource-specific) |
| `PERMISSION_DENIED` | RBAC failure (non-advisor on advisor-gated mutation) | (escalate to user) |
| `VALIDATION` | Input failed CLI-side validation | follow `fix` string |
| `CLIENT_REQUIRED` | `plans create` / `plan-trip` invoked without `--client` | `voyagier clients upsert --email ... --name ... --type Individual` |
| `NO_CLIENTS` | Account has no ACTIVE clients | `voyagier clients create --name ... --type Individual` |
| `MULTIPLE_CLIENTS` | Ambiguous email match in `upsert` | pass `--client <id>` directly |
| `LISTING_NOT_FOUND` | Blueprint listing missing or unavailable | `voyagier listings recent --selection <id>` |
| `PLACE_NOT_FOUND` | Place ID does not resolve | `voyagier places search --query ...` |
| `NO_MONITOR` | Selection has no Blueprint monitor attached | (advisor must enable monitoring; not yet exposed in CLI) |
| `BOOKING_BLOCKED` | Pre-flight checks failed | each blocker carries its own `fix` in `details.blockers[]` |
| `NOT_BOOKABLE` | Selection type is display-only (e.g. flight) | filter with `--types ACTIVITY,HOTEL` |
| `EXPIRED_OFFER` | Selection option no longer available | re-run `voyagier search ...` for current pricing |
| `STALE_PLAN_STATE` | Cached search/option expired | re-run `voyagier search ...` with `--plan <id>` |
| `SCHEMA_DRIFT` | CLI built against older schema than backend | upgrade: `npm i -g @voyagier/cli@latest` |

### Idempotency

Every mutating command accepts `--idempotency-key <ulid>`. The key is **echoed in JSON output** (`data.idempotencyKey`) so agents can track retries on their side. Server-side de-duplication is on the roadmap; the flag is forward-compatible.

### State files

Local state lives in `~/.voyagier/`:
- `credentials.json` — PAT + API URL.
- `last-search.json` — most recent search results, scoped per-plan.
- `last-options.json` — last sub-option list, scoped per-plan.
- `last-clients.json` — client list cache (1h TTL).

State is plan-scoped; running parallel workflows for different plans does not corrupt each other.

---

## Command Reference (v2 surface)

### Auth
```bash
voyagier auth set-token <PAT>      # save Personal Access Token
voyagier auth status --json        # verify connection
voyagier auth logout
```

Env vars: `VOYAGIER_TOKEN`, `VOYAGIER_API_URL`.

Get a PAT: voyagier.com → Settings → Personal Access Tokens.

### Doctor
```bash
voyagier doctor --json    # auth + schema + reachability + state + version
```
Returns `{ "ok": true, "checks": [{ name, status: "PASS"|"WARN"|"FAIL", details }], "summary": "..." }`. Run this first whenever you encounter an unfamiliar error.

### Clients (advisor CRM)
```bash
voyagier clients list [--status active|archived] [--type individual|company|group] --json
voyagier clients get <id> --json
voyagier clients create --name <n> --type individual|company|group [--email] [--phone] [--avatar] [--description] --json
voyagier clients update <id> [--name] [--type] [--email] [--phone] [--avatar] [--description] [--status active|archived] --json
voyagier clients archive <id> --json
voyagier clients upsert --email <e> --name <n> --type <t> [opts] --json
```
**`upsert` is the agent-friendly idempotency primitive.** Returns existing match by email or creates new. Lowercase input (`individual`) is normalized to PascalCase (`Individual`) for the schema.

### Plans
```bash
voyagier plans create --client <CLIENT_ID> --title "<title>" --json
voyagier plans list --json
voyagier plans get <id> --json
voyagier plans summary <id> --json     # reads tripPlanEvents
voyagier plans bookable <id> --json    # pre-flight bookability with per-item blockers
voyagier plans delete <id> --json
```

`plans create` requires `--client`. It does **not** accept `--start`, `--end`, or `--description` at create time — those live on goals/selections.

### Itinerary
```bash
voyagier itinerary <planId> --json
voyagier itinerary <planId> --day 3 --json
voyagier itinerary <planId> --from 2026-09-15 --to 2026-09-18 --json
voyagier itinerary <planId> --type flight --json
```

Sourced from the `tripPlanEvents` resolver. Output shape:
```json
{
  "ok": true,
  "data": {
    "events": [
      {
        "name": "Flight DCA → CDG",
        "datetime": "2026-09-15T18:30:00Z",
        "localTime": "2026-09-15T14:30:00-04:00",
        "duration": "PT7H30M",
        "location": { "name": "...", "lat": ..., "lng": ... },
        "metadata": { "type": "FLIGHT", "selectionId": "..." }
      }
    ],
    "total": 12,
    "dayRange": { "first": "2026-09-15", "last": "2026-09-22" }
  }
}
```

`--type` filtering is best-effort against `metadata.{type|eventType|selectionType|kind}`. Schema doesn't expose typed top-level fields yet.

### Travellers
```bash
voyagier travellers add --plan <id> --first <f> --last <l> --type Adult|Child|Infant --json
voyagier travellers list --plan <id> --json
voyagier travellers update <travellerId> [opts] --json
voyagier travellers remove <travellerId> --json
```

### Search → Select → Pick

```bash
# Search
voyagier search flights --plan <id> --from <iata> --to <iata> --date <YYYY-MM-DD> [--return <YYYY-MM-DD>] --json
voyagier search hotels --plan <id> --location <city> --checkin <date> --checkout <date> --json
voyagier search activities --plan <id> --destination <city> --date <date> [--query <q>] --json
voyagier search airports "<query>" --json

# Select an option from the last search (1-indexed)
voyagier select <n> --plan <id> --json

# Sub-options (cabin class, room type)
voyagier options <planId> --json
voyagier pick <n> --plan <id> --json
```

For round-trip flights, `select` is run twice (departure, then return). The departure response includes `actionRequired` pointing to the next command.

### Cart + Book
```bash
voyagier cart <planId> --json
```
Returns cart items grouped by goal, total, currency, and a per-item `isBookable` flag with `source` (SABRE | VIATOR | BLUEPRINT | UNKNOWN).

```bash
voyagier book <planId> --validate --json                 # pre-flight only
voyagier book <planId> --only-bookable --json            # skip display-only items silently
voyagier book <planId> --types ACTIVITY,HOTEL --json     # type filter
voyagier book <planId> --idempotency-key <ulid> --json
voyagier book <planId> --dry-run --json                  # preview, no Sabre PNR / Stripe
voyagier book <planId> --status --json                   # post-payment confirmation
```

`--validate` returns blockers without attempting checkout. Sample blocker shape:
```json
{
  "blockers": [
    { "selectionId": "...", "code": "NOT_BOOKABLE", "message": "Flight items are display-only.", "fix": "voyagier book <planId> --types ACTIVITY,HOTEL" }
  ]
}
```

### Listings (Blueprint Listings — advisor inventory escape hatch)
```bash
voyagier listings recent --selection <id> [--type <changeType>] [--limit <n>] --json
voyagier listings add-to-selection <selectionId> --listing <listingId> --json
```

`listings recent` first fetches the selection's `blueprintMonitorId`. If the selection has no monitor, returns `NO_MONITOR`.

`--type` accepts kebab-case (`availability-changed`, `new-listing`, `price-changed`); normalized to PascalCase.

### Places (geo / place layer)
```bash
voyagier places search --query <q> [--source google|internal] [--country <code|id>] \
                       [--lat <f>] [--lng <f>] [--radius <m>] [--type <type>] \
                       [--limit <n>] [--page <n>] --json

voyagier places get <id> [--external] --json                # default: internal id; --external: Google Place ID

voyagier places attach --plan <id> --name <n> --place-id <pid> \
                       [--type <PlaceType>] [--country-id] [--country-name] \
                       [--description] [--image] [--iata-code <CODE>] [--url] [--place-timezone] --json

voyagier places list --plan <id> [--highlighted --category attraction|hotel|restaurant] --json

voyagier places highlight --plan <id> --place <detectedPlaceId> --category <c> [--ranking <n>] --json
voyagier places unhighlight --plan <id> --place <detectedPlaceId> --json
voyagier places remove --id <tripPlanPlaceId> --json
```

`--source google` uses Google Places (only `query` / `country` / `lat` / `lng` / `radius` are forwarded; `type` / `limit` / `page` are ignored).
`--source internal` uses Voyagier's internal place catalog (all flags supported).
`--type` and `--category` are normalized to PascalCase. `--iata-code` is validated as 3-letter alpha and uppercased.

### Bookings
```bash
voyagier bookings list --json
voyagier bookings get <id> --json
```
Read confirmed booking records (post-payment).

### Misc
```bash
voyagier whoami --json                  # identity + profile
voyagier chat                           # interactive AI assistant
voyagier chat -m "<single prompt>"
voyagier telemetry status|on|off
voyagier agent-docs                     # prints this file
```

---

## Building a Plan (manual flow — current canonical agent path)

Until VOY-1189 lands, `plan-trip --auto-select navigator` is broken. Use this manual flow:

```bash
# 1) Health check
voyagier doctor --json

# 2) Client (idempotent)
CLIENT_ID=$(voyagier clients upsert --email "$CLIENT_EMAIL" --name "$CLIENT_NAME" --type Individual --json | jq -r '.data.client.id')

# 3) Plan
PLAN_ID=$(voyagier plans create --client "$CLIENT_ID" --title "$TITLE" --json | jq -r '.data.plan.id')

# 4) Travellers
voyagier travellers add --plan "$PLAN_ID" --first "$FIRST" --last "$LAST" --type Adult --json

# 5) Flight: outbound + return
voyagier search flights --plan "$PLAN_ID" --from "$FROM" --to "$TO" \
  --date "$DEPART" --return "$RETURN" --json
voyagier select 1 --plan "$PLAN_ID" --json    # outbound (response includes actionRequired)
voyagier select 1 --plan "$PLAN_ID" --json    # return
voyagier options "$PLAN_ID" --json
voyagier pick 1 --plan "$PLAN_ID" --json      # cabin class

# 6) Hotel
voyagier search hotels --plan "$PLAN_ID" --location "$DEST" \
  --checkin "$DEPART" --checkout "$RETURN" --json
voyagier select 1 --plan "$PLAN_ID" --json
voyagier options "$PLAN_ID" --json
voyagier pick 1 --plan "$PLAN_ID" --json      # room type

# 7) Activities (the bookable inventory)
voyagier search activities --plan "$PLAN_ID" --destination "$DEST" \
  --date "$DEPART" --query "$ACTIVITY_QUERY" --json
voyagier select 1 --plan "$PLAN_ID" --json

# 8) Itinerary preview + bookability check
voyagier itinerary "$PLAN_ID" --json
voyagier book "$PLAN_ID" --validate --json

# 9) Book (only the actually-bookable items)
voyagier book "$PLAN_ID" --only-bookable --idempotency-key "$ULID" --json
```

### Plan composability

A plan is a shopping cart. Add legs and items by passing `--plan <id>` to subsequent commands:

```bash
# Add a second leg with a fresh search (do NOT pass --travellers again — they're reused)
voyagier search flights --plan "$PLAN_ID" --from "$LEG_2_FROM" --to "$LEG_2_TO" \
  --date "$LEG_2_DATE" --json
voyagier select 1 --plan "$PLAN_ID" --json

# Add another activity
voyagier search activities --plan "$PLAN_ID" --destination "$LEG_2_DEST" \
  --date "$LEG_2_DATE" --query "$Q" --json
voyagier select 1 --plan "$PLAN_ID" --json

# One checkout for everything bookable
voyagier book "$PLAN_ID" --only-bookable --json
```

---

## Bookability Matrix (v2)

| Selection | Bookable? | Source | Notes |
|---|---|---|---|
| Flight | ❌ | Sabre (display only) | `is_bookable = false` per platform migration #377. Itinerary display only. |
| Activity | ✅ per time slot | Viator | Primary bookable inventory. Pre-check via cart `isBookable` flag. |
| Hotel | ⚠️ partial | Blueprint Listings | Search/watch works. Checkout coverage is incomplete; default `book` skips unless `--types HOTEL`. |
| Ride | ❌ | TBD | Selection type exists; no booking source wired. |
| Restaurant | ❌ | Internal | Selection type exists; booking path unclear. |

Always run `voyagier book --validate <planId>` before checkout. Branch on `data.blockers[]`.

---

## Airport Resolution

`--from` and `--to` accept city names; CLI resolves to the primary IATA:

| Input | Resolves to |
|---|---|
| `Baltimore` | `BWI` |
| `"Washington DC"` | `DCA` |
| `Paris` | `CDG` |
| `Tokyo` | `NRT` |

Manual lookup: `voyagier search airports "tokyo" --json`.

---

## Known Quirks

- **Flight prices are per-person.** Multiply by traveller count for total.
- **Travel fee (~6%)** is added at checkout, not in cart subtotal.
- **Hotel search is Sabre-backed** with limited coverage; Blueprint Listings supplements but checkout is partial (see bookability matrix).
- **Search results expire ~2h.** Re-run `voyagier search ...` if `EXPIRED_OFFER` fires.
- **PNR is reserved at checkout time, not selection time.** A successful `select` does not lock the price.
- **Sub-selection navigation** (`options` → `pick`) operates on a separate `last-options.json` from search's `last-search.json`. Use `select` for primary selections, `pick` for sub-options.
- **`plan-trip --auto-select`** is broken on v2 schema (VOY-1189). Use the manual flow above.

---

## When You're Lost

If the CLI returns something unexpected:

1. `voyagier doctor --json` — health check (auth, schema, state, version).
2. Read the error envelope: `code` tells you which class of failure; `fix` gives the next command.
3. If `code` is `SCHEMA_DRIFT`: the CLI is older than the backend; upgrade.
4. If `code` is `STALE_PLAN_STATE` or `EXPIRED_OFFER`: re-run the relevant `voyagier search ...`.
5. For everything else, fall back to the manual flow above, one command at a time.

---

## Auth: Programmatic

```bash
export VOYAGIER_TOKEN=voy_pat_xxxxx          # PAT
export VOYAGIER_API_URL=https://dev.voyagier.com   # optional (defaults to prod)
```

PATs are created at voyagier.com → Settings → Personal Access Tokens. They never expire automatically; rotate when team membership changes.

---

*Print this in your shell at any time:*
```bash
voyagier agent-docs
```
