import { describe, it, expect, beforeAll } from "@jest/globals";
import type { Command } from "commander";
import { buildProgram } from "./build-program.js";
import { loadAgentDocs } from "./commands/agent-docs.js";

/**
 * Doc-drift guard (VOY-1437 follow-up)
 * ------------------------------------
 * The CLI's only consumer is an AI agent, which treats the docs as a contract,
 * not a hint. Stale docs don't merely inconvenience it — they send it building
 * on commands/flags that no longer exist. (This exact drift — docs referencing
 * a removed `--auto-select` flag and "broken" commands long after they changed —
 * cost a full investigation session on 2026-06-07.)
 *
 * This guard fails the build when AGENT.md (or the top-level help text) names a
 * `voyagier <command>` or `--flag` that the real Commander tree does not expose.
 * It is intentionally a STRUCTURAL existence check, not a prose check — the
 * other agent-docs.spec.ts assertions cover content/semantics.
 */

// ---- Build a model of the real command surface -----------------------------

interface CommandModel {
  /** Full path, e.g. "plans create". Root program is "". */
  path: string;
  /** Long-form option flags declared on this command, e.g. "--json". */
  flags: Set<string>;
}

function collectCommands(cmd: Command, prefix: string, out: Map<string, CommandModel>): void {
  for (const sub of cmd.commands) {
    const name = sub.name();
    if (!name || name === "help") continue;
    const path = prefix ? `${prefix} ${name}` : name;

    const flags = new Set<string>();
    for (const opt of sub.options) {
      // opt.long is the "--xyz" form (may be undefined for short-only opts).
      if (opt.long) flags.add(opt.long);
    }
    out.set(path, { path, flags });

    collectCommands(sub, path, out);
  }
}

/** Global flags available on every command (declared on the root program). */
function collectGlobalFlags(program: Command): Set<string> {
  const flags = new Set<string>(["--help", "--version"]);
  for (const opt of program.options) {
    if (opt.long) flags.add(opt.long);
  }
  return flags;
}

// ---- Extract references out of the docs ------------------------------------

/**
 * Find every `voyagier <command...>` invocation in the doc text and return the
 * command path (longest matching known command prefix) plus the flags used.
 */
