import { describe, it, expect, beforeEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearToolsCache, isToolsCacheFresh, readToolsCache, toolsCacheAgeMs, toolsCachePath, toolsSurfaceHash, TOOLS_CACHE_TTL_MS, writeToolsCache } from "./tools-cache.js";

const URL_A = "https://mcp.example.test/api/mcp";

describe("tools cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voy-tools-cache-"));
  });

  it("round-trips and is owner-only on disk", () => {
    const cache = { url: URL_A, fetchedAt: new Date().toISOString(), server: { name: "voyagier", version: "1" }, tools: [{ name: "a" }] };
    writeToolsCache(cache, dir);
    expect(readToolsCache(dir)).toEqual(cache);
    expect(statSync(toolsCachePath(dir)).mode & 0o777).toBe(0o600);
    clearToolsCache(dir);
    expect(readToolsCache(dir)).toBeNull();
  });

  it("returns null for a missing, corrupt or malformed file (never throws)", () => {
    expect(readToolsCache(dir)).toBeNull();
    writeFileSync(toolsCachePath(dir), "{ nope");
    expect(readToolsCache(dir)).toBeNull();
    writeFileSync(toolsCachePath(dir), JSON.stringify({ url: URL_A, tools: "not-an-array", fetchedAt: "x" }));
    expect(readToolsCache(dir)).toBeNull();
    writeFileSync(toolsCachePath(dir), JSON.stringify({ url: URL_A, tools: [], fetchedAt: "not a date" }));
    expect(readToolsCache(dir)).toBeNull();
  });

  it("is fresh only for the same URL and within the TTL", () => {
    const now = Date.parse("2026-09-10T12:00:00Z");
    const cache = { url: URL_A, fetchedAt: new Date(now - 60_000).toISOString(), tools: [] };
    expect(isToolsCacheFresh(cache, URL_A, now)).toBe(true);
    expect(isToolsCacheFresh(cache, "https://other.example.test/mcp", now)).toBe(false);
    expect(isToolsCacheFresh(cache, URL_A, now + TOOLS_CACHE_TTL_MS)).toBe(false);
    expect(isToolsCacheFresh(null, URL_A, now)).toBe(false);
    expect(toolsCacheAgeMs(cache, now)).toBe(60_000);
  });

  it("creates the directory when missing", () => {
    const nested = join(dir, "nested", "deeper");
    writeToolsCache({ url: URL_A, fetchedAt: new Date().toISOString(), tools: [] }, nested);
    expect(JSON.parse(readFileSync(toolsCachePath(nested), "utf-8")).url).toBe(URL_A);
  });
});

describe("toolsSurfaceHash", () => {
  const a = { name: "a", title: "A", description: "first", inputSchema: { type: "object", properties: { x: { type: "string" }, y: { type: "integer" } }, required: ["x"] } };
  const b = { name: "b", inputSchema: { type: "object", properties: {} } };

  it("is stable across list order and object key order", () => {
    const reordered = { ...a, inputSchema: { required: ["x"], properties: { y: { type: "integer" }, x: { type: "string" } }, type: "object" } };
    expect(toolsSurfaceHash([a, b])).toBe(toolsSurfaceHash([b, reordered]));
    expect(toolsSurfaceHash([a, b])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores wording (title/description/annotations) but not names or input schemas", () => {
    expect(toolsSurfaceHash([{ ...a, title: "Renamed", description: "other", annotations: { readOnlyHint: true } }, b])).toBe(toolsSurfaceHash([a, b]));
    expect(toolsSurfaceHash([{ ...a, name: "a2" }, b])).not.toBe(toolsSurfaceHash([a, b]));
    expect(toolsSurfaceHash([{ ...a, inputSchema: { ...a.inputSchema, required: [] } }, b])).not.toBe(toolsSurfaceHash([a, b]));
    expect(toolsSurfaceHash([a])).not.toBe(toolsSurfaceHash([a, b]));
  });
});
