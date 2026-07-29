/**
 * Specs for the shared interactive-prompt helpers (VOY-1762).
 *
 * The invariant under test: prompts only ever engage for a human at a TTY, and
 * prompt output goes to stderr (never stdout) so a --json/pipe consumer of
 * stdout is never polluted with prompt text.
 */
import { jest } from "@jest/globals";
import { CliError, CliErrorCode } from "./errors.js";

const mockQuestion = jest.fn<() => Promise<string>>();
const mockClose = jest.fn();
jest.unstable_mockModule("readline/promises", () => ({
  createInterface: () => ({ question: mockQuestion, close: mockClose }),
}));

let isInteractive: typeof import("./prompt.js").isInteractive;
let promptText: typeof import("./prompt.js").promptText;
let promptPick: typeof import("./prompt.js").promptPick;

beforeAll(async () => {
  const mod = await import("./prompt.js");
  isInteractive = mod.isInteractive;
  promptText = mod.promptText;
  promptPick = mod.promptPick;
});

const originalIsTTY = process.stdin.isTTY;
const originalCI = process.env.CI;

let stdoutSpy: ReturnType<typeof jest.spyOn>;
let stderrSpy: ReturnType<typeof jest.spyOn>;
let stdoutWrites: string[];
let stderrWrites: string[];

beforeEach(() => {
  mockQuestion.mockReset();
  mockClose.mockReset();
  stdoutWrites = [];
  stderrWrites = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as never);
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
});

function setTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  delete process.env.CI;
}

describe("isInteractive", () => {
  it("true only when TTY, not CI, and no machine/no-input mode", () => {
    setTTY(true);
    expect(isInteractive({})).toBe(true);
  });

  it("false when stdin is not a TTY", () => {
    setTTY(false);
    expect(isInteractive({})).toBe(false);
  });

  it("false in CI even on a TTY", () => {
    setTTY(true);
    process.env.CI = "1";
    expect(isInteractive({})).toBe(false);
  });

  it("false under --json / --agent", () => {
    setTTY(true);
    expect(isInteractive({ json: true })).toBe(false);
    expect(isInteractive({ agent: true })).toBe(false);
  });

  it("false under --no-input (opts.noInput or commander's opts.input === false)", () => {
    setTTY(true);
    expect(isInteractive({ noInput: true })).toBe(false);
    // commander materializes `--no-input` as input:false
    expect(isInteractive({ input: false })).toBe(false);
    // input:true (the default when --no-input is absent) does NOT disable prompts
    expect(isInteractive({ input: true })).toBe(true);
  });
});

describe("promptText", () => {
  it("returns the trimmed answer", async () => {
    setTTY(true);
    mockQuestion.mockResolvedValueOnce("  2026-08-01  ");
    const answer = await promptText("Date: ");
    expect(answer).toBe("2026-08-01");
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns the default on an empty answer", async () => {
    setTTY(true);
    mockQuestion.mockResolvedValueOnce("   ");
    const answer = await promptText("Title: ", { default: "Trip · Aug 2026" });
    expect(answer).toBe("Trip · Aug 2026");
  });

  it("never writes to stdout", async () => {
    setTTY(true);
    mockQuestion.mockResolvedValueOnce("hi");
    await promptText("Q: ");
    expect(stdoutWrites.join("")).toBe("");
  });
});

describe("promptPick", () => {
  const items = [{ name: "Alice" }, { name: "Bob" }];
  const render = (c: { name: string }) => c.name;
  const giveUp = new CliError(CliErrorCode.MULTIPLE_CLIENTS, "ambiguous");

  it("returns the chosen 1-based item and renders the list to stderr only", async () => {
    setTTY(true);
    mockQuestion.mockResolvedValueOnce("2");
    const chosen = await promptPick("Pick a client:", items, render, giveUp);
    expect(chosen).toEqual({ name: "Bob" });
    const err = stderrWrites.join("");
    expect(err).toContain("[1] Alice");
    expect(err).toContain("[2] Bob");
    expect(stdoutWrites.join("")).toBe("");
    expect(mockClose).toHaveBeenCalled();
  });

  it("re-asks on invalid input then succeeds", async () => {
    setTTY(true);
    mockQuestion
      .mockResolvedValueOnce("nope")
      .mockResolvedValueOnce("9")
      .mockResolvedValueOnce("1");
    const chosen = await promptPick("Pick:", items, render, giveUp);
    expect(chosen).toEqual({ name: "Alice" });
  });

  it("throws the caller's original CliError after 2 failed re-asks", async () => {
    setTTY(true);
    mockQuestion
      .mockResolvedValueOnce("x")
      .mockResolvedValueOnce("y")
      .mockResolvedValueOnce("z");
    await expect(promptPick("Pick:", items, render, giveUp)).rejects.toBe(giveUp);
    expect(mockClose).toHaveBeenCalled();
  });
});
