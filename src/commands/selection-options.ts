import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import {
  GET_SELECTION_WITH_MONITOR,
  GET_BLUEPRINT_MONITOR,
  REFRESH_SELECTION_OPTIONS,
  GET_HOTEL_OPTION_DATA,
} from "../queries.js";
import { deriveRoomStay, type RoomStay } from "../hotel-format.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import {
  classifySelection,
  isTerminal,
  type SelectionState,
  type SelectionStatusResult,
} from "../selection-status.js";
import { deriveChosen, deriveBlockedOn, type RawTravellerChoice, type RawSelectionInput } from "../choices.js";
import { startSpinner } from "../spinner.js";

// Re-exported so downstream consumers (and specs) keep one import site.
export { deriveChosen, deriveBlockedOn };

interface RawOption {
  id: string;
  name: string;
  price?: number | null;
  time?: string | null;
  airline?: string | null;
  duration?: string | null;
  sortOrder?: number | null;
}

interface RawSelection {
  __typename: string;
  id: string;
  type?: string | null;
  blueprintMonitorId?: string | null;
  parentOptionId?: string | null;
  travellerOptionChoices?: RawTravellerChoice[] | null;
  inputs?: RawSelectionInput[] | null;
  options?: RawOption[] | null;
}

interface RawMonitor {
  id: string;
  type?: string | null;
  queryVersion?: number | null;
  fetchedAt?: string | null;
  lastFetchAttempt?: string | null;
  lastFetchError?: string | null;
}

