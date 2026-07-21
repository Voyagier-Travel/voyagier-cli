/**
 * voyagier send — email the client their invite link to the live trip plan.
 *
 * This is the SELF-SERVE close (VOY-1212): the client lands on the live trip
 * in the webapp, where they can view everything and pay their own checkout
 * (createTripPlanCheckout only needs Read permission; invited clients get the
 * client role). The advisor-mediated alternative is `quote` → client approves
 * → `book --expect-total <quoted>`.
 *
 * SAFETY RAIL — this command EMAILS A REAL CLIENT and the mutation is not
 * idempotent (each call sends another email):
 *   - interactive TTY: confirm prompt showing the actual recipient address
 *   - non-interactive (scripts/agents): hard-require --yes, else
 *     CONFIRMATION_REQUIRED. An agent must be explicitly told to send.
 * The recipient is pre-checked with a read query BEFORE the mutation, so the
 * prompt shows the real address and a plan without a client email fails fast
 * with a fix hint instead of a server 400.
 */
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { graphql } from "../api.js";
import { GET_PLAN_CLIENT, SEND_TRIP_PLAN_TO_CLIENT } from "../queries.js";
import { CliError, CliErrorCode } from "../errors.js";
import { shellArg } from "../utils.js";

interface PlanClientCheck {
  tripPlan: {
    id: string;
    title: string;
    client?: { id: string; name: string; email?: string | null } | null;
  } | null;
}

interface SendResult {
  sendTripPlanToClient: {
    id: string;
    email?: string | null;
    status: string;
    invitedUserId?: string | null;
    expiresAt?: string | null;
  };
}

export function registerSendCommand(program: Command): void {
  program
    .command("send <planId>")
    .description("Email the client an invite link to view (and pay for) the trip plan in the webapp")
    .option("--note <text>", "Personal note included in the invite email (max 2000 chars)")
    .option("--yes", "Skip the confirmation prompt (required in non-interactive/agent runs)")
    .option("--json", "Output structured JSON")
    .option("--agent", "Compact agent-friendly output")
    .action(async (planId: string, opts: { note?: string; yes?: boolean; json?: boolean; agent?: boolean }) => {
      const planIdArg = shellArg(planId);

      // Fail fast before any prompt or mutation (server caps at 2000).
      if (opts.note && opts.note.length > 2000) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `--note is ${opts.note.length} characters; the maximum is 2000.`,
        );
      }

      // Pre-check: who would this email actually go to?
      let check: PlanClientCheck;
      try {
        check = await graphql<PlanClientCheck>(GET_PLAN_CLIENT, { id: planId });
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load plan: ${message}`);
      }
      if (!check.tripPlan) {
        throw new CliError(CliErrorCode.NOT_FOUND, `Trip plan ${planId} not found.`);
      }
      const plan = check.tripPlan;
      const clientEmail = plan.client?.email?.trim();
      if (!clientEmail) {
        throw new CliError(
          CliErrorCode.VALIDATION,
          `Plan "${plan.title}" has no client email to send to.\n` +
            `Attach a client with an email first:  voyagier clients list  →  voyagier plans update ${planIdArg} --client <clientId>`,
        );
      }

      // Confirmation rail (external comms; mutation is NOT idempotent).
      if (!opts.yes) {
        const isInteractive = process.stdin.isTTY === true && !process.env.CI;
        if (!isInteractive) {
          throw new CliError(
            CliErrorCode.CONFIRMATION_REQUIRED,
            `send emails a real client (${clientEmail}) and requires explicit confirmation.\n` +
              `Re-run with --yes:  voyagier send ${planIdArg} --yes${opts.note ? ` --note ${shellArg(opts.note)}` : ""}`,
            { recipient: clientEmail, planId: plan.id },
          );
        }
        // Prompt + abort diagnostics go to STDERR: in --json mode stdout must
        // stay a pure JSON stream (a piped consumer would otherwise ingest the
        // prompt text), and stdin-TTY does not imply stdout-TTY.
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const answer = (
            await rl.question(`Send "${plan.title}" invite email to ${chalk.bold(clientEmail)}? [y/N] `)
          ).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            console.error(chalk.dim("Aborted. Nothing sent."));
            return;
          }
        } finally {
          rl.close();
        }
      }

      // Send.
      const variables: Record<string, unknown> = { tripPlanId: planId };
      if (opts.note) variables.input = { note: opts.note };
      let result: SendResult;
      try {
        result = await graphql<SendResult>(SEND_TRIP_PLAN_TO_CLIENT, variables);
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to send invite: ${message}`);
      }
      const invite = result.sendTripPlanToClient;

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                invite: {
                  id: invite.id,
                  email: invite.email ?? clientEmail,
                  status: invite.status,
                  invitedUserId: invite.invitedUserId ?? null,
                  expiresAt: invite.expiresAt ?? null,
                },
                planId: plan.id,
                nextStep: `voyagier plan-status ${planIdArg}`,
              },
            },
            null,
            2,
          ) + "\n",
        );
        return;
      }

      const accessNote = invite.invitedUserId
        ? "client already has an account — access granted immediately"
        : "invite will be claimed when the client signs up";

      if (opts.agent) {
        const lines: string[] = [];
        lines.push(`✉️ Invite sent: "${plan.title}" → ${invite.email ?? clientEmail} (${invite.status})`);
        lines.push(`- ${accessNote}`);
        if (invite.expiresAt) lines.push(`- expires: ${invite.expiresAt}`);
        lines.push(`Next: voyagier plan-status ${planIdArg}`);
        console.log(lines.join("\n"));
        return;
      }

      console.log(chalk.green(`\n  ✉️  Invite sent to ${chalk.bold(invite.email ?? clientEmail)}`));
      console.log(chalk.dim(`  Plan: ${plan.title}`));
      console.log(chalk.dim(`  ${accessNote}${invite.expiresAt ? ` · expires ${invite.expiresAt}` : ""}`));
      console.log(chalk.dim(`\n  The client can view the live trip and pay in the webapp.`));
      console.log(chalk.dim(`  Track: voyagier plan-status ${planIdArg}\n`));
    });
}
