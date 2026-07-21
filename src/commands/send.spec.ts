/**
 * Behavioral specs for `voyagier send` — VOY-1212 self-serve close.
 *
 * The safety rail is the point of this suite: `send` emails a REAL client and
 * the mutation is not idempotent, so non-interactive runs must refuse without
 * --yes and NOTHING may be sent when confirmation is missing or declined.
 */
import { jest } from "@jest/globals";
import { Command } from "commander";
import { CliErrorCode } from "../errors.js";

const mockGraphql = jest.fn<(query: string, vars?: Record<string, unknown>) => Promise<unknown>>();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  AuthError: class AuthError extends Error {},
}));

const mockQuestion = jest.fn<() => Promise<string>>();
jest.unstable_mockModule("readline/promises", () => ({
  createInterface: () => ({ question: mockQuestion, close: () => undefined }),
}));

let registerSendCommand: (program: Command) => void;

beforeAll(async () => {
  registerSendCommand = (await import("./send.js")).registerSendCommand;
});

let writes: string[];
let stdoutSpy: ReturnType<typeof jest.spyOn>;
let logSpy: ReturnType<typeof jest.spyOn>;
const originalIsTTY = process.stdin.isTTY;
const originalCI = process.env.CI;

beforeEach(() => {
  mockGraphql.mockReset();
  mockQuestion.mockReset();
  writes = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  logSpy = jest.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
    writes.push(args.join(" ") + "\n");
  }) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  logSpy.mockRestore();
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
});

function setInteractive(interactive: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true });
  if (interactive) delete process.env.CI;
  else process.env.CI = "1";
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PLAN_WITH_CLIENT = {
  tripPlan: { id: "plan-1", title: "BWI Getaway", client: { id: "cl-1", name: "Ada Client", email: "ada@example.com" } },
};
const PLAN_NO_EMAIL = {
  tripPlan: { id: "plan-1", title: "BWI Getaway", client: { id: "cl-1", name: "Ada Client", email: null } },
};
const INVITE = {
  sendTripPlanToClient: {
    id: "inv-1", email: "ada@example.com", status: "Pending", invitedUserId: null,
    expiresAt: "2026-08-20T00:00:00Z",
  },
};

function routeSend(overrides: { plan?: unknown; invite?: unknown } = {}) {
  mockGraphql.mockImplementation(async (query: string) => {
    if (query.includes("TripPlanClientCheck")) return overrides.plan ?? PLAN_WITH_CLIENT;
    if (query.includes("SendTripPlanToClient")) return overrides.invite ?? INVITE;
    throw new Error(`unrouted query: ${query.slice(0, 120)}`);
  });
}

function sendVars(): Record<string, unknown> | undefined {
  const call = mockGraphql.mock.calls.find(([q]) => (q as string).includes("SendTripPlanToClient"));
  return call?.[1] as Record<string, unknown> | undefined;
}

async function runSend(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSendCommand(program);
  await program.parseAsync(["node", "voyagier", "send", ...args]);
}

// ── Confirmation rail ───────────────────────────────────────────────────────

describe("send confirmation rail", () => {
  it("non-interactive without --yes → CONFIRMATION_REQUIRED and NOTHING is sent", async () => {
    setInteractive(false);
    routeSend();
    await expect(runSend(["plan-1", "--json"])).rejects.toMatchObject({
      code: CliErrorCode.CONFIRMATION_REQUIRED,
      details: { recipient: "ada@example.com", planId: "plan-1" },
    });
    expect(sendVars()).toBeUndefined();
  });

  it("non-interactive with --yes → sends", async () => {
    setInteractive(false);
    routeSend();
    await runSend(["plan-1", "--yes", "--json"]);
    expect(sendVars()).toEqual({ tripPlanId: "plan-1" });
  });

  it("interactive prompt shows the real recipient; 'y' proceeds", async () => {
    setInteractive(true);
    routeSend();
    mockQuestion.mockResolvedValue("y");
    await runSend(["plan-1", "--json"]);
    expect(mockQuestion.mock.calls[0][0] as unknown as string).toContain("ada@example.com");
    expect(sendVars()).toBeDefined();
  });

  it("interactive decline → aborts, NOTHING sent, no error", async () => {
    setInteractive(true);
    routeSend();
    mockQuestion.mockResolvedValue("n");
    await runSend(["plan-1"]);
    expect(sendVars()).toBeUndefined();
    expect(writes.join("")).toContain("Nothing sent");
  });
});

// ── Pre-checks (fail fast BEFORE prompt/mutation) ───────────────────────────

describe("send pre-checks", () => {
  it("plan not found → NOT_FOUND, nothing sent", async () => {
    routeSend({ plan: { tripPlan: null } });
    await expect(runSend(["plan-1", "--yes"])).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
    expect(sendVars()).toBeUndefined();
  });

  it("no client email on plan → VALIDATION with fix hint, nothing sent (even with --yes)", async () => {
    routeSend({ plan: PLAN_NO_EMAIL });
    await expect(runSend(["plan-1", "--yes"])).rejects.toMatchObject({ code: CliErrorCode.VALIDATION });
    expect(sendVars()).toBeUndefined();
  });

  it("note over 2000 chars → VALIDATION before any network call", async () => {
    routeSend();
    await expect(runSend(["plan-1", "--yes", "--note", "x".repeat(2001)])).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

// ── Happy paths ─────────────────────────────────────────────────────────────

describe("send output", () => {
  it("--json envelope carries the invite and nextStep; --note forwarded in input", async () => {
    setInteractive(false);
    routeSend();
    await runSend(["plan-1", "--yes", "--note", "Can't wait!", "--json"]);
    expect(sendVars()).toEqual({ tripPlanId: "plan-1", input: { note: "Can't wait!" } });
    const raw = writes.filter((w) => w.trimStart().startsWith("{")).at(-1);
    const out = JSON.parse(raw!);
    expect(out.ok).toBe(true);
    expect(out.data.invite).toEqual({
      id: "inv-1", email: "ada@example.com", status: "Pending", invitedUserId: null, expiresAt: "2026-08-20T00:00:00Z",
    });
    expect(out.data.nextStep).toBe("voyagier plan-status plan-1");
  });

  it("agent mode reports recipient, claim state, and nextStep", async () => {
    setInteractive(false);
    routeSend();
    await runSend(["plan-1", "--yes", "--agent"]);
    const out = writes.join("");
    expect(out).toContain("Invite sent");
    expect(out).toContain("ada@example.com");
    expect(out).toContain("claimed when the client signs up");
    expect(out).toContain("voyagier plan-status plan-1");
  });

  it("human mode distinguishes an already-registered client (immediate access)", async () => {
    setInteractive(false);
    routeSend({ invite: { sendTripPlanToClient: { ...INVITE.sendTripPlanToClient, invitedUserId: "u-9" } } });
    await runSend(["plan-1", "--yes"]);
    expect(writes.join("")).toContain("access granted immediately");
  });
});
