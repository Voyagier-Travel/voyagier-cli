import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";

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

let registerTravellerChoicesCommands: (program: Command) => void;
let summarizeChoices: (result: unknown) => string;
let buildNextStepCommand: (q: unknown, planId: string, allIds: string[]) => { command: string; note: string } | null;
let filterQuestions: (questions: unknown[], filters: Record<string, unknown>) => unknown[];

beforeAll(async () => {
  const mod = await import("./traveller-choices.js");
  registerTravellerChoicesCommands = mod.registerTravellerChoicesCommands;
  summarizeChoices = mod.summarizeChoices as (result: unknown) => string;
  buildNextStepCommand = mod.buildNextStepCommand as (q: unknown, planId: string, allIds: string[]) => { command: string; note: string };
  filterQuestions = mod.filterQuestions as (questions: unknown[], filters: Record<string, unknown>) => unknown[];
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const t1 = { id: "t1", firstName: "Daniel", lastName: "Gardner" };
const t2 = { id: "t2", firstName: "Child", lastName: "A" };

const qFlight = {
  selectionId: "sel_01",
  selectionType: "FlightClass",
  title: "Cabin class for outbound flight",
  goalId: "goal_01",
  groupName: "Outbound",
  questionTemplate: "Which cabin for {{traveller}}?",
  options: [
    { id: "opt_01", name: "Economy", isBookable: true },
    { id: "opt_02", name: "Business", isBookable: true },
  ],
  inputs: [],
  answeredTravellers: [t1],
  pendingTravellers: [t2],
};

const qHotel = {
  selectionId: "sel_02",
  selectionType: "HotelRoom",
  title: "Room type",
  goalId: "goal_02",
  groupName: null,
  questionTemplate: null,
  options: [{ id: "opt_03", name: "Standard", isBookable: true }],
  inputs: [],
  answeredTravellers: [],
  pendingTravellers: [t1, t2],
};

const baseResult = {
  title: "Paris Family Trip",
  startDate: "2026-07-15",
  endDate: "2026-07-22",
  numberOfDays: 8,
  numberOfNights: 7,
  travellers: [t1, t2],
  questions: [qFlight, qHotel],
};

const emptyResult = {
  title: "Empty Plan",
  startDate: null,
  endDate: null,
  numberOfDays: null,
  numberOfNights: null,
  travellers: [t1, t2],
  questions: [],
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
  registerTravellerChoicesCommands(p);
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

describe("traveller-choices list", () => {
  it("returns empty questions array for a plan with no choices", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: emptyResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as { data: { total: number; questions: unknown[] } };
    expect(out.data.total).toBe(0);
    expect(out.data.questions).toHaveLength(0);
  });

  it("returns multi-question results with planContext", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as {
      ok: boolean;
      data: { total: number; pending: number; questions: unknown[] };
      planContext: { planId: string; travellerCount: number };
    };
    expect(out.ok).toBe(true);
    expect(out.data.total).toBe(2);
    expect(out.data.pending).toBe(2); // both questions have pending travellers
    expect(out.planContext.planId).toBe("plan_01");
    expect(out.planContext.travellerCount).toBe(2);
  });

  it("includes option names (not labels) in output — see SECTION6-DISCOVERIES.md", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as { data: { questions: { options: { name: string }[] }[] } };
    expect(out.data.questions[0].options[0].name).toBe("Economy");
    expect(out.data.questions[0].options[0]).not.toHaveProperty("label");
  });

  it("filters with --pending: only returns questions with pending travellers", async () => {
    const allAnswered = {
      ...qFlight,
      selectionId: "sel_done",
      answeredTravellers: [t1, t2],
      pendingTravellers: [],
    };
    mockGraphql.mockResolvedValueOnce({
      travellerChoices: { ...baseResult, questions: [allAnswered, qHotel] },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--pending", "--json",
    ]);

    const out = lastJson() as { data: { questions: { selectionId: string }[] } };
    expect(out.data.questions).toHaveLength(1);
    expect(out.data.questions[0].selectionId).toBe("sel_02");
  });

  it("filters with --traveller: only returns questions where traveller is pending", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--traveller", "t2", "--json",
    ]);

    // qFlight: t2 is pending → included
    // qHotel: t2 is pending → included
    const out = lastJson() as { data: { questions: { selectionId: string }[] } };
    expect(out.data.questions.map((q) => q.selectionId).sort()).toEqual(["sel_01", "sel_02"]);
  });

  it("filters with --goal: only returns questions matching the goalId", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--goal", "goal_01", "--json",
    ]);

    const out = lastJson() as { data: { questions: { selectionId: string }[] } };
    expect(out.data.questions).toHaveLength(1);
    expect(out.data.questions[0].selectionId).toBe("sel_01");
  });

  it("filters with --type: case-insensitive selectionType match", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--type", "flightclass", "--json",
    ]);

    const out = lastJson() as { data: { questions: { selectionType: string }[] } };
    expect(out.data.questions).toHaveLength(1);
    expect(out.data.questions[0].selectionType).toBe("FlightClass");
  });

  it("combined --pending + --goal filters both conditions", async () => {
    const answered = {
      ...qFlight,
      selectionId: "sel_answered",
      goalId: "goal_01",
      answeredTravellers: [t1, t2],
      pendingTravellers: [],
    };
    mockGraphql.mockResolvedValueOnce({
      travellerChoices: { ...baseResult, questions: [answered, qFlight, qHotel] },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list",
      "--plan", "plan_01", "--pending", "--goal", "goal_01", "--json",
    ]);

    // Only qFlight passes: goalId=goal_01 AND pending (t2 is pending)
    const out = lastJson() as { data: { questions: { selectionId: string }[] } };
    expect(out.data.questions).toHaveLength(1);
    expect(out.data.questions[0].selectionId).toBe("sel_01");
  });

  it("--type filter returns empty when no match", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--type", "Activity", "--json",
    ]);

    const out = lastJson() as { data: { questions: unknown[] } };
    expect(out.data.questions).toHaveLength(0);
  });

  it("--traveller filter returns empty when traveller has answered all", async () => {
    const allAnswered = { ...qFlight, answeredTravellers: [t1, t2], pendingTravellers: [] };
    mockGraphql.mockResolvedValueOnce({
      travellerChoices: { ...baseResult, questions: [allAnswered] },
    });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--traveller", "t2", "--json",
    ]);

    const out = lastJson() as { data: { questions: unknown[] } };
    expect(out.data.questions).toHaveLength(0);
  });
});

