import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockFatal = jest.fn().mockImplementation((msg: string) => {
  throw new CliError(CliErrorCode.VALIDATION, msg);
});

jest.unstable_mockModule("../../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

jest.unstable_mockModule("../../output.js", () => ({
  fatal: mockFatal,
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerSocialCommands: (plans: Command) => void;

beforeAll(async () => {
  const mod = await import("./social.js");
  registerSocialCommands = mod.registerSocialCommands;
});

// ── Helpers ────────────────────────────────────────────────────────────────

let writes: string[];
let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
let logSpy: jest.SpiedFunction<typeof console.log>;

const logJoined = (): string => logSpy.mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  mockGraphql.mockReset();
  mockFatal.mockClear();
  writes = [];
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  writeSpy.mockRestore();
  logSpy.mockRestore();
});

async function run(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerSocialCommands(plans);
  await program.parseAsync(["node", "voyagier", "plans", ...args]);
}

// ── plans comments ───────────────────────────────────────────────────────────

describe("plans comments", () => {
  it("deletes a comment (--delete, --json)", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanItemComment: true });
    await run(["comments", "item-1", "--delete", "cmt_9", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ id: "cmt_9" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, deleted: "cmt_9" });
  });

  it("delete prints a confirmation in human mode", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanItemComment: true });
    await run(["comments", "item-1", "--delete", "cmt_9"]);
    expect(logJoined()).toContain("Comment deleted");
  });

  it("adds a comment (--add, --json)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanItemComment: { id: "cmt_1", text: "Nice" } });
    await run(["comments", "item-1", "--add", "Nice", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ itemId: "item-1", input: { content: "Nice" } });
    expect(JSON.parse(writes.join(""))).toEqual({ id: "cmt_1", text: "Nice" });
  });

  it("adds a threaded reply with --reply-to", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanItemComment: { id: "cmt_2", text: "Agreed" } });
    await run(["comments", "item-1", "--add", "Agreed", "--reply-to", "cmt_1", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input).toEqual({ content: "Agreed", parentCommentId: "cmt_1" });
  });

  it("add prints a confirmation in human mode", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanItemComment: { id: "cmt_1", text: "Nice" } });
    await run(["comments", "item-1", "--add", "Nice"]);
    expect(logJoined()).toContain("Comment added");
  });

  it("lists comments (--json) with the parsed limit", async () => {
    const items = [
      { id: "cmt_1", text: "Hello", author: { id: "u1", firstName: "Amy", lastName: "Adams" }, replies: [] },
    ];
    mockGraphql.mockResolvedValueOnce({ tripPlanItemComments: { count: 1, items } });
    await run(["comments", "item-1", "--limit", "5", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ itemId: "item-1", limit: 5, page: 1 });
    const out = JSON.parse(writes.join(""));
    expect(out.itemId).toBe("item-1");
    expect(out.comments).toHaveLength(1);
  });

  it("human mode renders authors, comment text, and replies", async () => {
    const items = [
      {
        id: "cmt_1",
        text: "Looks great",
        author: { id: "u1", firstName: "Amy", lastName: "Adams" },
        replies: [{ id: "cmt_2", text: "Agreed", author: { firstName: "Ben", lastName: "Bell" } }],
      },
    ];
    mockGraphql.mockResolvedValueOnce({ tripPlanItemComments: { count: 1, items } });
    await run(["comments", "item-1"]);
    const out = logJoined();
    expect(out).toContain("Comments (1)");
    expect(out).toContain("Amy Adams");
    expect(out).toContain("Looks great");
    expect(out).toContain("Ben Bell");
    expect(out).toContain("Agreed");
  });

  it("human mode shows an empty-state hint when there are no comments", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanItemComments: { count: 0, items: [] } });
    await run(["comments", "item-1"]);
    expect(logJoined()).toContain("No comments yet.");
  });

  it("wraps a graphql failure as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("boom"));
    await expect(run(["comments", "item-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
  });
});

// ── plans vote ───────────────────────────────────────────────────────────────

describe("plans vote", () => {
  it("upvotes (--up, --json)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanItemFeedback: {} });
    await run(["vote", "item-1", "--up", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ itemId: "item-1", input: { feedbackType: "Upvote" } });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, action: "upvote", itemId: "item-1" });
  });

  it("downvotes (--down, --json)", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanItemFeedback: {} });
    await run(["vote", "item-1", "--down", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars.input.feedbackType).toBe("Downvote");
    expect(JSON.parse(writes.join(""))).toMatchObject({ action: "downvote" });
  });

  it("upvote prints an emoji confirmation in human mode", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanItemFeedback: {} });
    await run(["vote", "item-1", "--up"]);
    expect(logJoined()).toContain("Upvoted");
  });

  it("removes a vote (--remove, --json)", async () => {
    mockGraphql.mockResolvedValueOnce({ deleteTripPlanItemFeedback: true });
    await run(["vote", "item-1", "--remove", "--json"]);
    const [, vars] = mockGraphql.mock.calls[0] as [string, any];
    expect(vars).toEqual({ itemId: "item-1" });
    expect(JSON.parse(writes.join(""))).toEqual({ success: true, action: "removed" });
  });

  it("falls back to update when the first vote already exists", async () => {
    mockGraphql
      .mockRejectedValueOnce(new Error("feedback already exists")) // CREATE_VOTE
      .mockResolvedValueOnce({ updateTripPlanItemFeedback: {} }); // UPDATE_VOTE
    await run(["vote", "item-1", "--up", "--json"]);
    expect(mockGraphql).toHaveBeenCalledTimes(2);
    const [, updateVars] = mockGraphql.mock.calls[1] as [string, any];
    expect(updateVars).toEqual({ itemId: "item-1", feedbackType: "Upvote" });
    expect(JSON.parse(writes.join(""))).toMatchObject({ action: "upvote" });
  });

  it("rethrows a non-conflict create error as API_ERROR", async () => {
    mockGraphql.mockRejectedValueOnce(new Error("permission denied"));
    await expect(run(["vote", "item-1", "--up", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
    });
    expect(mockGraphql).toHaveBeenCalledTimes(1); // no update fallback attempted
  });

  it("rejects specifying more than one of --up/--down/--remove", async () => {
    await expect(run(["vote", "item-1", "--up", "--down", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("requires a direction when none of --up/--down/--remove is given", async () => {
    await expect(run(["vote", "item-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
  });
});
