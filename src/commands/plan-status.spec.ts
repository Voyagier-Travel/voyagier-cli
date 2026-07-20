import { describe, it, expect } from "@jest/globals";
import { buildPlanStatus, type PlanStatusQueryResult } from "./plan-status.js";

/**
 * VOY-1704 contract tests. buildPlanStatus is pure — same inputs, same output.
 * The JSON shape is the product: these tests pin the readiness precedence,
 * blocker ordering, and nextSteps mapping agents depend on.
 */

const BASE = "https://travel.voyagier.com";

const traveller = (id: string, over: Partial<{ gender: string | null; dateOfBirth: string | null }> = {}) => ({
  id,
  firstName: "T",
  lastName: id.toUpperCase(),
  gender: over.gender === undefined ? "FEMALE" : over.gender,
  dateOfBirth: over.dateOfBirth === undefined ? "1998-06-23" : over.dateOfBirth,
});

const choice = (travellerId: string, optionId: string | null) => ({
  traveller: { id: travellerId },
  selectedOption: optionId ? { id: optionId } : null,
});

function plan(over: Partial<NonNullable<PlanStatusQueryResult["tripPlan"]>> = {}): NonNullable<PlanStatusQueryResult["tripPlan"]> {
  return {
    id: "plan-1",
    title: "Test Plan",
    travellers: [traveller("t1")],
    cart: { itemCount: 0, total: 0, currency: "USD" },
    ...over,
  };
}

function goal(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    name: "Flights",
    type: "Flight",
    sortOrder: 0,
    isDecided: false,
    isBooked: false,
    checkoutReadiness: { isReady: false, requirements: [] },
    items: [],
    ...over,
  };
}

const pickedSelection = (id = "s1") => ({
  id,
  type: "Flight",
  blueprintMonitorId: "m1",
  options: [{ id: "o1", name: "BWI to MCO" }],
  travellerOptionChoices: [choice("t1", "o1")],
});

describe("buildPlanStatus — readiness precedence", () => {
  it("BOOKED beats everything when all goals are booked", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1", { gender: null })] }),
        tripPlanGoals: [goal({ isBooked: true })],
      },
      BASE,
    );
    expect(s.readiness).toBe("BOOKED");
    expect(s.summary.goalsBooked).toBe(1);
  });

  it("BLOCKED when any blocker exists, even with waits pending", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1", { gender: null })] }),
        tripPlanGoals: [
          goal({
            items: [
              {
                id: "i1",
                selections: [
                  { id: "s1", type: "Flight", blueprintMonitorId: "m1", options: [] }, // FETCHING
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.readiness).toBe("BLOCKED");
    expect(s.blockers.map((b) => b.kind)).toEqual(["TRAVELLER_DATA"]);
    expect(s.waiting.map((w) => w.kind)).toEqual(["OPTIONS_PENDING"]);
  });

  it("IN_PROGRESS when only self-resolving waits remain", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            items: [
              { id: "i1", selections: [{ id: "s1", type: "Flight", blueprintMonitorId: "m1", options: [] }] },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.readiness).toBe("IN_PROGRESS");
    expect(s.blockers).toEqual([]);
  });

  it("READY_TO_BOOK when no blockers, no waits, cart has items", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 1, total: 339.1, currency: "USD" } }),
        tripPlanGoals: [
          goal({
            isDecided: true,
            checkoutReadiness: { isReady: true, requirements: [] },
            items: [{ id: "i1", selections: [pickedSelection()] }],
          }),
        ],
      },
      BASE,
    );
    expect(s.readiness).toBe("READY_TO_BOOK");
    expect(s.nextSteps).toEqual(["voyagier book plan-1 --dry-run"]);
  });

  it("empty cart with nothing pending → IN_PROGRESS with a CART_PENDING wait, never a silent READY", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            isDecided: true,
            checkoutReadiness: { isReady: true, requirements: [] },
            items: [{ id: "i1", selections: [pickedSelection()] }],
          }),
        ],
      },
      BASE,
    );
    expect(s.readiness).toBe("IN_PROGRESS");
    expect(s.waiting.map((w) => w.kind)).toEqual(["CART_PENDING"]);
    expect(s.nextSteps.some((c) => c.includes("voyagier cart plan-1"))).toBe(true);
  });
});

