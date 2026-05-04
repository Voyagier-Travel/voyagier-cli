import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

jest.unstable_mockModule("../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerTravellerGroupsCommands: (program: Command) => void;
let resolveGroupId: (planId: string, nameOrId: string) => Promise<string>;
let parseMemberIds: (csv: string, flagName?: string) => string[];
let formatGroup: (g: unknown) => Record<string, unknown>;

beforeAll(async () => {
  const mod = await import("./traveller-groups.js");
  registerTravellerGroupsCommands = mod.registerTravellerGroupsCommands;
  resolveGroupId = mod.resolveGroupId;
  parseMemberIds = mod.parseMemberIds;
  formatGroup = mod.formatGroup as (g: unknown) => Record<string, unknown>;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const samplePlan = {
  id: "plan_01",
  title: "Paris Family Trip",
  travellers: [{ id: "t1" }, { id: "t2" }],
};

const t1 = { id: "t1", firstName: "Daniel", lastName: "Gardner", email: "d@example.com" };
const t2 = { id: "t2", firstName: "Adrieli", lastName: "Gardner", email: "a@example.com" };

const groupAdults = {
  id: "grp_01",
  name: "Adults",
  color: "#0057FF",
  sortOrder: 1,
  tripPlanId: "plan_01",
  tripPlan: samplePlan,
  travellers: [t1, t2],
};

const groupKids = {
  id: "grp_02",
  name: "Kids",
  color: null,
  sortOrder: 2,
  tripPlanId: "plan_01",
  tripPlan: samplePlan,
  travellers: [],
};

// ── Helpers ────────────────────────────────────────────────────────────────

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let consoleLogSpy: jest.SpiedFunction<(...data: any[]) => void>;
let writes: string[];

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerTravellerGroupsCommands(p);
  return p;
}

function lastJson(): unknown {
  const joined = writes.join("");
  const trimmed = joined.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  writes = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((b: string | Uint8Array) => {
    writes.push(typeof b === "string" ? b : Buffer.from(b).toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  consoleLogSpy = jest.spyOn(console, "log").mockImplementation((...args: any[]) => {
    writes.push(args.map(String).join(" ") + "\n");
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("traveller-groups list", () => {
  it("returns empty list with planContext in --json mode", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "list", "--plan", "plan_01", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ groups: [], total: 0 }),
        planContext: expect.objectContaining({ planId: "plan_01", title: "Paris Family Trip", travellerCount: 2 }),
      }),
    );
  });

  it("returns single group with formatted travellers", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as { data: { groups: unknown[] } };
    expect(out.data.groups).toHaveLength(1);
    expect(out.data.groups[0]).toMatchObject({
      id: "grp_01",
      name: "Adults",
      color: "#0057FF",
      sortOrder: 1,
      travellerCount: 2,
    });
  });

  it("sorts multi-group result by sortOrder asc", async () => {
    const groupC = { ...groupKids, id: "grp_03", name: "Couple", sortOrder: 0 };
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults, groupKids, groupC],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as { data: { groups: { id: string }[] } };
    expect(out.data.groups.map((g) => g.id)).toEqual(["grp_03", "grp_01", "grp_02"]);
  });

  it("throws NOT_FOUND when tripPlan is null (invalid planId)", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "list", "--plan", "bad_id", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });
});

describe("traveller-groups get", () => {
  it("returns group with planContext in --json mode", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "get", "grp_01", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { id: "grp_01" });
    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ group: expect.objectContaining({ id: "grp_01", name: "Adults" }) }),
        planContext: expect.objectContaining({ planId: "plan_01" }),
      }),
    );
  });

  it("throws NOT_FOUND for null group", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "get", "grp_MISSING", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("formats travellers with combined name", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "get", "grp_01", "--json"]);

    const out = lastJson() as { data: { group: { travellers: { name: string }[] } } };
    expect(out.data.group.travellers[0].name).toBe("Daniel Gardner");
  });
});

