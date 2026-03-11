---
name: voyagier-booking
version: 1.0.0
description: "Voyagier: End-to-end trip planning and booking workflow."
metadata:
  openclaw:
    category: travel
    requires:
      bins:
        - voyagier
---

# voyagier-booking

End-to-end trip planning workflow using the Voyagier CLI.

PREREQUISITE: Read ../voyagier-shared/SKILL.md for auth, global flags, and security rules.

## Full Workflow

### 1. Create a trip plan

```bash
voyagier plans create --title "Client Name — Destination" --start 2026-04-15 --end 2026-04-22 --json
```

Save the `id` from the response — you'll use it for all subsequent commands.

### 2. Add travellers

```bash
voyagier travellers add --plan <PLAN_ID> --first John --last Smith --type ADULT --json
```

Add one traveller per person. At least one is required before searching.

### 3. Search flights

```bash
voyagier search flights --plan <PLAN_ID> --from LAX --to NRT --date 2026-04-15 --json
```

For round-trip, add `--return 2026-04-22`.

### 4. Select a flight

```bash
voyagier select 1 --json
```

For round-trip: this selects the departure. Return options will be displayed — run `voyagier select <n>` again.

### 5. Search hotels

```bash
voyagier search hotels --plan <PLAN_ID> --location Tokyo --checkin 2026-04-15 --checkout 2026-04-22 --json
```

### 6. Select a hotel

```bash
voyagier select 1 --json
```

### 7. Review the plan

```bash
voyagier plans get <PLAN_ID> --json
```

### 8. Share with client

The plan URL is shown in every command's output:
```
https://voyagier.com/plans/<PLAN_ID>
```

Send this to the client. They can view flights, hotels, and all selections in the web app.

## Tips

- Use `--json` on every command when automating. Parse output with `jq`.
- `voyagier select --info <n>` shows full details before committing.
- If search results are stale (>2 hours), re-search for current pricing.
- One trip plan per client trip. Add multiple flights/hotels to the same plan.

## Example: Scripted Booking

```bash
#!/bin/bash
set -e

# Create plan
PLAN=$(voyagier plans create --title "Johnson — Bali" --start 2026-06-01 --end 2026-06-10 --json | jq -r '.id')

# Add traveller
voyagier travellers add --plan $PLAN --first Sarah --last Johnson --type ADULT --json

# Search and select flight
voyagier search flights --plan $PLAN --from SFO --to DPS --date 2026-06-01 --return 2026-06-10 --json
voyagier select 1 --json  # departure
voyagier select 1 --json  # return

# Search and select hotel
voyagier search hotels --plan $PLAN --location Bali --checkin 2026-06-01 --checkout 2026-06-10 --json
voyagier select 1 --json

# Review
voyagier plans get $PLAN
echo "Plan ready: https://voyagier.com/plans/$PLAN"
```

## Related Skills

- [voyagier-shared](../voyagier-shared/SKILL.md) — Auth and global flags
- [voyagier-plans](../voyagier-plans/SKILL.md) — Plan management
- [voyagier-travellers](../voyagier-travellers/SKILL.md) — Traveller management
- [voyagier-search](../voyagier-search/SKILL.md) — Search and select details