describe("buildPlanStatus — blockers", () => {
  it("orders blockers traveller-data → inputs → picks → requirements", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1", { dateOfBirth: null })] }),
        tripPlanGoals: [
          goal({
            checkoutReadiness: {
              isReady: false,
              requirements: [
                { label: "Passport required", isFulfilled: false, isRequired: true, selectionId: "s-other" },
              ],
            },
            items: [
              {
                id: "i1",
                selections: [
                  {
                    id: "s-input",
                    type: "Date",
                    blueprintMonitorId: null, // AWAITING_INPUT
                    options: [],
                    inputs: [{ id: "in1", fieldName: "departureDate", fieldLabel: "Departure date", isRequired: true, value: null, sourceOutputId: null }],
                  },
                  {
                    id: "s-pick",
                    type: "Flight",
                    blueprintMonitorId: "m1",
                    options: [{ id: "o1", name: "A" }],
                    travellerOptionChoices: [choice("t1", null)],
                  },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers.map((b) => b.kind)).toEqual([
      "TRAVELLER_DATA",
      "SELECTION_INPUT",
      "PICK_PENDING",
      "REQUIREMENT_UNMET",
    ]);
    // SELECTION_INPUT names the field (honesty rule)
    expect(s.blockers[1].message).toContain("Departure date");
    // nextSteps map 1:1, deduped, runnable
    expect(s.nextSteps).toEqual([
      "voyagier travellers update t1 --gender <M|F|X> --dob <YYYY-MM-DD>",
      "voyagier plans goal g1 --json   # inspect the blocking requirements",
      "voyagier selection-options s-pick --json   # list options",
      "voyagier select --selection-id s-pick --option-id <optionId>",
    ]);
  });

  it("AWAITING_INPUT with no named inputs is dependency-pending — detail only, NO blocker", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            items: [
              { id: "i1", selections: [{ id: "s1", type: "Date", blueprintMonitorId: null, options: [], inputs: [] }] },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers).toEqual([]);
    expect(s.goals[0].selections[0].status).toBe("AWAITING_INPUT");
    expect(s.goals[0].selections[0].blockedOnUnavailable).toBe(true);
  });

  it("requirements rooted in already-reported missing traveller data are deduped", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1", { gender: null })] }),
        tripPlanGoals: [
          goal({
            id: "g1",
            name: "Outbound",
            checkoutReadiness: {
              isReady: false,
              requirements: [
                { label: "Gender", isFulfilled: false, isRequired: true, missingTravellerIds: ["t1"] },
                { label: "Cabin class", isFulfilled: false, isRequired: true, missingTravellerIds: [] },
              ],
            },
          }),
          goal({
            id: "g2",
            name: "Return",
            sortOrder: 1,
            checkoutReadiness: {
              isReady: false,
              requirements: [
                { label: "Gender", isFulfilled: false, isRequired: true, missingTravellerIds: ["t1"] },
              ],
            },
          }),
        ],
      },
      BASE,
    );
    // One TRAVELLER_DATA root cause, not three; Cabin class survives (not traveller-rooted).
    expect(s.blockers.map((b) => `${b.kind}:${b.message}`)).toEqual([
      "TRAVELLER_DATA:T T1 is missing gender (required for flight checkout)",
      "REQUIREMENT_UNMET:Outbound: Cabin class",
    ]);
  });

  it("requirement already covered by a selection blocker is deduped", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            checkoutReadiness: {
              isReady: false,
              requirements: [{ label: "Pick a flight", isFulfilled: false, isRequired: true, selectionId: "s1" }],
            },
            items: [
              {
                id: "i1",
                selections: [
                  { id: "s1", type: "Flight", blueprintMonitorId: "m1", options: [{ id: "o1", name: "A" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers.map((b) => b.kind)).toEqual(["PICK_PENDING"]);
  });

  it("List-mode selections never produce PICK_PENDING (they are mirror sources, not decision surfaces)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 1, total: 10, currency: "USD" } }),
        tripPlanGoals: [
          goal({
            items: [
              {
                id: "i1",
                selections: [
                  { id: "s-list", type: "FlightList", mode: "List", blueprintMonitorId: "m1", options: [{ id: "o1", name: "A" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers).toEqual([]);
    expect(s.goals[0].selections[0].mode).toBe("List");
  });

  it("server isComplete=true suppresses PICK_PENDING regardless of choice rows", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 1, total: 10, currency: "USD" } }),
        tripPlanGoals: [
          goal({
            items: [
              {
                id: "i1",
                selections: [
                  { id: "s1", type: "Flight", mode: "Single", isComplete: true, blueprintMonitorId: "m1", options: [{ id: "o1", name: "A" }], travellerOptionChoices: [] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers).toEqual([]);
    expect(s.goals[0].selections[0].isComplete).toBe(true);
  });

  it("locked selections never produce blockers", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 1, total: 10, currency: "USD" } }),
        tripPlanGoals: [
          goal({
            items: [
              { id: "i1", selections: [{ id: "s1", type: "Date", isLocked: true, blueprintMonitorId: null, options: [], inputs: [] }] },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers).toEqual([]);
  });
});

describe("buildPlanStatus — divergent picks are valid (demmersong 2026-07-20)", () => {
  it("all travellers picked different options: allPicked=true, consensus=false, NO blocker", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({
          travellers: [traveller("t1"), traveller("t2")],
          cart: { itemCount: 2, total: 500, currency: "USD" },
        }),
        tripPlanGoals: [
          goal({
            items: [
              {
                id: "i1",
                selections: [
                  {
                    id: "s1",
                    type: "Flight",
                    blueprintMonitorId: "m1",
                    options: [{ id: "o1", name: "A" }, { id: "o2", name: "B" }],
                    travellerOptionChoices: [choice("t1", "o1"), choice("t2", "o2")],
                  },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    const sel = s.goals[0].selections[0];
    expect(sel.allPicked).toBe(true);
    expect(sel.consensus).toBe(false);
    expect(sel.chosenOptionId).toBeNull();
    expect(s.blockers).toEqual([]);
    expect(s.readiness).toBe("READY_TO_BOOK");
  });

  it("partial picks → PICK_PENDING naming the count still to pick", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1"), traveller("t2")] }),
        tripPlanGoals: [
          goal({
            items: [
              {
                id: "i1",
                selections: [
                  {
                    id: "s1",
                    type: "Flight",
                    blueprintMonitorId: "m1",
                    options: [{ id: "o1", name: "A" }],
                    travellerOptionChoices: [choice("t1", "o1"), choice("t2", null)],
                  },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers[0].kind).toBe("PICK_PENDING");
    expect(s.blockers[0].message).toContain("1 traveller(s) still need to pick");
    expect(s.goals[0].selections[0].travellersPending).toEqual(["t2"]);
  });
});

describe("buildPlanStatus — misc contract", () => {
  it("consensus pick surfaces chosenOptionName", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 1, total: 339.1, currency: "USD" } }),
        tripPlanGoals: [goal({ items: [{ id: "i1", selections: [pickedSelection()] }] })],
      },
      BASE,
    );
    const sel = s.goals[0].selections[0];
    expect(sel.chosenOptionName).toBe("BWI to MCO");
    expect(sel.consensus).toBe(true);
  });

  it("empty plan (no goals, no travellers) → IN_PROGRESS via CART_PENDING, url built from base", () => {
    const s = buildPlanStatus({ tripPlan: plan({ travellers: [] }), tripPlanGoals: [] }, BASE);
    expect(s.readiness).toBe("IN_PROGRESS");
    expect(s.url).toBe("https://travel.voyagier.com/plans/plan-1");
    expect(s.summary).toEqual({ goalsTotal: 0, goalsDecided: 0, goalsBooked: 0, blockerCount: 0 });
  });

  it("goals sort by sortOrder", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [goal({ id: "g2", sortOrder: 5, name: "Second" }), goal({ id: "g1", sortOrder: 1, name: "First" })],
      },
      BASE,
    );
    expect(s.goals.map((g) => g.name)).toEqual(["First", "Second"]);
  });
});
