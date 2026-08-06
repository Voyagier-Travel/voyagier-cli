import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getHomeAirports } from "../config.js";
import {
  GET_TRAVELLERS_BRIEF,
  CREATE_FLIGHT_SELECTION,
  GET_TRIP_PLAN_ITEM_TYPES,
  DELETE_TRIP_PLAN_ITEM,
  CREATE_HOTEL_SELECTION,
  CREATE_ACTIVITY_SELECTION,
  GET_DECISION_SELECTION_OPTIONS,
  GET_SELECTION_MONITOR_ID,
  GET_MONITOR_SEED_COUNT,
} from "../queries.js";
import {
  loadGoals,
  resolveGoal,
  resolveMirrorList,
  resolveDecisionSelection,
  setAirport,
  addDateOption,
  resolveDateRange,
  requireAirports,
  resolveReturnFlightGoal,
  requireDateSelection,
  setDestination,
  diffSearchParams,
  formatReuseWarning,
} from "./search-helpers.js";
import { saveSearchState, loadSearchState, getSelectionSearchParams, rememberSelectionSearchParams } from "../state.js";
import type { SearchState, SelectionSearchParams } from "../state.js";
import { formatFlights, formatHotels, formatActivities } from "../formatters.js";
import { extractFlightToken, buildFlightSummary, buildHotelSummary, buildActivitySummary, validateDate, warnPastDate, validateIata, looksLikeAirportCode, shellArg } from "../utils.js";
import { clientPlanUrl, planUrls } from "../plan-urls.js";
import { agentFlightOptions, agentHotelOptions, agentActivityOptions } from "../agent-output.js";
import { deriveHotelStay, hotelFactsFields } from "../hotel-format.js";
import { flightProjectionFields, extractRankScore, deriveFlightDetail } from "../flight-format.js";
import { searchAirports } from "../data/airports.js";
import { findMetroArea } from "../data/metro-areas.js";
import { CliError, CliErrorCode } from "../errors.js";
import { waitForSelectionOptions } from "../selection-wait.js";
import type { OptionsHeartbeat } from "../selection-wait.js";
import type { SelectionStatusResult } from "../selection-status.js";
import { startSpinner, spinnerAnimates } from "../spinner.js";
import type { SpinnerHandle } from "../spinner.js";
import { isInteractive, promptText } from "../prompt.js";
import { scaffoldPlan, generateTripTitle } from "./scaffold.js";
import type { ShapeFlags } from "./scaffold.js";
import {
  parseClockMinutes,
  parseDurationMinutes,
  stopCount,
  filterFlights,
  filterHotels,
  flightCallouts,
  flightCalloutLine,
  flightFacets,
  hotelCallouts,
  hotelCalloutLine,
  hotelFacets,
} from "./search-refine.js";
import type { FlightFilters, HotelFilters, FilteredToZero, FlightCallouts, HotelCallouts } from "./search-refine.js";

/**
 * Resolve a date flag that used to be a commander `requiredOption` (VOY-1762):
 * return it if present, prompt for it at an interactive TTY, otherwise
 * synthesize commander's original missing-required-option failure via
 * `command.error(...)`. Agents / CI / --json / --agent / --no-input all fall
 * through to that failure.
 *
 * How it surfaces depends on argv (VOY-1829, superseding the VOY-1762
 * byte-identity note for the --json path only): WITHOUT --json it renders as
 * commander's exact text — `error: required option '--date <date>' not
 * specified` — on stderr with an empty stdout; WITH --json in argv the
 * build-program hook routes it to the uniform { error: true, code:
 * "VALIDATION", message } envelope on stdout instead. Exit code is 1 either
 * way. In production (no exitOverride) commander's own `_exit` terminates the
 * process; under test (exitOverride) it throws a CommanderError — same path
 * commander always used.
 */
async function resolveDateOpt(
  current: string | undefined,
  opts: { json?: boolean; agent?: boolean; input?: boolean; noInput?: boolean },
  question: string,
  command: Command,
): Promise<string> {
  if (current) return current;
  if (isInteractive(opts)) {
    const answer = await promptText(question);
    if (answer) return answer;
  }
  command.error("error: required option '--date <date>' not specified", {
    exitCode: 1,
    code: "commander.missingMandatoryOptionValue",
  });
}

interface SelectOption {
  id: string;
  name: string;
  price?: number;
  time?: string;
  airline?: string;
  duration?: string;
  bookingData?: Record<string, unknown>;
  sortOrder: number;
}

interface SelectionResult {
  item: { id: string; title: string; tripPlanId: string };
  selection: { id: string };
  options: SelectOption[];
}

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
}

type SortField = "price" | "duration" | "stops" | "default";

/**
 * Reuse the goal's existing decision selection when present; create one only
 * when the goal has none (VOY-1692).
 *
 * Why reuse is mandatory: the backend validates picks (and resolves options)
 * exactly ONE mirror hop from a selection. The skeleton decision selection is
 * wired 1 hop from the monitor-owned option rows (flights: re-mirrored onto
 * the FlightJourney by createJourneyForLegs). A freshly-created selection
 * mirroring the goal's *List is 2 hops away for flights: its options read
 * empty and every pick fails "Option not found". Creating duplicates also
 * detaches checkout readiness from the selection the agent is operating on.
 */
// Exported for unit testing the reuse/fail-fast contract (VOY-1692).
export async function resolveOrCreateDecisionSelection(
  kind: "flights" | "hotels" | "activities",
  goal: { id: string; name: string; items: { selections: { id: string; type: string | null }[] }[] },
  tripPlanId: string,
  createMutation: string,
  createResultKey: string,
  input: Record<string, unknown>,
  quiet: boolean,
  progress?: (line: string) => void,
): Promise<{ selectionId: string; options: SelectOption[]; reused: boolean }> {
  const existingId = resolveDecisionSelection(goal as never, kind);
  if (existingId) {
    if (!quiet) {
      // When a spinner is live (progress provided), route through it — a raw
      // stderr write mid-animation garbles the current frame in scrollback.
      const line = `Using the goal's existing ${KIND_LABEL[kind]} selection.`;
      if (progress) progress(line);
      else process.stderr.write(chalk.dim(`${line}\n`));
    }
    const data = await graphql<{ getTripPlanSelection: { id?: string; options?: SelectOption[] } | null }>(
      GET_DECISION_SELECTION_OPTIONS,
      { tripPlanSelectionId: existingId },
    );
    if (!data.getTripPlanSelection) {
      // Fail fast: an empty-options response would read as "still fetching"
      // and send the caller off to poll a selection that no longer exists.
      throw new CliError(
        CliErrorCode.API_ERROR,
        `The goal's ${KIND_LABEL[kind]} selection ${existingId} could not be loaded (stale goal graph or deleted selection). ` +
          `Re-check the plan structure with: voyagier plans goals ${shellArg(tripPlanId)}`,
      );
    }
    return { selectionId: existingId, options: data.getTripPlanSelection.options ?? [], reused: true };
  }
  // Goal has no decision selection (custom / non-skeleton goal) — create one
  // linked to the goal's mirror list, the pre-VOY-1692 behaviour.
  const data = await graphql<Record<string, SelectionResult>>(createMutation, { tripPlanId, input });
  const result = data[createResultKey];
  return { selectionId: result.selection.id, options: result.options, reused: false };
}

const KIND_LABEL: Record<string, string> = { flights: "Flight", hotels: "Hotel", activities: "Activity" };

async function resolveTravellerIds(tripPlanId: string): Promise<string[]> {
  const data = await graphql<{ tripPlanTravellers: Traveller[] }>(
    GET_TRAVELLERS_BRIEF,
    { tripPlanId }
  );
  return data.tripPlanTravellers.map((t) => t.id);
}

// Exported for unit testing the --plan validation contract (VOY-1437).
// `lastSearch` lets callers that already read the last-search state pass it in
// (undefined = not read yet, so read here; null = read and absent).
export function resolvePlanId(opts: { plan?: string }, lastSearch?: SearchState | null): string {
  // A passed-but-empty/whitespace --plan is an error, NOT a cue to silently
  // fall back to the last-search plan. Falling back here would run the search
  // against a DIFFERENT plan than the caller named — silent cross-plan
  // contamination. Only a fully OMITTED --plan uses the last-search fallback.
  if (opts.plan !== undefined) {
    const trimmed = opts.plan.trim();
    if (trimmed === "") {
      throw new CliError(
        CliErrorCode.VALIDATION,
        "--plan was given an empty value. Pass a real plan id, or omit --plan to reuse the last-search plan.",
      );
    }
    return trimmed;
  }
  const state = lastSearch !== undefined ? lastSearch : loadSearchState();
  if (state?.tripPlanId) {
    process.stderr.write(
      chalk.yellow(`No --plan given; using plan from last search: ${state.tripPlanId}\n`),
    );
    return state.tripPlanId;
  }
  throw new CliError(CliErrorCode.VALIDATION, '--plan <id> is required. Create one first:\n  voyagier plan-trip --client <id|name|email> --title "My Trip"');
}

