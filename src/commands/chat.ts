import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { graphql, streamChat } from "../api.js";

const CREATE_SESSION = `
  mutation CreateChatSession($input: CreateSessionInput) {
    createChatSession(input: $input) {
      id
      title
    }
  }
`;

const LIST_SESSIONS = `
  query ChatSessions($page: Int, $limit: Int) {
    chatSessions(page: $page, limit: $limit) {
      items {
        id
        title
        updatedAt
      }
      count
      page
    }
  }
`;

export function registerChatCommands(program: Command): void {
  program
    .command("chat")
    .description("Interactive AI trip planning chat")
    .option("-s, --session <id>", "Resume an existing session")
    .option("-p, --plan <id>", "Chat about a specific trip plan")
    .option("-l, --list", "List existing sessions")
    .action(async (opts: { session?: string; plan?: string; list?: boolean }) => {
      if (opts.list) {
        await listSessions();
        return;
      }

      let sessionId = opts.session;

      if (!sessionId) {
        try {
          const input = opts.plan ? { tripPlanId: opts.plan } : undefined;
          const data = await graphql<{ createChatSession: { id: string; title: string } }>(
            CREATE_SESSION,
            input ? { input } : undefined
          );
          sessionId = data.createChatSession.id;
          console.log(chalk.dim(`New session: ${sessionId}`));
        } catch (err) {
          console.error(chalk.red(`Failed to create session: ${err}`));
          process.exit(1);
        }
      }

      console.log(chalk.blue.bold("Voyagier AI Trip Planner"));
      console.log(chalk.dim("Type your message and press Enter. Ctrl+C to exit.\n"));

      await chatRepl(sessionId);
    });
}

async function listSessions(): Promise<void> {
  try {
    const data = await graphql<{
      chatSessions: {
        items: Array<{ id: string; title: string; updatedAt: string }>;
        count: number;
      };
    }>(LIST_SESSIONS, { page: 1, limit: 20 });

    const sessions = data.chatSessions.items;
    if (sessions.length === 0) {
      console.log(chalk.dim("No chat sessions found."));
      return;
    }

    console.log(chalk.bold(`Chat Sessions (${data.chatSessions.count} total):\n`));
    for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleDateString();
      console.log(`  ${chalk.cyan(s.id.slice(0, 8))}  ${s.title || "(untitled)"}  ${chalk.dim(date)}`);
    }
    console.log(chalk.dim(`\nResume with: voyagier chat --session <id>`));
  } catch (err) {
    console.error(chalk.red(`Failed to list sessions: ${err}`));
  }
}

async function chatRepl(sessionId: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green("you › "),
  });

  rl.prompt();

  rl.on("line", async (input) => {
    const message = input.trim();
    if (!message) {
      rl.prompt();
      return;
    }

    process.stdout.write(chalk.blue("ai › "));

    try {
      await streamChat(sessionId, message, {
        onTextDelta(text) {
          process.stdout.write(text);
        },
        onToolCall(toolName) {
          process.stdout.write(chalk.dim(`\n  [calling ${toolName}...]`));
        },
        onToolResult(toolName, result) {
          // Show a condensed summary of tool results inline
          try {
            const data = typeof result === "string" ? JSON.parse(result) : result;
            const summary = summarizeToolResult(toolName, data);
            if (summary) {
              process.stdout.write(chalk.dim(`\n  [${summary}]`));
            }
          } catch {
            // Skip formatting errors
          }
        },
        onError(errorText) {
          process.stdout.write(chalk.red(`\n  Error: ${errorText}`));
        },
      });
      process.stdout.write("\n\n");
    } catch (err) {
      console.error(chalk.red(`\nError: ${err}`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log(chalk.dim("\nSession ended."));
    process.exit(0);
  });
}

function summarizeToolResult(toolName: string, data: Record<string, unknown>): string | null {
  if (toolName.includes("flight") && Array.isArray(data.options)) {
    return `${data.options.length} flight options found`;
  }
  if (toolName.includes("hotel") && Array.isArray(data.options)) {
    return `${data.options.length} hotel options found`;
  }
  if (toolName === "voyagier_plan_trip") {
    const parts: string[] = [];
    if (data.tripPlanId) parts.push("plan created");
    const flights = data.flights as unknown[] | undefined;
    const hotels = data.hotels as unknown[] | undefined;
    if (Array.isArray(flights) && flights.length > 0) parts.push(`${flights.length} flights`);
    if (Array.isArray(hotels) && hotels.length > 0) parts.push(`${hotels.length} hotels`);
    return parts.join(", ") || null;
  }
  if (toolName.includes("traveller") && Array.isArray(data.travellers)) {
    return `${data.travellers.length} travellers`;
  }
  return null;
}
