import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

const mockGraphql = jest.fn();
const mockOpenBrowser = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

jest.unstable_mockModule("../utils.js", () => ({
  formatPrice: (n: number) => `$${n.toFixed(2)}`,
  openBrowser: mockOpenBrowser,
  deriveBaseUrl: (api: string) => {
    try { const u = new URL(api); u.pathname = ""; return u.origin; } catch { return "https://travel.voyagier.com"; }
  },
}));

jest.unstable_mockModule("../hints.js", () => ({
  hintCheckoutCreated: jest.fn().mockReturnValue(""),
  hintBookingConfirmed: jest.fn().mockReturnValue(""),
  hintBookingPending: jest.fn().mockReturnValue(""),
  hintDryRun: jest.fn().mockReturnValue(""),
}));

let registerBookCommands: (program: Command) => void;
beforeAll(async () => {
  registerBookCommands = (await import("./book.js")).registerBookCommands;
});

const CART_FIXTURE = {
  tripPlan: {
    id: "plan-1", title: "Test Trip",
    cart: {
      itemCount: 2, total: 1840, currency: "USD",
      items: [
        { id: "ci-1", name: "King Suite", description: null, price: 1840, currency: "USD", type: "Hotel", selectionId: "sel-h", optionId: "opt-h", metadata: {} },
        { id: "ci-2", name: "AF023", description: null, price: 0, currency: "USD", type: "Flight", selectionId: "sel-f", optionId: "opt-f", metadata: {} },
      ],
    },
    goals: [
      {
        id: "g-h", name: "Hotel", sortOrder: 1,
        items: [{ id: "i-h", title: "Hotel", goalId: "g-h", selections: [{ id: "sel-h", type: "Hotel", isLocked: false, options: [{ id: "opt-h", name: "King", isBookable: true, status: "ACTIVE", blueprintListingId: "bl-1", externalId: "blueprint:1" }] }] }],
      },
      {
        id: "g-f", name: "Flight", sortOrder: 2,
        items: [{ id: "i-f", title: "Flight", goalId: "g-f", selections: [{ id: "sel-f", type: "Flight", isLocked: false, options: [{ id: "opt-f", name: "AF023", isBookable: false, status: "ACTIVE", blueprintListingId: null, externalId: "sabre:af023" }] }] }],
      },
    ],
  },
};

const ALL_BOOKABLE = JSON.parse(JSON.stringify(CART_FIXTURE));
ALL_BOOKABLE.tripPlan.goals[1].items[0].selections[0].options[0].isBookable = true;

const EMPTY_CART = {
  tripPlan: {
    id: "plan-1", title: "Empty",
    cart: { itemCount: 0, total: 0, currency: "USD", items: [] },
    goals: [],
  },
};

async function runBook(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBookCommands(program);
  await program.parseAsync(["node", "voyagier", "book", ...args]);
}

