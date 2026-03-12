import { randomUUID, randomBytes } from "crypto";
import { hostname } from "os";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR, getUserContext } from "./config.js";

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
  error?: string;
  userId?: string;
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
  writeFileSync(TELEMETRY_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
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

// ── Track command ──

export function trackCommand(event: CommandEvent): void {
  if (!isTelemetryEnabled()) return;

  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;

  const config = loadTelemetryConfig();
  const user = getUserContext();

  const logEntry = {
    ddsource: "voyagier-cli",
    ddtags: `command:${event.command}${event.subcommand ? `,subcommand:${event.subcommand}` : ""},env:${process.env.VOYAGIER_ENV ?? "production"},success:${event.success}`,
    hostname: hostname(),
    service: "voyagier-cli",
    message: `${event.command}${event.subcommand ? ` ${event.subcommand}` : ""} ${event.success ? "✓" : "✗"} (${event.durationMs}ms)`,
    command: event.command,
    subcommand: event.subcommand,
    duration_ms: event.durationMs,
    success: event.success,
    error: event.error,
    user_id: user?.id ?? undefined,
    anonymous_id: config.anonymousId,
    trace_id: event.traceId ?? getTraceId(),
    cli_version: getCLIVersion(),
  };

  // Fire and forget — non-blocking, never fails the command
  fetch("https://http-intake.logs.datadoghq.com/api/v2/logs", {
    method: "POST",
    headers: {
      "DD-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([logEntry]),
    signal: AbortSignal.timeout(3000), // Don't hang CLI for telemetry
  }).catch(() => {
    // Silently ignore — telemetry should never break CLI
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
      const message = err instanceof Error ? err.message : String(err);
      trackCommand({
        command,
        subcommand,
        durationMs: Date.now() - start,
        success: false,
        error: message,
        traceId,
      });
      throw err;
    }
  };
}
