import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export function registerAgentDocsCommand(program: Command): void {
  program
    .command("agent-docs")
    .description("Print the agent reference guide (AGENT.md) for AI/automation integration")
    .option("--json", "Output as JSON with content field")
    .action((opts) => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const agentMdPath = join(__dirname, "..", "..", "AGENT.md");

      try {
        const content = readFileSync(agentMdPath, "utf-8");

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ content, format: "markdown" }) + "\n"
          );
        } else {
          process.stdout.write(content);
        }
      } catch {
        const fallback = [
          "# Voyagier CLI — Agent Quick Start",
          "",
          "Two commands to book a trip:",
          "",
          "  voyagier plan-trip --title \"Trip\" --from DCA --to Paris \\",
          "    --depart 2026-03-23 --return 2026-03-25 \\",
          "    --travellers \"John Doe\" --auto-select navigator --json",
          "",
          "  voyagier book <PLAN_ID> --json",
          "",
          "Full docs: https://github.com/Voyagier-Travel/voyagier-cli#agent-reference",
          "",
        ].join("\n");

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ content: fallback, format: "markdown", note: "AGENT.md not found, showing fallback" }) + "\n"
          );
        } else {
          process.stdout.write(fallback);
        }
      }
    });
}
