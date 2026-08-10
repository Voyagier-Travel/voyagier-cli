import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { Command } from "commander";
import { CliError, CliErrorCode } from "../errors.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGraphql = jest.fn();
const mockJsonOutput = jest.fn().mockImplementation((data: unknown) => {
  process.stdout.write(JSON.stringify(data) + "\n");
});
const mockFatal = jest.fn().mockImplementation((msg: string) => {
  throw new CliError(CliErrorCode.VALIDATION, msg);
});

// Test double for the compat wrapper (VOY-1748): delegates to mockGraphql so
// every existing "mockGraphql.mockResolvedValueOnce" assertion keeps working,
// while faithfully reproducing the enriched→legacy retry on an unknown-field
// error. The real detection logic itself is unit-tested in api.spec.ts. Trailing
// undefined args are trimmed so call-count/arg assertions match the historical
// graphql() call shape.
async function fallbackDouble(
  enriched: string,
  legacy: string,
  pattern: RegExp,
  variables?: Record<string, unknown>,
  options?: unknown,
): Promise<unknown> {
  const invoke = (q: string): Promise<unknown> => {
    const args: unknown[] = [q, variables, options];
    while (args.length > 1 && args[args.length - 1] === undefined) args.pop();
    return (mockGraphql as (...a: unknown[]) => Promise<unknown>)(...args);
  };
  try {
    return await invoke(enriched);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot query field|Unknown field/i.test(message) && pattern.test(message)) {
      return await invoke(legacy);
    }
    throw err;
  }
}

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
  graphqlWithFieldFallback: fallbackDouble,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
  fatal: mockFatal,
}));

// VOY-1762: resolveClient delegates to promptPick when interactive. Stub it so
// the picker path is exercised deterministically (no real readline / TTY).
const mockPromptPick = jest.fn();
jest.unstable_mockModule("../prompt.js", () => ({
  promptPick: mockPromptPick,
  promptText: jest.fn(),
  isInteractive: jest.fn(() => false),
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerClientsCommands: (program: Command) => void;
type ResolveOpts = { interactive?: boolean; carryFlags?: string };
let resolveClientId: (explicit?: string, options?: ResolveOpts) => Promise<string>;
let resolveClient: (explicit?: string, options?: ResolveOpts) => Promise<{ id: string; name: string; autoResolved: boolean; isSelf?: boolean }>;

beforeAll(async () => {
  const mod = await import("./clients.js");
  registerClientsCommands = mod.registerClientsCommands;
  resolveClientId = mod.resolveClientId;
  resolveClient = mod.resolveClient;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const sampleClient = {
  id: "clt_01HX",
  name: "Smith Family",
  email: "smith@example.com",
  phone: "+1-555-1234",
  avatarUrl: null,
  description: null,
  clientType: "Group" as const,
  status: "Active" as const,
  createdAt: "2026-01-15T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
};

const archivedClient = {
  ...sampleClient,
  id: "clt_OLD",
  name: "Old Co",
  email: "old@example.com",
  clientType: "Company" as const,
  status: "Archived" as const,
};

// The auto-provisioned "self" client (VOY-1748).
const selfClient = {
  ...sampleClient,
  id: "clt_SELF",
  name: "Jane Planner",
  email: "jane@example.com",
  clientType: "Individual" as const,
  status: "Active" as const,
  isSelf: true,
};

// ── Helpers ────────────────────────────────────────────────────────────────

let stdoutSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stderrSpy: jest.SpiedFunction<(buf: string | Uint8Array) => boolean>;
let stdoutOut: string[];

function buildProgram(): Command {
  const p = new Command();
  p.exitOverride();
  registerClientsCommands(p);
  return p;
}

beforeEach(() => {
  mockGraphql.mockReset();
  mockJsonOutput.mockClear();
  mockFatal.mockClear();
  mockPromptPick.mockReset();
  stdoutOut = [];
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((b: string | Uint8Array) => {
    stdoutOut.push(typeof b === "string" ? b : Buffer.from(b).toString());
    return true;
  });
  stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("clients list", () => {
  it("returns all clients in --json mode", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient, archivedClient] } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(mockJsonOutput).toHaveBeenCalledWith({
      clients: [sampleClient, archivedClient],
      total: 2,
    });
  });

  it("filters by --status active", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient, archivedClient] } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--status", "active", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      clients: [sampleClient],
      total: 1,
    });
  });

  it("filters by --type group", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient, archivedClient] } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--type", "group", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      clients: [sampleClient],
      total: 1,
    });
  });

  it("rejects invalid --type values", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "clients", "list", "--type", "invalid", "--json"])
    ).rejects.toThrow(/Invalid --type/);
  });
});

