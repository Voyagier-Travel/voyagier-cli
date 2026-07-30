import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./config.js";

export interface SearchResult {
  index: number;
  optionId: string;
  flightToken?: string;
  summary: string;
  // VOY-1724: hotel search results carry derived stay fields (minRate is a
  // STAY TOTAL). All optional/additive; absent for flights/activities.
  stayTotal?: number;
  nights?: number | null;
  perNight?: number | null;
  checkIn?: string | null;
  checkOut?: string | null;
}

export interface SearchState {
  type: "flights" | "hotels" | "activities";
  tripPlanId: string;
  selectionId: string;
  /** Round trips: the Return Flights goal's decision selection (VOY-1692). */
  returnSelectionId?: string;
  isRoundTrip?: boolean;
  awaitingReturn?: boolean;
  origin?: string;
  destination?: string;
  results: SearchResult[];
  timestamp: string;
}

/**
 * Options state — separate from search state so `options` doesn't clobber
 * an in-progress flight/hotel selection flow.
 */
export interface OptionsState {
  tripPlanId: string;
  results: Array<{
    index: number;
    subSelectionId: string;
    optionId: string;
    summary: string;
  }>;
  timestamp: string;
}

const STATE_FILE = join(CONFIG_DIR, "last-search.json");
const OPTIONS_FILE = join(CONFIG_DIR, "last-options.json");
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// --- Search state (flights/hotels) ---

export function saveSearchState(state: SearchState): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700); // L1: correct a pre-existing loose-perm dir
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

/**
 * L5: the state files live beside the token; a malformed or tampered file must
 * degrade to "no state" rather than feed junk into GraphQL variables or
 * suggested-command text. The guards validate exactly the fields downstream
 * code dereferences (ids fed to mutations, `type`/`timestamp`/`index`/`summary`
 * used for staleness, lookup, and display) — optional fields are left alone.
 */
function isValidSearchResult(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.index === "number" && typeof r.optionId === "string" && typeof r.summary === "string";
}

function isValidSearchState(v: unknown): v is SearchState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    (s.type === "flights" || s.type === "hotels" || s.type === "activities") &&
    typeof s.tripPlanId === "string" &&
    typeof s.selectionId === "string" &&
    typeof s.timestamp === "string" &&
    Array.isArray(s.results) &&
    s.results.every(isValidSearchResult)
  );
}

/** L5 sibling guard for the options cache (same trust boundary as above). */
function isValidOptionsState(v: unknown): v is OptionsState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.tripPlanId === "string" &&
    typeof s.timestamp === "string" &&
    Array.isArray(s.results) &&
    s.results.every((r) => {
      if (typeof r !== "object" || r === null) return false;
      const o = r as Record<string, unknown>;
      return (
        typeof o.index === "number" &&
        typeof o.subSelectionId === "string" &&
        typeof o.optionId === "string" &&
        typeof o.summary === "string"
      );
    })
  );
}

export function loadSearchState(): SearchState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSearchState(parsed)) return null;
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      // JSON parse failure — corrupted file, safe to delete
      try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
      process.stderr.write("Warning: Search state was corrupted and has been cleared. Re-run your search.\n");
    }
    // Permission/IO errors: leave the file alone, just return null
    return null;
  }
}

export function clearSearchState(): void {
  if (existsSync(STATE_FILE)) {
    unlinkSync(STATE_FILE);
  }
}

export function isSearchStateStale(state: SearchState, maxAgeMs = DEFAULT_MAX_AGE_MS): boolean {
  const age = Date.now() - new Date(state.timestamp).getTime();
  return age > maxAgeMs;
}

// --- Options state (sub-selections: cabin class, room type) ---

export function saveOptionsState(state: OptionsState): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700); // L1: correct a pre-existing loose-perm dir
  writeFileSync(OPTIONS_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(OPTIONS_FILE, 0o600);
}

export function loadOptionsState(): OptionsState | null {
  if (!existsSync(OPTIONS_FILE)) return null;
  try {
    const raw = readFileSync(OPTIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidOptionsState(parsed)) return null;
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      try { unlinkSync(OPTIONS_FILE); } catch { /* ignore */ }
      process.stderr.write("Warning: Options state was corrupted and has been cleared. Re-run voyagier options.\n");
    }
    return null;
  }
}