/**
 * Resolve the plan a search runs against — OR auto-scaffold a draft one when the
 * user gave neither `--plan` nor has a last-search fallback (VOY-1761).
 *
 * The first two branches are the exact pre-1761 behavior, owned by resolvePlanId
 * (VOY-1437): an explicit `--plan` (empty → error) or a last-search fallback.
 * Only when BOTH are absent — the "first command a new user types" case that used
 * to hard-error `--plan is required` — do we create a draft plan from the search
 * args and proceed as if it had been passed. `--dry-run` must not mutate, so it
 * keeps the old error there. Agents (--json/--agent/--no-input/non-TTY) never
 * prompt but DO still scaffold once the client resolves non-interactively — they
 * are the primary beneficiaries of this ticket.
 */
async function resolvePlanForSearch(
  opts: { plan?: string; client?: string; json?: boolean; agent?: boolean; noInput?: boolean; input?: boolean; dryRun?: boolean },
  scaffold: { title: string; shape: ShapeFlags },
  quiet: boolean,
): Promise<{ tripPlanId: string; scaffolded: boolean }> {
  // Read the last-search state at most once (and, as before, not at all when
  // --plan is given — loadSearchState has side effects on corrupted files).
  const lastSearch = opts.plan === undefined ? loadSearchState() : undefined;
  if (opts.plan !== undefined || lastSearch?.tripPlanId) {
    return { tripPlanId: resolvePlanId(opts, lastSearch), scaffolded: false };
  }
  if (opts.dryRun) {
    // Preserve the pre-1761 hard error under --dry-run (scaffolding would create
    // a real plan, violating dry-run's no-mutation contract).
    return { tripPlanId: resolvePlanId(opts, lastSearch), scaffolded: false };
  }
  const result = await scaffoldPlan({
    client: opts.client,
    title: scaffold.title,
    shape: scaffold.shape,
    ensureGoals: true,
    quiet,
    interactive: isInteractive(opts),
  });
  if (!quiet) {
    process.stderr.write(chalk.cyan(`No plan given — created draft plan ${result.plan.title} (${result.plan.id})\n`));
  }
  return { tripPlanId: result.plan.id, scaffolded: true };
}



/** Stops for sort ordering: unknown sinks to the end (Infinity), like a missing price. */
function parseStops(bookingData?: Record<string, unknown>): number {
  const c = stopCount(bookingData);
  return c == null ? Infinity : c;
}

function sortOptions(options: SelectOption[], sortBy: SortField): SelectOption[] {
  if (sortBy === "default") return options;
  return [...options].sort((a, b) => {
    switch (sortBy) {
      case "price":
        return (a.price ?? Infinity) - (b.price ?? Infinity);
      case "duration":
        return parseDurationMinutes(a.duration) - parseDurationMinutes(b.duration);
      case "stops":
        return parseStops(a.bookingData) - parseStops(b.bookingData);
      default:
        return 0;
    }
  });
}

/**
 * Resolve a user-supplied airport value to an IATA code.
 * Priority: exact IATA code → metro area (shows options) → single city match → ambiguous error.
 * Shows a note if city name was resolved. Throws CliError if ambiguous or unknown.
 */
function resolveAirportInput(value: string, flagName: string, quiet: boolean): string {
  // If it's already a valid 3-letter code, validate and return
  if (/^[A-Za-z]{3}$/.test(value.trim())) {
    validateIata(value, flagName);
    return value.toUpperCase();
  }

  // Check metro areas first — "Washington DC" → show BWI, DCA, IAD as options
  const metro = findMetroArea(value);
  if (metro) {
    if (metro.airports.length === 1) {
      if (!quiet) {
        process.stderr.write(chalk.dim(`Using ${metro.airports[0]} (${metro.name}) for ${flagName}\n`));
      }
      return metro.airports[0];
    }
    // Metro with multiple airports — use the primary (first) but show all
    if (!quiet) {
      process.stderr.write(chalk.dim(`${metro.name} airports: ${metro.airports.join(", ")}\n`));
      process.stderr.write(chalk.dim(`Using ${metro.airports[0]} (primary) for ${flagName}. Specify a code to override.\n`));
    }
    return metro.airports[0];
  }

  // Try to resolve as city name
  const matches = searchAirports(value);
  if (matches.length === 0) {
    throw new CliError(CliErrorCode.VALIDATION, `No airports found for ${flagName}: "${value}"\n  Use a 3-letter IATA code (e.g., LAX) or search: voyagier search airports ${shellArg(value)}`);
  }
  if (matches.length === 1) {
    if (!quiet) {
      process.stderr.write(chalk.dim(`Using ${matches[0].code} (${matches[0].name}) for ${flagName}\n`));
    }
    return matches[0].code;
  }
  // Multiple matches but not a known metro — show them all
  const codes = matches.slice(0, 10).map((m) => m.code).join(", ");
  throw new CliError(CliErrorCode.VALIDATION, `Multiple airports found for ${flagName}: "${value}". Specify a code: ${codes}\n  Run: voyagier search airports ${shellArg(value)} for details`);
}

/**
 * Cap on options shown by default (VOY-1714). The full option dump spreads raw
 * provider `bookingData` — a single flight search measured 2.7 MB of JSON —
 * which scrolls the selectionIds off the top of any terminal/agent buffer and
 * is exactly the oversized-payload shape that poisons LLM transcripts. Default
 * output = ids + counts + top summaries (everything an agent needs to pick);
 * the complete dump stays available behind --full.
 */
const TOP_OPTIONS = 10;

/**
 * Compact `--json` search envelope; `full` restores the complete option dump.
 * `refineHint` lists ONLY the refinement flags the calling subcommand actually
 * supports (`--max-stops` is flights-only; hotels/activities have `--sort`).
 *
 * `facets` (VOY-1784) is an at-a-glance map of the option space (price range,
 * airlines/stops distribution, …) added ONLY to the compact envelope — its whole
 * point is letting an agent choose a refinement without pulling `--full`. It is
 * ADDITIVE: existing fields are never removed or renamed.
 */
function searchJsonBody(
  base: Record<string, unknown>,
  options: Array<Record<string, unknown>>,
  topOptions: Array<Record<string, unknown>>,
  full: boolean | undefined,
  refineHint: string,
  facets?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (full) {
    return { ...base, optionCount: options.length, options: options.map((opt, i) => ({ index: i + 1, ...opt })) };
  }
  return {
    ...base,
    optionCount: options.length,
    topOptions: topOptions.slice(0, TOP_OPTIONS),
    ...(facets && Object.keys(facets).length ? { facets } : {}),
    ...(options.length > TOP_OPTIONS
      ? { note: `Showing top ${TOP_OPTIONS} of ${options.length} options — re-run with --full for the complete dump (large: includes raw provider bookingData), or refine with ${refineHint}.` }
      : {}),
  };
}

/**
 * Total available listings on the selection's blueprint monitor (VOY-1835).
 * The backend intentionally seeds only a shortlist of options into a hotel
 * decision selection; the full result set lives on the monitor. This reads
 * the count so output can be honest about it. Best-effort: any failure (no
 * monitor, field not yet deployed, network) returns null and the envelope
 * simply omits seededFrom — never fails the search.
 */
async function fetchTotalAvailableListings(selectionId: string): Promise<number | null> {
  try {
    const selData = await graphql<{
      getTripPlanSelection: { blueprintMonitorId?: string | null } | null;
    }>(GET_SELECTION_MONITOR_ID, { tripPlanSelectionId: selectionId });
    const monitorId = selData.getTripPlanSelection?.blueprintMonitorId;
    if (!monitorId) return null;
    const monData = await graphql<{
      blueprintMonitor: { totalAvailableListings?: number | null } | null;
    }>(GET_MONITOR_SEED_COUNT, { id: monitorId });
    const n = monData.blueprintMonitor?.totalAvailableListings;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The `seededFrom` envelope block (VOY-1835): emitted only when the monitor
 * holds more available listings than the options shown, so an agent knows the
 * shortlist is a seed, not the market.
 */
function seededFromBlock(shown: number, totalAvailable: number | null): Record<string, unknown> {
  if (totalAvailable == null || totalAvailable <= shown) return {};
  return {
    seededFrom: {
      shown,
      totalAvailable,
      note: `Showing a curated shortlist of ${shown} hotels seeded from ${totalAvailable} available in this market. This is a STARTING shortlist, not the full inventory. To consider more: refine the search (narrow location/dates or add --min-rating/--max-total/--sort) to re-shop, or use \`voyagier listings list --selection <id>\` to browse the full set and \`voyagier listings add-to-selection <id> --listing <listingId>\` to add specific properties.`,
    },
  };
}

/**
 * Parse + validate a numeric flag as a non-negative number, or undefined when
 * absent. Shared by --max-price / --max-total / --min-rating.
 */
function parseNonNegativeNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(CliErrorCode.VALIDATION, `${flag} must be a non-negative number (got "${value}").`);
  }
  return n;
}

/** Parse + validate an HH:MM time flag to minutes-since-midnight, or undefined. */
function parseTimeFlag(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const mins = parseClockMinutes(value);
  if (mins == null) {
    throw new CliError(CliErrorCode.VALIDATION, `${flag} must be a 24-hour HH:MM time (got "${value}").`);
  }
  return mins;
}