describe("voyagier book", () => {
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
    mockOpenBrowser.mockReset();
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  describe("--dry-run", () => {
    it("returns subtotal + items + blockers as JSON; never calls checkout", async () => {
      mockGraphql.mockResolvedValueOnce(CART_FIXTURE);
      await runBook(["plan-1", "--dry-run", "--json"]);
      const out = JSON.parse(stdoutOutput.join(""));
      expect(out.ok).toBe(true);
      expect(out.data.dryRun).toBe(true);
      expect(out.data.subtotal).toBe(1840);
      expect(out.data.blockers).toHaveLength(1);
      expect(out.data.blockers[0].itemName).toBe("AF023");
      expect(mockGraphql).toHaveBeenCalledTimes(1); // cart only, no createTripPlanCheckout
    });
  });

  describe("--validate", () => {
    it("throws BOOKING_BLOCKED with details.blockers when any item is non-bookable", async () => {
      mockGraphql.mockResolvedValueOnce(CART_FIXTURE);
      let err: unknown;
      try {
        await runBook(["plan-1", "--validate", "--json"]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.BOOKING_BLOCKED);
      expect((err as CliError).details?.blockers).toHaveLength(1);
    });

    it("passes through and creates checkout when everything is bookable", async () => {
      mockGraphql
        .mockResolvedValueOnce(ALL_BOOKABLE)
        .mockResolvedValueOnce({ createTripPlanCheckout: { url: "https://checkout.stripe.com/abc" } });
      await runBook(["plan-1", "--validate", "--json"]);
      const out = JSON.parse(stdoutOutput.join(""));
      expect(out.ok).toBe(true);
      expect(out.data.checkoutUrl).toContain("checkout.stripe.com");
    });
  });

  describe("--only-bookable", () => {
    it("filters out blockers and creates a checkout for the remaining bookable lines", async () => {
      mockGraphql
        .mockResolvedValueOnce(CART_FIXTURE)
        .mockResolvedValueOnce({ createTripPlanCheckout: { url: "https://checkout.stripe.com/x" } });
      await runBook(["plan-1", "--only-bookable", "--json"]);
      const out = JSON.parse(stdoutOutput.join(""));
      expect(out.ok).toBe(true);
      expect(out.data.bookableCount).toBe(1);
      expect(out.data.skippedBlockers).toHaveLength(1);
    });
  });

  describe("--types", () => {
    it("filters cart by type before bookability gate", async () => {
      mockGraphql
        .mockResolvedValueOnce(CART_FIXTURE)
        .mockResolvedValueOnce({ createTripPlanCheckout: { url: "https://checkout.stripe.com/h" } });
      await runBook(["plan-1", "--types", "Hotel", "--json"]);
      const out = JSON.parse(stdoutOutput.join(""));
      expect(out.ok).toBe(true);
      expect(out.data.itemCount).toBe(1);
    });

    it("throws VALIDATION when no items match", async () => {
      mockGraphql.mockResolvedValueOnce(CART_FIXTURE);
      let err: unknown;
      try {
        await runBook(["plan-1", "--types", "Restaurant", "--json"]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      expect((err as CliError).details?.availableTypes).toBeDefined();
    });
  });

  describe("--idempotency-key", () => {
    it("surfaces the key on the JSON envelope", async () => {
      mockGraphql
        .mockResolvedValueOnce(ALL_BOOKABLE)
        .mockResolvedValueOnce({ createTripPlanCheckout: { url: "https://checkout.stripe.com/k" } });
      await runBook(["plan-1", "--idempotency-key", "01H...", "--json"]);
      const out = JSON.parse(stdoutOutput.join(""));
      expect(out.data.idempotencyKey).toBe("01H...");
    });
  });

  describe("empty + bookability edges", () => {
    it("empty cart → VALIDATION error", async () => {
      mockGraphql.mockResolvedValueOnce(EMPTY_CART);
      let err: unknown;
      try {
        await runBook(["plan-1", "--json"]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    });

    it("nothing bookable in working set → NOT_BOOKABLE", async () => {
      const allFlights = JSON.parse(JSON.stringify(CART_FIXTURE));
      allFlights.tripPlan.goals[0].items[0].selections[0].options[0].isBookable = false;
      mockGraphql.mockResolvedValueOnce(allFlights);
      let err: unknown;
      try {
        await runBook(["plan-1", "--json"]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.NOT_BOOKABLE);
    });
  });

  describe("--status", () => {
    it("returns checkouts as JSON envelope", async () => {
      mockGraphql.mockResolvedValueOnce({
        tripPlanPaymentCheckouts: [
          {
            id: "co-1", status: "PAID", checkoutUrl: null, hostedInvoiceUrl: null,
            bookingRecords: [{ id: "br-1", type: "FLIGHT", status: "CONFIRMED", pnr: "ABC123", providerReference: null, amount: 800 }],
          },
        ],
      });
      await runBook(["plan-1", "--status", "--json"]);
      const out = JSON.parse(stdoutOutput.join(""));
      expect(out.ok).toBe(true);
      expect(out.data.checkouts).toHaveLength(1);
      expect(out.data.checkouts[0].bookingRecords[0].pnr).toBe("ABC123");
    });

    it("renders 'no payment history' when empty", async () => {
      mockGraphql.mockResolvedValueOnce({ tripPlanPaymentCheckouts: [] });
      await runBook(["plan-1", "--status", "--agent"]);
      const out = stdoutOutput.join("");
      expect(out).toContain("No payment history");
    });
  });
});