// ── VOY-1896: single-page mode (backs the clients_list MCP tool) ─────────────
describe("clients list — pagination (--page/--limit)", () => {
  it("--page/--limit fetch a single page and echo page/limit/count", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient], count: 42, page: 2, limit: 1 },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--page", "2", "--limit", "1", "--json"]);

    // ONE query, with the page/limit variables (no full-roster walk).
    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { page: 2, limit: 1 });
    expect(mockJsonOutput).toHaveBeenCalledWith({
      clients: [sampleClient],
      total: 1,
      page: 2,
      limit: 1,
      count: 42,
    });
  });

  it("--limit alone defaults page to 1", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient], count: 1, page: 1, limit: 5 },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--limit", "5", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { page: 1, limit: 5 });
  });

  it("rejects a non-positive-integer --page", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "clients", "list", "--page", "0", "--json"])
    ).rejects.toThrow(/Invalid --page/);
  });

  it("rejects a non-numeric --limit but accepts a zero-padded one", async () => {
    await expect(
      buildProgram().parseAsync(["node", "test", "clients", "list", "--limit", "5x", "--json"])
    ).rejects.toThrow(/Invalid --limit/);

    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient], count: 1, page: 2, limit: 5 },
    });
    await buildProgram().parseAsync(["node", "test", "clients", "list", "--page", "02", "--limit", "5", "--json"]);
    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { page: 2, limit: 5 });
  });
});

describe("clients get", () => {
  it("returns the client in --json mode", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClient: sampleClient });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "get", "clt_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), { id: "clt_01HX" });
    expect(mockJsonOutput).toHaveBeenCalledWith({ client: sampleClient });
  });

  it("throws NOT_FOUND for missing client", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClient: null });

    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "clients", "get", "clt_MISSING", "--json"])
    ).rejects.toMatchObject({ code: CliErrorCode.NOT_FOUND });
  });
});

describe("clients create", () => {
  it("creates a client with all fields and normalizes type", async () => {
    mockGraphql.mockResolvedValueOnce({ createTripPlanClient: sampleClient });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "clients", "create",
      "--name", "Smith Family",
      "--type", "group",
      "--email", "smith@example.com",
      "--phone", "+1-555-1234",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      {
        input: {
          name: "Smith Family",
          clientType: "Group",
          email: "smith@example.com",
          phone: "+1-555-1234",
        },
      },
      { dryRun: undefined }
    );
    expect(mockJsonOutput).toHaveBeenCalledWith({ client: sampleClient, ok: true });
  });

  it("requires --name and --type", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "clients", "create", "--name", "X", "--json"])
    ).rejects.toThrow();
  });
});

describe("clients update", () => {
  it("sends only the changed fields", async () => {
    mockGraphql.mockResolvedValueOnce({ updateTripPlanClient: { ...sampleClient, name: "Smiths" } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "clients", "update", "clt_01HX",
      "--name", "Smiths",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { id: "clt_01HX", input: { name: "Smiths" } },
      { dryRun: undefined }
    );
  });

  it("fails when no fields are provided", async () => {
    const p = buildProgram();
    await expect(
      p.parseAsync(["node", "test", "clients", "update", "clt_01HX", "--json"])
    ).rejects.toThrow(/No fields provided/);
  });
});

describe("clients archive", () => {
  it("calls update with status: Archived", async () => {
    mockGraphql.mockResolvedValueOnce({
      updateTripPlanClient: { ...sampleClient, status: "Archived" },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "archive", "clt_01HX", "--json"]);

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { id: "clt_01HX", input: { status: "Archived" } },
      { dryRun: undefined }
    );
  });
});

