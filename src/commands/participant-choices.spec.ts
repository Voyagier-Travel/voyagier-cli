import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";

// ── Mocks (declared before dynamic imports) ─────────────────────────────────

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

// ── Dynamic import after mocks ──────────────────────────────────────────────

let registerParticipantChoicesCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./participant-choices.js");
  registerParticipantChoicesCommands = mod.registerParticipantChoicesCommands;
});

const PLAN_ID = "pl_01HX";
const SEL_ID = "sel_01HX";

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerParticipantChoicesCommands(program);
  await program.parseAsync(["node", "voyagier", ...args]);
}

let stderrSpy: ReturnType<typeof jest.spyOn>;
let stdoutSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ── choices-view ─────────────────────────────────────────────────────────────
describe("choices-view", () => {
  const rows = [
    { id: "pc1", selectionId: "s1", selectionType: "HotelRoom", isActiveBranch: true, optionId: null },
    { id: "pc2", selectionId: "s2", selectionType: "Flight", isActiveBranch: false, optionId: "o9" },
  ];

  it("queries tripPlanChoicesView by plan id and returns the rows", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanChoicesView: rows });
    await run(["choices-view", PLAN_ID, "--json"]);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { tripPlanId: PLAN_ID });
    expect(mockJsonOutput).toHaveBeenCalledWith({ ok: true, choices: rows, total: 2 });
  });

  it("normalises a null view to an empty list", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanChoicesView: null });
    await run(["choices-view", PLAN_ID, "--json"]);
    expect(mockJsonOutput).toHaveBeenCalledWith({ ok: true, choices: [], total: 0 });
  });

  it("rejects an empty plan id before hitting the API", async () => {
    await expect(run(["choices-view", "null", "--json"])).rejects.toThrow(/Invalid planId/);
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});

// ── choose-room-slot ──────────────────────────────────────────────────────────
describe("choose-room-slot", () => {
  it("sends only the selection id when no scope/slot flags are given", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertParticipantChoice: { id: SEL_ID } });
    await run(["choose-room-slot", SEL_ID, "--json"]);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { selectionId: SEL_ID });
    expect(mockJsonOutput).toHaveBeenCalledWith({ ok: true, selectionId: SEL_ID });
  });

  it("forwards every provided variable, mapping --travellers to a string array", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertParticipantChoice: { id: SEL_ID } });
    await run([
      "choose-room-slot", SEL_ID,
      "--option-id", "o1",
      "--travellers", "t1, t2",
      "--participant-choice-id", "pc1",
      "--replace-existing",
      "--create-new-choice",
      "--json",
    ]);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), {
      selectionId: SEL_ID,
      optionId: "o1",
      travellerIds: ["t1", "t2"],
      participantChoiceId: "pc1",
      replaceExisting: true,
      createNewChoice: true,
    });
  });

  it("maps --for-all and --group without sending unset optionals as null", async () => {
    mockGraphql.mockResolvedValueOnce({ upsertParticipantChoice: { id: SEL_ID } });
    await run(["choose-room-slot", SEL_ID, "--for-all", "--group", "g1", "--json"]);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), {
      selectionId: SEL_ID,
      forAll: true,
      groupId: "g1",
    });
  });

  it("rejects an empty --travellers list", async () => {
    await expect(run(["choose-room-slot", SEL_ID, "--travellers", " , ", "--json"])).rejects.toThrow(
      /--travellers requires/,
    );
    expect(mockGraphql).not.toHaveBeenCalled();
  });
});
