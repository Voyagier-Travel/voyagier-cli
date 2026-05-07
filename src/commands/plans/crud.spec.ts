import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../../errors.js";

const mockGraphql = jest.fn();

jest.unstable_mockModule("../../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

// Stub plan-footer so registerCrudCommands doesn't try to fetch a footer in tests.
jest.unstable_mockModule("../../plan-footer.js", () => ({
  printPlanFooter: jest.fn().mockResolvedValue(undefined),
  getPlanSummary: jest.fn().mockResolvedValue({ travellerCount: 0, itemCount: 0 }),
}));

let registerCrudCommands: (plans: Command) => void;

beforeAll(async () => {
  const mod = await import("./crud.js");
  registerCrudCommands = mod.registerCrudCommands;
});

beforeEach(() => {
  mockGraphql.mockReset();
});

let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let writes: string[];
let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
let stderrWrites: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  writes = [];
  stderrWrites = [];
  writeSpy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  stderrSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
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

function lastJsonOutput(): any {
  const joined = writes.join("").trim();
  if (!joined) return null;
  return JSON.parse(joined);
}

async function runPlansCreate(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerCrudCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", "create", ...args]);
}

const sampleClient = {
  id: "2c0dbde7-b658-4c7d-ab5b-0226e1a7e22d",
  name: "Daniel Gardner",
  email: "daniel@example.com",
  phone: null,
  avatarUrl: null,
  description: null,
  clientType: "Individual",
  status: "Active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const samplePlan = {
  id: "plan-1",
  title: "Test plan",
  startDate: null,
  endDate: null,
  description: null,
};

describe("plans create — client wiring", () => {
  it("sends { clientId, title } only when --client is an explicit UUID", async () => {
    // resolveClient takes UUID directly, no list call. Then createTripPlan.
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });

    await runPlansCreate([
      "--client",
      sampleClient.id,
      "--title",
      "Test plan",
      "--json",
    ]);

    // Single graphql call (the create); resolveClient short-circuits on UUID.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({
      input: { clientId: sampleClient.id, title: "Test plan" },
    });
    // Critically: no startDate, endDate, description in input.
    expect(vars.input).not.toHaveProperty("startDate");
    expect(vars.input).not.toHaveProperty("endDate");
    expect(vars.input).not.toHaveProperty("description");
  });

  it("auto-resolves the client when --client is omitted and exactly 1 ACTIVE exists, logs to stderr", async () => {
    // 1) tripPlanClients listing (resolveClient auto path).
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient], count: 1, page: 1, limit: 100 },
    });
    // 2) createTripPlan.
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });

    await runPlansCreate(["--title", "Test plan", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, createVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(createVars).toEqual({
      input: { clientId: sampleClient.id, title: "Test plan" },
    });
    const stderrJoined = stderrWrites.join("");
    expect(stderrJoined).toContain("auto-resolved client: Daniel Gardner");
  });

  it("throws NO_CLIENTS when --client is omitted and no ACTIVE clients exist", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [{ ...sampleClient, status: "Archived" }],
        count: 1,
        page: 1,
        limit: 100,
      },
    });

    await expect(
      runPlansCreate(["--title", "Test plan", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.NO_CLIENTS });
  });

  it("throws MULTIPLE_CLIENTS when --client is omitted and >1 ACTIVE exist", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [sampleClient, { ...sampleClient, id: "clt_OTHER", name: "Other" }],
        count: 2,
        page: 1,
        limit: 100,
      },
    });

    await expect(
      runPlansCreate(["--title", "Test plan", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.MULTIPLE_CLIENTS });
  });

  it("warns to stderr when --start, --end, or --description are passed (currently no-ops)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlan: samplePlan });

    await runPlansCreate([
      "--client",
      sampleClient.id,
      "--title",
      "Test plan",
      "--start",
      "2026-09-15",
      "--end",
      "2026-09-22",
      "--description",
      "Demo",
      "--json",
    ]);

    const stderrJoined = stderrWrites.join("");
    expect(stderrJoined).toContain("--start, --end, --description");
    expect(stderrJoined).toContain("not yet wired");
    // And critically, those values are NOT sent in input.
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toEqual({ clientId: sampleClient.id, title: "Test plan" });
  });
});
