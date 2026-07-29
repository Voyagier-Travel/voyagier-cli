import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { fatal } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import {
  DELETE_COMMENT,
  CREATE_COMMENT,
  GET_COMMENTS,
  REMOVE_VOTE,
  CREATE_VOTE,
  UPDATE_VOTE,
} from "../../queries.js";
import { shellArg } from "../../utils.js";

export function registerSocialCommands(plans: Command): void {
  plans
    .command("comments <itemId>")
    .description("View or add comments on a trip plan item")
    .option("--add <text>", "Add a comment")
    .option("--reply-to <commentId>", "Reply to a comment (used with --add)")
    .option("--delete <commentId>", "Delete a comment")
    .option("--limit <n>", "Max comments", "20")
    .option("--json", "Output raw JSON")
    .action(async (itemId: string, opts) => {
      try {
        // Delete mode
        if (opts.delete) {
          await graphql<{ deleteTripPlanItemComment: boolean }>(
            DELETE_COMMENT,
            { id: opts.delete }
          );
          if (opts.json) {
            process.stdout.write(JSON.stringify({ success: true, deleted: opts.delete }, null, 2) + "\n");
          } else {
            console.log(chalk.green(`\n  ✓ Comment deleted\n`));
          }
          return;
        }

        // Add mode
        if (opts.add) {
          const input: Record<string, unknown> = { content: opts.add };
          if (opts.replyTo) input.parentCommentId = opts.replyTo;

          const data = await graphql<{ createTripPlanItemComment: { id: string; text: string } }>(
            CREATE_COMMENT,
            { itemId, input }
          );

          if (opts.json) {
            process.stdout.write(JSON.stringify(data.createTripPlanItemComment, null, 2) + "\n");
          } else {
            console.log(chalk.green(`\n  ✓ Comment added\n`));
          }
          return;
        }

        // List mode
        const limit = parseInt(opts.limit, 10);
        const data = await graphql<{
          tripPlanItemComments: {
            count: number;
            items: Array<{
              id: string;
              text: string;
              author: { id: string; firstName: string; lastName: string };
              parentCommentId?: string;
              replies?: Array<{ id: string; text: string; author: { firstName: string; lastName: string } }>;
            }>;
          };
        }>(
          GET_COMMENTS,
          { itemId, limit, page: 1 }
        );

        const comments = data.tripPlanItemComments.items;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ itemId, comments }, null, 2) + "\n");
          return;
        }

        if (comments.length === 0) {
          console.log(chalk.dim("\n  No comments yet.\n"));
          console.log(chalk.dim(`  Add one: voyagier plans comments ${shellArg(itemId)} --add "Looks great!"\n`));
          return;
        }

        console.log(chalk.bold(`\n  💬 Comments (${comments.length})\n`));
        for (const comment of comments) {
          const name = `${comment.author.firstName} ${comment.author.lastName}`.trim();
          console.log(`  ${chalk.cyan(name)}: ${comment.text}`);
          console.log(chalk.dim(`    ID: ${comment.id}`));
          if (comment.replies) {
            for (const reply of comment.replies) {
              const rName = `${reply.author.firstName} ${reply.author.lastName}`.trim();
              console.log(`    ↳ ${chalk.cyan(rName)}: ${reply.text}`);
            }
          }
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed: ${message}`);
      }
    });

  plans
    .command("vote <itemId>")
    .description("Upvote or downvote a trip plan item (or remove vote)")
    .option("--up", "Upvote")
    .option("--down", "Downvote")
    .option("--remove", "Remove your vote")
    .option("--json", "Output raw JSON")
    .action(async (itemId: string, opts) => {
      try {
        // Validate exactly one of --up, --down, --remove
        const flagCount = [opts.up, opts.down, opts.remove].filter(Boolean).length;
        if (flagCount > 1) {
          fatal("Specify exactly one of --up, --down, or --remove.");
        }

        if (opts.remove) {
          await graphql<{ deleteTripPlanItemFeedback: boolean }>(
            REMOVE_VOTE,
            { itemId }
          );
          if (opts.json) {
            process.stdout.write(JSON.stringify({ success: true, action: "removed" }, null, 2) + "\n");
          } else {
            console.log(chalk.green("\n  ✓ Vote removed\n"));
          }
          return;
        }

        if (!opts.up && !opts.down) {
          throw new CliError(CliErrorCode.VALIDATION, "Specify --up or --down (or --remove to clear vote).");
        }

        const feedbackType = opts.down ? "Downvote" : "Upvote";

        // Try create first (first vote), fall back to update (changing existing vote)
        try {
          await graphql<{ createTripPlanItemFeedback: unknown }>(
            CREATE_VOTE,
            { itemId, input: { feedbackType } }
          );
        } catch (createErr) {
          // Only fall back to update if it looks like an "already exists" error
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          if (msg.includes("already") || msg.includes("duplicate") || msg.includes("exists") || msg.includes("conflict")) {
            await graphql<{ updateTripPlanItemFeedback: unknown }>(
              UPDATE_VOTE,
              { itemId, feedbackType }
            );
          } else {
            throw createErr;
          }
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify({ success: true, action: feedbackType.toLowerCase(), itemId }, null, 2) + "\n");
        } else {
          const emoji = feedbackType === "Upvote" ? "👍" : "👎";
          console.log(chalk.green(`\n  ${emoji} ${feedbackType}d\n`));
        }
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to vote: ${message}`);
      }
    });
}
