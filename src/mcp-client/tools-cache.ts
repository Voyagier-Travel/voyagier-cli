/**
 * On-disk cache of the server's `tools/list`, so `voyagier <tool>` can build
 * its command surface without a network round-trip on every invocation.
 *
 * File: `<CONFIG_DIR>/tools-cache.json` (honours VOYAGIER_CONFIG_DIR, like
 * credentials). Keyed by endpoint URL so switching VOYAGIER_MCP_URL never
 * reuses another server's tool table. Entries older than the TTL are treated
 * as a miss; `voyagier doctor` always refreshes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { CONFIG_DIR } from "../config.js";
import type { McpToolDescriptor } from "./client.js";

export const TOOLS_CACHE_FILE = "tools-cache.json";
/** Cache freshness window. Doctor refreshes; a cache miss refreshes. */
export const TOOLS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ToolsCache {
  /** Endpoint the tools were listed from. */
  url: string;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  /** Server identity from initialize, when known. */
  server?: { name?: string; version?: string };
  /** `toolsSurfaceHash(tools)` at fetch time — scripts compare it across runs. */
  surfaceHash?: string;
  /** The server's `instructions` from initialize (agent guidance); `agent-docs` prints it. */
  instructions?: string;
  tools: McpToolDescriptor[];
}

/**
 * Stable identity of a tool surface: sha256 over the sorted list of
 * `{ name, inputSchema }` with object keys serialized in sorted order, so two
 * servers publishing the same tools with the same inputs hash the same
 * regardless of list or key order. Titles, descriptions and annotations are
 * excluded on purpose: they change wording, not the calling contract. Shown by
 * `doctor` and `--verbose` so a script can detect a surface change.
 */
export function toolsSurfaceHash(tools: readonly McpToolDescriptor[]): string {
  const canonical = [...tools]
    .map((t) => ({ name: t.name, inputSchema: t.inputSchema ?? {} }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256").update(stableStringify(canonical)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

export function toolsCachePath(dir: string = CONFIG_DIR): string {
  return join(dir, TOOLS_CACHE_FILE);
}

/** Read the cache file. Null when absent or unreadable (never throws). */
export function readToolsCache(dir: string = CONFIG_DIR): ToolsCache | null {
  const path = toolsCachePath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ToolsCache>;
    if (!parsed || typeof parsed.url !== "string" || !Array.isArray(parsed.tools)) return null;
    if (typeof parsed.fetchedAt !== "string" || Number.isNaN(Date.parse(parsed.fetchedAt))) return null;
    return parsed as ToolsCache;
  } catch {
    return null;
  }
}

export function writeToolsCache(cache: ToolsCache, dir: string = CONFIG_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = toolsCachePath(dir);
  writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearToolsCache(dir: string = CONFIG_DIR): void {
  const path = toolsCachePath(dir);
  if (existsSync(path)) unlinkSync(path);
}

/** Age of a cache entry in milliseconds. */
export function toolsCacheAgeMs(cache: ToolsCache, now: number = Date.now()): number {
  return Math.max(0, now - Date.parse(cache.fetchedAt));
}

/** True when the entry is for `url` and younger than the TTL. */
export function isToolsCacheFresh(
  cache: ToolsCache | null,
  url: string,
  now: number = Date.now(),
  ttlMs: number = TOOLS_CACHE_TTL_MS,
): cache is ToolsCache {
  if (!cache) return false;
  if (cache.url !== url) return false;
  return toolsCacheAgeMs(cache, now) < ttlMs;
}
