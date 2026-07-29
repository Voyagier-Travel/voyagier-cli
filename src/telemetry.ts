import { randomUUID, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./config.js";
import { CliError } from "./errors.js";

const TELEMETRY_FILE = join(CONFIG_DIR, "telemetry.json");

interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
}

interface CommandEvent {
  command: string;
  subcommand?: string;
  durationMs: number;
  success: boolean;
  /**
   * M1 (privacy): a stable, non-identifying failure label — a CliError.code
   * (e.g. "VALIDATION") or, for unexpected errors, the error constructor name
   * (e.g. "TypeError"). NEVER the raw error message: those routinely embed
   * emails, plan titles, and other PII.
   */
  errorCode?: string;
  traceId?: string;
}

// ── Trace ID (propagated to API for correlation) ──

let _traceId: string | null = null;

export function getTraceId(): string {
  if (!_traceId) {
    // Generate a 64-bit hex trace ID compatible with Datadog
    _traceId = randomBytes(8).toString("hex");
  }
  return _traceId;
}

// ── Opt-in config ──

function loadTelemetryConfig(): TelemetryConfig {
  if (!existsSync(TELEMETRY_FILE)) {
    return { enabled: false, anonymousId: randomUUID() };
  }
  try {
    const raw = readFileSync(TELEMETRY_FILE, "utf-8");
    return JSON.parse(raw) as TelemetryConfig;
  } catch {
    return { enabled: false, anonymousId: randomUUID() };
  }
}

function saveTelemetryConfig(config: TelemetryConfig): void {
  // 0o700 dir + 0o600 file, chmod after write to correct pre-existing loose
  // perms (L1/L2).
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700); // L1: correct a pre-existing loose-perm dir
  writeFileSync(TELEMETRY_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(TELEMETRY_FILE, 0o600);
}

export function isTelemetryEnabled(): boolean {
  // Env override: DD_API_KEY must be set, and telemetry must be opted in
  if (!process.env.DD_API_KEY) return false;
  const config = loadTelemetryConfig();
  return config.enabled;
}

export function setTelemetryEnabled(enabled: boolean): void {
  const config = loadTelemetryConfig();
  config.enabled = enabled;
  if (!config.anonymousId) config.anonymousId = randomUUID();
  saveTelemetryConfig(config);
}

export function getTelemetryStatus(): { enabled: boolean; hasApiKey: boolean } {
  const config = loadTelemetryConfig();
  return {
    enabled: config.enabled,
    hasApiKey: !!process.env.DD_API_KEY,
  };
}

// ── In-flight telemetry sends (VOY-1765) ──
// Every telemetry send is fire-and-forget; on a failing command the CLI then
// hard-exits microseconds later. On Windows, exiting while the pending fetch's
// libuv async handle is still live trips an assertion (src\win\async.c:76). We
// track each in-flight send here so gracefulExit() (via flushTelemetry) can
// drain them before process.exit.
const pendingSends = new Set<Promise<unknown>>();

/** Test-only: forget any tracked in-flight sends (e.g. never-settling mocks). */
export function __resetPendingSends(): void {
  pendingSends.clear();
}

/**
 * Drain in-flight telemetry sends before the process exits (VOY-1765).
 *
 * Awaits settlement of every pending send, capped at `timeoutMs` so telemetry
 * can never stall the exit. Resolves immediately when nothing is in flight.
 * Never throws — telemetry must never break the CLI.
 */
export async function flushTelemetry(timeoutMs = 250): Promise<void> {
  if (pendingSends.size === 0) return;
  const drained = Promise.allSettled([...pendingSends]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.(); // never hold the loop open just for the flush cap
  });
  try {
    await Promise.race([drained, capped]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Track command ──

export function trackCommand(event: CommandEvent): void {
  if (!isTelemetryEnabled()) return;

  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;

  const config = loadTelemetryConfig();

  // M1 (privacy): NO hostname (often a person's name), NO user_id, NO raw error
  // message (embeds PII). Only a non-identifying error CODE is included on
  // failure. This keeps the "No personal data" claim TRUE.
  const logEntry = {
    ddsource: "voyagier-cli",
    ddtags: `command:${event.command}${event.subcommand ? `,subcommand:${event.subcommand}` : ""},env:${process.env.VOYAGIER_ENV ?? "production"},success:${event.success}`,
    service: "voyagier-cli",
    message: `${event.command}${event.subcommand ? ` ${event.subcommand}` : ""} ${event.success ? "✓" : "✗"} (${event.durationMs}ms)`,
    command: event.command,
    subcommand: event.subcommand,
    duration_ms: event.durationMs,
    success: event.success,
    error_code: event.errorCode,
    anonymous_id: config.anonymousId,
    trace_id: event.traceId ?? getTraceId(),
    cli_version: getCLIVersion(),
  };

  // Fire and forget — non-blocking, never fails the command. The send is
  // tracked in `pendingSends` (settled or not) so gracefulExit() can drain it
  // before a hard process.exit (VOY-1765).
  const send = fetch("https://http-intake.logs.datadoghq.com/api/v2/logs", {
    method: "POST",
    headers: {
      "DD-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([logEntry]),
    signal: AbortSignal.timeout(3000), // Don't hang CLI for telemetry
  }).then(
    () => undefined,
    () => {
      // Silently ignore — telemetry should never break CLI
    },
  );
  pendingSends.add(send);
  void send.finally(() => {
    pendingSends.delete(send);
  });
}

// ── Helpers ──

let _cliVersion: string | null = null;

function getCLIVersion(): string {
  if (_cliVersion) return _cliVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
    _cliVersion = pkg.version;
  } catch {
    _cliVersion = "unknown";
  }
  return _cliVersion;
}

// ── Command wrapper for easy instrumentation ──

export function withTelemetry(
  command: string,
  subcommand: string | undefined,
  fn: () => Promise<void>
): () => Promise<void> {
  return async () => {
    const start = Date.now();
    const traceId = getTraceId();
    try {
      await fn();
      trackCommand({
        command,
        subcommand,
        durationMs: Date.now() - start,
        success: true,
        traceId,
      });
    } catch (err) {
      trackCommand({
        command,
        subcommand,
        durationMs: Date.now() - start,
        success: false,
        errorCode: telemetryErrorCode(err),
        traceId,
      });
      throw err;
    }
  };
}

/**
 * M1 (privacy): derive a non-identifying failure label for telemetry.
 * A CliError contributes its `code` (e.g. "VALIDATION"); any other error
 * contributes only its constructor name (e.g. "TypeError"). The error message
 * — which routinely embeds emails, plan titles, and other PII — is NEVER sent.
 */
export function telemetryErrorCode(err: unknown): string {
  if (err instanceof CliError) return err.code;
  if (err instanceof Error) return err.constructor?.name ?? err.name ?? "Error";
  return "Error";
}
