import chalk from "chalk";
import { graphql } from "../api.js";
import { CREATE_TRIP_PLAN, ADD_TRIP_PLAN_TRAVELLERS } from "../queries.js";
import { shellArg } from "../utils.js";
import { progress } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { resolveClient } from "./clients.js";

/**
 * The goal graphs the server can scaffold. Wire values, passed straight through
 * as the `template` on createTripPlan.
 *
 * These replace the old --one-way/--flight-only/--hotel-only flags and the
 * client-side scaffold-then-prune they drove: the CLI used to create the full
 * round-trip + hotel graph and then delete the goals the brief did not want,
 * with six conflict rules between the three flags. The server now builds the
 * requested shape directly, so the wrong-shape failure mode (an unpruned return
 * leg blocking one-way inventory and fare carting) cannot happen halfway.
 */
export const TRIP_PLAN_TEMPLATES = [
  "Blank",
  "RoundTripFlight",
  "RoundTripFlightAndHotel",
  "OneWayFlight",
  "OneWayFlightAndHotel",
  "HotelOnly",
] as const;

export type TripPlanTemplate = (typeof TRIP_PLAN_TEMPLATES)[number];

/** Case-insensitive lookup so `--template hotelonly` works. */
const TEMPLATE_BY_LOWER = new Map<string, TripPlanTemplate>(
  TRIP_PLAN_TEMPLATES.map(t => [t.toLowerCase(), t]),
);

export interface TemplateFlags {
  template?: string;
  /** @deprecated superseded by --template */
  oneWay?: boolean;
  /** @deprecated superseded by --template */
  flightOnly?: boolean;
  /** @deprecated superseded by --template */
  hotelOnly?: boolean;
  plan?: string;
}

/**
 * Resolve the template from `--template` or the deprecated shape flags.
 * Returns undefined to let the server apply its default. Pure for testability.
 *
 * The legacy flags are kept as aliases so existing scripts keep working for one
 * release: they map onto the equivalent template and emit a deprecation warning
 * (the caller decides whether to print it, so this stays pure).
 */
export function resolveTemplate(opts: TemplateFlags): {
  template?: TripPlanTemplate;
  deprecationWarning?: string;
} {
  const legacy = !!(opts.oneWay || opts.flightOnly || opts.hotelOnly);

  if (opts.template) {
    const match = TEMPLATE_BY_LOWER.get(opts.template.trim().toLowerCase());
    if (!match) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `Unknown --template "${opts.template}". Choose one of: ${TRIP_PLAN_TEMPLATES.join(", ")}.`,
      );
    }
    if (legacy) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        "--template replaces --one-way/--flight-only/--hotel-only. Pass the template alone.",
      );
    }
    return { template: match };
  }

  if (!legacy) return {};

  if (opts.plan) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "--one-way/--flight-only/--hotel-only only apply when creating a NEW plan. For an existing plan, change goals directly: `voyagier plans goals <planId>` then `voyagier plans goal-remove <goalId> --force`.",
    );
  }
  if (opts.hotelOnly && (opts.flightOnly || opts.oneWay)) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      "--hotel-only conflicts with the flight flags (a hotel-only trip has no flights). Prefer --template HotelOnly.",
    );
  }

  // hotel-only → no flights. one-way → a single outbound leg. flight-only drops
  // the hotel. Anything else keeps the round trip.
  const template: TripPlanTemplate = opts.hotelOnly
    ? "HotelOnly"
    : opts.oneWay
      ? opts.flightOnly
        ? "OneWayFlight"
        : "OneWayFlightAndHotel"
      : "RoundTripFlight";

  const used = [
    opts.oneWay ? "--one-way" : null,
    opts.flightOnly ? "--flight-only" : null,
    opts.hotelOnly ? "--hotel-only" : null,
  ].filter(Boolean).join(" ");

  return {
    template,
    deprecationWarning: `${used} is deprecated — use \`--template ${template}\` instead. The old flags will be removed in a future release.`,
  };
}

/**
 * Parse a comma-separated traveller-name list into { firstName, lastName }
 * pairs. A single-token name uses that token for both fields (matching the
 * historical plan-trip behavior).
 */
export function parseTravellers(names: string): Array<{ firstName: string; lastName: string }> {
  return names.split(",")
    .map(name => name.trim())
    .filter(Boolean)
    .map(name => {
      const parts = name.split(/\s+/);
      if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
      return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
    });
}

/**
 * Add a comma-separated list of traveller names to a plan and return their
 * new ids. Shared by scaffoldPlan (the create path) and plan-trip's existing
 * `--plan` path so both add travellers identically. Emits an "Adding
 * travellers..." progress line unless `quiet` or `progress:false`.
 */
export async function addTravellers(
  tripPlanId: string,
  names: string,
  opts?: { quiet?: boolean; progress?: boolean },
): Promise<string[]> {
  const parsed = parseTravellers(names);
  if (parsed.length === 0) return [];
  if (!opts?.quiet && opts?.progress !== false) progress("Adding travellers...");
  // One call for the whole party: the server reuses anyone already on the plan
  // (so naming an INDIVIDUAL client cannot duplicate them) and checks the
  // traveller cap against the whole batch before writing any of it.
  const data = await graphql<{ addTripPlanTravellers: { id: string }[] }>(
    ADD_TRIP_PLAN_TRAVELLERS,
    { tripPlanId, travellers: parsed.map(t => ({ ...t, type: "Adult" })) },
  );
  return data.addTripPlanTravellers.map(t => t.id);
}

