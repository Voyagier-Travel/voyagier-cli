/**
 * Behavioral specs for `voyagier quote` — VOY-1212 offer snapshot.
 * House pattern: mock only the network boundary (../api.js) + config; drive
 * the real command through commander.parseAsync; assert output shapes and
 * CliError codes.
 *
 * The flagship spec is CROSS-COMMAND consistency: the acceptance command
 * quote emits is executed against the REAL book command on the same cart and
 * must pass book's price gate (no PRICE_CHANGED) — quoted ≡ gated, proven by
 * execution, not reasoning.
 */
import { jest } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

const mockGraphql = jest.fn<(query: string, vars?: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: () => "https://travel.voyagier.com/api",
  getUserContext: () => ({ id: "u1", name: "Daniel Gardner", email: "daniel@voyagier.com", homeAirports: [], preferredCabin: "economy" }),
}));

let registerQuoteCommand: (program: Command) => void;
let registerBookCommands: (program: Command) => void;

beforeAll(async () => {
  registerQuoteCommand = (await import("./quote.js")).registerQuoteCommand;
  registerBookCommands = (await import("./book.js")).registerBookCommands;
});

let writes: string[];
let stdoutSpy: ReturnType<typeof jest.spyOn>;
let logSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockGraphql.mockReset();
  writes = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  logSpy = jest.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
    writes.push(args.join(" ") + "\n");
  }) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  logSpy.mockRestore();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Bookable flight $339.10 + non-bookable hotel $100, with client + dates. */
function quoteFixture() {
  return {
    tripPlan: {
      id: "plan-1",
      title: "BWI Getaway",
      startDate: "2027-03-01",
      endDate: "2027-03-08",
      client: { id: "cl-1", name: "Ada Client", email: "ada@example.com", phone: null },
      cart: {
        items: [
          { id: "ci-1", name: "BWI→MCO / Economy", type: "Flight", price: 339.1, currency: "USD", selectionId: "sel-f", optionId: "opt-f" },
          { id: "ci-2", name: "Hotel Radiance", type: "Hotel", price: 100, currency: "USD", selectionId: "sel-h", optionId: "opt-h" },
        ],
        itemCount: 2,
        total: 439.1,
        currency: "USD",
      },
      goals: [
        {
          id: "g1", name: "Flights", sortOrder: 1,
          items: [{ selections: [{ id: "sel-f", options: [{ id: "opt-f", isBookable: true, status: "Available", blueprintListingId: null, externalId: "sabre-1" }] }] }],
        },
        {
          id: "g2", name: "Hotel", sortOrder: 2,
          items: [{ selections: [{ id: "sel-h", options: [{ id: "opt-h", isBookable: false, status: "Unavailable", blueprintListingId: null, externalId: null }] }] }],
        },
      ],
    },
  };
}

function routeQuote(fixture: unknown = quoteFixture()) {
  mockGraphql.mockImplementation(async (query: string) => {
    if (query.includes("TripPlanQuote")) return fixture;
    throw new Error(`unrouted query: ${query.slice(0, 120)}`);
  });
}

async function runQuote(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerQuoteCommand(program);
  await program.parseAsync(["node", "voyagier", "quote", ...args]);
}

function lastJson(): { ok: boolean; data: Record<string, any> } {
  const raw = writes.filter((w) => w.trimStart().startsWith("{")).at(-1);
  expect(raw).toBeDefined();
  return JSON.parse(raw!);
}

// ── Specs ───────────────────────────────────────────────────────────────────

