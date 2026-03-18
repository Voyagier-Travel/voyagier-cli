import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { jsonOutput } from "../output.js";

const FALLBACK = [
  "# Voyagier CLI — Agent Quick Start",
  "",
  "Two commands to book a trip:",
  "",
  "  voyagier plan-trip --title \"Trip\" --from DCA --to Paris \\",
  "    --depart <YYYY-MM-DD> --return <YYYY-MM-DD> \\",
  "    --travellers \"John Doe\" --auto-select navigator --json",
  "",
  "  voyagier book <PLAN_ID> --json",
  "",
  "Full docs: https://github.com/Voyagier-Travel/voyagier-cli#agent-reference",
  "",
].join("\n");

export function resolveAgentMdPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, "..", "..", "AGENT.md");
}

export function loadAgentDocs(): { content: string; fromFallback: boolean } {
  try {
    const content = readFileSync(resolveAgentMdPath(), "utf-8");
    return { content, fromFallback: false };
  } catch {
    return { content: FALLBACK, fromFallback: true };
  }
}

export function registerAgentDocsCommand(program: Command): void {
  program
    .command("agent-docs")
    .description("Print the agent reference guide (AGENT.md) for AI/automation integration")
    .option("--json", "Output as JSON with content field")
    .action((opts) => {
      const { content, fromFallback } = loadAgentDocs();

      if (opts.json) {
        jsonOutput({
          content,
          format: "markdown",
          ...(fromFallback ? { note: "AGENT.md not found, showing fallback" } : {}),
        });
      } else {
        process.stdout.write(content);
      }
    });
}
