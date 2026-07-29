/**
 * Shared interactive-prompt helpers (VOY-1762).
 *
 * The CLI should ASK for missing info when a human is at a TTY, but preserve
 * EXACT non-interactive error behavior everywhere else — agents, CI, `--json`
 * consumers, and the MCP server must never block on a prompt.
 *
 * Convention (matches the inline prompts in send.ts / travellers.ts):
 *   - createInterface from readline/promises
 *   - prompt output goes to process.stderr, NEVER stdout: stdout must stay a
 *     pure JSON/pipe stream (a piped consumer would otherwise ingest the prompt
 *     text), and stdin-TTY does not imply stdout-TTY.
 *   - always rl.close() in finally.
 */
import { createInterface } from "readline/promises";
import chalk from "chalk";
import { CliError } from "./errors.js";

/**
 * Interactivity signal, read from a command's commander opts bag.
 *
 * `input` is present because `commander`'s `--no-input` negatable option
 * materializes as `opts.input === false` (and `true` by default); we treat that
 * exactly like an explicit `noInput`. `json`/`agent` are machine-output modes
 * whose stdout is a payload stream — never prompt in those.
 */
export interface InteractiveOptions {
  json?: boolean;
  agent?: boolean;
  noInput?: boolean;
  input?: boolean;
}

/**
 * True only when a human is at a TTY and no machine/agent/no-input mode is
 * active. This is the single gate every prompt site must pass through so that
 * non-TTY, CI, `--json`, `--agent`, and `--no-input` all keep their exact
 * current non-interactive error behavior.
 */
export function isInteractive(opts: InteractiveOptions = {}): boolean {
  const noInput = opts.noInput === true || opts.input === false;
  return (
    process.stdin.isTTY === true &&
    !process.env.CI &&
    !opts.json &&
    !opts.agent &&
    !noInput
  );
}

/**
 * Ask a free-text question on STDERR and return the trimmed answer.
 * When the answer is empty and a `default` is provided, the default is returned.
 */
export async function promptText(
  question: string,
  opts: { default?: string } = {},
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim();
    if (!answer && opts.default !== undefined) return opts.default;
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * Numbered picker printed to STDERR. Renders each item as `  [n] <render(item)>`,
 * reads a 1-based selection, and returns the chosen item. Re-asks up to 2 times
 * on invalid input (non-numeric, out of range, or empty), then throws the
 * ORIGINAL CliError the caller provides — so a caller that gives up interactively
 * fails with the exact same error it would have thrown non-interactively.
 */
export async function promptPick<T>(
  question: string,
  items: T[],
  render: (item: T) => string,
  onGiveUp: CliError,
): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const MAX_ATTEMPTS = 3; // initial ask + 2 re-asks
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      process.stderr.write(question + "\n");
      items.forEach((item, i) => {
        process.stderr.write(`  [${i + 1}] ${render(item)}\n`);
      });
      const raw = (await rl.question("> ")).trim();
      const n = Number(raw);
      if (raw !== "" && Number.isInteger(n) && n >= 1 && n <= items.length) {
        return items[n - 1];
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        process.stderr.write(chalk.dim(`Please enter a number between 1 and ${items.length}.\n`));
      }
    }
    throw onGiveUp;
  } finally {
    rl.close();
  }
}
