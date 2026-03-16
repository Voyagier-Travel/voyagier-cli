import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// Must be declared before any imports of the mocked module
const mockGraphql = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AuthError";
    }
  },
}));

// Dynamically imported after mocks are registered
let registerBookCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./book.js");
  registerBookCommands = mod.registerBookCommands;
});

// ─── Test data fixtures ────────────────────────────────────────────────────

const PLAN_NO_PENDING = {
  tripPlan: {
    id: "plan-123",
    title: "Tokyo Trip",
    items: [
      {
        id: "item-1",
        title: "Flight JFK→NRT",
        selection: {
          id: "sel-1",
          isLocked: false,
          selectedOption: {
            id: "opt-1",
            name: "AA175",
            price: 800,
            status: "ACTIVE",
            subSelections: [
              {
                id: "sub-1",
                type: "FLIGHT_CLASS",
                selectedOptionId: "class-eco", // already chosen — not pending
                options: [{ id: "class-eco" }, { id: "class-biz" }],
              },
            ],
          },
        },
      },
    ],
  },
};

const PLAN_WITH_PENDING = {
  tripPlan: {
    id: "plan-123",
    title: "Tokyo Trip",
    items: [
      {
        id: "item-1",
        title: "Flight JFK→NRT",
        selection: {
          id: "sel-1",
          isLocked: false,
          selectedOption: {
            id: "opt-1",
            name: "AA175",
            price: 800,
            status: "ACTIVE",
            subSelections: [
              {
                id: "sub-1",
                type: "FLIGHT_CLASS",
                // no selectedOptionId — pending choice required
                options: [{ id: "class-eco" }, { id: "class-biz" }],
              },
            ],
          },
        },
      },
    ],
  },
};

const CART_WITH_ITEMS = {
  getTripPlanCart: {
    items: [
      { id: "ci-1", name: "AA175 JFK→NRT", description: "Economy", price: 800, type: "FLIGHT" },
      { id: "ci-2", name: "Park Hyatt Tokyo", description: "Deluxe Room", price: 500, type: "HOTEL" },
    ],
    total: 1300,
    itemCount: 2,
  },
};

const CART_EMPTY = {
  getTripPlanCart: {
    items: [],
    total: 0,
    itemCount: 0,
  },
};

const CHECKOUT_RESULT = {
  createTripPlanCheckout: {
    url: "https://checkout.stripe.com/pay/cs_test_abc123",
  },
};

const PAYMENT_CHECKOUTS_WITH_RECORDS = {
  tripPlanPaymentCheckouts: [
    {
      id: "co-abc",
      status: "PAID",
      checkoutUrl: "https://checkout.stripe.com/pay/cs_test_abc123",
      createdAt: "2026-03-10T12:00:00.000Z",
      bookingRecords: [
        {
          id: "br-1",
          type: "FLIGHT_BOOKING",
          status: "CONFIRMED",
          pnr: "XYZABC",
          providerReference: null,
          amount: 80000, // cents
        },
      ],
    },
  ],
};

