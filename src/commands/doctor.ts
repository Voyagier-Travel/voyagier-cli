/**
 * `voyagier doctor` (v2.0.0).
 *
 * Single self-check command for agents/humans to verify the CLI environment
 * before doing real work. Pulled forward from Phase 4 because schema drift
 * is a real risk during the v2 build window.
 *
 * Checks:
 *   1. auth         — credentials exist + whoami query returns 200
 *   2. reachability — backend GraphQL endpoint responds
 *   3. schema       — known critical operations validate against introspection
 *   4. state-files  — ~/.voyagier/last-*.json are valid + not stale
 *   5. version      — CLI vs latest npm release (best-effort, soft-fail)
 *
 * Exit code: 0 if all PASS or WARN; 1 if any FAIL.
 *
 * Surface:
 *   voyagier doctor [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  validate,
  type IntrospectionQuery,
  type GraphQLSchema,
} from "graphql";
import { graphql, AuthError } from "../api.js";
import { CONFIG_DIR, credentialsExist, getApiUrl, getUserContext } from "../config.js";
import { sanitizeExternalText } from "../utils.js";
import { jsonOutput } from "../output.js";
import { CliError } from "../errors.js";
import { DOCTOR_PING } from "../queries.js";
import * as queries from "../queries.js";

/**
 * Every GraphQL operation the CLI ships, as `{ name, operation }`.
 *
 * Source of truth is `src/queries.ts` — every `export const NAME = \`...\``
 * string export is an operation we send to the backend. Iterating the module
 * (rather than a hand-maintained list) is deliberate: it guarantees `doctor`
 * validates the WHOLE surface and can never silently drift back to a
 * hardcoded subset (the original VOY-1411 bug).
 */
/**
 * Operations OUTSIDE the core compose/close loop. Drift here breaks only its
 * own command (places/comments/booking-record reads — tracked as VOY-1417/
 * 1418/1419), never plan→search→select→quote→book. Name-pattern match so new
 * peripheral ops classify themselves; anything unmatched is treated as CORE
 * (fail-closed: unknown ops err on the side of blocking).
 */
export const PERIPHERAL_OP_PATTERN = /PLACE|COMMENT|BOOKING_RECORD/;

