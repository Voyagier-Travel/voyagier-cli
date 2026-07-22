/**
 * Spinner contract tests (VOY: loading-spinner).
 *
 * The spinner has two modes gated on isTTY && !CI:
 *   - Interactive TTY: animated braille frames + elapsed suffix, redrawn in
 *     place with ANSI cursor control. Exercised with fake timers.
 *   - Non-TTY / CI: a single plain (dim) line per DISTINCT label, no ANSI —
 *     the pre-spinner behaviour agents and CI logs depend on.
 *
 * chalk.level is pinned to 0 so the "no ANSI escapes" assertions don't depend
 * on the ambient FORCE_COLOR of whatever runs the suite.
 */
import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from "@jest/globals";
import chalk from "chalk";
import { spinnerAnimates, startSpinner } from "./spinner.js";

beforeAll(() => {
  chalk.level = 0;
});

function makeStream(isTTY: boolean): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

// The animation gate reads process.env.CI; neutralise the ambient value so the
// TTY tests actually animate, and restore it afterwards.
let savedCI: string | undefined;
beforeEach(() => {
  savedCI = process.env.CI;
  delete process.env.CI;
});
afterEach(() => {
  jest.useRealTimers();
  if (savedCI === undefined) delete process.env.CI;
  else process.env.CI = savedCI;
});

describe("startSpinner — interactive TTY", () => {
  it("animates through braille frames redrawn in place", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });

    // Initial synchronous render uses the first frame.
    expect(writes.join("")).toContain("⠋ Searching flights…");
    // Each frame redraw clears the line first.
    expect(writes.join("")).toContain("\r\x1b[2K");

    jest.advanceTimersByTime(120);
    expect(writes.join("")).toContain("⠙ Searching flights…");
    jest.advanceTimersByTime(120);
    expect(writes.join("")).toContain("⠹ Searching flights…");

    spinner.stop();
  });

  it("appends the elapsed suffix only after 3s have passed", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });

    // Before 3s: no elapsed suffix.
    jest.advanceTimersByTime(2000);
    expect(writes.join("")).not.toMatch(/\(\d+s\)/);

    // After 3s: suffix appears and tracks elapsed seconds.
    jest.advanceTimersByTime(1200);
    expect(writes.join("")).toContain("(3s)");

    spinner.stop();
  });

  it("update() swaps the label mid-flight", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Resolving travellers…", { stream });

    spinner.update("Searching flights…");
    expect(writes.join("")).toContain("⠋ Searching flights…");

    spinner.stop();
  });

  it("stop() clears the line and writes finalLine with a trailing newline", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });

    spinner.stop("✓ Done");
    const out = writes.join("");
    // Last thing written: a line clear followed by the final line + newline.
    expect(out).toContain("\r\x1b[2K");
    expect(out.endsWith("✓ Done\n")).toBe(true);
  });

  it("stop() with no finalLine leaves the line cleared and writes nothing else", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });
    const before = writes.length;
    spinner.stop();
    // Exactly one more write (the clear); no stray final line.
    expect(writes.length).toBe(before + 1);
    expect(writes[writes.length - 1]).toBe("\r\x1b[2K");
  });

  it("is safe to stop twice (idempotent)", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });
    spinner.stop("done");
    const after = writes.length;
    expect(() => spinner.stop("again")).not.toThrow();
    // Second stop is a no-op — no additional writes.
    expect(writes.length).toBe(after);
  });

  it("update()/stop() after stop() do nothing", () => {
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });
    spinner.stop();
    const after = writes.length;
    spinner.update("late");
    expect(writes.length).toBe(after);
  });

  it("unref()s the animation interval so it can never keep the process alive", () => {
    // Isolate from fake timers: spy on the real setInterval to capture the
    // Timeout and assert unref() was invoked on it.
    jest.useRealTimers();
    const unref = jest.fn();
    const fakeTimer = { unref, ref: jest.fn() } as unknown as NodeJS.Timeout;
    const spy = jest.spyOn(global, "setInterval").mockReturnValue(fakeTimer);
    try {
      const { stream } = makeStream(true);
      const spinner = startSpinner("Searching flights…", { stream });
      expect(unref).toHaveBeenCalledTimes(1);
      spinner.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("startSpinner — non-TTY / CI fallback", () => {
  it("writes the label once as a plain line, no ANSI, no animation", () => {
    const { stream, writes } = makeStream(false);
    const spinner = startSpinner("Searching flights…", { stream });
    const out = writes.join("");
    expect(out).toBe("Searching flights…\n");
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).not.toContain("⠋");
    spinner.stop();
  });

  it("dedupes a repeated update() label but lets a distinct label through", () => {
    const { stream, writes } = makeStream(false);
    const spinner = startSpinner("Fetching options… (attempt 1)", { stream });
    spinner.update("Fetching options… (attempt 1)"); // same → deduped
    spinner.update("Fetching options… (attempt 2)"); // distinct → written
    const out = writes.join("");
    expect(out).toBe("Fetching options… (attempt 1)\nFetching options… (attempt 2)\n");
    expect(out).not.toMatch(/\x1b\[/);
    spinner.stop();
  });

  it("stop(finalLine) writes the final line; bare stop() writes nothing", () => {
    const { stream, writes } = makeStream(false);
    const spinner = startSpinner("Searching…", { stream });
    const afterStart = writes.length;
    spinner.stop("✓ 5 options found");
    expect(writes[writes.length - 1]).toBe("✓ 5 options found\n");

    const second = makeStream(false);
    const s2 = startSpinner("Searching…", { stream: second.stream });
    const n = second.writes.length;
    s2.stop();
    expect(second.writes.length).toBe(n);
    // sanity: afterStart captured the single label line
    expect(afterStart).toBe(1);
  });

  it("CI env forces the non-TTY fallback even when isTTY is true", () => {
    process.env.CI = "1";
    jest.useFakeTimers();
    const { stream, writes } = makeStream(true);
    const spinner = startSpinner("Searching flights…", { stream });

    // No interval-driven frames even after advancing time.
    jest.advanceTimersByTime(1000);
    const out = writes.join("");
    expect(out).toBe("Searching flights…\n");
    expect(out).not.toContain("⠋");
    expect(out).not.toMatch(/\x1b\[/);
    spinner.stop();
  });

  it("spinnerAnimates mirrors the animation gate (TTY yes; non-TTY no; CI no)", () => {
    const tty = makeStream(true).stream;
    const pipe = makeStream(false).stream;
    expect(spinnerAnimates(tty)).toBe(true);
    expect(spinnerAnimates(pipe)).toBe(false);
    process.env.CI = "1";
    expect(spinnerAnimates(tty)).toBe(false);
  });
});
