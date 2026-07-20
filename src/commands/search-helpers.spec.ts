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

  it("round-trip: adds start option, then sets duration = days between", async () => {
    mockGraphql.mockResolvedValue({});
    await SH.resolveDateRange("sel-date", "2026-09-15", "2026-09-22");
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, addVars] = mockGraphql.mock.calls[0] as [string, any];
    const [, durVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(addVars).toEqual({ selectionId: "sel-date", startDate: "2026-09-15" });
    expect(durVars).toEqual({ selectionId: "sel-date", fieldName: "duration", value: 7 });
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

describe("resolveReturnFlightGoal (VOY-1421: wire the return leg)", () => {
  const flightGoal = (id: string, segmentIndex?: number) =>
    goal({
      id,
      type: "Flight",
      items: [{ selections: [{ id: `${id}-f`, type: "Flight", ...(segmentIndex != null ? { segmentIndex } : {}) }] }],
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

  it("returns null when multiple return candidates lack a segmentIndex === 1 marker", () => {
    // Three flight goals, none marked seg 1, more than one remaining -> ambiguous -> null.
    const goals = [flightGoal("g-out", 0), flightGoal("g-a"), flightGoal("g-b")];
    expect(SH.resolveReturnFlightGoal(goals, "g-out")).toBeNull();
  });

  it("prefers the segmentIndex === 1 goal even when several Flight goals remain", () => {
    const goals = [flightGoal("g-out", 0), flightGoal("g-a"), flightGoal("g-ret", 1)];
    expect(SH.resolveReturnFlightGoal(goals, "g-out")?.id).toBe("g-ret");
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
