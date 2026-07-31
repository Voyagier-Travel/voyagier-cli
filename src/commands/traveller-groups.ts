/**
 * Traveller Groups command surface (v2.1.0 — Section 6).
 *
 * Backed by TripPlanTravellerGroup entity. Stable per agent-surface audit
 * (AGENT-SURFACE-AUDIT.md): --color, --sort-order input, and `reorder`
 * command intentionally excluded; color + sortOrder appear in JSON output
 * only (read-completeness for web-UI-set values).
 *
 * Surface:
 *   voyagier traveller-groups list --plan <id> [--json]
 *   voyagier traveller-groups get <groupId> [--json]
 *   voyagier traveller-groups create --plan <id> --name <n> [--members <tids>] [--idempotency-key] [--json]
 *   voyagier traveller-groups update <groupId> --name <n> [--idempotency-key] [--json]
 *   voyagier traveller-groups delete <groupId> [--idempotency-key] [--json]
 *   voyagier traveller-groups add-members <groupId> --travellers <tids> [--idempotency-key] [--json]
 *   voyagier traveller-groups remove-members <groupId> --travellers <tids> [--idempotency-key] [--json]
 *   voyagier traveller-groups upsert --plan <id> --name <n> [--members <tids>] [--idempotency-key] [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import {
  LIST_TRIP_PLAN_TRAVELLER_GROUPS,
  GET_TRIP_PLAN_TRAVELLER_GROUP,
  CREATE_TRIP_PLAN_TRAVELLER_GROUP,
  UPDATE_TRIP_PLAN_TRAVELLER_GROUP,
  DELETE_TRIP_PLAN_TRAVELLER_GROUP,
  ADD_TRAVELLERS_TO_GROUP,
  REMOVE_TRAVELLERS_FROM_GROUP,
} from "../queries.js";
import { shellArg } from "../utils.js";
import { planUrls } from "../plan-urls.js";

// ---------- Types ----------

export interface GroupTraveller {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
}

export interface TravellerGroupPlanContext {
  id: string;
  title: string;
  travellers?: { id: string }[];
}

export interface TripPlanTravellerGroup {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  tripPlanId: string;
  tripPlan: TravellerGroupPlanContext;
  travellers: GroupTraveller[];
}

// ---------- Pure helpers (exported for reuse / tests) ----------

export function buildGroupPlanContext(plan: TravellerGroupPlanContext): Record<string, unknown> {
  return {
    planId: plan.id,
    title: plan.title,
    ...planUrls(plan.id),
    travellerCount: plan.travellers?.length ?? null,
  };
}

export function formatGroupTraveller(t: GroupTraveller): Record<string, unknown> {
  const name = [t.firstName, t.lastName].filter(Boolean).join(" ").trim() || t.id;
  return { id: t.id, name, email: t.email ?? null };
}

export function formatGroup(g: TripPlanTravellerGroup): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    color: g.color ?? null,
    sortOrder: g.sortOrder,
    travellerCount: g.travellers.length,
    travellers: g.travellers.map(formatGroupTraveller),
  };
}

/** Parse a comma-separated list of traveller IDs. Throws MEMBERS_REQUIRED if empty. */
export function parseMemberIds(csv: string, flagName = "--travellers"): string[] {
  const ids = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) {
    throw new CliError(
      CliErrorCode.MEMBERS_REQUIRED,
      `${flagName} cannot be empty. Provide at least one traveller id.\n  Fix: ${flagName} <tid1,tid2>`,
    );
  }
  return unique;
}

/**
 * Resolve a group by name (case-insensitive) within a plan.
 * Returns the group id. Exported for Section 5 (`select --group <name|id>`).
 */
export async function resolveGroupId(planId: string, nameOrId: string): Promise<string> {
  const data = await graphql<{
    tripPlanTravellerGroups: Array<{ id: string; name: string }>;
    tripPlan: TravellerGroupPlanContext | null;
  }>(LIST_TRIP_PLAN_TRAVELLER_GROUPS, { tripPlanId: planId });

  if (!data.tripPlan) {
    throw new CliError(
      CliErrorCode.PLAN_NOT_FOUND,
      `Trip plan "${planId}" not found.\n  Fix: voyagier plans list --json`,
    );
  }

  const groups = data.tripPlanTravellerGroups ?? [];
  const lower = nameOrId.toLowerCase();
  const match = groups.find(
    (g) => g.id === nameOrId || g.name.toLowerCase() === lower,
  );
  if (!match) {
    throw new CliError(
      CliErrorCode.NOT_FOUND,
      `No group found with name or id "${nameOrId}" in plan "${planId}".\n  Fix: voyagier traveller-groups list --plan ${shellArg(planId)}`,
    );
  }
  return match.id;
}