/**
 * Build the flight refinement filters from the parsed CLI options, validating
 * each value. `--nonstop` is sugar for `--max-stops 0`; when both are given the
 * stricter (smaller) cap wins. Times reuse the VOY-1783 wall-clock model (no TZ
 * math). Throws CliError(VALIDATION) on any malformed value.
 */
function parseFlightFilters(opts: Record<string, unknown>): FlightFilters {
  let maxStops: number | undefined;
  if (opts.maxStops !== undefined) {
    const n = Number(opts.maxStops);
    if (!Number.isInteger(n) || n < 0) {
      throw new CliError(
        CliErrorCode.VALIDATION,
        `--max-stops must be a non-negative integer (got "${opts.maxStops}").`,
      );
    }
    maxStops = n;
  }
  if (opts.nonstop) maxStops = maxStops === undefined ? 0 : Math.min(maxStops, 0);

  const airlines = Array.isArray(opts.airline)
    ? (opts.airline as string[]).map((a) => {
        const code = String(a).trim().toUpperCase();
        if (!/^[A-Z0-9]{2}$/.test(code)) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            `--airline must be a 2-character carrier IATA code (got "${a}").`,
          );
        }
        return code;
      })
    : undefined;

  return {
    departAfter: parseTimeFlag(opts.departAfter as string | undefined, "--depart-after"),
    departBefore: parseTimeFlag(opts.departBefore as string | undefined, "--depart-before"),
    arriveBy: parseTimeFlag(opts.arriveBy as string | undefined, "--arrive-by"),
    returnDepartAfter: parseTimeFlag(opts.returnDepartAfter as string | undefined, "--return-depart-after"),
    returnDepartBefore: parseTimeFlag(opts.returnDepartBefore as string | undefined, "--return-depart-before"),
    ...(airlines && airlines.length ? { airlines } : {}),
    maxStops,
    maxPrice: parseNonNegativeNumber(opts.maxPrice as string | undefined, "--max-price"),
  };
}

/** Build the hotel refinement filters from the parsed CLI options, validating each. */
function parseHotelFilters(opts: Record<string, unknown>): HotelFilters {
  return {
    minRating: parseNonNegativeNumber(opts.minRating as string | undefined, "--min-rating"),
    maxTotal: parseNonNegativeNumber(opts.maxTotal as string | undefined, "--max-total"),
  };
}

/**
 * When active filters removed EVERY option (but the backend did return some),
 * emit the which-filter attribution + nearest miss. Human/agent get the prose
 * lines; --json gets the structured `filteredToZero` object. Exit stays 0 — an
 * over-tight filter is a user choice, not a CLI failure.
 */
function filteredToZeroJson(zero: FilteredToZero): Record<string, unknown> {
  return {
    filteredToZero: {
      eliminatedBy: zero.eliminatedBy,
      inputCount: zero.inputCount,
      combination: zero.combination,
      detail: zero.detail,
    },
  };
}

/** Prose lines for a filtered-to-zero result (human + agent). */
function filteredToZeroLines(zero: FilteredToZero): string[] {
  const lines: string[] = [];
  const lead = zero.combination
    ? `All ${zero.inputCount} option${zero.inputCount === 1 ? "" : "s"} were filtered out by the combination of active filters:`
    : `All ${zero.inputCount} option${zero.inputCount === 1 ? "" : "s"} were filtered out:`;
  lines.push(lead);
  for (const d of zero.detail) lines.push(`  • ${d.message}`);
  lines.push("Loosen or drop a filter and search again.");
  return lines;
}

/** Structured `callouts` field for flights (omitted when no datum supports one). */
function flightCalloutsJson(c: FlightCallouts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.cheapest) out.cheapest = c.cheapest;
  if (c.fastest && c.fastest.durationLabel) out.fastest = { index: c.fastest.index, duration: c.fastest.durationLabel };
  if (c.earliest) out.earliest = { index: c.earliest.index, departure: c.earliest.departLabel };
  return Object.keys(out).length ? { callouts: out } : {};
}

/** Structured `callouts` field for hotels (cheapest + highest-rated, both factual). */
function hotelCalloutsJson(c: HotelCallouts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.cheapest) out.cheapest = c.cheapest;
  if (c.highestRated) out.highestRated = c.highestRated;
  return Object.keys(out).length ? { callouts: out } : {};
}

/** Hard cap on how long a search waits inline for async inventory (VOY-1780). */
const SEARCH_WAIT_TIMEOUT_MS = 90_000;

/** Cadence for plain-stderr wait heartbeats when the spinner cannot animate. */
const WAIT_HEARTBEAT_MS = 10_000;

/**
 * Build the per-poll heartbeat sink for the inline wait (VOY-1780).
 *
 * When the spinner animates, it updates the spinner label in place. When it
 * cannot — e.g. CI set at an otherwise interactive stderr, so `spinnerAnimates`
 * is false but `shouldWaitInline` still holds — the wait would otherwise be
 * completely silent and the CLI would look hung. In that case fall back to a
 * plain dim stderr line every ~10s (never every poll) so there is visible
 * progress. --json/--agent/non-TTY never reach the inline-wait path
 * (`shouldWaitInline` gates it), so their output stays byte-identical.
 */
function makeWaitHeartbeat(
  label: string,
  waitSpinner: SpinnerHandle | null,
): (h: OptionsHeartbeat) => void {
  let lastBucket = 0;
  return ({ elapsedMs }) => {
    const line = `${label}… fetching inventory (${Math.round(elapsedMs / 1000)}s)`;
    if (waitSpinner) {
      waitSpinner.update(line);
      return;
    }
    // No animation: emit one line per elapsed ~10s window, not per poll.
    const bucket = Math.floor(elapsedMs / WAIT_HEARTBEAT_MS);
    if (bucket > lastBucket) {
      lastBucket = bucket;
      process.stderr.write(chalk.dim(line + "\n"));
    }
  };
}

/**
 * Re-read a decision selection's FULL options (including provider `bookingData`)
 * once the inline wait reports READY. The wait itself reads only the lean
 * monitor query (no bookingData), so we re-fetch through the same query the
 * immediate-results path uses and feed the result into the identical render
 * pipeline (VOY-1780).
 */
async function refetchDecisionOptions(selectionId: string): Promise<SelectOption[]> {
  const data = await graphql<{ getTripPlanSelection: { options?: SelectOption[] } | null }>(
    GET_DECISION_SELECTION_OPTIONS,
    { tripPlanSelectionId: selectionId },
  );
  return data.getTripPlanSelection?.options ?? [];
}

/**
 * Human/TTY inline-wait gate (VOY-1780): wait for async options only at an
 * interactive stderr, when the user hasn't asked for the machine surfaces
 * (--json/--agent) or opted out with --no-wait. Everywhere else the old
 * fire-and-return + poll-pointer behaviour is preserved.
 */
function shouldWaitInline(opts: { json?: boolean; agent?: boolean; wait?: boolean }): boolean {
  return (
    !opts.json &&
    !opts.agent &&
    opts.wait !== false &&
    process.stderr.isTTY === true
  );
}

/**
 * Copy-safe poll hint (VOY-1780): the label and the command live on SEPARATE
 * lines so copying the command line runs the command — not `Poll:`. Written to
 * stderr (stdout stays clean for redirection).
 */
function writePollHint(selectionId: string): void {
  process.stderr.write(chalk.dim("Poll for results with:\n"));
  process.stderr.write(chalk.dim(`  voyagier selection-options ${shellArg(selectionId)} --wait\n`));
}

/**
 * After an inline wait ends without READY options, explain WHY in plain English
 * (never a generic "no options") and, for the transient statuses, hand back a
 * copy-safe resume command. Exit code stays 0 — a slow/emptied fetch is not a
 * CLI failure. Returns nothing; the caller returns after this.
 */
function reportWaitStop(result: SelectionStatusResult, selectionId: string): void {
  switch (result.status) {
    case "FETCHING":
      // Timed out still fetching — the search is fine, inventory is just slow.
      process.stderr.write(
        chalk.yellow("Inventory is still loading on our side — your results will be ready shortly.\n"),
      );
      writePollHint(selectionId);
      break;
    case "FETCH_ERROR":
      process.stderr.write(
        chalk.yellow(
          `The inventory search hit an error while fetching${result.fetchError ? `: ${result.fetchError}` : "."}\n`,
        ),
      );
      writePollHint(selectionId);
      break;
    case "AWAITING_INPUT":
      process.stderr.write(
        chalk.yellow(
          "The search is missing a required input, so no inventory could be fetched. Check the owning goal: voyagier plans goal <goalId>\n",
        ),
      );
      break;
    case "NO_RESULTS":
    default:
      // Handled by callers that add domain-specific suggestions (hotels).
      break;
  }
}

/**
 * VOY-1793 selection-reuse observability.
 *
 * A search reuses the goal's existing decision selection (VOY-1692) rather than
 * refetching, so results can silently reflect the params the selection was
 * ORIGINALLY searched with. This records the params a selection was first
 * searched with and, on reuse, surfaces `effectiveParams` (the original) plus a
 * SELECTION_REUSED_PARAMS_MISMATCH warning when the new request differs. It is
 * pure observability — it never changes what the search does.
 */
