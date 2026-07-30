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

/** Selection-map keys that would pollute the returned object's prototype. A
 *  file that (tampered or not) carries one of these keys is dropped. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a stored params object field-by-field. Returns a clean
 * SelectionSearchParams holding only the known fields, or null if any present
 * field carries the wrong type. The cast in loadSelectionParamsMap is a trust
 * boundary, not a guarantee — without this a tampered file could push a
 * non-string origin or an object partySize into diffSearchParams, the
 * SELECTION_REUSED_PARAMS_MISMATCH warning, and the JSON envelope. A tampered
 * entry degrades to "no record" (returns null) rather than junk.
 */
const STRING_PARAM_KEYS = ["origin", "destination", "depart", "return", "checkin", "checkout"] as const;
function sanitizeSelectionParams(raw: Record<string, unknown>): SelectionSearchParams | null {
  const clean: SelectionSearchParams = {};
  for (const k of STRING_PARAM_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return null;
    clean[k] = v;
  }
  if (raw.partySize !== undefined && raw.partySize !== null) {
    if (typeof raw.partySize !== "number" || !Number.isFinite(raw.partySize)) return null;
    clean.partySize = raw.partySize;
  }
  return clean;
}

/** L5 trust boundary: the params file sits beside the token — a malformed or
 *  tampered entry must degrade to "no record", never feed junk into an
 *  agent-facing warning. Validate exactly the fields callers read; the returned
 *  map is null-prototype so a `__proto__`-keyed entry can't pollute it. */
function loadSelectionParamsMap(): Record<string, StoredSelectionParams> {
  if (!existsSync(SELECTION_PARAMS_FILE)) return Object.create(null);
  try {
    const raw = readFileSync(SELECTION_PARAMS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const map = (parsed as { selections?: unknown })?.selections;
    if (typeof map !== "object" || map === null) return Object.create(null);
    const out: Record<string, StoredSelectionParams> = Object.create(null);
    for (const [id, v] of Object.entries(map as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(id)) continue; // prototype-pollution guard
      if (typeof v !== "object" || v === null) continue;
      const e = v as Record<string, unknown>;
      if (typeof e.timestamp !== "string" || typeof e.params !== "object" || e.params === null) continue;
      const params = sanitizeSelectionParams(e.params as Record<string, unknown>);
      if (!params) continue; // tampered field types → drop the entry
      out[id] = { params, timestamp: e.timestamp };
    }
    return out;
  } catch (err) {
    if (err instanceof SyntaxError) {
      try { unlinkSync(SELECTION_PARAMS_FILE); } catch { /* ignore */ }
    }
    return Object.create(null);
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
    // Prune stale/undated entries FIRST, before the preserve-original check
    // below. The common path re-searches an EXISTING selectionId, and an early
    // return there would skip pruning entirely — sibling entries (and a
    // now-stale entry for this same selectionId) would then accumulate in a
    // long-lived selection-params.json forever.
    const cutoff = now.getTime() - SELECTION_PARAMS_MAX_AGE_MS;
    let mutated = false;
    for (const [id, e] of Object.entries(map)) {
      const t = new Date(e.timestamp).getTime();
      if (!Number.isFinite(t) || t < cutoff) {
        delete map[id];
        mutated = true;
      }
    }
    // Record the original only when absent: a surviving (non-stale) entry is
    // preserved so a later params change stays detectable; an entry just pruned
    // as stale above is re-recorded here as a fresh original.
    if (!map[selectionId]) {
      map[selectionId] = { params, timestamp: now.toISOString() };
      mutated = true;
    }
    if (!mutated) return; // nothing pruned and the original stands — no write
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
