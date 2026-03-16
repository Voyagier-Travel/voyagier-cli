export enum CliErrorCode {
  AUTH_FAILED = "AUTH_FAILED",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION = "VALIDATION",
  API_ERROR = "API_ERROR",
  NETWORK = "NETWORK",
  STATE_CORRUPT = "STATE_CORRUPT",
}

export class CliError extends Error {
  constructor(public code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** Standardized auth failure message — used by all AUTH_FAILED errors. */
export function authFailedMessage(reason: string): string {
  return `${reason}\n\n  Run:  voyagier login\n  Or:   voyagier auth set-token <token>\n\n  Get a token: https://travel.voyagier.com → Settings → Personal Access Tokens`;
}
