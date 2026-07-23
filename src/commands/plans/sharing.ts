import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { getApiUrl } from "../../config.js";
import { deriveBaseUrl, formatDateRange, resolvePlanId } from "../../utils.js";
import { jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import {
  LOOKUP_USER,
  GET_USERS,
  CREATE_USER_INVITATION,
  GET_TRIP_PLAN_ROLES,
  INVITE_COLLABORATOR,
  GET_COLLABORATORS,
  REMOVE_COLLABORATOR,
  GET_SHARED_TRIP_PLANS,
} from "../../queries.js";

export function registerSharingCommands(plans: Command): void {
  plans
    .command("share [planId]")
    .description("Invite a collaborator to a trip plan")
    .option("--user <username>", "Username of the person to invite")
    .option("--email <email>", "Email address of the person to invite")
    .option("--role <role>", "Role: viewer, editor, agent", "viewer")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts) => {
      const planId = resolvePlanId(planIdInput, opts, "plans share");
      try {
        if (!opts.user && !opts.email) {
          throw new CliError(CliErrorCode.VALIDATION, "Either --user or --email is required.");
        }
        if (opts.user && opts.email) {
          throw new CliError(CliErrorCode.VALIDATION, "Use either --user or --email, not both.");
        }

        let userId: string;
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
          userId = user.id;
          userDisplay = user.name ?? user.username;
        } else {
          // Look up user by email (search users, filter client-side)
          // TODO: Replace with server-side email filter query when available (VOY-809)
          const usersData = await graphql<{ users: { items: Array<{ id: string; name: string; email: string; username?: string }> } }>(
            GET_USERS
          );
          const email = (opts.email as string).toLowerCase();
          const match = usersData.users.items.find((u) => u.email?.toLowerCase() === email);

          if (!match) {
            // User not found — send platform invitation
            await graphql<{ createUserInvitation: { __typename: string } }>(
              CREATE_USER_INVITATION,
              { input: { email: opts.email as string } }
            );
            if (opts.json) {
              jsonOutput({ invited: true, email: opts.email, message: "Platform invitation sent. Re-run after they sign up." });
              return;
            }
            console.log(chalk.yellow(`\n  ✉ No Voyagier account found for ${opts.email}.`));
            console.log(chalk.dim("    A platform invitation has been sent."));
            console.log(chalk.dim("    Run this command again once they've signed up.\n"));
            return;
          }
          userId = match.id;
          userDisplay = match.name || match.email;
        }

        // Resolve role name to ID
        const rolesData = await graphql<{ tripPlanRoles: Array<{ id: string; name: string }> }>(
          GET_TRIP_PLAN_ROLES
        );
        const roleName = opts.role.charAt(0).toUpperCase() + opts.role.slice(1).toLowerCase();
        const role = rolesData.tripPlanRoles.find(r => r.name === roleName);
        if (!role) {
          const valid = rolesData.tripPlanRoles.map(r => r.name.toLowerCase()).join(", ");
          throw new CliError(CliErrorCode.VALIDATION, `Invalid role "${opts.role}". Valid: ${valid}`);
        }

        await graphql<{ inviteTripPlanCollaborator: unknown }>(
          INVITE_COLLABORATOR,
          { tripPlanId: planId, input: { invitedUserId: userId, roleId: role.id } }
        );

        if (opts.json) {
          jsonOutput({ success: true, planId, invitedUser: userDisplay, role: role.name });
          return;
        }
        console.log(chalk.green(`\n  ✓ Invited ${chalk.bold(userDisplay)} as ${role.name}\n`));
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
      const planId = resolvePlanId(planIdInput, opts, "plans collaborators");
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
      const planId = resolvePlanId(planIdInput, opts, "plans unshare");
      try {
        await graphql<{ removeTripPlanCollaborator: boolean }>(
          REMOVE_COLLABORATOR,
          { collaboratorId: opts.collaboratorId }
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify({ success: true, removed: opts.collaboratorId }, null, 2) + "\n");
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
          console.log(chalk.dim(`    ${baseUrl}/plans/${p.id}`));
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to list shared plans: ${message}`);
      }
    });
}
