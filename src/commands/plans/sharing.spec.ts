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

/** What the API returns for a successful invite, per role. */
const inviteFor = (role: "viewer" | "editor" | "agent", extra: Record<string, unknown> = {}) => ({
  inviteTripPlanCollaborator: {
    id: "inv_1",
    status: "PENDING",
    email: null,
    invitedUserId: "usr_1",
    role: { id: `role-${role}`, name: role.charAt(0).toUpperCase() + role.slice(1), key: role },
    ...extra,
  },
});

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
      .mockResolvedValueOnce(inviteFor("viewer"));

    await run(["share", "plan-1", "--user", "bob", "--json"]);

    // Username lookup + invite: the role key goes straight to the API, no roles round-trip.
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, inviteVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(inviteVars).toEqual({
      tripPlanId: "plan-1",
      input: { invitedUserId: "usr_1", role: "viewer" },
    });
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      success: true,
      planId: "plan-1",
      invitedUser: "Bob Jones",
      role: "Viewer",
    });
  });

  it("sends an explicit --role as its key, case-insensitively (Editor)", async () => {
    mockGraphql
      .mockResolvedValueOnce({ userPublicProfile: { id: "usr_1", name: "Bob", username: "bob" } })
      .mockResolvedValueOnce(inviteFor("editor"));
    await run(["share", "plan-1", "--user", "bob", "--role", "Editor", "--json"]);
    const [, inviteVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(inviteVars.input).toEqual({ invitedUserId: "usr_1", role: "editor" });
    expect(mockJsonOutput).toHaveBeenCalledWith(expect.objectContaining({ role: "Editor" }));
  });

  it("throws NOT_FOUND when the username does not exist", async () => {
    mockGraphql.mockResolvedValueOnce({ userPublicProfile: null });
    await expect(run(["share", "plan-1", "--user", "ghost", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.NOT_FOUND,
    });
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it("invites by email in ONE call, letting the server resolve the address", async () => {
    mockGraphql.mockResolvedValueOnce(inviteFor("viewer", { invitedUserId: "usr_9" }));

    await run(["share", "plan-1", "--email", " AMY@example.com ", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, inviteVars] = mockGraphql.mock.calls[0] as [string, any];
    expect(inviteVars).toEqual({
      tripPlanId: "plan-1",
      input: { invitedEmail: "AMY@example.com", role: "viewer" },
    });
    // An existing account behind the address: a normal invite, not pending signup.
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      success: true,
      planId: "plan-1",
      invitedUser: "AMY@example.com",
      role: "Viewer",
    });
  });

  it("reports pending: true when no account uses the email yet", async () => {
    mockGraphql.mockResolvedValueOnce(inviteFor("editor", { invitedUserId: null, email: "new@example.com" }));

    await run(["share", "plan-1", "--email", "new@example.com", "--role", "editor", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    const [, inviteVars] = mockGraphql.mock.calls[0] as [string, any];
    expect(inviteVars.input).toEqual({ invitedEmail: "new@example.com", role: "editor" });
    expect(mockJsonOutput).toHaveBeenCalledWith({
      ok: true,
      success: true,
      planId: "plan-1",
      invitedUser: "new@example.com",
      role: "Editor",
      pending: true,
    });
  });

  it("human mode explains a pending invite and that nothing was emailed", async () => {
    mockGraphql.mockResolvedValueOnce(inviteFor("viewer", { invitedUserId: null, email: "new@example.com" }));
    await run(["share", "plan-1", "--email", "new@example.com"]);
    const out = logJoined();
    expect(out).toContain("Invited");
    expect(out).toContain("new@example.com");
    expect(out).toContain("sign up");
    expect(out).toContain("No email was sent");
  });

  it("rejects an invalid --role locally with the list of valid roles", async () => {
    await expect(
      run(["share", "plan-1", "--user", "bob", "--role", "boss", "--json"]),
    ).rejects.toMatchObject({ code: CliErrorCode.VALIDATION, message: expect.stringContaining("viewer, editor, agent") });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("prints a human confirmation on success", async () => {
    mockGraphql
      .mockResolvedValueOnce({ userPublicProfile: { id: "usr_1", name: "Bob Jones", username: "bob" } })
      .mockResolvedValueOnce(inviteFor("viewer"));
    await run(["share", "plan-1", "--user", "bob"]);
    expect(logJoined()).toContain("Invited");
    expect(logJoined()).toContain("Bob Jones");
    expect(logJoined()).not.toContain("sign up");
  });

  it("falls back to the requested role name when the API returns no role", async () => {
    mockGraphql.mockResolvedValueOnce({ inviteTripPlanCollaborator: { id: "inv_1", status: "PENDING", invitedUserId: "usr_9" } });
    await run(["share", "plan-1", "--email", "amy@example.com", "--role", "agent", "--json"]);
    expect(mockJsonOutput).toHaveBeenCalledWith(expect.objectContaining({ role: "Agent" }));
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
    expect(JSON.parse(writes.join(""))).toEqual({ ok: true, success: true, removed: "col_1" });
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
