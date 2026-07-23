/**
 * Child-spawn seam for the MCP server (`voyagier mcp`).
 *
 * The MCP server is a THIN adapter: every tool handler self-spawns the CLI as a
 * subprocess (`node <cliEntry> <args...> --json`), captures stdout, and returns
 * it as the tool result — normalised through `toToolResult` into one canonical
 * `{ok,data}` / `{ok:false,error}` envelope. The CLI's own `--json` agent
 * surface IS the contract — stable payloads, uniform error codes, price gates —
 * so calling it as a subprocess guarantees zero behaviour drift and full
 * process isolation; the MCP layer only reshapes the outermost wrapper.
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
 * The promise resolves only once execFile's callback fires — i.e. when the
 * child actually exits and its stdio closes. SIGKILL makes that near-certain
 * shortly after timeoutMs + grace, but it is not a hard upper bound: a child
 * that can't be reaped (e.g. stuck in uninterruptible I/O) keeps the promise
 * pending until the OS releases it. On timeout the result carries a synthetic
 * `{error:true, code:"TIMEOUT"}` envelope on stdout with a non-zero exit code.
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

/** The canonical MCP success envelope: normalised across BOTH CLI payload styles. */
export interface OkEnvelope {
  ok: true;
  data: unknown;
  planContext?: unknown;
}

/** The canonical MCP failure envelope. */
export interface ErrEnvelope {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * Parse a string as JSON, returning it only when it is a non-null object
 * (arrays included — they carry no `ok`/`error`/`data` keys, so they flow to
 * the lossless wrap). Scalars (`123`, `"x"`, `true`) and unparseable text
 * return `undefined` so the caller falls through to the non-JSON branch.
 */
function tryParseObject(text: string): Record<string, unknown> | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * Normalise a raw child result into ONE canonical MCP envelope. The CLI ships
 * two payload styles (Style A wrapped `{ok,data,planContext}`, Style B flat
 * domain shapes); this seam is the single place that collapses them so every
 * MCP tool result looks the same to a client. The CLI surface is untouched.
 *
 * Rules (content-driven for JSON; exit-code-driven only for non-JSON):
 *  - JSON object stdout:
 *      · CLI error envelope (`error === true`, incl. the synthetic TIMEOUT from
 *        runCli) → `{ok:false, error:{code, message, details?}}`, isError:true.
 *      · Already canonical (`ok === true` AND a `data` key, i.e. Style A) →
 *        passed through field-for-field (planContext preserved).
 *      · Style A with `ok:false` (doctor's overall-FAIL report — the CLI's only
 *        non-true `ok` emitter) → folded into the SINGLE failure shape:
 *        `{ok:false, error:{code:"COMMAND_FAILED", message, details:<report>}}`,
 *        isError:true. The full report survives lossless in error.details; a
 *        failed doctor never reads as success and clients only ever see one
 *        failure envelope.
 *      · Any other object (Style B flat, incl. select's flat-with-`ok`) →
 *        wrapped LOSSLESS as `{ok:true, data:<parsed>}` — inner fields
 *        untouched. A top-level `planContext` (select emits one via
 *        jsonOutputWithPlan) is ALSO hoisted to the envelope top level so its
 *        location is consistent with the documented contract; the copy inside
 *        `data` stays (losslessness wins over de-duplication).
 *  - Non-JSON stdout:
 *      · exit 0 → `{ok:true, data:{content:<raw stdout>}}` (covers agent_docs
 *        markdown, the one tool that runs without `--json`).
 *      · exit ≠ 0 → `{ok:false, error:{code:"UNKNOWN", message:<stdout | stderr
 *        | "command failed">}}`, isError:true.
 *
 * isError is true exactly when the envelope is `ok:false`. Output text is a
 * COMPACT `JSON.stringify` of the envelope (no pretty-print).
 */
export function toToolResult(result: CliResult): ToolResultPayload {
  const { stdout, stderr, exitCode } = result;
  const trimmed = stdout.trim();

  const parsed = tryParseObject(trimmed);
  if (parsed) {
    // CLI error envelope → canonical failure.
    if (parsed.error === true) {
      const error: ErrEnvelope["error"] = {
        code: typeof parsed.code === "string" ? parsed.code : "UNKNOWN",
        message: typeof parsed.message === "string" ? parsed.message : "command failed",
      };
      if (parsed.details !== undefined) error.details = parsed.details;
      return { text: JSON.stringify({ ok: false, error }), isError: true };
    }

    // Already canonical Style A → pass through field-for-field.
    if (parsed.ok === true && "data" in parsed) {
      return { text: JSON.stringify(parsed), isError: false };
    }

    // Style A with ok:false (doctor's overall-FAIL report is the only CLI
    // emitter) → fold into the one canonical failure shape. The report stays
    // lossless under error.details; clients never see a second failure shape.
    if (parsed.ok === false && "data" in parsed) {
      return {
        text: JSON.stringify({
          ok: false,
          error: { code: "COMMAND_FAILED", message: "Command reported failure.", details: parsed.data },
        }),
        isError: true,
      };
    }

    // Any other object (Style B flat) → lossless wrap. Hoist a top-level
    // planContext when the CLI emitted one so clients find it in the
    // documented envelope position regardless of the source style.
    const envelope: OkEnvelope = { ok: true, data: parsed };
    if (!Array.isArray(parsed) && parsed.planContext !== undefined) envelope.planContext = parsed.planContext;
    return { text: JSON.stringify(envelope), isError: false };
  }

  // Non-JSON stdout. On success, fall back to stderr when stdout is empty —
  // some child failures-of-convention emit diagnostics there, and an empty
  // content envelope would discard them.
  if (exitCode === 0) {
    const content = trimmed.length > 0 ? stdout : stderr;
    return { text: JSON.stringify({ ok: true, data: { content } }), isError: false };
  }
  const stderrTrimmed = stderr.trim();
  const message = trimmed.length > 0 ? trimmed : stderrTrimmed.length > 0 ? stderrTrimmed : "command failed";
  const error: ErrEnvelope["error"] = { code: "UNKNOWN", message };
  // Keep stderr for diagnostics when it isn't already the message.
  if (stderrTrimmed.length > 0 && message !== stderrTrimmed) error.details = { stderr: stderrTrimmed };
  return { text: JSON.stringify({ ok: false, error }), isError: true };
}
