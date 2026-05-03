/**
 * Clients command surface (v2.0.0).
 *
 * Backed by the TripPlanClient entity introduced in #369.
 * STABLE per Phase 0 schema audit (BREAKING-CHANGES.md Section 3).
 *
 * Surface:
 *   voyagier clients list [--status active|archived] [--type individual|company|group] [--json]
 *   voyagier clients get <id> [--json]
 *   voyagier clients create --name <n> --type <t> [--email] [--phone] [--description] [--avatar] [--json]
 *   voyagier clients update <id> [--name] [--type] [--email] [--phone] [--description] [--avatar] [--status] [--json]
 *   voyagier clients archive <id> [--json]
 *   voyagier clients upsert --email <e> --name <n> --type <t> [opts] [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput, fatal } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import {
  LIST_TRIP_PLAN_CLIENTS,
  GET_TRIP_PLAN_CLIENT,
  CREATE_TRIP_PLAN_CLIENT,
  UPDATE_TRIP_PLAN_CLIENT,
} from "../queries.js";

export interface TripPlanClient {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  description?: string | null;
  clientType: "Individual" | "Company" | "Group";
  status: "Active" | "Archived";
  createdAt?: string;
  updatedAt?: string;
}

const VALID_TYPES = ["individual", "company", "group"] as const;
const VALID_STATUSES = ["active", "archived"] as const;

/**
 * Normalize a CLI flag value (lowercase) to the GraphQL enum (PascalCase).
 * Throws VALIDATION error with allowed values listed.
 */
function normalizeType(value: string): TripPlanClient["clientType"] {
  const lower = value.toLowerCase();
  if (!VALID_TYPES.includes(lower as (typeof VALID_TYPES)[number])) {
    fatal(`Invalid --type "${value}". Must be one of: ${VALID_TYPES.join(", ")}`);
  }
  return (lower.charAt(0).toUpperCase() + lower.slice(1)) as TripPlanClient["clientType"];
}

