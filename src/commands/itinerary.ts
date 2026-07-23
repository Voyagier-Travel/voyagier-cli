/**
 * Itinerary command (v2.0.0).
 *
 * Reads the FROZEN `tripPlanEvents` resolver introduced in #282. Replaces the
 * v1.x assumption that itinerary data lived on `TripPlanItem.{startTime,endTime,day,date}`
 * (those columns were dropped in #386).
 *
 * Surface:
 *   voyagier itinerary <planId> [--day <n>] [--from <date>] [--to <date>]
 *                               [--type flight|hotel|activity|...] [--json]
 *
 * Filtering:
 *   - `--day <n>` is 1-indexed, relative to plan.startDate
 *   - `--from`/`--to` use ISO date strings (YYYY-MM-DD)
 *   - `--type` filters via `event.metadata.{type,eventType,selectionType,kind}` if present
 *     (best-effort; metadata blob is not strictly typed in the schema yet — flagged as
 *     P3 question for Mark sync)
 *
 * All filtering happens client-side because the schema doesn't expose typed filter args
 * on `tripPlanEvents` yet. If/when it does, we'll switch to server-side filtering.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput, fatal } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { GET_TRIP_PLAN_EVENTS } from "../queries.js";
import { validateDate, deriveBaseUrl } from "../utils.js";
import { resolvePlanArg } from "../resolve-plan-arg.js";
import { getApiUrl } from "../config.js";

export interface TripPlanEventLocation {
  name?: string | null;
  address?: string | null;
  placeId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TripPlanEvent {
  name?: string | null;
  datetime?: string | null;
  localTime?: string | null;
  duration?: string | null;
  description?: string | null;
  location?: TripPlanEventLocation | null;
  metadata?: Record<string, unknown> | null;
}

export interface TripPlanWithEvents {
  id: string;
  title: string;
  startDate?: string | null;
  endDate?: string | null;
  tripPlanEvents: TripPlanEvent[] | null;
}

/**
 * Compute a 1-indexed day number for an event relative to the plan start date.
 * Returns null if either date is missing or unparseable.
 *
 * Exported for unit testing.
 */