export function collectCliOperations(): Array<{ name: string; operation: string }> {
  const ops: Array<{ name: string; operation: string }> = [];
  for (const [name, value] of Object.entries(queries as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const op = value.trim();
    // Must look like a GraphQL operation document.
    if (!/^(query|mutation|subscription|fragment|\{)/.test(op)) continue;
    ops.push({ name, operation: op });
  }
  return ops;
}

/**
 * Validate every CLI operation against a live schema, field-by-field.
 * Pure (no I/O) so it is trivially unit-testable with a fixture schema.
 * Returns per-operation drift diagnostics (empty array => all valid).
 */
export function validateOperationsAgainstSchema(
  schema: GraphQLSchema,
  ops: Array<{ name: string; operation: string }>,
): Array<{ name: string; errors: string[] }> {
  const drifted: Array<{ name: string; errors: string[] }> = [];
  for (const { name, operation } of ops) {
    let errors: string[] = [];
    try {
      const ast = parse(operation);
      errors = validate(schema, ast).map((e) => e.message);
    } catch (e) {
      // A parse error is a malformed op we ship — treat as drift, not a crash.
      errors = [`parse error: ${e instanceof Error ? e.message : String(e)}`];
    }
    if (errors.length > 0) drifted.push({ name, errors });
  }
  return drifted;
}

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  overall: CheckStatus;
}

/**
 * State directory under inspection. Override via env (`VOYAGIER_STATE_DIR`) for
 * doctor-specific tests; otherwise follows CONFIG_DIR (which itself honors
 * `VOYAGIER_CONFIG_DIR`). In normal use, this is `~/.voyagier/`.
 */
function stateDir(): string {
  return process.env.VOYAGIER_STATE_DIR ?? CONFIG_DIR;
}
const STATE_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Compute the overall status from individual checks.
 * FAIL > WARN > PASS.
 */
export function rollUpStatus(checks: DoctorCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  return "PASS";
}

/**
 * Verify auth: credentials exist and a basic GraphQL ping succeeds.
 */
async function checkAuth(): Promise<DoctorCheck> {
  if (!credentialsExist()) {
    return {
      name: "auth",
      status: "FAIL",
      message: "No credentials. Run: voyagier auth login (or voyagier auth set-token <PAT>)",
    };
  }
  try {
    await graphql<{ __schema: { queryType: { name: string } } }>(DOCTOR_PING);
    const ctx = getUserContext();
    const who = ctx?.email ?? ctx?.name ?? "unknown";
    return {
      name: "auth",
      status: "PASS",
      message: `Authenticated as ${who}`,
    };
  } catch (err) {
    if (err instanceof AuthError || (err instanceof CliError && err.code === "AUTH_FAILED")) {
      return {
        name: "auth",
        status: "FAIL",
        message: "Token rejected. Run: voyagier auth set-token <PAT>",
      };
    }
    return {
      name: "auth",
      status: "WARN",
      message: `Auth check could not complete: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify backend reachability via a tiny introspection query.
 * Only runs if auth has already passed, since auth implicitly tests this.
 * Kept separate so its failure mode is distinct from "bad token".
 */
/** Hard ceiling on doctor probes; doctor is meant to be a quick self-check primitive. */
const DOCTOR_PROBE_TIMEOUT_MS = 5000;

async function checkReachability(): Promise<DoctorCheck> {
  const url = getApiUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 401) {
      return {
        name: "reachability",
        status: "FAIL",
        message: `Backend ${url} responded ${res.status} ${sanitizeExternalText(res.statusText)}`,
      };
    }
    return {
      name: "reachability",
      status: "PASS",
      message: `${url} responding`,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const detail = aborted
      ? `timed out after ${DOCTOR_PROBE_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    return {
      name: "reachability",
      status: "FAIL",
      message: `Cannot reach ${url}: ${detail}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify schema compatibility across the ENTIRE CLI operation surface.
 *
 * Strategy (the VOY-1411 fix): fetch the live schema via a single
 * introspection query, build a client schema, then field-by-field validate
 * EVERY operation the CLI ships (collected from src/queries.ts) using
 * graphql's own `validate()`. This is the same technique as the workspace
 * audit script, brought into the runtime self-check.
 *
 * Why this replaced the old 2-probe version: the original checkSchema probed
 * exactly two always-valid queries and reported PASS while `goals`,
 * `plans get`, `selections`, `options` etc. were all broken (VOY-1407/1412/
 * 1413/1416). Validating the whole surface against the live schema would have
 * caught the entire drift chain in one run.
 *
 * Side-effect-free: introspection + local validation only. No CLI operation
 * (including mutations) is ever executed.
 */
async function checkSchema(): Promise<DoctorCheck> {
  // 1. Fetch the live schema. One introspection query covers the whole surface.
  let schema: GraphQLSchema;
  try {
    const introspection = await graphql<IntrospectionQuery>(getIntrospectionQuery());
    schema = buildClientSchema(introspection);
  } catch (err) {
    if (err instanceof CliError && err.code === "AUTH_FAILED") {
      return {
        name: "schema",
        status: "WARN",
        message: "Schema check skipped (auth failed; fix auth first)",
      };
    }
    // Couldn't introspect or build the schema (network blip, permissions, or an
    // unexpected shape). Inconclusive — WARN, never a false FAIL.
    return {
      name: "schema",
      status: "WARN",
      message: `Schema check inconclusive — could not introspect live schema: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Validate every shipped operation against it.
  const ops = collectCliOperations();
  const drifted = validateOperationsAgainstSchema(schema, ops);
  return buildSchemaDriftCheck(ops.length, drifted);
}

/**
 * Turn drift diagnostics into the schema check verdict. Pure so the WARN/FAIL
 * classification is unit-testable without a live schema.
 *
 * Classification rationale (VOY-1714 #5): a cold agent seeing `overall: FAIL`
 * has no way to know whether it can proceed. Drift confined to peripheral
 * surfaces (places / comments / booking-record reads — the known VOY-1417/
 * 1418/1419 cluster) does NOT block the core compose/close loop (plan →
 * search → select → travellers → quote → book), so it downgrades to WARN with
 * an explicit go-ahead. Any core-surface drift stays FAIL.
 */
export function buildSchemaDriftCheck(
  opsCount: number,
  drifted: Array<{ name: string; errors: string[] }>,
): DoctorCheck {
  if (drifted.length === 0) {
    return {
      name: "schema",
      status: "PASS",
      message: `All ${opsCount} CLI operations valid against live schema`,
    };
  }

  const coreDrifted = drifted.filter((d) => !PERIPHERAL_OP_PATTERN.test(d.name));
  if (coreDrifted.length === 0) {
    return {
      name: "schema",
      status: "WARN",
      message:
        `Schema drift on ${drifted.length}/${opsCount} operation(s), ALL on peripheral surfaces ` +
        `(places/comments/booking-records) — the core compose/close loop is unaffected; safe to proceed`,
      details: {
        drifted: drifted.map((d) => `${d.name}: ${d.errors.join("; ")}`),
      },
    };
  }
  return {
    name: "schema",
    status: "FAIL",
    message: `Schema drift detected on ${drifted.length}/${opsCount} operation(s), ${coreDrifted.length} on CORE surfaces — core commands may fail`,
    details: {
      coreDrifted: coreDrifted.map((d) => d.name),
      drifted: drifted.map((d) => `${d.name}: ${d.errors.join("; ")}`),
    },
  };
}

/**
 * Verify state files: parseable JSON, not stale beyond 24h.
 */
function checkStateFiles(): DoctorCheck {
  const STATE_DIR = stateDir();
  if (!existsSync(STATE_DIR)) {
    return {
      name: "state-files",
      status: "PASS",
      message: "No state directory yet (clean install)",
    };
  }

  const files = readdirSync(STATE_DIR).filter((f) => f.startsWith("last-") && f.endsWith(".json"));
  if (files.length === 0) {
    return {
      name: "state-files",
      status: "PASS",
      message: "No cached state",
    };
  }

  const issues: string[] = [];
  const stale: string[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
    try {
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content) as { timestamp?: string | number };
      // Prefer the embedded `timestamp` from src/state.ts (matches the rest of the state layer).
      // state.ts stores ISO strings; older payloads may omit it. Fall back to mtime.
      let baseMs: number | null = null;
      if (typeof parsed.timestamp === "string") {
        const ms = new Date(parsed.timestamp).getTime();
        if (Number.isFinite(ms)) baseMs = ms;
      } else if (typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)) {
        baseMs = parsed.timestamp;
      }
      if (baseMs === null) baseMs = statSync(path).mtimeMs;
      const age = Date.now() - baseMs;
      if (age > STATE_STALE_MS) stale.push(f);
    } catch {
      issues.push(f);
    }
  }

  if (issues.length > 0) {
    return {
      name: "state-files",
      status: "WARN",
      message: `${issues.length} corrupt state file(s); consider clearing ~/.voyagier/`,
      details: { corrupt: issues },
    };
  }
  if (stale.length > 0) {
    return {
      name: "state-files",
      status: "WARN",
      message: `${stale.length} cached file(s) older than 24h`,
      details: { stale },
    };
  }
  return {
    name: "state-files",
    status: "PASS",
    message: `${files.length} cached file(s), all valid`,
  };
}

/**
 * Best-effort version check against npm registry.
 * WARN-only; never fails the report.
 */
async function checkVersion(currentVersion: string): Promise<DoctorCheck> {
  try {
    const res = await fetch("https://registry.npmjs.org/@voyagier/cli/latest", {
      // eslint-disable-next-line no-undef
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        name: "version",
        status: "WARN",
        message: `Could not fetch latest version (registry returned ${res.status})`,
      };
    }
    const data = (await res.json()) as { version?: string };
    if (!data.version) {
      return {
        name: "version",
        status: "WARN",
        message: "Could not parse latest version from registry",
      };
    }
    const cmp = compareSemver(currentVersion, data.version);
    if (cmp === 0) {
      return {
        name: "version",
        status: "PASS",
        message: `Running latest (v${currentVersion})`,
      };
    }
    if (cmp > 0) {
      // Local build is ahead of npm latest — dev/prerelease build, not outdated.
      return {
        name: "version",
        status: "PASS",
        message: `Running v${currentVersion} (ahead of npm latest v${data.version} — likely a dev/prerelease build)`,
        details: { current: currentVersion, latest: data.version },
      };
    }
    return {
      name: "version",
      status: "WARN",
      message: `v${data.version} available; running v${currentVersion}. Update: npm i -g @voyagier/cli@latest`,
      details: { current: currentVersion, latest: data.version },
    };
  } catch (err) {
    return {
      name: "version",
      status: "WARN",
      message: `Version check skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Minimal semver comparator.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Pre-release segments (e.g. `2.0.0-next.0`) are *less than* their release counterpart
 * (`2.0.0`), per https://semver.org/#spec-item-11.
 * If either input fails to parse, returns 0 (treat as equal — no false positives).
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return null;
    return {
      core: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ? m[4].split(".") : [],
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  // Cores equal. A version with pre-release is < the same version without.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  // Compare pre-release segments per semver rules
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xn !== null) {
      return -1; // numeric < alpha per spec
    } else if (yn !== null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function statusIcon(s: CheckStatus): string {
  if (s === "PASS") return chalk.green("✓");
  if (s === "WARN") return chalk.yellow("⚠");
  return chalk.red("✗");
}

export function registerDoctorCommand(program: Command, currentVersion: string): void {
  program
    .command("doctor")
    .description("Self-check: auth, schema, reachability, state, version")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const auth = await checkAuth();
      const reachability = await checkReachability();
      // Only probe schema if auth passed; otherwise the schema check will spuriously fail.
      const schema = auth.status === "PASS" ? await checkSchema() : {
        name: "schema",
        status: "WARN" as const,
        message: "Schema check skipped (auth failed; fix auth first)",
      };
      const stateFiles = checkStateFiles();
      const version = await checkVersion(currentVersion);

      const checks = [auth, reachability, schema, stateFiles, version];
      const overall = rollUpStatus(checks);
      const report: DoctorReport = { checks, overall };

      if (opts.json) {
        jsonOutput({ ok: overall !== "FAIL", data: report });
        if (overall === "FAIL") process.exit(1);
        return;
      }

      console.log(chalk.bold("\nVoyagier CLI Doctor\n"));
      for (const c of checks) {
        console.log(`  ${statusIcon(c.status)} ${chalk.bold(c.name.padEnd(14))} ${c.message}`);
        if (c.details && (c.status === "FAIL" || c.status === "WARN")) {
          for (const [k, v] of Object.entries(c.details)) {
            if (Array.isArray(v)) {
              // One entry per line — drift lists get long; comma-joining is unreadable.
              console.log(chalk.dim(`      ${k}:`));
              for (const entry of v) console.log(chalk.dim(`        - ${String(entry)}`));
            } else {
              console.log(chalk.dim(`      ${k}: ${String(v)}`));
            }
          }
        }
      }
      const summaryLabel =
        overall === "PASS" ? chalk.green("All checks passed.") :
        overall === "WARN" ? chalk.yellow("Some warnings.") :
        chalk.red("One or more checks failed.");
      console.log(`\n  ${summaryLabel}\n`);

      if (overall === "FAIL") process.exit(1);
    });
}