interface ReuseObservation {
  requestedParams: SelectionSearchParams;
  effectiveParams?: SelectionSearchParams;
  warnings: string[];
}

function observeSelectionReuse(
  selectionId: string,
  requested: SelectionSearchParams,
): ReuseObservation {
  // No stored record yet → this is the selection's original search: remember it
  // (best-effort) and there is nothing to reconcile against.
  const stored = getSelectionSearchParams(selectionId);
  if (!stored) {
    rememberSelectionSearchParams(selectionId, requested);
    return { requestedParams: requested, warnings: [] };
  }
  const changed = diffSearchParams(stored, requested);
  const warnings = changed.length > 0 ? [formatReuseWarning(changed, stored, requested)] : [];
  return { requestedParams: requested, effectiveParams: stored, warnings };
}

/** Fields injected into the search JSON envelope for reuse observability. */
function reuseEnvelopeFields(obs: ReuseObservation): Record<string, unknown> {
  return {
    requestedParams: obs.requestedParams,
    ...(obs.effectiveParams ? { effectiveParams: obs.effectiveParams } : {}),
    ...(obs.warnings.length > 0 ? { warnings: obs.warnings } : {}),
  };
}

/** Print the ⚠ reuse-mismatch line(s) to stderr for human output (VOY-1793). */
function writeReuseWarnings(warnings: string[]): void {
  for (const w of warnings) process.stderr.write(chalk.yellow(`⚠ ${w}\n`));
}

/**
 * VOY-1871: the origin / destination / date(s) a flight search actually wired
 * into the goal graph — the params IN EFFECT for the searched selection after
 * the search ran, as understood client-side from the inputs it set. Echoed to
 * the envelope as `effectiveParams` so an agent can assert the direction and
 * dates BEFORE selecting an option, rather than trusting whatever rows the
 * (possibly not-yet-refreshed) selection happened to hand back.
 */
interface EffectiveFlightParams {
  origin: string;
  destination: string;
  depart: string;
  return?: string;
}

function effectiveFlightParams(
  origin: string,
  destination: string,
  depart: string,
  ret?: string,
): EffectiveFlightParams {
  return { origin, destination, depart, ...(ret ? { return: ret } : {}) };
}

/** One-line human echo of the effective search, e.g. "Search: LAS → BWI on 2026-12-10". */
function effectiveParamsLine(p: EffectiveFlightParams): string {
  const when = p.return ? `${p.depart} (return ${p.return})` : p.depart;
  return `Search: ${p.origin} → ${p.destination} on ${when}`;
}

/**
 * The outbound origin encoded in a flight option's rows (first leg's origin), or
 * null when the leg data isn't present to read it. Used to detect inventory that
 * still reflects a PREVIOUS search's params (VOY-1871).
 */
function optionOutboundOrigin(opt: SelectOption): string | null {
  return deriveFlightDetail(opt.bookingData)?.origin ?? null;
}

/** The outbound final destination encoded in a flight option's rows, or null. */
function optionOutboundDestination(opt: SelectOption): string | null {
  return deriveFlightDetail(opt.bookingData)?.destination ?? null;
}

/**
 * True when the first option's outbound origin OR destination is KNOWN and
 * differs from the params just wired — i.e. the rows still reflect the previous
 * params and the re-seed triggered by the new inputs has not landed yet.
 * Comparing both endpoints matters: a reused selection whose destination
 * changed (same origin) is just as stale as a reversed direction. A field that
 * can't be read is treated as "can't tell" (never stale on that field), so
 * older/partial payloads never trip a false positive.
 */
function outboundLegStale(
  options: SelectOption[],
  effectiveOrigin: string,
  effectiveDestination: string,
): boolean {
  if (options.length === 0) return false;
  const legOrigin = optionOutboundOrigin(options[0]);
  const legDestination = optionOutboundDestination(options[0]);
  if (legOrigin != null && legOrigin !== effectiveOrigin) return true;
  return legDestination != null && legDestination !== effectiveDestination;
}

/** Bounded re-poll for the stale-inventory refetch (VOY-1871): the selection
 * status can already be terminal (READY) while rows still reflect the previous
 * params, so a status wait alone can return immediately with stale rows. */
export const STALE_REFETCH_ATTEMPTS = 3;
export const STALE_REFETCH_DELAY_MS = 750;

/**
 * Envelope fields for the flights search (VOY-1793 reuse observability +
 * VOY-1871 effectiveParams / staleInventory).
 *
 * `effectiveParams` (VOY-1871) is ALWAYS present and reflects the params wired
 * for THIS search. The reused selection's ORIGINAL params (VOY-1793, present
 * on any reuse that has a stored record — matching or not) move to
 * `previousSearchParams` so the two concepts don't collide on one key.
 * `staleInventory` + its warning are added when the rendered rows still don't
 * match the effective origin/destination.
 */