export function computeDayNumber(eventDatetime: string | null | undefined, planStart: string | null | undefined): number | null {
  if (!eventDatetime || !planStart) return null;
  const event = new Date(eventDatetime);
  const start = new Date(planStart);
  if (isNaN(event.getTime()) || isNaN(start.getTime())) return null;
  // Compare on UTC date boundaries (ignores intra-day time)
  const eventDay = Date.UTC(event.getUTCFullYear(), event.getUTCMonth(), event.getUTCDate());
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const diffMs = eventDay - startDay;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Best-effort extraction of an event's "type" classifier from its metadata blob.
 * The schema doesn't formally expose this; it lives in `metadata: JSON` per the
 * audit. Try common keys; return null if none found.
 *
 * Exported for unit testing.
 */
export function extractEventType(event: TripPlanEvent): string | null {
  const meta = event.metadata;
  if (!meta || typeof meta !== "object") return null;
  for (const key of ["type", "eventType", "selectionType", "kind"]) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Normalize a free-text type filter to a canonical lower-case value for comparison.
 */
function normalizeTypeFilter(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Apply all filters to the event list. Pure function; exported for testing.
 */
export function filterEvents(
  events: TripPlanEvent[],
  planStart: string | null | undefined,
  filters: {
    day?: number;
    from?: string;
    to?: string;
    type?: string;
  }
): TripPlanEvent[] {
  let out = events;

  if (filters.day !== undefined) {
    out = out.filter((e) => computeDayNumber(e.datetime, planStart) === filters.day);
  }
  if (filters.from !== undefined) {
    const fromMs = new Date(filters.from + "T00:00:00Z").getTime();
    out = out.filter((e) => {
      if (!e.datetime) return false;
      return new Date(e.datetime).getTime() >= fromMs;
    });
  }
  if (filters.to !== undefined) {
    // Inclusive end-of-day
    const toMs = new Date(filters.to + "T23:59:59.999Z").getTime();
    out = out.filter((e) => {
      if (!e.datetime) return false;
      return new Date(e.datetime).getTime() <= toMs;
    });
  }
  if (filters.type !== undefined) {
    const target = normalizeTypeFilter(filters.type);
    out = out.filter((e) => {
      const t = extractEventType(e);
      return t !== null && t.toLowerCase() === target;
    });
  }

  // Sort by datetime ascending (the resolver should already do this, but guarantee it)
  return [...out].sort((a, b) => {
    const at = parseTimestamp(a.datetime);
    const bt = parseTimestamp(b.datetime);
    if (at === null && bt === null) {
      // Both missing/unparseable → tiebreak by name to keep ordering stable
      return (a.name ?? "").localeCompare(b.name ?? "");
    }
    if (at === null) return 1;   // missing dates sort to the end
    if (bt === null) return -1;
    return at - bt;
  });
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function planUrl(planId: string): string {
  return `${deriveBaseUrl(getApiUrl())}/plans/${planId}`;
}

function formatEventLine(e: TripPlanEvent, planStart: string | null | undefined): string {
  const dayNum = computeDayNumber(e.datetime, planStart);
  const dayBadge = dayNum !== null ? chalk.cyan(`Day ${dayNum}`) : chalk.dim("—");
  const time = e.localTime ?? e.datetime ?? "";
  const timeStr = time ? chalk.dim(time.slice(0, 16).replace("T", " ")) : "";
  const name = chalk.bold(e.name ?? "(unnamed event)");
  const loc = e.location?.name ? chalk.dim(` @ ${e.location.name}`) : "";
  const type = extractEventType(e);
  const typeBadge = type ? chalk.magenta(`[${type}]`) + " " : "";
  return `  ${dayBadge}  ${timeStr}  ${typeBadge}${name}${loc}`;
}

export function registerItineraryCommand(program: Command): void {
  program
    .command("itinerary [planId]")
    .description("Show the computed itinerary for a trip plan (sourced from tripPlanEvents)")
    .option("--day <n>", "Filter to a specific day (1-indexed, relative to plan start)")
    .option("--from <date>", "Filter events on or after this date (YYYY-MM-DD)")
    .option("--to <date>", "Filter events on or before this date (YYYY-MM-DD)")
    .option("--type <type>", "Filter by event type (best-effort; reads event.metadata.{type,eventType,selectionType,kind})")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts) => {
      const planId = resolvePlanArg(planIdInput, opts, "itinerary");
      // Validate flags
      let dayFilter: number | undefined;
      if (opts.day !== undefined) {
        const n = parseInt(opts.day, 10);
        if (isNaN(n) || n < 1) {
          fatal(`Invalid --day "${opts.day}". Must be a positive integer (1-indexed).`);
        }
        dayFilter = n;
      }
      if (opts.from !== undefined) validateDate(opts.from, "--from");
      if (opts.to !== undefined) validateDate(opts.to, "--to");

      const data = await graphql<{ tripPlan: TripPlanWithEvents | null }>(
        GET_TRIP_PLAN_EVENTS,
        { id: planId }
      );

      if (!data.tripPlan) {
        throw new CliError(
          CliErrorCode.NOT_FOUND,
          `Trip plan "${planId}" not found.\n  Fix: voyagier plans list --json`
        );
      }

      const plan = data.tripPlan;
      const allEvents = plan.tripPlanEvents ?? [];
      const filtered = filterEvents(allEvents, plan.startDate, {
        day: dayFilter,
        from: opts.from,
        to: opts.to,
        type: opts.type,
      });

      // Compute day range for context
      const dayNums = filtered
        .map((e) => computeDayNumber(e.datetime, plan.startDate))
        .filter((d): d is number => d !== null);
      const dayRange =
        dayNums.length > 0
          ? { first: Math.min(...dayNums), last: Math.max(...dayNums) }
          : null;

      if (opts.json) {
        jsonOutput({
          ok: true,
          data: {
            events: filtered,
            total: filtered.length,
            totalUnfiltered: allEvents.length,
            dayRange,
          },
          planContext: {
            planId: plan.id,
            title: plan.title,
            url: planUrl(plan.id),
            startDate: plan.startDate ?? null,
            endDate: plan.endDate ?? null,
          },
        });
        return;
      }

      // Human output
      console.log(`\n${chalk.bold(plan.title)}  ${chalk.dim(`(${plan.id})`)}`);
      if (plan.startDate || plan.endDate) {
        console.log(chalk.dim(`  ${plan.startDate ?? "?"} → ${plan.endDate ?? "?"}`));
      }
      console.log("");

      if (filtered.length === 0) {
        if (allEvents.length === 0) {
          console.log(chalk.dim("  No events on this plan yet."));
          console.log(chalk.dim("  Add some via: voyagier search activities --plan <id> ..."));
        } else {
          console.log(chalk.dim(`  No events match your filters. (${allEvents.length} total events on the plan.)`));
        }
        return;
      }

      // Group by day for readability
      const byDay = new Map<number | null, TripPlanEvent[]>();
      for (const e of filtered) {
        const d = computeDayNumber(e.datetime, plan.startDate);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d)!.push(e);
      }
      const dayKeys = [...byDay.keys()].sort((a, b) => {
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b;
      });

      for (const day of dayKeys) {
        const dayEvents = byDay.get(day)!;
        const header = day !== null ? chalk.cyan.bold(`Day ${day}`) : chalk.dim("Unscheduled");
        console.log(`${header}  ${chalk.dim(`(${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"})`)}`);
        for (const e of dayEvents) {
          console.log(formatEventLine(e, plan.startDate));
        }
        console.log("");
      }

      console.log(chalk.dim(`  ${filtered.length} of ${allEvents.length} event${allEvents.length === 1 ? "" : "s"} shown.`));
      console.log(chalk.dim(`  Plan: ${planUrl(plan.id)}`));
    });
}
