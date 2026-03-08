# @voyagier/cli

AI trip planning from your terminal. Authenticate with a Personal Access Token and interact with Voyagier's AI chat, search flights/hotels, and manage trip plans.

## Setup

```bash
npm install -g @voyagier/cli
# or
npx @voyagier/cli
```

## Authentication

Get a PAT from **Settings → API Tokens** in the Voyagier web app, then:

```bash
voyagier auth set-token voy_pat_xxxxx
voyagier auth status
```

For dev/staging:

```bash
voyagier auth set-token voy_pat_xxxxx --api-url https://dev.voyagier.com
```

## Chat (Interactive REPL)

```bash
voyagier chat                    # New session
voyagier chat --session <id>     # Resume session
voyagier chat --list             # List sessions
```

## Trip Plans

```bash
voyagier plans list              # List your trip plans
voyagier plans get <id>          # Show plan details
```

## Development

```bash
npm install
npm run dev -- auth status       # Run with tsx
npm run build                    # Compile to dist/
```

## Architecture

Thin client over Voyagier's existing API:
- **Auth:** PAT stored in `~/.voyagier/credentials.json` (mode 0600)
- **Chat:** SSE streaming via `POST /chat/sessions/:id/stream` (Vercel AI SDK format)
- **Data:** GraphQL for session/plan management
- **Dependencies:** commander, chalk, ora (minimal footprint)
