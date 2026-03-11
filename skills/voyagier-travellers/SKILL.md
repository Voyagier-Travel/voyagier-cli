---
name: voyagier-travellers
version: 1.0.0
description: "Voyagier: Add and manage travellers on trip plans."
metadata:
  openclaw:
    category: travel
    requires:
      bins:
        - voyagier
---

# voyagier-travellers

PREREQUISITE: Read ../voyagier-shared/SKILL.md for auth, global flags, and security rules.

## Add a Traveller

```bash
voyagier travellers add --plan <id> --first <name> --last <name> \
  [--type ADULT|CHILD|INFANT] [--email <email>] [--dob YYYY-MM-DD] \
  [--gender MALE|FEMALE|UNSPECIFIED] [--json]
```

IMPORTANT: At least one traveller must be added before searching for flights or hotels. The booking system needs passenger counts.

Default `--type` is `ADULT`.

### Example

```bash
voyagier travellers add --plan abc123 --first John --last Smith --type ADULT --email john@example.com --json
```

## List Travellers

```bash
voyagier travellers list --plan <id> [--json]
```

## Remove a Traveller

```bash
voyagier travellers remove <traveller-id> [--json]
```

## Related Skills

- [voyagier-shared](../voyagier-shared/SKILL.md) — Auth and global flags
- [voyagier-plans](../voyagier-plans/SKILL.md) — Create plans first
- [voyagier-search](../voyagier-search/SKILL.md) — Search after adding travellers
