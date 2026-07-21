import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

const mockGraphql = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

let registerCartCommands: (program: Command) => void;
beforeAll(async () => {
  registerCartCommands = (await import("./cart.js")).registerCartCommands;
});

const FIXTURE_FULL = {
  tripPlan: {
    id: "plan-1",
    title: "Paris Trip",
    cart: {
      itemCount: 2,
      total: 1840,
      currency: "USD",
      items: [
        {
          id: "ci-1", name: "Hotel Le Bristol — King Suite", description: "King Suite",
          price: 1840, currency: "USD", type: "Hotel", selectionId: "sel-h", optionId: "opt-h",
          metadata: {},
        },
        {
          id: "ci-2", name: "AF023 DCA→CDG", description: "Coach",
          price: 0, currency: "USD", type: "Flight", selectionId: "sel-f", optionId: "opt-f",
          metadata: {},
        },
      ],
    },
    goals: [
      {
        id: "g-flight", name: "Outbound Flight", sortOrder: 1,
        items: [{
          id: "i-f", title: "Flight", goalId: "g-flight",
          selections: [{
            id: "sel-f", type: "Flight", isLocked: false,
            options: [{ id: "opt-f", name: "AF023", isBookable: false, status: "ACTIVE", blueprintListingId: null, externalId: "sabre:af023" }],
          }],
        }],
      },
      {
        id: "g-hotel", name: "Paris Hotel", sortOrder: 2,
        items: [{
          id: "i-h", title: "Hotel", goalId: "g-hotel",
          selections: [{
            id: "sel-h", type: "Hotel", isLocked: false,
            options: [{ id: "opt-h", name: "King Suite", isBookable: true, status: "ACTIVE", blueprintListingId: "bl-1", externalId: "blueprint:1" }],
          }],
        }],
      },
    ],
  },
};

const FIXTURE_EMPTY = {
  tripPlan: {
    id: "plan-1",
    title: "Empty Trip",
    cart: { itemCount: 0, total: 0, currency: "USD", items: [] },
    goals: [],
  },
};

async function runCart(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCartCommands(program);
  await program.parseAsync(["node", "voyagier", "cart", ...args]);
}

describe("voyagier cart", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stdoutOutput: string[] = [];

  beforeEach(() => {
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      stdoutOutput.push(typeof c === "string" ? c : String(c));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("emits the v2 envelope on --json", async () => {
    mockGraphql.mockResolvedValue(FIXTURE_FULL);
    await runCart(["plan-1", "--json"]);
    const out = JSON.parse(stdoutOutput.join(""));
    expect(out.ok).toBe(true);
    expect(out.data.cart.itemCount).toBe(2);
    expect(out.data.cart.byGoal).toHaveLength(2);
    expect(out.planContext.planId).toBe("plan-1");
    expect(out.planContext.url).toContain("/plans/plan-1");
  });

  it("groups by goal and orders by sortOrder", async () => {
    mockGraphql.mockResolvedValue(FIXTURE_FULL);
    await runCart(["plan-1", "--json"]);
    const out = JSON.parse(stdoutOutput.join(""));
    expect(out.data.cart.byGoal[0].goalId).toBe("g-flight");
    expect(out.data.cart.byGoal[1].goalId).toBe("g-hotel");
  });

  it("marks each item with isBookable + source + reason", async () => {
    mockGraphql.mockResolvedValue(FIXTURE_FULL);
    await runCart(["plan-1", "--json"]);
    const out = JSON.parse(stdoutOutput.join(""));
    const flightItem = out.data.cart.byGoal.find((g: { goalId: string }) => g.goalId === "g-flight").items[0];
    const hotelItem = out.data.cart.byGoal.find((g: { goalId: string }) => g.goalId === "g-hotel").items[0];
    expect(flightItem.isBookable).toBe(false);
    expect(flightItem.source).toBe("AIR_SUPPLIER");
    expect(flightItem.bookableReason).toContain("Fare & Cabin");
    expect(hotelItem.isBookable).toBe(true);
    expect(hotelItem.source).toBe("ACCOMMODATION_SUPPLIER");
    expect(hotelItem.bookableReason).toBeNull();
  });

  it("renders empty cart cleanly", async () => {
    mockGraphql.mockResolvedValue(FIXTURE_EMPTY);
    await runCart(["plan-1", "--json"]);
    const out = JSON.parse(stdoutOutput.join(""));
    expect(out.data.cart.itemCount).toBe(0);
    expect(out.data.cart.byGoal).toHaveLength(0);
  });

  it("--agent emits markdown with bookable / display-only badges", async () => {
    mockGraphql.mockResolvedValue(FIXTURE_FULL);
    await runCart(["plan-1", "--agent"]);
    const out = stdoutOutput.join("");
    expect(out).toContain("## 🛒 Cart");
    expect(out).toContain("**bookable**");
    expect(out).toContain("display-only");
  });

  it("throws NOT_FOUND when the API returns null tripPlan", async () => {
    mockGraphql.mockResolvedValue({ tripPlan: null });
    await expect(runCart(["missing", "--json"])).rejects.toBeInstanceOf(CliError);
  });

  it("wraps API errors as API_ERROR", async () => {
    mockGraphql.mockRejectedValue(new Error("boom"));
    let captured: unknown;
    try {
      await runCart(["plan-1", "--json"]);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(CliError);
    expect((captured as CliError).code).toBe(CliErrorCode.API_ERROR);
  });
});
