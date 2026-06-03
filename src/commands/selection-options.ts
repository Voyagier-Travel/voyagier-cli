import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import {
  GET_SELECTION_WITH_MONITOR,
  GET_BLUEPRINT_MONITOR,
  REFRESH_SELECTION_OPTIONS,
} from "../queries.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import {
  classifySelection,
  isTerminal,
  type SelectionState,
  type SelectionStatusResult,
} from "../selection-status.js";

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
      const timeoutMs = Math.max(1, parseInt(opts.timeout, 10) || 30) * 1000;
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

          const deadline = Date.now() + timeoutMs;
          let delay = retryAfterMs;
          while (!isTerminal(result.status) && Date.now() < deadline) {
            const remaining = deadline - Date.now();
            await sleep(Math.min(delay, Math.max(0, remaining)));
            ({ raw, result } = await loadSelectionState(selectionId, retryAfterMs));
            delay = Math.min(delay * 1.5, 8000); // exponential backoff, capped
          }

          if (!isTerminal(result.status)) {
            // Ran out of time still FETCHING — report honestly, never hang or lie-empty.
            result = { ...result, status: "FETCHING", retryAfterMs };
          }
        }

        const sortedOptions = [...(raw.options ?? [])].sort(
          (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
        );

        if (asJson) {
          jsonOutput({
            selectionId: raw.id,
            type: raw.type ?? null,
            status: result.status,
            optionCount: result.optionCount,
            ...(result.retryAfterMs != null && result.status === "FETCHING"
              ? { retryAfterMs: result.retryAfterMs }
              : {}),
            ...(result.fetchError ? { fetchError: result.fetchError } : {}),
            ...(result.staleWarning ? { staleWarning: true } : {}),
            blueprintMonitorId: raw.blueprintMonitorId ?? null,
            chosenOptionId: raw.parentOptionId ?? null,
            options: sortedOptions.map((o) => ({
              id: o.id,
              name: o.name,
              price: o.price ?? null,
              time: o.time ?? null,
              airline: o.airline ?? null,
              duration: o.duration ?? null,
            })),
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
          console.log(chalk.dim(`  A required input is missing. Check the owning goal: voyagier plans goal <goalId>`));
        }
        if (result.status === "FETCHING") {
          console.log(chalk.dim(`  Still fetching. Re-run with --wait, or retry in ~${Math.round((result.retryAfterMs ?? 2000) / 1000)}s.`));
        }
        if (sortedOptions.length > 0) {
          console.log();
          for (const o of sortedOptions) {
            const price = o.price != null ? chalk.green(` · $${o.price}`) : "";
            const chosen = raw.parentOptionId === o.id ? chalk.green(" ✓") : "";
            console.log(`    ${chalk.white(o.name)}${price}${chosen}`);
            console.log(chalk.dim(`      ${o.id}`));
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
