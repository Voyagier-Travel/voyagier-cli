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

let registerBookableCommand: (plans: Command) => void;
beforeAll(async () => {
  registerBookableCommand = (await import("./bookable.js")).registerBookableCommand;
});

const FIXTURE = {
  tripPlan: {
    id: "plan-1", title: "Trip",
    cart: {
      itemCount: 2, total: 1840, currency: "USD",
      items: [
        { id: "ci-1", name: "Hotel", description: null, price: 1840, currency: "USD", type: "Hotel", selectionId: "sel-h", optionId: "opt-h", metadata: {} },
        { id: "ci-2", name: "Flight", description: null, price: 0, currency: "USD", type: "Flight", selectionId: "sel-f", optionId: "opt-f", metadata: {} },
      ],
    },
    goals: [
      {
        id: "g-h", name: "Hotel", sortOrder: 1,
        items: [{ id: "i", title: "H", goalId: "g-h", selections: [{ id: "sel-h", type: "Hotel", isLocked: false, options: [{ id: "opt-h", name: "King", isBookable: true, status: "ACTIVE", blueprintListingId: "bl", externalId: "blueprint:1" }] }] }],
      },
      {
        id: "g-f", name: "Flight", sortOrder: 2,
        items: [{ id: "i2", title: "F", goalId: "g-f", selections: [{ id: "sel-f", type: "Flight", isLocked: false, options: [{ id: "opt-f", name: "AF", isBookable: false, status: "ACTIVE", blueprintListingId: null, externalId: "sabre:af" }] }] }],
      },
    ],
  },
};

async function runBookable(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const plans = program.command("plans");
  registerBookableCommand(plans);
  await program.parseAsync(["node", "voyagier", "plans", "bookable", ...args]);
}

describe("voyagier plans bookable", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let stdoutOutput: string[] = [];

  beforeEach(() => {
    stdoutOutput = [];
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      stdoutOutput.push(typeof c === "string" ? c : String(c));
      return true;
    });
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockGraphql.mockReset();
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("returns counts + items + blockers as JSON envelope", async () => {
    mockGraphql.mockResolvedValueOnce(FIXTURE);
    await runBookable(["plan-1", "--json"]);
    const out = JSON.parse(stdoutOutput.join(""));
    expect(out.ok).toBe(true);
    expect(out.data.itemCount).toBe(2);
    expect(out.data.bookableCount).toBe(1);
    expect(out.data.blockedCount).toBe(1);
    expect(out.data.bookableSubtotal).toBe(1840);
    expect(out.data.blockers).toHaveLength(1);
  });

  it("emits agent markdown with fixes section", async () => {
    mockGraphql.mockResolvedValueOnce(FIXTURE);
    await runBookable(["plan-1", "--agent"]);
    const out = stdoutOutput.join("");
    expect(out).toContain("## ✅ Bookability");
    expect(out).toContain("### Fixes");
  });

  it("throws NOT_FOUND when API returns null", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlan: null });
    let err: unknown;
    try {
      await runBookable(["missing", "--json"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CliErrorCode.NOT_FOUND);
  });
});
