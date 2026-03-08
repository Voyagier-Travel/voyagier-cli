# Voyagier CLI

AI trip planning from your terminal. Search flights, hotels, and plan trips using Voyagier's MCP-powered API.

## Quick Start

```bash
# Install
npx @voyagier/cli auth setup

# Authenticate
voyagier auth set-token voy_pat_xxx

# Search flights
voyagier search flights --from LAX --to NRT --date 2026-04-15

# Search hotels
voyagier search hotels --location Tokyo --checkin 2026-04-15 --checkout 2026-04-20

# Interactive AI chat
voyagier chat
```

## Commands

| Command | Description |
|---------|-------------|
| `voyagier auth set-token <token>` | Set your Personal Access Token |
| `voyagier auth setup` | Show how to get a token |
| `voyagier auth status` | Check connection and token validity |
| `voyagier auth logout` | Clear saved credentials |
| `voyagier search flights` | Search for flights |
| `voyagier search hotels` | Search for hotels |
| `voyagier chat` | Interactive AI trip planning chat |
| `voyagier chat --list` | List chat sessions |
| `voyagier plans list` | List your trip plans |
| `voyagier plans get <id>` | View trip plan details |
| `voyagier tools list` | List available MCP tools |
| `voyagier tools call <name> '<json>'` | Call an MCP tool directly |

## Authentication

Get a Personal Access Token from your Voyagier account settings:

- **Production:** https://voyagier.com/me/settings/tokens
- **Sandbox:** https://dev.voyagier.com/me/settings/tokens (Sabre test data, free)

```bash
# Sandbox (recommended for testing)
voyagier auth set-token voy_pat_xxx --url https://dev.voyagier.com

# Production
voyagier auth set-token voy_pat_xxx
```

### Environment Variables

For CI/CD or scripts, use environment variables instead of the config file:

```bash
export VOYAGIER_TOKEN=voy_pat_xxx
export VOYAGIER_API_URL=https://dev.voyagier.com  # optional, defaults to production
```

Environment variables take precedence over the config file (`~/.voyagier/credentials.json`).

## Machine-Readable Output

Use `--json` for piping and scripting:

```bash
# Pipe flight results to jq
voyagier search flights --from LAX --to NRT --date 2026-04-15 --json | jq '.flights[0].options'

# List tools as JSON
voyagier tools list --json
```

When `--json` is used, data goes to stdout and status messages go to stderr, so pipes work cleanly.

## Requirements

- Node.js 18+
- A Voyagier account with a Personal Access Token
