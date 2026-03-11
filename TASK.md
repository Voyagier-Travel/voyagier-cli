# CLI v1.0 Rewrite — Phase 1 Task

## Context
This is the Voyagier CLI (`@voyagier/cli`). We're rewriting it from an MCP-based architecture to a pure GraphQL client.
The CLI talks to `nest-api` GraphQL — the same API the web frontend uses. All mutations already exist and accept PAT auth via `Authorization: Bearer voy_pat_xxx`.

## What to Delete
1. `src/mcp.ts` — MCP client, no longer needed
2. `src/commands/tools.ts` — MCP tools command, no longer needed
3. Remove `@modelcontextprotocol/sdk` from package.json dependencies
4. Remove tools registration from `src/index.ts`

## What to Create

### 1. `src/state.ts` — Local search result cache
Read/write `~/.voyagier/last-search.json` for the `select` command.

```typescript
interface SearchState {
  type: "flights" | "hotels";
  tripPlanId: string;
  selectionId: string;
  isRoundTrip?: boolean;
  results: Array<{
    index: number;
    optionId: string;
    flightToken?: string;
    summary: string;
  }>;
  timestamp: string;
}
```

Functions:
- `saveSearchState(state: SearchState): void`
- `loadSearchState(): SearchState | null`
- `clearSearchState(): void`
- `isSearchStateStale(state: SearchState, maxAgeMs?: number): boolean` — default 2 hours

Store in same config dir as credentials (`~/.voyagier/`).

### 2. `src/commands/select.ts` — Select from search results

```
voyagier select <number> [--json]
voyagier select --info <number>
voyagier select --clear
```

Logic:
- Read search state from `last-search.json`
- Map user's number (1-based) to the option's real IDs
- For one-way flights and hotels: call `setTripPlanSelectedOption(selectionId, optionId)`
- For round-trip departure: call `selectDepartureFlight(selectionId, flightToken)` where flightToken comes from the cached result. After selection, the backend refreshes options with return legs. The mutation returns updated options. Save new return options to state, display them numbered, tell user to run `voyagier select <n>` again for return.
- For round-trip return: call `selectReturnFlight(selectionId, flightToken)`
- `--info <n>`: show full details for an option without selecting
- `--clear`: delete the state file
- `--json`: structured output
- Show trip plan URL in success output: `https://voyagier.com/plans/${tripPlanId}`

GraphQL mutations:
```graphql
mutation SetSelectedOption($selectionId: String!, $optionId: String!) {
  setTripPlanSelectedOption(selectionId: $selectionId, optionId: $optionId) {
    id
    selectedOption { id name price }
  }
}

mutation SelectDepartureFlight($selectionId: String!, $flightToken: String!) {
  selectDepartureFlight(selectionId: $selectionId, flightToken: $flightToken) {
    id
    options { id name price time airline duration bookingData }
  }
}

mutation SelectReturnFlight($selectionId: String!, $flightToken: String!) {
  selectReturnFlight(selectionId: $selectionId, flightToken: $flightToken) {
    id
    options { id name price time airline duration bookingData }
  }
}
```

### 3. `src/commands/travellers.ts` — Traveller management

```
voyagier travellers add --plan <id> --first <name> --last <name> [--type ADULT|CHILD|INFANT] [--email <email>] [--dob YYYY-MM-DD] [--gender MALE|FEMALE|UNSPECIFIED] [--json]
voyagier travellers list --plan <id> [--json]
voyagier travellers remove <id> [--json]
```

GraphQL:
```graphql
mutation CreateTraveller($tripPlanId: String!, $input: CreateTravellerInput!) {
  createTripPlanTraveller(tripPlanId: $tripPlanId, input: $input) {
    id firstName lastName email dateOfBirth gender declaredTravellerType
  }
}

query Travellers($tripPlanId: String!) {
  tripPlanTravellers(tripPlanId: $tripPlanId) {
    id firstName lastName email dateOfBirth declaredTravellerType
  }
}

mutation DeleteTraveller($id: String!) {
  deleteTripPlanTraveller(id: $id)
}
```

## What to Modify

### 4. `src/commands/search.ts` — FULL REWRITE

Remove ALL MCP imports. Replace with GraphQL mutations.

