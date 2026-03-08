import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { graphql, streamChat } from "../api.js";

const CREATE_SESSION = `
  mutation CreateChatSession {
    createChatSession {
      id
      title
    }
  }
`;

const LIST_SESSIONS = `
  query ChatSessions {
    chatSessions {
      id
      title
      updatedAt
    }
  }
`;

export function registerChatCommands(program: Command): void {
  program
    .command("chat")
    .description("Interactive AI trip planning chat")
    .option("-s, --session <id>", "Resume an existing session")
    .option("-l, --list", "List existing sessions")
    .action(async (opts: { session?: string; list?: boolean }) => {
      if (opts.list) {
        await listSessions();
        return;
      }

      let sessionId = opts.session;

      if (!sessionId) {
        // Create new session
        try {
          const data = await graphql<{ createChatSession: { id: string; title: string } }>(
            CREATE_SESSION
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
      chatSessions: Array<{ id: string; title: string; updatedAt: string }>;
    }>(LIST_SESSIONS);

    const sessions = data.chatSessions;
    if (sessions.length === 0) {
      console.log(chalk.dim("No chat sessions found."));
      return;
    }

    console.log(chalk.bold("Chat Sessions:\n"));
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
      await streamChat(sessionId, message, (text) => {
        process.stdout.write(text);
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
