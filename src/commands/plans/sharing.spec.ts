import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliErrorCode } from "../../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});

jest.unstable_mockModule("../../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../../config.js", () => ({
  getApiUrl: jest.fn().mockReturnValue("https://dev.voyagier.com/api"),
  CONFIG_DIR: "/tmp/test-config",
}));

jest.unstable_mockModule("../../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerSharingCommands: (plans: Command) => void;

beforeAll(async () => {
  const mod = await import("./sharing.js");
  registerSharingCommands = mod.registerSharingCommands;
});

// ── Helpers ────────────────────────────────────────────────────────────────

let writes: string[];
let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
let logSpy: jest.SpiedFunction<typeof console.log>;

const logJoined = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  writes = [];
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
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
  const plans = program.command("plans");
  registerSharingCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", ...args]);
}

const roles = [
  { id: "role-viewer", name: "Viewer" },
  { id: "role-editor", name: "Editor" },
  { id: "role-agent", name: "Agent" },
];

// ── plans share ───────────────────────────────────────────────────────────

describe("plans share", () => {
  it("requires either --user or --email", async () => {
    await expect(run(["share", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
  });

  it("rejects passing both --user and --email", async () => {
    await expect(
      run(["share", "plan-1", "--user", "bob", "--email", "bob@x.com", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("invites a user found by username with the default viewer role (--json)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ userPublicProfile: { id: "usr_1", name: "Bob Jones", username: "bob" } })
      .mockResolvedValueOnce({ tripPlanRoles: roles })
      .mockResolvedValueOnce({ inviteTripPlanCollaborator: {} });

    await run(["share", "plan-1", "--user", "bob", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(3);
    const [, inviteVars] = mockGraphql.mock.calls[2] as [string, any];
    expect(inviteVars).toEqual({
      tripPlanId: "plan-1",
      input: { invitedUserId: "usr_1", roleId: "role-viewer" },
    });
    expect(mockJsonOutput).toHaveBeenCalledWith({
      success: true,
      planId: "plan-1",
      invitedUser: "Bob Jones",
      role: "Viewer",
    });
  });

  it("resolves an explicit --role to its id (editor)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ userPublicProfile: { id: "usr_1", name: "Bob", username: "bob" } })
      .mockResolvedValueOnce({ tripPlanRoles: roles })
      .mockResolvedValueOnce({ inviteTripPlanCollaborator: {} });
    await run(["share", "plan-1", "--user", "bob", "--role", "editor", "--json"]);
    const [, inviteVars] = mockGraphql.mock.calls[2] as [string, any];
    expect(inviteVars.input.roleId).toBe("role-editor");
  });

  it("throws NOT_FOUND when the username does not exist", async () => {
    mockGraphql.mockResolvedValueOnce({ userPublicProfile: null });
    await expect(run(["share", "plan-1", "--user", "ghost", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.NOT_FOUND,
    });
  });

  it("invites a user found by email (case-insensitive match)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ users: { items: [{ id: "usr_9", name: "Amy", email: "amy@example.com" }] } })
      .mockResolvedValueOnce({ tripPlanRoles: roles })
      .mockResolvedValueOnce({ inviteTripPlanCollaborator: {} });
    await run(["share", "plan-1", "--email", "AMY@example.com", "--json"]);
    const [, inviteVars] = mockGraphql.mock.calls[2] as [string, any];
    expect(inviteVars.input.invitedUserId).toBe("usr_9");
  });

  it("sends a platform invitation when no account matches the email", async () => {
    mockGraphql
      .mockResolvedValueOnce({ users: { items: [{ id: "usr_9", name: "Amy", email: "amy@example.com" }] } })
      .mockResolvedValueOnce({ createUserInvitation: { __typename: "UserInvitation" } });
    await run(["share", "plan-1", "--email", "new@example.com", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, inviteVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(inviteVars).toEqual({ input: { email: "new@example.com" } });
    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({ invited: true, email: "new@example.com" }),
    );
  });

  it("rejects an invalid --role with the list of valid roles", async () => {
    mockGraphql
      .mockResolvedValueOnce({ userPublicProfile: { id: "usr_1", name: "Bob", username: "bob" } })
      .mockResolvedValueOnce({ tripPlanRoles: roles });
    await expect(
      run(["share", "plan-1", "--user", "bob", "--role", "boss", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
  });

  it("prints a human confirmation on success", async () => {
    mockGraphql
      .mockResolvedValueOnce({ userPublicProfile: { id: "usr_1", name: "Bob Jones", username: "bob" } })
      .mockResolvedValueOnce({ tripPlanRoles: roles })
      .mockResolvedValueOnce({ inviteTripPlanCollaborator: {} });
    await run(["share", "plan-1", "--user", "bob"]);
    expect(logJoined()).toContain("Invited");
    expect(logJoined()).toContain("Bob Jones");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("boom"));
    await expect(run(["share", "plan-1", "--user", "bob", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── plans collaborators ─────────────────────────────────────────────────────

describe("plans collaborators", () => {
  const collab = {
    id: "col_1",
    userId: "usr_1",
    roleId: "role-editor",
    role: { id: "role-editor", name: "Editor" },
    user: { id: "usr_1", firstName: "Amy", lastName: "Adams", email: "amy@example.com" },
  };

  it("--json returns the planId and collaborators", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanCollaborators: [collab] });
    await run(["collaborators", "plan-1", "--json"]);
    const out = JSON.parse(writes.join(""));
    expect(out.planId).toBe("plan-1");
    expect(out.collaborators).toHaveLength(1);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ tripPlanId: "plan-1" });
  });

  it("human mode lists each collaborator with role and email", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanCollaborators: [collab] });
    await run(["collaborators", "plan-1"]);
    const out = logJoined();
    expect(out).toContain("Collaborators (1)");
    expect(out).toContain("Amy Adams");
    expect(out).toContain("amy@example.com");
  });

  it("human mode shows an empty-state line", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanCollaborators: [] });
    await run(["collaborators", "plan-1"]);
    expect(logJoined()).toContain("No collaborators on this plan.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("x"));
    await expect(run(["collaborators", "plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── plans unshare ────────────────────────────────────────────────────────────

describe("plans unshare", () => {
  it("--json emits { success, removed }", async () => {
    mockGraphql.mockResolvedValueOnce({ removeTripPlanCollaborator: true });
    await run(["unshare", "plan-1", "--collaborator-id", "col_1", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ collaboratorId: "col_1" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, removed: "col_1" });
  });

  it("human mode prints a confirmation", async () => {
    mockGraphql.mockResolvedValueOnce({ removeTripPlanCollaborator: true });
    await run(["unshare", "plan-1", "--collaborator-id", "col_1"]);
    expect(logJoined()).toContain("Removed collaborator col_1");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("x"));
    await expect(
      run(["unshare", "plan-1", "--collaborator-id", "col_1", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

// ── plans shared ─────────────────────────────────────────────────────────────

describe("plans shared", () => {
  const shared = { id: "plan-9", title: "Shared Trip", startDate: "2026-09-15", endDate: "2026-09-22" };

  it("--json returns count, paging, and plans", async () => {
    mockGraphql.mockResolvedValueOnce({ sharedTripPlans: { count: 1, items: [shared] } });
    await run(["shared", "--json"]);
    const out = JSON.parse(writes.join(""));
    expect(out).toEqual({ count: 1, page: 1, limit: 20, plans: [shared] });
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ limit: 20, page: 1 });
  });

  it("human mode lists shared plans with links", async () => {
    mockGraphql.mockResolvedValueOnce({ sharedTripPlans: { count: 1, items: [shared] } });
    await run(["shared"]);
    const out = logJoined();
    expect(out).toContain("Shared with you (1 total)");
    expect(out).toContain("Shared Trip");
    expect(out).toContain("/plans/plan-9");
  });

  it("human mode shows an empty-state line", async () => {
    mockGraphql.mockResolvedValueOnce({ sharedTripPlans: { count: 0, items: [] } });
    await run(["shared"]);
    expect(logJoined()).toContain("No shared plans.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("x"));
    await expect(run(["shared", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});
