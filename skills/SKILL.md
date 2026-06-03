---
name: voyagier-cli
version: 1.2.0
description: "Voyagier CLI — search, plan, and book travel for clients. For human advisors and AI agents."
metadata:
  openclaw:
    category: travel
    requires:
      bins:
        - voyagier
---

# Voyagier CLI

Search flights, book hotels, manage trip plans from the terminal. Everything syncs to the web app at `voyagier.com/plans/{id}`.

## Install & Auth

```bash
npm install -g @voyagier/cli
voyagier auth set-token <PAT>    # save Personal Access Token
voyagier auth status             # verify connection
```

Get a PAT: voyagier.com → Settings → Personal Access Tokens → Create.

Or use env vars for CI/scripts:
```bash
export VOYAGIER_TOKEN=voy_pat_xxxxx
export VOYAGIER_API_URL=https://dev.voyagier.com  # optional
```

## Quick Reference

| Command | Description | `--json` | `--agent` |
|---------|-------------|----------|-----------|
| **Auth** | | | |
| `auth set-token <token>` | Save PAT | — | — |
| `auth status` | Check connection + user | — | — |
| `auth logout` | Clear credentials | — | — |
| `auth setup` | Configure home airports, cabin preference | — | — |
| `auth login` | Browser-based OAuth | — | — |
| **Plans** | | | |
| `plans create --title <t>` | Create trip plan | ✅ | — |
| `plans list` | List plans (`--active` for future only) | ✅ | ✅ |
| `plans get <id>` | Full plan details | ✅ | ✅ |
| `plans summary <id>` | Compact summary | ✅ | ✅ |
| `plans update <id>` | Update title/dates | ✅ | — |
| `plans delete <id>` | Delete plan | ✅ | — |
| `plans items <planId>` | List items with status | ✅ | — |
| `plans remove-item [id]` | Remove item(s) | ✅ | — |
| **Sharing** | | | |
| `plans share <planId>` | Invite collaborator (`--email` or `--user`) | ✅ | — |
| `plans collaborators <planId>` | List who has access | ✅ | — |
| `plans unshare <planId>` | Remove collaborator | ✅ | — |
| `plans shared` | Plans shared with you | ✅ | — |
| `plans comments <itemId>` | View/add comments | ✅ | — |
| `plans vote <itemId>` | Upvote/downvote items | ✅ | — |
| **Travellers** | | | |
| `travellers add --plan <id>` | Add traveller (required before search) | ✅ | — |
| `travellers list --plan <id>` | List travellers | ✅ | ✅ |
| `travellers update <id>` | Update traveller details | ✅ | — |
| `travellers remove <id>` | Remove traveller | ✅ | — |
| **Search** (async — returns a selectionId) | | | |
| `search flights` | Search flights (`--from`, `--to`, `--date`, `--return`, `--goal`, `--max-stops`) | ✅ | ✅ |
| `search hotels` | Search hotels (`--location`, `--checkin`, `--checkout`, `--goal`) | ✅ | ✅ |
| `search activities` | Search Viator experiences (`--destination`, `--date`, `--query`, `--goal`) | ✅ | ✅ |
| `search airports <query>` | Look up airport codes by city name | ✅ | ✅ |
| **Options & Selection** | | | |
| `selection-options <selectionId>` | Read/poll a selection's options (`--wait` to poll until ready) | ✅ | — |
| `select --selection-id <id> --option-id <id>` | Choose an option (direct mode) | ✅ | ✅ |
| `select <n>` | Choose by index from last search | ✅ | ✅ |
| `select --info <n>` | Preview option without selecting | ✅ | — |
| **Cart & Booking** | | | |
| `cart <planId>` | View cart with line items and totals | ✅ | ✅ |
| `book <planId>` | Checkout via Stripe (`--dry-run` to preview) | ✅ | ✅ |
| `book <planId> --status` | Check payment/booking status | ✅ | — |
| `bookings list` | List booking records | ✅ | — |
| `bookings get <id>` | Booking details (PNR, ticket refs) | ✅ | — |
| **AI Chat** | | | |
| `chat` | Interactive AI trip planning REPL | — | — |
| `chat -m "message"` | Single-turn non-interactive query | — | — |
| **Goals** | | | |
| `plans goals <planId>` | Inspect the goal graph + readiness / what still needs a decision | ✅ | ✅ |
| **Scaffold** | | | |
| `plan-trip` | Create plan + default goal graph (adds travellers only with `--travellers`), print compose next-steps | ✅ | ✅ |

## Core Workflow

A plan is a **goal graph**. You scaffold the plan, then compose it by searching against goals and selecting options. **Search is asynchronous** — it creates a selection, and options are fetched in the background, so you poll with `selection-options --wait`.