describe("clients upsert", () => {
  it("returns existing client when email matches", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "clients", "upsert",
      "--email", "smith@example.com",
      "--name", "Smith Family",
      "--type", "group",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledTimes(1); // only the list query, no create
    expect(mockJsonOutput).toHaveBeenCalledWith({
      client: sampleClient,
      ok: true,
      created: false,
    });
  });

  it("creates new client when email doesn't match", async () => {
    mockGraphql
      .mockResolvedValueOnce({ tripPlanClients: { items: [archivedClient] } })
      .mockResolvedValueOnce({ createTripPlanClient: sampleClient });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "clients", "upsert",
      "--email", "smith@example.com",
      "--name", "Smith Family",
      "--type", "group",
      "--json",
    ]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockJsonOutput).toHaveBeenCalledWith({
      client: sampleClient,
      ok: true,
      created: true,
    });
  });

  it("matches email case-insensitively", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "clients", "upsert",
      "--email", "SMITH@example.com",  // uppercase
      "--name", "Smith Family",
      "--type", "group",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({ created: false })
    );
  });

  it("throws VALIDATION when only an Archived client matches the email (Copilot #3178799085)", async () => {
    // The archived record is unusable downstream because resolveClientId() requires Active.
    // Surface explicitly so the caller can reactivate or pick a different email — don't
    // silently return an Archived id (the v1 bug).
    const archivedSmith = {
      ...archivedClient,
      id: "clt_ARCH",
      email: "smith@example.com",
    };
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [archivedSmith] } });

    const p = buildProgram();
    p.exitOverride();
    await expect(
      p.parseAsync([
        "node", "test", "clients", "upsert",
        "--email", "smith@example.com",
        "--name", "Smith Family",
        "--type", "group",
        "--json",
      ]),
    ).rejects.toMatchObject({
      code: CliErrorCode.VALIDATION,
      details: { archivedClientId: "clt_ARCH" },
    });
    // Critically: did NOT call createTripPlanClient, did NOT return the archived id.
    expect(mockJsonOutput).not.toHaveBeenCalled();
  });

  it("prefers an Active match even when an Archived record with the same email also exists", async () => {
    const activeSmith = sampleClient;
    const archivedSmith = {
      ...archivedClient,
      id: "clt_ARCH",
      email: "smith@example.com",
    };
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [archivedSmith, activeSmith] } });

    const p = buildProgram();
    await p.parseAsync([
      "node", "test", "clients", "upsert",
      "--email", "smith@example.com",
      "--name", "Smith Family",
      "--type", "group",
      "--json",
    ]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      client: activeSmith,
      ok: true,
      created: false,
    });
  });
});

