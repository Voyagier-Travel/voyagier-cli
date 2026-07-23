import { CliError, CliErrorCode } from "./errors.js";

// ── Plan-id resolution (v2.11.0) ──
//
// Every command that takes a trip plan id accepts it two ways: as the leading
// positional argument (historical form — byte-identical behavior preserved) or
// via `--plan <id>`. This single helper enforces the semantics uniformly so no
// command grows its own copy:
//   - positional only          → use positional
//   - --plan only              → use --plan (positional is optional)
//   - both, identical          → proceed
//   - both, different          → INVALID_INPUT (conflict)
//   - neither                  → INVALID_INPUT (required)
//
// Throws CliError(INVALID_INPUT); in --json mode index.ts renders the standard
// error envelope { error, code, message }.
//
// Named resolvePlanArg (not resolvePlanArg) to avoid colliding with
// search.ts's exported resolvePlanArg, which has different semantics
// (--plan with last-search fallback, VALIDATION errors).
//
// The flag value is trimmed; an empty/whitespace-only --plan is rejected
// locally as INVALID_INPUT rather than sent to the API. The positional
// argument is deliberately left untouched (byte-identical to the pre-flag
// behavior).
export function resolvePlanArg(
  positional: string | undefined,
  opts: { plan?: string },
  commandName: string,
): string {
  const flag = opts.plan?.trim();
  if (opts.plan !== undefined && flag === "") {
    throw new CliError(CliErrorCode.INVALID_INPUT, "--plan requires a non-empty plan id.");
  }
  if (positional !== undefined && flag !== undefined && positional !== flag) {
    throw new CliError(
      CliErrorCode.INVALID_INPUT,
      `Conflicting plan ids: positional ${positional} vs --plan ${flag}.`,
    );
  }
  const resolved = positional ?? flag;
  if (resolved === undefined) {
    throw new CliError(
      CliErrorCode.INVALID_INPUT,
      `A plan id is required: pass it as the positional argument (voyagier ${commandName} <planId>) or with --plan <id>.`,
    );
  }
  return resolved;
}
