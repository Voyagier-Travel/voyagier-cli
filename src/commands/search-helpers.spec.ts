import { jest, describe, it, expect, beforeAll, beforeEach } from "@jest/globals";

const mockGraphql = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

let SH: typeof import("./search-helpers.js");
let CliError: typeof import("../errors.js").CliError;
let CliErrorCode: typeof import("../errors.js").CliErrorCode;

beforeAll(async () => {
  SH = await import("./search-helpers.js");
  const errs = await import("../errors.js");
  CliError = errs.CliError;
  CliErrorCode = errs.CliErrorCode;
});

beforeEach(() => {
  mockGraphql.mockReset();
});

function goal(over: Partial<import("./search-helpers.js").SearchGoal> = {}): import("./search-helpers.js").SearchGoal {
  return {
    id: "g-flight",
    name: "Outbound Flights",
    type: "Flight",
    sortOrder: 1,
    items: [
      {
        selections: [
          { id: "sel-list", type: "FlightList" },
          { id: "sel-origin", type: "Airport" },
          { id: "sel-dest", type: "Airport" },
        ],
      },
    ],
    ...over,
  };
}

describe("loadGoals", () => {
  it("returns goals sorted by sortOrder", async () => {
    mockGraphql.mockResolvedValue({
      tripPlanGoals: [
        { id: "b", name: "B", type: "Hotel", sortOrder: 2, items: [] },
        { id: "a", name: "A", type: "Flight", sortOrder: 1, items: [] },
      ],
    });
    const goals = await SH.loadGoals("plan-1");
    expect(goals.map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("tolerates a null tripPlanGoals", async () => {
    mockGraphql.mockResolvedValue({ tripPlanGoals: null });
    expect(await SH.loadGoals("plan-1")).toEqual([]);
  });
});

describe("resolveGoal", () => {
  it("returns the explicit goal by id when present", () => {
    const goals = [goal(), goal({ id: "g2", type: "Hotel", name: "Lodging" })];
    expect(SH.resolveGoal(goals, "hotels", "g2").id).toBe("g2");
  });

  it("throws NOT_FOUND when explicit goal id is missing", () => {
    try {
      SH.resolveGoal([goal()], "flights", "nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as InstanceType<typeof CliError>).code).toBe(CliErrorCode.NOT_FOUND);
    }
  });

  it("falls back to first goal matching the kind's goal type", () => {
    const goals = [goal({ id: "h", type: "Hotel" }), goal({ id: "f", type: "Flight" })];
    expect(SH.resolveGoal(goals, "flights").id).toBe("f");
  });

  it("throws NOT_FOUND with an add-goal hint when no goal of the type exists", () => {
    try {
      SH.resolveGoal([goal({ type: "Hotel" })], "flights");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as InstanceType<typeof CliError>).message).toMatch(/goal-add/);
    }
  });
});

describe("resolveMirrorList", () => {
  it("returns the matching *List selection id", () => {
    expect(SH.resolveMirrorList(goal(), "flights")).toBe("sel-list");
  });

  it("throws NOT_FOUND when the goal has no mirror list", () => {
    const g = goal({ items: [{ selections: [{ id: "x", type: "Airport" }] }] });
    try {
      SH.resolveMirrorList(g, "flights");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InstanceType<typeof CliError>).code).toBe(CliErrorCode.NOT_FOUND);
    }
  });

  it("tolerates missing items/selections", () => {
    expect(() => SH.resolveMirrorList(goal({ items: [] }), "hotels")).toThrow(CliError);
  });
});

describe("resolveDecisionSelection (VOY-1692: reuse the goal's decision selection)", () => {
  it("returns the goal's existing decision selection id for the kind", () => {
    const g = goal({
      items: [
        {
          selections: [
            { id: "sel-list", type: "FlightList" },
            { id: "sel-decision", type: "Flight" },
            { id: "sel-origin", type: "Airport" },
          ],
        },
      ],
    });
    expect(SH.resolveDecisionSelection(g, "flights")).toBe("sel-decision");
  });

  it("does NOT match the *List selection (list-mode selections reject picks)", () => {
    // Default goal() fixture has FlightList + Airports but no Flight decision selection.
    expect(SH.resolveDecisionSelection(goal(), "flights")).toBeNull();
  });

  it("matches Hotel decision selections for the hotels kind", () => {
    const g = goal({
      type: "Hotel",
      items: [{ selections: [{ id: "h-list", type: "HotelList" }, { id: "h-decision", type: "Hotel" }] }],
    });
    expect(SH.resolveDecisionSelection(g, "hotels")).toBe("h-decision");
  });

  it("returns null when the goal has no items", () => {
    expect(SH.resolveDecisionSelection(goal({ items: [] }), "flights")).toBeNull();
  });
});

