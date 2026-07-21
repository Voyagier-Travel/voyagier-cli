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

  // v2.0.0 — Section 7 (listings + places)
  LISTING_NOT_FOUND = "LISTING_NOT_FOUND",
  PLACE_NOT_FOUND = "PLACE_NOT_FOUND",
  NO_MONITOR = "NO_MONITOR",

  // v2.0.0 — Section 4 (goals)
  GOAL_NOT_FOUND = "GOAL_NOT_FOUND",
  // PLAN_REQUIRED and PLACE_ID_REQUIRED were declared in an earlier draft
  // but never thrown — Commander's required-flag validation handles missing
  // --plan / --place-id at the parser layer, so the codes are unused.
  // Reintroduce here only when there's a real path that needs to throw them.

  // v2.1.0 — Section 6 (traveller groups + choices)
  GROUP_NAME_REQUIRED = "GROUP_NAME_REQUIRED",
  TRAVELLER_NOT_IN_PLAN = "TRAVELLER_NOT_IN_PLAN",
  MEMBERS_REQUIRED = "MEMBERS_REQUIRED",
  PLAN_NOT_FOUND = "PLAN_NOT_FOUND",

  // v2.4.0 — VOY-1706 (book price hard-gate + checkout idempotency)
  /** Chargeable cart total does not satisfy --expect-total / --max-total. */
  PRICE_CHANGED = "PRICE_CHANGED",
  /** A Paid checkout with booking records already exists for this plan. */
  ALREADY_BOOKED = "ALREADY_BOOKED",

  // v2.5.0 — VOY-1212 (send + quote)
  /** Externally-visible action (e.g. emailing a client) needs explicit confirmation: interactive yes or --yes. */
  CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED",
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