/** Fetch a selection + (if it has one) its monitor, then classify. Pure I/O + classify. */
async function loadSelectionState(
  selectionId: string,
  retryAfterMs: number,
): Promise<{ raw: RawSelection; result: SelectionStatusResult }> {
  const data = await graphql<{ getTripPlanSelection: RawSelection | null }>(
    GET_SELECTION_WITH_MONITOR,
    { tripPlanSelectionId: selectionId },
  );
  const raw = data.getTripPlanSelection;
  if (!raw || !raw.id) {
    throw new CliError(CliErrorCode.NOT_FOUND, `Selection ${selectionId} not found.`);
  }

  let monitor: RawMonitor | null = null;
  if (raw.blueprintMonitorId) {
    try {
      const m = await graphql<{ blueprintMonitor: RawMonitor | null }>(GET_BLUEPRINT_MONITOR, {
        id: raw.blueprintMonitorId,
      });
      monitor = m.blueprintMonitor;
    } catch {
      // Monitor read is best-effort; absence just means we can't refine FETCHING vs NO_RESULTS.
      monitor = null;
    }
  }

  const state: SelectionState = {
    id: raw.id,
    type: raw.type,
    blueprintMonitorId: raw.blueprintMonitorId,
    optionCount: (raw.options ?? []).length,
    monitor: monitor
      ? {
          id: monitor.id,
          fetchedAt: monitor.fetchedAt,
          lastFetchAttempt: monitor.lastFetchAttempt,
          lastFetchError: monitor.lastFetchError,
        }
      : null,
  };

  return { raw, result: classifySelection(state, { retryAfterMs }) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * VOY-1724: room/rate options carry a nightly rate breakdown + check-in/out
 * dates in their `optionData`. Fetch it via a targeted secondary query (kept
 * out of the lean monitor query so flight lists aren't bloated) and derive a
 * "N nights · $total (~$/nt incl. tax)" label per option. Best-effort: any
 * failure returns an empty map and the breakdown is silently skipped. Raw
 * optionData is extracted-then-discarded — never emitted.
 */
async function loadRoomStays(selectionId: string): Promise<Map<string, RoomStay>> {
  const stays = new Map<string, RoomStay>();
  try {
    const res = await graphql<{
      getTripPlanSelection: { options?: { id: string; optionData?: unknown }[] | null } | null;
    }>(GET_HOTEL_OPTION_DATA, { tripPlanSelectionId: selectionId });
    for (const o of res.getTripPlanSelection?.options ?? []) {
      const stay = deriveRoomStay(o.optionData);
      if (stay) stays.set(o.id, stay);
    }
  } catch {
    // Best-effort — no breakdown shown.
  }
  return stays;
}

export function registerSelectionOptionsCommands(program: Command): void {
  program
    .command("selection-options <selectionId>")
    .description(
      "Show a selection's options with an explicit fetch status (READY / FETCHING / AWAITING_INPUT / NO_RESULTS / FETCH_ERROR). Use --wait to poll an async fetch to completion.",
    )
    .option("--json", "Output raw JSON")
    .option("--wait", "Refresh + poll with backoff until options are ready or a terminal status is reached")
    .option("--timeout <seconds>", "Max seconds to wait when --wait is set (default 30)", "30")
    .option("--human", "Force human-readable output")
    .action(async (selectionId: string, opts) => {
      const retryAfterMs = 2000;
      // Parse THEN clamp: an explicit `--timeout 0` must clamp to 1s (consistent
      // with the Math.max floor), not silently revert to the 30s default via `|| 30`.
      const parsedTimeout = parseInt(opts.timeout, 10);
      const timeoutMs = Math.max(1, Number.isNaN(parsedTimeout) ? 30 : parsedTimeout) * 1000;
      // Agent-first: default to JSON unless --human is explicitly requested.
      const asJson = opts.json || !opts.human;

      try {
        let { raw, result } = await loadSelectionState(selectionId, retryAfterMs);

        if (opts.wait && !isTerminal(result.status)) {
          // Kick a refresh (no-op server-side if not auto-fetchable), then poll.
          try {
            await graphql(REFRESH_SELECTION_OPTIONS, { selectionId });
          } catch {
            // Refresh failure isn't fatal — polling will reflect real monitor state.
          }

          const startedAt = Date.now();
          const deadline = startedAt + timeoutMs;
          let delay = retryAfterMs;
          // Spinner on stderr so the poll loop is never a silent black box, while
          // --json stdout stays clean (VOY-1437). On a TTY it animates in place;
          // piped/CI it degrades to one line per DISTINCT label — and since each
          // poll's label carries a rising attempt/elapsed count, every poll still
          // emits a heartbeat line (the non-TTY dedupe never swallows them).
          let attempt = 0;
          const spinner = startSpinner("Fetching options…");
          try {
            while (!isTerminal(result.status) && Date.now() < deadline) {
              const remaining = deadline - Date.now();
              await sleep(Math.min(delay, Math.max(0, remaining)));
              ({ raw, result } = await loadSelectionState(selectionId, retryAfterMs));
              attempt++;
              const elapsed = Math.round((Date.now() - startedAt) / 1000);
              spinner.update(
                `Fetching options… (attempt ${attempt}, status=${result.status}, options=${result.optionCount}, ${elapsed}s)`,
              );
              delay = Math.min(delay * 1.5, 8000); // exponential backoff, capped
            }
          } finally {
            spinner.stop();
          }

          if (!isTerminal(result.status)) {
            // Ran out of time still FETCHING — report honestly, never hang or lie-empty.
            result = { ...result, status: "FETCHING", retryAfterMs };
          }
        }

        const sortedOptions = [...(raw.options ?? [])].sort(
          (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
        );

        const { chosenOptionId, consensus } = deriveChosen(raw);
        const travellerChoices = (raw.travellerOptionChoices ?? []).map((c) => ({
          travellerId: c.traveller?.id ?? null,
          travellerName: [c.traveller?.firstName, c.traveller?.lastName].filter(Boolean).join(" ") || null,
          optionId: c.selectedOption?.id ?? null,
          scope: c.scope ?? null,
        }));

        const blockedOn = result.status === "AWAITING_INPUT" ? deriveBlockedOn(raw) : [];

        // VOY-1724: for room/rate selections, derive the nights × rate breakdown
        // (secondary optionData fetch). Skipped silently for other types.
        const roomStays = (raw.type ?? "").startsWith("HotelRoom")
          ? await loadRoomStays(raw.id)
          : new Map<string, RoomStay>();

        if (asJson) {
          jsonOutput({
            selectionId: raw.id,
            type: raw.type ?? null,
            status: result.status,
            optionCount: result.optionCount,
            // Honesty rule (VOY-1703): when AWAITING_INPUT, name the missing
            // inputs; blockedOnUnavailable=true means the API did not identify
            // them (never a bare null).
            ...(result.status === "AWAITING_INPUT"
              ? { blockedOn, ...(blockedOn.length === 0 ? { blockedOnUnavailable: true } : {}) }
              : {}),
            ...(result.retryAfterMs != null && result.status === "FETCHING"
              ? { retryAfterMs: result.retryAfterMs }
              : {}),
            ...(result.fetchError ? { fetchError: result.fetchError } : {}),
            ...(result.staleWarning ? { staleWarning: true } : {}),
            blueprintMonitorId: raw.blueprintMonitorId ?? null,
            chosenOptionId,
            // Per-traveller picks (participant-choice model). consensus=false
            // means travellers picked different options OR some have not picked
            // yet — inspect travellerChoices to tell which.
            consensus,
            ...(travellerChoices.length > 0 ? { travellerChoices } : {}),
            options: sortedOptions.map((o) => {
              const stay = roomStays.get(o.id);
              return {
                id: o.id,
                name: o.name,
                price: o.price ?? null,
                time: o.time ?? null,
                airline: o.airline ?? null,
                duration: o.duration ?? null,
                // VOY-1724 additive: nights × rate breakdown for room/rate options.
                ...(stay ? { stay: { nights: stay.nights, total: stay.total, perNight: stay.perNight } } : {}),
              };
            }),
          });
          return;
        }

        // Human output
        const badge = statusBadge(result.status);
        console.log(chalk.bold(`\n  Selection ${raw.type ? chalk.cyan(raw.type) + " " : ""}${chalk.dim(raw.id)}`));
        console.log(`  Status: ${badge}  (${result.optionCount} option${result.optionCount === 1 ? "" : "s"})`);
        if (result.fetchError) {
          console.log(chalk.yellow(`  ${result.staleWarning ? "Last refresh errored" : "Fetch error"}: ${result.fetchError}`));
        }
        if (result.status === "AWAITING_INPUT") {
          if (blockedOn.length > 0) {
            console.log(chalk.yellow(`  Blocked on: ${blockedOn.map((b) => b.fieldLabel ?? b.fieldName).join(", ")}`));
            console.log(chalk.dim(`  Set the missing input(s), or check the owning goal: voyagier plans goal <goalId>`));
          } else {
            console.log(chalk.dim(`  A required input is missing (the API did not identify which). Check the owning goal: voyagier plans goal <goalId>`));
          }
        }
        if (result.status === "FETCHING") {
          console.log(chalk.dim(`  Still fetching. Re-run with --wait, or retry in ~${Math.round((result.retryAfterMs ?? 2000) / 1000)}s.`));
        }
        if (sortedOptions.length > 0) {
          console.log();
          for (const o of sortedOptions) {
            const price = o.price != null ? chalk.green(` · $${o.price}`) : "";
            const chosen = chosenOptionId === o.id ? chalk.green(" ✓") : "";
            console.log(`    ${chalk.white(o.name)}${price}${chosen}`);
            const stay = roomStays.get(o.id);
            if (stay) console.log(chalk.dim(`      ${stay.label}`));
            console.log(chalk.dim(`      ${o.id}`));
          }
        }
        if (travellerChoices.length > 0 && !consensus) {
          const distinct = new Set(travellerChoices.filter((c) => c.optionId).map((c) => c.optionId));
          const label = distinct.size > 1
            ? "Travellers have picked DIFFERENT options:"
            : "Not all travellers have picked yet:";
          console.log(chalk.yellow(`\n  ${label}`));
          for (const c of travellerChoices) {
            console.log(chalk.dim(`    ${c.travellerName ?? c.travellerId}: ${c.optionId ?? "— (no pick)"}`));
          }
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load selection options: ${message}`);
      }
    });
}

function statusBadge(status: SelectionStatusResult["status"]): string {
  switch (status) {
    case "READY":
      return chalk.green("READY");
    case "FETCHING":
      return chalk.yellow("FETCHING");
    case "AWAITING_INPUT":
      return chalk.yellow("AWAITING_INPUT");
    case "NO_RESULTS":
      return chalk.dim("NO_RESULTS");
    case "FETCH_ERROR":
      return chalk.red("FETCH_ERROR");
    default:
      return status;
  }
}
