import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { getApiUrl } from "../../config.js";
import { deriveBaseUrl, formatDateRange } from "../../utils.js";
import { clientPlanUrl } from "../../plan-urls.js";
import { resolvePlanArg } from "../../resolve-plan-arg.js";
import { jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import {
  LOOKUP_USER,
  INVITE_COLLABORATOR,
  GET_COLLABORATORS,
  REMOVE_COLLABORATOR,
  GET_SHARED_TRIP_PLANS,
} from "../../queries.js";

/** Collaborator roles `plans share --role` accepts, as the API's role keys. */
const SHARE_ROLES = ["viewer", "editor", "agent"] as const;

/** What `inviteTripPlanCollaborator` returns; the fields `plans share` reports. */
interface CollaboratorInvite {
  id: string;
  status: string;
  email?: string | null;
  invitedUserId?: string | null;
  role?: { id: string; name: string; key?: string | null } | null;
}

export function registerSharingCommands(plans: Command): void {
  plans
    .command("share [planId]")
    .description("Invite a collaborator to a trip plan")
    .option("--user <username>", "Username of the person to invite")
    .option("--email <email>", "Email address of the person to invite (no account required)")
    .option("--role <role>", "Role: viewer, editor, agent", "viewer")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts) => {
      const planId = resolvePlanArg(planIdInput, opts, "plans share");
      try {
        if (!opts.user && !opts.email) {
          throw new CliError(CliErrorCode.VALIDATION, "Either --user or --email is required.");
        }
        if (opts.user && opts.email) {
          throw new CliError(CliErrorCode.VALIDATION, "Use either --user or --email, not both.");
        }

        // The API accepts the role KEY directly, so no roles round-trip is needed.
        const roleKey = String(opts.role).trim().toLowerCase();
        if (!(SHARE_ROLES as readonly string[]).includes(roleKey)) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            `Invalid role "${opts.role}". Valid: ${SHARE_ROLES.join(", ")}`
          );
        }

        let input: { invitedUserId?: string; invitedEmail?: string; role: string };
        let userDisplay: string;

        if (opts.user) {
          // Look up user by username
          const userData = await graphql<{ userPublicProfile: { id: string; name: string; username: string } | null }>(
            LOOKUP_USER,
            { username: opts.user }
          );
          const user = userData.userPublicProfile;
          if (!user) {
            throw new CliError(CliErrorCode.NOT_FOUND, `User "${opts.user}" not found.`);
          }
          input = { invitedUserId: user.id, role: roleKey };
          userDisplay = user.name ?? user.username;
        } else {
          // The server resolves the address itself: an existing account is
          // invited directly; an address with no account gets a pending invite
          // that is claimed when they sign up with it.
          const email = String(opts.email).trim();
          input = { invitedEmail: email, role: roleKey };
          userDisplay = email;
        }

        const data = await graphql<{ inviteTripPlanCollaborator: CollaboratorInvite | null }>(
          INVITE_COLLABORATOR,
          { tripPlanId: planId, input }
        );
        const invite = data.inviteTripPlanCollaborator;
        // Fail fast rather than report success (or a pending signup) for an
        // invite the API did not actually create.
        if (!invite?.id) {
          throw new CliError(CliErrorCode.API_ERROR, "Invite was not created; the API returned no invite.");
        }
        const roleName = invite.role?.name ?? roleKey.charAt(0).toUpperCase() + roleKey.slice(1);
        // No account behind the address yet: the invite waits for their signup.
        const pending = Boolean(opts.email) && !invite.invitedUserId;

        if (opts.json) {
          jsonOutput({
            ok: true,
            success: true,
            planId,
            invitedUser: userDisplay,
            role: roleName,
            ...(pending ? { pending: true } : {}),
          });
          return;
        }
        // The API records the invite and sends nothing, on every path: say so
        // every time so the caller knows the notification is theirs to make.
        console.log(chalk.green(`\n  ✓ Invited ${chalk.bold(userDisplay)} as ${roleName}`));
        if (pending) {
          console.log(chalk.dim("    No Voyagier account uses this address yet. The invite is held for it and"));
          console.log(chalk.dim("    access is granted when they sign up with this email."));
        } else {
          console.log(chalk.dim("    They have a pending invite to accept in Voyagier."));
        }
        console.log(chalk.dim("    No email was sent. Let them know yourself.\n"));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to share plan: ${message}`);
      }
    });

  plans
    .command("collaborators [planId]")
    .description("List collaborators on a trip plan")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts) => {
      const planId = resolvePlanArg(planIdInput, opts, "plans collaborators");
      try {
        const data = await graphql<{
          tripPlanCollaborators: Array<{
            id: string;
            userId: string;
            roleId: string;
            role: { id: string; name: string };
            user: { id: string; firstName: string; lastName: string; email: string };
          }>;
        }>(
          GET_COLLABORATORS,
          { tripPlanId: planId }
        );

        const collabs = data.tripPlanCollaborators;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ planId, collaborators: collabs }, null, 2) + "\n");
          return;
        }

        if (collabs.length === 0) {
          console.log(chalk.dim("\n  No collaborators on this plan.\n"));
          return;
        }

        console.log(chalk.bold(`\n  👥 Collaborators (${collabs.length})\n`));
        for (const c of collabs) {
          const name = `${c.user.firstName} ${c.user.lastName}`.trim();
          const role = c.role?.name ?? "Unknown";
          const roleColor = role === "Owner" ? chalk.yellow : role === "Editor" ? chalk.cyan : chalk.dim;
          console.log(`  ${roleColor(role.padEnd(8))}  ${chalk.white(name)}  ${chalk.dim(c.user.email)}`);
          console.log(chalk.dim(`            ID: ${c.id}`));
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to list collaborators: ${message}`);
      }
    });

  plans
    .command("unshare [planId]")
    .description("Remove a collaborator from a trip plan")
    .requiredOption("--collaborator-id <id>", "Collaborator ID (from `plans collaborators`)")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts) => {
      // Validate the plan-id inputs (conflict/missing rules) even though the
      // mutation itself only needs the collaborator id.
      resolvePlanArg(planIdInput, opts, "plans unshare");
      try {
        await graphql<{ removeTripPlanCollaborator: boolean }>(
          REMOVE_COLLABORATOR,
          { collaboratorId: opts.collaboratorId }
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ok: true, success: true, removed: opts.collaboratorId }, null, 2) + "\n");
          return;
        }

        console.log(chalk.green(`\n  ✓ Removed collaborator ${opts.collaboratorId}\n`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to remove collaborator: ${message}`);
      }
    });

  plans
    .command("shared")
    .description("List trip plans shared with you")
    .option("--limit <n>", "Max results", "20")
    .option("--page <n>", "Page number", "1")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const limit = parseInt(opts.limit, 10);
        const page = parseInt(opts.page, 10);

        const data = await graphql<{
          sharedTripPlans: { count: number; items: Array<{ id: string; title: string; startDate?: string; endDate?: string }> };
        }>(
          GET_SHARED_TRIP_PLANS,
          { limit, page }
        );

        const { count, items } = data.sharedTripPlans;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ count, page, limit, plans: items }, null, 2) + "\n");
          return;
        }

        if (items.length === 0) {
          console.log(chalk.dim("\n  No shared plans.\n"));
          return;
        }

        const baseUrl = deriveBaseUrl(getApiUrl());
        console.log(chalk.bold(`\n  🤝 Shared with you (${count} total)\n`));
        for (const p of items) {
          const dr = formatDateRange(p.startDate, p.endDate);
          const dates = dr ? chalk.dim(` ${dr}`) : "";
          console.log(`  ${chalk.white(p.title)}${dates}`);
          console.log(chalk.dim(`    ${clientPlanUrl(p.id, baseUrl)}`));
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to list shared plans: ${message}`);
      }
    });
}
