# Build Spec: CLI Agent Features (VOY-795, VOY-796, VOY-797, VOY-798)

Build these in order. Each gets its own branch off main, its own commit. Run `npm run build && npm test` after each feature to verify. When ALL 4 are done, run: `openclaw system event --text "Done: VOY-795 through VOY-798 — all 4 CLI agent features built" --mode now`

## Phase 1A: VOY-795 — Clean --json Contract

**Branch:** `feat/VOY-795-json-contract`

### Create `src/output.ts`
```typescript
import chalk from "chalk";

/** Write JSON to stdout. Only call this when --json is active. */
export function jsonOutput(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Write structured error JSON to stdout (for --json mode failures). */
export function jsonError(message: string, code?: string): never {
  process.stdout.write(JSON.stringify({ error: true, message, code: code ?? "ERROR" }, null, 2) + "\n");
  process.exit(1);
}

/** Progress message to stderr (dimmed). */
export function progress(msg: string): void {
  process.stderr.write(chalk.dim(msg + "\n"));
}

/** Warning to stderr (yellow). */
export function warn(msg: string): void {
  process.stderr.write(chalk.yellow(`⚠ ${msg}\n`));
}

/** Fatal error to stderr + exit. */
export function fatal(msg: string): never {
  process.stderr.write(chalk.red(msg + "\n"));
  process.exit(1);
}
```

### Audit all command files
Go through every file in src/commands/ and:
1. Import from `../output.js` where helpful
2. In `--json` error paths: use `jsonError()` instead of `process.stderr.write + process.exit`
3. In progress messages: use `progress()` instead of `process.stderr.write(chalk.dim(...))`
4. In warnings: use `warn()` instead of raw stderr writes
5. In fatal errors (non-json): use `fatal()` instead of `process.stderr.write(chalk.red(...)) + process.exit(1)`

Don't refactor everything — just the most common patterns. Keep changes minimal and surgical.

### Add tests for output.ts
Create `src/output.spec.ts` testing:
- `jsonOutput` writes valid JSON to stdout
- `jsonError` writes error JSON and exits
- `progress` writes to stderr
- `warn` writes to stderr
- `fatal` writes to stderr and exits

### Commit message:
```
feat(VOY-795): clean --json contract with output helpers

- New src/output.ts: jsonOutput, jsonError, progress, warn, fatal
- Audit all command files to use helpers for consistent output
- --json errors now return structured JSON: {error, message, code}
- stdout is clean JSON when --json passed, everything else to stderr

Closes VOY-795
```

---

## Phase 1B: VOY-796 — Explicit ID-based Select/Pick

**Branch:** `feat/VOY-796-explicit-ids` (branch off main AFTER merging VOY-795)

### Update `src/commands/select.ts`
Add options to the select command:
- `--selection-id <id>` — explicit selection ID
- `--option-id <id>` — explicit option ID (for hotels and one-way flights)  
- `--flight-token <token>` — explicit flight token (for round-trip flights)
- `--phase <phase>` — `departure` or `return` (required with --flight-token)

Logic:
```
if (opts.selectionId && (opts.optionId || opts.flightToken)):
  // Direct mode — skip state file entirely
  if (opts.flightToken):
    if (opts.phase === "departure"):
      call selectDepartureFlight mutation
    else if (opts.phase === "return"):
      call selectReturnFlight mutation  
    else:
      error("--phase departure|return required with --flight-token")
  else:
    call setTripPlanSelectedOption mutation
else:
  // Existing numbered index flow (unchanged)
```

### Update `src/commands/options.ts` (pick command)
Add options:
- `--sub-selection-id <id>` — explicit sub-selection ID
- `--option-id <id>` — explicit option ID

Logic:
```
if (opts.subSelectionId && opts.optionId):
  // Direct mode — call setTripPlanSubSelectionOption directly
  // Skip state file
else:
  // Existing numbered flow (unchanged)
```

### Important: keep --json output consistent
Both direct and indexed modes should produce identical JSON output structure.

### Commit message:
```
feat(VOY-796): explicit ID-based select/pick for agent workflows

- select: --selection-id, --option-id, --flight-token, --phase flags
- pick: --sub-selection-id, --option-id flags
- Direct ID mode bypasses state file for parallel agent operations
- Numbered index flow completely unchanged
- Enables agents to search and select without sequential state dependency

Closes VOY-796
```

---

## Phase 2: VOY-797 — CRUD Completeness

**Branch:** `feat/VOY-797-crud` (branch off main AFTER merging VOY-796)

### Add `plans items <planId>` subcommand in plans.ts
Query: reuse GET_PLAN_DEEP from queries.ts (it has items with selections and sub-selections)

Output --json:
```json
{
  "planId": "...",
  "items": [{
    "id": "item-uuid",
    "type": "Selection",
    "title": "Flight: BWI → SJU",
    "inferredType": "flight",
    "selectionId": "sel-uuid",
    "selectedOption": { "id": "opt-uuid", "name": "...", "price": 1926 },
    "status": "selected|pending|needs_sub_selection",
    "subSelections": [{ "id": "sub-uuid", "type": "HOTEL_ROOM", "selectedOptionId": "...", "optionCount": 4 }]
  }]
}
```

Use title-based type inference: title.toLowerCase().includes("hotel") → "hotel", includes("flight") → "flight", else "other"

Human output: table-like list with emoji, title, status, price.

