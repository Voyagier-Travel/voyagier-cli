# Changelog

All notable changes to `@voyagier/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed
- **`plan-status` maps room chains to the chosen hotel by supplier `hotelCode` (VOY-1724):** hotel options AND room options both carry the supplier hotel code, so after a hotel pick `plan-status` now marks every room/rate chain under a *different* hotel `branch: "deadBranch"` immediately — even before any room is picked — and keeps only the chosen hotel's chain `active`. The aggregated `PICK_PENDING` collapses to that one chain ("room pick pending in your chosen hotel — N candidate selection(s)") instead of "11 candidates across 6 branches", and a 1-candidate collapse routes straight to the real `select` command. The VOY-1718 completion-evidence rule stays as fallback when a code is missing on either side; a `REQUIREMENT_UNMET` pointing at a code-mismatched chain downgrades to `unverified`.
- **Hotel search prices are shown as STAY TOTALS, not per-night (VOY-1724):** the supplier's `minRate` is a whole-stay "from" price, but summaries rendered it as `$X/night` — wildly wrong on multi-night stays. `search hotels` (human / `--agent` / `--json` summaries) now renders `from $X total · N nights (~$Y/nt)` using the option's check-in/out dates.
- **Flight fares no longer imply a per-person price (VOY-1724):** the `--agent` flight list dropped the misleading `/pp` suffix, and the docs' "flight prices are per-person — multiply by traveller count" quirk was removed — it was wrong: the shown price is what checkout charges for the party as searched. The docs now advise sanity-checking multi-traveller math against `book --dry-run` / `quote`.

### Added
- **`plan-status --verify` (VOY-1724):** runs the same `book --dry-run` checkout truth (shared helper — no logic duplication) and appends `verify: { bookable, blockers, chargeableSubtotal }` to the JSON payload plus a human/agent section. On dry-run error it degrades to `verify: { error: <code> }` and never fails the command.
- **`plan-status` additive `summary.bookableNow` (VOY-1724):** `true` when the cart holds ≥1 bookable item AND every remaining blocker is `unverified`. When readiness is `BLOCKED` but `bookableNow`, the headline says all remaining blockers are unverified and names the bookable count — trust `book --dry-run`. The readiness enum is unchanged.
- **Room nights × rate breakdown (VOY-1724):** `selection-options` on a room/rate selection now derives `N nights · $total (~$/nt incl. tax)` from the option's nightly rate breakdown (human line + additive `stay` object in `--json`), via a targeted secondary read that never dumps raw `optionData`.

## [2.6.2] — 2026-07-21

### Fixed
- **Round-trip and hotel date ranges no longer land one day early (VOY-1723):** the Date selection's `duration` input is an INCLUSIVE day count on the server (endDate = startDate + duration − 1), but the CLI sent the exclusive difference between the two dates — so a `--return 2026-09-15` search produced return flights on 09-14 and a `--checkout` hotel stay lost its last night. The CLI now sends `daysBetween + 1`.
- **Post-hotel-pick guidance names the room chain (VOY-1724):** after a hotel pick, `select` resolves the chosen hotel's actual room chain by `hotelCode` and points next-steps at its real selection id (additive `roomSelectionId` in `--json`), falling back to the generic text when unresolvable.
- **`quote` header shows the full date range (VOY-1724):** departure AND return/end date (inclusive of the end since VOY-1723). `search hotels --json` gains additive per-result `stayTotal` / `nights` / `perNight` / `checkIn` / `checkOut` fields.

## [2.6.1] — 2026-07-21
### Fixed
- **`plan-status` suppresses alternate-branch picks (VOY-1718):** the goal graph pre-creates a decision chain for every candidate parent option, so after a hotel/flight pick the sibling chains (rooms/rates under hotels you didn't choose, extra mirrors of the one you did) were each emitting a phantom `PICK_PENDING`. `plan-status` now groups Single-mode selections by type within a goal; once one is complete (or a bookable cart item joins to it), the incomplete siblings are classified `branch: "alternate" | "deadBranch"` and their picks are suppressed. A group with no settled member and ≥2 pending siblings collapses into ONE aggregated `PICK_PENDING` carrying `candidateSelectionIds[]` (pick the parent first). A `REQUIREMENT_UNMET` pointing at a suppressed branch is kept but downgraded to `unverified`. On a real fully-composed plan this cut blockers from 17 to a handful of genuine ones.

### Added
- **`plan-status` additive contract fields (VOY-1718):** selection rows gain `branch` (`"active" | "alternate" | "deadBranch"`); each goal and `summary` gain `alternateBranchCount`; aggregated `PICK_PENDING` blockers gain `candidateSelectionIds[]`. `GET_PLAN_STATUS` now selects `mirrorListSelectionId` per selection (used to tell a same-list alternate from a dead branch).

### Changed
- **Decision-chain docs (VOY-1718):** AGENT.md adds a "Decision chains" section (decision → list → decision → bookable leaf; alternates are suppressed; baselines auto-fill; pick the parent first) and documents the new plan-status fields; README's "What's Bookable" table now shows hotels as bookable via the auto-carted room-rate. Both note that live-rate cart items may report `source: "OTHER"` (normal, not an error).
- **Post-pick chain guidance (VOY-1718):** `select`'s flight/hotel hints and `--agent`/`--json` output now point at the next link in the chain — after a hotel pick the room decision (baseline rate auto-carts); after the flight leg(s) the Fare & Cabin (FlightClass) pick, chosen in the CLI (defaults to Economy) — seat selection and cabin upgrades remain with the airline after booking. `--json` gains an additive `chainNote`.

## [2.6.0] — 2026-07-21

### Changed
- **Cart-item `source` values are now supplier-agnostic (breaking):** `cart` / `book` / `plans bookable` JSON emit `AIR_SUPPLIER` / `ACCOMMODATION_SUPPLIER` / `ACTIVITY_SUPPLIER` (previously vendor-branded values). `OTHER` / `UNKNOWN` unchanged. Update any switches on `source`.
- **Stale flight guidance purged from runtime output:** the air-supplier bookability reason and blocker fix string claimed flights were "itinerary display only; book directly with the airline" — wrong since flights became bookable via the fare-level (Fare & Cabin) item. Both now explain the fare-level pick, and the reason is emitted only when the line is actually not bookable.
- **"Travel fee" → "Processing fee"** across cart/book output and hints, matching the docs — it covers processing costs (credit card, booking, servicing).
- **Published docs no longer name internal suppliers or processes:** AGENT.md / README / skill docs refer to air, accommodation, and activity suppliers generically; compiled `dist/` output no longer ships source comments (`removeComments`), and `.d.ts` emission is off (the package is a CLI binary, not a library). The checkout fee line now explains what the ~6% processing fee covers (credit card, booking, servicing).
- **`skills/SKILL.md` rewritten for the v2.5 surface (was v1-era):** price-gated `book` flow, compact search envelope, `plan-status` / `quote` / `send`, uniform error envelope, and a pointer to `voyagier agent-docs` as the canonical reference. The old copy taught a gate-less `book` that now fails by design.

## [2.5.0] — 2026-07-21

### Added
- **`voyagier quote <planId>` (VOY-1212):** read-only offer snapshot — itemized cart with per-item bookability, client + trip dates, and a `chargeableTotal` computed through the same cents-rounding the `book` gate compares (quoted ≡ gated by construction). `--json` includes a machine-readable `acceptance` block (`{ command, itemIds, expectedTotal }`) — the exact gated booking that accepts the offer — or `acceptance: null` with a reason when nothing is bookable. Deliberately does NOT render client-facing documents (the webapp is the offer surface) or embed payment links (sessions expire; links are minted fresh at acceptance by `book`).
- **`voyagier send <planId> [--note <text>]` (VOY-1212):** email the client their invite link to the live trip plan in the webapp (exposes `sendTripPlanToClient`), where they can view and pay self-serve. Emails a real client and is not idempotent, so it confirms interactively and hard-requires `--yes` in non-interactive runs (`CONFIRMATION_REQUIRED`); the recipient is pre-checked before the mutation so a plan without a client email fails fast with a fix hint.
- New error code `CONFIRMATION_REQUIRED` for externally-visible actions run non-interactively without `--yes`.
- **`search --full` flag (VOY-1714):** restores the complete option dump (raw provider `bookingData` included) now that the default `--json` output is a compact envelope.
- **`plan-status` blockers gain `unverified: true` (VOY-1714/VOY-1715):** set on `REQUIREMENT_UNMET` blockers whose server requirement references no selection — these may be stale phantoms (e.g. "Cabin class" never flips fulfilled even after the fare is picked). Their `nextSteps` route to `book --dry-run` (the checkout truth) instead of a `plans goal` dead-loop, and AGENT.md documents the tie-breaker rule.

### Changed
- **`book --status --json` and `bookings list/get --json` rename `amount` → `amountCents` (VOY-1713, breaking):** the API stores integer cents but exposes them as an undocumented `Float` named `amount` — the dollar-looking name caused the v2.3.0 100× display bug and `ALREADY_BOOKED.details` already says `amountCents`. One name per unit across every CLI machine surface.
- **`book --dry-run` reports a gate verdict (VOY-1713):** when `--expect-total`/`--max-total` accompany `--dry-run`, output includes `data.gate.{wouldPass,failReason}` (and a ✓/✗ line in human/agent modes) so agents can pre-verify a gate without risking `PRICE_CHANGED`. Dry-run still requires no gate.
- **`book --dry-run` distinguishes "no paid checkouts" from "could not verify" (VOY-1713):** human/agent output now warns when the existing-checkout query fails instead of silently looking like zero.
- **`search --json` emits a compact envelope (VOY-1714, breaking):** `{selectionId, optionCount, topOptions[≤10]}` (+ `returnSelectionId`/`isRoundTrip` for round-trip flights) instead of the full option dump — a single real flight search measured 2.7 MB of raw provider JSON, scrolling the selection ids out of terminal/agent buffers. Summaries carry `{index, optionId, summary}` (+ `flightToken` for flights); pass `--full` for the old shape. Agent-mode listings cap at 10 with an "…and N more" tail. First finding of the cold-agent UX test.
- **`select --json` payloads now carry `ok: true` (VOY-1714):** success is checkable on the same key as every enveloped command instead of being inferred from the absence of an error envelope. Additive — existing keys unchanged.
- **`doctor` classifies schema drift core vs peripheral (VOY-1714):** drift confined to places/comments/booking-record reads (the known VOY-1417/1418/1419 cluster) now reports `WARN` with an explicit "core compose/close loop is unaffected; safe to proceed" instead of a blanket `FAIL` that strands a cold agent; core-surface drift still fails and names the ops in `details.coreDrifted`.

### Docs
- **AGENT.md corrections from the cold-agent UX test (VOY-1714):** search section rewritten for the compact envelope + inline-options reality (the stale "often no options yet" narrative predated VOY-1692's selection reuse); fare/cabin third pick added to Quick Start as step 4b (defaults to Economy); leg-mirrored option ids documented as intended; `plans goals`/`plans goal` corrected to Style A with a payload map for where selection ids live; `plan-trip` scaffold shortcuts (`--from/--to/--depart/--return/--hotel/…`) shown; unverified-blocker semantics + the `plan-status` vs `book --dry-run` tie-breaker rule; doctor drift-class guidance; "settled ≠ requirement flags caught up" note on `select --wait`.

### Fixed
- **`nextStep` recipe is now self-consistent (VOY-1713):** the amount is derived from the same rounded-cents value the gate compares, so the emitted command can never fail its own gate on a half-cent subtotal.

## [2.4.0] — 2026-07-20

### Added
- **`book` price hard-gate (VOY-1706):** a real checkout now REQUIRES `--expect-total <amt>` (exact, cents-compared) or `--max-total <amt>` (cap; both flags → both enforced), checked against the **chargeable subtotal** (bookable items only) at cart-read time. Mismatch aborts with `PRICE_CHANGED` (+ `details.{expectedTotal,maxTotal,actualTotal,items}`) before any mutation. `book --dry-run` now reports `chargeableSubtotal`, existing paid checkouts, and a ready-to-run `nextStep` (carrying any active filters).
- **`book` paid-checkout pre-flight (VOY-1706):** before minting a Stripe session, `book` checks existing checkouts — `Paid` → `ALREADY_BOOKED` with booking-record summary (`amountCents`); override `--rebook`. Fails closed (preserving the underlying error code) if the check itself errors. Note: unpaid `Pending` sessions are excluded by the server on this query and are therefore invisible to the CLI — pending-session idempotency needs a backend change (tracked separately).
- **`book` checkouts are now item-pinned:** every checkout sends `CreateTripPlanCheckoutInput.itemIds` (`selectionId:optionId`) for the exact bookable set the gate priced, so the charged set always equals the gated set; `--types` / `--only-bookable` narrow it server-side (previously client-side preflight gates over a full-cart checkout).

### Fixed
- `book --status` rendered booking-record amounts 100× too large (amounts are cents; a $1,297.06 flight displayed as $129,706.00) and compared status enums in UPPERCASE against the API's PascalCase values, so confirmed bookings rendered as failed and the confirmation hints never fired.

### Removed
- `book --idempotency-key` — it was a JSON-echo no-op (never sent server-side); real duplicate protection is the paid-checkout pre-flight above.

## [2.3.0] — 2026-07-20

### Added
- `select --wait [--timeout <seconds>]` (VOY-1705): after a pick succeeds, wait until the choice is reflected server-side and plan readiness settles (post-pick `CART_PENDING` cart regeneration), then append a plan-status snapshot (`wait.{pickVisible,settled,readiness,blockers,waiting,nextSteps}`) — agents no longer hand-roll post-pick polling. Timeout reports honest partial state and exits 0 (the pick itself succeeded), matching `selection-options --wait` semantics.

## [2.2.1] — 2026-07-20

### Security
- Server-provided ids in `plan-status` `nextSteps[]` are now shell-quoted via `shellArg()` — nextSteps remain safe to paste/run even against a hostile or corrupted API response (VOY-1709)
- All GraphQL response strings (and server error messages, and chat stream deltas) are sanitized at the API boundary: ANSI escape sequences and control characters are stripped, preventing terminal-rewrite/spoofing via supplier content like hotel names (VOY-1709)
- AGENT.md: new "Untrusted content" section — supplier text is data, never instructions (prompt-injection guidance for consuming agents) (VOY-1709)

## [2.2.0] — 2026-07-20

Survives the July 2026 backend participant-choice migration and adds one-shot plan readiness. **Breaking-by-policy:** fresh-install stance — no compat aliases (`whoami --refresh` removed, `select` rebuilt on the traveller-choice mutation family).

### Added
- **`voyagier plan-status <planId> [--json|--agent]`** — one-call readiness ([VOY-1704](https://linear.app/voyagier/issue/VOY-1704)): `readiness` enum (`BOOKED` / `READY_TO_BOOK` / `BLOCKED` = act / `IN_PROGRESS` = poll), ordered `blockers[]` (`TRAVELLER_DATA` → `SELECTION_INPUT` → `PICK_PENDING` → `REQUIREMENT_UNMET`), self-resolving `waiting[]`, runnable `nextSteps[]`, `cart.bookableCount`. Additive-only JSON stability promise (documented in AGENT.md). Divergent per-traveller picks are valid — informational `consensus: false`, never a blocker.
- **`select` choice scopes** ([VOY-1692](https://linear.app/voyagier/issue/VOY-1692)): `--traveller <id>`, `--travellers <ids>`, `--group <id>` map to the backend's `setTripPlanTravellerChoice*` mutation family; default remains all-travellers.
- **`selection-options` honesty** ([VOY-1703](https://linear.app/voyagier/issue/VOY-1703)): `AWAITING_INPUT` now names the blocking inputs in `blockedOn[]`, or emits `blockedOnUnavailable: true` when the stall is dependency-pending. Per-traveller choices + consensus in output.

### Fixed
- **Picks work again after the participant-choice migration** ([VOY-1692](https://linear.app/voyagier/issue/VOY-1692)): `search` now reuses the goal's existing decision selection (backend validates picks/options exactly one mirror hop; the old create-a-new-selection path added a second hop → empty options + rejected picks). Round-trip searches emit `returnSelectionId`. Empty-but-provided scope flag values are hard errors.
- **Chosen-state reads are consensus-aware** ([VOY-1701](https://linear.app/voyagier/issue/VOY-1701)): `plans get/summary/items` derive chosen options from `travellerOptionChoices` (shared `deriveChosen`), with `parentOptionId` legacy fallback — picks made under the new model no longer render as ⏳ pending.
- **`whoami` live-verifies the token by default** ([VOY-1703](https://linear.app/voyagier/issue/VOY-1703)): a dead PAT fails loudly with `AUTH_FAILED` + the fix command instead of serving cached identity. `--cached` is the explicit offline escape hatch; `--refresh` removed.
- `travellers update` works again (`UpdateTravellerInput` → `UpdateTripPlanTravellerInput` backend rename).

### Removed
- Dead pre-#386 sub-selection code paths (`findPendingSubSelections`); stale repo-root audit artifacts (`CLI-AUDIT-2026-03-16.md`, `SECTION6-DISCOVERIES.md` — both described the pre-participant-choice model).

---

## [2.1.2] — 2026-06-03

Composable goal-graph write path. A trip plan is a goal graph; you compose a trip by searching against the plan's goals and selecting options on the resulting selections.

### Fixed
- **`search` now fully resolves query inputs so the backend monitor can fetch inventory** ([VOY-1421](https://linear.app/voyagier/issue/VOY-1421)). Previously a CLI-built search added a start-date *option* but never populated the Date selection's `endDate` output, and never set the **return leg's** airports — so the monitor query stayed "insufficient" and sat in `AWAITING_INPUT` forever.
  - `search flights | hotels` now resolve a full date *range* (start + end via the Date selection's `duration` input), and `search flights` now wires the **return-leg airports** (reversed) for round-trips.
  - Empty-immediately-after-search now points at `voyagier selection-options <id> --wait` (“still fetching”) instead of a misleading “no results.”
  - **Known limitation:** round-trip flight searches may still stay empty pending a backend fix ([VOY-1422](https://linear.app/voyagier/issue/VOY-1422)) — the return leg does not yet trigger the combined `FlightJourney` search on the first save. The CLI sets all inputs correctly; the CLI surfaces this note when a round-trip search returns no options.
  - Hardening: reject impossible calendar dates (e.g. `2026-02-30`) in date-range parsing, and validate the full range before any backend mutation so an invalid range leaves no partial state.

- **`search` is asynchronous and goal-based.** `search flights | hotels | activities` resolves the target goal (`--goal <id>`, or the first matching goal) and its mirror list, sets the provided inputs, and creates a mirroring selection. The response returns a `selectionId`; options are fetched in the background. Flags: `--goal` (all), `--max-stops` (flights), `--replace` (hotels, activities).
- **`voyagier selection-options <selectionId>`** reads or polls a selection's options. `--wait` polls with backoff until options are ready or a terminal status (`READY` / `NO_RESULTS` / `AWAITING_INPUT` / `FETCH_ERROR`) is reached; `--timeout <seconds>` bounds the wait; `--human` forces readable output.
- **`select` chooses by IDs.** `voyagier select --selection-id <id> --option-id <id>` is the primary path. Index-based `select <n>` works against the last cached search; `--plan <id>` asserts plan ownership of the cache.
- **`plan-trip` is a scaffold.** It creates the plan + default goal graph (and adds travellers when `--travellers` is provided), then prints the exact compose next-steps for that plan.
- **`options` and `pick` are removed.** The sub-selection model they were built on no longer exists. Read options with `voyagier selection-options <selectionId>` and choose with `voyagier select --selection-id <id> --option-id <id>`.

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

[2.1.2]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v2.1.2
[2.0.0]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v2.0.0
[1.8.1]: https://github.com/Voyagier-Travel/voyagier-cli/releases/tag/v1.8.1