function flightReuseEnvelopeFields(
  reuse: ReuseObservation,
  effectiveParams: EffectiveFlightParams,
  staleInventory: boolean,
  staleWarning: string | null,
): Record<string, unknown> {
  const warnings = [...reuse.warnings, ...(staleWarning ? [staleWarning] : [])];
  return {
    requestedParams: reuse.requestedParams,
    effectiveParams,
    ...(reuse.effectiveParams ? { previousSearchParams: reuse.effectiveParams } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(staleInventory ? { staleInventory: true } : {}),
  };
}

export function registerSearchCommands(program: Command): void {
  const search = program.command("search").description("Search flights, hotels, and activities");

  search
    .command("airports")
    .description("Search airports by city name or code")
    .argument("<query>", "City name or partial airport code")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action((query: string, opts: { json?: boolean; agent?: boolean }) => {
      const results = searchAirports(query);

      if (opts.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + "\n");
        return;
      }

      if (opts.agent) {
        if (results.length === 0) {
          process.stdout.write(`_No airports found matching "${query}"._\n`);
          return;
        }
        const lines = [`### Airports matching "${query}"`, ""];
        for (const r of results) {
          lines.push(`- **${r.code}** — ${r.city} (${r.name})`);
        }
        process.stdout.write(lines.join("\n") + "\n");
        return;
      }

      if (results.length === 0) {
        process.stderr.write(chalk.yellow(`No airports found matching "${query}".\n`));
        return;
      }

      console.log(chalk.bold(`\n${results.length} airport${results.length !== 1 ? "s" : ""} matching "${query}":\n`));
      for (const r of results) {
        console.log(`  ${chalk.cyan(r.code)}  ${r.city.padEnd(20)} ${chalk.dim(r.name)}`);
      }
      console.log();
    });

  search
    .command("flights")
    .description("Search for flights")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--client <ref>", "Client id, email, or name for the auto-created draft plan when no --plan is given (same semantics as plan-trip)")
    .option("--goal <goalId>", "Target Flight goal (defaults to the first Flight goal on the plan)")
    .option("--from <code>", "Origin airport code (e.g., LAX)")
    .requiredOption("--to <code>", "Destination airport code (e.g., NRT)")
    .option("--date <date>", "Departure date (YYYY-MM-DD); prompted when omitted at a TTY")
    .option("--return <date>", "Return date (YYYY-MM-DD) for round-trip")
    .option("--max-stops <n>", "Maximum number of stops")
    .option("--nonstop", "Only nonstop flights (sugar for --max-stops 0)")
    .option("--depart-after <HH:MM>", "Outbound departs at or after this wall-clock time")
    .option("--depart-before <HH:MM>", "Outbound departs before this wall-clock time")
    .option("--arrive-by <HH:MM>", "Outbound arrives at or before this wall-clock time")
    .option("--return-depart-after <HH:MM>", "Return leg departs at or after this time (round trips)")
    .option("--return-depart-before <HH:MM>", "Return leg departs before this time (round trips)")
    .option(
      "--airline <code>",
      "Filter by carrier IATA code (repeatable)",
      (value: string, acc: string[]) => [...acc, value],
      [] as string[],
    )
    .option("--max-price <n>", "Only options at or below this price")
    .option("--sort <field>", "Sort by: price, duration, stops, default", "default")
    .option("--full", "Include ALL options with raw provider data in the output (large; default shows top summaries)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--no-wait", "Return immediately instead of waiting inline for async inventory (human/TTY mode)")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts, command) => {
      // Resolve --date FIRST (VOY-1762): it used to be a commander
      // `requiredOption`, so a missing --date failed at PARSE time — before any
      // action code, including origin/--from resolution — ran. Keeping the date
      // check ahead of origin resolution preserves that error precedence, so
      // `search flights --to X` (no --date, no origin) still reports the missing
      // --date rather than the "No origin specified" error. It also sits OUTSIDE
      // the try below so the CommanderError `command.error` throws (under
      // exitOverride, in tests) is not swallowed and re-wrapped by
      // handleSearchError — it must surface with commander's own code/exit, and
      // its text on stderr WITHOUT --json or the VALIDATION envelope on stdout
      // WITH --json in argv (VOY-1829).
      opts.date = await resolveDateOpt(opts.date, opts, "Departure date (YYYY-MM-DD): ", command);
      try {
        const quiet = !!(opts.json || opts.agent);
        // Resolve origin: explicit --from, or home airport default
        let origin: string;
        if (opts.from) {
          origin = resolveAirportInput(opts.from, "--from", quiet);
        } else {
          const homeAirports = getHomeAirports();
          if (homeAirports.length > 0) {
            origin = homeAirports[0].toUpperCase();
            validateIata(origin, "--from (home airport)");
            if (!opts.json && !opts.agent) process.stderr.write(chalk.dim(`Using home airport: ${origin} (from profile)\n`));
          } else {
            throw new CliError(CliErrorCode.VALIDATION, "No origin specified. Run: voyagier auth setup (or use --from <code>)");
          }
        }

        const destination = resolveAirportInput(opts.to, "--to", quiet);
        validateDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");
        if (opts.return) {
          validateDate(opts.return, "--return");
          warnPastDate(opts.return, "--return");
        }
        // Validate refinement flags up front so a malformed value fails fast,
        // before any search work (VOY-1784).
        const flightFilters = parseFlightFilters(opts);

        // Auto-scaffold a draft plan when no --plan/last-search exists (VOY-1761).
        // Shape: flight-only (no hotel), and one-way unless --return is given.
        const { tripPlanId, scaffolded } = await resolvePlanForSearch(
          opts,
          {
            title: generateTripTitle({ to: destination, depart: opts.date }),
            shape: { oneWay: !opts.return, flightOnly: true, hotelOnly: false },
          },
          quiet,
        );
        const dryRun = !!opts.dryRun;
        const showProgress = !dryRun && !opts.json && !opts.agent;

        const travellerSpinner = showProgress ? startSpinner("Resolving travellers...") : null;
        let travellerIds: string[];
        try {
          travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        } finally {
          travellerSpinner?.stop();
        }
        // A freshly auto-scaffolded plan is traveller-less by design (VOY-1761:
        // traveller checkout blockers are out of scope, and the backend accepts a
        // flight search with zero travellers). Only require travellers on a plan
        // the caller pointed us at.
        if (!dryRun && travellerIds.length === 0 && !scaffolded) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${shellArg(tripPlanId)} --first <name> --last <name> --type ADULT`);
        }

        const isRoundTrip = !!opts.return;

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list",
                steps: [
                  `resolve Flight goal (--goal or first Flight goal)`,
                  `set origin airport -> ${origin}, destination airport -> ${destination}`,
                  `set date -> ${opts.date}${opts.return ? `, return -> ${opts.return}` : ""}`,
                  `reuse the goal's existing Flight decision selection (create only if the goal has none)`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        // New goal/mirror-list model: set the goal's inputs, then create a
        // selection mirroring the goal's FlightList. Options are produced
        // asynchronously by the backend monitor (surfaced via selection-options).
        // The whole fetch runs under a spinner (try/finally so a thrown CliError
        // never leaves a dangling animation interval).
        const searchSpinner = showProgress ? startSpinner("Searching flights...") : null;
        let selectionId: string;
        let fetchedOptions: SelectOption[];
        let returnSelectionId: string | null = null;
        try {
          const goals = await loadGoals(tripPlanId);
          const goal = resolveGoal(goals, "flights", opts.goal);
          const mirrorListSelectionId = resolveMirrorList(goal, "flights");
          // Fail fast if the goal graph can't accept the required inputs, rather
          // than create a selection silently stuck AWAITING_INPUT downstream.
          const aps = requireAirports(goal, 2);
          const dateSel = requireDateSelection(goals);
          await setAirport(aps[0], origin);
          await setAirport(aps[1], destination);
          // Round-trip: also wire the RETURN-leg goal's airports (reversed:
          // destination -> origin), or its segment query stays insufficient and
          // no inventory is fetched (VOY-1421). One-way plans have no return goal.
          if (isRoundTrip) {
            const returnGoal = resolveReturnFlightGoal(goals, goal.id);
            if (returnGoal) {
              const returnAps = requireAirports(returnGoal, 2);
              await setAirport(returnAps[0], destination);
              await setAirport(returnAps[1], origin);
              // Surface the return goal's decision selection too: a round trip is
              // complete only when BOTH legs carry a choice (VOY-1692).
              returnSelectionId = resolveDecisionSelection(returnGoal, "flights");
            }
          }
          // Resolve BOTH date outputs so the round-trip monitor query is
          // sufficient (VOY-1421): startDate from --date, endDate via duration
          // when --return is given.
          await resolveDateRange(dateSel, opts.date, opts.return);

          // Reuse the goal's existing Flight (leg) selection — the one wired
          // 1 mirror hop from the FlightJourney's option rows — instead of
          // creating a duplicate 2 hops away (VOY-1692).
          ({ selectionId, options: fetchedOptions } = await resolveOrCreateDecisionSelection(
            "flights",
            goal,
            tripPlanId,
            CREATE_FLIGHT_SELECTION,
            "createTripPlanFlightSelection",
            { goalId: goal.id, mirrorListSelectionId, travellerIds, title: `Flight: ${origin} → ${destination}` },
            quiet,
            searchSpinner ? (l) => searchSpinner.update(l) : undefined,
          ));
        } finally {
          searchSpinner?.stop();
        }

        // VOY-1793: record/reconcile the params this (possibly reused) selection
        // was searched with, so the envelope can flag a stale-reuse mismatch.
        const reuse = observeSelectionReuse(selectionId, {
          origin,
          destination,
          depart: opts.date,
          ...(opts.return ? { return: opts.return } : {}),
          partySize: travellerIds.length,
        });

        // VOY-1871: the params actually wired into the goal graph for THIS
        // search — the origin/destination/date(s) in effect for the selection.
        const effectiveParams = effectiveFlightParams(origin, destination, opts.date, opts.return);

        // Human/TTY: wait inline for async inventory rather than handing the user
        // a poll command (VOY-1780). Kick a refresh + poll to completion, then
        // re-fetch the full options and fall through to the SAME render path as
        // the immediate-results case. --no-wait / --json / --agent / non-TTY skip
        // this and keep the fire-and-return behaviour below.
        if (fetchedOptions.length === 0 && shouldWaitInline(opts)) {
          const label = `Searching ${origin} → ${destination}`;
          const waitSpinner = spinnerAnimates() ? startSpinner(`${label}… fetching inventory`) : null;
          let snap;
          try {
            snap = await waitForSelectionOptions(
              selectionId,
              { timeoutMs: SEARCH_WAIT_TIMEOUT_MS },
              { heartbeat: makeWaitHeartbeat(label, waitSpinner) },
            );
          } finally {
            waitSpinner?.stop();
          }
          if (snap.result.status === "READY") {
            fetchedOptions = await refetchDecisionOptions(selectionId);
          } else if (snap.result.status === "NO_RESULTS") {
            process.stderr.write(
              chalk.yellow(`No flights matched ${origin} → ${destination} on these dates.\n`),
            );
            return;
          } else {
            reportWaitStop(snap.result, selectionId);
            return;
          }
        }

        // VOY-1871: a REUSED selection can hand back the PREVIOUS params'
        // inventory when we read it — wiring the new inputs above re-seeds the
        // backend monitor asynchronously, so an immediate read (in
        // resolveOrCreateDecisionSelection) can still see the old rows while the
        // re-seed is in flight. The prior empty-wait only settles when NO rows
        // came back; here rows DID come back but their outbound leg doesn't
        // match the params we just wired, which means they're stale. The status
        // wait alone is NOT sufficient: a reused selection is often already
        // terminal (READY), so the wait returns immediately while the rows are
        // still the old ones. Re-poll the full options (bounded) until the rows
        // match the effective params, so the envelope is built from
        // POST-refresh rows only. Runs in every mode (incl. --json/--agent)
        // because agents consume the envelope directly.
        if (outboundLegStale(fetchedOptions, origin, destination)) {
          await waitForSelectionOptions(selectionId, { timeoutMs: SEARCH_WAIT_TIMEOUT_MS });
          for (let attempt = 1; attempt <= STALE_REFETCH_ATTEMPTS; attempt++) {
            fetchedOptions = await refetchDecisionOptions(selectionId);
            if (!outboundLegStale(fetchedOptions, origin, destination)) break;
            if (attempt < STALE_REFETCH_ATTEMPTS) {
              await new Promise<void>((r) => setTimeout(r, STALE_REFETCH_DELAY_MS));
            }
          }
        }

        const sortBy = (opts.sort ?? "default") as SortField;
        // Client-side presentation filters over the options the backend returned
        // (same layer as --sort), NOT goal-input constraints — server order
        // stays the default (VOY-1784). Filter first (over the sortOrder-ordered
        // set), then apply --sort; both run before the display limit.
        const prefiltered = [...fetchedOptions].sort((a, b) => a.sortOrder - b.sortOrder);
        const { kept, zero: filteredToZero } = filterFlights(prefiltered, flightFilters);
        const options = sortOptions(kept, sortBy);

        // VOY-1871: after the bounded re-poll, if the FIRST rendered row's
        // outbound leg still disagrees with the effective params, the
        // inventory hasn't finished refreshing. Don't render silently — flag it
        // so an agent re-fetches before selecting.
        const staleInventory = outboundLegStale(options, origin, destination);
        const staleWarning = staleInventory
          ? `STALE_INVENTORY: the top option's outbound leg (${optionOutboundOrigin(options[0]) ?? "?"} → ${optionOutboundDestination(options[0]) ?? "?"}) does not match the searched params (${origin} → ${destination}); the selection's inventory may still be refreshing for the new params. Re-fetch before selecting: voyagier selection-options ${shellArg(selectionId)} --wait --json`
          : null;

        const searchResults = options.map((opt, i) => {
          // VOY-1824: platform value score (optionData.rankScore), display-only.
          // Included only when it is a finite number; the key is omitted
          // entirely when absent (never null/undefined).
          const rankScore = extractRankScore(opt.bookingData);
          return {
            index: i + 1,
            optionId: opt.id,
            flightToken: extractFlightToken(opt.bookingData),
            summary: buildFlightSummary(opt, origin, destination),
            // VOY-1783: additive leg detail (times, flight number, stops,
            // connections) so agents can decide without the --full dump.
            ...flightProjectionFields(opt.bookingData),
            ...(rankScore !== undefined ? { rankScore } : {}),
          };
        });

        saveSearchState({
          type: "flights",
          tripPlanId,
          selectionId,
          ...(returnSelectionId ? { returnSelectionId } : {}),
          isRoundTrip,
          origin,
          destination,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(searchJsonBody(
            {
              tripPlanId,
              ...(scaffolded ? { scaffolded: true } : {}),
              selectionId,
              ...(returnSelectionId ? { returnSelectionId } : {}),
              isRoundTrip,
              ...planUrls(tripPlanId),
              ...flightReuseEnvelopeFields(reuse, effectiveParams, staleInventory, staleWarning),
              // Factual callouts over the displayed (post-filter/sort) list.
              ...flightCalloutsJson(flightCallouts(options)),
              // Structured which-filter attribution when filters removed all.
              ...(filteredToZero ? filteredToZeroJson(filteredToZero) : {}),
            },
            options as unknown as Array<Record<string, unknown>>,
            searchResults,
            opts.full,
            "--sort/--max-stops/--nonstop/--depart-after/--depart-before/--arrive-by/--return-depart-after/--return-depart-before/--airline/--max-price",
            flightFacets(options) as Record<string, unknown>,
          ), null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = clientPlanUrl(tripPlanId);
          const lines: string[] = [];
          lines.push(`### Flights (${origin} → ${destination})`);
          if (scaffolded) lines.push(`_No plan given — created draft plan \`${tripPlanId}\`._`);
          // VOY-1871: echo the effective search so an agent can assert direction.
          lines.push(`_${effectiveParamsLine(effectiveParams)}_`);
          for (const w of reuse.warnings) lines.push(`> ⚠ ${w}`);
          if (staleWarning) lines.push(`> ⚠ ${staleWarning}`);
          if (filteredToZero) {
            // Filters removed everything the backend returned — say WHICH ones
            // and the nearest miss (VOY-1784), not a generic "no options".
            for (const l of filteredToZeroLines(filteredToZero)) lines.push(l);
          } else if (options.length === 0) {
            // Options are produced asynchronously by the monitor once the goal's
            // inputs are sufficient. Empty here usually means "still fetching",
            // not "no results" — point at the async-aware poll (VOY-1421).
            lines.push("_No options yet — the search is still fetching inventory._");
            lines.push("");
            lines.push(`**Next:** \`voyagier selection-options ${shellArg(selectionId)} --wait --json\``);
          } else {
            const callout = flightCalloutLine(options);
            if (callout) lines.push(`_${callout}_`);
            const shown = opts.full ? options : options.slice(0, TOP_OPTIONS);
            lines.push(agentFlightOptions(shown));
            if (options.length > shown.length) {
              lines.push(`_…and ${options.length - shown.length} more — \`--full\` lists all, \`--sort price\`/\`--max-stops\` refine._`);
            }
            lines.push("");
            lines.push("**Next:** `voyagier select <number>`");
          }
          if (isRoundTrip && returnSelectionId) {
            lines.push("");
            lines.push(
              `_Round trip: after choosing the outbound, also choose on the return selection — \`voyagier select --selection-id ${shellArg(returnSelectionId)} --option-id <id>\` (options: \`voyagier selection-options ${shellArg(returnSelectionId)} --wait --json\`)._`,
            );
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        // Human mode: surface the reuse-mismatch warning as a clear ⚠ line.
        writeReuseWarnings(reuse.warnings);
        // VOY-1871: one-line echo of the effective search direction/dates, and a
        // clear ⚠ line when the rendered rows don't match it.
        process.stderr.write(chalk.dim(effectiveParamsLine(effectiveParams) + "\n"));
        if (staleWarning) process.stderr.write(chalk.yellow(`⚠ ${staleWarning}\n`));

        if (filteredToZero) {
          // Filters removed every returned option — explain which filter(s) and
          // the nearest miss so the user knows what to loosen (VOY-1784).
          for (const l of filteredToZeroLines(filteredToZero)) process.stderr.write(chalk.yellow(l + "\n"));
          return;
        }

        if (options.length === 0) {
          // Reached only when the inline wait was skipped (--no-wait / non-TTY);
          // hand back a copy-safe poll hint (VOY-1780).
          process.stderr.write(chalk.dim("No options yet — the search is still fetching inventory.\n"));
          writePollHint(selectionId);
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} flight option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        const calloutLine = flightCalloutLine(options);
        if (calloutLine) console.log(chalk.dim(calloutLine));
        console.log(formatFlights(options));
        await printPlanFooter(tripPlanId);
        if (isRoundTrip) {
          console.log(chalk.dim(`  Note: Select the outbound leg first, then the return leg${returnSelectionId ? ` (selection ${returnSelectionId})` : ""}.`));
        }
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });

  search
    .command("hotels")
    .description("Search for hotels")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--client <ref>", "Client id, email, or name for the auto-created draft plan when no --plan is given (same semantics as plan-trip)")
    .option("--goal <goalId>", "Target Hotel goal (defaults to the first Hotel goal on the plan)")
    .requiredOption("--location <place>", "Destination (city name)")
    .requiredOption("--checkin <date>", "Check-in date (YYYY-MM-DD)")
    .requiredOption("--checkout <date>", "Check-out date (YYYY-MM-DD)")
    .option("--currency <code>", "Currency code", "USD")
    .option("--guests <n>", "Number of adult guests", "1")
    .option("--min-rating <n>", "Only hotels rated at or above this")
    .option("--max-total <n>", "Only hotels with a stay total at or below this")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--full", "Include ALL options with raw provider data in the output (large; default shows top summaries)")
    .option("--replace", "Replace existing hotel items for this location (removes old selections)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--verbose", "Show request details sent to the API")
    .option("--no-wait", "Return immediately instead of waiting inline for async inventory (human/TTY mode)")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts) => {
      try {
        validateDate(opts.checkin, "--checkin");
        warnPastDate(opts.checkin, "--checkin");
        warnPastDate(opts.checkin, "--checkin");
        validateDate(opts.checkout, "--checkout");
        warnPastDate(opts.checkout, "--checkout");
        warnPastDate(opts.checkout, "--checkout");
        // Validate refinement flags up front (VOY-1784).
        const hotelFilters = parseHotelFilters(opts);

        const quietHotel = !!(opts.json || opts.agent);
        // Auto-scaffold a hotel-only draft plan when no --plan/last-search exists.
        const { tripPlanId, scaffolded } = await resolvePlanForSearch(
          opts,
          {
            title: generateTripTitle({ hotel: opts.location, checkin: opts.checkin }),
            shape: { oneWay: false, flightOnly: false, hotelOnly: true },
          },
          quietHotel,
        );
        const dryRun = !!opts.dryRun;
        const showProgress = !dryRun && !opts.json && !opts.agent;

        const travellerSpinner = showProgress ? startSpinner("Resolving travellers...") : null;
        let travellerIds: string[];
        try {
          travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        } finally {
          travellerSpinner?.stop();
        }
        // Auto-scaffolded plans are traveller-less by design (VOY-1761); only
        // require travellers on a plan the caller pointed us at.
        if (!dryRun && travellerIds.length === 0 && !scaffolded) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${shellArg(tripPlanId)} --first <name> --last <name> --type ADULT`);
        }

        // Check for existing hotel items and handle --replace.

        // Filter by selection type (HOTEL) instead of title text to avoid
        // false matches on unrelated items whose titles contain "hotel".
        if (!dryRun) {
          try {
            const planData = await graphql<{
              tripPlan: { items: Array<{ id: string; title: string; selections?: Array<{ type: string }> }> };
            }>(
              GET_TRIP_PLAN_ITEM_TYPES,
              { id: tripPlanId }
            );
            const hotelItems = planData.tripPlan.items.filter(
              (item) => (item.selections ?? []).some((s) => s.type === "HOTEL")
            );
            if (hotelItems.length > 0) {
              if (opts.replace) {
                for (const item of hotelItems) {
                  await graphql<{ deleteTripPlanItem: boolean }>(
                    DELETE_TRIP_PLAN_ITEM,
                    { id: item.id }
                  );
                }
                if (!opts.json) {
                  process.stderr.write(chalk.dim(`Replaced ${hotelItems.length} existing hotel item${hotelItems.length > 1 ? "s" : ""}.\n`));
                }
              } else if (!opts.json) {
                process.stderr.write(chalk.yellow(`⚠ This plan already has ${hotelItems.length} hotel item${hotelItems.length > 1 ? "s" : ""}. Use --replace to remove them first.\n`));
              }
            }
          } catch (err) {
            // Non-fatal — continue with search, but warn if --replace was requested
            // so the user knows cleanup didn't happen.
            if (opts.replace && !opts.json) {
              process.stderr.write(chalk.yellow(`⚠ --replace: failed to clean up existing hotel items. Duplicates may result.\n`));
            }
          }
        }

        if (!dryRun && opts.verbose) {
          process.stderr.write(chalk.dim(`API request — location: "${opts.location}", check-in: ${opts.checkin}, check-out: ${opts.checkout}\n`));
        }

        const adults = parseInt(opts.guests, 10);
        if (!Number.isFinite(adults) || adults < 1) {
          throw new CliError(CliErrorCode.VALIDATION, "--guests must be an integer ≥ 1.");
        }

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list",
                steps: [
                  `resolve Hotel goal (--goal or first Hotel goal)`,
                  `set date -> ${opts.checkin} (and ${opts.checkout})`,
                  `reuse the goal's existing Hotel decision selection (create only if the goal has none)`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        // The whole fetch runs under a spinner (try/finally so a thrown CliError
        // never leaves a dangling animation interval).
        const searchSpinner = showProgress ? startSpinner("Searching hotels...") : null;
        let selectionId: string;
        let fetchedOptions: SelectOption[];
        try {
          const goals = await loadGoals(tripPlanId);
          const goal = resolveGoal(goals, "hotels", opts.goal);
          const mirrorListSelectionId = resolveMirrorList(goal, "hotels");
          const dateSel = requireDateSelection(goals);
          // --location applies to the plan-level Destination selection (Hotel goals
          // inherit destination via bindings; there's no per-Hotel location input).
          // Throws if no Destination selection exists, so the flag never silently no-ops.
          if (opts.location) await setDestination(goals, opts.location);
          // Resolve check-in + check-out so the hotel monitor query is sufficient
          // (VOY-1421): check-out is derived as a duration from check-in.
          await resolveDateRange(dateSel, opts.checkin, opts.checkout);

          ({ selectionId, options: fetchedOptions } = await resolveOrCreateDecisionSelection(
            "hotels",
            goal,
            tripPlanId,
            CREATE_HOTEL_SELECTION,
            "createTripPlanHotelSelection",
            { goalId: goal.id, mirrorListSelectionId, travellerIds, title: `Hotel: ${opts.location}` },
            !!(opts.json || opts.agent),
            searchSpinner ? (l) => searchSpinner.update(l) : undefined,
          ));
        } finally {
          searchSpinner?.stop();
        }

        // VOY-1793: record/reconcile the params this (possibly reused) hotel
        // selection was searched with, so the envelope can flag a stale reuse.
        const reuse = observeSelectionReuse(selectionId, {
          destination: opts.location,
          checkin: opts.checkin,
          checkout: opts.checkout,
          partySize: adults,
        });

        // Human/TTY: wait inline for async inventory (VOY-1780). Same shape as
        // flights — poll to completion, re-fetch full options, then render
        // through the immediate-results path below. NO_RESULTS keeps the
        // location-specific suggestions the empty branch already prints.
        if (fetchedOptions.length === 0 && shouldWaitInline(opts)) {
          const label = `Searching hotels in ${opts.location}`;
          const waitSpinner = spinnerAnimates() ? startSpinner(`${label}… fetching inventory`) : null;
          let snap;
          try {
            snap = await waitForSelectionOptions(
              selectionId,
              { timeoutMs: SEARCH_WAIT_TIMEOUT_MS },
              { heartbeat: makeWaitHeartbeat(label, waitSpinner) },
            );
          } finally {
            waitSpinner?.stop();
          }
          if (snap.result.status === "READY") {
            fetchedOptions = await refetchDecisionOptions(selectionId);
          } else if (snap.result.status !== "NO_RESULTS") {
            reportWaitStop(snap.result, selectionId);
            return;
          }
          // NO_RESULTS falls through to the empty branch below, which prints the
          // location-specific "no hotels matched" suggestions.
        }

        const sortBy = (opts.sort ?? "default") as SortField;
        // Client-side presentation filters over the returned set (VOY-1784),
        // applied before the display limit; server order stays the default.
        const { kept: keptHotels, zero: filteredToZero } = filterHotels(
          [...fetchedOptions].sort((a, b) => a.sortOrder - b.sortOrder),
          hotelFilters,
        );
        const options = sortBy === "price"
          ? [...keptHotels].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          : keptHotels;

        const searchResults = options.map((opt, i) => {
          // VOY-1724: minRate is a STAY TOTAL — expose derived stay fields
          // (additive; existing keys unchanged).
          const stay = deriveHotelStay(opt.price, opt.bookingData);
          return {
            index: i + 1,
            optionId: opt.id,
            summary: buildHotelSummary(opt),
            // VOY-1783: additive rating + amenities.
            ...hotelFactsFields(opt.bookingData),
            ...(stay
              ? {
                  stayTotal: stay.stayTotal,
                  nights: stay.nights,
                  perNight: stay.perNight,
                  checkIn: stay.checkIn,
                  checkOut: stay.checkOut,
                }
              : {}),
          };
        });

        saveSearchState({
          type: "hotels",
          tripPlanId: tripPlanId,
          selectionId: selectionId,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        // VOY-1835: the backend seeds only a shortlist of hotels into the
        // selection; report the monitor's real inventory count so agents know
        // more exist. Best-effort (null → omitted).
        const totalAvailable = options.length > 0 ? await fetchTotalAvailableListings(selectionId) : null;

        if (opts.json) {
          process.stdout.write(JSON.stringify(searchJsonBody(
            {
              tripPlanId: tripPlanId,
              ...(scaffolded ? { scaffolded: true } : {}),
              selectionId: selectionId,
              ...planUrls(tripPlanId),
              ...reuseEnvelopeFields(reuse),
              ...hotelCalloutsJson(hotelCallouts(options)),
              ...(filteredToZero ? filteredToZeroJson(filteredToZero) : {}),
              ...seededFromBlock(opts.full ? options.length : Math.min(options.length, TOP_OPTIONS), totalAvailable),
            },
            options as unknown as Array<Record<string, unknown>>,
            searchResults,
            opts.full,
            "--sort/--min-rating/--max-total",
            hotelFacets(options) as Record<string, unknown>,
          ), null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = clientPlanUrl(tripPlanId);
          const lines: string[] = [];
          lines.push(`### Hotels (${opts.location})`);
          if (scaffolded) lines.push(`_No plan given — created draft plan \`${tripPlanId}\`._`);
          for (const w of reuse.warnings) lines.push(`> ⚠ ${w}`);
          if (filteredToZero) {
            for (const l of filteredToZeroLines(filteredToZero)) lines.push(l);
          } else if (options.length === 0) {
            // Empty immediately after create usually means the monitor is still
            // fetching, not that there are no hotels — poll first (VOY-1421).
            lines.push("_No options yet — the search is still fetching inventory._");
            lines.push("");
            lines.push(`**Next:** \`voyagier selection-options ${shellArg(selectionId)} --wait --json\``);
          } else {
            const callout = hotelCalloutLine(options);
            if (callout) lines.push(`_${callout}_`);
            const shown = opts.full ? options : options.slice(0, TOP_OPTIONS);
            lines.push(agentHotelOptions(shown));
            if (options.length > shown.length) {
              lines.push(`_…and ${options.length - shown.length} more — \`--full\` lists all._`);
            }
            if (totalAvailable != null && totalAvailable > shown.length) {
              lines.push(`_These ${shown.length} are a curated shortlist of ${totalAvailable} available — refine the search or use \`voyagier listings list --selection ${shellArg(selectionId)}\` to see more._`);
            }
            lines.push("");
            lines.push("**Next:** `voyagier select <number>`");
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        // Human mode: surface the reuse-mismatch warning as a clear ⚠ line.
        writeReuseWarnings(reuse.warnings);

        if (filteredToZero) {
          for (const l of filteredToZeroLines(filteredToZero)) process.stderr.write(chalk.yellow(l + "\n"));
          return;
        }

        if (options.length === 0) {
          const loc = opts.location as string;
          process.stderr.write(chalk.dim(`No options yet — the search may still be fetching inventory.\n`));
          writePollHint(selectionId);
          process.stderr.write(chalk.yellow(`\nIf it stays empty, no hotels matched "${loc}" on these dates.\n\n`));
          process.stderr.write(chalk.dim("Suggestions:\n"));
          if (looksLikeAirportCode(loc)) {
            process.stderr.write(chalk.dim(`  • "${loc.toUpperCase()}" looks like an airport code — the API needs a city name\n`));
            process.stderr.write(chalk.dim(`    e.g. try "Kota Kinabalu" instead of "BKI", "Kuala Lumpur" instead of "KUL"\n`));
          } else {
            process.stderr.write(chalk.dim(`  • Try a different location format: full city name, region, or country\n`));
          }
          process.stderr.write(chalk.dim(`  • Try a nearby major city with more hotel inventory\n`));
          process.stderr.write(chalk.dim(`  • Use --verbose to see exactly what location was sent to the API\n`));
          process.stderr.write(chalk.dim(`  • Check the web UI for expanded search options:\n`));
          process.stderr.write(chalk.dim(`    ${clientPlanUrl(tripPlanId)}\n`));
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} hotel option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        const hotelCallout = hotelCalloutLine(options);
        if (hotelCallout) console.log(chalk.dim(hotelCallout));
        console.log(formatHotels(options));
        if (totalAvailable != null && totalAvailable > options.length) {
          console.log(chalk.dim(`  Showing ${options.length} of ${totalAvailable} available — refine or \`voyagier listings list --selection ${selectionId}\` to see more.`));
        }
        await printPlanFooter(tripPlanId);
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });

  search
    .command("activities")
    .description("Search for bookable experiences and activities")
    .option("--plan <id>", "Trip plan ID (or auto-resolved from last search)")
    .option("--goal <goalId>", "Target Activity goal (defaults to the first Activity goal on the plan)")
    .requiredOption("--destination <place>", "Destination name (city or region)")
    .option("--date <date>", "Travel date (YYYY-MM-DD); prompted when omitted at a TTY")
    .option("--query <text>", "Free text search (e.g. 'snorkeling')")
    .option("--currency <code>", "Currency code", "USD")
    .option("--sort <field>", "Sort by: price, default", "default")
    .option("--full", "Include ALL options with raw provider data in the output (large; default shows top summaries)")
    .option("--replace", "Replace existing activity items for this destination (removes old selections)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--verbose", "Show request details sent to the API")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts, command) => {
      // Resolve --date FIRST and OUTSIDE the try (VOY-1762): a missing --date was
      // a commander `requiredOption` parse failure; reproduce it byte-for-byte
      // without letting the CommanderError get re-wrapped by handleSearchError.
      opts.date = await resolveDateOpt(opts.date, opts, "Travel date (YYYY-MM-DD): ", command);
      try {
        validateDate(opts.date, "--date");
        warnPastDate(opts.date, "--date");

        const tripPlanId = resolvePlanId(opts);
        const dryRun = !!opts.dryRun;
        const showProgress = !dryRun && !opts.json && !opts.agent;

        const travellerSpinner = showProgress ? startSpinner("Resolving travellers...") : null;
        let travellerIds: string[];
        try {
          travellerIds = dryRun ? ["<traveller-id>"] : await resolveTravellerIds(tripPlanId);
        } finally {
          travellerSpinner?.stop();
        }
        if (!dryRun && travellerIds.length === 0) {
          throw new CliError(CliErrorCode.VALIDATION, `No travellers on this plan. Add one first:\n  voyagier travellers add --plan ${shellArg(tripPlanId)} --first <name> --last <name> --type ADULT`);
        }

        // Check for existing activity items and handle --replace.
        if (!dryRun) {
          try {
            const planData = await graphql<{
              tripPlan: { items: Array<{ id: string; title: string; selections?: Array<{ type: string }> }> };
            }>(
              GET_TRIP_PLAN_ITEM_TYPES,
              { id: tripPlanId }
            );
            const activityItems = planData.tripPlan.items.filter(
              (item) => (item.selections ?? []).some((s) => s.type === "ACTIVITY")
            );
            if (activityItems.length > 0) {
              if (opts.replace) {
                for (const item of activityItems) {
                  await graphql<{ deleteTripPlanItem: boolean }>(
                    DELETE_TRIP_PLAN_ITEM,
                    { id: item.id }
                  );
                }
                if (!opts.json) {
                  process.stderr.write(chalk.dim(`Replaced ${activityItems.length} existing activity item${activityItems.length > 1 ? "s" : ""}.\n`));
                }
              } else if (!opts.json) {
                process.stderr.write(chalk.yellow(`⚠ This plan already has ${activityItems.length} activity item${activityItems.length > 1 ? "s" : ""}. Use --replace to remove them first.\n`));
              }
            }
          } catch (err) {
            if (opts.replace && !opts.json) {
              process.stderr.write(chalk.yellow(`⚠ --replace: failed to clean up existing activity items. Duplicates may result.\n`));
            }
          }
        }

        if (!dryRun && opts.verbose) {
          process.stderr.write(chalk.dim(`API request — destination: "${opts.destination}", date: ${opts.date}${opts.query ? `, query: "${opts.query}"` : ""}\n`));
        }

        const titleParts = [`Activity: ${opts.destination}`];
        if (opts.query) titleParts.push(opts.query);

        if (dryRun) {
          process.stdout.write(
            JSON.stringify(
              {
                dryRun: true,
                flow: "goal/mirror-list",
                steps: [
                  `resolve Activity goal (--goal or first Activity goal)`,
                  `set date -> ${opts.date}`,
                  `reuse the goal's existing Activity decision selection (create only if the goal has none)`,
                  `surface options via selection-options <selectionId> --wait`,
                ],
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }

        // The whole fetch runs under a spinner (try/finally so a thrown CliError
        // never leaves a dangling animation interval).
        const searchSpinner = showProgress ? startSpinner("Searching activities...") : null;
        let selectionId: string;
        let fetchedOptions: SelectOption[];
        try {
          const goals = await loadGoals(tripPlanId);
          const goal = resolveGoal(goals, "activities", opts.goal);
          const mirrorListSelectionId = resolveMirrorList(goal, "activities");
          const dateSel = requireDateSelection(goals);
          // --destination applies to the plan-level Destination selection (Activity
          // goals inherit destination via bindings; no per-Activity location input).
          if (opts.destination) await setDestination(goals, opts.destination);
          await addDateOption(dateSel, opts.date);

          ({ selectionId, options: fetchedOptions } = await resolveOrCreateDecisionSelection(
            "activities",
            goal,
            tripPlanId,
            CREATE_ACTIVITY_SELECTION,
            "createTripPlanActivitySelection",
            { goalId: goal.id, mirrorListSelectionId, travellerIds, title: titleParts.join(" — ") },
            !!(opts.json || opts.agent),
            searchSpinner ? (l) => searchSpinner.update(l) : undefined,
          ));
        } finally {
          searchSpinner?.stop();
        }

        const sortBy = (opts.sort ?? "default") as SortField;
        const options = sortBy === "price"
          ? [...fetchedOptions].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
          : [...fetchedOptions].sort((a, b) => a.sortOrder - b.sortOrder);

        const searchResults = options.map((opt, i) => ({
          index: i + 1,
          optionId: opt.id,
          summary: buildActivitySummary(opt),
        }));

        saveSearchState({
          type: "activities",
          tripPlanId: tripPlanId,
          selectionId: selectionId,
          results: searchResults,
          timestamp: new Date().toISOString(),
        });

        if (opts.json) {
          process.stdout.write(JSON.stringify(searchJsonBody(
            {
              tripPlanId: tripPlanId,
              selectionId: selectionId,
              ...planUrls(tripPlanId),
            },
            options as unknown as Array<Record<string, unknown>>,
            searchResults,
            opts.full,
            "--sort",
          ), null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = clientPlanUrl(tripPlanId);
          const lines: string[] = [];
          lines.push(`### Activities (${opts.destination})`);
          if (options.length === 0) {
            lines.push("_No activities found for this destination and date._");
          } else {
            const shown = opts.full ? options : options.slice(0, TOP_OPTIONS);
            lines.push(agentActivityOptions(shown));
            if (options.length > shown.length) {
              lines.push(`_…and ${options.length - shown.length} more — \`--full\` lists all._`);
            }
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          lines.push("");
          lines.push("**Next:** `voyagier select <number>`");
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (options.length === 0) {
          process.stderr.write(chalk.yellow(`No activities found for "${opts.destination}" on this date.\n`));
          return;
        }

        const sortLabel = sortBy !== "default" ? ` (sorted by ${sortBy})` : "";
        console.log(chalk.bold(`\n${options.length} activity option${options.length > 1 ? "s" : ""} found${sortLabel}:\n`));
        console.log(formatActivities(options));
        await printPlanFooter(tripPlanId);
        console.log(chalk.dim(`  Next: voyagier select <number>`));
      } catch (err) {
        handleSearchError(err);
      }
    });
}





function handleSearchError(err: unknown): never {
  if (err instanceof CliError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("401") || message.includes("Unauthorized") || message.includes("Authentication")) {
    throw new CliError(CliErrorCode.AUTH_FAILED, "Authentication failed. Run: voyagier auth setup");
  } else if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("Network error")) {
    throw new CliError(CliErrorCode.NETWORK, "Could not connect to API. Run: voyagier auth status");
  } else {
    throw new CliError(CliErrorCode.API_ERROR, `Search error: ${message}`);
  }
}