function extractInvocations(
  text: string,
  knownPaths: Set<string>,
): Array<{ raw: string; path: string | null; flags: string[] }> {
  const results: Array<{ raw: string; path: string | null; flags: string[] }> = [];
  // Only treat ACTUAL command lines as invocations: a line whose first
  // non-whitespace token is `voyagier` (optionally prefixed by a `$` prompt).
  // This deliberately ignores inline prose references like "`voyagier doctor`
  // verifies ...", which are sentences, not runnable examples, and would
  // otherwise produce false positives from trailing punctuation.
  for (const lineRaw of text.split("\n")) {
    const line = lineRaw.trim();
    const lm = line.match(/^\$?\s*voyagier\s+(.*)$/);
    if (!lm) continue;
    // Strip a trailing inline comment (# ...) from the example.
    const rest = lm[1].replace(/\s+#.*$/, "").trim();
    if (!rest) continue;
    // Tokenize: split on whitespace, drop line-continuation backslashes.
    const tokens = rest.split(/\s+/).filter((t) => t && t !== "\\");

    // Command path = leading non-flag tokens that form a known command path.
    // Greedily take up to 3 leading bareword tokens, then shrink to the
    // longest prefix that is a known command path.
    const barewords: string[] = [];
    for (const t of tokens) {
      if (t.startsWith("-")) break;
      // Stop at obvious argument placeholders / values.
      if (/^[<"]/.test(t)) break;
      barewords.push(t);
      if (barewords.length >= 3) break;
    }
    let path: string | null = null;
    for (let take = Math.min(barewords.length, 3); take >= 1; take--) {
      const candidate = barewords.slice(0, take).join(" ");
      if (knownPaths.has(candidate)) {
        path = candidate;
        break;
      }
    }

    // Normalize flag tokens: a flag name is --[a-z][a-z0-9-]*. Strip LEADING
    // doc punctuation that wraps optional flags ([--flag ...], `--flag`,
    // (--flag)) before matching, and any trailing value (--flag=x) / prose
    // punctuation. Without the leading-strip the guard would silently miss
    // bracketed/backticked flag references and fail to enforce them.
    const flags: string[] = [];
    for (const rawTok of tokens) {
      const t = rawTok.replace(/^[[(`'"]+/, "");
      const fm = t.match(/^(--[a-z][a-z0-9-]*)/i);
      if (fm) flags.push(fm[1]);
    }
    results.push({ raw: `voyagier ${rest}`, path, flags });
  }
  return results;
}

// ---- The guard -------------------------------------------------------------

describe("doc-drift guard", () => {
  let commands: Map<string, CommandModel>;
  let knownPaths: Set<string>;
  let globalFlags: Set<string>;
  let content: string;
  let fromFallback: boolean;
  let corpus: string;
  let invocations: Array<{ raw: string; path: string | null; flags: string[] }>;

  beforeAll(() => {
    const program = buildProgram("0.0.0-test");
    commands = new Map<string, CommandModel>();
    collectCommands(program, "", commands);
    knownPaths = new Set(commands.keys());
    globalFlags = collectGlobalFlags(program);

    ({ content, fromFallback } = loadAgentDocs());
    // Always guard the built-in help/quick-start text; add AGENT.md when present.
    const helpText = program.helpInformation();
    corpus = `${helpText}\n${content}`;

    invocations = extractInvocations(corpus, knownPaths);
  });

  it("builds a non-trivial command surface (sanity)", () => {
    // If this ever collapses, the extraction below would vacuously pass.
    expect(knownPaths.size).toBeGreaterThan(20);
    expect(knownPaths.has("plans create")).toBe(true);
    expect(knownPaths.has("selection-options")).toBe(true);
  });

  it("references at least one real voyagier command (extraction sanity)", () => {
    const recognized = invocations.filter((i) => i.path !== null);
    expect(recognized.length).toBeGreaterThan(3);
  });

  it("every documented `voyagier <command>` exists in the CLI", () => {
    // A doc line whose leading barewords match no known command path is drift —
    // UNLESS it's a bareword-free invocation (e.g. `voyagier --help`) or a
    // generic placeholder like `voyagier <command>`.
    const drift: string[] = [];
    for (const inv of invocations) {
      if (inv.path !== null) continue;
      // Allow flag-only invocations (voyagier --help / --version).
      const firstToken = inv.raw.replace(/^voyagier\s+/, "").split(/\s+/)[0] ?? "";
      if (firstToken.startsWith("-")) continue;
      // Allow explicit placeholders.
      if (/^[<\[]/.test(firstToken)) continue;
      drift.push(inv.raw);
    }
    expect(drift).toEqual([]);
  });

  it("every documented --flag exists on the command it's shown with", () => {
    const drift: Array<{ command: string; flag: string }> = [];
    for (const inv of invocations) {
      if (inv.path === null) continue;
      const model = commands.get(inv.path)!;
      for (const flag of inv.flags) {
        if (model.flags.has(flag)) continue;
        if (globalFlags.has(flag)) continue;
        drift.push({ command: inv.path, flag });
      }
    }
    expect(drift).toEqual([]);
  });

  it("regression: the removed --auto-select flag is not referenced anywhere", () => {
    // VOY-1189 removed --auto-select; VOY-1437 corrected the docs. If it ever
    // reappears in the docs without a real flag behind it, fail loudly.
    if (!fromFallback) {
      const referencesAutoSelect = /--auto-select\b/.test(corpus);
      const hasAutoSelectFlag = [...commands.values()].some((c) => c.flags.has("--auto-select"));
      expect(referencesAutoSelect && !hasAutoSelectFlag).toBe(false);
    }
  });
});
