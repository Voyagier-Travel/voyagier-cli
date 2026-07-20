/**
 * Jest globalTeardown — removes the per-run config sandbox minted by
 * test/global-setup.ts. Only deletes paths we minted (prefix check), never
 * an ambient VOYAGIER_CONFIG_DIR.
 */
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export default function globalTeardown(): void {
  const dir = process.env.VOYAGIER_CONFIG_DIR;
  if (dir?.startsWith(join(tmpdir(), "voyagier-test-"))) {
    rmSync(dir, { recursive: true, force: true });
  }
}
