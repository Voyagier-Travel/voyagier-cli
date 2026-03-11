# Voyagier Booking Workflow

End-to-end trip booking via CLI. Read `voyagier-shared/SKILL.md` first for auth and global flags.

## Full Workflow

### 1. Create a trip plan
```bash
voyagier plans create --title "Smith Family — Punta Cana" --start 2026-06-01 --end 2026-06-08 --json
```
Save the `id` from the response.

### 2. Add travellers
```bash
voyagier travellers add --plan <planId> --first John --last Smith --type ADULT --json
voyagier travellers add --plan <planId> --first Jane --last Smith --type ADULT --json
```

### 3. Search and select flights
```bash
voyagier search flights --plan <planId> --from JFK --to PUJ --date 2026-06-01 --return 2026-06-08 --json
voyagier select 1 --json      # select departure flight
voyagier select 2 --json      # select return flight (prompted automatically for round-trip)
```

### 4. Search and select hotels
```bash
voyagier search hotels --plan <planId> --location "Punta Cana" --checkin 2026-06-01 --checkout 2026-06-08 --json
voyagier select 1 --json      # select hotel
```

### 5. Pick sub-options (cabin class, room type)
```bash
voyagier options <planId> --json    # see what needs sub-selection choices
voyagier pick 1 --json              # pick cabin class or room type by number
```

If sub-options need refreshing:
```bash
voyagier options <planId> --refresh --json
```

### 6. Review cart
```bash
voyagier cart <planId> --json
```
Verify all items are present, no pending sub-selections, total looks correct.

### 7. Book (checkout via Stripe)
```bash
# Preview what would be charged:
voyagier book <planId> --dry-run --json

# Create checkout and open Stripe payment page:
voyagier book <planId>
```

### 8. Check booking status
```bash
voyagier book <planId> --status --json
```

## Command Reference

| Step | Command | Key Flags |
|------|---------|-----------|
| Plan | `plans create` | `--title`, `--start`, `--end` |
| Travellers | `travellers add` | `--plan`, `--first`, `--last`, `--type` |
| Search flights | `search flights` | `--plan`, `--from`, `--to`, `--date`, `--return` |
| Search hotels | `search hotels` | `--plan`, `--location`, `--checkin`, `--checkout` |
| Select | `select <n>` | index from last search |
| Sub-options | `options <planId>` | `--refresh` to re-fetch from provider |
| Pick sub-option | `pick <n>` | index from `options` output |
| Cart | `cart <planId>` | review before booking |
| Book | `book <planId>` | `--dry-run`, `--status` |

## Important Notes

- **Sub-selections matter:** After selecting a flight, you may need to pick a cabin class. After selecting a hotel, you may need to pick a room type. The `options` command shows what's needed.
- **Cart must be complete** before `book` will proceed. It checks for empty cart and missing sub-selections.
- **Stripe handles payment.** The `book` command opens a Stripe-hosted checkout page in the browser.
- **Flight prices are reserved** when you run `book`. The Sabre fare is locked at checkout time.
- **6% travel fee** is added automatically at checkout.
- **Everything syncs to the web.** View at `https://voyagier.com/plans/<planId>` at any time.
