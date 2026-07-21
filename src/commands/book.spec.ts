/**
 * Behavioral specs for `voyagier book` — VOY-1706 price hard-gate + checkout
 * idempotency. House pattern: mock only the network boundary (../api.js) +
 * config; drive the real command through commander.parseAsync; assert on the
 * GraphQL variables sent, JSON output shapes, and CliError codes.
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
}));

const mockOpenBrowser = jest.fn();
jest.unstable_mockModule("../utils.js", () => ({
  formatPrice: (n: number) => `$${n.toFixed(2)}`,
  openBrowser: mockOpenBrowser,
  deriveBaseUrl: () => "https://travel.voyagier.com",
  // Real semantics required: the gate's cents-rounding IS the behavior under
  // test (moved to utils in VOY-1212 so quote shares it).
  cents: (n: number) => Math.round(n * 100),
  // Real implementation semantics matter here: nextStep assertions verify the
  // recipe stays paste-runnable (simple tokens unquoted, unsafe ones quoted).
  shellArg: (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /^[A-Za-z0-9_.,:@/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  },
}));

let registerBookCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./book.js");
  registerBookCommands = mod.registerBookCommands;
});

let writes: string[];
let stdoutSpy: ReturnType<typeof jest.spyOn>;
let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockGraphql.mockReset();
  mockOpenBrowser.mockReset();
  writes = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Cart with one bookable flight ($339.10) + one non-bookable hotel ($100). */