describe("nextStep.command formatting", () => {
  it("returns null for a completed question (no pending travellers)", () => {
    const q = { ...qFlight, pendingTravellers: [] };
    const result = buildNextStepCommand(q, "plan_01", ["t1", "t2"]);
    expect(result).toBeNull();
  });

  it("scope=all when all travellers are pending", () => {
    const q = { ...qHotel, pendingTravellers: [t1, t2] };
    const result = buildNextStepCommand(q, "plan_01", ["t1", "t2"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe(
      "voyagier select --selection sel_02 --plan plan_01 --scope all --experimental",
    );
    expect(result!.note).toContain("Section 5");
  });

  it("scope=individual when exactly one traveller is pending", () => {
    const q = { ...qFlight, pendingTravellers: [t2] };
    const result = buildNextStepCommand(q, "plan_01", ["t1", "t2"]);
    expect(result!.command).toBe(
      "voyagier select --selection sel_01 --plan plan_01 --participants t2 --scope individual --experimental",
    );
  });

  it("scope=subset when multiple but not all travellers are pending", () => {
    const t3 = { id: "t3", firstName: "Child", lastName: "B" };
    const q = { ...qHotel, pendingTravellers: [t2, t3] };
    const result = buildNextStepCommand(q, "plan_01", ["t1", "t2", "t3"]);
    expect(result!.command).toContain("--scope subset");
    expect(result!.command).toContain("--participants t2,t3");
    expect(result!.command).toContain("--experimental");
    expect(result!.command).toContain("--selection sel_02");
  });

  it("nextStep is included in --json output for pending questions", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as { data: { questions: { nextStep: { command: string } }[] } };
    expect(out.data.questions[0].nextStep).toBeDefined();
    expect(out.data.questions[0].nextStep).not.toBeNull();
    expect(out.data.questions[0].nextStep.command).toMatch(/voyagier select/);
    expect(out.data.questions[0].nextStep.command).toContain("--experimental");
    expect(out.data.questions[0].nextStep.command).toContain("--selection");
  });

  it("nextStep is null in --json output for a completed question", async () => {
    const allAnswered = { ...qFlight, answeredTravellers: [t1, t2], pendingTravellers: [] };
    const result = { ...baseResult, questions: [allAnswered] };
    mockGraphql.mockResolvedValueOnce({ travellerChoices: result });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01", "--json"]);

    const out = lastJson() as { data: { questions: { nextStep: unknown }[] } };
    expect(out.data.questions[0].nextStep).toBeNull();
  });
});

describe("summarizeChoices", () => {
  it("0 questions → 'No questions on this plan yet.'", () => {
    const result = { ...emptyResult, questions: [] };
    expect(summarizeChoices(result)).toBe("No questions on this plan yet.");
  });

  it("N questions, 0 pending → 'All N questions answered.'", () => {
    const answered = { ...qFlight, answeredTravellers: [t1, t2], pendingTravellers: [] };
    const result = { ...baseResult, questions: [answered, { ...answered, selectionId: "sel_x" }] };
    expect(summarizeChoices(result)).toBe("All 2 questions answered.");
  });

  it("N questions, all pending → 'N of N questions pending across M travellers.'", () => {
    const result = { ...baseResult, questions: [qHotel] };
    // qHotel has 2 pending travellers
    expect(summarizeChoices(result)).toBe("1 of 1 question pending across 2 travellers.");
  });

  it("partial: some questions pending → correct counts", () => {
    const answered = { ...qFlight, answeredTravellers: [t1, t2], pendingTravellers: [] };
    const result = { ...baseResult, questions: [answered, qHotel] };
    // 1 of 2 questions pending, qHotel has t1 and t2 pending
    expect(summarizeChoices(result)).toBe("1 of 2 questions pending across 2 travellers.");
  });

  it("singular form for 1 question", () => {
    const result = { ...baseResult, questions: [qFlight] };
    expect(summarizeChoices(result)).toBe("1 of 1 question pending across 1 traveller.");
  });
});

describe("filterQuestions", () => {
  it("no filters returns all questions", () => {
    const out = filterQuestions([qFlight, qHotel], {});
    expect(out).toHaveLength(2);
  });

  it("pending filter removes fully-answered questions", () => {
    const done = { ...qFlight, answeredTravellers: [t1, t2], pendingTravellers: [] };
    const out = filterQuestions([done, qHotel], { pending: true });
    expect(out).toHaveLength(1);
    expect((out[0] as { selectionId: string }).selectionId).toBe("sel_02");
  });

  it("travellerId filter matches by pendingTravellers id", () => {
    const out = filterQuestions([qFlight, qHotel], { travellerId: "t1" });
    // qFlight: t2 pending (t1 answered) — NOT included
    // qHotel: t1 + t2 pending — included
    expect(out).toHaveLength(1);
    expect((out[0] as { selectionId: string }).selectionId).toBe("sel_02");
  });

  it("goalId filter is exact match", () => {
    const out = filterQuestions([qFlight, qHotel], { goalId: "goal_02" });
    expect(out).toHaveLength(1);
    expect((out[0] as { selectionId: string }).selectionId).toBe("sel_02");
  });

  it("selectionType filter is case-insensitive", () => {
    const out = filterQuestions([qFlight, qHotel], { selectionType: "HOTELROOM" });
    expect(out).toHaveLength(1);
    expect((out[0] as { selectionType: string }).selectionType).toBe("HotelRoom");
  });

  it("combined filters are ANDed", () => {
    const out = filterQuestions([qFlight, qHotel], { pending: true, goalId: "goal_01" });
    // qFlight: goalId=goal_01, t2 pending → passes
    // qHotel: goalId=goal_02 → fails goal filter
    expect(out).toHaveLength(1);
    expect((out[0] as { selectionId: string }).selectionId).toBe("sel_01");
  });
});

describe("traveller-choices list — human output", () => {
  it("empty plan: no questions at all → prints 'No choice questions on this plan yet.'", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: emptyResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("No choice questions on this plan yet.");
  });

  it("filter excludes everything → prints 'No questions match your filters. (N total)'", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "traveller-choices", "list", "--plan", "plan_01", "--type", "Activity",
    ]);

    const output = writes.join("");
    expect(output).toContain("No questions match your filters.");
    expect(output).toContain("2 total");
  });

  it("multi-question: [1]/[2] indexing, pending badges, Selection/Goal/Options/Pending/Answered lines", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    // Index labels
    expect(output).toContain("[1]");
    expect(output).toContain("[2]");
    // Pending badges
    expect(output).toContain("1 pending");          // qFlight: t2 pending
    expect(output).toContain("2 pending");          // qHotel: t1+t2 pending
    // Detail lines
    expect(output).toContain("Selection: sel_01");
    expect(output).toContain("Goal: goal_01");
    expect(output).toContain("Options: Economy, Business");
    expect(output).toContain("Pending: Child A");
    expect(output).toContain("Answered: Daniel Gardner");
    // Footer
    expect(output).toContain("2 questions shown");
    expect(output).toContain("2 with pending travellers");
  });

  it("goalId present → Goal: line shown; goalId null → Goal: line omitted; options empty → Options: line omitted", async () => {
    const qNoGoalNoOpts = { ...qHotel, goalId: null, options: [] };
    const result = { ...baseResult, questions: [qFlight, qNoGoalNoOpts] };
    mockGraphql.mockResolvedValueOnce({ travellerChoices: result });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("Goal: goal_01");            // qFlight has goalId
    const goalLines = output.match(/Goal:/g) ?? [];
    expect(goalLines).toHaveLength(1);                    // no Goal: line for null goalId
    // Options line omitted when options array is empty
    const optionLines = output.match(/Options:/g) ?? [];
    expect(optionLines).toHaveLength(1);                  // only qFlight has options
  });

  it("footer: all questions answered → 'done' badge, no 'with pending travellers' line", async () => {
    const answered = { ...qFlight, answeredTravellers: [t1, t2], pendingTravellers: [] };
    const result = { ...baseResult, questions: [answered] };
    mockGraphql.mockResolvedValueOnce({ travellerChoices: result });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("done");
    expect(output).toContain("1 question shown");
    expect(output).not.toContain("with pending travellers");
  });

  it("dates: both startDate and endDate present → date range line rendered", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: baseResult });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("2026-07-15");
    expect(output).toContain("2026-07-22");
  });

  it("dates: startDate present, endDate null → shows ? for missing end", async () => {
    const result = { ...baseResult, startDate: "2026-07-15", endDate: null, questions: [] };
    mockGraphql.mockResolvedValueOnce({ travellerChoices: result });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).toContain("2026-07-15");
    expect(output).toContain("?");
  });

  it("dates: both null → no date range line (no → separator in output)", async () => {
    mockGraphql.mockResolvedValueOnce({ travellerChoices: emptyResult }); // startDate: null, endDate: null

    const p = buildProgram();
    await p.parseAsync(["node", "test", "traveller-choices", "list", "--plan", "plan_01"]);

    const output = writes.join("");
    expect(output).not.toContain("→");
  });
});
