/**
 * select --wait (VOY-1705) — contract tests.
 *
 * pickReflected/isSettled are the pure decision points; waitForPickSettle is
 * exercised with injected gql/sleep/now so the poll loop, two-phase ordering,
 * timeout honesty, and backoff behavior are all asserted without real timers.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { pickReflected, rowReflected, isSettled, waitForPickSettle } from "./select-wait.js";
import type { PlanStatusData } from "./plan-status.js";

const choice = (travellerId: string, optionId: string | null) => ({
  traveller: { id: travellerId, firstName: null, lastName: null },
  selectedOption: optionId ? { id: optionId } : null,
  scope: null,
});

describe("pickReflected", () => {
  it("default scope (all travellers): true only on consensus for THIS option", () => {
    const both = { id: "s1", travellerOptionChoices: [choice("t1", "o1"), choice("t2", "o1")] };
    expect(pickReflected(both, "o1", {})).toBe(true);
    expect(pickReflected(both, "o2", {})).toBe(false);
  });

  it("default scope: partial picks are NOT reflected (no consensus yet)", () => {
    const partial = { id: "s1", travellerOptionChoices: [choice("t1", "o1"), choice("t2", null)] };
    expect(pickReflected(partial, "o1", {})).toBe(false);
  });

  it("default scope: divergent picks are NOT consensus for either option", () => {
    const divergent = { id: "s1", travellerOptionChoices: [choice("t1", "o1"), choice("t2", "o2")] };
    expect(pickReflected(divergent, "o1", {})).toBe(false);
    expect(pickReflected(divergent, "o2", {})).toBe(false);
  });

  it("--traveller: only that traveller's choice matters (divergence elsewhere is fine)", () => {
    const divergent = { id: "s1", travellerOptionChoices: [choice("t1", "o1"), choice("t2", "o2")] };
    expect(pickReflected(divergent, "o1", { traveller: "t1" })).toBe(true);
    expect(pickReflected(divergent, "o1", { traveller: "t2" })).toBe(false);
    expect(pickReflected(divergent, "o1", { traveller: "t3" })).toBe(false);
  });

  it("--travellers: ALL listed travellers must have the pick", () => {
    const mixed = { id: "s1", travellerOptionChoices: [choice("t1", "o1"), choice("t2", "o1"), choice("t3", null)] };
    expect(pickReflected(mixed, "o1", { travellers: "t1,t2" })).toBe(true);
    expect(pickReflected(mixed, "o1", { travellers: "t1, t2" })).toBe(true);
    expect(pickReflected(mixed, "o1", { travellers: "t1,t3" })).toBe(false);
    expect(pickReflected(mixed, "o1", { travellers: "" })).toBe(false);
  });

  it("--participant-choice-id is never judged from the selection read (conservative false)", () => {
    const raw = { id: "sel", travellerOptionChoices: [choice("t1", "optA"), choice("t2", "optB")] };
    expect(pickReflected(raw, "optA", { participantChoiceId: "row-1" })).toBe(false);
  });

  it("--group: weakest honest check — at least one traveller chose the option", () => {
    const some = { id: "s1", travellerOptionChoices: [choice("t1", "o1"), choice("t2", null)] };
    expect(pickReflected(some, "o1", { group: "g1" })).toBe(true);
    expect(pickReflected(some, "o2", { group: "g1" })).toBe(false);
  });

  it("no choices at all: falls back to parentOptionId for default scope", () => {
    expect(pickReflected({ id: "s1", parentOptionId: "o1" }, "o1", {})).toBe(true);
    expect(pickReflected({ id: "s1" }, "o1", {})).toBe(false);
  });
});

const status = (over: Partial<PlanStatusData> = {}): PlanStatusData =>
  ({
    readiness: "IN_PROGRESS",
    blockers: [],
    waiting: [],
    nextSteps: [],
    goals: [],
    travellers: [],
    cart: { itemCount: 0, bookableCount: 0, total: null },
    blockerCount: 0,
    planId: "p1",
    planTitle: "T",
    planUrl: "https://x/plans/p1",
    ...over,
  }) as PlanStatusData;

describe("isSettled", () => {
  it("CART_PENDING is the only unsettled wait; OPTIONS_PENDING settles", () => {
    expect(isSettled(status())).toBe(true);
    expect(
      isSettled(status({ waiting: [{ kind: "OPTIONS_PENDING", message: "m", refs: {} }] })),
    ).toBe(true);
    expect(
      isSettled(status({ waiting: [{ kind: "CART_PENDING", message: "m", refs: {} }] })),
    ).toBe(false);
    expect(
      isSettled(
        status({
          waiting: [
            { kind: "OPTIONS_PENDING", message: "m", refs: {} },
            { kind: "CART_PENDING", message: "m", refs: {} },
          ],
        }),
      ),
    ).toBe(false);
  });
});

// ── waitForPickSettle poll loop ──

interface GqlCall {
  query: string;
  vars: Record<string, unknown>;
}

/** Scripted gql: selection reads pop from selectionReads, plan reads from planReads. */
function scriptedGql(selectionReads: unknown[], planReads: unknown[]) {
  const calls: GqlCall[] = [];
  const gql = (async (query: string, vars: Record<string, unknown>) => {
    calls.push({ query, vars });
    if (query.includes("TripPlanSelectionWithMonitor")) {
      return selectionReads.length > 1 ? selectionReads.shift() : selectionReads[0];
    }
    return planReads.length > 1 ? planReads.shift() : planReads[0];
  }) as never;
  return { gql, calls };
}

