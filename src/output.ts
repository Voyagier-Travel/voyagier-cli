import chalk from "chalk";

/** Write JSON to stdout. Only call this when --json is active. */
export function jsonOutput(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Write structured error JSON to stdout (for --json mode failures). */
export function jsonError(message: string, code?: string): never {
  process.stdout.write(JSON.stringify({ error: true, message, code: code ?? "ERROR" }, null, 2) + "\n");
  process.exit(1);
}

/** Progress message to stderr (dimmed). */
export function progress(msg: string): void {
  process.stderr.write(chalk.dim(msg + "\n"));
}

/** Warning to stderr (yellow). */
export function warn(msg: string): void {
  process.stderr.write(chalk.yellow(`⚠ ${msg}\n`));
}

/** Fatal error to stderr + exit. */
export function fatal(msg: string): never {
  process.stderr.write(chalk.red(msg + "\n"));
  process.exit(1);
}
