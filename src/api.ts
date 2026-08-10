import chalk from "chalk";
import { getApiUrl, getToken } from "./config.js";
import { getTraceId } from "./telemetry.js";
import { gracefulExit } from "./exit.js";
import { verbose } from "./verbose.js";
import { CliError, CliErrorCode, authFailedMessage } from "./errors.js";
import { sanitizeExternalData, sanitizeExternalText } from "./utils.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface GraphQLOptions {
  dryRun?: boolean;
}

export async function graphql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  options?: GraphQLOptions
): Promise<T> {
  const apiUrl = getApiUrl();
  const token = getToken();

  if (options?.dryRun) {
    const body = { query, variables };
    process.stderr.write("\n--- DRY RUN ---\n");
    process.stderr.write(`POST ${apiUrl}/graphql\n`);
    process.stderr.write(`Authorization: Bearer ${token.slice(0, 8)}••••\n\n`);
    process.stderr.write(JSON.stringify(body, null, 2) + "\n");
    process.stderr.write("--- END DRY RUN ---\n\n");
    await gracefulExit(0);
  }

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-request-id": getTraceId(),
        "x-datadog-trace-id": getTraceId(),
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (fetchErr) {
    if (fetchErr instanceof CliError) throw fetchErr;
    const stack = verbose && fetchErr instanceof Error ? `\n${fetchErr.stack}` : "";
    throw new CliError(
      CliErrorCode.NETWORK,
      `Network error: Could not reach the API.\nHint: Check your connection and API URL: voyagier auth status${stack}`
    );
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Authentication failed. Your token may be invalid or expired."));
    }
    if (res.status === 403) {
      throw new CliError(
        CliErrorCode.PERMISSION_DENIED,
        "Permission denied: your token does not have access to this resource — or the resource does not exist (the server reports missing and forbidden identically).\n  Fix: double-check any resource id in the command (if the operation targets one), confirm the token belongs to the right account, or ask a workspace admin for access.",
      );
    }
    // Try to extract GraphQL error details from the response body
    let detail = "";
    try {
      const errorBody = (await res.json()) as GraphQLResponse;
      if (errorBody.errors?.length) {
        detail = " — " + errorBody.errors.map(e => sanitizeExternalText(e.message)).join("; ");
      }
    } catch {
      // Response body wasn't valid JSON; fall through to generic message
    }
    const hint = detail === ""
      ? "\nHint: The API returned no data. This may be a permissions issue."
      : "";
    throw new CliError(CliErrorCode.API_ERROR, `API error: ${res.status} ${sanitizeExternalText(res.statusText)}${detail}${hint}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    // Sanitize server-provided error text before it reaches a terminal — same
    // untrusted-content rule as response data (VOY-1709).
    const err = { ...json.errors[0], message: sanitizeExternalText(json.errors[0].message) };
    const code = (err as Record<string, unknown> & { extensions?: { code?: string } }).extensions?.code;
    if (code === "UNAUTHENTICATED" || err.message === "Unauthorized") {
      throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Authentication failed. Your token may be invalid or expired."));
    }
    if (code === "FORBIDDEN") {
      throw new CliError(
        CliErrorCode.PERMISSION_DENIED,
        `Permission denied: ${err.message}\n  Note: this can also mean the requested resource does not exist — the server reports missing and forbidden identically. If the operation targets an id, double-check it before assuming an access problem.`,
      );
    }
    // Schema-drift signals from the GraphQL validator. CLI is out of sync with the server schema.
    const drifty = /Cannot query field|Unknown argument|Unknown type|Unknown field/.test(err.message);
    if (drifty) {
      throw new CliError(
        CliErrorCode.SCHEMA_DRIFT,
        `Schema drift detected: ${err.message}\n  Hint: your CLI may be out of date. Run: voyagier doctor (and check: voyagier --version)`,
      );
    }
    throw new CliError(CliErrorCode.API_ERROR, `GraphQL error: ${err.message}`);
  }
  if (!json.data) {
    throw new CliError(CliErrorCode.API_ERROR, "No data returned from API");
  }
  // SECURITY (VOY-1709): responses carry third-party supplier content (hotel
  // names, option labels). Strip ANSI escapes/control chars once, here, so
  // every command and output mode renders it as inert text.
  return sanitizeExternalData(json.data);
}

/**
 * Backward-compat wrapper for queries that select fields a not-yet-deployed
 * backend won't recognize (VOY-1748: TripPlanClient.isSelf, User.isTripPlanner).
 *
 * The published CLI talks to prod, which validates every query against its
 * schema — selecting an unknown field is a hard validation error, not a null.
 * So this attempts the enriched query first; if the server rejects it with a
 * field-validation error naming one of the new fields, it transparently
 * retries the legacy query and lets the caller treat those fields as absent.
 *
 * Detection is strict: graphql() classifies GraphQL validation errors as
 * CliError(SCHEMA_DRIFT) and preserves the original "Cannot query field …"
 * phrasing, so we require BOTH the SCHEMA_DRIFT code and the caller-supplied
 * field name in the message. Any other error (auth, network, a genuine
 * server error — or drift on an unrelated, pre-existing field) propagates
 * untouched.
 *
 * Once a query has fallen back, the downgrade is remembered for the rest of
 * the process (a single CLI invocation): paginated callers like
 * fetchAllClients would otherwise pay a doubled round-trip on every page
 * against an old backend.
 */
const legacyModeQueries = new Set<string>();

/** Test-only: reset the per-process fallback memory. */
export function __resetFieldFallbackCache(): void {
  legacyModeQueries.clear();
}

export async function graphqlWithFieldFallback<T = unknown>(
  enrichedQuery: string,
  legacyQuery: string,
  fieldPattern: RegExp,
  variables?: Record<string, unknown>,
  options?: GraphQLOptions,
): Promise<T> {
  if (legacyModeQueries.has(enrichedQuery)) {
    return await graphql<T>(legacyQuery, variables, options);
  }
  try {
    return await graphql<T>(enrichedQuery, variables, options);
  } catch (err) {
    const isUnknownNewField =
      err instanceof CliError &&
      err.code === CliErrorCode.SCHEMA_DRIFT &&
      fieldPattern.test(err.message);
    if (isUnknownNewField) {
      legacyModeQueries.add(enrichedQuery);
      return await graphql<T>(legacyQuery, variables, options);
    }
    throw err;
  }
}