/** A settled plan read: decided goal + cart item joining a bookable option. */
const settledPlan = () => ({
  tripPlan: {
    id: "p1",
    title: "T",
    travellers: [{ id: "t1", firstName: "A", lastName: "B" }],
    cart: { itemCount: 1, total: 339.1, currency: "USD", items: [{ selectionId: "s1", optionId: "o1" }] },
  },
  tripPlanGoals: [
    {
      id: "g1",
      name: "Flights",
      type: "Flight",
      sortOrder: 0,
      isDecided: true,
      isBooked: false,
      checkoutReadiness: { isReady: true, requirements: [] },
      items: [
        {
          id: "i1",
          selections: [
            {
              id: "s1",
              type: "Flight",
              blueprintMonitorId: "m1",
              options: [{ id: "o1", name: "BWI to MCO", isBookable: true }],
              travellerOptionChoices: [choice("t1", "o1")],
            },
          ],
        },
      ],
    },
  ],
});

/** A CART_PENDING plan read: decided goal, empty cart (regeneration in flight). */
const pendingPlan = () => {
  const p = settledPlan();
  p.tripPlan.cart = { itemCount: 0, total: 0, currency: "USD", items: [] };
  return p;
};

const deps = () => {
  let t = 0;
  return {
    heartbeat: jest.fn(),
    now: () => t,
    sleepFn: async (ms: number) => {
      t += ms;
    },
  };
};

describe("rowReflected (row-addressed --wait)", () => {
  const rows = [
    { id: "row-1", optionId: "optA" },
    { id: "row-2", optionId: null },
    { id: "row-3", optionId: "optA" },
  ];
  it("true only when the TARGETED row carries the option", () => {
    expect(rowReflected(rows, "row-1", "optA")).toBe(true);
    expect(rowReflected(rows, "row-2", "optA")).toBe(false);
  });
  it("a sibling row already on the same option does not count for the target", () => {
    // row-3 has optA; row-2 (the target) does not yet.
    expect(rowReflected(rows, "row-2", "optA")).toBe(false);
  });
  it("an empty-roster row still reflects once ITS optionId flips (no traveller needed)", () => {
    expect(rowReflected([{ id: "row-9", optionId: "optZ" }], "row-9", "optZ")).toBe(true);
  });
  it("returns null when the row is gone from the view", () => {
    expect(rowReflected(rows, "row-404", "optA")).toBeNull();
    expect(rowReflected(null, "row-1", "optA")).toBeNull();
  });
});

/** Scripted gql for row-addressed waits: selection read → choices view(s) → plan read(s). */
function scriptedRowGql(selectionRead: unknown, viewReads: unknown[], planReads: unknown[]) {
  const calls: GqlCall[] = [];
  const gql = (async (query: string, vars: Record<string, unknown>) => {
    calls.push({ query, vars });
    if (query.includes("TripPlanSelectionWithMonitor")) return selectionRead;
    if (query.includes("TripPlanChoicesView")) return viewReads.length > 1 ? viewReads.shift() : viewReads[0];
    return planReads.length > 1 ? planReads.shift() : planReads[0];
  }) as never;
  return { gql, calls };
}