describe("airportSelections", () => {
  it("returns Airport selection ids in document order", () => {
    expect(SH.airportSelections(goal())).toEqual(["sel-origin", "sel-dest"]);
  });

  it("returns empty when there are no airport selections", () => {
    expect(SH.airportSelections(goal({ items: [{ selections: [{ id: "l", type: "HotelList" }] }] }))).toEqual([]);
  });
});

describe("findDateSelection", () => {
  it("finds a Date selection anywhere on the plan", () => {
    const goals = [
      goal(),
      goal({ id: "dates", type: "Date", items: [{ selections: [{ id: "sel-date", type: "Date" }] }] }),
    ];
    expect(SH.findDateSelection(goals)).toBe("sel-date");
  });

  it("returns null when no Date selection exists", () => {
    expect(SH.findDateSelection([goal()])).toBeNull();
  });
});

describe("graphql wrappers", () => {
  it("setAirport calls UPDATE_AIRPORT_SELECTION with location input", async () => {
    mockGraphql.mockResolvedValue({});
    await SH.setAirport("sel-1", "MCO");
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ selectionId: "sel-1", input: { location: "MCO" } });
  });

  it("addDateOption calls ADD_DATE_OPTION with startDate", async () => {
    mockGraphql.mockResolvedValue({});
    await SH.addDateOption("sel-1", "2026-09-01");
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ selectionId: "sel-1", startDate: "2026-09-01" });
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days, end - start", () => {
    expect(SH.daysBetween("2026-09-15", "2026-09-22")).toBe(7);
    expect(SH.daysBetween("2026-08-01", "2026-08-10")).toBe(9);
  });

  it("is UTC-safe across a month boundary", () => {
    expect(SH.daysBetween("2026-01-30", "2026-02-02")).toBe(3);
  });

  it("returns null for same-day, reversed, or malformed input", () => {
    expect(SH.daysBetween("2026-09-15", "2026-09-15")).toBeNull();
    expect(SH.daysBetween("2026-09-22", "2026-09-15")).toBeNull();
    expect(SH.daysBetween("not-a-date", "2026-09-15")).toBeNull();
    expect(SH.daysBetween("2026-09-15", "")).toBeNull();
  });

  it("returns null for impossible calendar dates (no overflow normalization)", () => {
    // 2026 is not a leap year; Feb 30 / Feb 29 must be rejected, not rolled over.
    expect(SH.daysBetween("2026-02-01", "2026-02-30")).toBeNull();
    expect(SH.daysBetween("2026-02-29", "2026-03-05")).toBeNull();
    expect(SH.daysBetween("2026-13-01", "2026-12-01")).toBeNull();
    expect(SH.daysBetween("2026-04-31", "2026-05-10")).toBeNull();
  });
});