// ---------- Command registration ----------

export function registerTravellerGroupsCommands(program: Command): void {
  const tg = program
    .command("traveller-groups")
    .description("Manage traveller groups for a trip plan");

  // ---------- LIST ----------
  tg.command("list")
    .description("List all traveller groups in a plan, sorted by sortOrder")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const data = await graphql<{
        tripPlanTravellerGroups: TripPlanTravellerGroup[];
        tripPlan: TravellerGroupPlanContext & { travellers: { id: string }[] } | null;
      }>(LIST_TRIP_PLAN_TRAVELLER_GROUPS, { tripPlanId: opts.plan });

      if (!data.tripPlan) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Trip plan "${opts.plan}" not found.\n  Fix: voyagier plans list --json`,
        );
      }

      const plan = data.tripPlan;
      const groups = (data.tripPlanTravellerGroups ?? [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            groups: groups.map(formatGroup),
            total: groups.length,
          },
          planContext: buildGroupPlanContext(plan),
        });
        return;
      }

      if (groups.length === 0) {
        console.log(chalk.dim(`No traveller groups for plan "${plan.title}".`));
        console.log(
          chalk.dim(
            `  Create one: voyagier traveller-groups create --plan ${shellArg(opts.plan)} --name "Adults"`,
          ),
        );
        return;
      }

      console.log(chalk.bold(`\n  Traveller Groups — ${plan.title}\n`));
      for (const g of groups) {
        const mc = g.travellers.length;
        console.log(
          `  ${chalk.cyan(`[${g.sortOrder}]`)} ${chalk.bold(g.name)}  ${chalk.dim(`(${mc} member${mc === 1 ? "" : "s"})`)}`,
        );
        console.log(chalk.dim(`      ID: ${g.id}`));
        if (g.color) console.log(chalk.dim(`      Color: ${g.color}`));
      }
      console.log();
    });

  // ---------- GET ----------
  tg.command("get <groupId>")
    .description("Show details of a single traveller group")
    .option("--json", "Output raw JSON")
    .action(async (groupId: string, opts) => {
      const data = await graphql<{
        tripPlanTravellerGroup: TripPlanTravellerGroup | null;
      }>(GET_TRIP_PLAN_TRAVELLER_GROUP, { id: groupId });

      const g = data.tripPlanTravellerGroup;
      if (!g) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Group "${groupId}" not found.\n  Fix: voyagier traveller-groups list --plan <planId>`,
        );
      }

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: { group: formatGroup(g) },
          planContext: buildGroupPlanContext(g.tripPlan),
        });
        return;
      }

      console.log(`\n  ${chalk.bold(g.name)}  ${chalk.dim(`(${g.id})`)}`);
      console.log(chalk.dim(`  Plan:   ${g.tripPlan.id}`));
      if (g.color) console.log(chalk.dim(`  Color:  ${g.color}`));
      console.log(chalk.dim(`  Sort:   ${g.sortOrder}`));
      const mc = g.travellers.length;
      console.log(`  Members (${mc}):`);
      for (const t of g.travellers) {
        const name = [t.firstName, t.lastName].filter(Boolean).join(" ").trim() || t.id;
        console.log(chalk.dim(`    · ${name}  ${t.id}`));
      }
      console.log();
    });

  // ---------- CREATE ----------
  tg.command("create")
    .description("Create a new traveller group")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--name <name>", "Group name")
    .option("--members <ids>", "Comma-separated traveller IDs to add at creation")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      if (!opts.name || String(opts.name).trim() === "") {
        throw new CliError(
          CliErrorCode.GROUP_NAME_REQUIRED,
          "--name is required.\n  Fix: voyagier traveller-groups create --plan <id> --name \"Adults\"",
        );
      }
      const input: Record<string, unknown> = { name: String(opts.name).trim() };
      if (opts.members) {
        input.travellerIds = parseMemberIds(opts.members, "--members");
      }

      let createResult: { createTripPlanTravellerGroup: TripPlanTravellerGroup };
      try {
        createResult = await graphql<{
          createTripPlanTravellerGroup: TripPlanTravellerGroup;
        }>(CREATE_TRIP_PLAN_TRAVELLER_GROUP, { input, tripPlanId: opts.plan });
      } catch (err) {
        if (
          err instanceof CliError &&
          err.code === CliErrorCode.API_ERROR &&
          /traveller.*not.*in.*plan|not.*member.*plan|not.*in.*trip/i.test(err.message)
        ) {
          throw new CliError(
            CliErrorCode.TRAVELLER_NOT_IN_PLAN,
            `One or more travellers are not in this trip plan. Only plan travellers can be added to groups.\n  Fix: voyagier travellers list --plan ${shellArg(opts.plan)}`,
          );
        }
        throw err;
      }
      const g = createResult.createTripPlanTravellerGroup;

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: { group: formatGroup(g), idempotencyKey: opts.idempotencyKey ?? null },
          planContext: buildGroupPlanContext(g.tripPlan),
        });
        return;
      }

      console.log(chalk.green(`✓ Created group: ${g.name}`));
      console.log(chalk.dim(`  ID: ${g.id}`));
      if (g.travellers.length > 0) {
        console.log(chalk.dim(`  Members: ${g.travellers.length}`));
      }
    });

  // ---------- UPDATE ----------
  tg.command("update <groupId>")
    .description("Update a traveller group (currently only --name is mutable via CLI)")
    .option("--name <name>", "New group name")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking")
    .option("--json", "Output raw JSON")
    .action(async (groupId: string, opts) => {
      if (!opts.name || String(opts.name).trim() === "") {
        throw new CliError(
          CliErrorCode.GROUP_NAME_REQUIRED,
          "--name is required for update.\n  Fix: voyagier traveller-groups update <id> --name \"Adults\"",
        );
      }
      const input: Record<string, unknown> = { name: String(opts.name).trim() };

      const data = await graphql<{
        updateTripPlanTravellerGroup: TripPlanTravellerGroup | null;
      }>(UPDATE_TRIP_PLAN_TRAVELLER_GROUP, { id: groupId, input });
      const g = data.updateTripPlanTravellerGroup;
      if (!g) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Group "${groupId}" not found.\n  Fix: voyagier traveller-groups list --plan <planId>`,
        );
      }

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: { group: formatGroup(g), idempotencyKey: opts.idempotencyKey ?? null },
          planContext: buildGroupPlanContext(g.tripPlan),
        });
        return;
      }

      console.log(chalk.green(`✓ Updated group: ${g.name}`));
      console.log(chalk.dim(`  ID: ${g.id}`));
    });

  // ---------- DELETE ----------
  tg.command("delete <groupId>")
    .description("Delete a traveller group (server soft-deletes via softRemove)")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking")
    .option("--json", "Output raw JSON")
    .action(async (groupId: string, opts) => {
      const data = await graphql<{ deleteTripPlanTravellerGroup: boolean }>(
        DELETE_TRIP_PLAN_TRAVELLER_GROUP,
        { id: groupId },
      );
      const deleted = data.deleteTripPlanTravellerGroup === true;

      if (opts.json) {
        jsonOutput({
          ok: deleted,
          data: { groupId, deleted, idempotencyKey: opts.idempotencyKey ?? null },
        });
        return;
      }

      if (deleted) {
        console.log(chalk.green(`✓ Deleted group: ${groupId}`));
      } else {
        console.log(chalk.yellow(`⚠ Server returned false for delete of group ${groupId}`));
      }
    });

  // ---------- ADD-MEMBERS ----------
  tg.command("add-members <groupId>")
    .description("Add travellers to a group (server deduplicates existing members)")
    .option("--travellers <ids>", "Comma-separated traveller IDs")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking")
    .option("--json", "Output raw JSON")
    .action(async (groupId: string, opts) => {
      if (!opts.travellers) {
        throw new CliError(
          CliErrorCode.MEMBERS_REQUIRED,
          "--travellers is required.\n  Fix: voyagier traveller-groups add-members <groupId> --travellers <tid1,tid2>",
        );
      }
      const travellerIds = parseMemberIds(opts.travellers, "--travellers");

      // Fetch pre-mutation membership so we can compute the real delta.
      // The server silently deduplicates existing members, so the only way to
      // know which IDs were actually added is to diff request vs. pre-state.
      const preFetch = await graphql<{ tripPlanTravellerGroup: TripPlanTravellerGroup | null }>(
        GET_TRIP_PLAN_TRAVELLER_GROUP,
        { id: groupId },
      );
      const preMemberIds = new Set(
        (preFetch.tripPlanTravellerGroup?.travellers ?? []).map((t) => t.id),
      );

      let mutData: { addTravellersToGroup: TripPlanTravellerGroup };
      try {
        mutData = await graphql<{ addTravellersToGroup: TripPlanTravellerGroup }>(
          ADD_TRAVELLERS_TO_GROUP,
          { groupId, travellerIds },
        );
      } catch (err) {
        if (
          err instanceof CliError &&
          err.code === CliErrorCode.API_ERROR &&
          /traveller.*not.*in.*plan|not.*member.*plan|not.*in.*trip/i.test(err.message)
        ) {
          throw new CliError(
            CliErrorCode.TRAVELLER_NOT_IN_PLAN,
            `One or more travellers are not in this trip plan. Only plan travellers can be added to groups.\n  Fix: voyagier travellers list --plan <planId>`,
          );
        }
        throw err;
      }
      const g = mutData.addTravellersToGroup;
      const addedTravellerIds = travellerIds.filter((id) => !preMemberIds.has(id));

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            group: formatGroup(g),
            addedTravellerIds,
            idempotencyKey: opts.idempotencyKey ?? null,
          },
          planContext: buildGroupPlanContext(g.tripPlan),
        });
        return;
      }

      console.log(chalk.green(`✓ Added ${addedTravellerIds.length} traveller(s) to group: ${g.name}`));
      console.log(chalk.dim(`  Group ID: ${g.id}   Members now: ${g.travellers.length}`));
    });

  // ---------- REMOVE-MEMBERS ----------
  tg.command("remove-members <groupId>")
    .description("Remove travellers from a group")
    .option("--travellers <ids>", "Comma-separated traveller IDs")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking")
    .option("--json", "Output raw JSON")
    .action(async (groupId: string, opts) => {
      if (!opts.travellers) {
        throw new CliError(
          CliErrorCode.MEMBERS_REQUIRED,
          "--travellers is required.\n  Fix: voyagier traveller-groups remove-members <groupId> --travellers <tid1,tid2>",
        );
      }
      const travellerIds = parseMemberIds(opts.travellers, "--travellers");

      // Fetch pre-mutation membership to compute the real delta (same pattern
      // as add-members: server silently no-ops for non-members).
      const preFetchRm = await graphql<{ tripPlanTravellerGroup: TripPlanTravellerGroup | null }>(
        GET_TRIP_PLAN_TRAVELLER_GROUP,
        { id: groupId },
      );
      const preMemberIdsRm = new Set(
        (preFetchRm.tripPlanTravellerGroup?.travellers ?? []).map((t) => t.id),
      );

      const data = await graphql<{ removeTravellersFromGroup: TripPlanTravellerGroup }>(
        REMOVE_TRAVELLERS_FROM_GROUP,
        { groupId, travellerIds },
      );
      const g = data.removeTravellersFromGroup;
      const removedTravellerIds = travellerIds.filter((id) => preMemberIdsRm.has(id));

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            group: formatGroup(g),
            removedTravellerIds,
            idempotencyKey: opts.idempotencyKey ?? null,
          },
          planContext: buildGroupPlanContext(g.tripPlan),
        });
        return;
      }

      console.log(
        chalk.green(`✓ Removed ${removedTravellerIds.length} traveller(s) from group: ${g.name}`),
      );
      console.log(chalk.dim(`  Group ID: ${g.id}   Members now: ${g.travellers.length}`));
    });

  // ---------- UPSERT ----------
  tg.command("upsert")
    .description("Create a group by name, or return existing (case-insensitive name match)")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--name <name>", "Group name (lookup and create key)")
    .option("--members <ids>", "Comma-separated traveller IDs (for create case only)")
    .option("--idempotency-key <ulid>", "Echoed in JSON output for client-side retry tracking")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      if (!opts.name || String(opts.name).trim() === "") {
        throw new CliError(
          CliErrorCode.GROUP_NAME_REQUIRED,
          "--name is required.\n  Fix: voyagier traveller-groups upsert --plan <id> --name \"Adults\"",
        );
      }
      const name = String(opts.name).trim();

      const listData = await graphql<{
        tripPlanTravellerGroups: TripPlanTravellerGroup[];
        tripPlan: TravellerGroupPlanContext & { travellers: { id: string }[] } | null;
      }>(LIST_TRIP_PLAN_TRAVELLER_GROUPS, { tripPlanId: opts.plan });

      if (!listData.tripPlan) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Trip plan "${opts.plan}" not found.\n  Fix: voyagier plans list --json`,
        );
      }

      const existing = (listData.tripPlanTravellerGroups ?? []).find(
        (g) => g.name.toLowerCase() === name.toLowerCase(),
      );

      if (existing) {
        if (opts.json) {
          jsonOutput({
            ok: true,
            data: { group: formatGroup(existing), created: false, idempotencyKey: opts.idempotencyKey ?? null },
            planContext: buildGroupPlanContext(listData.tripPlan),
          });
          return;
        }
        console.log(chalk.cyan(`◆ Found existing group: ${existing.name}`));
        console.log(chalk.dim(`  ID: ${existing.id}`));
        return;
      }

      // Create new group
      const input: Record<string, unknown> = { name };
      if (opts.members) {
        input.travellerIds = parseMemberIds(opts.members, "--members");
      }

      let createData: { createTripPlanTravellerGroup: TripPlanTravellerGroup };
      try {
        createData = await graphql<{
          createTripPlanTravellerGroup: TripPlanTravellerGroup;
        }>(CREATE_TRIP_PLAN_TRAVELLER_GROUP, { input, tripPlanId: opts.plan });
      } catch (err) {
        if (
          err instanceof CliError &&
          err.code === CliErrorCode.API_ERROR &&
          /traveller.*not.*in.*plan|not.*member.*plan|not.*in.*trip/i.test(err.message)
        ) {
          throw new CliError(
            CliErrorCode.TRAVELLER_NOT_IN_PLAN,
            `One or more travellers are not in this trip plan. Only plan travellers can be added to groups.\n  Fix: voyagier travellers list --plan ${shellArg(opts.plan)}`,
          );
        }
        // Race condition: two concurrent upserts may both pass the "no existing group"
        // check, then both reach create — the second hits a unique-constraint error.
        // Recovery: do a second list pass to find the group the winner just created.
        // If still not found, throw the original error (genuinely something else went wrong).
        if (
          err instanceof CliError &&
          err.code === CliErrorCode.API_ERROR &&
          /already.*exists|duplicate.*name|unique.*constraint/i.test(err.message)
        ) {
          const recoveryData = await graphql<{
            tripPlanTravellerGroups: TripPlanTravellerGroup[];
            tripPlan: TravellerGroupPlanContext | null;
          }>(LIST_TRIP_PLAN_TRAVELLER_GROUPS, { tripPlanId: opts.plan });
          const recovered = (recoveryData.tripPlanTravellerGroups ?? []).find(
            (g) => g.name.toLowerCase() === name.toLowerCase(),
          );
          if (recovered) {
            const planCtx = recoveryData.tripPlan ?? recovered.tripPlan;
            if (opts.json) {
              jsonOutput({
                ok: true,
                data: {
                  group: formatGroup(recovered),
                  created: false,
                  recoveredFromRace: true,
                  idempotencyKey: opts.idempotencyKey ?? null,
                },
                planContext: buildGroupPlanContext(planCtx),
              });
              return;
            }
            console.log(chalk.cyan(`◆ Found existing group (recovered): ${recovered.name}`));
            console.log(chalk.dim(`  ID: ${recovered.id}`));
            return;
          }
        }
        throw err;
      }
      const g = createData.createTripPlanTravellerGroup;

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: { group: formatGroup(g), created: true, idempotencyKey: opts.idempotencyKey ?? null },
          planContext: buildGroupPlanContext(g.tripPlan),
        });
        return;
      }

      console.log(chalk.green(`✓ Created group: ${g.name}`));
      console.log(chalk.dim(`  ID: ${g.id}`));
    });
}
