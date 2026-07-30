import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, unlinkSync, writeFileSync, readFileSync, statSync, chmodSync } from "fs";
import { join } from "path";
import { saveSearchState, loadSearchState, clearSearchState, isSearchStateStale, SearchState, saveOptionsState, loadOptionsState, clearOptionsState, getSelectionSearchParams, rememberSelectionSearchParams, clearSelectionSearchParams } from "./state.js";
import { CONFIG_DIR } from "./config.js";

const STATE_FILE = join(CONFIG_DIR, "last-search.json");
const SELECTION_PARAMS_FILE = join(CONFIG_DIR, "selection-params.json");

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
      originalState = readFileSync(STATE_FILE, "utf-8");
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
      writeFileSync(STATE_FILE, originalState, { mode: 0o600 });
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

    it("writes the state file 0600", () => {
      saveSearchState(MOCK_STATE);
      expect(statSync(STATE_FILE).mode & 0o777).toBe(0o600);
    });

    it("corrects a pre-existing loose-perm (0644) state file to 0600 (L2)", () => {
      // The state file lives beside the token; a world-readable one left by an
      // older version must be tightened on the next save.
      writeFileSync(STATE_FILE, "{}", { mode: 0o644 });
      chmodSync(STATE_FILE, 0o644); // defeat umask so the pre-state is truly 0644
      expect(statSync(STATE_FILE).mode & 0o777).toBe(0o644);

      saveSearchState(MOCK_STATE);
      expect(statSync(STATE_FILE).mode & 0o777).toBe(0o600);
    });

    it("returns null for a structurally invalid state file (L5 shape guard)", () => {
      // Valid JSON, wrong shape — a tampered/malformed file must degrade to
      // "no state", never feed junk ids into GraphQL variables.
      writeFileSync(STATE_FILE, JSON.stringify({ tripPlanId: 123, results: "nope" }), { mode: 0o600 });
      expect(loadSearchState()).toBeNull();
      // Not a JSON syntax error — the file is left in place for inspection.
      expect(existsSync(STATE_FILE)).toBe(true);
    });

    it("returns null when required string ids are missing (L5 shape guard)", () => {
      writeFileSync(STATE_FILE, JSON.stringify({ results: [] }), { mode: 0o600 });
      expect(loadSearchState()).toBeNull();
    });

    it("returns null when type is not a known search type (L5 shape guard)", () => {
      writeFileSync(STATE_FILE, JSON.stringify({ ...MOCK_STATE, type: "bookings" }), { mode: 0o600 });
      expect(loadSearchState()).toBeNull();
    });

    it("returns null when a results entry is missing optionId (L5 shape guard)", () => {
      // A tampered entry must not reach setSelectedOption with undefined ids.
      const tampered = { ...MOCK_STATE, results: [{ index: 1, summary: "LAX→NRT" }] };
      writeFileSync(STATE_FILE, JSON.stringify(tampered), { mode: 0o600 });
      expect(loadSearchState()).toBeNull();
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

    it("should return false for state just under 2 hours old", () => {
      // Use a small buffer (1 second) to avoid CI timing flakes: the elapsed
      // time between constructing `timestamp` and calling `isSearchStateStale`
      // is non-zero, so a value of exactly `Date.now() - maxAge` flips to
      // stale on slow runners. Anything strictly under 2h must be fresh.
      const borderline: SearchState = {
        ...MOCK_STATE,
        timestamp: new Date(Date.now() - (2 * 60 * 60 * 1000 - 1000)).toISOString(),
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

  it("returns null for a structurally invalid options file (L5 shape guard)", () => {
    const OPTIONS_FILE = join(CONFIG_DIR, "last-options.json");
    writeFileSync(OPTIONS_FILE, JSON.stringify({ tripPlanId: "plan-abc", results: [{ index: 1 }], timestamp: new Date().toISOString() }), { mode: 0o600 });
    expect(loadOptionsState()).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    // Write garbage to the options state file
    writeFileSync(join(CONFIG_DIR, "last-options.json"), "not valid json");
    expect(loadOptionsState()).toBeNull();
  });

  // ── VOY-1793: selection search params ─────────────────────────────────────
  describe("getSelectionSearchParams / rememberSelectionSearchParams", () => {
    let backup: string | null = null;
    beforeEach(() => {
      backup = existsSync(SELECTION_PARAMS_FILE) ? readFileSync(SELECTION_PARAMS_FILE, "utf-8") : null;
      clearSelectionSearchParams();
    });
    afterEach(() => {
      clearSelectionSearchParams();
      if (backup !== null) writeFileSync(SELECTION_PARAMS_FILE, backup, { mode: 0o600 });
    });

    it("returns null before anything is recorded", () => {
      expect(getSelectionSearchParams("sel-x")).toBeNull();
    });

    it("records params on first sight and reads them back", () => {
      rememberSelectionSearchParams("sel-x", { origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
      expect(getSelectionSearchParams("sel-x")).toEqual({ origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 });
    });

    it("PRESERVES the original params — a later remember with different params does not overwrite", () => {
      rememberSelectionSearchParams("sel-x", { depart: "2026-08-01" });
      rememberSelectionSearchParams("sel-x", { depart: "2026-09-01" });
      expect(getSelectionSearchParams("sel-x")).toEqual({ depart: "2026-08-01" });
    });

    it("keeps records for distinct selections independent", () => {
      rememberSelectionSearchParams("sel-a", { depart: "2026-08-01" });
      rememberSelectionSearchParams("sel-b", { checkin: "2026-08-02" });
      expect(getSelectionSearchParams("sel-a")).toEqual({ depart: "2026-08-01" });
      expect(getSelectionSearchParams("sel-b")).toEqual({ checkin: "2026-08-02" });
    });

    it("prunes stale entries (older than the max age) on write", () => {
      const old = new Date("2020-01-01T00:00:00.000Z");
      rememberSelectionSearchParams("sel-old", { depart: "2020-01-01" }, old);
      // A fresh write happens 'now' — the ancient entry should be pruned.
      rememberSelectionSearchParams("sel-new", { depart: "2026-08-01" });
      expect(getSelectionSearchParams("sel-old")).toBeNull();
      expect(getSelectionSearchParams("sel-new")).toEqual({ depart: "2026-08-01" });
    });

    it("degrades to no-record on a corrupt params file (never throws)", () => {
      writeFileSync(SELECTION_PARAMS_FILE, "not valid json", { mode: 0o600 });
      expect(getSelectionSearchParams("sel-x")).toBeNull();
      expect(() => rememberSelectionSearchParams("sel-x", { depart: "2026-08-01" })).not.toThrow();
      expect(getSelectionSearchParams("sel-x")).toEqual({ depart: "2026-08-01" });
    });

    it("drops an entry whose param fields carry the wrong types (tampered file degrades to no-record)", () => {
      const ts = new Date().toISOString();
      writeFileSync(
        SELECTION_PARAMS_FILE,
        JSON.stringify({ selections: {
          "sel-bad": { params: { origin: 12345, partySize: "lots", destination: { nested: 1 } }, timestamp: ts },
          "sel-ok": { params: { origin: "LAX", destination: "NRT", partySize: 2 }, timestamp: ts },
        } }, null, 2),
        { mode: 0o600 },
      );
      // The tampered entry never reaches diffSearchParams / the JSON envelope.
      expect(getSelectionSearchParams("sel-bad")).toBeNull();
      // A well-formed sibling still loads.
      expect(getSelectionSearchParams("sel-ok")).toEqual({ origin: "LAX", destination: "NRT", partySize: 2 });
    });

    it("ignores prototype-pollution keys in the stored map", () => {
      const ts = new Date().toISOString();
      // Raw JSON so `__proto__` lands as an own key (JSON.parse never runs the setter).
      writeFileSync(
        SELECTION_PARAMS_FILE,
        `{"selections":{"__proto__":{"params":{"depart":"2026-08-01"},"timestamp":"${ts}"},` +
          `"sel-x":{"params":{"depart":"2026-08-01"},"timestamp":"${ts}"}}}`,
        { mode: 0o600 },
      );
      expect(getSelectionSearchParams("sel-x")).toEqual({ depart: "2026-08-01" });
      expect(getSelectionSearchParams("__proto__")).toBeNull();
      // No global pollution: a fresh plain object gained no `params` key.
      expect(({} as Record<string, unknown>).params).toBeUndefined();
    });

    it("prunes stale siblings on the REUSE path — an existing selectionId still triggers prune+write", () => {
      // Simulate a file that accumulated a stale sibling under the pre-fix
      // early-return behavior: a fresh entry for the selection about to be
      // re-searched, plus an ancient one.
      const at = new Date("2026-07-01T00:00:00.000Z");
      writeFileSync(
        SELECTION_PARAMS_FILE,
        JSON.stringify({ selections: {
          "sel-live": { params: { depart: "2026-08-01" }, timestamp: at.toISOString() },
          "sel-stale": { params: { depart: "2020-01-01" }, timestamp: "2020-01-01T00:00:00.000Z" },
        } }, null, 2),
        { mode: 0o600 },
      );
      // Re-search the SAME live selection (exists → original preserved).
      rememberSelectionSearchParams("sel-live", { depart: "2026-09-01" }, at);
      expect(getSelectionSearchParams("sel-stale")).toBeNull(); // sibling pruned despite the reuse
      expect(getSelectionSearchParams("sel-live")).toEqual({ depart: "2026-08-01" }); // original preserved
    });
  });
});