```bash
# 1. Scaffold a plan (plan + default goal graph)
voyagier plan-trip --client "Smith Family" --title "Smith Family — Tokyo" --json

# 2. Add travellers (required before search)
voyagier travellers add --plan <PLAN_ID> --first John --last Smith --type Adult --json

# 3. Search flights (accepts city names or IATA codes) → returns a selectionId
voyagier search flights --plan <PLAN_ID> --from "Washington DC" --to NRT --date 2026-09-01 --return 2026-09-08 --json

# 4. Poll the selection until options are ready, then choose one
voyagier selection-options <SELECTION_ID> --wait --json
voyagier select --selection-id <SELECTION_ID> --option-id <OPTION_ID> --json

# 5. Search a hotel → poll → select
voyagier search hotels --plan <PLAN_ID> --location "Tokyo" --checkin 2026-09-01 --checkout 2026-09-08 --json
voyagier selection-options <SELECTION_ID> --wait --json
voyagier select --selection-id <SELECTION_ID> --option-id <OPTION_ID> --json

# 6. Inspect readiness at any time
voyagier plans goals <PLAN_ID> --json

# 7. Review cart
voyagier cart <PLAN_ID> --json

# 8. Book (opens Stripe checkout)
voyagier book <PLAN_ID> --validate --json   # pre-flight check first
voyagier book <PLAN_ID>                      # actual checkout

# 9. Share with client
voyagier plans share <PLAN_ID> --email client@example.com --role viewer
```

The plan URL (`voyagier.com/plans/{id}`) is shown after every command. Clients view and interact with the same plan in the web app.

## Output Modes

| Flag | Audience | Format |
|------|----------|--------|
| *(none)* | Human at terminal | Colored text (chalk) |
| `--json` | Agents and scripts | Structured JSON to stdout |
| `--agent` | AI → human display | Plain markdown (no ANSI), plan URL prominent |
| `--dry-run` | Debug/preview | Shows what would happen without executing |

**For AI agents: always use `--json`.** It's the primary agent interface — consistent, parseable, complete. `--agent` is optional markdown for display.

## JSON Output Contract

Every `--json` response follows these rules:
- **Plan URL** included as `url` field when plan context exists
- **Errors** return: `{ "error": true, "code": "<ERROR_CODE>", "message": "..." }`
- **Error codes:** `AUTH_FAILED`, `NOT_FOUND`, `VALIDATION`, `API_ERROR`, `NETWORK`, `STATE_CORRUPT`
- **Exit codes:** 0 = success, 1 = handled error, 2 = unexpected error

Key JSON shapes:

```
plans create  → { ...plan, url, planSummary }   # full plan fields + url + planSummary
plans list    → { items: [{ id, title, startDate, endDate, url }], total, page, limit }
plans get     → { id, title, items: [...], travellers: [...], url }
search flights → { tripPlanId, selectionId, options: [...], url }   # flat shape; options often empty initially (async)
selection-options → { selectionId, status, optionCount, options: [{ id, name, price, ... }] }
select        → { success, selected: { name, price }, url }
cart          → { items: [...], total, currency, url }
book          → { checkoutUrl } or { status, bookingRecords: [...] }
```

## Airport Resolution

`--from` and `--to` accept city names in addition to IATA codes:
- **Unambiguous:** `--from Baltimore` → resolves to BWI automatically
- **Metro area:** `--from "Washington DC"` → uses DCA (primary), shows all options (DCA, IAD, BWI)
- **Ambiguous:** shows candidates and exits with error
- **Lookup:** `voyagier search airports "tokyo"` to browse

## Known Quirks

- **Hotel search coverage is limited** — Sabre GDS doesn't have all properties. Luxury/boutique hotels may need direct booking.
- **Airport codes required for search** — Flight search needs IATA codes or resolvable city names, not destination names like "Tuscany."
- **Search is asynchronous** — `search` creates a selection and returns a `selectionId`; options arrive shortly after. Poll with `voyagier selection-options <selectionId> --wait` until the status is **terminal** — `READY`, `NO_RESULTS`, `AWAITING_INPUT`, or `FETCH_ERROR` (only `FETCHING` keeps polling). Don't expect priced options in the immediate `search` response.
- **Selecting uses selection + option IDs** — `voyagier select --selection-id <id> --option-id <id>`. Index-based `select <n>` works against the last search, but direct IDs are the reliable agent path.
- **Flight prices are per-person** — Multiply by traveller count for total.
- **Travel fee (6%)** is added at checkout, not shown in cart subtotal.
- **PNR is reserved at checkout** — Sabre fare is locked when `book` runs, not when `select` runs.
- **Search results expire ~2h** — GDS offer TTL. Re-search for current pricing.

## Security

- Never output PAT tokens in command output
- Confirm with user before `book` (checkout creates real charges)
- Credentials stored at `~/.voyagier/credentials.json` (mode 0600)
- `--dry-run` on `book` to preview without creating checkout
