/**
 * VOY-1724 `plan-status --verify`: runs the shared checkout dry-run and reduces
 * it to { bookable, blockers, chargeableSubtotal }, degrading to { error } on
 * any failure (never fails the whole command). House pattern: mock the network
 * boundary (../api.js) and drive the real helper.
 */
import { jest } from "@jest/globals";

const mockGraphql = jest.fn<(query: string, vars?: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

let runVerify: (planId: string) => Promise<unknown>;
let resolveHotelCodes: (data: unknown) => Promise<Map<string, string>>;

beforeAll(async () => {
  ({ runVerify, resolveHotelCodes } = await import("./plan-status.js"));
});

beforeEach(() => mockGraphql.mockReset());

describe("plan-status --verify (runVerify)", () => {
  it("success: reports bookable, chargeable subtotal, and per-item blockers", async () => {
    mockGraphql.mockResolvedValue({
      tripPlan: {
        id: "plan-1",
        title: "Test",
        cart: {
          items: [
            { id: "c1", name: "Room rate", price: 616.98, currency: "USD", type: "Hotel", selectionId: "s-rate", optionId: "o-rate" },
            { id: "c2", name: "Flight leg", price: 100, currency: "USD", type: "Flight", selectionId: "s-flight", optionId: "o-flight" },
          ],
          itemCount: 2,
          total: 716.98,
          currency: "USD",
        },
        goals: [
          {
            id: "g1",
            name: "Lodging",
            items: [
              {
                id: "i1",
                title: "Lodging",
                selections: [
                  { id: "s-rate", type: "HotelRoomRate", options: [{ id: "o-rate", isBookable: true, blueprintListingId: "L1" }] },
                  { id: "s-flight", type: "Flight", options: [{ id: "o-flight", isBookable: false, externalId: "sabre-x" }] },
                ],
              },
            ],
          },
        ],
      },
    });
    const v = (await runVerify("plan-1")) as {
      bookable: boolean;
      chargeableSubtotal: number;
      currency: string;
      blockers: { itemName: string }[];
    };
    expect(v.bookable).toBe(true);
    expect(v.chargeableSubtotal).toBe(616.98);
    expect(v.currency).toBe("USD");
    expect(v.blockers.map((b) => b.itemName)).toEqual(["Flight leg"]);
  });

  it("error: degrades to { error: <code> } rather than throwing", async () => {
    mockGraphql.mockRejectedValue(new Error("boom"));
    const v = (await runVerify("plan-1")) as { error?: string };
    expect(v.error).toBe("API_ERROR");
  });

  it("error: plan not found degrades to { error: NOT_FOUND }", async () => {
    mockGraphql.mockResolvedValue({ tripPlan: null });
    const v = (await runVerify("plan-1")) as { error?: string };
    expect(v.error).toBe("NOT_FOUND");
  });
});

describe("resolveHotelCodes", () => {
  const data = {
    tripPlan: { id: "plan-1" },
    tripPlanGoals: [
      {
        id: "gh",
        items: [
          {
            selections: [
              {
                id: "hotel-dec",
                type: "Hotel",
                mode: "Single",
                isComplete: true,
                travellerOptionChoices: [{ traveller: { id: "t1" }, selectedOption: { id: "hopt-A" } }],
              },
              { id: "room-A", type: "HotelRoom", mode: "Single", isComplete: false, mirrorListSelectionId: "list-A" },
              { id: "room-B", type: "HotelRoom", mode: "Single", isComplete: false, mirrorListSelectionId: "list-B" },
            ],
          },
        ],
      },
    ],
  };

  it("resolves the chosen hotel + each room chain to a supplier hotelCode via the mirror list", async () => {
    mockGraphql.mockImplementation(async (_q, vars) => {
      const id = (vars as { tripPlanSelectionId: string }).tripPlanSelectionId;
      const byId: Record<string, string> = { "hotel-dec": "HC-001", "list-A": "HC-001", "list-B": "HC-002" };
      const optId = id === "hotel-dec" ? "hopt-A" : "opt";
      return { getTripPlanSelection: { options: [{ id: optId, optionData: { hotelCode: byId[id] } }] } };
    });
    const codes = await resolveHotelCodes(data);
    expect(codes.get("hotel-dec")).toBe("HC-001");
    expect(codes.get("room-A")).toBe("HC-001"); // matches chosen hotel
    expect(codes.get("room-B")).toBe("HC-002"); // different hotel
  });

  it("returns an empty map (no fetches) when no hotel is picked yet", async () => {
    const noPick = {
      tripPlan: { id: "plan-1" },
      tripPlanGoals: [
        {
          id: "gh",
          items: [
            {
              selections: [
                { id: "hotel-dec", type: "Hotel", mode: "Single", isComplete: false, travellerOptionChoices: [] },
                { id: "room-A", type: "HotelRoom", mode: "Single", isComplete: false, mirrorListSelectionId: "list-A" },
              ],
            },
          ],
        },
      ],
    };
    const codes = await resolveHotelCodes(noPick);
    expect(codes.size).toBe(0);
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("degrades to no code (never throws) when a fetch fails", async () => {
    mockGraphql.mockRejectedValue(new Error("boom"));
    const codes = await resolveHotelCodes(data);
    expect(codes.size).toBe(0);
  });
});