export function clearOptionsState(): void {
  if (existsSync(OPTIONS_FILE)) {
    unlinkSync(OPTIONS_FILE);
  }
}

// --- Selection search params (VOY-1793) ---

/**
 * The search params a decision selection's inventory was fetched for.
 *
 * Searching flights/hotels REUSES the goal's existing decision selection
 * (VOY-1692) rather than creating a new one, and reuse does NOT refetch — so a
 * later search with different dates can still return results for the ORIGINAL
 * params. We persist the params a selection was FIRST searched with, keyed by
 * selectionId, so a subsequent search can surface the discrepancy
 * (`effectiveParams` + a SELECTION_REUSED_PARAMS_MISMATCH warning).
 *
 * Same shape for flights and hotels; a given selectionId is always one kind, so
 * the irrelevant fields simply stay undefined (flights: origin/destination/
 * depart/return; hotels: destination/checkin/checkout). partySize is common.
 */
export interface SelectionSearchParams {
  origin?: string;
  destination?: string;
  depart?: string;
  return?: string;
  checkin?: string;
  checkout?: string;
  partySize?: number;
}

interface StoredSelectionParams {
  params: SelectionSearchParams;
  timestamp: string;
}

const SELECTION_PARAMS_FILE = join(CONFIG_DIR, "selection-params.json");
// Bound the file: a plan's compose loop is short-lived, so drop entries older
// than this on write rather than let the map grow unbounded across sessions.
const SELECTION_PARAMS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** L5 trust boundary: the params file sits beside the token — a malformed or
 *  tampered entry must degrade to "no record", never feed junk into an
 *  agent-facing warning. Validate exactly the fields callers read. */
function loadSelectionParamsMap(): Record<string, StoredSelectionParams> {
  if (!existsSync(SELECTION_PARAMS_FILE)) return {};
  try {
    const raw = readFileSync(SELECTION_PARAMS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const map = (parsed as { selections?: unknown })?.selections;
    if (typeof map !== "object" || map === null) return {};
    const out: Record<string, StoredSelectionParams> = {};
    for (const [id, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const e = v as Record<string, unknown>;
      if (typeof e.timestamp === "string" && typeof e.params === "object" && e.params !== null) {
        out[id] = { params: e.params as SelectionSearchParams, timestamp: e.timestamp };
      }
    }
    return out;
  } catch (err) {
    if (err instanceof SyntaxError) {
      try { unlinkSync(SELECTION_PARAMS_FILE); } catch { /* ignore */ }
    }
    return {};
  }
}

/** The params a selection's inventory was first searched with, or null. */
export function getSelectionSearchParams(selectionId: string): SelectionSearchParams | null {
  return loadSelectionParamsMap()[selectionId]?.params ?? null;
}

/**
 * Record the params a selection was searched with — but ONLY the first time
 * (the "original"). Later reuses deliberately keep the original so a params
 * change stays detectable; overwriting would make effectiveParams always equal
 * requestedParams and defeat the mismatch warning. Best-effort: never throws
 * (observability must not break a search).
 */
export function rememberSelectionSearchParams(
  selectionId: string,
  params: SelectionSearchParams,
  now: Date = new Date(),
): void {
  try {
    const map = loadSelectionParamsMap();
    if (map[selectionId]) return; // preserve the original params
    // Prune stale/undated entries so the file stays bounded.
    const cutoff = now.getTime() - SELECTION_PARAMS_MAX_AGE_MS;
    for (const [id, e] of Object.entries(map)) {
      const t = new Date(e.timestamp).getTime();
      if (!Number.isFinite(t) || t < cutoff) delete map[id];
    }
    map[selectionId] = { params, timestamp: now.toISOString() };
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    chmodSync(CONFIG_DIR, 0o700); // L1: correct a pre-existing loose-perm dir
    writeFileSync(SELECTION_PARAMS_FILE, JSON.stringify({ selections: map }, null, 2), { mode: 0o600 });
    chmodSync(SELECTION_PARAMS_FILE, 0o600);
  } catch {
    /* best-effort — a persistence failure must not fail the search */
  }
}

export function clearSelectionSearchParams(): void {
  if (existsSync(SELECTION_PARAMS_FILE)) {
    unlinkSync(SELECTION_PARAMS_FILE);
  }
}