describe("traveller-groups create", () => {
  it("creates a group with minimal options", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTravellerGroup: groupKids });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "create",
      "--plan", "plan_01", "--name", "Kids", "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { input: { name: "Kids" }, tripPlanId: "plan_01" },
    );
    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: expect.objectContaining({ group: expect.objectContaining({ name: "Kids" }) }) }),
    );
  });

  it("creates a group with --members (includes travellerIds in input)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "create",
      "--plan", "plan_01", "--name", "Adults", "--members", "t1,t2", "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { input: { name: "Adults", travellerIds: ["t1", "t2"] }, tripPlanId: "plan_01" },
    );
  });

  it("echoes --idempotency-key in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTravellerGroup: groupKids });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "create",
      "--plan", "plan_01", "--name", "Kids", "--idempotency-key", "01HXKEY", "--json",
    ]);

    const out = lastJson() as { data: { idempotencyKey: string } };
    expect(out.data.idempotencyKey).toBe("01HXKEY");
  });

  it("throws GROUP_NAME_REQUIRED when --name is missing", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "create", "--plan", "plan_01", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.GROUP_NAME_REQUIRED });
  });

  it("propagates TRAVELLER_NOT_IN_PLAN error from API", async () => {
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.TRAVELLER_NOT_IN_PLAN, "Traveller not in plan"),
    );

    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "traveller-groups", "create",
        "--plan", "plan_01", "--name", "Adults", "--members", "t_OUTSIDER", "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.TRAVELLER_NOT_IN_PLAN });
  });

  it("reclassifies API_ERROR as TRAVELLER_NOT_IN_PLAN when response contains 'not in plan' message", async () => {
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.API_ERROR, "GraphQL error: Traveller t_OUTSIDER is not in this trip plan"),
    );

    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "traveller-groups", "create",
        "--plan", "plan_01", "--name", "Adults", "--members", "t_OUTSIDER", "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.TRAVELLER_NOT_IN_PLAN });
  });
});

describe("traveller-groups update", () => {
  it("updates the group name", async () => {
    mockGraphql.mockResolvedValueOnce({
      updateTripPlanTravellerGroup: { ...groupAdults, name: "Grown-Ups" },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "update", "grp_01",
      "--name", "Grown-Ups", "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { id: "grp_01", input: { name: "Grown-Ups" } },
    );
    const out = lastJson() as { data: { group: { name: string } } };
    expect(out.data.group.name).toBe("Grown-Ups");
  });

  it("throws NOT_FOUND when update returns null", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTravellerGroup: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "update", "grp_MISSING", "--name", "X", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });

  it("echoes --idempotency-key in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "update", "grp_01",
      "--name", "Adults", "--idempotency-key", "01HXKEY2", "--json",
    ]);

    const out = lastJson() as { data: { idempotencyKey: string } };
    expect(out.data.idempotencyKey).toBe("01HXKEY2");
  });

  it("throws GROUP_NAME_REQUIRED when --name is missing", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "update", "grp_01", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.GROUP_NAME_REQUIRED });
  });
});

describe("traveller-groups delete", () => {
  it("reports deleted: true when server returns true", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTravellerGroup: true });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "delete", "grp_01", "--json"]);

    const out = lastJson() as { ok: boolean; data: { deleted: boolean; groupId: string } };
    expect(out.ok).toBe(true);
    expect(out.data.deleted).toBe(true);
    expect(out.data.groupId).toBe("grp_01");
  });

  it("reports deleted: false when server returns false (soft-delete issue)", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTravellerGroup: false });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "delete", "grp_01", "--json"]);

    const out = lastJson() as { ok: boolean; data: { deleted: boolean } };
    expect(out.ok).toBe(false);
    expect(out.data.deleted).toBe(false);
  });

  it("echoes --idempotency-key in JSON output", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTravellerGroup: true });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "delete", "grp_01",
      "--idempotency-key", "01HXDEL", "--json",
    ]);

    const out = lastJson() as { data: { idempotencyKey: string } };
    expect(out.data.idempotencyKey).toBe("01HXDEL");
  });
});

