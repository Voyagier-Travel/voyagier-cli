import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, chmodSync, rmSync } from "fs";
import { join } from "path";
import { trackCommand, telemetryErrorCode, setTelemetryEnabled, flushTelemetry, __resetPendingSends } from "./telemetry.js";
import { CONFIG_DIR } from "./config.js";
import { CliError, CliErrorCode } from "./errors.js";

// telemetry.js is NOT mocked — it writes to the sandboxed VOYAGIER_CONFIG_DIR
// set by test/setup-env.ts. As with config.spec.ts, we back up and restore any
// telemetry.json the suite touches so a crashed run can never clobber a real
// ~/.voyagier/telemetry.json.
const TELEMETRY_FILE = join(CONFIG_DIR, "telemetry.json");

describe("telemetry", () => {
  let originalTelemetry: string | null = null;
  const originalDdKey = process.env.DD_API_KEY;

  beforeEach(() => {
    originalTelemetry = existsSync(TELEMETRY_FILE) ? readFileSync(TELEMETRY_FILE, "utf-8") : null;
    if (existsSync(TELEMETRY_FILE)) unlinkSync(TELEMETRY_FILE);
    delete process.env.DD_API_KEY;
  });

  afterEach(() => {
    // Keep the sandbox dir intact (one test removes it to exercise mkdir), then
    // restore whatever telemetry.json was there before.
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (existsSync(TELEMETRY_FILE)) unlinkSync(TELEMETRY_FILE);
    if (originalTelemetry !== null) writeFileSync(TELEMETRY_FILE, originalTelemetry, { mode: 0o600 });
    if (originalDdKey === undefined) delete process.env.DD_API_KEY;
    else process.env.DD_API_KEY = originalDdKey;
    jest.restoreAllMocks();
  });

  describe("telemetryErrorCode", () => {
    it("returns the CliError.code for a CliError", () => {
      expect(telemetryErrorCode(new CliError(CliErrorCode.VALIDATION, "bad input"))).toBe("VALIDATION");
      expect(telemetryErrorCode(new CliError(CliErrorCode.AUTH_FAILED, "nope"))).toBe("AUTH_FAILED");
    });

    it("returns the constructor name for an unexpected error", () => {
      expect(telemetryErrorCode(new TypeError("x is not a function"))).toBe("TypeError");
      expect(telemetryErrorCode(new RangeError("out of range"))).toBe("RangeError");
      expect(telemetryErrorCode(new Error("boom"))).toBe("Error");
    });

    it("returns a generic label for non-Error throwables", () => {
      expect(telemetryErrorCode("just a string")).toBe("Error");
      expect(telemetryErrorCode(undefined)).toBe("Error");
    });

    it("never leaks the raw error message", () => {
      const err = new CliError(CliErrorCode.VALIDATION, "user ada@voyagier.com plan 'Honeymoon in Bali'");
      const code = telemetryErrorCode(err);
      expect(code).toBe("VALIDATION");
      expect(code).not.toMatch(/ada@voyagier\.com/);
      expect(code).not.toMatch(/Bali/);
    });
  });

  describe("command event privacy (M1)", () => {
    function sentLogEntry(fetchSpy: jest.SpiedFunction<typeof fetch>): Record<string, unknown> {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = (fetchSpy.mock.calls[0][1] as { body: string }).body;
      return (JSON.parse(body) as Record<string, unknown>[])[0];
    }

    it("posts an event with NO hostname, NO user_id, and NO raw error field", () => {
      process.env.DD_API_KEY = "dd-test-key";
      setTelemetryEnabled(true);
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(null, { status: 202 }));

      trackCommand({
        command: "plan-trip",
        subcommand: "create",
        durationMs: 42,
        success: false,
        errorCode: "VALIDATION",
        traceId: "abc123",
      });

      const entry = sentLogEntry(fetchSpy);
      expect(entry).not.toHaveProperty("hostname");
      expect(entry).not.toHaveProperty("user_id");
      expect(entry).not.toHaveProperty("error"); // raw error message field is gone
      // Only the non-identifying code survives.
      expect(entry.error_code).toBe("VALIDATION");

      // Belt-and-braces: the serialized payload mentions neither field name.
      const raw = (fetchSpy.mock.calls[0][1] as { body: string }).body;
      expect(raw).not.toMatch(/"hostname"/);
      expect(raw).not.toMatch(/"user_id"/);
      expect(raw).not.toMatch(/"error"\s*:/);
    });

    it("omits error_code on a successful event", () => {
      process.env.DD_API_KEY = "dd-test-key";
      setTelemetryEnabled(true);
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(null, { status: 202 }));

      trackCommand({ command: "search", durationMs: 10, success: true, traceId: "t" });

      const entry = sentLogEntry(fetchSpy);
      expect(entry.success).toBe(true);
      expect(entry.error_code).toBeUndefined();
    });

    it("does not post anything when telemetry is disabled", () => {
      process.env.DD_API_KEY = "dd-test-key";
      setTelemetryEnabled(false);
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(null, { status: 202 }));

      trackCommand({ command: "search", durationMs: 10, success: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("flushTelemetry (VOY-1765)", () => {
    // Each test drives the module-level pending-sends set; a never-settling
    // mock from one test must not leak into the next.
    beforeEach(() => {
      __resetPendingSends();
    });

    it("resolves immediately when no sends are pending", async () => {
      // No telemetry fired → nothing to drain.
      await expect(flushTelemetry()).resolves.toBeUndefined();
    });

    it("resolves within the timeout even if a send never settles", async () => {
      process.env.DD_API_KEY = "dd-test-key";
      setTelemetryEnabled(true);
      // A fetch that never resolves — mirrors a socket that hangs on exit.
      jest.spyOn(global, "fetch").mockImplementation(() => new Promise<Response>(() => {}));

      trackCommand({ command: "search", durationMs: 10, success: true, traceId: "t" });

      const start = Date.now();
      // Cap well below the 3s AbortSignal so the test stays fast; the point is
      // that flushTelemetry returns on the cap rather than waiting forever.
      await expect(flushTelemetry(50)).resolves.toBeUndefined();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // waited ~the cap
      expect(elapsed).toBeLessThan(1500); // but nowhere near forever
    });

    it("resolves once a pending send settles before the timeout", async () => {
      process.env.DD_API_KEY = "dd-test-key";
      setTelemetryEnabled(true);
      jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

      trackCommand({ command: "search", durationMs: 10, success: true, traceId: "t" });

      // Generous cap; the send resolves fast, so flush should return well under it.
      const start = Date.now();
      await expect(flushTelemetry(2000)).resolves.toBeUndefined();
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it("never rejects even when the underlying send rejects", async () => {
      process.env.DD_API_KEY = "dd-test-key";
      setTelemetryEnabled(true);
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

      trackCommand({ command: "search", durationMs: 10, success: false, traceId: "t" });

      await expect(flushTelemetry(500)).resolves.toBeUndefined();
    });
  });

  describe("on-disk permissions (L1/L2)", () => {
    it("writes telemetry.json with 0600 perms", () => {
      setTelemetryEnabled(true);
      expect(statSync(TELEMETRY_FILE).mode & 0o777).toBe(0o600);
    });

    it("corrects a pre-existing loose-perm (0644) telemetry.json to 0600", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(TELEMETRY_FILE, "{}", { mode: 0o644 });
      chmodSync(TELEMETRY_FILE, 0o644); // defeat umask so the pre-state is truly 0644
      expect(statSync(TELEMETRY_FILE).mode & 0o777).toBe(0o644);

      setTelemetryEnabled(true);
      expect(statSync(TELEMETRY_FILE).mode & 0o777).toBe(0o600);
    });

    it("creates CONFIG_DIR with 0700 perms", () => {
      // Remove the dir so the mkdir-with-mode path actually runs.
      rmSync(CONFIG_DIR, { recursive: true, force: true });
      setTelemetryEnabled(true);
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
    });
  });
});
