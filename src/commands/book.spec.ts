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
  // VOY-1877: real cents-based rounding — emitted money values are asserted below.
  money: (n: number) => Math.round(n * 100) / 100,
  // Real implementation semantics matter here: nextStep assertions verify the
  // recipe stays paste-runnable (simple tokens unquoted, unsafe ones quoted).
  shellArg: (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /^[A-Za-z0-9_.,:@/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  },
  // resolvePlanArg is not mocked: it lives in resolve-plan-arg.ts (own
  // module) so the real contract is always in play here.
}));

let registerBookCommands: (program: Command) => void;
let blockerFix: typeof import("./book.js").blockerFix;

beforeAll(async () => {
  const mod = await import("./book.js");
  registerBookCommands = mod.registerBookCommands;
  blockerFix = mod.blockerFix;
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

/**
 * Plan-status response for the VOY-1792 readiness guard (the real book path
 * fetches this before creating a checkout). Default: a READY plan — travellers
 * complete, no goal blockers — so the guard is a no-op and every pre-existing
 * book test keeps passing. Pass overrides to inject blockers.
 */
function planStatusFixture(over: { travellers?: unknown[]; goals?: unknown[]; cartItems?: unknown[] } = {}) {
  return {
    tripPlan: {
      id: "plan-1",
      title: "BWI Getaway",
      travellers: over.travellers ?? [
        { id: "t-1", firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-01-01", gender: "F", passport: { last4: "1234" } },
      ],
      cart: { itemCount: 1, total: 339.1, currency: "USD", items: over.cartItems ?? [{ selectionId: "sel-f", optionId: "opt-f", requiresPassport: false }] },
    },
    tripPlanGoals: over.goals ?? [
      {
        id: "g1", name: "Flights", type: "Flight", sortOrder: 1, isDecided: true, isBooked: false,
        checkoutReadiness: { isReady: true, requirements: [] },
        items: [{ id: "it-1", title: "Outbound", selections: [
          { id: "sel-f", type: "Flight", mode: "Single", isComplete: true, isLocked: false, blueprintMonitorId: null, parentOptionId: null, mirrorListSelectionId: null,
            travellerOptionChoices: [{ traveller: { id: "t-1" }, selectedOption: { id: "opt-f" } }],
            inputs: [], options: [{ id: "opt-f", name: "BWI→MCO", isBookable: true }] },
        ] }],
      },
    ],
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

/** Route queries by operation content: plan-status, cart, checkouts, create. */
function routeGraphql(overrides: { checkouts?: unknown; cart?: unknown; createUrl?: string; planStatus?: unknown } = {}) {
  mockGraphql.mockImplementation(async (query: string) => {
    if (query.includes("TripPlanPaymentCheckouts")) return overrides.checkouts ?? NO_CHECKOUTS;
    if (query.includes("CreateTripPlanCheckout")) {
      return { createTripPlanCheckout: { url: overrides.createUrl ?? "https://stripe.test/pay/new" } };
    }
    // PlanStatus must be checked before the generic `cart` match — its query
    // body also contains a `cart {` block (VOY-1792 readiness guard).
    if (query.includes("PlanStatus")) return overrides.planStatus ?? planStatusFixture();
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

// ── Readiness hard-gate (VOY-1792) ──────────────────────────────────────────

/** plan-status with a hard TRAVELLER_DATA blocker (Jane missing gender + DOB). */
function travellerBlockedStatus() {
  return planStatusFixture({
    travellers: [
      { id: "t-1", firstName: "Jane", lastName: "Doe", dateOfBirth: null, gender: null, passport: { last4: null } },
    ],
    goals: [
      {
        id: "g1", name: "Flights", type: "Flight", sortOrder: 1, isDecided: true, isBooked: false,
        checkoutReadiness: { isReady: false, requirements: [
          { label: "Date of birth", isFulfilled: false, isRequired: true, type: "TravellerField", selectionId: null, missingTravellerIds: ["t-1"] },
        ] },
        items: [{ id: "it-1", title: "Outbound", selections: [
          { id: "sel-f", type: "Flight", mode: "Single", isComplete: true, isLocked: false, blueprintMonitorId: null, parentOptionId: null, mirrorListSelectionId: null,
            travellerOptionChoices: [{ traveller: { id: "t-1" }, selectedOption: { id: "opt-f" } }],
            inputs: [], options: [{ id: "opt-f", name: "BWI→MCO", isBookable: true }] },
        ] }],
      },
    ],
  });
}

/** plan-status with a PICK_PENDING blocker (hotel not yet picked). */
function pickPendingStatus() {
  return planStatusFixture({
    goals: [
      {
        id: "g2", name: "Hotel", type: "Hotel", sortOrder: 2, isDecided: false, isBooked: false,
        checkoutReadiness: { isReady: false, requirements: [] },
        items: [{ id: "it-2", title: "Stay", selections: [
          { id: "sel-p", type: "Hotel", mode: "Single", isComplete: false, isLocked: false, blueprintMonitorId: null, parentOptionId: null, mirrorListSelectionId: null,
            travellerOptionChoices: [], inputs: [],
            options: [{ id: "o1", name: "Hotel A", isBookable: true }, { id: "o2", name: "Hotel B", isBookable: true }] },
        ] }],
      },
    ],
  });
}

/** plan-status whose only blocker is unverified (a stale server ref, no selectionId). */
function unverifiedOnlyStatus() {
  return planStatusFixture({
    goals: [
      {
        id: "g1", name: "Flights", type: "Flight", sortOrder: 1, isDecided: true, isBooked: false,
        checkoutReadiness: { isReady: false, requirements: [
          { label: "Cabin class", isFulfilled: false, isRequired: true, type: "Other", selectionId: null, missingTravellerIds: [] },
        ] },
        items: [{ id: "it-1", title: "Outbound", selections: [
          { id: "sel-f", type: "Flight", mode: "Single", isComplete: true, isLocked: false, blueprintMonitorId: null, parentOptionId: null, mirrorListSelectionId: null,
            travellerOptionChoices: [{ traveller: { id: "t-1" }, selectedOption: { id: "opt-f" } }],
            inputs: [], options: [{ id: "opt-f", name: "BWI→MCO", isBookable: true }] },
        ] }],
      },
    ],
  });
}

describe("readiness hard-gate (PLAN_BLOCKED)", () => {
  it("refuses checkout when a hard TRAVELLER_DATA blocker exists — no mutation, blockers + fix in details", async () => {
    routeGraphql({ planStatus: travellerBlockedStatus() });
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PLAN_BLOCKED,
      details: {
        blockers: [
          expect.objectContaining({
            kind: "TRAVELLER_DATA",
            fix: "voyagier travellers update t-1 --gender <M|F|X> --dob <YYYY-MM-DD>",
          }),
        ],
      },
    });
    expect(createVars()).toBeUndefined();
  });

  it("blocks conservatively on other hard blocker kinds too (PICK_PENDING)", async () => {
    routeGraphql({ planStatus: pickPendingStatus() });
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PLAN_BLOCKED,
      details: {
        blockers: [
          expect.objectContaining({ kind: "PICK_PENDING", fix: "voyagier select --selection-id sel-p --option-id <optionId>" }),
        ],
      },
    });
    expect(createVars()).toBeUndefined();
  });

  it("does NOT block on unverified-class blockers — book --dry-run is the tie-breaker for those", async () => {
    routeGraphql({ planStatus: unverifiedOnlyStatus() });
    await runBook(["plan-1", "--expect-total", "339.10", "--json"]);
    expect(createVars()).toBeDefined();
  });

  it("--force-checkout bypasses the guard and never fetches plan-status", async () => {
    routeGraphql({ planStatus: travellerBlockedStatus() });
    await runBook(["plan-1", "--expect-total", "339.10", "--force-checkout", "--json"]);
    expect(createVars()).toBeDefined();
    expect(mockGraphql.mock.calls.some(([q]) => (q as string).includes("PlanStatus"))).toBe(false);
  });

  it("--force-checkout still enforces the price gate (bypasses readiness only)", async () => {
    routeGraphql({ planStatus: travellerBlockedStatus() });
    await expect(runBook(["plan-1", "--expect-total", "1.00", "--force-checkout", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.PRICE_CHANGED,
    });
    expect(createVars()).toBeUndefined();
  });

  it("--dry-run never runs the guard (no PlanStatus fetch), even with blockers present", async () => {
    routeGraphql({ planStatus: travellerBlockedStatus() });
    await runBook(["plan-1", "--dry-run", "--json"]);
    const out = lastJson();
    expect(out.data.dryRun).toBe(true);
    expect(mockGraphql.mock.calls.some(([q]) => (q as string).includes("PlanStatus"))).toBe(false);
  });

  it("fails CLOSED when the readiness query errors — no checkout, points at --force-checkout", async () => {
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("TripPlanPaymentCheckouts")) return NO_CHECKOUTS;
      if (query.includes("PlanStatus")) throw new Error("upstream 502");
      if (query.includes("cart")) return cartFixture();
      throw new Error(`unrouted query: ${query.slice(0, 120)}`);
    });
    await expect(runBook(["plan-1", "--expect-total", "339.10", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
      message: expect.stringContaining("--force-checkout"),
    });
    expect(createVars()).toBeUndefined();
  });

  it("a ready plan books normally (guard passes through)", async () => {
    routeGraphql();
    await runBook(["plan-1", "--expect-total", "339.10", "--json"]);
    expect(createVars()).toBeDefined();
  });
});

// ── blockerFix routing (VOY-1792) ───────────────────────────────────────────
// The PLAN_BLOCKED "fix" command must not disagree with plan-status's nextSteps
// routing (plan-status.ts:777-790) for the same blocker.

describe("blockerFix — PICK_PENDING routing parity with plan-status", () => {
  it("single-candidate aggregated blocker (no refs.selectionId) routes straight to select", () => {
    // VOY-1724: hotelCode matching collapsed the group to ONE live chain, so the
    // exact selection is known even though refs carries only goalId.
    const fix = blockerFix(
      { kind: "PICK_PENDING", message: "room pick pending", refs: { goalId: "gh" }, candidateSelectionIds: ["room-A"] },
      [],
    );
    expect(fix).toBe("voyagier select --selection-id room-A --option-id <optionId>");
  });

  it("multi-candidate aggregated blocker routes to goal inspection", () => {
    const fix = blockerFix(
      { kind: "PICK_PENDING", message: "pick pending", refs: { goalId: "gh" }, candidateSelectionIds: ["room-A", "room-B"] },
      [],
    );
    expect(fix).toBe("voyagier plans goal gh --json");
  });

  it("selection-level blocker (refs.selectionId present, no candidates) routes to select", () => {
    const fix = blockerFix(
      { kind: "PICK_PENDING", message: "pick pending", refs: { selectionId: "sel-p", goalId: "g2" } },
      [],
    );
    expect(fix).toBe("voyagier select --selection-id sel-p --option-id <optionId>");
  });

  it("no selection ref and no candidates falls back to goal inspection", () => {
    const fix = blockerFix(
      { kind: "PICK_PENDING", message: "pick pending", refs: { goalId: "g2" } },
      [],
    );
    expect(fix).toBe("voyagier plans goal g2 --json");
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

// ── VOY-1877: money emission (integer cents) ────────────────────────────────

/** Two bookable flight lines priced to float-sum dirty (0.1 + 0.2). */
function dirtyCartFixture() {
  return {
    tripPlan: {
      id: "plan-1",
      title: "Dirty Sum",
      cart: {
        items: [
          { id: "ci-1", name: "Leg A", type: "Flight", price: 0.1, currency: "USD", selectionId: "sel-f", optionId: "opt-a" },
          { id: "ci-2", name: "Leg B", type: "Flight", price: 0.2, currency: "USD", selectionId: "sel-f", optionId: "opt-b" },
        ],
        itemCount: 2,
        total: 0.1 + 0.2,
        currency: "USD",
      },
      goals: [
        {
          id: "g1", name: "Flights", sortOrder: 1,
          items: [{ selections: [{ id: "sel-f", options: [
            { id: "opt-a", isBookable: true, status: "Available", blueprintListingId: null, externalId: "sabre-1" },
            { id: "opt-b", isBookable: true, status: "Available", blueprintListingId: null, externalId: "sabre-2" },
          ] }] }],
        },
      ],
    },
  };
}

describe("money emission (VOY-1877)", () => {
  it("dry-run --json emits summed money at exactly 2 decimals, no float artifact (4c)", async () => {
    routeGraphql({ cart: dirtyCartFixture() });
    await runBook(["plan-1", "--dry-run", "--json"]);
    const out = lastJson();
    expect(out.data.chargeableSubtotal).toBe(0.3);
    expect(out.data.subtotal).toBe(0.3);
    expect(out.data.items.map((i: { price: number }) => i.price)).toEqual([0.1, 0.2]);
    expect(writes.join("")).not.toContain("0.30000000000000004");
  });

  it("the price gate still compares in integer cents — a dirty 0.30 sum passes --expect-total 0.30 (4d)", async () => {
    routeGraphql({ cart: dirtyCartFixture() });
    // Gate verdict is computed in cents (0.1+0.2 → 30¢ === 30¢), so it PASSES
    // and a checkout is minted despite the raw float being 0.30000000000000004.
    await runBook(["plan-1", "--expect-total", "0.30", "--json"]);
    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.data.checkoutUrl).toBeTruthy();
    // …and the emitted money is still the clean 2-decimal value.
    expect(out.data.chargeableSubtotal).toBe(0.3);
    expect(createVars()).toBeDefined();
  });
});