describe("traveller-groups add-members", () => {
  it("all-new members: addedTravellerIds equals full request list", async () => {
    // Pre-fetch: group has no members yet
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupKids, travellers: [] } });
    const updated = { ...groupKids, travellers: [t1] };
    mockGraphql.mockResolvedValueOnce({ addTravellersToGroup: updated });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "add-members", "grp_02",
      "--travellers", "t1", "--json",
    ]);

    expect(mockGraphql).toHaveBeenNthCalledWith(2, expect.any(String), { groupId: "grp_02", travellerIds: ["t1"] });
    const out = lastJson() as { data: { addedTravellerIds: string[] } };
    expect(out.data.addedTravellerIds).toEqual(["t1"]);
  });

  it("all-existing members: addedTravellerIds is empty (no new members added)", async () => {
    // Pre-fetch: group already has t1
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupAdults, travellers: [t1] } });
    // Server deduplicates — group unchanged
    mockGraphql.mockResolvedValueOnce({ addTravellersToGroup: { ...groupAdults, travellers: [t1] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "add-members", "grp_01",
      "--travellers", "t1", "--json",
    ]);

    const out = lastJson() as { data: { addedTravellerIds: string[] } };
    expect(out.data.addedTravellerIds).toEqual([]);
  });

  it("mix of new + existing: addedTravellerIds contains only the new ones", async () => {
    // Pre-fetch: group already has t1
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupAdults, travellers: [t1] } });
    // After mutation: t1 + t2
    mockGraphql.mockResolvedValueOnce({ addTravellersToGroup: { ...groupAdults, travellers: [t1, t2] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "add-members", "grp_01",
      "--travellers", "t1,t2", "--json",
    ]);

    const out = lastJson() as { data: { addedTravellerIds: string[] } };
    expect(out.data.addedTravellerIds).toEqual(["t2"]);
  });

  it("reclassifies API_ERROR as TRAVELLER_NOT_IN_PLAN when mutation returns 'not in plan' message", async () => {
    // Pre-fetch succeeds
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupKids, travellers: [] } });
    // Mutation fails with API_ERROR containing the known pattern
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.API_ERROR, "GraphQL error: Traveller t_OUTSIDER is not in this trip plan"),
    );

    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "traveller-groups", "add-members", "grp_02",
        "--travellers", "t_OUTSIDER", "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.TRAVELLER_NOT_IN_PLAN });
  });

  it("throws MEMBERS_REQUIRED when --travellers is missing", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "add-members", "grp_02", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.MEMBERS_REQUIRED });
  });

  it("echoes --idempotency-key in JSON output", async () => {
    // Pre-fetch: group already has t1 (so t1 is not reported as newly added)
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });
    mockGraphql.mockResolvedValueOnce({ addTravellersToGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "add-members", "grp_01",
      "--travellers", "t1", "--idempotency-key", "01HXADD", "--json",
    ]);

    const out = lastJson() as { data: { idempotencyKey: string } };
    expect(out.data.idempotencyKey).toBe("01HXADD");
  });
});

describe("traveller-groups remove-members", () => {
  it("removes members and returns updated group with accurate removedTravellerIds", async () => {
    // Pre-fetch: group has t1 and t2
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });
    const updated = { ...groupAdults, travellers: [t2] };
    mockGraphql.mockResolvedValueOnce({ removeTravellersFromGroup: updated });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "remove-members", "grp_01",
      "--travellers", "t1", "--json",
    ]);

    expect(mockGraphql).toHaveBeenNthCalledWith(2, expect.any(String), { groupId: "grp_01", travellerIds: ["t1"] });
    const out = lastJson() as { data: { removedTravellerIds: string[] } };
    expect(out.data.removedTravellerIds).toEqual(["t1"]);
  });

  it("non-member removal: removedTravellerIds is empty (not over-counted)", async () => {
    // Pre-fetch: group has only t2 — t1 is not a member
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupAdults, travellers: [t2] } });
    // Server no-ops; group unchanged
    mockGraphql.mockResolvedValueOnce({ removeTravellersFromGroup: { ...groupAdults, travellers: [t2] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "remove-members", "grp_01",
      "--travellers", "t1", "--json",
    ]);

    const out = lastJson() as { data: { removedTravellerIds: string[] } };
    expect(out.data.removedTravellerIds).toEqual([]);
  });

  it("throws MEMBERS_REQUIRED when --travellers is missing", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "remove-members", "grp_01", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.MEMBERS_REQUIRED });
  });

  it("echoes --idempotency-key in JSON output", async () => {
    // Pre-fetch: group has t1
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });
    mockGraphql.mockResolvedValueOnce({ removeTravellersFromGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "remove-members", "grp_01",
      "--travellers", "t1", "--idempotency-key", "01HXRM", "--json",
    ]);

    const out = lastJson() as { data: { idempotencyKey: string } };
    expect(out.data.idempotencyKey).toBe("01HXRM");
  });
});

