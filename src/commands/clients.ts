/**
 * Clients command surface (v2.0.0).
 *
 * Backed by the TripPlanClient entity introduced in #369.
 * STABLE per Phase 0 schema audit (BREAKING-CHANGES.md Section 3).
 *
 * Surface:
 *   voyagier clients list [--status active|archived] [--type individual|company|group] [--json]
 *   voyagier clients get <id> [--json]
 *   voyagier clients create --name <n> --type <t> [--email] [--phone] [--description] [--json]
 *   voyagier clients update <id> [--name] [--type] [--email] [--phone] [--description] [--status] [--json]
 *
 * Note: avatars are set in the web UI (an agent has no upstream context to anchor a
 * valid avatar URL). `upsert` takes no free-text description — set it with
 * `clients update --description` after the client resolves, so the idempotent
 * upsert stays idempotent.
 *   voyagier clients archive <id> [--json]
 *   voyagier clients upsert --email <e> --name <n> --type <t> [opts] [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql, graphqlWithFieldFallback } from "../api.js";
import { jsonOutput, fatal } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { promptPick } from "../prompt.js";
import {
  LIST_TRIP_PLAN_CLIENTS,
  LIST_TRIP_PLAN_CLIENTS_WITH_SELF,
  GET_TRIP_PLAN_CLIENT,
  CREATE_TRIP_PLAN_CLIENT,
  UPDATE_TRIP_PLAN_CLIENT,
} from "../queries.js";
import { shellArg } from "../utils.js";

export interface TripPlanClient {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  description?: string | null;
  clientType: "Individual" | "Company" | "Group";
  status: "Active" | "Archived";
  // The auto-provisioned "self" client every trip-planner gets when granted the
  // role (VOY-1748). Optional because a pre-isSelf backend omits it entirely —
  // see fetchAllClients()'s compat fallback; treat absent as "not self".
  isSelf?: boolean;
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

// Page size for tripPlanClients pagination. Server default is 20; we ask for
// 100 to minimize round-trips while staying well under any reasonable per-page
// cap. The accumulator below keeps fetching until a short page (or count) ends
// the loop.
const CLIENTS_PAGE_SIZE = 100;
// Hard ceiling on pages walked, in case a buggy server keeps returning full
// pages forever. 50 * 100 = 5,000 clients is well above any realistic advisor
// roster; if you hit this, something is wrong with the server response.
const CLIENTS_MAX_PAGES = 50;

async function fetchAllClients(): Promise<TripPlanClient[]> {
  const out: TripPlanClient[] = [];
  let page = 1;
  while (page <= CLIENTS_MAX_PAGES) {
    // Attempt the isSelf-enriched query; transparently fall back to the legacy
    // field set against a backend that hasn't deployed isSelf yet (VOY-1748).
    const data = await graphqlWithFieldFallback<{
      tripPlanClients: {
        items: TripPlanClient[];
        count: number;
        page: number;
        limit: number;
      };
    }>(LIST_TRIP_PLAN_CLIENTS_WITH_SELF, LIST_TRIP_PLAN_CLIENTS, /isSelf/, {
      page,
      limit: CLIENTS_PAGE_SIZE,
    });
    const items = data.tripPlanClients.items ?? [];
    out.push(...items);
    // Stop when the server returns a short page (last page) or when we've
    // collected every record per server-reported count.
    if (items.length < CLIENTS_PAGE_SIZE) break;
    if (out.length >= data.tripPlanClients.count) break;
    page += 1;
  }
  return out;
}

/**
 * Parse a positive-integer CLI flag, falling back to `fallback` when the flag
 * was omitted. A present-but-invalid value (non-numeric, ≤0) is a hard
 * VALIDATION error rather than a silent default — the caller asked for a
 * specific page/size and a typo must not quietly return page 1.
 */
function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || String(n) !== raw.trim()) {
    fatal(`Invalid ${flag} "${raw}". Must be a positive integer.`);
  }
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeClientId(s: string): boolean {
  return UUID_RE.test(s) || s.startsWith("clt_");
}

