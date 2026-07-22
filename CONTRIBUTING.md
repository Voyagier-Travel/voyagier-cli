# Contributing

Thanks for your interest in the Voyagier CLI!

## Before you start

This repository is **source-visible but proprietary** (see [LICENSE.md](LICENSE.md)). By submitting a pull request, you agree that your contribution is licensed to Voyagier, Inc. and may be distributed under the terms of the repository license.

- **Bugs:** please open an issue with reproduction steps and `voyagier --version`.
- **Security issues:** do NOT open an issue — see [SECURITY.md](SECURITY.md).
- **Features:** open an issue first so we can discuss fit before you invest time.

## Development setup

```bash
git clone https://github.com/Voyagier-Travel/voyagier-cli.git
cd voyagier-cli
npm ci
npm run build   # tsc — must compile clean
npm test        # jest — full suite
```

Node >= 20 required (CI runs on 22).

## Pull requests

- One concern per PR; keep diffs reviewable.
- `npm run build` **and** `npm test` must both pass — the build is stricter than the test runner.
- Add or update tests for behavior changes; suggested-command output and error codes are asserted heavily in specs.
- Follow the existing conventions: `--json` output contracts are additive-only, every server-derived value interpolated into a runnable suggested command goes through `shellArg()`, and errors use `CliError` codes.
- Conventional commit titles (`feat:`, `fix:`, `chore:`) — they drive release version bumps.

## Agent-facing docs

`AGENT.md` is a load-bearing artifact consumed by AI agents (`voyagier agent-doc`). If your change alters command surfaces, flags, or JSON shapes, update `AGENT.md` — `doc-drift.spec.ts` will fail if key claims drift from reality.
