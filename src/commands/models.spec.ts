import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn();

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
}));

// ── Dynamic import ───────────────────────────────────────────────────────────

let registerModelsCommands: (program: Command) => void;

beforeAll(async () => {
  ({ registerModelsCommands } = await import("./models.js"));
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CATALOG = [
  {
    provider: "Anthropic",
    modelId: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    isProviderDefault: true,
    isUserDefault: false,
    source: "user",
  },
  {
    provider: "Gemini",
    modelId: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    isProviderDefault: false,
    isUserDefault: true,
    source: "house-env",
  },
  {
    provider: "OpenAi",
    modelId: "gpt-5",
    displayName: "GPT-5",
    isProviderDefault: false,
    isUserDefault: false,
    source: "house-stored",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

let logs: string[];
let logSpy: jest.SpiedFunction<typeof console.log>;

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerModelsCommands(p);
  return p;
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockReset();
  logs = [];
  logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

// ── models (list) ────────────────────────────────────────────────────────────

describe("models (list)", () => {
  it("queries availableChatModels and renders provider, id, key source, and markers", async () => {
    mockGraphql.mockResolvedValueOnce({ availableChatModels: CATALOG });
    await buildProgram().parseAsync(["node", "v", "models"]);

    expect(String(mockGraphql.mock.calls[0][0])).toContain("availableChatModels");
    const text = logs.join("\n");
    expect(text).toContain("claude-opus-4-8");
    expect(text).toContain("gemini-2.5-pro");
    // 'user' renders as "your key", house-* as "Voyagier".
    expect(text).toContain("your key");
    expect(text).toContain("Voyagier");
    // markers for provider default / your default.
    expect(text).toContain("provider default");
    expect(text).toContain("your default");
  });

  it("emits raw JSON (untransformed source) under --json", async () => {
    mockGraphql.mockResolvedValueOnce({ availableChatModels: CATALOG });
    await buildProgram().parseAsync(["node", "v", "models", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith({ models: CATALOG, total: 3 });
    expect(logs.join("\n")).toBe(""); // no human table in JSON mode
  });

  it("prints a friendly message when no models are available", async () => {
    mockGraphql.mockResolvedValueOnce({ availableChatModels: [] });
    await buildProgram().parseAsync(["node", "v", "models"]);
    expect(logs.join("\n")).toMatch(/No chat models available/);
  });

  it("maps an older-deployment schema-drift rejection to a clear unsupported error", async () => {
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.SCHEMA_DRIFT, 'Cannot query field "availableChatModels" on type "Query".'),
    );
    await expect(buildProgram().parseAsync(["node", "v", "models"])).rejects.toMatchObject({
      code: CliErrorCode.API_ERROR,
      message: expect.stringContaining("not supported by this server yet"),
    });
  });

  it("propagates a non-drift error untouched (auth/network/server)", async () => {
    mockGraphql.mockRejectedValueOnce(new CliError(CliErrorCode.AUTH_FAILED, "nope"));
    await expect(buildProgram().parseAsync(["node", "v", "models"])).rejects.toMatchObject({
      code: CliErrorCode.AUTH_FAILED,
    });
  });

  it("rethrows schema drift that does not name a model-selection field (not masked as unsupported)", async () => {
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.SCHEMA_DRIFT, 'Cannot query field "someUnrelatedField" on type "Query".'),
    );
    await expect(buildProgram().parseAsync(["node", "v", "models"])).rejects.toMatchObject({
      code: CliErrorCode.SCHEMA_DRIFT,
      message: expect.stringContaining("someUnrelatedField"),
    });
  });
});

// ── models set-default ───────────────────────────────────────────────────────

describe("models set-default", () => {
  it("resolves the provider from the catalog and passes it to setMyDefaultChatModel", async () => {
    mockGraphql
      .mockResolvedValueOnce({ availableChatModels: CATALOG }) // resolve
      .mockResolvedValueOnce({
        setMyDefaultChatModel: {
          userId: "u1",
          defaultAiProvider: "Gemini",
          defaultAiModelId: "gemini-2.5-pro",
        },
      });

    await buildProgram().parseAsync(["node", "v", "models", "set-default", "gemini-2.5-pro"]);

    // Second call is the mutation; provider was resolved from the catalog, not guessed.
    const [query, vars] = mockGraphql.mock.calls[1];
    expect(String(query)).toContain("setMyDefaultChatModel");
    expect(vars).toEqual({ provider: "Gemini", modelId: "gemini-2.5-pro" });
    expect(logs.join("\n")).toMatch(/Default chat model set: gemini-2.5-pro \(Gemini\)/);
  });

  it("errors with the valid ids listed when the modelId is unknown", async () => {
    mockGraphql.mockResolvedValueOnce({ availableChatModels: CATALOG });
    await expect(
      buildProgram().parseAsync(["node", "v", "models", "set-default", "no-such-model"]),
    ).rejects.toMatchObject({
      code: CliErrorCode.NOT_FOUND,
      message: expect.stringContaining("claude-opus-4-8"),
    });
    // Never attempted the mutation once resolution failed.
    expect(mockGraphql).toHaveBeenCalledTimes(1);
  });

  it("emits a JSON envelope under --json", async () => {
    const def = { userId: "u1", defaultAiProvider: "Anthropic", defaultAiModelId: "claude-opus-4-8" };
    mockGraphql
      .mockResolvedValueOnce({ availableChatModels: CATALOG })
      .mockResolvedValueOnce({ setMyDefaultChatModel: def });
    await buildProgram().parseAsync(["node", "v", "models", "set-default", "claude-opus-4-8", "--json"]);
    expect(mockJsonOutput).toHaveBeenCalledWith({ ok: true, default: def });
  });
});

// ── models clear-default ─────────────────────────────────────────────────────

describe("models clear-default", () => {
  it("calls clearMyDefaultChatModel and reports the fallback", async () => {
    mockGraphql.mockResolvedValueOnce({
      clearMyDefaultChatModel: { userId: "u1", defaultAiProvider: null, defaultAiModelId: null },
    });
    await buildProgram().parseAsync(["node", "v", "models", "clear-default"]);
    expect(String(mockGraphql.mock.calls[0][0])).toContain("clearMyDefaultChatModel");
    expect(logs.join("\n")).toMatch(/cleared: none \(using the Voyagier default\)/);
  });

  it("maps schema drift to the unsupported error", async () => {
    mockGraphql.mockRejectedValueOnce(
      new CliError(CliErrorCode.SCHEMA_DRIFT, 'Cannot query field "clearMyDefaultChatModel" on type "Mutation".'),
    );
    await expect(
      buildProgram().parseAsync(["node", "v", "models", "clear-default"]),
    ).rejects.toMatchObject({ code: CliErrorCode.API_ERROR });
  });
});

// ── registration ─────────────────────────────────────────────────────────────

describe("registration", () => {
  it("registers models with set-default and clear-default subcommands", () => {
    const p = buildProgram();
    const models = p.commands.find((c) => c.name() === "models");
    expect(models).toBeDefined();
    const subs = models!.commands.map((c) => c.name());
    expect(subs).toContain("set-default");
    expect(subs).toContain("clear-default");
  });
});
