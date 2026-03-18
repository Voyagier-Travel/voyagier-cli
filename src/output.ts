import chalk from "chalk";
import { CliError, CliErrorCode } from "./errors.js";

/** Write JSON to stdout. Only call this when --json is active. */
export function jsonOutput(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Progress message to stderr (dimmed). */
export function progress(msg: string): void {
  process.stderr.write(chalk.dim(msg + "\n"));
}

/** Warning to stderr (yellow). */
export function warn(msg: string): void {
  process.stderr.write(chalk.yellow(`⚠ ${msg}\n`));
}

/** Fatal validation error — throws CliError (caught by top-level handler). */
export function fatal(msg: string): never {
  throw new CliError(CliErrorCode.VALIDATION, msg);
}

/** Write JSON to stdout with planContext injected at the top level. */
export function jsonOutputWithPlan(data: object, planId: string, planTitle?: string): void {
  jsonOutput({ ...data, planContext: { planId, title: planTitle } });
}