function normalizeStatus(value: string): TripPlanClient["status"] {
  const lower = value.toLowerCase();
  if (!VALID_STATUSES.includes(lower as (typeof VALID_STATUSES)[number])) {
    fatal(`Invalid --status "${value}". Must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  return (lower.charAt(0).toUpperCase() + lower.slice(1)) as TripPlanClient["status"];
}

/**
 * Format a client for human-readable TTY output (color, single line).
 */
function formatClientLine(c: TripPlanClient): string {
  const statusBadge = c.status === "Active" ? chalk.green("●") : chalk.dim("○");
  const typeLabel = chalk.cyan(`[${c.clientType}]`);
  const contact = c.email ? chalk.dim(` <${c.email}>`) : "";
  return `${statusBadge} ${typeLabel} ${chalk.bold(c.name)}${contact}  ${chalk.dim(c.id)}`;
}

/**
 * Resolve the active client when a command needs one.
 * Returns the resolved clientId, throwing structured CliErrors with `fix` strings on failure.
 *
 * Used by other v2 commands (plans create, plan-trip) that need a clientId.
 *
 * @param explicit - user-provided --client flag (id or email)
 * @returns resolved clientId
 */
export async function resolveClientId(explicit?: string): Promise<string> {
  if (explicit) {
    // Heuristic: if it looks like an email, look it up; otherwise treat as id.
    if (explicit.includes("@")) {
      const data = await graphql<{ tripPlanClients: TripPlanClient[] }>(LIST_TRIP_PLAN_CLIENTS);
      const match = data.tripPlanClients.find(
        (c) => c.email?.toLowerCase() === explicit.toLowerCase() && c.status === "Active"
      );
      if (!match) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `No ACTIVE client found with email "${explicit}".\n  Fix: voyagier clients list --json  (then pick an id)\n  Or:  voyagier clients create --name "..." --type individual --email "${explicit}"`
        );
      }
      return match.id;
    }
    return explicit;
  }

  // No explicit value: auto-resolve.
  const data = await graphql<{ tripPlanClients: TripPlanClient[] }>(LIST_TRIP_PLAN_CLIENTS);
  const active = data.tripPlanClients.filter((c) => c.status === "Active");

  if (active.length === 0) {
    throw new CliError(
      CliErrorCode.NO_CLIENTS,
      `No ACTIVE clients found on this account.\n  Fix: voyagier clients create --name "<n>" --type individual`
    );
  }
  if (active.length > 1) {
    const list = active.map((c) => `    ${c.id}  ${c.name}`).join("\n");
    throw new CliError(
      CliErrorCode.MULTIPLE_CLIENTS,
      `Multiple ACTIVE clients found. Specify --client <id>:\n${list}\n  Fix: voyagier plans create --client <id>`
    );
  }
  return active[0].id;
}

export function registerClientsCommands(program: Command): void {
  const clients = program
    .command("clients")
    .description("Manage trip plan clients (advisor CRM)");

  // -- list --
  clients
    .command("list")
    .description("List all trip plan clients on this account")
    .option("--status <status>", "Filter by status (active|archived)")
    .option("--type <type>", "Filter by client type (individual|company|group)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const data = await graphql<{ tripPlanClients: TripPlanClient[] }>(LIST_TRIP_PLAN_CLIENTS);
      let list = data.tripPlanClients;
      if (opts.status) {
        const statusFilter = normalizeStatus(opts.status);
        list = list.filter((c) => c.status === statusFilter);
      }
      if (opts.type) {
        const typeFilter = normalizeType(opts.type);
        list = list.filter((c) => c.clientType === typeFilter);
      }

      if (opts.json) {
        jsonOutput({ clients: list, total: list.length });
        return;
      }

      if (list.length === 0) {
        console.log(chalk.dim("No clients found."));
        console.log(chalk.dim("Create one: voyagier clients create --name \"<n>\" --type individual"));
        return;
      }
      list.forEach((c) => console.log(formatClientLine(c)));
      console.log(chalk.dim(`\n${list.length} client${list.length === 1 ? "" : "s"}`));
    });

  // -- get --
  clients
    .command("get <id>")
    .description("Show details of a single client")
    .option("--json", "Output raw JSON")
    .action(async (id, opts) => {
      const data = await graphql<{ tripPlanClient: TripPlanClient | null }>(
        GET_TRIP_PLAN_CLIENT,
        { id }
      );
      if (!data.tripPlanClient) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Client "${id}" not found.\n  Fix: voyagier clients list --json`
        );
      }
      const c = data.tripPlanClient;

      if (opts.json) {
        jsonOutput({ client: c });
        return;
      }

      console.log(`${chalk.bold(c.name)} ${chalk.cyan(`[${c.clientType}]`)}`);
      console.log(chalk.dim(`  ID:      ${c.id}`));
      console.log(chalk.dim(`  Status:  ${c.status}`));
      if (c.email) console.log(chalk.dim(`  Email:   ${c.email}`));
      if (c.phone) console.log(chalk.dim(`  Phone:   ${c.phone}`));
      if (c.description) console.log(chalk.dim(`  Notes:   ${c.description}`));
      if (c.createdAt) console.log(chalk.dim(`  Created: ${c.createdAt}`));
    });

  // -- create --
  clients
    .command("create")
    .description("Create a new client")
    .requiredOption("--name <name>", "Client name")
    .requiredOption("--type <type>", "Client type (individual|company|group)")
    .option("--email <email>", "Email address")
    .option("--phone <phone>", "Phone number")
    .option("--description <text>", "Notes/description")
    .option("--avatar <url>", "Avatar URL")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      const input: Record<string, unknown> = {
        name: opts.name,
        clientType: normalizeType(opts.type),
      };
      if (opts.email) input.email = opts.email;
      if (opts.phone) input.phone = opts.phone;
      if (opts.description) input.description = opts.description;
      if (opts.avatar) input.avatarUrl = opts.avatar;

      const data = await graphql<{ createTripPlanClient: TripPlanClient }>(
        CREATE_TRIP_PLAN_CLIENT,
        { input },
        { dryRun: opts.dryRun }
      );
      const c = data.createTripPlanClient;

      if (opts.json) {
        jsonOutput({ client: c, ok: true });
        return;
      }
      console.log(chalk.green(`✓ Created client: ${c.name}`));
      console.log(chalk.dim(`  ID:   ${c.id}`));
      console.log(chalk.dim(`  Type: ${c.clientType}`));
      if (c.email) console.log(chalk.dim(`  Email: ${c.email}`));
    });

  // -- update --
  clients
    .command("update <id>")
    .description("Update a client")
    .option("--name <name>", "New name")
    .option("--type <type>", "New client type")
    .option("--email <email>", "New email")
    .option("--phone <phone>", "New phone")
    .option("--description <text>", "New notes/description")
    .option("--avatar <url>", "New avatar URL")
    .option("--status <status>", "New status (active|archived)")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (id, opts) => {
      const input: Record<string, unknown> = {};
      if (opts.name !== undefined) input.name = opts.name;
      if (opts.type !== undefined) input.clientType = normalizeType(opts.type);
      if (opts.email !== undefined) input.email = opts.email;
      if (opts.phone !== undefined) input.phone = opts.phone;
      if (opts.description !== undefined) input.description = opts.description;
      if (opts.avatar !== undefined) input.avatarUrl = opts.avatar;
      if (opts.status !== undefined) input.status = normalizeStatus(opts.status);

      if (Object.keys(input).length === 0) {
        fatal("No fields provided to update. Use at least one of: --name, --type, --email, --phone, --description, --avatar, --status");
      }

      const data = await graphql<{ updateTripPlanClient: TripPlanClient }>(
        UPDATE_TRIP_PLAN_CLIENT,
        { id, input },
        { dryRun: opts.dryRun }
      );
      const c = data.updateTripPlanClient;

      if (opts.json) {
        jsonOutput({ client: c, ok: true });
        return;
      }
      console.log(chalk.green(`✓ Updated client: ${c.name}`));
      console.log(chalk.dim(`  ID:     ${c.id}`));
      console.log(chalk.dim(`  Status: ${c.status}`));
    });

  // -- archive --
  clients
    .command("archive <id>")
    .description("Archive a client (soft-delete; convenience wrapper around update --status archived)")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (id, opts) => {
      const data = await graphql<{ updateTripPlanClient: TripPlanClient }>(
        UPDATE_TRIP_PLAN_CLIENT,
        { id, input: { status: "Archived" } },
        { dryRun: opts.dryRun }
      );
      const c = data.updateTripPlanClient;

      if (opts.json) {
        jsonOutput({ client: c, ok: true });
        return;
      }
      console.log(chalk.yellow(`✓ Archived client: ${c.name}`));
      console.log(chalk.dim(`  ID: ${c.id}`));
    });

  // -- upsert --
  clients
    .command("upsert")
    .description("Create or return existing client by email (idempotent helper for agents)")
    .requiredOption("--email <email>", "Email address (lookup key)")
    .requiredOption("--name <name>", "Name (for create case)")
    .requiredOption("--type <type>", "Client type (individual|company|group)")
    .option("--phone <phone>", "Phone number (for create case)")
    .option("--description <text>", "Notes/description (for create case)")
    .option("--avatar <url>", "Avatar URL (for create case)")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      const list = await graphql<{ tripPlanClients: TripPlanClient[] }>(LIST_TRIP_PLAN_CLIENTS);
      const existing = list.tripPlanClients.find(
        (c) => c.email?.toLowerCase() === opts.email.toLowerCase()
      );

      if (existing) {
        if (opts.json) {
          jsonOutput({ client: existing, ok: true, created: false });
          return;
        }
        console.log(chalk.cyan(`◆ Found existing client: ${existing.name}`));
        console.log(chalk.dim(`  ID: ${existing.id}`));
        return;
      }

      const input: Record<string, unknown> = {
        name: opts.name,
        clientType: normalizeType(opts.type),
        email: opts.email,
      };
      if (opts.phone) input.phone = opts.phone;
      if (opts.description) input.description = opts.description;
      if (opts.avatar) input.avatarUrl = opts.avatar;

      const data = await graphql<{ createTripPlanClient: TripPlanClient }>(
        CREATE_TRIP_PLAN_CLIENT,
        { input },
        { dryRun: opts.dryRun }
      );
      const c = data.createTripPlanClient;

      if (opts.json) {
        jsonOutput({ client: c, ok: true, created: true });
        return;
      }
      console.log(chalk.green(`✓ Created client: ${c.name}`));
      console.log(chalk.dim(`  ID: ${c.id}`));
    });
}