describe("resolveDateRange (VOY-1421: populate BOTH date outputs)", () => {
  it("one-way: only adds the start date option, no duration set", async () => {
    mockGraphql.mockResolvedValue({});
    await SH.resolveDateRange("sel-date", "2026-09-15");
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ selectionId: "sel-date", startDate: "2026-09-15" });
  });

  it("round-trip: adds start option, then sets duration = INCLUSIVE trip days (daysBetween + 1)", async () => {
    // Server computes endDate = startDate + duration − 1, so 09-15 → 09-22 (7 days
    // apart) must send duration 8 for the endDate output to land on 09-22 exactly.
    // Sending the exclusive difference shifted every return flight / hotel checkout
    // one day early (VOY-1723).
    mockGraphql.mockResolvedValue({});
    await SH.resolveDateRange("sel-date", "2026-09-15", "2026-09-22");
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, addVars] = mockGraphql.mock.calls[0] as [string, any];
    const [, durVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(addVars).toEqual({ selectionId: "sel-date", startDate: "2026-09-15" });
    expect(durVars).toEqual({ selectionId: "sel-date", fieldName: "duration", value: 8 });
  });

  it("adjacent dates (one night): sends duration 2 so endDate lands on checkout day", async () => {
    mockGraphql.mockResolvedValue({});
    await SH.resolveDateRange("sel-date", "2026-09-10", "2026-09-11");
    const [, durVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(durVars).toEqual({ selectionId: "sel-date", fieldName: "duration", value: 2 });
  });

  it("throws VALIDATION for a bad range BEFORE any mutation (no partial write)", async () => {
    mockGraphql.mockResolvedValue({});
    await expect(SH.resolveDateRange("sel-date", "2026-09-15", "2026-09-10")).rejects.toBeInstanceOf(CliError);
    // Range is validated first: no start-date option is left behind on the error path.
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("throws VALIDATION for an impossible end date without mutating", async () => {
    mockGraphql.mockResolvedValue({});
    await expect(SH.resolveDateRange("sel-date", "2026-02-01", "2026-02-30")).rejects.toBeInstanceOf(CliError);
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

describe("resolveReturnFlightGoal (VOY-1421 wire the return leg; VOY-1870 pair correctly)", () => {
  const flightGoal = (
    id: string,
    segmentIndex?: number,
    travellerIds?: string[],
  ) =>
    goal({
      id,
      name: id,
      type: "Flight",
      items: [
        {
          selections: [
            {
              id: `${id}-f`,
              type: "Flight",
              ...(segmentIndex != null ? { segmentIndex } : {}),
              ...(travellerIds ? { assignedTravellers: travellerIds.map((t) => ({ id: t })) } : {}),
            },
          ],
        },
      ],
    });

  it("finds the goal whose child selection has segmentIndex === 1", () => {
    const goals = [flightGoal("g-out", 0), flightGoal("g-ret", 1), goal({ id: "g-hotel", type: "Hotel" })];
    expect(SH.resolveReturnFlightGoal(goals, "g-out")?.id).toBe("g-ret");
  });

  it("falls back to the single remaining Flight goal when segment indices are absent", () => {
    const goals = [flightGoal("g-out"), flightGoal("g-ret"), goal({ id: "g-hotel", type: "Hotel" })];
    expect(SH.resolveReturnFlightGoal(goals, "g-out")?.id).toBe("g-ret");
  });

  it("returns null for a one-way plan (no other Flight goal)", () => {
    const goals = [flightGoal("g-out", 0), goal({ id: "g-hotel", type: "Hotel" })];
    expect(SH.resolveReturnFlightGoal(goals, "g-out")).toBeNull();
  });

  it("prefers the segmentIndex === 1 goal even when several Flight goals remain (only one seg-1 candidate)", () => {
    const goals = [flightGoal("g-out", 0), flightGoal("g-a"), flightGoal("g-ret", 1)];
    expect(SH.resolveReturnFlightGoal(goals, "g-out")?.id).toBe("g-ret");
  });

  it("group plan: pairs the return goal by shared traveller assignment, not by first seg-1", () => {
    // Two travellers, each with their own outbound/return pair. The outbound
    // being searched (g-out-A) belongs to traveller t1, so it must pair with the
    // return goal assigned to t1 — NOT the arbitrary first seg-1 goal.
    const goals = [
      flightGoal("g-out-A", 0, ["t1"]),
      flightGoal("g-out-B", 0, ["t2"]),
      flightGoal("g-ret-B", 1, ["t2"]),
      flightGoal("g-ret-A", 1, ["t1"]),
    ];
    expect(SH.resolveReturnFlightGoal(goals, "g-out-A")?.id).toBe("g-ret-A");
    expect(SH.resolveReturnFlightGoal(goals, "g-out-B")?.id).toBe("g-ret-B");
  });

  it("throws RETURN_GOAL_AMBIGUOUS listing candidates when multiple seg-1 goals have no distinguishing linkage", () => {
    // Two return candidates, no traveller assignments to pair on -> fail closed.
    const goals = [flightGoal("g-out", 0), flightGoal("g-ret-a", 1), flightGoal("g-ret-b", 1)];
    try {
      SH.resolveReturnFlightGoal(goals, "g-out");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      const err = e as InstanceType<typeof CliError>;
      expect(err.code).toBe(CliErrorCode.RETURN_GOAL_AMBIGUOUS);
      expect(err.message).toContain("g-ret-a");
      expect(err.message).toContain("g-ret-b");
      expect(err.details?.candidateGoalIds).toEqual(["g-ret-a", "g-ret-b"]);
    }
  });

  it("throws RETURN_GOAL_AMBIGUOUS when several unmarked Flight goals remain and can't be paired", () => {
    // Three flight goals, none marked seg 1, more than one remaining, no
    // assignments to pair on -> ambiguous -> fail closed (was silently null).
    const goals = [flightGoal("g-out", 0), flightGoal("g-a"), flightGoal("g-b")];
    try {
      SH.resolveReturnFlightGoal(goals, "g-out");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as InstanceType<typeof CliError>).code).toBe(CliErrorCode.RETURN_GOAL_AMBIGUOUS);
    }
  });
});

describe("requireAirports (fail-fast on insufficient inputs)", () => {
  it("returns the ids when the goal has >= min airport selections", () => {
    expect(SH.requireAirports(goal(), 2)).toEqual(["sel-origin", "sel-dest"]);
  });

  it("throws VALIDATION (not a silent skip) when the goal has too few airports", () => {
    const g = goal({ items: [{ selections: [{ id: "a", type: "Airport" }, { id: "l", type: "FlightList" }] }] });
    try {
      SH.requireAirports(g, 2);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as InstanceType<typeof CliError>).code).toBe(CliErrorCode.VALIDATION);
      expect((e as InstanceType<typeof CliError>).message).toMatch(/plans goals/);
    }
  });
});

describe("requireDateSelection (fail-fast on missing Date)", () => {
  it("returns the Date selection id when present", () => {
    const goals = [goal({ id: "d", type: "Date", items: [{ selections: [{ id: "sel-date", type: "Date" }] }] })];
    expect(SH.requireDateSelection(goals)).toBe("sel-date");
  });

  it("throws VALIDATION when no Date selection exists", () => {
    try {
      SH.requireDateSelection([goal()]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InstanceType<typeof CliError>).code).toBe(CliErrorCode.VALIDATION);
    }
  });
});

