import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { saveSearchState, loadSearchState, clearSearchState, isSearchStateStale, SearchState, saveOptionsState, loadOptionsState, clearOptionsState } from "./state.js";
import { CONFIG_DIR } from "./config.js";

const STATE_FILE = join(CONFIG_DIR, "last-search.json");

const MOCK_STATE: SearchState = {
  type: "flights",
  tripPlanId: "plan-123",
  selectionId: "sel-456",
  isRoundTrip: true,
  awaitingReturn: false,
  results: [
    { index: 1, optionId: "opt-1", flightToken: "tok-1", summary: "LAX→NRT · AA · $1,200.00 · 11h 30m" },
    { index: 2, optionId: "opt-2", flightToken: "tok-2", summary: "LAX→NRT · UA · $980.00 · 12h 15m" },
  ],
  timestamp: new Date().toISOString(),
};

describe("state", () => {
  let originalState: string | null = null;

  beforeEach(() => {
    // Back up existing state
    if (existsSync(STATE_FILE)) {
      originalState = require("fs").readFileSync(STATE_FILE, "utf-8");
      unlinkSync(STATE_FILE);
    } else {
      originalState = null;
    }
  });

  afterEach(() => {
    // Clean up test state
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    // Restore original state
    if (originalState !== null) {
      require("fs").writeFileSync(STATE_FILE, originalState, { mode: 0o600 });
    }
  });

  describe("saveSearchState / loadSearchState", () => {
    it("should save and load search state", () => {
      saveSearchState(MOCK_STATE);
      const loaded = loadSearchState();
      expect(loaded).toEqual(MOCK_STATE);
    });

    it("should return null when no state file exists", () => {
      expect(loadSearchState()).toBeNull();
    });

    it("should overwrite previous state", () => {
      saveSearchState(MOCK_STATE);
      const newState: SearchState = {
        ...MOCK_STATE,
        type: "hotels",
        selectionId: "sel-789",
        results: [{ index: 1, optionId: "hotel-1", summary: "W Punta Cana · $350.00/night" }],
      };
      saveSearchState(newState);
      const loaded = loadSearchState();
      expect(loaded?.type).toBe("hotels");
      expect(loaded?.selectionId).toBe("sel-789");
    });

    it("should preserve round-trip state fields", () => {
      const rtState: SearchState = {
        ...MOCK_STATE,
        awaitingReturn: true,
      };
      saveSearchState(rtState);
      const loaded = loadSearchState();
      expect(loaded?.awaitingReturn).toBe(true);
    });
  });

  describe("clearSearchState", () => {
    it("should remove state file", () => {
      saveSearchState(MOCK_STATE);
      expect(existsSync(STATE_FILE)).toBe(true);
      clearSearchState();
      expect(loadSearchState()).toBeNull();
    });

    it("should not throw when no state file exists", () => {
      expect(() => clearSearchState()).not.toThrow();
    });
  });

  describe("isSearchStateStale", () => {
    it("should return false for fresh state", () => {
      const fresh: SearchState = {
        ...MOCK_STATE,
        timestamp: new Date().toISOString(),
      };
      expect(isSearchStateStale(fresh)).toBe(false);
    });

    it("should return true for state older than 2 hours", () => {
      const old: SearchState = {
        ...MOCK_STATE,
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      };
      expect(isSearchStateStale(old)).toBe(true);
    });

    it("should return false for state at exactly 2 hours", () => {
      const borderline: SearchState = {
        ...MOCK_STATE,
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      };
      expect(isSearchStateStale(borderline)).toBe(false);
    });

    it("should respect custom maxAge", () => {
      const recent: SearchState = {
        ...MOCK_STATE,
        timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      };
      expect(isSearchStateStale(recent, 5 * 60 * 1000)).toBe(true);
    });
  });
});

describe("OptionsState", () => {
  const testState = {
    tripPlanId: "plan-abc",
    results: [
      { index: 1, subSelectionId: "sub1", optionId: "opt1", summary: "Economy · $500" },
      { index: 2, subSelectionId: "sub1", optionId: "opt2", summary: "Business · $1,200" },
    ],
    timestamp: new Date().toISOString(),
  };

  afterEach(() => {
    clearOptionsState();
  });

  it("saves and loads options state", () => {
    saveOptionsState(testState);
    const loaded = loadOptionsState();
    expect(loaded).not.toBeNull();
    expect(loaded!.tripPlanId).toBe("plan-abc");
    expect(loaded!.results).toHaveLength(2);
    expect(loaded!.results[0].summary).toBe("Economy · $500");
  });

  it("returns null when no options state file exists", () => {
    expect(loadOptionsState()).toBeNull();
  });

  it("clears options state", () => {
    saveOptionsState(testState);
    expect(loadOptionsState()).not.toBeNull();
    clearOptionsState();
    expect(loadOptionsState()).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    // Write garbage to the options state file
    writeFileSync(join(CONFIG_DIR, "last-options.json"), "not valid json");
    expect(loadOptionsState()).toBeNull();
  });
});
