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