/**
 * Format a client for human-readable TTY output (color, single line).
 */
function formatClientLine(c: TripPlanClient): string {
  const statusBadge = c.status === "Active" ? chalk.green("●") : chalk.dim("○");
  const typeLabel = chalk.cyan(`[${c.clientType}]`);
  const selfMarker = c.isSelf ? " " + chalk.magenta("(self)") : "";
  const contact = c.email ? chalk.dim(` <${c.email}>`) : "";
  return `${statusBadge} ${typeLabel} ${chalk.bold(c.name)}${selfMarker}${contact}  ${chalk.dim(c.id)}`;
}

export interface ResolvedClient {
  id: string;
  name: string;
  autoResolved: boolean;
  /** True when the resolved client is the caller's own "self" client (VOY-1748). */
  isSelf?: boolean;
}

/**
 * Interactivity signal for resolveClient (VOY-1762).
 *
 * The signal is passed in EXPLICITLY, never guessed from a global — resolveClient
 * has many callers, and only the ones that opt in (a human at a TTY) should ever
 * see a picker. Non-interactive callers keep the exact CliError-throwing behavior
 * their specs assert.
 */
export interface ResolveClientOptions {
  /**
   * When true and multiple ACTIVE clients match, show a numbered picker instead
   * of throwing MULTIPLE_CLIENTS. Only ever set this for a human at a TTY.
   */
  interactive?: boolean;
  /**
   * Flags the caller already typed, carried forward into the MULTIPLE_CLIENTS
   * retry hint so the suggested command doesn't silently drop them (e.g.
   * `--title 'Paris'`). Only surfaces in the non-interactive error text.
   */
  carryFlags?: string;
}

/**
 * Resolve the active client when a command needs one.
 * Returns id, display name, and an autoResolved flag for callers that want to
 * surface "we picked this for you" feedback.
 *
 * Accepted forms for `explicit`:
 *   - empty string                → CLIENT_REQUIRED error (explicit-but-empty signal)
 *   - email (`x@y`)               → looked up by email (Active only)
 *   - canonical id — UUID or `clt_…` prefix → returned directly, no lookup
 *   - any other string            → looked up as case-insensitive name match (Active only)
 */