describe("traveller-groups upsert", () => {
  it("returns existing group when name matches (case-insensitive)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults, groupKids],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "adults", "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledTimes(1); // list only, no create
    const out = lastJson() as { data: { created: boolean; group: { name: string } } };
    expect(out.data.created).toBe(false);
    expect(out.data.group.name).toBe("Adults");
  });

  it("creates new group when no name match found", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlanTravellerGroups: [groupAdults], tripPlan: samplePlan })
      .mockResolvedValueOnce({ createTripPlanTravellerGroup: groupKids });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "Kids", "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledTimes(2); // list + create
    const out = lastJson() as { data: { created: boolean; group: { name: string } } };
    expect(out.data.created).toBe(true);
    expect(out.data.group.name).toBe("Kids");
  });

  it("passes --members to create call when no match found", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan })
      .mockResolvedValueOnce({ createTripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "Adults", "--members", "t1,t2", "--json",
    ]);

    expect(mockGraphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      { input: { name: "Adults", travellerIds: ["t1", "t2"] }, tripPlanId: "plan_01" },
    );
  });

  it("echoes --idempotency-key whether created or found", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "Adults", "--idempotency-key", "01HXUPS", "--json",
    ]);

    const out = lastJson() as { data: { idempotencyKey: string } };
    expect(out.data.idempotencyKey).toBe("01HXUPS");
  });

  it("throws GROUP_NAME_REQUIRED when --name is missing", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "traveller-groups", "upsert", "--plan", "plan_01", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.GROUP_NAME_REQUIRED });
  });

  it("reclassifies API_ERROR as TRAVELLER_NOT_IN_PLAN in create path when response contains 'not in plan'", async () => {
    // List call: no existing group with this name
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan });
    // Create call: fails with 'not in plan' API error
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.API_ERROR, "GraphQL error: Traveller t_OUTSIDER is not in this trip plan"),
    );

    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "traveller-groups", "upsert",
        "--plan", "plan_01", "--name", "NewGroup", "--members", "t_OUTSIDER", "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.TRAVELLER_NOT_IN_PLAN });
  });

  it("recovers from race: create fails with duplicate-name error, recovery list finds the group", async () => {
    // Initial list: no match
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan });
    // Create: concurrent upsert already created it — unique constraint error
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.API_ERROR, "GraphQL error: Group already exists with this name"),
    );
    // Recovery list: winner's group is now visible
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "Adults", "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledTimes(3); // list + create(failed) + recovery list
    const out = lastJson() as {
      ok: boolean;
      data: { created: boolean; recoveredFromRace: boolean; group: { name: string } };
    };
    expect(out.ok).toBe(true);
    expect(out.data.created).toBe(false);
    expect(out.data.recoveredFromRace).toBe(true);
    expect(out.data.group.name).toBe("Adults");
  });

  it("throws original error when race recovery list also finds no group", async () => {
    const originalErr = new CliError(CliErrorCode.API_ERROR, "unique constraint: duplicate name adults");
    // Initial list: no match
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan });
    // Create: fails with duplicate error
    mockGraphql.mockRejectedValueOnce(originalErr);
    // Recovery list: group still not found (genuine error, not a race)
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan });

    const p = buildProgram();
    await expect(
      p.parseAsync([
        "node", "test", "traveller-groups", "upsert",
        "--plan", "plan_01", "--name", "Adults", "--json",
      ]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR, message: expect.stringContaining("duplicate name adults") });
  });
});

