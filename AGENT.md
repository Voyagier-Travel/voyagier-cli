# Voyagier CLI — Agent Reference

> Canonical integration guide for AI agents driving `@voyagier/cli`.
> Print this at runtime: `voyagier agent-docs`.
> Always pass `--json` for machine-readable output.

---

## What changed in v2.0.0

This is a **clean rebuild** against the new advisor-first / Blueprint trip-plan model. v1.x is broken against the current backend schema and is deprecated. Highlights:

- **Computed itinerary** replaces hand-crafted item metadata. `voyagier itinerary <planId>` reads the platform's `tripPlanEvents` resolver.
- **Advisor CRM** is a first-class concept. New `voyagier clients` command group.
- **Multi-source bookability.** Flights are display-only (`isBookable = false`). Activities (Viator) are the primary bookable inventory. Hotels (Blueprint Listings) are searchable but checkout coverage is partial.
- **Inventory escape hatch.** New `voyagier listings` command group surfaces Blueprint Listing change events.
- **Place / geo layer.** New `voyagier places` command group wraps Google Places + the internal place catalog + TripPlanPlace management.
- **Self-check.** New `voyagier doctor` command verifies auth, schema reachability, state, and version.

For the full breaking-changes table see [`CHANGELOG.md`](./CHANGELOG.md).

