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
  const root = mkdtempSync(join(tmpdir(), "voyagier-test-"));
  process.env.VOYAGIER_CONFIG_DIR = root;
  // Teardown deletes THIS, not VOYAGIER_CONFIG_DIR: in --runInBand the tests
  // share our process and setup-env.ts repoints VOYAGIER_CONFIG_DIR at a
  // worker-<id> subdir — deleting that would leave the parent behind.
  process.env.VOYAGIER_TEST_SANDBOX_ROOT = root;
}
