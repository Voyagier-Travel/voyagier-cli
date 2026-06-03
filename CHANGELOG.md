# Changelog

All notable changes to `@voyagier/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.1] — 2026-06-03

Composable goal-graph write path. The CLI now composes a trip by searching against the plan's goals and selecting options on the resulting selections, instead of a synchronous search-and-attach flow.

### Changed

- **`search` is asynchronous and goal-based.** `search flights | hotels | activities` resolves the target goal (`--goal <id>`, or the first matching goal) and its mirror list, sets the provided inputs, and creates a mirroring selection. The response returns a `selectionId`; options are fetched in the background. New flags: `--goal` (all), `--max-stops` (flights), `--replace` (hotels, activities).
- **`select` chooses by IDs.** `voyagier select --selection-id <id> --option-id <id>` is the primary path. Index-based `select <n>` still works against the last cached search; `--plan <id>` asserts plan ownership of the cache.
- **`plan-trip` is a scaffold.** It creates the plan + default goal graph (and adds travellers only when `--travellers` is provided), then prints the exact compose next-steps for that plan. It no longer auto-searches or auto-selects.

### Added

- **`voyagier selection-options <selectionId>`** — read or poll a selection's options. `--wait` polls with backoff until options are ready or a terminal status (e.g. `AWAITING_INPUT`) is reached; `--timeout <seconds>` bounds the wait; `--human` forces readable output.

### Deprecated

- **`voyagier options` / `voyagier pick`** — the sub-selection model is gone. Both commands are now **retired migration stubs**: they still exist and print a message pointing you to the replacements rather than doing anything. Use `selection-options` to read/poll options and `select --selection-id --option-id` to choose.

---

## [2.1.0] — 2026-05-04

Minor release: ships **Sections 4 (Goals) + 6 (Traveller Groups + Choices)**, agent-surface cleanup, and AGENT.md error-code documentation. Mark unblocked these surfaces in his 2026-05-04 Slack DM: *"TripPlanGoal mutations are frozen along with ParticipantChoice and BlueprintSync."*

### Added

#### New command groups
- `voyagier plans goals | goal | goal-add | goal-add-with-selection | goal-update | goal-remove | goal-assign-travellers | goal-add-item | goal-add-item-with-selection | goal-reorder` — TripPlanGoal surface ([VOY-1202](https://linear.app/voyagier/issue/VOY-1202) / [PR #49](https://github.com/Voyagier-Travel/voyagier-cli/pull/49)).
- `voyagier traveller-groups list | get | create | update | delete | add-members | remove-members | upsert` — TripPlanTravellerGroup surface ([VOY-1204](https://linear.app/voyagier/issue/VOY-1204) / [PR #50](https://github.com/Voyagier-Travel/voyagier-cli/pull/50)).
- `voyagier traveller-choices list` — read-only inspection of per-traveller selection choices with `--pending`, `--traveller`, `--goal`, `--type` filters ([VOY-1204](https://linear.app/voyagier/issue/VOY-1204)).

#### New error codes
- `GOAL_NOT_FOUND` — goals surface.
- `GROUP_NAME_REQUIRED`, `MEMBERS_REQUIRED`, `TRAVELLER_NOT_IN_PLAN`, `PLAN_NOT_FOUND` — traveller-groups surface.

### Changed

#### Help text reframing (agent leverage points)

The help text for three flags was rewritten to read as **agent leverage points** rather than fillable form fields. The framing is meant to nudge agents toward passing distilled upstream context (when they have it) and omitting (when they don't) instead of generating boilerplate to fill the field.

- `voyagier clients create --description` / `clients update --description` — framed as "distilled client brief from the agent's upstream context."
- `voyagier plans goal-add-with-selection --question-template` — framed as "prompt template the traveller will see in the web UI; pass when the agent has distilled meaningful intent."
- `voyagier plans goal-add-with-selection --initial-search` (renamed from `--initial-query`, see below) — framed as "initial search query that seeds this selection."

#### Renamed

- `voyagier plans goal-add-with-selection --initial-query` is now `--initial-search` for clarity (reads like user intent, not GraphQL plumbing). Old flag name accepted as a deprecated alias — emits a one-line stderr warning and routes to the new flag. Removed in v2.2.0.

### Deprecated

All deprecated flags continue to work in v2.1.0 with a stderr warning. Removal target: **v2.2.0**.

- `voyagier clients create --avatar` / `clients update --avatar` / `clients upsert --avatar` — an agent has no upstream context to anchor a valid avatar URL. Set avatars in the web UI.
- `voyagier clients upsert --description` — free-text on an idempotent operation breaks the idempotency contract (re-running the same upsert with a slightly different description string is non-idempotent). Use `voyagier clients update --description` after upsert resolves.
- `voyagier places attach --country-name` — resolved server-side from `--country-id`.
- `voyagier places attach --description` / `--image` / `--url` — resolved server-side from the upstream Place entity (Google Places / Foursquare cache). Agent-supplied overrides cause drift between the place record and downstream UI surfaces.
- `voyagier plans goal-add-with-selection --initial-query` — use `--initial-search` instead.

### Documented

- AGENT.md error-code table now covers all v2.x codes including the 5 added in this release.
- Help text on agent-leverage flags includes concrete "pass when / omit when / never with" guidance — see [./AGENT.md](./AGENT.md).

### Tests

- 720 → 746 (+26 from cleanup PR; main was at 741 after VOY-1204 merged plus 5 from this cleanup work).
- All 25 suites passing.

---

## [2.0.0] — 2026-05-03

> ⚠️ **Breaking release.** v1.x is broken against the current Voyagier backend schema (37% of GraphQL operations fail on `dev.voyagier.com`). v2.0.0 is a clean rebuild against the new advisor-first / Blueprint trip-plan model.
>
> Migration is one-way: there is no compat shim. v1.x is deprecated.

### Highlights

- **Computed itinerary** replaces hand-crafted item metadata. New `voyagier itinerary <planId>` reads the platform's `tripPlanEvents` resolver.
- **Advisor CRM** is now a first-class concept. New `voyagier clients` command group manages the CRM layer.
- **Multi-source bookability.** Flights are display-only (`isBookable = false`); activities (Viator) are the primary bookable inventory; hotels (Blueprint Listings) are search-and-watch with checkout pending.
- **Inventory escape hatch.** New `voyagier listings` command group surfaces Blueprint Listing change events and adds listings to selections.
- **Place / geo layer.** New `voyagier places` command group wraps Google Places + the internal place catalog + TripPlanPlace management.
- **Self-check.** New `voyagier doctor` command verifies auth, schema reachability, state-file health, and version.

### Added

#### New command groups
- `voyagier clients list | get | create | update | archive | upsert` — advisor CRM (TripPlanClient).
- `voyagier itinerary <planId>` — computed itinerary from `tripPlanEvents`. Supports `--day`, `--from`, `--to`, `--type` filters.
- `voyagier listings recent | add-to-selection` — Blueprint Listings inventory ([VOY-1190](https://linear.app/voyagier/issue/VOY-1190)).
- `voyagier places search | get | attach | list | highlight | unhighlight | remove` — geo / place layer ([VOY-1190](https://linear.app/voyagier/issue/VOY-1190)).
- `voyagier doctor` — diagnostic self-check with PASS / WARN / FAIL rollup ([VOY-1186](https://linear.app/voyagier/issue/VOY-1186)).
- `voyagier plans bookable <planId>` — pre-flight bookability summary with per-item blockers ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)).

#### New flags on existing commands
- `voyagier book` gained `--validate`, `--only-bookable`, `--types`, `--idempotency-key` ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)). See **Known Issues** for current scope of these flags.

#### New error codes
- `LISTING_NOT_FOUND`, `PLACE_NOT_FOUND`, `NO_MONITOR` — listings + places surfaces.
- `NOT_BOOKABLE`, `BOOKING_BLOCKED`, `EXPIRED_OFFER`, `STALE_PLAN_STATE` — booking pre-flight ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)).
- `SCHEMA_DRIFT` — when CLI is built against an older schema than the backend.
- `PERMISSION_DENIED` — RBAC failures (e.g., non-advisors attempting plan creation).
- `NO_CLIENTS`, `MULTIPLE_CLIENTS`, `CLIENT_REQUIRED` — client-resolution surfaces. `CLIENT_REQUIRED` is emitted by `plan-trip --client ""` or `plans create --client ""` (explicit-but-empty); `NO_CLIENTS` and `MULTIPLE_CLIENTS` are emitted by both the `plan-trip` and `plans create` auto-resolve paths.

#### Helpers (exported for downstream tooling)
- Numeric validators: `parsePositiveInt`, `parseNonNegativeInt`, `parseFloatStrict({min, max, nonNegative})`.
- Output safety: `formatNullableBool` (tri-state Yes / No / Unknown), `escapeMdTableCell` (markdown table cell escaping for `--agent` output).
- Place / client / monitor enum normalizers: `normalizeListingChangeType`, `normalizeHighlightCategory`, `normalizePlaceType`, `parseSearchLocation`.

### Changed

- **`voyagier cart`** rewritten against the v2 schema. No more `subSelectionOptionId`. `CartItemType` is PascalCase. Cart items grouped by goal in `--json` output. Single round-trip bookability fetch ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)).
- **`voyagier book`** preflight gates introduced (`--validate`, `--only-bookable`, `--types`). PNR reservation happens at checkout time; `--dry-run` previews without reserving. (See **Known Issues** for the current scope of `--types` / `--only-bookable`.)
- **`voyagier plans create`** error semantics changed. Server-side now requires `clientId` per the new `TripPlanCreatorGuard`; the CLI does not yet pass it ([VOY-1193](https://linear.app/voyagier/issue/VOY-1193)). The CLI flag surface is unchanged from v1 (`--title`, `--start`, `--end`, `--description`).
- **`--idempotency-key`** is echoed in `--json` output for the commands that accept it (`book`, `listings add-to-selection`, four `places` mutations). Server-side de-duplication is forward-compatible.
- **`--agent` help text** standardized to `"Output plain markdown for AI agents"` across listings + places commands for `--help` consistency.
- **`--type` casing** in `places search` and `places attach` normalized through `normalizePlaceType` so `--type hotel` and `--type Hotel` behave identically. Already-PascalCase multi-word inputs (e.g. `TouristAttraction`) preserved verbatim.
- **IATA validation** on `places attach --iata-code` now boundary-validates through the existing `validateIata` helper and uppercases lowercase input.

### Deprecated

- **`@voyagier/cli@1.x`** is deprecated. v1.x cannot drive workflows against the current backend schema.

### Removed

- **GraphQL fields no longer requested** by the CLI:
  - `bookingData` on `TripPlanSelectOption` → renamed to `optionData` upstream.
  - `selection` (singular) on `TripPlanItem` → use `selections` (plural).
  - `selectedOption` on `TripPlanSelection` → use `parentOption`.
  - `subtitle`, `start_time`, `end_time`, `details`, `day`, `date` on `TripPlanItem` → all deleted; the canonical itinerary is now computed via `tripPlanEvents`.
  - `subSelectionOptionId` on cart items → no longer exists; reference `selectionId + optionId`.
  - `createdAt` on `TripPlanPaymentCheckout` → no longer exists.
- **Subselection mutations no longer called:** `setTripPlanSubSelectionOption`, `selectDepartureFlight`, `selectReturnFlight`, `setTripPlanSelectedOption`. Replaced by the v2 selection + fork model.
- **Type renames absorbed:** `Traveller` → `TripPlanTraveller`; `OfferTracker` → `BlueprintMonitor`; `CreateTravellerInput` → unified shape under `TripPlanTraveller` mutations.
- **`PLAN_REQUIRED` and `PLACE_ID_REQUIRED` error codes** dropped before publish — Commander's required-flag validation already covers those cases.

### Fixed

- N/A (v2.0.0 is a clean rebuild rather than a fix release).

### Known Issues

- **`voyagier plan-trip --auto-select navigator` is broken** on the v2 schema. The composite path uses removed `TripPlanItem.selection` (singular). Tracked as [VOY-1189](https://linear.app/voyagier/issue/VOY-1189). Use the manual flow described in [`AGENT.md`](./AGENT.md) until VOY-1189 lands.
- **`voyagier plans create --start/--end/--description` are no-ops on the current schema.** `CreateTripPlanInput` accepts only `{ clientId, title }` on the current dev backend; the extra flags warn on stderr but are not sent. A follow-on `setTripPlan` / itinerary-side mutation will rewire these.
- **`voyagier book --types` and `--only-bookable` are client-side preflight gates only.** They affect what `--validate` reports, but the actual `createTripPlanCheckout` mutation still targets the full cart. Build a clean cart (don't add display-only items) before calling `book` to control what's charged. Server-side filtering is a future enhancement.
- **The `--json` envelope is not yet uniform across commands.** Cart, book, bookable, itinerary, listings, and places emit `{ ok: true, data, planContext? }`. Clients, plans, travellers, search, select, pick, doctor, and whoami emit ad-hoc per-command shapes. Unification tracked as [VOY-1192](https://linear.app/voyagier/issue/VOY-1192). Per-command shapes are documented in `AGENT.md`.
- **Error envelope is `{ error, code, message, details? }`** today (no top-level `ok: false`, no `fix` field). Branch on `code`.
- **`voyagier plans summary` still iterates `plan.items`** rather than `tripPlanEvents`. Tracked as [VOY-1194](https://linear.app/voyagier/issue/VOY-1194). Use `voyagier itinerary <planId>` for the canonical time-sorted view.
- **State files are global, not per-plan.** `~/.voyagier/last-search.json` and `last-options.json` are single global files; cross-plan corruption is prevented by `--plan <id>` mismatch checks on `select` and `pick`, not by file partitioning. There is no `last-clients.json` cache.
- **Hotel checkout path is not fully verified** end-to-end on the new Blueprint Listings model. Default `voyagier book` will skip hotel items when present alongside non-bookable items unless the cart is curated explicitly.
- **The v2 surface assumes the live backend matches the schema introspected on 2026-05-03.** Running `voyagier doctor` after upgrade will surface drift.

### Migration Notes

If you were on `@voyagier/cli@1.8.1`:

1. Run `voyagier doctor --json` to confirm auth and schema reachability.
2. Replace any code that read `bookingData` from CLI JSON output with `optionData`.
3. Replace flat-item iteration (`tripPlan.items[].startTime` / `endTime` / `day` / `date`) with `voyagier itinerary <planId> --json`.
4. Stop relying on `voyagier book` to checkout flights. Use `voyagier book --validate` to see which selections are bookable; build the cart accordingly before calling `book` without `--validate`.
5. Hold any `plan-trip --auto-select` automation pending VOY-1189.
6. The `--client` flag does not yet exist on `plans create` / `plan-trip`. If your scripts assume it (because of pre-release docs that previewed it), the wiring is tracked as VOY-1193.

For the full per-operation breaking-changes table, see `projects/api-strategy/BREAKING-CHANGES.md` in the workspace docs (49 operations classified, 18 broken on v1.x).

### Internal

- **Test suite:** 307 → 559 (+82% growth) across 22 suites.
- **Build:** TypeScript `tsc` clean; no warnings.
- **Reproducible schema audit:** `schema/audit-cli.mjs` runs introspection + `graphql.validate()` against every operation in `src/queries.ts`. Suitable for CI integration.

---

## [1.8.1] — 2026-03-18

> ⚠️ **Deprecated.** This version is broken against the current `dev.voyagier.com` schema. Upgrade to `2.0.0` or higher.

- Last release of the v1.x line.
- Detailed v1 history is preserved in git tags (`v1.0.0` … `v1.8.1`).

---

[2.0.0]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v2.0.0
[1.8.1]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v1.8.1