> ⚠️ **Known gaps in this release (don't rely on these yet):**
>
> - `voyagier plan-trip --auto-select navigator` is broken on the v2 schema (tracked as [VOY-1189](https://linear.app/voyagier/issue/VOY-1189)). Use the manual flow below.
> - `voyagier plans create` and `plan-trip` do **not** yet take a `--client` flag, even though every TripPlan must server-side belong to a client per the new model. Plan creation today still uses the v1 input shape; `clientId` wiring is tracked as [VOY-1193](https://linear.app/voyagier/issue/VOY-1193).
> - The `--json` envelope is **not yet uniform** across commands. The newer surfaces (cart, book, bookable, itinerary, listings, places) emit `{ ok: true, data, planContext? }`. The older surfaces (clients, plans) emit ad-hoc shapes documented per-command below. Unification tracked as [VOY-1192](https://linear.app/voyagier/issue/VOY-1192).
> - `voyagier book --types` and `--only-bookable` are **client-side preflight gates only** — they do not yet pass an item filter to the `createTripPlanCheckout` mutation. Use `--validate` first, and only invoke `book` once the cart actually contains the items you want to charge.

---

## Quick Start

The fastest grounded loop for an agent against the current release. (`--json` is a per-command flag — supported on every command shown below; not on `chat`, `telemetry`, or `auth login` / `setup`.)

```bash
# 0) Health check
voyagier doctor --json

# 1) Resolve a client (idempotent by email)
voyagier clients upsert --email "smith@example.com" --name "Smith Family" --type Individual --json
# Returns: { client: { id, name, ... }, ok: true, created: true|false }

# 2) Create the plan (server-side will require a clientId once VOY-1193 lands;
#    until then the CLI doesn't pass it. The plan is created against your
#    user account.)
voyagier plans create --title "Smith — Tokyo" --start 2026-09-15 --end 2026-09-22 --json
# Returns: { ...plan, url, planSummary }

# 3) Add travellers
voyagier travellers add --plan <PLAN_ID> --first John --last Smith --type Adult --json

# 4) Search → select → pick
voyagier search flights --plan <PLAN_ID> --from JFK --to NRT \
  --date 2026-09-15 --return 2026-09-22 --json
voyagier select 1 --plan <PLAN_ID> --json
voyagier select 1 --plan <PLAN_ID> --json    # return leg
voyagier options <PLAN_ID> --json
voyagier pick 1 --plan <PLAN_ID> --json      # cabin

voyagier search activities --plan <PLAN_ID> --destination Tokyo \
  --date 2026-09-16 --query "sushi tour" --json
voyagier select 1 --plan <PLAN_ID> --json

# 5) Pre-flight + book
voyagier book <PLAN_ID> --validate --json    # see what's actually bookable
# Then build a fresh cart with only the items you want and call book again.
voyagier book <PLAN_ID> --json
```

`--plan <id>` on `select` and `pick` is mandatory. It guards against cross-plan state corruption when you run multiple workflows in parallel.

---

## Output Conventions

### Output modes

- `--json` — agent-targeted, machine-readable. **Per-command flag**, not a global default. Most data-bearing commands (`plans`, `clients`, `cart`, `book`, `itinerary`, `listings`, `places`, `bookings`, `whoami`, `doctor`, `search`, `select`, `pick`, `travellers`, ...) accept it. Some commands do not: `chat`, `telemetry`, and most `auth` subcommands have no JSON shape and will reject `--json` with an unknown-option error. When in doubt, run `voyagier <command> --help`.
- `--agent` — markdown rendered for AI → human display. Same per-command rule applies.
- (default) — chalk-colored TTY for humans.

### Success-payload shape: command-specific (NOT yet uniform)

v2.0.0 has two payload styles. Pick the right shape for the command you're calling:

**Style A — wrapped envelope** (doctor, cart, book, bookable, itinerary, listings, places — i.e. the Section 3 / 7 / 9 surfaces):

```json
{
  "ok": true,
  "data": { /* command-specific payload */ },
  "planContext": {
    "planId": "...",
    "title": "...",
    "url": "https://app.voyagier.com/plans/..."
  }
}
```

**Style B — flat / domain-specific** (clients, plans, travellers, search, select, pick, whoami — the older / Section 1 surfaces):

```json
// clients list:    { "clients": [...], "total": 12 }
// clients get:     { "client": { id, name, ... } }
// clients upsert:  { "client": { ... }, "ok": true, "created": false }
// plans create:    { "id": "...", "title": "...", "url": "...", "planSummary": "..." }
// plans list:      { "items": [...], "total": 12, "page": 1, "limit": 20 }
// search flights:  { "options": [...], "planContext": { ... } }
```

When in doubt: pipe `--json` through `jq keys` to inspect. The unification work is tracked as [VOY-1192](https://linear.app/voyagier/issue/VOY-1192).

### Error envelope (uniform across commands)

```json
{
  "error": true,
  "code": "ERROR_CODE",
  "message": "Human-readable explanation.",
  "details": { /* optional structured context, e.g. blockers[] */ }
}
```

Branch on `code`. The CLI exits 1 for `CliError`s, 2 for unexpected errors. Pass `--stacktrace` to get the full stack on stderr alongside the JSON.

### Error codes (what the CLI actually emits today)

| Code | Meaning | Typical recovery |
|---|---|---|
| `AUTH_FAILED` | No PAT, expired, or rejected | `voyagier auth set-token <PAT>` or `voyagier auth login` |
| `NOT_FOUND` | Resource doesn't exist | (resource-specific) |
| `VALIDATION` | Input failed CLI-side validation | follow `message` |
| `API_ERROR` | Backend GraphQL error | inspect `details`; may indicate `SCHEMA_DRIFT` |
| `NETWORK` | Couldn't reach the API | check connectivity; `voyagier doctor --json` |
| `STATE_CORRUPT` | Local state file unreadable | delete affected file under `~/.voyagier/` |
| `NO_CLIENTS` | Account has no ACTIVE clients | `voyagier clients create --name ... --type Individual` |
| `MULTIPLE_CLIENTS` | Ambiguous email match in upsert | pass an explicit `--client <id>` (where supported) |
| `CLIENT_REQUIRED` | Reserved for the in-flight VOY-1193 work; not currently emitted | — |
| `PERMISSION_DENIED` | RBAC failure (non-advisor on advisor-gated mutation) | escalate to user |
| `SCHEMA_DRIFT` | CLI is older than backend; queries don't validate | `npm i -g @voyagier/cli@latest` |
| `NOT_BOOKABLE` | Selection type is display-only (e.g. flight) | filter the cart manually before booking |
| `BOOKING_BLOCKED` | Pre-flight blockers found by `book --validate` | each blocker carries its own context in `details.blockers[]` |
| `EXPIRED_OFFER` | Selection option no longer available | re-run `voyagier search ...` |
| `STALE_PLAN_STATE` | Cached search/option expired | re-run `voyagier search ...` with `--plan <id>` |
| `LISTING_NOT_FOUND` | Blueprint listing missing or unavailable | `voyagier listings recent --selection <id>` |
| `PLACE_NOT_FOUND` | Place ID does not resolve | `voyagier places search --query ...` |
| `NO_MONITOR` | Selection has no Blueprint monitor attached | (advisor must enable monitoring; not yet exposed in CLI) |

### Idempotency

A subset of mutating commands accept `--idempotency-key <ulid>`:

- `voyagier book`
- `voyagier listings add-to-selection`
- `voyagier places attach`, `places highlight`, `places unhighlight`, `places remove`

The key is **echoed in `--json` output today** (e.g. `data.idempotencyKey`) so agents can track retries on their side. Server-side de-duplication is a future change. **Other mutating commands** (`clients create/update/upsert`, `plans create`, `travellers add`, etc.) do **not** accept the flag — passing it will fail option parsing.

### State files (`~/.voyagier/`)

- `credentials.json` — PAT + API URL (managed by `voyagier auth`)
- `last-search.json` — most recent search results, **global single file** (cross-plan corruption prevented by `--plan <id>` mismatch checks on `select`)
- `last-options.json` — last sub-option list, **global single file** (same protection)

There is no client-list cache file today; `voyagier clients list` always hits the network.

---

## Command Reference (v2 surface)

### Auth
```bash
voyagier auth set-token <PAT>      # save Personal Access Token
voyagier auth status --json        # verify connection
voyagier auth login                # browser-based flow
voyagier auth logout
```

Env vars: `VOYAGIER_TOKEN`, `VOYAGIER_API_URL`. Tokens never expire automatically; rotate when team membership changes.

Top-level shortcut: `voyagier login` is rewritten to `voyagier auth login`.

### Doctor (Style A JSON)
```bash
voyagier doctor --json
# Returns: { ok: boolean, data: { checks: [...], overall: "PASS" | "WARN" | "FAIL" } }
# `ok` is true unless `overall === "FAIL"`. Process exits 1 on FAIL.
```
Each `checks[]` entry is `{ name, status: "PASS" | "WARN" | "FAIL", message, details? }`. The covered checks today are auth, schema reachability, state-file health, and version. Run this first whenever you encounter an unfamiliar error.

### Clients (advisor CRM, Style B JSON)
```bash
voyagier clients list [--status active|archived] [--type individual|company|group] --json
# Returns: { clients: [...], total }

voyagier clients get <id> --json
# Returns: { client }

voyagier clients create --name <n> --type individual|company|group [--email] [--phone] [--avatar] [--description] --json
# Returns: { client, ok: true }

voyagier clients update <id> [--name] [--type] [--email] [--phone] [--avatar] [--description] [--status active|archived] --json
voyagier clients archive <id> --json
voyagier clients upsert --email <e> --name <n> --type <t> [--phone] [--avatar] [--description] --json
# upsert returns: { client, ok: true, created: boolean }
```

`upsert` is the agent-friendly idempotency primitive: returns existing match by email or creates new. Lowercase input (`individual`) is normalized to PascalCase (`Individual`) for the schema.

### Plans (Style B JSON)
```bash
voyagier plans create --title <title> [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>] [--description <text>] --json
# Returns: { ...plan, url, planSummary }
# NOTE: server-side now expects clientId; the CLI does not yet pass it (VOY-1193).

voyagier plans list [--active] [--page <n>] [--limit <n>] --json
voyagier plans get <id> --json
voyagier plans summary <id> --json
# NOTE: summary still iterates plan.items for compat. The canonical time-sorted view is voyagier itinerary <id> (VOY-1194).

voyagier plans bookable <id> --json
# Style A: { ok: true, data: { items: [...], blockers: [...], summary }, planContext }

voyagier plans delete <id> --json
```

### Itinerary (Style A JSON)
```bash
voyagier itinerary <planId> --json
voyagier itinerary <planId> --day 3 --json
voyagier itinerary <planId> --from 2026-09-15 --to 2026-09-18 --json
voyagier itinerary <planId> --type flight --json
```

Sourced from the `tripPlanEvents` resolver. Output:

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
        "description": "...",
        "location": { "name": "...", "address": "...", "placeId": "...", "metadata": { /* opaque */ } },
        "metadata": { "type": "FLIGHT" }
      }
    ],
    "total": 12,
    "totalUnfiltered": 12,
    "dayRange": { "first": 1, "last": 8 }
  },
  "planContext": { "planId": "...", "title": "...", "url": "..." }
}
```

`location` shape comes from the schema's `TripPlanEventLocation` (`name`, `address`, `placeId`, `metadata: JSON`); coordinates, when present, live inside `metadata`. `dayRange` is numeric — day indexes computed relative to `plan.startDate` (Day 1 = the plan's start date).

`--type` filtering is best-effort against `metadata.{type|eventType|selectionType|kind}`. Top-level typed fields aren't in the schema today.

### Travellers (Style B JSON)
```bash
voyagier travellers add --plan <id> --first <f> --last <l> --type Adult|Child|Infant --json
voyagier travellers list --plan <id> --json
voyagier travellers update <travellerId> [...] --json
voyagier travellers remove <travellerId> --json
```

### Search → Select → Pick

```bash
voyagier search flights --plan <id> --from <iata> --to <iata> --date <YYYY-MM-DD> [--return <YYYY-MM-DD>] --json
voyagier search hotels --plan <id> --location <city> --checkin <date> --checkout <date> --json
voyagier search activities --plan <id> --destination <city> --date <date> [--query <q>] --json
voyagier search airports "<query>" --json

voyagier select <n> --plan <id> --json     # 1-indexed pick from last search
voyagier options <planId> --json           # surfaces sub-options (cabin, room type)
voyagier pick <n> --plan <id> --json       # picks from last sub-options
```

For round-trip flights, `select` is run twice (departure, then return). The departure response includes an `actionRequired` field pointing at the next command.

### Cart + Book (Style A JSON)
```bash
voyagier cart <planId> --json
# Returns: { ok, data: { items, blockers, summary }, planContext }
```

```bash
voyagier book <planId> --validate --json                 # pre-flight only; reports blockers, no Stripe call
voyagier book <planId> --only-bookable --json            # client-side filter; skips display-only items in the preflight gate
voyagier book <planId> --types Activity,Hotel --json     # client-side filter; case-insensitive match against CartItemType
voyagier book <planId> --idempotency-key <ulid> --json   # echoed in JSON; not yet sent server-side
voyagier book <planId> --dry-run --json                  # show GraphQL without executing
voyagier book <planId> --status --json                   # post-payment confirmation lookup
```

> ⚠️ **`--types` and `--only-bookable` are client-side preflight gates today.** They affect what `--validate` considers blocking, but the actual `createTripPlanCheckout` mutation still targets the full cart. To control what's charged, **build a clean cart first** (don't add display-only items, or remove them) and then call `book`.

`--validate` returns blockers without attempting checkout. Sample shape (matches the standard error envelope above — there is no top-level `ok`, `data`, or `planContext` on `CliError` output):

```json
{
  "error": true,
  "code": "BOOKING_BLOCKED",
  "message": "...",
  "details": {
    "blockers": [
      { "selectionId": "...", "code": "NOT_BOOKABLE", "message": "Flight items are display-only.", "fix": "Remove flight selections before booking." }
    ]
  }
}
```

Individual `blockers[]` entries carry their own `fix` strings; the top-level error envelope does not.

### Listings (Style A JSON — Blueprint advisor inventory)
```bash
voyagier listings recent --selection <id> [--type <changeType>] [--limit <n>] --json
voyagier listings add-to-selection <selectionId> --listing <listingId> [--idempotency-key <ulid>] --json
```

`listings recent` first fetches the selection's `blueprintMonitorId`. If the selection has no monitor, returns `NO_MONITOR`. `--type` accepts kebab-case (`availability-changed`, `new-listing`, `price-changed`); normalized to PascalCase server-side.

### Places (Style A JSON — geo / place layer)
```bash
voyagier places search --query <q> [--source google|internal] [--country <code|id>] \
                       [--lat <f>] [--lng <f>] [--radius <m>] [--type <type>] \
                       [--limit <n>] [--page <n>] --json

voyagier places get <id> [--external] --json   # default: internal; --external: Google Place ID

voyagier places attach --plan <id> --name <n> --place-id <pid> [...] [--idempotency-key <ulid>] --json
voyagier places list --plan <id> [--highlighted --category attraction|hotel|restaurant] --json
voyagier places highlight --plan <id> --place <detectedPlaceId> --category <c> [--ranking <n>] [--idempotency-key <ulid>] --json
voyagier places unhighlight --plan <id> --place <detectedPlaceId> [--idempotency-key <ulid>] --json
voyagier places remove --id <tripPlanPlaceId> [--idempotency-key <ulid>] --json
```

`--source google` uses Google Places (forwards `query` / `country` / `lat` / `lng` / `radius` only; `type` / `limit` / `page` are ignored). `--source internal` uses Voyagier's catalog (all flags supported). `--type` and `--category` are normalized to PascalCase. `--iata-code` on `attach` is validated as 3-letter alpha and uppercased.

### Bookings
```bash
voyagier bookings list --json
voyagier bookings get <id> --json
```

### Misc
```bash
voyagier whoami --json                # identity + profile
voyagier chat                         # interactive AI assistant
voyagier chat -m "<single prompt>"
voyagier telemetry status|on|off
voyagier agent-docs                   # prints this file
```

---

## Bookability Matrix (v2)

| Selection | Bookable? | Source | Notes |
|---|---|---|---|
| Activity | ✅ per slot | Viator | Primary bookable inventory. Pre-check via cart `isBookable` flag. |
| Hotel | ⚠️ partial | Blueprint Listings | Search/watch works. Checkout coverage is incomplete. |
| Flight | ❌ display only | Sabre | `is_bookable = false` per platform migration #377. Itinerary view only. |
| Ride | ❌ | TBD | Selection type exists; no booking source wired. |
| Restaurant | ❌ | Internal | Selection type exists; booking path unclear. |

Always `voyagier book --validate <planId>` before checkout. Branch on `details.blockers[]`. Build a clean cart for the `book` call rather than relying on `--types` to filter the mutation.

---

## Airport Resolution

`--from` and `--to` accept city names; the CLI resolves to the primary IATA:

| Input | Resolves to |
|---|---|
| `Baltimore` | `BWI` |
| `"Washington DC"` | `DCA` |
| `Paris` | `CDG` |
| `Tokyo` | `NRT` |

Manual lookup: `voyagier search airports "tokyo" --json`.

---

## Known Quirks

- **JSON shape is not uniform across commands** (see Output Conventions above). Tracked as VOY-1192.
- **`plan-trip --auto-select` is broken** on the v2 schema (VOY-1189). Use the manual flow.
- **`plans create` and `plan-trip` do not yet take `--client`** (VOY-1193). Plans are created against the user account today; the server-side `clientId` requirement isn't yet plumbed through the CLI.
- **`book --types` and `--only-bookable` are client-side gates only** — they don't filter the checkout mutation. Build a clean cart before calling `book`.
- **`plans summary` reads `plan.items`**, not `tripPlanEvents` (VOY-1194). Use `voyagier itinerary <planId>` for the canonical time-sorted view.
- **State files are global, not per-plan.** Cross-plan corruption is prevented by `--plan <id>` mismatch checks, not by file partitioning.
- **Flight prices are per-person.** Multiply by traveller count for total.
- **Travel fee (~6%)** is added at checkout, not in cart subtotal.
- **PNR is reserved at checkout time, not selection time.** A successful `select` does not lock the price.
- **Search results expire ~2h.** Re-run `voyagier search ...` if `EXPIRED_OFFER` fires.

---

## When You're Lost

1. `voyagier doctor --json` — health check (auth, schema, state, version).
2. Read the error envelope: `code` tells you the failure class; `message` and `details` give context.
3. If `code` is `SCHEMA_DRIFT`: the CLI is older than the backend; upgrade.
4. If `code` is `STALE_PLAN_STATE` or `EXPIRED_OFFER`: re-run the relevant `voyagier search ...`.
5. For everything else, fall back to the manual flow above, one command at a time.

---

## Auth: Programmatic

```bash
export VOYAGIER_TOKEN=voy_pat_xxxxx
export VOYAGIER_API_URL=https://travel.voyagier.com/api   # optional; CLI appends /graphql
```

PATs are created at voyagier.com → Settings → Personal Access Tokens.

---

*Print this in your shell at any time:* `voyagier agent-docs`