describe("findDestinationSelection + setDestination", () => {
  const goalsWithDest = () => [
    goal(),
    goal({ id: "dest", type: "Destination", items: [{ selections: [{ id: "sel-dest-goal", type: "Destination" }] }] }),
  ];

  it("finds the plan-level Destination selection", () => {
    expect(SH.findDestinationSelection(goalsWithDest())).toBe("sel-dest-goal");
  });

  it("returns null when there is no Destination selection", () => {
    expect(SH.findDestinationSelection([goal()])).toBeNull();
  });

  it("setDestination applies SET_DESTINATION_VALUE to the Destination selection", async () => {
    mockGraphql.mockResolvedValue({});
    await SH.setDestination(goalsWithDest(), "Orlando, FL");
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ selectionId: "sel-dest-goal", name: "Orlando, FL" });
  });

  it("setDestination throws VALIDATION (no silent no-op) when there's no Destination selection", async () => {
    await expect(SH.setDestination([goal()], "Orlando, FL")).rejects.toBeInstanceOf(CliError);
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

// ── VOY-1793: selection-reuse param diffing ─────────────────────────────────

describe("diffSearchParams", () => {
  it("flags only the fields that differ (both sides set)", () => {
    expect(SH.diffSearchParams(
      { origin: "LAX", destination: "NRT", depart: "2026-08-01", partySize: 1 },
      { origin: "LAX", destination: "NRT", depart: "2026-09-01", partySize: 1 },
    )).toEqual(["depart"]);
  });

  it("returns [] when every comparable field matches", () => {
    const p = { destination: "Paris", checkin: "2026-08-01", checkout: "2026-08-05", partySize: 2 };
    expect(SH.diffSearchParams(p, { ...p })).toEqual([]);
  });

  it("does not flag fields that are undefined on both sides (a field irrelevant to this selection kind)", () => {
    // Hotel params: origin/depart/return stay undefined on both — not mismatches.
    expect(SH.diffSearchParams(
      { destination: "Paris", checkin: "2026-08-01", checkout: "2026-08-05" },
      { destination: "Paris", checkin: "2026-08-01", checkout: "2026-08-05" },
    )).toEqual([]);
  });

  it("flags a one-way → round-trip transition (return added)", () => {
    expect(SH.diffSearchParams(
      { origin: "LAX", destination: "NRT", depart: "2026-08-01" },
      { origin: "LAX", destination: "NRT", depart: "2026-08-01", return: "2026-08-10" },
    )).toEqual(["return"]);
  });

  it("flags a party-size change", () => {
    expect(SH.diffSearchParams({ partySize: 1 }, { partySize: 3 })).toEqual(["partySize"]);
  });
});

describe("formatReuseWarning", () => {
  it("starts with the stable token and spells out each changed field as from → to", () => {
    const msg = SH.formatReuseWarning(
      ["depart", "partySize"],
      { depart: "2026-08-01", partySize: 1 },
      { depart: "2026-09-01", partySize: 2 },
    );
    expect(msg.startsWith("SELECTION_REUSED_PARAMS_MISMATCH")).toBe(true);
    expect(msg).toContain("departure date 2026-08-01 → 2026-09-01");
    expect(msg).toContain("party size 1 → 2");
  });
});