describe("waitForPickSettle — row-addressed scope polls the row, not the selection", () => {
  const selRead = { getTripPlanSelection: { id: "s1", tripPlanId: "p1", travellerOptionChoices: [] } };
  const view = (targetOption: string | null, siblingOption: string | null = null) => ({
    tripPlanChoicesView: [
      { id: "row-target", optionId: targetOption },
      { id: "row-sibling", optionId: siblingOption },
    ],
  });

  it("a sibling row already on the option is NOT the pick; waits until the target row flips", async () => {
    const d = deps();
    const { gql, calls } = scriptedRowGql(selRead, [view(null, "o1"), view(null, "o1"), view("o1", "o1")], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { participantChoiceId: "row-target" }, 30000, "https://x", { gql, ...d });
    expect(out.pickVisible).toBe(true);
    expect(out.settled).toBe(true);
    expect(calls.filter((c) => c.query.includes("TripPlanChoicesView"))).toHaveLength(3);
    // The selection is read exactly once, for the plan id — never to judge the pick.
    expect(calls.filter((c) => c.query.includes("TripPlanSelectionWithMonitor"))).toHaveLength(1);
    expect(calls.find((c) => c.query.includes("TripPlanChoicesView"))?.vars).toEqual({ tripPlanId: "p1" });
  });

  it("an empty-roster row reflects as soon as its optionId matches", async () => {
    const { gql } = scriptedRowGql(selRead, [view("o1")], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { participantChoiceId: "row-target" }, 30000, "https://x", { gql, ...deps() });
    expect(out.pickVisible).toBe(true);
    expect(out.timedOut).toBe(false);
  });

  it("a vanished row stops the wait with rowMissing instead of running to the deadline", async () => {
    const d = deps();
    const { gql } = scriptedRowGql(selRead, [{ tripPlanChoicesView: [{ id: "other", optionId: null }] }], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { participantChoiceId: "row-target" }, 30000, "https://x", { gql, ...d });
    expect(out.rowMissing).toBe(true);
    expect(out.pickVisible).toBe(false);
    expect(out.timedOut).toBe(false);
    expect(out.elapsedMs).toBeLessThan(30000);
  });

  it("times out honestly when the target row never flips", async () => {
    const { gql } = scriptedRowGql(selRead, [view(null)], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { participantChoiceId: "row-target" }, 5000, "https://x", { gql, ...deps() });
    expect(out.pickVisible).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(out.tripPlanId).toBe("p1");
  });
});

describe("waitForPickSettle", () => {
  const selRead = (reflected: boolean) => ({
    getTripPlanSelection: {
      id: "s1",
      tripPlanId: "p1",
      travellerOptionChoices: [choice("t1", reflected ? "o1" : null)],
    },
  });

  it("settles immediately when pick is visible and readiness is settled", async () => {
    const { gql, calls } = scriptedGql([selRead(true)], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { traveller: "t1" }, 30000, "https://x", { gql, ...deps() });
    expect(out.pickVisible).toBe(true);
    expect(out.settled).toBe(true);
    expect(out.timedOut).toBe(false);
    expect(out.tripPlanId).toBe("p1");
    expect(out.planStatus?.readiness).toBeDefined();
    expect(calls).toHaveLength(2); // one selection read, one plan read
  });

  it("polls the selection until the pick becomes visible", async () => {
    const d = deps();
    const { gql, calls } = scriptedGql([selRead(false), selRead(false), selRead(true)], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { traveller: "t1" }, 30000, "https://x", { gql, ...d });
    expect(out.pickVisible).toBe(true);
    expect(out.settled).toBe(true);
    expect(calls.filter((c) => c.query.includes("TripPlanSelectionWithMonitor"))).toHaveLength(3);
    expect(d.heartbeat).toHaveBeenCalled();
  });

  it("times out honestly when the pick never becomes visible — pick success is never masked", async () => {
    const { gql } = scriptedGql([selRead(false)], [settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { traveller: "t1" }, 5000, "https://x", { gql, ...deps() });
    expect(out.pickVisible).toBe(false);
    expect(out.settled).toBe(false);
    expect(out.timedOut).toBe(true);
    // tripPlanId still resolved from the read — the caller can point at plan-status
    expect(out.tripPlanId).toBe("p1");
  });

  it("phase B polls plan-status while CART_PENDING, then settles", async () => {
    // First plan read: empty cart on a decided plan → CART_PENDING; second: bookable item present.
    const { gql, calls } = scriptedGql([selRead(true)], [pendingPlan(), settledPlan()]);
    const out = await waitForPickSettle("s1", "o1", { traveller: "t1" }, 30000, "https://x", { gql, ...deps() });
    expect(out.settled).toBe(true);
    expect(calls.filter((c) => !c.query.includes("TripPlanSelectionWithMonitor")).length).toBeGreaterThanOrEqual(2);
  });

  it("times out with settled=false while cart stays pending, returning the last snapshot", async () => {
    const { gql } = scriptedGql([selRead(true)], [pendingPlan()]);
    const out = await waitForPickSettle("s1", "o1", { traveller: "t1" }, 5000, "https://x", { gql, ...deps() });
    expect(out.pickVisible).toBe(true);
    expect(out.settled).toBe(false);
    expect(out.timedOut).toBe(true);
    expect(out.planStatus).not.toBeNull();
    expect(out.planStatus?.waiting.some((w) => w.kind === "CART_PENDING")).toBe(true);
  });
});