describe("resolveClientId", () => {
  it("returns explicit id unchanged when not an email", async () => {
    const id = await resolveClientId("clt_01HX");
    expect(id).toBe("clt_01HX");
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("throws CLIENT_REQUIRED when explicit is empty string (Copilot #3178799122 — wires the unused error code)", async () => {
    await expect(resolveClientId("")).rejects.toMatchObject({
      code: CliErrorCode.CLIENT_REQUIRED,
    });
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("looks up email and returns matching active client", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, archivedClient] },
    });
    const id = await resolveClientId("smith@example.com");
    expect(id).toBe("clt_01HX");
  });

  it("throws NOT_FOUND when email has no active match", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [archivedClient] } });
    await expect(resolveClientId("nomatch@example.com")).rejects.toMatchObject({
      code: CliErrorCode.NOT_FOUND,
    });
  });

  it("auto-picks the single active client when no explicit value", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, archivedClient] },
    });
    const id = await resolveClientId();
    expect(id).toBe("clt_01HX");
  });

  it("throws NO_CLIENTS when no active clients exist", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [archivedClient] } });
    await expect(resolveClientId()).rejects.toMatchObject({
      code: CliErrorCode.NO_CLIENTS,
    });
  });

  it("throws MULTIPLE_CLIENTS when more than one active", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, { ...sampleClient, id: "clt_OTHER" }] },
    });
    await expect(resolveClientId()).rejects.toMatchObject({
      code: CliErrorCode.MULTIPLE_CLIENTS,
    });
  });

  it("MULTIPLE_CLIENTS (auto-resolve) hint advertises id|name|email with a concrete name example (VOY-1764)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, { ...sampleClient, id: "clt_OTHER", name: "Other Co" }] },
    });
    const err = await resolveClientId().catch((e) => e as CliError);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("--client <id|name|email>");
    // Concrete example uses the first listed client's actual name, shell-quoted
    // via shellArg (single quotes for values with spaces/metacharacters).
    expect(err.message).toContain(`--client '${sampleClient.name}'`);
    expect(err.message).toContain("accepts an id, name, or email");
  });

  it("NOT_FOUND (explicit name) hint mentions passing an id, name, or email (VOY-1764)", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });
    const err = await resolveClientId("Nobody Here").catch((e) => e as CliError);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe(CliErrorCode.NOT_FOUND);
    expect(err.message).toContain("--client <id|name|email>");
  });

  it("NOT_FOUND (explicit email) hint mentions passing an id, name, or email (VOY-1764)", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });
    const err = await resolveClientId("nobody@example.com").catch((e) => e as CliError);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe(CliErrorCode.NOT_FOUND);
    expect(err.message).toContain("--client <id|name|email>");
    // Still offers the create-client fallback with the searched email.
    expect(err.message).toContain('--email "nobody@example.com"');
  });

  it("MULTIPLE_CLIENTS (explicit name matched >1) hint says email or id disambiguates (VOY-1764)", async () => {
    // Two active clients share the same name; an explicit name value matches both.
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [sampleClient, { ...sampleClient, id: "clt_TWIN", email: "twin@example.com" }],
      },
    });
    const err = await resolveClientId(sampleClient.name).catch((e) => e as CliError);
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe(CliErrorCode.MULTIPLE_CLIENTS);
    expect(err.message).toContain("--client <id|email>");
    expect(err.message).toContain("an email or id is unambiguous");
  });

  // ── VOY-1748: self-client auto-resolution ────────────────────────────────

  it("auto-picks the single self client among multiple active clients", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, selfClient, { ...sampleClient, id: "clt_OTHER" }] },
    });
    const id = await resolveClientId();
    expect(id).toBe("clt_SELF");
  });

  it("surfaces isSelf on the resolved self client with autoResolved", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, selfClient] },
    });
    const resolved = await resolveClient();
    expect(resolved).toMatchObject({ id: "clt_SELF", autoResolved: true, isSelf: true });
  });

  it("still errors MULTIPLE_CLIENTS when >1 active and none is the self client", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, { ...sampleClient, id: "clt_OTHER" }] },
    });
    await expect(resolveClientId()).rejects.toMatchObject({
      code: CliErrorCode.MULTIPLE_CLIENTS,
    });
  });

  it("errors MULTIPLE_CLIENTS when more than one client is flagged isSelf (ambiguous)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [selfClient, { ...selfClient, id: "clt_SELF2" }],
      },
    });
    await expect(resolveClientId()).rejects.toMatchObject({
      code: CliErrorCode.MULTIPLE_CLIENTS,
    });
  });

  it("explicit --client id is returned untouched, never overridden by a self client", async () => {
    // No graphql call at all for a canonical id — the self default must not
    // intercept an explicit reference.
    const resolved = await resolveClient("clt_EXPLICIT");
    expect(resolved).toMatchObject({ id: "clt_EXPLICIT", autoResolved: false });
    expect(resolved.isSelf).toBeUndefined();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it("single active client is still picked (self flag absent — old backend)", async () => {
    // fetchAllClients falls back to the legacy field set, so isSelf is undefined.
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });
    const resolved = await resolveClient();
    expect(resolved).toMatchObject({ id: "clt_01HX", autoResolved: true, isSelf: false });
  });

  // ── VOY-1762: interactive picker + hint carry-forward ──────────────────────

  it("interactive auto-resolve shows a picker and returns the chosen client", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, { ...sampleClient, id: "clt_OTHER", name: "Other Co" }] },
    });
    mockPromptPick.mockResolvedValueOnce({ id: "clt_OTHER", name: "Other Co" });
    const resolved = await resolveClient(undefined, { interactive: true });
    expect(mockPromptPick).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({ id: "clt_OTHER", name: "Other Co", autoResolved: false });
  });

  it("interactive explicit-name-matches-many shows a picker and returns the chosen client", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: {
        items: [sampleClient, { ...sampleClient, id: "clt_TWIN", email: "twin@example.com" }],
      },
    });
    mockPromptPick.mockResolvedValueOnce({ id: "clt_TWIN", name: sampleClient.name });
    const resolved = await resolveClient(sampleClient.name, { interactive: true });
    expect(mockPromptPick).toHaveBeenCalledTimes(1);
    expect(resolved.id).toBe("clt_TWIN");
  });

  it("NON-interactive still throws MULTIPLE_CLIENTS (picker never engaged)", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, { ...sampleClient, id: "clt_OTHER" }] },
    });
    await expect(resolveClient()).rejects.toMatchObject({ code: CliErrorCode.MULTIPLE_CLIENTS });
    expect(mockPromptPick).not.toHaveBeenCalled();
  });

  it("carries the caller's flags forward into the MULTIPLE_CLIENTS retry hint", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient, { ...sampleClient, id: "clt_OTHER", name: "Other Co" }] },
    });
    const err = await resolveClient(undefined, { carryFlags: "--title 'Paris'" }).catch((e) => e as CliError);
    expect(err.code).toBe(CliErrorCode.MULTIPLE_CLIENTS);
    expect(err.message).toContain("--title 'Paris'");
    // The retry command still names --client and the concrete example.
    expect(err.message).toContain(`--client '${sampleClient.name}'`);
  });
});

