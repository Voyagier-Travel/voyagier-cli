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