export interface ScaffoldOptions {
  /** Client id | name | email (resolveClient semantics). */
  client?: string;
  title: string;
  /** Comma-separated traveller names (parseTravellers format). */
  travellers?: string;
  /** Goal graph to scaffold. Omit to take the server's default (round trip + hotel). */
  template?: TripPlanTemplate;
  /** Suppress progress output + the auto-resolved-client note (for --json callers). */
  quiet?: boolean;
  /**
   * Set false to suppress progress lines only, keeping the auto-resolved-client
   * note (unless quiet). `plans create` uses this: its pre-VOY-1763 contract
   * always wrote the note to stderr (even under --json) but never progress.
   */
  progress?: boolean;
  /** Print the createTripPlan mutation instead of executing (mirrors --dry-run). */
  dryRun?: boolean;
  /**
   * When true, resolveClient shows an interactive picker on MULTIPLE_CLIENTS
   * instead of throwing (VOY-1762). Callers pass the result of isInteractive()
   * here — never a global guess.
   */
  interactive?: boolean;
  /**
   * Flags the caller already typed, carried forward into the MULTIPLE_CLIENTS
   * retry hint (e.g. `--title 'Paris'`). Surfaces only in the non-interactive
   * error text.
   */
  clientHintFlags?: string;
}

/** Three-letter month abbreviations for generated titles. */
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a `YYYY-MM-DD` string (or, absent/unparseable, `now`) as `Mon YYYY`
 * — e.g. "Aug 2026". `now` is injectable purely so the fallback is testable.
 */
function formatMonthYear(dateStr: string | undefined, now: Date): string {
  let d: Date | null = null;
  const m = dateStr ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim()) : null;
  if (m) {
    const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const parsed = new Date(y, mo - 1, day);
    // Reject calendar overflow (e.g. 2026-02-31 silently becomes Mar 2026):
    // only accept dates that round-trip to the same Y/M/D.
    if (parsed.getFullYear() === y && parsed.getMonth() === mo - 1 && parsed.getDate() === day) d = parsed;
  }
  if (!d) d = now;
  return `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Generate a sensible default trip title for the interactive `--title` prompt
 * (VOY-1762): `<destination> · <Mon YYYY>` when a destination/date is derivable
 * from the args the caller already typed, else `Trip · <Mon YYYY>`.
 *
 * `now` is injectable for deterministic tests; production passes the real clock.
 */
export function generateTripTitle(
  args: { to?: string; hotel?: string; depart?: string; checkin?: string },
  now: Date = new Date(),
): string {
  const destination = (args.to || args.hotel)?.trim();
  const monYear = formatMonthYear(args.depart || args.checkin, now);
  return `${destination || "Trip"} · ${monYear}`;
}

export interface ScaffoldedGoal {
  id: string;
  name?: string | null;
  type: string;
}

export interface ScaffoldResult {
  plan: {
    id: string;
    title: string;
    startDate?: string;
    endDate?: string;
    description?: string | null;
    travellers?: { id: string; firstName?: string | null; lastName?: string | null }[];
    goals?: ScaffoldedGoal[];
  };
  client: { id: string; name: string; autoResolved: boolean; isSelf?: boolean };
  /** IDs of every traveller on the created plan, in plan order. */
  travellerIds: string[];
  /** The goal graph the server scaffolded from the template. */
  goals: ScaffoldedGoal[];
  /** The template applied (undefined when the server default was taken). */
  template?: TripPlanTemplate;
}

/**
 * Create a trip plan shaped to the caller's brief. The single create path shared
 * by `plan-trip` (the canonical creation verb), the `plans create` alias, and
 * `search`'s auto-draft.
 *
 * Steps: resolve client → createTripPlan (template + party in ONE call). The
 * server builds the requested goal graph directly, so there is no prune step and
 * no window in which the plan holds goals the trip does not want.
 *
 * The auto-resolved-client note and progress messages go to stderr and are
 * suppressed when `quiet` is set.
 */
export async function scaffoldPlan(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const chatty = !opts.quiet;

  // Step 1: Resolve the client.
  const resolved = await resolveClient(opts.client, {
    interactive: opts.interactive,
    carryFlags: opts.clientHintFlags,
  });
  if (resolved.autoResolved && chatty) {
    const note = resolved.isSelf
      ? `auto-resolved client: you (${resolved.name}, self)\n`
      : `auto-resolved client: ${resolved.name} (${resolved.id})\n`;
    process.stderr.write(chalk.dim(note));
  }

  // Step 2: Create the plan — template, party and all, in one call.
  //
  // Travellers go in the CREATE rather than a follow-up: passing them makes the
  // list authoritative, so an INDIVIDUAL client is not auto-seeded on top of the
  // names the caller gave (which would put the client on the plan twice), and
  // the traveller cap is checked before the plan row exists.
  if (chatty && opts.progress !== false) progress("Creating trip plan...");
  const parsedTravellers = opts.travellers ? parseTravellers(opts.travellers) : [];
  const planInput: Record<string, unknown> = {
    clientId: resolved.id,
    title: opts.title,
    ...(opts.template ? { template: opts.template } : {}),
    ...(parsedTravellers.length > 0
      ? { travellers: parsedTravellers.map(t => ({ ...t, type: "Adult" })) }
      : {}),
  };
  const planData = await graphql<{ createTripPlan: ScaffoldResult["plan"] }>(
    CREATE_TRIP_PLAN,
    { input: planInput },
    { dryRun: opts.dryRun },
  );
  const plan = planData.createTripPlan;

  return {
    plan,
    client: { id: resolved.id, name: resolved.name, autoResolved: resolved.autoResolved, isSelf: resolved.isSelf },
    // Every traveller on the plan, not just the ones named here: an INDIVIDUAL
    // client is seeded at creation, and a named traveller matching someone
    // already present is reused rather than added.
    travellerIds: (plan.travellers ?? []).map(t => t.id),
    goals: plan.goals ?? [],
    template: opts.template,
  };
}
