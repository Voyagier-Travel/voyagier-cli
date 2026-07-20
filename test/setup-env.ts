/**
 * Jest bootstrap (setupFiles — runs in each worker BEFORE any module is
 * imported).
 *
 * Guarantees VOYAGIER_CONFIG_DIR points at a throwaway sandbox so no spec can
 * ever read or destroy the real ~/.voyagier (credentials.json,
 * last-search.json). Before this existed, a crashed test run deleted a live
 * PAT — specs used the real CONFIG_DIR. Do NOT remove; do NOT set
 * VOYAGIER_CONFIG_DIR to a real home path in tests.
 *
 * The sandbox is normally minted once per run by test/global-setup.ts
 * (workers inherit it via env) and removed by test/global-teardown.ts. The
 * fallback mint below only fires if globalSetup was bypassed — the prefix
 * check ensures an ambient VOYAGIER_CONFIG_DIR from the caller's shell never
 * leaks into tests.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sandboxPrefix = join(tmpdir(), "voyagier-test-");
if (!process.env.VOYAGIER_CONFIG_DIR?.startsWith(sandboxPrefix)) {
  process.env.VOYAGIER_CONFIG_DIR = mkdtempSync(sandboxPrefix);
}
// Belt and braces: no spec should ever hit real telemetry or inherit ambient auth.
delete process.env.DD_API_KEY; // telemetry is gated on this
delete process.env.VOYAGIER_TOKEN;
delete process.env.VOYAGIER_API_URL;