export async function resolveClient(
  explicit?: string,
  options: ResolveClientOptions = {},
): Promise<ResolvedClient> {
  if (explicit === "") {
    throw new CliError(
      CliErrorCode.CLIENT_REQUIRED,
      "--client was provided but empty. Pass an id, email, name, or omit the flag to auto-resolve.",
    );
  }
  if (explicit) {
    if (explicit.includes("@")) {
      const items = await fetchAllClients();
      const match = items.find(
        (c) => c.email?.toLowerCase() === explicit.toLowerCase() && c.status === "Active"
      );
      if (!match) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `No ACTIVE client found with email "${explicit}".\n  Fix: voyagier clients list  (then pass --client <id|name|email>)\n  Or:  voyagier clients create --name "..." --type individual --email "${explicit}"`
        );
      }
      return { id: match.id, name: match.name, autoResolved: false };
    }
    if (looksLikeClientId(explicit)) {
      // Canonical client id (UUID or clt_ prefix) — trust it without a roundtrip.
      return { id: explicit, name: explicit, autoResolved: false };
    }
    // Otherwise treat as a name (case-insensitive exact match against Active clients).
    const items = await fetchAllClients();
    const target = explicit.toLowerCase();
    const matches = items.filter(
      (c) => c.name.toLowerCase() === target && c.status === "Active"
    );
    if (matches.length === 0) {
      throw new CliError(
        CliErrorCode.NOT_FOUND,
        `No ACTIVE client found matching "${explicit}".\n  Fix: voyagier clients list  (then pass --client <id|name|email>)`
      );
    }
    if (matches.length > 1) {
      const list = matches.map((c) => `    ${c.id}  ${c.name}`).join("\n");
      const ambiguous = new CliError(
        CliErrorCode.MULTIPLE_CLIENTS,
        `Multiple ACTIVE clients matched "${explicit}". Specify --client <id|email>:\n${list}\n  Tip: an email or id is unambiguous.`
      );
      if (options.interactive) {
        const chosen = await promptPick(
          `Multiple ACTIVE clients matched "${explicit}". Which one?`,
          matches,
          (c) => `${c.name}${c.email ? ` <${c.email}>` : ""}`,
          ambiguous,
        );
        return { id: chosen.id, name: chosen.name, autoResolved: false };
      }
      throw ambiguous;
    }
    return { id: matches[0].id, name: matches[0].name, autoResolved: false };
  }

  // No explicit value: auto-resolve.
  const items = await fetchAllClients();
  const active = items.filter((c) => c.status === "Active");

  if (active.length === 0) {
    throw new CliError(
      CliErrorCode.NO_CLIENTS,
      `No ACTIVE clients found on this account.\n  Fix: voyagier clients create --name "<n>" --type individual`
    );
  }
  // Exactly one active client — pick it, unchanged from prior behavior.
  if (active.length === 1) {
    return { id: active[0].id, name: active[0].name, autoResolved: true, isSelf: active[0].isSelf === true };
  }
  // >1 active: if the backend marks exactly one as the "self" client
  // (VOY-1748), that's the frictionless default — a trip-planner planning
  // their own trip shouldn't need --client. (A pre-isSelf backend leaves the
  // flag absent, so this collapses to the legacy ambiguity error below.)
  const selfClients = active.filter((c) => c.isSelf === true);
  if (selfClients.length === 1) {
    return { id: selfClients[0].id, name: selfClients[0].name, autoResolved: true, isSelf: true };
  }
  const list = active.map((c) => `    ${c.id}  ${c.name}${c.isSelf ? "  (self)" : ""}`).join("\n");
  const selfHint = selfClients.length > 0
    ? "\n  Note: more than one client is flagged as your self client — pass --client <id> explicitly."
    : "";
  const exampleName = shellArg(active[0].name || "Client Name");
  // Carry forward the flags the caller already typed so the retry command is
  // copy-pasteable (VOY-1762) — previously the hint dropped e.g. --title.
  const carry = options.carryFlags ? ` ${options.carryFlags}` : "";
  const ambiguous = new CliError(
    CliErrorCode.MULTIPLE_CLIENTS,
    `Multiple ACTIVE clients found. Specify --client <id|name|email>:\n${list}${selfHint}\n  Fix: voyagier plan-trip --client ${exampleName}${carry}  (--client accepts an id, name, or email)`
  );
  if (options.interactive) {
    const chosen = await promptPick(
      "Multiple ACTIVE clients found. Which one?",
      active,
      (c) => `${c.name}${c.isSelf ? " (self)" : ""}${c.email ? ` <${c.email}>` : ""}`,
      ambiguous,
    );
    return { id: chosen.id, name: chosen.name, autoResolved: false };
  }
  throw ambiguous;
}

/**
 * Thin wrapper around resolveClient — returns just the id.
 * Kept for backward compatibility with existing callers that don't need name/autoResolved.
 */