function cartFixture() {
  return {
    tripPlan: {
      id: "plan-1",
      title: "BWI Getaway",
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

const NO_CHECKOUTS = { tripPlanPaymentCheckouts: [] };
const PENDING_CHECKOUT = {
  tripPlanPaymentCheckouts: [
    { id: "co-pending", status: "Pending", checkoutUrl: "https://stripe.test/pay/co-pending", hostedInvoiceUrl: null, bookingRecords: [] } as const,
  ],
};
const PAID_CHECKOUT = {
  tripPlanPaymentCheckouts: [
    {
      id: "co-paid", status: "Paid", checkoutUrl: null, hostedInvoiceUrl: null,
      // status enums are PascalCase; record amounts are CENTS (schema reality, live-verified 2026-07-20)
      bookingRecords: [{ id: "br-1", type: "FlightBooking", status: "Confirmed", pnr: "ABC123", providerReference: null, amount: 33910 }],
    },
  ],
};
const CANCELLED_CHECKOUT = {
  tripPlanPaymentCheckouts: [
    { id: "co-x", status: "Cancelled", checkoutUrl: null, hostedInvoiceUrl: null, bookingRecords: [] },
  ],
};

/** Route queries by operation content: cart, checkouts, create. */
function routeGraphql(overrides: { checkouts?: unknown; cart?: unknown; createUrl?: string } = {}) {
  mockGraphql.mockImplementation(async (query: string) => {
    if (query.includes("TripPlanPaymentCheckouts")) return overrides.checkouts ?? NO_CHECKOUTS;
    if (query.includes("CreateTripPlanCheckout")) {
      return { createTripPlanCheckout: { url: overrides.createUrl ?? "https://stripe.test/pay/new" } };
    }
    if (query.includes("cart")) return overrides.cart ?? cartFixture();
    throw new Error(`unrouted query: ${query.slice(0, 120)}`);
  });
}

function createVars(): Record<string, unknown> | undefined {
  const call = mockGraphql.mock.calls.find(([q]) => (q as string).includes("CreateTripPlanCheckout"));
  return call?.[1] as Record<string, unknown> | undefined;
}

async function runBook(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBookCommands(program);
  await program.parseAsync(["node", "voyagier", "book", ...args]);
}

function lastJson(): any {
  return JSON.parse(writes.join(""));
}

// ── Price hard-gate ─────────────────────────────────────────────────────────

describe("price hard-gate", () => {
  it("refuses a real checkout without --expect-total/--max-total (VALIDATION, no network)", async () => {
    routeGraphql();
    await expect(runBook(["plan-1", "--json"])).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("creates checkout when --expect-total matches the chargeable subtotal exactly", async () => {
    routeGraphql();
    await runBook(["plan-1", "--expect-total", "339.10", "--json"]);
    const vars = createVars();
    expect(vars).toBeDefined();
    expect((vars!.input as Record<string, unknown>).tripPlanId).toBe("plan-1");
    expect((vars!.input as Record<string, unknown>).itemIds).toEqual(["sel-f:opt-f"]); // always pinned to the gated set
    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.data.checkoutUrl).toBe("https://stripe.test/pay/new");
    expect(out.data.chargeableSubtotal).toBeCloseTo(339.1, 2);
    expect(out.data.gate).toEqual({ expectedTotal: 339.1, maxTotal: null });
  });

  it("gates on the CHARGEABLE subtotal (excludes non-bookable lines), not the display subtotal", async () => {
    routeGraphql();
    // Display subtotal is 439.10 — expecting that must FAIL: the hotel is not chargeable.
    await expect(runBook(["plan-1", "--expect-total", "439.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PRICE_CHANGED,
      details: expect.objectContaining({ actualTotal: expect.closeTo(339.1, 2), expectedTotal: expect.closeTo(439.1, 2) }),
    });
    expect(createVars()).toBeUndefined();
  });

  it("aborts with PRICE_CHANGED on mismatch and fires no mutation", async () => {
    routeGraphql();
    await expect(runBook(["plan-1", "--expect-total", "300.00", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PRICE_CHANGED,
    });
    expect(createVars()).toBeUndefined();
  });

  it("--max-total passes when chargeable equals the cap exactly", async () => {
    routeGraphql();
    await runBook(["plan-1", "--max-total", "339.10", "--json"]);
    expect(createVars()).toBeDefined();
  });

  it("--max-total aborts when chargeable exceeds the cap", async () => {
    routeGraphql();
    await expect(runBook(["plan-1", "--max-total", "339.09", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PRICE_CHANGED,
    });
    expect(createVars()).toBeUndefined();
  });

  it("enforces BOTH flags when both are given", async () => {
    routeGraphql();
    // expect matches, but max is below actual → still aborts
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--max-total", "200", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PRICE_CHANGED,
    });
    expect(createVars()).toBeUndefined();
  });

  it("accepts $-prefixed amounts and treats 339.1 as 339.10 (cents comparison)", async () => {
    routeGraphql();
    await runBook(["plan-1", "--expect-total", "$339.1", "--json"]);
    expect(createVars()).toBeDefined();
  });

  it("rejects garbage amounts with VALIDATION before any network call", async () => {
    routeGraphql();
    await expect(runBook(["plan-1", "--expect-total", "abc", "--json"])).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    await expect(runBook(["plan-1", "--expect-total", "-5", "--json"])).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

// ── Idempotency pre-flight ──────────────────────────────────────────────────

describe("paid-checkout pre-flight", () => {
  it("ignores Pending checkout rows — only Paid blocks (server excludes Pending today; if that changes, Pending stays non-blocking by design)", async () => {
    routeGraphql({ checkouts: PENDING_CHECKOUT });
    await runBook(["plan-1", "--expect-total", "339.10", "--json"]);
    expect(createVars()).toBeDefined();
  });

  it("refuses when a Paid checkout exists (ALREADY_BOOKED) with booking-record summary", async () => {
    routeGraphql({ checkouts: PAID_CHECKOUT });
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.ALREADY_BOOKED,
      details: {
        paidCheckouts: [{ id: "co-paid", bookingRecords: [{ type: "FlightBooking", status: "Confirmed", amountCents: 33910 }] }],
      },
    });
    expect(createVars()).toBeUndefined();
  });

  it("--rebook proceeds past a Paid checkout", async () => {
    routeGraphql({ checkouts: PAID_CHECKOUT });
    await runBook(["plan-1", "--expect-total", "339.10", "--rebook", "--json"]);
    expect(createVars()).toBeDefined();
  });

  it("Cancelled checkouts do not block", async () => {
    routeGraphql({ checkouts: CANCELLED_CHECKOUT });
    await runBook(["plan-1", "--expect-total", "339.10", "--json"]);
    expect(createVars()).toBeDefined();
  });

  it("fails CLOSED when the pre-flight query errors (API_ERROR, no checkout minted)", async () => {
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("TripPlanPaymentCheckouts")) throw new Error("upstream 502");
      if (query.includes("cart")) return cartFixture();
      throw new Error(`unrouted query: ${query.slice(0, 120)}`);
    });
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
    expect(createVars()).toBeUndefined();
  });

  it("runs the pre-flight BEFORE the price gate (ALREADY_BOOKED wins over PRICE_CHANGED)", async () => {
    routeGraphql({ checkouts: PAID_CHECKOUT });
    await expect(runBook(["plan-1", "--expect-total", "1.00", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.ALREADY_BOOKED,
    });
  });

  it("preserves the original CliError code when the pre-flight fails (AUTH_FAILED not masked as API_ERROR)", async () => {
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("TripPlanPaymentCheckouts")) throw new CliError(CliErrorCode.AUTH_FAILED, "token expired");
      if (query.includes("cart")) return cartFixture();
      throw new Error(`unrouted query: ${query.slice(0, 120)}`);
    });
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.AUTH_FAILED,
      message: expect.stringContaining("refusing to create a new session"),
    });
    expect(createVars()).toBeUndefined();
  });

});