// ── VOY-1748: clients list marks the self client ─────────────────────────────

describe("clients list — self marker", () => {
  it("includes isSelf in --json output", async () => {
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [selfClient, sampleClient] } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--json"]);

    expect(mockJsonOutput).toHaveBeenCalledWith({
      clients: [selfClient, sampleClient],
      total: 2,
    });
  });

  it("appends a (self) marker in human/table output", async () => {
    // Human/table rows are printed via console.log, not process.stdout.write.
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockGraphql.mockResolvedValueOnce({ tripPlanClients: { items: [selfClient, sampleClient] } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list"]);

    const written = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    // Only the self client is marked.
    expect(written).toMatch(/Jane Planner.*\(self\)/);
    expect(written).not.toMatch(/Smith Family.*\(self\)/);
    logSpy.mockRestore();
  });
});

// ── VOY-1748: fetchAllClients compat fallback ────────────────────────────────

describe("fetchAllClients isSelf compat fallback", () => {
  it("retries the legacy query and treats isSelf as absent when the backend rejects it", async () => {
    // First (enriched) call rejects with a field-validation error; the wrapper
    // retries the legacy query, whose items carry no isSelf.
    mockGraphql
      .mockRejectedValueOnce(
        new CliError(
          CliErrorCode.SCHEMA_DRIFT,
          'Schema drift detected: Cannot query field "isSelf" on type "TripPlanClient".',
        ),
      )
      .mockResolvedValueOnce({ tripPlanClients: { items: [sampleClient] } });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockJsonOutput).toHaveBeenCalledWith({ clients: [sampleClient], total: 1 });
  });
});

// ── Pagination ─────────────────────────────────────────────────────────────

describe("fetchAllClients pagination", () => {
  // The page size constant lives in clients.ts (CLIENTS_PAGE_SIZE = 100). To
  // exercise the pagination loop without producing 100-element fixtures, the
  // tests rely on the early-exit semantics: a *short* page ends iteration. So
  // we send a full page on iteration 1, then a short page on iteration 2.
  const PAGE_SIZE = 100;

  function makeClient(i: number): typeof sampleClient {
    return { ...sampleClient, id: `clt_${i.toString().padStart(4, "0")}` };
  }

  it("walks every page until a short page is returned", async () => {
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => makeClient(i));
    const shortPage = [makeClient(PAGE_SIZE), makeClient(PAGE_SIZE + 1)];

    mockGraphql
      .mockResolvedValueOnce({
        tripPlanClients: { items: fullPage, count: PAGE_SIZE + 2, page: 1, limit: PAGE_SIZE },
      })
      .mockResolvedValueOnce({
        tripPlanClients: { items: shortPage, count: PAGE_SIZE + 2, page: 2, limit: PAGE_SIZE },
      });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(2);
    expect(mockGraphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      { page: 1, limit: PAGE_SIZE },
    );
    expect(mockGraphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      { page: 2, limit: PAGE_SIZE },
    );
    expect(mockJsonOutput).toHaveBeenCalledWith(
      expect.objectContaining({ total: PAGE_SIZE + 2 }),
    );
  });

  it("stops after the first page when it is short", async () => {
    mockGraphql.mockResolvedValueOnce({
      tripPlanClients: { items: [sampleClient], count: 1, page: 1, limit: PAGE_SIZE },
    });

    const p = buildProgram();
    await p.parseAsync(["node", "test", "clients", "list", "--json"]);

    expect(mockGraphql).toHaveBeenCalledTimes(1);
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.any(String),
      { page: 1, limit: PAGE_SIZE },
    );
  });
});
