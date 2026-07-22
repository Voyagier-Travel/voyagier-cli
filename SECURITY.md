# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately via GitHub:
**[Security → Report a vulnerability](https://github.com/Voyagier-Travel/voyagier-cli/security/advisories/new)**

Do **not** open a public issue for security reports.

We aim to acknowledge reports within 2 business days. Please include reproduction steps and the CLI version (`voyagier --version`).

## Scope

This policy covers the `@voyagier/cli` package and this repository. Vulnerabilities in the Voyagier platform/API can also be reported through the same channel and will be routed to the right team.

## Supported Versions

Only the latest published version of `@voyagier/cli` is supported. Please reproduce against the latest release before reporting.

## Token Safety

- Prefer `voyagier login` (interactive) or the `VOYAGIER_TOKEN` env var; `voyagier auth set-token <token>` places the token in your shell history.
- Credentials are stored in `~/.voyagier/credentials.json` with `0600` permissions.
- If you believe a token has been exposed, revoke it from your Voyagier account immediately.
