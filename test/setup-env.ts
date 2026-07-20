/**
 * Jest bootstrap (setupFiles — runs BEFORE any module is imported).
 *
 * Points VOYAGIER_CONFIG_DIR at a per-run temp dir so no spec can ever read
 * or destroy the real ~/.voyagier (credentials.json, last-search.json).
 * Before this existed, a crashed test run deleted a live PAT — specs used the
 * real CONFIG_DIR. Do NOT remove; do NOT set VOYAGIER_CONFIG_DIR to a real
 * home path in tests.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.VOYAGIER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "voyagier-test-"));
// Belt and braces: no spec should ever hit real telemetry or inherit ambient auth.
delete process.env.DD_API_KEY; // telemetry is gated on this
delete process.env.VOYAGIER_TOKEN;
delete process.env.VOYAGIER_API_URL;
