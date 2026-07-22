/**
 * TTY-aware loading spinner for long CLI operations (VOY: loading-spinner).
 *
 * Why this exists: long operations (flight search ~45s, hotel search ~35s,
 * --wait poll loops) used to print a single static stderr line and then sit
 * silent — a human at a terminal sees a dead prompt for tens of seconds. This
 * gives an animated, elapsed-time spinner WITHOUT changing the agent surface:
 *
 *   - stdout is NEVER written to (that carries --json / --agent payloads).
 *   - Animation (ANSI cursor control) happens ONLY on an interactive TTY that
 *     is not CI. Everywhere else (pipes, CI, agents) the spinner degrades to
 *     the old behaviour: a single plain line per label, no ANSI junk.
 *
 * Color is chalk's concern and is orthogonal — chalk already self-disables on
 * non-TTY / NO_COLOR. The *animation* gate here is isTTY && !CI only, so a
 * color-capable-but-non-interactive stream still gets the plain fallback.
 */

import chalk from "chalk";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 120;
/** Only surface the elapsed suffix once the op has visibly stalled (>3s). */
const ELAPSED_AFTER_MS = 3000;

export interface SpinnerHandle {
  /** Swap the label shown next to the spinner mid-flight. */
  update(label: string): void;
  /** Stop the spinner. Clears the animated line; writes `finalLine` (+\n) if given. Idempotent. */
  stop(finalLine?: string): void;
}

/**
 * Start a spinner on `opts.stream` (default process.stderr). Returns a handle
 * to update the label or stop it. See the module comment for the TTY gate.
 */
export function startSpinner(
  label: string,
  opts: { stream?: NodeJS.WriteStream } = {},
): SpinnerHandle {
  const stream = opts.stream ?? process.stderr;
  const animate = stream.isTTY === true && !process.env.CI;

  if (!animate) {
    // Non-TTY / CI: preserve the pre-spinner behaviour exactly — a single dim
    // line per distinct label, no ANSI cursor control. Dedupe repeats so a
    // poll loop that re-sends the same label doesn't spam identical lines,
    // while distinct labels (e.g. "attempt 3" → "attempt 4") still get through.
    let lastWritten: string | null = null;
    let stopped = false;
    const writeLine = (text: string): void => {
      if (text === lastWritten) return;
      lastWritten = text;
      stream.write(chalk.dim(text + "\n"));
    };
    writeLine(label);
    return {
      update(next: string): void {
        if (stopped) return;
        writeLine(next);
      },
      stop(finalLine?: string): void {
        if (stopped) return;
        stopped = true;
        if (finalLine !== undefined) stream.write(finalLine + "\n");
      },
    };
  }

  // Interactive TTY: animate braille frames in place, appending elapsed time.
  let currentLabel = label;
  let frame = 0;
  let stopped = false;
  const startedAt = Date.now();

  const clearLine = (): void => {
    stream.write("\r\x1b[2K");
  };

  const render = (): void => {
    const spinner = FRAMES[frame % FRAMES.length];
    const elapsedMs = Date.now() - startedAt;
    const suffix = elapsedMs >= ELAPSED_AFTER_MS ? ` (${Math.floor(elapsedMs / 1000)}s)` : "";
    clearLine();
    stream.write(`${spinner} ${currentLabel}${suffix}`);
  };

  render();
  const timer = setInterval(() => {
    frame++;
    render();
  }, INTERVAL_MS);
  // A hung spinner must never keep the event loop (and thus the process) alive.
  timer.unref();

  return {
    update(next: string): void {
      if (stopped) return;
      currentLabel = next;
      render();
    },
    stop(finalLine?: string): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearLine();
      if (finalLine !== undefined) stream.write(finalLine + "\n");
    },
  };
}
