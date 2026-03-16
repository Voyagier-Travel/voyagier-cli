import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { graphql, streamChat } from "../api.js";
import { CliError, CliErrorCode } from "../errors.js";

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
    .option("-m, --message <text>", "Send a single message non-interactively")
    .action(async (opts: { session?: string; plan?: string; list?: boolean; message?: string }) => {
      if (opts.list) {
        await listSessions();
        return;
      }

      // Determine if we're in non-interactive mode
      let nonInteractiveMessage = opts.message;
      if (!nonInteractiveMessage && !process.stdin.isTTY) {
        nonInteractiveMessage = await readStdin();
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
          if (!nonInteractiveMessage) {
            console.log(chalk.dim(`New session: ${sessionId}`));
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
          throw new CliError(CliErrorCode.API_ERROR, `Failed to create session: ${err}`);
        }
      }

      if (nonInteractiveMessage) {
        await chatSingleTurn(sessionId, nonInteractiveMessage);
        return;
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
    process.stderr.write(chalk.red(`Failed to list sessions: ${err}\n`));
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
  });
}

async function chatSingleTurn(sessionId: string, message: string): Promise<void> {
  try {
    await streamChat(sessionId, message, {
      onTextDelta(text) {
        process.stdout.write(text);
      },
      onToolCall(toolName) {
        process.stderr.write(`[${toolName}]\n`);
      },
      onError(errorText) {
        process.stderr.write(`Error: ${errorText}\n`);
      },
    });
    process.stdout.write("\n");
    process.exit(0);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(CliErrorCode.API_ERROR, `Error: ${err}`);
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
      process.stderr.write(chalk.red(`\nError: ${err}\n`));
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
  if (toolName.includes("createTripPlan") || toolName.includes("create_trip_plan")) {
    return data.title ? `plan created: ${data.title}` : "plan created";
  }
  if (toolName.includes("Traveller") || toolName.includes("traveller")) {
    if (Array.isArray(data.travellers)) return `${data.travellers.length} travellers`;
    if (data.firstName) return `added ${data.firstName} ${data.lastName ?? ""}`.trim();
    return "traveller updated";
  }
  return null;
}
