# Section 6 Build — Schema Discoveries

Discovered during implementation on 2026-05-04. Per the hard-rule in `SECTION6-PROMPT.md`:
> If you discover the plan is wrong about a schema shape, document it in a `SECTION6-DISCOVERIES.md` file at repo root and follow the plan's intent.

---

## Discovery 1: `TripPlanSelectOption` uses `name` not `label`

**Plan doc JSON contract shows:**
```json
"options": [{ "id": "tpopt_...", "label": "Economy", "isBookable": true }]
```

**Actual schema (`TripPlanSelectOption` fields):**
- `name: String!` — the option display name (NOT `label`)
- `isBookable: Boolean!`
- `id: String!`
- Plus many other fields (price, status, optionType, etc.)

**Decision:** Output `name` in the JSON (not `label`) — this is what the API returns and what downstream consumers should use. The plan doc used "label" as a conceptual label but the field is `name`.

---

## Discovery 2: `TripPlanSelectionInput` has a richer shape than expected

**Plan doc shows:** `inputs: []` (empty in examples, no field contract)

**Actual schema fields:**
- `id: String!`
- `fieldName: String!`
- `fieldLabel: String` (nullable)
- `fieldType: SelectionOutputType` (enum, nullable)
- `isRequired: Boolean!`
- `isLocked: Boolean!`
- `selectionId: String!`
- `value: JSON`
- `transform: JSON`

**Decision:** Output the relevant fields (`id`, `fieldName`, `fieldLabel`, `isRequired`) in the JSON. Omit internal fields (`selectionId`, `transform`, `value`) that have no agent utility.

---

## Discovery 3: `travellerChoices` returns `TravellerChoicesResult!` (non-null)

**Plan doc says:** `travellerChoices(tripPlanId) -> TravellerChoicesResult` (nullable implied)

**Actual schema:** `travellerChoices(tripPlanId: String!): TravellerChoicesResult!` (non-null)

**Decision:** Remove null-guard on the result. If the query throws, it bubbles as an API_ERROR. The `questions` array will be empty for plans with no choices — handled defensively via `result.questions ?? []`.

---

## Discovery 4: `tripPlanTravellerGroup(id)` returns `TripPlanTravellerGroup!` (non-null)

**Plan doc says:** single-group get returns the group (null implied for not-found)

**Actual schema:** returns non-null. A not-found scenario produces a GraphQL error (API_ERROR from our api.ts).

**Decision:** Keep a defensive null check at the TypeScript layer (`data.tripPlanTravellerGroup ?? null`) since GraphQL resolvers sometimes return null even for non-null schema types (e.g., soft-deleted records). This also makes NOT_FOUND tests straightforward to write.

---

## Discovery 5: `TravellerChoicesResult` does not have a `planId` field

The `travellerChoicesResult` type contains `title`, `startDate`, `endDate`, `numberOfDays`, `numberOfNights`, `travellers`, and `questions`, but no `planId` field.

**Decision:** planContext uses the `--plan` flag value for `planId`, `result.title` for `title`, and `result.travellers.length` for `travellerCount`. No extra plan query needed.
