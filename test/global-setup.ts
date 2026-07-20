/**
 * Jest globalSetup — runs ONCE in the parent process before workers spawn.
 *
 * Mints a single per-run sandbox for VOYAGIER_CONFIG_DIR; workers inherit it
 * via process.env. Removed by test/global-teardown.ts. See test/setup-env.ts
 * for why this exists (protecting the real ~/.voyagier).
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export default function globalSetup(): void {
  process.env.VOYAGIER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "voyagier-test-"));
}
