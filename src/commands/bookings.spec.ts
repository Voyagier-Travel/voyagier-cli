import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerBookingsCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./bookings.js");
  registerBookingsCommands = mod.registerBookingsCommands;
});

// ── Fixtures & helpers ────────────────────────────────────────────────────────

const flightBooking = {
  id: "bkg_1",
  type: "FlightBooking",
  status: "Confirmed",
  pnr: "ABC123",
  providerName: "JetBlue",
  providerReference: "REF-9",
  amount: 26800, // cents → $268.00
  currency: "USD",
  issueDate: "2026-08-01T00:00:00Z",
  travelStartDate: "2026-09-15T00:00:00Z",
  travelEndDate: "2026-09-22T00:00:00Z",
  tripPlanId: "plan-1",
  tripPlan: { id: "plan-1", title: "Paris Trip" },
  tripPlanItem: { id: "item-1", title: "Flight to Paris" },
  travellers: [{ firstName: "John", lastName: "Doe" }],
};

const hotelBooking = {
  id: "bkg_2",
  type: "HotelBooking",
  status: "Pending",
  amount: 15000,
  providerReference: "HREF-2",
};

let writes: string[];
let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
let stderrWrites: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;

const logJoined = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  mockGraphql.mockReset();
  writes = [];
  stderrWrites = [];
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  writeSpy.mockRestore();
  stderrSpy.mockRestore();
  logSpy.mockRestore();
});

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBookingsCommands(program);
  await program.parseAsync(["node", "voyagier", "bookings", ...args]);
}

// ── bookings list ───────────────────────────────────────────────────────────

describe("bookings list", () => {
  it("applies the default limit filter and enriches records with a url (--json)", async () => {
    // --limit defaults to "20", so the filtered query is always used and the
    // by-user branch is not reachable from the CLI.
    mockGraphql.mockResolvedValueOnce({ getBookingRecords: [flightBooking] });
    await run(["list", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ filters: { limit: 20 } });
    const out = JSON.parse(writes.join(""));
    expect(out.bookings).toHaveLength(1);
    expect(out.bookings[0].url).toContain("/plans/plan-1");
  });

  it("uses the filtered query and forwards parsed filters", async () => {
    mockGraphql.mockResolvedValueOnce({ getBookingRecords: [flightBooking] });
    await run([
      "list",
      "--plan", "plan-1",
      "--status", "Confirmed",
      "--type", "FlightBooking",
      "--limit", "5",
      "--json",
    ]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({
      filters: { tripPlanId: "plan-1", status: "Confirmed", type: "FlightBooking", limit: 5 },
    });
  });

  it("human mode renders label, status, amount, and PNR", async () => {
    mockGraphql.mockResolvedValueOnce({ getBookingRecords: [flightBooking] });
    await run(["list"]);
    const out = logJoined();
    expect(out).toContain("Bookings (1)");
    expect(out).toContain("Flight");
    expect(out).toContain("confirmed");
    expect(out).toContain("$268.00");
    expect(out).toContain("PNR: ABC123");
  });

  it("human mode shows an empty-state line", async () => {
    mockGraphql.mockResolvedValueOnce({ getBookingRecords: [] });
    await run(["list"]);
    expect(logJoined()).toContain("No bookings found.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("boom"));
    await expect(run(["list", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── bookings get ─────────────────────────────────────────────────────────────

describe("bookings get", () => {
  it("--json returns the record enriched with a url", async () => {
    mockGraphql.mockResolvedValueOnce({ getBookingRecord: flightBooking });
    await run(["get", "bkg_1", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ id: "bkg_1" });
    const out = JSON.parse(writes.join(""));
    expect(out.id).toBe("bkg_1");
    expect(out.url).toContain("/plans/plan-1");
  });

  it("--refresh calls the refresh mutation first, then re-reads the record", async () => {
    mockGraphql
      .mockResolvedValueOnce({ refreshBookingRecord: flightBooking }) // REFRESH
      .mockResolvedValueOnce({ getBookingRecord: flightBooking }); // GET
    await run(["get", "bkg_1", "--refresh", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, refreshVars] = mockGraphql.mock.calls[0] as [string, any];
    expect(refreshVars).toEqual({ id: "bkg_1" });
  });

  it("--refresh writes a progress line to stderr in human mode", async () => {
    mockGraphql
      .mockResolvedValueOnce({ refreshBookingRecord: flightBooking })
      .mockResolvedValueOnce({ getBookingRecord: flightBooking });
    await run(["get", "bkg_1", "--refresh"]);
    expect(stderrWrites.join("")).toContain("Refreshing from provider");
    expect(logJoined()).toContain("Refreshed from provider");
  });

  it("human mode prints the full detail block", async () => {
    mockGraphql.mockResolvedValueOnce({ getBookingRecord: flightBooking });
    await run(["get", "bkg_1"]);
    const out = logJoined();
    expect(out).toContain("Booking: Flight");
    expect(out).toContain("ABC123");
    expect(out).toContain("REF-9");
    expect(out).toContain("JetBlue");
    expect(out).toContain("$268.00");
    expect(out).toContain("Paris Trip");
    expect(out).toContain("Flight to Paris");
    expect(out).toContain("John Doe");
  });

  it("human mode renders a minimal hotel record without optional fields", async () => {
    mockGraphql.mockResolvedValueOnce({ getBookingRecord: hotelBooking });
    await run(["get", "bkg_2"]);
    const out = logJoined();
    expect(out).toContain("Booking: Hotel");
    expect(out).toContain("pending");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("down"));
    await expect(run(["get", "bkg_1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});
