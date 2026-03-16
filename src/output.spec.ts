import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { jsonOutput, progress, warn, fatal } from "./output.js";
import { CliError, CliErrorCode } from "./errors.js";

describe("jsonOutput", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("writes valid JSON to stdout", () => {
    jsonOutput({ key: "value", num: 42 });
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify({ key: "value", num: 42 }, null, 2) + "\n");
  });

  it("writes null as JSON", () => {
    jsonOutput(null);
    expect(stdoutSpy).toHaveBeenCalledWith("null\n");
  });

  it("writes arrays as JSON", () => {
    jsonOutput([1, 2, 3]);
    expect(stdoutSpy).toHaveBeenCalledWith(JSON.stringify([1, 2, 3], null, 2) + "\n");
  });
});

describe("progress", () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("writes message to stderr", () => {
    progress("loading results...");
    expect(stderrSpy).toHaveBeenCalled();
    const written = String((stderrSpy.mock.calls[0] as any[])[0]);
    expect(written).toContain("loading results...");
  });
});

describe("warn", () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("writes warning to stderr", () => {
    warn("something is off");
    expect(stderrSpy).toHaveBeenCalled();
    const written = String((stderrSpy.mock.calls[0] as any[])[0]);
    expect(written).toContain("something is off");
  });

  it("includes warning indicator", () => {
    warn("check this");
    const written = String((stderrSpy.mock.calls[0] as any[])[0]);
    expect(written).toContain("⚠");
  });
});

describe("fatal", () => {
  it("throws a CliError with VALIDATION code and the given message", () => {
    expect(() => fatal("critical failure")).toThrow(CliError);
    expect(() => fatal("critical failure")).toThrow("critical failure");
  });

  it("thrown error has VALIDATION code", () => {
    let caughtCode: string | undefined;
    try {
      fatal("critical failure");
    } catch (err) {
      if (err instanceof CliError) caughtCode = err.code;
    }
    expect(caughtCode).toBe(CliErrorCode.VALIDATION);
  });
});
