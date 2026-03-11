import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./config.js";

export interface SearchResult {
  index: number;
  optionId: string;
  flightToken?: string;
  summary: string;
}

export interface SearchState {
  type: "flights" | "hotels";
  tripPlanId: string;
  selectionId: string;
  isRoundTrip?: boolean;
  awaitingReturn?: boolean;
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
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadSearchState(): SearchState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as SearchState;
  } catch {
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
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(OPTIONS_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadOptionsState(): OptionsState | null {
  if (!existsSync(OPTIONS_FILE)) return null;
  try {
    const raw = readFileSync(OPTIONS_FILE, "utf-8");
    return JSON.parse(raw) as OptionsState;
  } catch {
    return null;
  }
}

export function clearOptionsState(): void {
  if (existsSync(OPTIONS_FILE)) {
    unlinkSync(OPTIONS_FILE);
  }
}