describe("resolveGroupId", () => {
  it("returns the group id for an exact id match", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [{ id: "grp_01", name: "Adults" }],
      tripPlan: samplePlan,
    });

    const id = await resolveGroupId("plan_01", "grp_01");
    expect(id).toBe("grp_01");
  });

  it("returns the group id for a case-insensitive name match", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [{ id: "grp_01", name: "Adults" }],
      tripPlan: samplePlan,
    });

    const id = await resolveGroupId("plan_01", "ADULTS");
    expect(id).toBe("grp_01");
  });

  it("throws NOT_FOUND when name/id has no match", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [{ id: "grp_01", name: "Adults" }],
      tripPlan: samplePlan,
    });

    await expect(resolveGroupId("plan_01", "Nonexistent")).rejects.toMatchObject({
      code: CliErrorCode.NOT_FOUND,
    });
  });

  it("throws PLAN_NOT_FOUND when tripPlan is null (invalid planId)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [],
      tripPlan: null,
    });

    await expect(resolveGroupId("bad_plan_id", "Adults")).rejects.toMatchObject({
      code: CliErrorCode.PLAN_NOT_FOUND,
      message: expect.stringContaining("Trip plan"),
    });
  });
});

describe("parseMemberIds", () => {
  it("parses and dedupes comma-separated ids", () => {
    expect(parseMemberIds("t1,t2,t1")).toEqual(["t1", "t2"]);
  });

  it("trims whitespace around ids", () => {
    expect(parseMemberIds(" t1 , t2 ")).toEqual(["t1", "t2"]);
  });

  it("throws MEMBERS_REQUIRED for empty string", () => {
    expect(() => parseMemberIds("")).toThrow(expect.objectContaining({ code: CliErrorCode.MEMBERS_REQUIRED }));
  });

  it("throws MEMBERS_REQUIRED for whitespace-only string", () => {
    expect(() => parseMemberIds("   ,   ")).toThrow(expect.objectContaining({ code: CliErrorCode.MEMBERS_REQUIRED }));
  });
});

describe("traveller-groups list — human output", () => {
  it("empty groups: prints plan name and create hint", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroups: [], tripPlan: samplePlan });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("No traveller groups for plan");
    expect(output).toContain("Paris Family Trip");
    expect(output).toContain("Create one:");
  });

  it("populated: sortOrder index, name, member count, ID line; Color shown/absent conditionally", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults, groupKids],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("[1]");
    expect(output).toContain("Adults");
    expect(output).toContain("2 members");
    expect(output).toContain("ID: grp_01");
    expect(output).toContain("Color: #0057FF");   // groupAdults has color
    expect(output).toContain("[2]");
    expect(output).toContain("Kids");
    expect(output).toContain("0 members");
    expect(output).toContain("ID: grp_02");
    expect(output).not.toContain("Color: null");  // groupKids has no color
  });
});

describe("traveller-groups get — human output", () => {
  it("with color and members: shows name, plan, Color, Sort, members list", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "get", "grp_01"]);

    const output = writes.join("");
    expect(output).toContain("Adults");
    expect(output).toContain("grp_01");
    expect(output).toContain("Plan:");
    expect(output).toContain("Color:");
    expect(output).toContain("#0057FF");
    expect(output).toContain("Sort:");
    expect(output).toContain("Members (2):");
    expect(output).toContain("Daniel Gardner");
    expect(output).toContain("Adrieli Gardner");
  });

  it("without color: Color line omitted", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupKids });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "get", "grp_02"]);

    const output = writes.join("");
    expect(output).toContain("Kids");
    expect(output).not.toContain("Color:");
    expect(output).toContain("Members (0):");
  });
});

describe("traveller-groups create — human output", () => {
  it("with members: prints '✓ Created group', ID, and member count", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTravellerGroup: groupAdults });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "create",
      "--plan", "plan_01", "--name", "Adults", "--members", "t1,t2",
    ]);

    const output = writes.join("");
    expect(output).toContain("Created group: Adults");
    expect(output).toContain("ID: grp_01");
    expect(output).toContain("Members: 2");
  });

  it("without members: no Members line", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanTravellerGroup: groupKids });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "create",
      "--plan", "plan_01", "--name", "Kids",
    ]);

    const output = writes.join("");
    expect(output).toContain("Created group: Kids");
    expect(output).not.toContain("Members:");
  });
});

