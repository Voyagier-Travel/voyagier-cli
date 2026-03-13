import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { jsonOutput, jsonError, progress, warn, fatal } from "./output.js";

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

describe("jsonError", () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("writes error JSON to stdout and exits with 1", () => {
    jsonError("something went wrong", "SOME_CODE");
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ error: true, message: "something went wrong", code: "SOME_CODE" }, null, 2) + "\n"
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults code to ERROR when not provided", () => {
    jsonError("bad request");
    const written = String((stdoutSpy.mock.calls[0] as any[])[0]);
    const parsed = JSON.parse(written);
    expect(parsed.code).toBe("ERROR");
    expect(parsed.error).toBe(true);
    expect(parsed.message).toBe("bad request");
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
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    exitSpy = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("writes message to stderr and exits with 1", () => {
    fatal("critical failure");
    expect(stderrSpy).toHaveBeenCalled();
    const written = String((stderrSpy.mock.calls[0] as any[])[0]);
    expect(written).toContain("critical failure");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
