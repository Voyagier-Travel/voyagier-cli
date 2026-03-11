import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

const STATE_DIR = join(homedir(), ".voyagier");
const STATE_FILE = join(STATE_DIR, "last-search.json");
const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function saveSearchState(state: SearchState): void {
  mkdirSync(STATE_DIR, { recursive: true });
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