export async function resolveClientId(
  explicit?: string,
  options?: ResolveClientOptions,
): Promise<string> {
  return (await resolveClient(explicit, options)).id;
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
    .option("--page <n>", "Fetch a single page (1-based) instead of the whole roster")
    .option("--limit <n>", "Page size when --page/--limit is given (default 20)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      // Single-page mode: when either --page or --limit is given, fetch exactly
      // that page (bounds output for paginated agent callers) instead of walking
      // the whole roster. Status/type filters still apply, scoped to the page.
      if (opts.page !== undefined || opts.limit !== undefined) {
        const page = parsePositiveInt(opts.page, "--page", 1);
        const limit = parsePositiveInt(opts.limit, "--limit", 20);
        const data = await graphqlWithFieldFallback<{
          tripPlanClients: { items: TripPlanClient[]; count: number; page: number; limit: number };
        }>(LIST_TRIP_PLAN_CLIENTS_WITH_SELF, LIST_TRIP_PLAN_CLIENTS, /isSelf/, { page, limit });
        let items = data.tripPlanClients.items ?? [];
        if (opts.status) {
          const statusFilter = normalizeStatus(opts.status);
          items = items.filter((c) => c.status === statusFilter);
        }
        if (opts.type) {
          const typeFilter = normalizeType(opts.type);
          items = items.filter((c) => c.clientType === typeFilter);
        }
        if (opts.json) {
          jsonOutput({
            clients: items,
            total: items.length,
            page: data.tripPlanClients.page,
            limit: data.tripPlanClients.limit,
            count: data.tripPlanClients.count,
          });
          return;
        }
        if (items.length === 0) {
          console.log(chalk.dim("No clients on this page."));
          return;
        }
        items.forEach((c) => console.log(formatClientLine(c)));
        console.log(chalk.dim(`\nPage ${data.tripPlanClients.page} · ${items.length} shown · ${data.tripPlanClients.count} total`));
        return;
      }

      let list = await fetchAllClients();
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
    .option(
      "--description <text>",
      "Agent leverage point: distilled client brief from the agent's upstream context. Pass when the agent has gathered meaningful intent (preferences, family composition, advisor notes); omit when there's nothing concrete to record. Never fill this with auto-generated boilerplate.",
    )
    // Note: avatars have no agent-settable path — set them in the web UI.
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
    .option(
      "--description <text>",
      "Agent leverage point: refresh the distilled client brief. Pass when the agent has new meaningful intent to record; omit otherwise. Replaces existing description.",
    )
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
      if (opts.status !== undefined) input.status = normalizeStatus(opts.status);

      if (Object.keys(input).length === 0) {
        fatal("No fields provided to update. Use at least one of: --name, --type, --email, --phone, --description, --status");
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
    // upsert takes no free-text description: re-running with a slightly different
    // string would break idempotency. Use `clients update --description` after
    // the client resolves.
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL mutation without executing")
    .action(async (opts) => {
      // KNOWN LIMITATION (Copilot #3178799095): this list-then-create flow is not
      // strictly idempotent under concurrency — two callers may both miss the existing
      // row and both call createTripPlanClient. Until the API exposes server-side
      // uniqueness on email or an explicit upsertTripPlanClient mutation, the CLI
      // workaround is best-effort and assumes serial agent flows. Tracking with Mark
      // sync (tracked as a P1 follow-up). Wrap calling code with an
      // idempotency-key + retry on duplicate-conflict when the server side lands.
      const allClients = await fetchAllClients();
      const sameEmail = allClients.filter(
        (c) => c.email?.toLowerCase() === opts.email.toLowerCase()
      );
      // Only an Active record is reusable downstream (resolveClientId requires Active);
      // Archived matches must be surfaced explicitly so callers can reactivate or pick another.
      const existing = sameEmail.find((c) => c.status === "Active");
      const archived = sameEmail.find((c) => c.status === "Archived");

      if (existing) {
        if (opts.json) {
          jsonOutput({ client: existing, ok: true, created: false });
          return;
        }
        console.log(chalk.cyan(`◆ Found existing client: ${existing.name}`));
        console.log(chalk.dim(`  ID: ${existing.id}`));
        return;
      }

      if (archived) {
        const message = `Found an Archived client with email ${opts.email} (id ${archived.id}).\n` +
          `  Reactivate first, or create with a different email:\n` +
          `    voyagier clients update ${shellArg(archived.id)} --status active`;
        throw new CliError(CliErrorCode.VALIDATION, message, { archivedClientId: archived.id });
      }

      const input: Record<string, unknown> = {
        name: opts.name,
        clientType: normalizeType(opts.type),
        email: opts.email,
      };
      if (opts.phone) input.phone = opts.phone;

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