// ── Server-side filtering (itemIds) ─────────────────────────────────────────

describe("server-side itemIds pinning", () => {
  it("ALWAYS sends itemIds for the gated bookable set, even without filters (charged set = gated set)", async () => {
    routeGraphql();
    await runBook(["plan-1", "--expect-total", "339.10", "--json"]);
    const input = createVars()!.input as Record<string, unknown>;
    expect(input.itemIds).toEqual(["sel-f:opt-f"]);
  });

  it("--types Flight sends itemIds for the bookable flight only", async () => {
    routeGraphql();
    await runBook(["plan-1", "--types", "Flight", "--expect-total", "339.10", "--json"]);
    const input = createVars()!.input as Record<string, unknown>;
    expect(input.itemIds).toEqual(["sel-f:opt-f"]);
  });

  it("--only-bookable sends itemIds for bookable items", async () => {
    routeGraphql();
    await runBook(["plan-1", "--only-bookable", "--expect-total", "339.10", "--json"]);
    const input = createVars()!.input as Record<string, unknown>;
    expect(input.itemIds).toEqual(["sel-f:opt-f"]);
  });

  it("a cart line without optionId is not bookable and cannot be checked out via filters", async () => {
    const cart = cartFixture();
    (cart.tripPlan.cart.items[0] as { optionId?: string }).optionId = undefined;
    routeGraphql({ cart });
    // Bookability is keyed on `${selectionId}:${optionId}` — with optionId
    // stripped the flight enriches as UNKNOWN/non-bookable, the filtered set
    // has zero bookable items → NOT_BOOKABLE, and no checkout fires. (The
    // in-command inexpressible-item guard is defensive-only today for the
    // same reason: bookable ⇒ optionId present.)
    await expect(runBook(["plan-1", "--types", "Flight", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.NOT_BOOKABLE,
    });
    expect(createVars()).toBeUndefined();
  });
});

// ── Dry run ─────────────────────────────────────────────────────────────────

describe("--dry-run", () => {
  it("needs no gate, reports chargeableSubtotal + nextStep recipe, creates nothing", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--json"]);
    const out = lastJson();
    expect(out.data.dryRun).toBe(true);
    expect(out.data.chargeableSubtotal).toBeCloseTo(339.1, 2);
    expect(out.data.subtotal).toBeCloseTo(439.1, 2);
    expect(out.data.nextStep).toBe("voyagier book plan-1 --expect-total 339.10");
    expect(out.data.existingCheckouts).toEqual({ paid: 0 });
    expect(createVars()).toBeUndefined();
  });

  it("nextStep recipe carries active filters (copy-paste must gate the same set it priced)", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--types", "Flight", "--only-bookable", "--json"]);
    const out = lastJson();
    expect(out.data.nextStep).toBe("voyagier book plan-1 --types Flight --only-bookable --expect-total 339.10");
  });

  it("reports existing paid sessions", async () => {
    routeGraphql({ checkouts: PAID_CHECKOUT });
    await runBook(["plan-1", "--dry-run", "--json"]);
    const out = lastJson();
    expect(out.data.existingCheckouts).toEqual({ paid: 1 });
  });

  it("still works when the checkout query fails (existingCheckouts null, no abort)", async () => {
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("TripPlanPaymentCheckouts")) throw new Error("upstream 502");
      if (query.includes("cart")) return cartFixture();
      throw new Error("unrouted");
    });
    await runBook(["plan-1", "--dry-run", "--json"]);
    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.data.existingCheckouts).toBeNull();
  });

  it("agent mode says could-not-verify (not zero) when the checkout query fails", async () => {
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("TripPlanPaymentCheckouts")) throw new Error("upstream 502");
      if (query.includes("cart")) return cartFixture();
      throw new Error("unrouted");
    });
    await runBook(["plan-1", "--dry-run", "--agent"]);
    expect(writes.join("")).toContain("Could not verify existing checkouts");
  });

  it("reports no gate verdict when no gate flags are supplied (data.gate null)", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--json"]);
    expect(lastJson().data.gate).toBeNull();
  });

  it("gate verdict: --expect-total matching → wouldPass true, no failReason", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--expect-total", "339.10", "--json"]);
    const gate = lastJson().data.gate;
    expect(gate.wouldPass).toBe(true);
    expect(gate.failReason).toBeNull();
    expect(createVars()).toBeUndefined(); // verdict only — dry-run never mints
  });

  it("gate verdict: --expect-total mismatch → wouldPass false with failReason; still ok:true, no PRICE_CHANGED", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--expect-total", "1.00", "--json"]);
    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.data.gate.wouldPass).toBe(false);
    expect(out.data.gate.failReason).toContain("--expect-total");
    expect(createVars()).toBeUndefined();
  });

  it("gate verdict: --max-total below chargeable → wouldPass false with exceeds reason", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--max-total", "100", "--json"]);
    const gate = lastJson().data.gate;
    expect(gate.wouldPass).toBe(false);
    expect(gate.failReason).toContain("exceeds");
  });

  it("gate verdict: BOTH gates failing → failReason reports both (agent must not fix one and trip the other)", async () => {
    routeGraphql();
    await runBook(["plan-1", "--dry-run", "--expect-total", "1.00", "--max-total", "2.00", "--json"]);
    const gate = lastJson().data.gate;
    expect(gate.wouldPass).toBe(false);
    expect(gate.failReason).toContain("--expect-total");
    expect(gate.failReason).toContain("--max-total");
  });

  it("nextStep recipe is self-consistent: the emitted command passes its own gate (half-cent subtotal)", async () => {
    // 100.005 has no exact float representation — the class of value where a
    // raw toFixed(2) recipe and the rounded-cents gate can disagree.
    const cart = cartFixture();
    (cart.tripPlan.cart.items[0] as { price: number }).price = 100.005;
    routeGraphql({ cart });
    await runBook(["plan-1", "--dry-run", "--json"]);
    const nextStep: string = lastJson().data.nextStep;
    const expectTotal = /--expect-total (\S+)/.exec(nextStep)![1];
    writes.length = 0;
    routeGraphql({ cart });
    await runBook(["plan-1", "--expect-total", expectTotal, "--json"]); // must NOT throw PRICE_CHANGED
    expect(createVars()).toBeDefined();
  });
});