### Add `plans remove-item` subcommand in plans.ts
```
plans remove-item <itemId>                          # remove one
plans remove-item --plan <planId> --type flight      # remove by type
plans remove-item --plan <planId> --type hotel       # remove by type  
plans remove-item --plan <planId> --all              # remove all
```

For --type and --all: fetch items first, filter, then delete each.
Mutation: `deleteTripPlanItem(id: String!)` — check the exact signature by introspecting:
```graphql
mutation DeleteTripPlanItem($id: String!) { deleteTripPlanItem(id: $id) }
```

### Add `plans update <planId>` subcommand in plans.ts
```
plans update <planId> --title "New" --start 2026-06-01 --end 2026-06-05 --description "text"
```
All flags optional. Only send provided fields.
Mutation: `updateTripPlan(id: String!, input: UpdateTripPlanInput!)`
Input fields: title, startDate, endDate, description
Apply existing date validation (validateDate, validateDateRange, warnPastDate).

### Add `travellers update <id>` subcommand in travellers.ts
```
travellers update <id> --first "Name" --last "Name" --dob 1990-01-01 --gender male --email x@x.com --type adult
```
All flags optional. Only send provided fields.
Mutation: `updateTripPlanTraveller(id: String!, input: UpdateTravellerInput!)`
Use toPascalCase for gender and declaredTravellerType.

### Commit message:
```
feat(VOY-797): plans items, remove-item, update + travellers update

- plans items: structured item list with IDs, types, status
- plans remove-item: single, by type, or all
- plans update: title, dates, description
- travellers update: name, DOB, gender, email, type
- All mutations verified against API schema

Closes VOY-797
```

---

## Phase 3: VOY-798 — plan-trip Composite Command

**Branch:** `feat/VOY-798-plan-trip` (branch off main AFTER merging VOY-797)

### Create `src/commands/plan-trip.ts`

New top-level command: `voyagier plan-trip`

Options:
- `--title <title>` (required)
- `--from <code>` (optional, defaults to home airport)
- `--to <code>` (required if doing flights)
- `--depart <date>` (required if doing flights)
- `--return <date>` (optional, makes it round-trip)
- `--hotel <location>` (optional, triggers hotel search)
- `--checkin <date>` (defaults to --depart)
- `--checkout <date>` (defaults to --return or --depart + 1 day)
- `--guests <n>` (defaults to traveller count)
- `--travellers <names>` (comma-separated, e.g. "John Doe, Jane Doe")
- `--sort <field>` (price|duration|stops, default price)
- `--max-results <n>` (default 10, limits options returned)
- `--json`

Pipeline:
1. Create plan (title, depart as startDate, return/checkout as endDate)
2. Parse and add travellers (split by comma, first/last by space, all Adult)
3. If --to and --depart: search flights (resolve --from from home airports if not given)
4. If --hotel: search hotels (use --checkin/--checkout or --depart/--return)
5. Collect all results

JSON output:
```json
{
  "plan": { "id": "...", "title": "...", "url": "..." },
  "travellers": [{ "id": "...", "firstName": "...", "lastName": "..." }],
  "flights": {
    "selectionId": "...",
    "isRoundTrip": true,
    "optionCount": 40,
    "options": [/* top N by sort, each with id, flightToken, summary, price, duration, airline */]
  },
  "hotels": {
    "selectionId": "...",
    "optionCount": 10,
    "options": [/* top N, each with id, name, price, summary */]
  },
  "nextSteps": {
    "selectFlight": "voyagier select --selection-id <id> --flight-token <token> --phase departure",
    "selectHotel": "voyagier select --selection-id <id> --option-id <optionId>",
    "viewPlan": "voyagier plans get <planId>"
  }
}
```

Human output:
```
✓ Created: Dorado Beach Golf Trip (May 14-18, 2026)
  4 travellers added

✈️  Top 5 flights (BWI → SJU, sorted by price):
  [1] NK $717  BWI→SJU  3h43m nonstop
  [2] NK $809  BWI→SJU  3h43m nonstop
  ...
  
🏨  Top 5 hotels (Dorado Beach, Puerto Rico):
  [1] Embassy Suites Dorado Del Mar  $476/night
  ...

Next:
  voyagier select --selection-id abc --flight-token xyz --phase departure
  voyagier select --selection-id def --option-id ghi
  Full plan: https://dev.voyagier.com/plans/...
```

### Register in index.ts
Import and register `registerPlanTripCommand`.

### Commit message:
```
feat(VOY-798): plan-trip composite command for agents

One command to create a full trip plan:
  voyagier plan-trip --title "..." --to SJU --depart 2026-05-14 \
    --return 2026-05-18 --hotel "Dorado Beach" --travellers "A, B, C"

Pipeline: create plan → add travellers → search flights → search hotels
Returns all options for agent/human selection (does not auto-select).
Includes explicit ID-based next-step commands in output.

Closes VOY-798
```

---

## General Rules
- Run `npm run build && npm test` after EACH feature
- Do NOT change package.json dependencies
- Use existing code patterns (chalk, graphql helper, etc.)
- Keep existing tests passing
- Add tests for new code where practical
- Use the output.ts helpers from VOY-795 in all subsequent features
- Import getHomeAirports from config.ts where needed
- Use toPascalCase pattern for enum values
- For each feature: git checkout main, git pull, create branch, build, commit, push
