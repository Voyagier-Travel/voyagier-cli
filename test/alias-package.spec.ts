import { readFileSync } from "node:fs";
import { join } from "node:path";

// The voyagier alias (alias/) is the short npm name for @voyagier/cli. The
// publish workflow sets both to the same version; this spec keeps main in step.
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(process.cwd(), rel), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };

describe("voyagier alias package", () => {
  const root = readJson("package.json");
  const alias = readJson("alias/package.json");

  it("has the same version as @voyagier/cli", () => {
    expect(alias.version).toBe(root.version);
  });

  it("requires at least the matching @voyagier/cli release", () => {
    expect(alias.dependencies?.["@voyagier/cli"]).toBe(`^${root.version}`);
  });
});
