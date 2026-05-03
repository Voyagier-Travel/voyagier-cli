export enum CliErrorCode {
  AUTH_FAILED = "AUTH_FAILED",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION = "VALIDATION",
  API_ERROR = "API_ERROR",
  NETWORK = "NETWORK",
  STATE_CORRUPT = "STATE_CORRUPT",

  // v2.0.0 — client/RBAC awareness
  NO_CLIENTS = "NO_CLIENTS",
  MULTIPLE_CLIENTS = "MULTIPLE_CLIENTS",
  CLIENT_REQUIRED = "CLIENT_REQUIRED",
  PERMISSION_DENIED = "PERMISSION_DENIED",

  // v2.0.0 — schema drift / version compat
  SCHEMA_DRIFT = "SCHEMA_DRIFT",

  // v2.0.0 — Section 3 (cart + bookability)
  NOT_BOOKABLE = "NOT_BOOKABLE",
  BOOKING_BLOCKED = "BOOKING_BLOCKED",
  EXPIRED_OFFER = "EXPIRED_OFFER",
  STALE_PLAN_STATE = "STALE_PLAN_STATE",
}

export class CliError extends Error {
  /** Optional structured details (blockers, contextual data). Surfaces on --json output. */
  public details?: Record<string, unknown>;

  constructor(public code: CliErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    if (details) this.details = details;
  }
}

/** Standardized auth failure message — used by all AUTH_FAILED errors. */
export function authFailedMessage(reason: string): string {
  return `${reason}\n\n  Run:  voyagier login\n  Or:   voyagier auth set-token <token>\n\n  Get a token: https://travel.voyagier.com → Settings → Personal Access Tokens`;
}