const PAYMENT_CHECKOUTS_EMPTY = {
  tripPlanPaymentCheckouts: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeGraphqlMock(overrides: Record<string, unknown> = {}) {
  return (query: string) => {
    if (query.includes("getTripPlanCart")) {
      return Promise.resolve(overrides.cart ?? CART_WITH_ITEMS);
    }
    if (query.includes("TripPlanDeep")) {
      return Promise.resolve(overrides.plan ?? PLAN_NO_PENDING);
    }
    if (query.includes("createTripPlanCheckout")) {
      return Promise.resolve(overrides.checkout ?? CHECKOUT_RESULT);
    }
    if (query.includes("tripPlanPaymentCheckouts")) {
      return Promise.resolve(overrides.checkouts ?? PAYMENT_CHECKOUTS_WITH_RECORDS);
    }
    return Promise.reject(new Error(`Unexpected query: ${query.slice(0, 60)}`));
  };
}

async function runBook(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBookCommands(program);
  await program.parseAsync(["node", "voyagier", "book", ...args]);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("book command", () => {
  let stdoutOutput: string[];
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    process.env.VOYAGIER_TOKEN = "test-token";
    process.env.VOYAGIER_API_URL = "https://api.test.voyagier.com/graphql";

    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    mockGraphql.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.VOYAGIER_TOKEN;
    delete process.env.VOYAGIER_API_URL;
  });

  // ── 1. Pre-flight: pending sub-selections ─────────────────────────────

  it("throws VALIDATION when items have pending sub-selections", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock({ plan: PLAN_WITH_PENDING }));

    let err: unknown;
    try {
      await runBook(["plan-123"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("Cannot checkout");
    expect((err as CliError).message).toContain("Flight JFK→NRT");
  });

  // ── 2. Pre-flight: empty cart ─────────────────────────────────────────

  it("throws VALIDATION when cart is empty", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock({ cart: CART_EMPTY }));

    let err: unknown;
    try {
      await runBook(["plan-123"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    expect((err as CliError).message).toContain("Cart is empty");
  });

  // ── 3. Dry-run JSON output ────────────────────────────────────────────

  it("outputs correct JSON shape in --dry-run --json mode", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--dry-run", "--json"]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);

    expect(parsed.dryRun).toBe(true);
    expect(parsed.planId).toBe("plan-123");
    expect(parsed.subtotal).toBe(1300);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ name: "AA175 JFK→NRT", price: 800, type: "FLIGHT" });
    expect(parsed.items[1]).toMatchObject({ name: "Park Hyatt Tokyo", price: 500, type: "HOTEL" });
  });

  it("does not call CREATE_CHECKOUT in dry-run mode", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--dry-run", "--json"]);

    // Only the two pre-flight queries should be called
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const queries: string[] = (mockGraphql.mock.calls as [string][]).map(([q]) => q);
    expect(queries.some(q => q.includes("createTripPlanCheckout"))).toBe(false);
  });

  // ── 4. Checkout creation JSON output ─────────────────────────────────

  it("outputs correct JSON shape after creating checkout", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--json"]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);

    expect(parsed.planId).toBe("plan-123");
    expect(parsed.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test_abc123");
    expect(parsed.subtotal).toBe(1300);
    expect(parsed.url).toContain("plan-123");
  });

  it("calls graphql three times for the checkout path (cart + plan + mutation)", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(3);
  });

  // ── 5. Status check with booking records ─────────────────────────────

  it("outputs correct JSON shape in --status --json mode", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--status", "--json"]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);

    expect(parsed.planId).toBe("plan-123");
    expect(Array.isArray(parsed.checkouts)).toBe(true);
    expect(parsed.checkouts).toHaveLength(1);
    expect(parsed.checkouts[0].status).toBe("PAID");
    expect(parsed.checkouts[0].bookingRecords).toHaveLength(1);
    expect(parsed.checkouts[0].bookingRecords[0].pnr).toBe("XYZABC");
  });

  it("calls graphql exactly once for the --status path", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--status", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  // ── 6. Status check empty ─────────────────────────────────────────────

  it("outputs empty checkouts array when there is no payment history", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock({ checkouts: PAYMENT_CHECKOUTS_EMPTY }));

    await runBook(["plan-123", "--status", "--json"]);

    const output = stdoutOutput.join("");
    const parsed = JSON.parse(output);

    expect(parsed.planId).toBe("plan-123");
    expect(parsed.checkouts).toEqual([]);
  });

  // ── 7. API error wrapping ─────────────────────────────────────────────

  it("wraps unexpected API errors in CliError(API_ERROR)", async () => {
    mockGraphql.mockRejectedValue(new Error("Network timeout"));

    let err: unknown;
    try {
      await runBook(["plan-123"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.API_ERROR);
    expect((err as CliError).message).toContain("Network timeout");
  });

  it("does not double-wrap CliError instances", async () => {
    const original = new CliError(CliErrorCode.AUTH_FAILED, "Not authenticated.");
    mockGraphql.mockRejectedValue(original);

    let err: unknown;
    try {
      await runBook(["plan-123"]);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.AUTH_FAILED);
  });

  // ── 8. Text output modes (non-JSON) ──────────────────────────────────

  it("outputs dry-run summary in text mode without throwing", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await runBook(["plan-123", "--dry-run"]);

    consoleSpy.mockRestore();
    // Two pre-flight queries only
    expect(mockGraphql).toHaveBeenCalledTimes(2);
  });

  it("outputs status in --agent mode with booking records", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--status", "--agent"]);

    const output = stdoutOutput.join("");
    expect(output).toContain("## Booking Status");
    expect(output).toContain("PAID");
    expect(output).toContain("XYZABC");
  });

  it("outputs empty status message in --agent mode with no checkouts", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock({ checkouts: PAYMENT_CHECKOUTS_EMPTY }));

    await runBook(["plan-123", "--status", "--agent"]);

    const output = stdoutOutput.join("");
    expect(output).toContain("No payment history");
  });

  it("outputs status in text mode with booking records", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await runBook(["plan-123", "--status"]);

    consoleSpy.mockRestore();
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it("outputs checkout in --agent mode", async () => {
    mockGraphql.mockImplementation(makeGraphqlMock());

    await runBook(["plan-123", "--agent"]);

    const output = stdoutOutput.join("");
    expect(output).toContain("checkout.stripe.com");
    expect(output).toContain("plan-123");
  });
});