// ── book --status ──────────────────────────────────────────────────────────────────────

describe("book --status", () => {
  it("--json renames bookingRecords[].amount → amountCents (one name per unit on machine surfaces)", async () => {
    routeGraphql({ checkouts: PAID_CHECKOUT });
    await runBook(["plan-1", "--status", "--json"]);
    const records = lastJson().data.checkouts[0].bookingRecords;
    expect(records[0].amountCents).toBe(33910);
    expect(records[0]).not.toHaveProperty("amount");
  });
});

// ── parseMoney unit coverage ────────────────────────────────────────────────

describe("parseMoney", () => {
  let parseMoney: (raw: string, flag: string) => number;
  beforeAll(async () => {
    ({ parseMoney } = await import("./book.js"));
  });

  it.each([
    ["339.10", 339.1],
    ["$339.10", 339.1],
    ["339", 339],
    ["0", 0],
  ])("parses %s", (raw, expected) => {
    expect(parseMoney(raw, "--expect-total")).toBe(expected);
  });

  it.each(["abc", "-5", "339.105", "1e3", "", "339,10", "$"])("rejects %s", (raw) => {
    expect(() => parseMoney(raw, "--expect-total")).toThrow(CliError);
  });

  it("rejects absurdly long digit strings that overflow to Infinity", () => {
    expect(() => parseMoney("9".repeat(400), "--max-total")).toThrow(/too large/);
  });
});