describe("quote --json", () => {
  it("itemizes the cart, totals only bookable items, and emits the acceptance contract", async () => {
    routeQuote();
    await runQuote(["plan-1", "--json"]);
    const { ok, data } = lastJson();
    expect(ok).toBe(true);
    expect(data.plan).toEqual({ id: "plan-1", title: "BWI Getaway", startDate: "2027-03-01", endDate: "2027-03-08" });
    expect(data.client).toEqual({ name: "Ada Client", email: "ada@example.com", phone: null });
    expect(data.items).toHaveLength(2);
    const flight = data.items.find((i: any) => i.type === "Flight");
    const hotel = data.items.find((i: any) => i.type === "Hotel");
    expect(flight).toMatchObject({ price: 339.1, priceCents: 33910, bookable: true });
    expect(hotel).toMatchObject({ price: 100, priceCents: 10000, bookable: false });
    // Total = bookable only (hotel is display-only, never charged)
    expect(data.chargeableTotalCents).toBe(33910);
    expect(data.chargeableTotal).toBe("339.10");
    expect(data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.acceptance).toEqual({
      command: "voyagier book plan-1 --expect-total 339.10",
      itemIds: ["sel-f:opt-f"],
      expectedTotal: "339.10",
    });
    expect(data.alternatives.selfServe).toBe("voyagier send plan-1");
  });

  it("chargeableTotalCents is subtotal-rounded (gate semantics), NOT the sum of per-item priceCents", async () => {
    // Two bookable half-cent items: per-line rounding gives 2¢ + 2¢ = 4¢, but
    // the gate rounds ONCE on the raw subtotal: cents(0.015 + 0.015) = 3¢.
    // The total must match the gate — consumers re-derive from raw `price`.
    const fixture = quoteFixture();
    const plan = (fixture as any).tripPlan;
    plan.cart.items = [
      { id: "ci-1", name: "A", type: "Flight", price: 0.015, currency: "USD", selectionId: "sel-f", optionId: "opt-f" },
      { id: "ci-2", name: "B", type: "Flight", price: 0.015, currency: "USD", selectionId: "sel-f2", optionId: "opt-f2" },
    ];
    plan.goals = [
      {
        id: "g1", name: "Flights", sortOrder: 1,
        items: [{ selections: [
          { id: "sel-f", options: [{ id: "opt-f", isBookable: true, status: "Available", blueprintListingId: null, externalId: "s1" }] },
          { id: "sel-f2", options: [{ id: "opt-f2", isBookable: true, status: "Available", blueprintListingId: null, externalId: "s2" }] },
        ] }],
      },
    ];
    routeQuote(fixture);
    await runQuote(["plan-1", "--json"]);
    const { data } = lastJson();
    const itemCentsSum = data.items.reduce((acc: number, i: any) => acc + i.priceCents, 0);
    expect(itemCentsSum).toBe(4); // per-line rounding
    expect(data.chargeableTotalCents).toBe(3); // gate rounding — authoritative
    expect(data.chargeableTotal).toBe("0.03");
    expect(data.acceptance.expectedTotal).toBe("0.03");
    // Raw price present for consumers who need to re-derive totals.
    expect(data.items.map((i: any) => i.price)).toEqual([0.015, 0.015]);
  });

  it("zero bookable items → acceptance null with a reason (still ok:true)", async () => {
    const fixture = quoteFixture();
    fixture.tripPlan.goals[0].items[0].selections[0].options[0].isBookable = false;
    routeQuote(fixture);
    await runQuote(["plan-1", "--json"]);
    const { ok, data } = lastJson();
    expect(ok).toBe(true);
    expect(data.acceptance).toBeNull();
    expect(data.acceptanceUnavailableReason).toContain("no bookable items");
  });

  it("bookable item without optionId → acceptance null (cannot be pinned; matches book's fail-closed rule)", async () => {
    const fixture = quoteFixture();
    (fixture.tripPlan.cart.items[0] as { optionId?: string }).optionId = undefined;
    // bookability is keyed on selectionId:optionId, so without optionId the
    // item enriches as non-bookable — degenerate to the zero-bookables reason.
    routeQuote(fixture);
    await runQuote(["plan-1", "--json"]);
    const { data } = lastJson();
    expect(data.acceptance).toBeNull();
    expect(data.acceptanceUnavailableReason).toBeTruthy();
  });

  it("plan not found → NOT_FOUND", async () => {
    routeQuote({ tripPlan: null });
    await expect(runQuote(["plan-1", "--json"])).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("query failure → API_ERROR (CliError preserved when already one)", async () => {
    mockGraphql.mockRejectedValue(new CliError(CliErrorCode.AUTH_FAILED, "nope"));
    await expect(runQuote(["plan-1", "--json"])).rejects.toMatchObject({ code: CliErrorCode.AUTH_FAILED });
    mockGraphql.mockRejectedValue(new Error("boom"));
    await expect(runQuote(["plan-1", "--json"])).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

describe("quote human/agent output", () => {
  it("human mode renders items, chargeable total, advisor footer, and both closes", async () => {
    routeQuote();
    await runQuote(["plan-1"]);
    const out = writes.join("");
    expect(out).toContain("Quote — BWI Getaway");
    expect(out).toContain("Ada Client");
    expect(out).toContain("BWI→MCO / Economy");
    // The specific bookableReason must surface (matching cart) — a generic
    // tag would hide actionable issues.
    expect(out).toMatch(/display only — not charged: .+/);
    expect(out).toContain("Chargeable total: $339.10");
    expect(out).toContain("Prepared by Daniel Gardner");
    expect(out).toContain("voyagier book plan-1 --expect-total 339.10");
    expect(out).toContain("voyagier send plan-1");
  });

  it("agent mode is markdown with the acceptance command", async () => {
    routeQuote();
    await runQuote(["plan-1", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("## Quote: BWI Getaway");
    expect(out).toContain("**Chargeable total: $339.10**");
    expect(out).toContain("voyagier book plan-1 --expect-total 339.10");
  });
});

describe("quote → book cross-command consistency (quoted ≡ gated, proven by execution)", () => {
  async function runBook(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerBookCommands(program);
    await program.parseAsync(["node", "voyagier", "book", ...args]);
  }

  function bookRoutes(cartFixture: unknown) {
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("TripPlanQuote")) return cartFixture;
      if (query.includes("TripPlanPaymentCheckouts")) return { tripPlanPaymentCheckouts: [] };
      if (query.includes("CreateTripPlanCheckout")) {
        return { createTripPlanCheckout: { url: "https://stripe.test/pay/new" } };
      }
      if (query.includes("cart")) return cartFixture; // book's GET_CART_V2
      throw new Error(`unrouted query: ${query.slice(0, 120)}`);
    });
  }

  it.each([339.1, 100.005, 0.015, 1234.565])(
    "the emitted acceptance command passes book's gate on the same cart (price %p)",
    async (price) => {
      const fixture = quoteFixture();
      (fixture.tripPlan.cart.items[0] as { price: number }).price = price;
      bookRoutes(fixture);

      await runQuote(["plan-1", "--json"]);
      const acceptance = lastJson().data.acceptance;
      expect(acceptance).not.toBeNull();

      // Execute the emitted command's flags against the REAL book command.
      const match = /^voyagier book (\S+) --expect-total (\S+)$/.exec(acceptance.command);
      expect(match).not.toBeNull();
      const [, planArg, expectTotal] = match!;

      writes.length = 0;
      await runBook([planArg, "--expect-total", expectTotal, "--json"]); // must NOT throw PRICE_CHANGED
      const createCall = mockGraphql.mock.calls.find(([q]) => (q as string).includes("CreateTripPlanCheckout"));
      expect(createCall).toBeDefined();
      // And book pins exactly the itemIds quote promised.
      expect((createCall![1] as { input: { itemIds: string[] } }).input.itemIds).toEqual(acceptance.itemIds);
    },
  );
});
