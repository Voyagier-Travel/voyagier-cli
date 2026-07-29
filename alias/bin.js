#!/usr/bin/env node
// Convenience alias: `npm install -g voyagier` / `npx voyagier`.
// The canonical package is @voyagier/cli — this delegates to whatever that
// package publishes as its `voyagier` bin entry (resolved dynamically so a
// future change to the canonical build output location can't break the alias).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("@voyagier/cli/package.json");
const pkg = require(pkgPath);
const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.voyagier;
if (!binRel) {
  console.error("voyagier alias: @voyagier/cli does not declare a 'voyagier' bin entry.");
  process.exit(1);
}
await import(pathToFileURL(join(dirname(pkgPath), binRel)).href);
