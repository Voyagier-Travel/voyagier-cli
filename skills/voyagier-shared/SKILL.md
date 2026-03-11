---
name: voyagier-shared
version: 1.0.0
description: "Voyagier CLI: Auth, global flags, and output formatting."
metadata:
  openclaw:
    category: travel
    requires:
      bins:
        - voyagier
---

# voyagier-shared

Shared patterns for the Voyagier CLI. Read this first before using any other voyagier skill.

## Install

```bash
npm install -g @voyagier/cli
```

## Auth

```bash
# Save a Personal Access Token
voyagier auth set-token <PAT>

# Check connectivity + show authenticated user
voyagier auth status

# Or use environment variables (CI/scripts)
export VOYAGIER_TOKEN=voy_pat_xxxxx
export VOYAGIER_API_URL=https://voyagier.com  # optional
```

To get a PAT: log in to voyagier.com → Settings → Personal Access Tokens → Create.

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON to stdout (for piping/agents) |
| `--plan <id>` | Operate within a trip plan context |

## Output

- Human-readable by default (formatted, colored)
- `--json` outputs structured JSON to stdout
- Status messages and errors go to stderr
- Exit code 1 on all errors

## Trip Plan URLs

All plan-related commands include a URL in their output:
```
https://voyagier.com/plans/<id>
```
Share this URL with clients so they can view the plan in the web app.

## Security

- Never output PAT tokens directly
- Confirm with the user before any purchase/booking commands
- Credentials stored in `~/.voyagier/credentials.json` (mode 0600)