```
voyagier search flights --plan <id> --from <IATA> --to <IATA> --date YYYY-MM-DD [--return <date>] [--max-stops <n>] [--json]
voyagier search hotels --plan <id> --location <city> --checkin YYYY-MM-DD --checkout YYYY-MM-DD [--currency USD] [--guests <n>] [--json]
```

`--plan` is required (or auto-resolve from state if active tripPlanId exists).

Before searching, auto-resolve traveller IDs by querying `tripPlanTravellers(tripPlanId)`. If no travellers exist, error with: "No travellers on this plan. Add one first: voyagier travellers add --plan <id> --first <name> --last <name> --type ADULT"

Flight search mutation:
```graphql
mutation CreateFlightSelection($tripPlanId: String!, $input: CreateFlightSelectionInput!) {
  createTripPlanFlightSelection(tripPlanId: $tripPlanId, input: $input) {
    item { id title tripPlanId }
    selection { id }
    options { id name price time airline duration bookingData sortOrder }
  }
}
```

CreateFlightSelectionInput fields: origin, destination, departureDate, returnDate (optional), maxStops (optional), travellerIds, title (optional — auto-generate "Flight: LAX → NRT")

Hotel search mutation:
```graphql
mutation CreateHotelSelection($tripPlanId: String!, $input: CreateHotelSelectionInput!) {
  createTripPlanHotelSelection(tripPlanId: $tripPlanId, input: $input) {
    item { id title tripPlanId }
    selection { id }
    options { id name price time duration bookingData sortOrder }
  }
}
```

CreateHotelSelectionInput fields: location, checkInDate, checkOutDate, currency (default "USD"), travellerIds, title (optional)

After getting results, save to state via `saveSearchState()` and format with numbered indices. For flights, extract flightToken from `bookingData.flights[0].flightToken` per option and store in state for the select command.

Determine `isRoundTrip` from whether `--return` was passed and save to state.

### 5. `src/commands/plans.ts` — Add create, delete

Add:
```
voyagier plans create --title <title> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--description <text>] [--json]
voyagier plans delete <id>
```

GraphQL:
```graphql
mutation CreateTripPlan($input: CreateTripPlanInput!) {
  createTripPlan(input: $input) { id title startDate endDate description }
}
mutation DeleteTripPlan($id: String!) {
  deleteTripPlan(id: $id)
}
```

Add `--json` flag to existing `list` and `get` commands.
Include `url` field in plan output: construct from `getApiUrl()` base + `/plans/${id}`.

### 6. `src/formatters.ts` — Add numbered indices

Change formatters to show `[1]`, `[2]`, `[3]` before each option. The index should be passed in or derived from array position (1-based).

### 7. `src/commands/auth.ts` — Relax prefix check + add whoami

Change `voy_pat_` prefix from hard error to soft warning.
Add user identity to `auth status` — query `{ me { email name } }`:
```
  User:    daniel@voyagier.com (Daniel Gardner)
```

### 8. `src/index.ts` — Register new commands, remove tools

Remove `registerToolsCommands`. Add `registerSelectCommands` and `registerTravellerCommands`.
Read version from package.json dynamically instead of hardcoding "0.2.0".

### 9. `package.json`
- Remove `@modelcontextprotocol/sdk` from dependencies
- `"private": false`
- Add `"files": ["dist", "skills", "README.md"]`
- Version `"1.0.0"`
- Add `"prepublishOnly": "npm run build"` to scripts

## Coding Standards
- Strict TypeScript, zero `as any`, zero `@ts-ignore`
- Errors to stderr, data to stdout
- `--json` flag on every data-producing command
- Exit code 1 on all error paths
- Use existing `graphql()` helper from `src/api.ts`
- Use existing `getApiUrl()` from `src/config.ts`
- Follow patterns in existing commands (chalk, error handling)
- No new npm dependencies

## DO NOT
- Modify `src/api.ts` or `src/config.ts` unless necessary
- Modify `src/commands/chat.ts`
- Create test files or skills/ directory

## After all changes:
1. Run `npm run build` — must compile with zero errors
2. Commit: "feat: v1.0 rewrite — GraphQL backend, select flow, travellers, kill MCP"
