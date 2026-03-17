# @voyagier/cli

One CLI for Voyagier — built for humans and AI agents.

Search flights, book hotels, manage trip plans from your terminal. Everything syncs to the web app at [voyagier.com](https://voyagier.com).

```bash
npm install -g @voyagier/cli
```

## Quick Start

```bash
# Authenticate
voyagier auth set-token <your-token>

# Create a trip plan
voyagier plans create --title "Tokyo Trip" --start 2026-04-15 --end 2026-04-22

# Add a traveller
voyagier travellers add --plan <PLAN_ID> --first John --last Smith --type ADULT

# Search flights
voyagier search flights --plan <PLAN_ID> --from LAX --to NRT --date 2026-04-15

# Select from results
voyagier select 1

# Search hotels
voyagier search hotels --plan <PLAN_ID> --location Tokyo --checkin 2026-04-15 --checkout 2026-04-22

# Select hotel
voyagier select 1

# Search activities
voyagier search activities --plan <PLAN_ID> --destination Tokyo --date 2026-04-16

# Select activity
voyagier select 1

# View plan
voyagier plans get <PLAN_ID>
# → https://voyagier.com/plans/<PLAN_ID>
```

## Commands

### Auth

| Command | Description |
|---------|-------------|
| `voyagier auth set-token <token>` | Save a personal access token |
| `voyagier auth status` | Check connection and show authenticated user |
| `voyagier auth logout` | Clear credentials |
| `voyagier auth setup` | How to get a token |

### Trip Plans

| Command | Description |
|---------|-------------|
| `voyagier plans create --title <title>` | Create a new plan |
| `voyagier plans list` | List your plans |
| `voyagier plans get <id>` | Show plan details |
| `voyagier plans delete <id>` | Delete a plan |

### Travellers

| Command | Description |
|---------|-------------|
| `voyagier travellers add --plan <id> --first <name> --last <name>` | Add a traveller |
| `voyagier travellers list --plan <id>` | List travellers |
| `voyagier travellers remove <id>` | Remove a traveller |

### Search

| Command | Description |
|---------|-------------|
| `voyagier search flights --plan <id> --from <IATA> --to <IATA> --date <date>` | Search flights |
| `voyagier search hotels --plan <id> --location <city> --checkin <date> --checkout <date>` | Search hotels |
| `voyagier search activities --plan <id> --destination <place> --date <date>` | Search activities/experiences |

### Select

| Command | Description |
|---------|-------------|
| `voyagier select <number>` | Select option from last search |
| `voyagier select --info <number>` | Show details without selecting |
| `voyagier select --clear` | Clear search cache |

### Chat

| Command | Description |
|---------|-------------|
| `voyagier chat` | Start an AI chat session |
| `voyagier chat --plan <id>` | Chat about a specific plan |
| `voyagier chat --list` | List chat sessions |

## JSON Output

Every command supports `--json` for structured output:

```bash
# Create plan and capture ID
PLAN=$(voyagier plans create --title "My Trip" --json | jq -r '.id')

# Search and pipe to jq
voyagier search flights --plan $PLAN --from LAX --to NRT --date 2026-04-15 --json | jq '.options[].name'
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VOYAGIER_TOKEN` | Personal access token (overrides config file) | — |
| `VOYAGIER_API_URL` | API base URL | `https://travel.voyagier.com` |

## Agent Skills

This package ships with [agent skills](./skills/) — structured instructions that teach AI agents how to use the CLI.

### OpenClaw

```bash
# Symlink all skills
ln -s $(npm root -g)/@voyagier/cli/skills/voyagier-* ~/.openclaw/skills/

# Or copy specific ones
cp -r $(npm root -g)/@voyagier/cli/skills/voyagier-booking ~/.openclaw/skills/
```

### Any Agent

The skills are SKILL.md files that any agent with shell access can read and follow. No MCP required. The agent reads the skill, calls CLI commands, and parses JSON output.

### Available Skills

| Skill | Description |
|-------|-------------|
| `voyagier-shared` | Auth, global flags, output formatting |
| `voyagier-plans` | Create, list, get, delete trip plans |
| `voyagier-travellers` | Add, list, remove travellers |
| `voyagier-search` | Search flights/hotels/activities, select options |
| `voyagier-booking` | End-to-end booking workflow |

## How It Works

The CLI is a thin client over Voyagier's GraphQL API — the same API the web app uses. Everything you do in the CLI shows up in the web app and vice versa.

```
CLI  →  Voyagier GraphQL API  →  Trip Plans (visible at voyagier.com)
                               →  GDS (flight/hotel search)
```

## License

UNLICENSED — proprietary.
