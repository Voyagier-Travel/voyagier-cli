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
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

/**
 * L5: the state file lives beside the token; a malformed or tampered file must
 * degrade to "no state" rather than feed junk ids into GraphQL variables or
 * suggested-command text. Minimal structural check — ids are strings, results
 * is an array — nothing more.
 */
function isValidSearchState(v: unknown): v is SearchState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.tripPlanId === "string" && typeof s.selectionId === "string" && Array.isArray(s.results);
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
  writeFileSync(OPTIONS_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(OPTIONS_FILE, 0o600);
}

export function loadOptionsState(): OptionsState | null {
  if (!existsSync(OPTIONS_FILE)) return null;
  try {
    const raw = readFileSync(OPTIONS_FILE, "utf-8");
    return JSON.parse(raw) as OptionsState;
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
