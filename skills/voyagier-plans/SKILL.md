---
name: voyagier-plans
version: 1.0.0
description: "Voyagier: Create, list, and manage trip plans."
metadata:
  openclaw:
    category: travel
    requires:
      bins:
        - voyagier
---

# voyagier-plans

PREREQUISITE: Read ../voyagier-shared/SKILL.md for auth, global flags, and security rules.

## Create a Trip Plan

```bash
voyagier plans create --title <title> [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--description <text>] [--json]
```

Returns the plan ID and URL. Always create a plan before searching.

### Example

```bash
voyagier plans create --title "Smith Family — Tokyo" --start 2026-04-15 --end 2026-04-22 --json
```

## List Trip Plans

```bash
voyagier plans list [--json]
```

Shows up to 20 plans with title, dates, and item count.

## Get Trip Plan Details

```bash
voyagier plans get <id> [--json]
```

Shows items (flights, hotels, activities), travellers, and collaborators.

## Delete a Trip Plan

```bash
voyagier plans delete <id> [--json]
```

Caution: This is a destructive operation — confirm with the user first.

## Typical Flow

```bash
# 1. Create
voyagier plans create --title "Client Trip" --json
# → { "id": "abc123", "url": "https://voyagier.com/plans/abc123" }

# 2. Add travellers (see voyagier-travellers skill)
# 3. Search & select (see voyagier-search skill)

# 4. Review
voyagier plans get abc123

# 5. Share URL with client
# https://voyagier.com/plans/abc123
```

## Related Skills

- [voyagier-shared](../voyagier-shared/SKILL.md) — Auth and global flags
- [voyagier-travellers](../voyagier-travellers/SKILL.md) — Manage travellers
- [voyagier-search](../voyagier-search/SKILL.md) — Search and select flights/hotels
- [voyagier-booking](../voyagier-booking/SKILL.md) — End-to-end workflow
