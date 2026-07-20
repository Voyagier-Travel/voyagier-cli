import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});
const mockFatal = jest.fn().mockImplementation((msg: string) => {
  throw new CliError(CliErrorCode.VALIDATION, msg);
});

jest.unstable_mockModule("../../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../../output.js", () => ({
  jsonOutput: mockJsonOutput,
  fatal: mockFatal,
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerItemCommands: (plans: Command) => void;

beforeAll(async () => {
  const mod = await import("./items.js");
  registerItemCommands = mod.registerItemCommands;
});

// ── Fixtures & helpers ────────────────────────────────────────────────────────

const flightItem = {
  id: "i-flight",
  type: "Selection",
  title: "Flight to Paris",
  selections: [
    {
      id: "s1",
      type: "Flight",
      isLocked: false,
      parentOptionId: "o1",
      options: [{ id: "o1", name: "B6 DCA→CDG", price: 268 }],
    },
  ],
};

const hotelItem = {
  id: "i-hotel",
  type: "Selection",
  title: "Hotel in Paris",
  selections: [
    { id: "s2", type: "Hotel", isLocked: false, parentOptionId: null, options: [{ id: "h1", name: "Le Marais", price: 150 }] },
  ],
};

let writes: string[];
let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let logSpy: jest.SpiedFunction<typeof console.log>;

const logJoined = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  mockFatal.mockClear();
  writes = [];
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  writeSpy.mockRestore();
  logSpy.mockRestore();
});

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerItemCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", ...args]);
}

// ── plans items ───────────────────────────────────────────────────────────

describe("plans items", () => {
  it("--json maps items with inferred type, status, and chosen option", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlan: { id: "plan-1", title: "Paris", items: [flightItem, hotelItem] },
    });
    await run(["items", "plan-1", "--json"]);

    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ id: "plan-1" });

    const out = JSON.parse(writes.join(""));
    expect(out.planId).toBe("plan-1");
    expect(out.items).toHaveLength(2);

    const flight = out.items.find((i: any) => i.id === "i-flight");
    expect(flight.inferredType).toBe("flight");
    expect(flight.status).toBe("selected");
    expect(flight.selections[0].selectedOption).toEqual({ id: "o1", name: "B6 DCA→CDG", price: 268 });

    const hotel = out.items.find((i: any) => i.id === "i-hotel");
    expect(hotel.inferredType).toBe("hotel");
    expect(hotel.status).toBe("pending");
    expect(hotel.selections[0].selectedOption).toBeNull();
  });

  it("human mode lists items with status labels and chosen option", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlan: { id: "plan-1", title: "Paris", items: [flightItem, hotelItem] },
    });
    await run(["items", "plan-1"]);
    const out = logJoined();
    expect(out).toContain("Items — Paris");
    expect(out).toContain("Flight to Paris");
    expect(out).toContain("selected");
    expect(out).toContain("B6 DCA→CDG");
    expect(out).toContain("Hotel in Paris");
    expect(out).toContain("pending");
  });

  it("human mode shows 'No items yet.' for an empty plan", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: { id: "plan-1", title: "Empty", items: [] } });
    await run(["items", "plan-1"]);
    expect(logJoined()).toContain("No items yet.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("boom"));
    await expect(run(["items", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── plans remove-item ─────────────────────────────────────────────────────────

describe("plans remove-item", () => {
  it("deletes a single item by id (--json)", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanItem: true });
    await run(["remove-item", "i-flight", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ id: "i-flight" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, deleted: ["i-flight"] });
  });

  it("deletes a single item by id (human)", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanItem: true });
    await run(["remove-item", "i-flight"]);
    expect(logJoined()).toContain("Removed item i-flight");
  });

  it("requires --plan for bulk operations", async () => {
    await expect(run(["remove-item", "--all", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("removes only items of a given --type", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlan: { id: "plan-1", items: [flightItem, hotelItem] } }) // GET_PLAN_DEEP
      .mockResolvedValueOnce({ deleteTripPlanItem: true }); // delete i-flight
    await run(["remove-item", "--plan", "plan-1", "--type", "flight", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, delVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(delVars).toEqual({ id: "i-flight" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, deleted: ["i-flight"] });
  });

  it("rejects an invalid --type", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: { id: "plan-1", items: [flightItem] } });
    await expect(
      run(["remove-item", "--plan", "plan-1", "--type", "car", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("removes every item with --all", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlan: { id: "plan-1", items: [flightItem, hotelItem] } })
      .mockResolvedValueOnce({ deleteTripPlanItem: true })
      .mockResolvedValueOnce({ deleteTripPlanItem: true });
    await run(["remove-item", "--plan", "plan-1", "--all", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(3);
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, deleted: ["i-flight", "i-hotel"] });
  });

  it("--all prints a human confirmation with the count", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlan: { id: "plan-1", items: [flightItem, hotelItem] } })
      .mockResolvedValueOnce({ deleteTripPlanItem: true })
      .mockResolvedValueOnce({ deleteTripPlanItem: true });
    await run(["remove-item", "--plan", "plan-1", "--all"]);
    expect(logJoined()).toContain("Removed 2 items");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("nope"));
    await expect(run(["remove-item", "i-flight", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});
