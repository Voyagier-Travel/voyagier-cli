/**
 * Jest globalTeardown — removes the per-run config sandbox minted by
 * test/global-setup.ts. Only deletes paths we minted (prefix check), never
 * an ambient VOYAGIER_CONFIG_DIR.
 */
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export default function globalTeardown(): void {
  // Prefer the run-sandbox ROOT recorded by global-setup: in --runInBand,
  // setup-env.ts repoints VOYAGIER_CONFIG_DIR at a worker-<id> subdir in this
  // same process, and deleting only the subdir would leak the parent.
  const dir = process.env.VOYAGIER_TEST_SANDBOX_ROOT ?? process.env.VOYAGIER_CONFIG_DIR;
  if (dir?.startsWith(join(tmpdir(), "voyagier-test-"))) {
    rmSync(dir, { recursive: true, force: true });
  }
}
