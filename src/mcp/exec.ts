/**
 * Child-spawn seam for the MCP server (`voyagier mcp`).
 *
 * The MCP server is a THIN adapter: every tool handler self-spawns the CLI as a
 * subprocess (`node <cliEntry> <args...> --json`), captures stdout, and returns
 * it as the tool result. The CLI's own `--json` agent surface IS the contract —
 * stable envelopes, uniform error codes, price gates — so calling it as a
 * subprocess guarantees zero behaviour drift and full process isolation.
 *
 * Two exported seams:
 *   - `runCli`      — spawn + capture + bounded timeout (SIGTERM → SIGKILL grace).
 *   - `toToolResult`— normalise a raw {stdout,stderr,exitCode} into the MCP tool
 *                     result text + isError flag.
 *
 * `cliEntry`, `execPath`, and the spawn fn are all injectable (deps-object
 * pattern, cf. src/commands/select-wait.ts) so the seam is unit-testable
 * without spawning anything real.
 */
import { execFile, type ExecFileException } from "child_process";

/** Raw outcome of a child CLI invocation. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The MCP tool-result payload: content text + error flag. */
export interface ToolResultPayload {
  text: string;
  isError: boolean;
}

/**
 * Minimal injectable shape for `child_process.execFile` — deliberately narrower
 * than the (heavily overloaded) real signature so tests can supply a trivial
 * stub. Returns something with a `kill` method (a ChildProcess in production).
 */
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { maxBuffer: number; encoding: "utf8" },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => { kill: (signal?: NodeJS.Signals | number) => boolean };

export interface RunCliDeps {
  /** CLI entry script to spawn. Defaults to `process.argv[1]` (this CLI). */
  cliEntry?: string;
  /** Node executable. Defaults to `process.execPath`. */
  execPath?: string;
  /** Spawn fn. Defaults to `child_process.execFile`. */
  execFileFn?: ExecFileFn;
}

/** A real flight search can be multi-MB of raw bookingData; give headroom. */
const MAX_BUFFER = 32 * 1024 * 1024; // 32MB
/** Grace between SIGTERM and the guaranteed-fatal SIGKILL on timeout. */
const KILL_GRACE_MS = 5000;

/**
 * Spawn the CLI as a child process and capture its output.
 *
 * The child inherits `process.env` UNTOUCHED (execFile's default) — so
 * VOYAGIER_TOKEN / VOYAGIER_API_URL / VOYAGIER_CONFIG_DIR flow through and the
 * MCP layer never has to see, hold, or forward a token. The child is piped
 * (non-TTY), so the CLI's spinner/progress code stays silent-safe.
 *
 * Timeout: at `timeoutMs` we SIGTERM the child, then SIGKILL after a 5s grace.
 * The promise resolves only once the child actually exits (bounded by
 * timeoutMs + grace), surfacing a synthetic `{error:true, code:"TIMEOUT"}`
 * envelope on stdout with a non-zero exit code.
 */
export function runCli(
  args: string[],
  timeoutMs: number,
  deps: RunCliDeps = {},
): Promise<CliResult> {
  const execPath = deps.execPath ?? process.execPath;
  const cliEntry = deps.cliEntry ?? process.argv[1];
  const execFileFn = deps.execFileFn ?? (execFile as unknown as ExecFileFn);

  return new Promise<CliResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = execFileFn(
      execPath,
      [cliEntry, ...args],
      { maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (killTimer) clearTimeout(killTimer);
        if (timer) clearTimeout(timer);
        if (settled) return;
        settled = true;

        if (timedOut) {
          const message = `voyagier ${args.join(" ")} timed out after ${timeoutMs}ms`;
          resolve({
            stdout: JSON.stringify({ error: true, code: "TIMEOUT", message }),
            stderr: stderr ?? "",
            exitCode: 124,
          });
          return;
        }

        // execFile reports a non-zero exit via `error.code` (numeric). A spawn
        // failure (e.g. ENOENT) has a string code — treat as generic failure 1.
        let exitCode = 0;
        if (error) {
          const code = (error as ExecFileException).code;
          exitCode = typeof code === "number" ? code : 1;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );

    // Arm the timeout only if the child hasn't already exited synchronously
    // (an injected stub may fire its callback before we get here).
    if (!settled) {
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGTERM");
        // If the child ignores SIGTERM, force-kill after the grace period.
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_GRACE_MS);
      }, timeoutMs);
    }
  });
}

/**
 * Normalise a raw child result into the MCP tool-result payload.
 *
 * Rules:
 *  - Success (exit 0): pass stdout through VERBATIM. This covers both the
 *    CLI's JSON envelopes AND plain text (e.g. `agent-docs` markdown, the one
 *    tool that runs without `--json`). Falls back to stderr if stdout is empty.
 *  - Failure (exit ≠ 0) with a JSON body on stdout: pass the CLI's own error
 *    envelope through verbatim (uniform `{error,code,message,details?}`),
 *    isError = true.
 *  - Failure with NON-JSON / empty stdout (e.g. an unexpected exit-2 crash that
 *    put a stack on stderr): synthesise an API_ERROR envelope preserving the
 *    raw output so nothing is lost.
 */
export function toToolResult(result: CliResult): ToolResultPayload {
  const { stdout, stderr, exitCode } = result;
  const isError = exitCode !== 0;
  const trimmed = stdout.trim();

  if (!isError) {
    const text = trimmed.length > 0 ? stdout : stderr;
    return { text, isError: false };
  }

  // Error path — prefer the CLI's own JSON error envelope, verbatim.
  if (trimmed.length > 0) {
    try {
      JSON.parse(trimmed);
      return { text: stdout, isError: true };
    } catch {
      // Not JSON — fall through to synthetic wrap.
    }
  }

  const raw = [stdout, stderr]
    .map((s) => s.trimEnd())
    .filter((s) => s.trim().length > 0)
    .join("\n");
  const synthetic = {
    error: true,
    code: "API_ERROR",
    message: `voyagier CLI exited ${exitCode} without a JSON error envelope.`,
    details: { exitCode, raw },
  };
  return { text: JSON.stringify(synthetic, null, 2), isError: true };
}
