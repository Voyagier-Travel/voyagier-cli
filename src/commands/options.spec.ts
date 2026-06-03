import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";

// options/pick are RETIRED stubs (VOY-1414) — they perform no API calls and
// only emit a migration message pointing at selection-options / select.

const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

let registerOptionsCommands: (program: Command) => void;

beforeAll(async () => {
  const mod = await import("./options.js");
  registerOptionsCommands = mod.registerOptionsCommands;
});

let stdout: string;
let writeSpy: ReturnType<typeof jest.spyOn>;
let logSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockJsonOutput.mockClear();
  stdout = "";
  writeSpy = jest.spyOn(process.stdout, "write").mockImplementation((c: any) => {
    stdout += typeof c === "string" ? c : c.toString();
    return true;
  });
  logSpy = jest.spyOn(console, "log").mockImplementation((...a: any[]) => {
    stdout += a.join(" ") + "\n";
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  logSpy.mockRestore();
});

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerOptionsCommands(program);
  await program.parseAsync(["node", "voyagier", ...args]);
}

describe("options/pick retirement (VOY-1414)", () => {
  it("options <planId> --json reports retired + replacement commands", async () => {
    await run(["options", "plan-123", "--json"]);
    const out = mockJsonOutput.mock.calls[0][0] as any;
    expect(out.retired).toBe(true);
    expect(out.replacement.readOptions).toMatch(/selection-options/);
  });

  it("pick <number> --json reports retired + replacement commands", async () => {
    await run(["pick", "1", "--json"]);
    const out = mockJsonOutput.mock.calls[0][0] as any;
    expect(out.retired).toBe(true);
    expect(out.replacement.chooseOption).toMatch(/select --selection-id/);
  });

  it("human output mentions the replacement", async () => {
    await run(["options", "plan-123"]);
    expect(stdout).toMatch(/retired/i);
    expect(stdout).toMatch(/selection-options/);
  });
});