describe("traveller-groups update — human output", () => {
  it("success: prints '✓ Updated group' with new name and ID", async () => {
    mockGraphql.mockResolvedValueOnce({
      updateTripPlanTravellerGroup: { ...groupAdults, name: "Grown-Ups" },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "update", "grp_01", "--name", "Grown-Ups",
    ]);

    const output = writes.join("");
    expect(output).toContain("Updated group: Grown-Ups");
    expect(output).toContain("ID: grp_01");
  });
});

describe("traveller-groups delete — human output", () => {
  it("deleted=true: prints green success message", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTravellerGroup: true });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "delete", "grp_01"]);

    const output = writes.join("");
    expect(output).toContain("Deleted group: grp_01");
  });

  it("deleted=false: prints warning message", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanTravellerGroup: false });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-groups", "delete", "grp_01"]);

    const output = writes.join("");
    expect(output).toContain("Server returned false for delete of group grp_01");
  });
});

describe("traveller-groups add-members — human output", () => {
  it("success: prints actually-added count (not request count), group name, group ID, member total", async () => {
    // Pre-fetch: group has no members
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupKids, travellers: [] } });
    const updated = { ...groupKids, travellers: [t1] };
    mockGraphql.mockResolvedValueOnce({ addTravellersToGroup: updated });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "add-members", "grp_02",
      "--travellers", "t1",
    ]);

    const output = writes.join("");
    expect(output).toContain("Added 1 traveller(s) to group: Kids");
    expect(output).toContain("Group ID: grp_02");
    expect(output).toContain("Members now: 1");
  });

  it("existing member re-added: reports 0 added (not 1)", async () => {
    // Pre-fetch: group already has t1
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupKids, travellers: [t1] } });
    // Server deduplicates — group unchanged
    mockGraphql.mockResolvedValueOnce({ addTravellersToGroup: { ...groupKids, travellers: [t1] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "add-members", "grp_02",
      "--travellers", "t1",
    ]);

    const output = writes.join("");
    expect(output).toContain("Added 0 traveller(s) to group: Kids");
    expect(output).toContain("Members now: 1");
  });
});

describe("traveller-groups remove-members — human output", () => {
  it("success: prints actually-removed count (not request count), group name, group ID, member total", async () => {
    // Pre-fetch: group has t1 and t2
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: groupAdults });
    const updated = { ...groupAdults, travellers: [t2] };
    mockGraphql.mockResolvedValueOnce({ removeTravellersFromGroup: updated });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "remove-members", "grp_01",
      "--travellers", "t1",
    ]);

    const output = writes.join("");
    expect(output).toContain("Removed 1 traveller(s) from group: Adults");
    expect(output).toContain("Group ID: grp_01");
    expect(output).toContain("Members now: 1");
  });

  it("non-member removal: reports 0 removed (not 1)", async () => {
    // Pre-fetch: group has only t2, t1 is not a member
    mockGraphql.mockResolvedValueOnce({ tripPlanTravellerGroup: { ...groupAdults, travellers: [t2] } });
    mockGraphql.mockResolvedValueOnce({ removeTravellersFromGroup: { ...groupAdults, travellers: [t2] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "remove-members", "grp_01",
      "--travellers", "t1",
    ]);

    const output = writes.join("");
    expect(output).toContain("Removed 0 traveller(s) from group: Adults");
  });
});

describe("traveller-groups upsert — human output", () => {
  it("found existing: prints '◆ Found existing group' with name and ID", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanTravellerGroups: [groupAdults, groupKids],
      tripPlan: samplePlan,
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "Adults",
    ]);

    const output = writes.join("");
    expect(output).toContain("Found existing group: Adults");
    expect(output).toContain("ID: grp_01");
  });

  it("created new: prints '✓ Created group' with name and ID", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlanTravellerGroups: [groupAdults], tripPlan: samplePlan })
      .mockResolvedValueOnce({ createTripPlanTravellerGroup: groupKids });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-groups", "upsert",
      "--plan", "plan_01", "--name", "Kids",
    ]);

    const output = writes.join("");
    expect(output).toContain("Created group: Kids");
    expect(output).toContain("ID: grp_02");
  });
});
