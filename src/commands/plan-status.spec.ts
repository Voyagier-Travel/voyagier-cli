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
  options: [{ id: "o1", name: "BWI to MCO", isBookable: true }],
  travellerOptionChoices: [choice("t1", "o1")],
});

/** Cart with one item that joins to pickedSelection()'s bookable option. */
const bookableCart = (id = "s1", over: Record<string, unknown> = {}) => ({
  itemCount: 1,
  total: 339.1,
  currency: "USD",
  items: [{ selectionId: id, optionId: "o1", ...over }],
});

describe("buildPlanStatus — readiness precedence", () => {
  it("BOOKED beats everything when all goals are booked — and terminal state clears blockers/nextSteps", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1", { gender: null })] }),
        tripPlanGoals: [goal({ isBooked: true })],
      },
      BASE,
    );
    expect(s.readiness).toBe("BOOKED");
    expect(s.summary.goalsBooked).toBe(1);
    // Terminal: no contradictory advice next to a BOOKED verdict.
    expect(s.blockers).toEqual([]);
    expect(s.waiting).toEqual([]);
    expect(s.nextSteps).toEqual([]);
    expect(s.summary.blockerCount).toBe(0);
  });

  it("BLOCKED when any blocker exists, even with waits pending", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1", { gender: null })] }),
        tripPlanGoals: [
          goal({
            checkoutReadiness: {
              isReady: false,
              requirements: [
                { label: "Gender", isFulfilled: false, isRequired: true, type: "TravellerField", missingTravellerIds: ["t1"] },
              ],
            },
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

  it("READY_TO_BOOK when no blockers, no waits, cart has ≥1 BOOKABLE item", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: bookableCart() }),
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
    expect(s.cart.bookableCount).toBe(1);
    expect(s.nextSteps).toEqual(["voyagier book plan-1 --dry-run"]);
  });

  it("cart items that don't join to a bookable option gate READY_TO_BOOK (no false ready)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({
          cart: { itemCount: 1, total: 100, currency: "USD", items: [{ selectionId: "s1", optionId: "o-unknown" }] },
        }),
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
    expect(s.cart.bookableCount).toBe(0);
    expect(s.readiness).toBe("IN_PROGRESS");
    expect(s.waiting[0].kind).toBe("CART_PENDING");
    expect(s.waiting[0].message).toContain("none report bookable");
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

  it("passport joins traveller `missing` (and blocks) only when a cart item requires it", () => {
    const goals = [
      goal({
        isDecided: true,
        checkoutReadiness: { isReady: true, requirements: [] },
        items: [{ id: "i1", selections: [pickedSelection()] }],
      }),
    ];
    // Domestic (requiresPassport absent): no passport gap.
    const domestic = buildPlanStatus(
      { tripPlan: plan({ cart: bookableCart() }), tripPlanGoals: goals },
      BASE,
    );
    expect(domestic.travellers[0].missing).toEqual([]);
    expect(domestic.readiness).toBe("READY_TO_BOOK");
    // International (server says requiresPassport): traveller without passport blocks.
    const intl = buildPlanStatus(
      { tripPlan: plan({ cart: bookableCart("s1", { requiresPassport: true }) }), tripPlanGoals: goals },
      BASE,
    );
    expect(intl.travellers[0].missing).toEqual(["passport"]);
    expect(intl.readiness).toBe("BLOCKED");
    expect(intl.blockers[0].kind).toBe("TRAVELLER_DATA");
    expect(intl.blockers[0].message).toContain("passport");
    // nextSteps tailored to the actual gap — passport flags, no gender/dob noise.
    expect(intl.nextSteps[0]).toBe(
      "voyagier travellers update t1 --passport-number <number> --passport-country <code> --passport-expiry <YYYY-MM>",
    );
  });

  it("buildPlanStatus throws a clear error on null tripPlan", () => {
    expect(() => buildPlanStatus({ tripPlan: null, tripPlanGoals: [] }, BASE)).toThrow(
      /tripPlan is null/,
    );
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
                { label: "Passport required", isFulfilled: false, isRequired: true, selectionId: "s-other", type: "ParticipantChoice" },
                { label: "Date of birth", isFulfilled: false, isRequired: true, type: "TravellerField", missingTravellerIds: ["t1"] },
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
    // The TravellerField requirement dedupes onto the TRAVELLER_DATA root cause.
    expect(s.blockers.filter((b) => b.message.includes("Date of birth"))).toEqual([]);
    // SELECTION_INPUT names the field (honesty rule)
    expect(s.blockers[1].message).toContain("Departure date");
    // nextSteps map 1:1, deduped, runnable
    expect(s.nextSteps).toEqual([
      "voyagier travellers update t1 --dob <YYYY-MM-DD>",
      "voyagier plans goal g1 --json   # inspect the blocking requirements",
      "voyagier selection-options s-pick --json   # list options",
      "voyagier select --selection-id s-pick --option-id <optionId>",
    ]);
  });

  it("kind ordering holds across goals (PICK_PENDING in an earlier goal sorts after SELECTION_INPUT in a later one)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            id: "g1",
            sortOrder: 0,
            items: [
              {
                id: "i1",
                selections: [
                  { id: "s-pick", type: "Flight", blueprintMonitorId: "m1", options: [{ id: "o1", name: "A" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
          goal({
            id: "g2",
            sortOrder: 1,
            items: [
              {
                id: "i2",
                selections: [
                  {
                    id: "s-input",
                    type: "Date",
                    blueprintMonitorId: null,
                    options: [],
                    inputs: [{ id: "in1", fieldName: "checkin", fieldLabel: "Check-in", isRequired: true, value: null, sourceOutputId: null }],
                  },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    expect(s.blockers.map((b) => b.kind)).toEqual(["SELECTION_INPUT", "PICK_PENDING"]);
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
                { label: "Gender", isFulfilled: false, isRequired: true, type: "TravellerField", missingTravellerIds: ["t1"] },
                { label: "Cabin class", isFulfilled: false, isRequired: true, type: "ParticipantChoice", missingTravellerIds: [] },
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
                { label: "Gender", isFulfilled: false, isRequired: true, type: "TravellerField", missingTravellerIds: ["t1"] },
              ],
            },
          }),
        ],
      },
      BASE,
    );
    // One TRAVELLER_DATA root cause, not three; Cabin class survives (not traveller-rooted).
    expect(s.blockers.map((b) => `${b.kind}:${b.message}`)).toEqual([
      "TRAVELLER_DATA:T T1 is missing gender (required for checkout)",
      "REQUIREMENT_UNMET:Outbound: Cabin class",
    ]);
  });

  it("traveller gaps do NOT block when no server requirement demands the field (hotel-only plan)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({
          travellers: [traveller("t1", { gender: null, dateOfBirth: null })],
          cart: bookableCart(),
        }),
        tripPlanGoals: [
          goal({
            name: "Hotel",
            type: "Hotel",
            isDecided: true,
            checkoutReadiness: { isReady: true, requirements: [] },
            items: [{ id: "i1", selections: [pickedSelection()] }],
          }),
        ],
      },
      BASE,
    );
    // Informational gap stays visible; no blocker, plan can proceed.
    expect(s.travellers[0].missing).toEqual(["gender", "dateOfBirth"]);
    expect(s.blockers).toEqual([]);
    expect(s.readiness).toBe("READY_TO_BOOK");
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
          cart: {
            itemCount: 2,
            total: 500,
            currency: "USD",
            items: [
              { selectionId: "s1", optionId: "o1" },
              { selectionId: "s1", optionId: "o2" },
            ],
          },
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
                    options: [
                      { id: "o1", name: "A", isBookable: true },
                      { id: "o2", name: "B", isBookable: true },
                    ],
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
        tripPlan: plan({ cart: bookableCart() }),
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
