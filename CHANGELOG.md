# Changelog

All notable changes to `@voyagier/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0-alpha.0] — 2026-05-03 (unreleased)

> ⚠️ **Breaking release.** v1.x is broken against the current Voyagier backend schema (37% of GraphQL operations fail on `dev.voyagier.com`). v2.0.0 is a clean rebuild against the new advisor-first / Blueprint trip-plan model.
>
> Migration is one-way: there is no compat shim. v1.x is deprecated.

### Highlights

- **Advisor CRM** is now the foundation. Every trip plan must be associated with a `TripPlanClient`. New `voyagier clients` command group manages the CRM layer.
- **Computed itinerary** replaces hand-crafted item metadata. New `voyagier itinerary <planId>` reads the platform's `tripPlanEvents` resolver.
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

#### New flags
- `voyagier book` gained `--validate`, `--only-bookable`, `--types`, `--idempotency-key` ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)).
- `voyagier plans create` and `voyagier plan-trip` require `--client <id>`. Use `voyagier clients upsert --email <e> --name <n>` for idempotent client resolution.

#### New error codes
- `LISTING_NOT_FOUND`, `PLACE_NOT_FOUND`, `NO_MONITOR` — listings + places surfaces.
- `NOT_BOOKABLE`, `BOOKING_BLOCKED`, `EXPIRED_OFFER`, `STALE_PLAN_STATE` — booking pre-flight ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)).
- `SCHEMA_DRIFT` — emitted when CLI is built against an older schema than the backend.
- `PERMISSION_DENIED` — RBAC failures (e.g., non-advisors attempting plan creation).
- `CLIENT_REQUIRED` — `plans create` / `plan-trip` invoked without `--client`.

#### Helpers (exported for downstream tooling)
- Numeric validators with strict rejection of non-numeric / out-of-range inputs: `parsePositiveInt`, `parseNonNegativeInt`, `parseFloatStrict({min, max, nonNegative})`.
- Output safety: `formatNullableBool` (tri-state Yes / No / Unknown), `escapeMdTableCell` (markdown table cell escaping for `--agent` output).
- Place / client / monitor enum normalizers: `normalizeListingChangeType`, `normalizeHighlightCategory`, `normalizePlaceType`, `parseSearchLocation`.

### Changed

- **`voyagier cart`** rewritten against the v2 schema. No more `subSelectionOptionId`. `CartItemType` is PascalCase. Cart items are grouped by goal in `--json` output. Single round-trip bookability fetch (`tripPlanCartWithBookability`-equivalent client-side enrichment) ([VOY-1188](https://linear.app/voyagier/issue/VOY-1188)).
- **`voyagier book`** routes flight items to display-only and only checks out actually-bookable items by default. Use `--types` to scope further. PNR reservation happens at checkout time; `--dry-run` previews without reserving.
- **`voyagier plans create`** input shape changed: takes `clientId` + `title` only. `startDate` / `endDate` / `description` are no longer accepted at creation time.
- **`voyagier plans get`** / **`plans summary`** rewritten to read from goals + `tripPlanEvents` rather than the deleted item temporal columns.
- **`--idempotency-key`** on mutating commands is echoed in `--json` output today; server-side de-duplication is forward-compatible (pending backend support).
- **`--agent` help text** standardized to `"Output plain markdown for AI agents"` across every command for `--help` consistency.
- **`--type` casing** in `places search` and `places attach` normalized through `normalizePlaceType` so `--type hotel` and `--type Hotel` behave identically.
- **IATA validation** on `places attach --iata-code` now boundary-validates through the existing `validateIata` helper and uppercases lowercase input.

### Deprecated

- **`@voyagier/cli@1.x`** is deprecated. v1.x cannot drive workflows against the current backend schema.

### Removed

- **GraphQL fields no longer requested** by the CLI:
  - `bookingData` on `TripPlanSelectOption` → renamed to `optionData` upstream.
  - `selection` (singular) on `TripPlanItem` → use `selections` (plural).
  - `selectedOption` on `TripPlanSelection` → use `parentOption`.
  - `subtitle`, `start_time`, `end_time`, `details`, `day`, `date` on `TripPlanItem` → all deleted; itinerary is now computed.
  - `subSelectionOptionId` on cart items → no longer exists; reference `selectionId + optionId`.
  - `createdAt` on `TripPlanPaymentCheckout` → no longer exists.
- **Subselection mutations no longer called:** `setTripPlanSubSelectionOption`, `selectDepartureFlight`, `selectReturnFlight`, `setTripPlanSelectedOption`. Use the v2 selection + fork model instead.
- **Type renames absorbed:** `Traveller` → `TripPlanTraveller`; `OfferTracker` → `BlueprintMonitor`; `CreateTravellerInput` → unified shape under `TripPlanTraveller` mutations.
- **`PLAN_REQUIRED` and `PLACE_ID_REQUIRED` error codes** removed before publish — Commander's required-flag validation already covers those cases.

### Fixed

- N/A (v2.0.0 is a clean rebuild rather than a fix release).

### Known Issues

- **`voyagier plan-trip --auto-select navigator` is broken** on the v2 schema. The composite path uses removed `TripPlanItem.selection` (singular). Tracked as [VOY-1189](https://linear.app/voyagier/issue/VOY-1189). Use the manual flow (`plans create` → `search` → `select` → `pick` → `cart` → `book`) until VOY-1189 lands. The fix depends on the Section 5 (Selections / Forks) build, which is gated on the platform schema freeze.
- **Hotel checkout path is not fully verified** end-to-end on the new Blueprint Listings model. `voyagier book` will skip hotel items unless `--types HOTEL` is explicitly passed.
- **The v2 surface assumes the live backend matches the schema introspected on 2026-05-03.** Running `voyagier doctor` after upgrade will surface drift.

### Migration Notes

If you were on `@voyagier/cli@1.8.1`:

1. Run `voyagier doctor` to confirm auth and schema reachability.
2. If you scripted `plans create`, add `--client <id>`. To resolve a client by email idempotently: `voyagier clients upsert --email <e> --name <n> --type Individual --json`.
3. Replace any code that read `bookingData` from CLI JSON output with `optionData`.
4. Replace flat-item iteration (`tripPlan.items[].startTime` / `endTime` / `day` / `date`) with `voyagier itinerary <planId> --json`.
5. Stop relying on `voyagier book` booking flights. Use `voyagier book --validate` to see exactly what's bookable before checkout.
6. Hold any `plan-trip --auto-select` automation pending VOY-1189.

For the full per-operation breaking-changes table, see [`projects/api-strategy/BREAKING-CHANGES.md`](https://github.com/Voyagier-Travel/voyagier-cli) in the workspace docs (49 operations classified, 18 broken on v1.x).

### Internal

- **Test suite:** 307 → 556 (+81% growth) across 22 suites.
- **Build:** TypeScript `tsc` clean; no warnings.
- **Reproducible schema audit:** `schema/audit-cli.mjs` runs introspection + `graphql.validate()` against every operation in `src/queries.ts`. Suitable for CI integration.

---

## [1.8.1] — 2026-03-18

> ⚠️ **Deprecated.** This version is broken against the current `dev.voyagier.com` schema. Upgrade to `2.0.0-alpha` or higher.

- Last release of the v1.x line.
- Detailed v1 history is preserved in git tags (`v1.0.0` … `v1.8.1`).

---

[2.0.0-alpha.0]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v2.0.0-alpha.0
[1.8.1]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v1.8.1
