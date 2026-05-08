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

jest.unstable_mockModule("../api.js", () => ({
  graphql: mockGraphql,
}));

jest.unstable_mockModule("../output.js", () => ({
  jsonOutput: mockJsonOutput,
  fatal: mockFatal,
}));

// ── Dynamic imports ────────────────────────────────────────────────────────

let registerClientsCommands: (program: Command) => void;
let resolveClientId: (explicit?: string) => Promise<string>;

beforeAll(async () => {
  const mod = await import("./clients.js");
  registerClientsCommands = mod.registerClientsCommands;
  resolveClientId = mod.resolveClientId;
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
