---
name: voyagier-search
version: 1.0.0
description: "Voyagier: Search flights and hotels, select options."
metadata:
  openclaw:
    category: travel
    requires:
      bins:
        - voyagier
---

# voyagier-search

PREREQUISITE: Read ../voyagier-shared/SKILL.md for auth, global flags, and security rules.

## Search Flights

```bash
voyagier search flights --plan <id> --from <IATA> --to <IATA> --date YYYY-MM-DD \
  [--return YYYY-MM-DD] [--max-stops <n>] [--json]
```

Requires travellers on the plan (see voyagier-travellers skill). If `--plan` is omitted, auto-resolves from the last search context.

Results are numbered `[1] [2] [3]` and cached locally for the `select` command.

### Example

```bash
voyagier search flights --plan abc123 --from LAX --to NRT --date 2026-04-15 --json
```

## Search Hotels

```bash
voyagier search hotels --plan <id> --location <city> --checkin YYYY-MM-DD --checkout YYYY-MM-DD \
  [--currency USD] [--guests <n>] [--json]
```

### Example

```bash
voyagier search hotels --plan abc123 --location Tokyo --checkin 2026-04-15 --checkout 2026-04-22 --json
```

## Select from Results

```bash
voyagier select <number> [--json]
```

Selects the numbered option from the most recent search. Handles:
- **One-way flights:** Selects directly.
- **Round-trip flights:** First `select` picks departure, then displays return options. Run `select` again for the return leg.
- **Hotels:** Selects directly.

### Other select commands

```bash
voyagier select --info <number>   # Show full details without selecting
voyagier select --clear           # Discard cached search results
```

## Search + Select Flow

```bash
# Search flights
voyagier search flights --plan abc123 --from LAX --to NRT --date 2026-04-15
#   ✈️  [1]  AA175 LAX → NRT  ·  $850  ·  11h20m
#   ✈️  [2]  UA837 LAX → NRT  ·  $720  ·  14h05m

# Select option 1
voyagier select 1
#   ✓ Selected: LAX→NRT · AA175 · $850 · 11h20m

# Search hotels
voyagier search hotels --plan abc123 --location Tokyo --checkin 2026-04-15 --checkout 2026-04-22
#   🏨  [1]  Park Hyatt Tokyo  ·  $450/night
#   🏨  [2]  Aman Tokyo  ·  $890/night

# Select hotel
voyagier select 1
#   ✓ 🏨 Selected: Park Hyatt Tokyo · $450/night
```

## Notes

- Search results expire after ~2 hours (GDS offer TTL). Re-search for current pricing.
- Each search creates a selection item on the trip plan, visible in the web app.
- `--json` output includes `tripPlanId`, `selectionId`, and full option details.

## Related Skills

- [voyagier-shared](../voyagier-shared/SKILL.md) — Auth and global flags
- [voyagier-travellers](../voyagier-travellers/SKILL.md) — Add travellers before searching
- [voyagier-booking](../voyagier-booking/SKILL.md) — End-to-end workflow
