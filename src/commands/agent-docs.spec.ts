import { describe, it, expect } from "@jest/globals";
import { loadAgentDocs, resolveAgentMdPath } from "./agent-docs.js";
import { existsSync } from "fs";

/**
 * agent-docs spec
 *
 * These assertions check that AGENT.md continues to describe the actual
 * v2.0.0-alpha CLI behavior, not an aspirational design. Each block here
 * is intentional — when a v2 surface lands or changes, both AGENT.md and
 * this spec should be updated together.
 *
 * Background: an earlier version of these tests asserted an aspirational
 * uniform JSON envelope and a `--client` flag on `plans create` that
 * neither exist in the v2 alpha. Copilot review on PR #48 caught the
 * drift; tests were narrowed to ground-truth claims and known-gap callouts.
 */
describe("agent-docs", () => {
  describe("resolveAgentMdPath", () => {
    it("should return a path ending with AGENT.md", () => {
      const path = resolveAgentMdPath();
      expect(path).toMatch(/AGENT\.md$/);
    });
  });

  describe("loadAgentDocs", () => {
    it("should load AGENT.md when it exists", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (existsSync(resolveAgentMdPath())) {
        expect(fromFallback).toBe(false);
        expect(content).toContain("Voyagier CLI");
        expect(content).toContain("--json");
      } else {
        // Fallback path
        expect(fromFallback).toBe(true);
        expect(content).toContain("Agent Quick Start");
      }
    });

    it("should document the v2 command groups", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // The five LOCKED-STABLE v2 surfaces shipped on 2026-05-03
        expect(content).toContain("voyagier doctor");
        expect(content).toContain("voyagier clients");
        expect(content).toContain("voyagier itinerary");
        expect(content).toContain("voyagier listings");
        expect(content).toContain("voyagier places");
        expect(content).toContain("voyagier plans bookable");
      }
    });

    it("should document the actual two JSON-payload styles (alpha is not uniform)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Style A — wrapped envelope used by Section 3 / 7 / 9 surfaces.
        expect(content).toContain('"ok": true');
        expect(content).toContain("planContext");
        // Style B — domain-specific shapes the older surfaces emit.
        // The doc lists at least the clients upsert and plans create payloads.
        expect(content).toMatch(/clients upsert/i);
        expect(content).toMatch(/plans create/i);
        // The doc must be honest that the envelope is not uniform.
        expect(content).toMatch(/not\s+(yet\s+)?uniform/i);
      }
    });

    it("should classify `voyagier doctor` as Style A (wrapped envelope)", () => {
      // Regression: an earlier draft put `doctor` under Style B. The runtime
      // (src/commands/doctor.ts) emits { ok, data: { checks, overall } }, so
      // it belongs in the Style A list and the doctor section must show the
      // wrapped shape with `data.checks` and `data.overall`.
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Doctor must be named in the Style A surface roster.
        const styleAHeader = content.match(/Style A.*?\n/);
        expect(styleAHeader?.[0]?.toLowerCase()).toContain("doctor");
        // Doctor section heading carries the Style A label.
        expect(content).toMatch(/###\s+Doctor.*Style A/);
        // The actual key is `overall`, not `summary`.
        expect(content).toContain("overall");
        expect(content).toMatch(/data:\s*{\s*checks/);
      }
    });

    it("should document the actual error envelope shape (no `fix` field today)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Real shape: { error: true, code, message, details? }
        expect(content).toContain('"error": true');
        expect(content).toContain('"code"');
        expect(content).toContain('"message"');
      }
    });

    it("should not show top-level `ok: false` in error examples", () => {
      // Regression: the BOOKING_BLOCKED sample used to include `"ok": false`,
      // which the runtime never emits. The top-level error handler
      // (src/index.ts) writes only { error, code, message, details? } for
      // CliError. Strict JSON consumers checking `payload.ok === false` would
      // have parsed real errors as success.
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).not.toContain('"ok": false');
      }
    });

    it("should document the --plan safety rail and explain the cross-plan rationale", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).toContain("--plan");
        expect(content.toLowerCase()).toContain("cross-plan");
      }
    });

    it("should document only error codes that the CLI actually emits", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Codes from src/errors.ts that the runtime can throw.
        expect(content).toContain("AUTH_FAILED");
        expect(content).toContain("VALIDATION");
        expect(content).toContain("NOT_FOUND");
        expect(content).toContain("BOOKING_BLOCKED");
        expect(content).toContain("NOT_BOOKABLE");
        expect(content).toContain("SCHEMA_DRIFT");
        // CLIENT_REQUIRED is in the enum but reserved for VOY-1193; the doc
        // should mention it AND flag it as not-yet-emitted to avoid setting
        // a false branching expectation.
        expect(content).toContain("CLIENT_REQUIRED");
      }
    });

    it("should NOT promise an `AUTH_REQUIRED` code (it isn't in CliErrorCode)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // AGENT.md must use AUTH_FAILED, not AUTH_REQUIRED. AUTH_REQUIRED
        // is not a defined CliErrorCode and the runtime never emits it,
        // so documenting it as branchable would mislead agents.
        expect(content).not.toContain("AUTH_REQUIRED");
      }
    });

    it("should document the bookability matrix honestly", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Flights book via the fare-level (Fare & Cabin / FlightClass) cart item,
        // generated once all legs are picked — verified bookable on prod 2026-07-20.
        // The stale "display only" claim must never come back.
        expect(content).toMatch(/Flight.*Fare & Cabin/i);
        expect(content).not.toMatch(/Flight.*display only|display only.*Flight/i);
        // Activities remain a bookable path (supplier named generically —
        // internal supplier brands are deliberately not shipped in the docs).
        expect(content).toMatch(/Activity.*✅ per slot/i);
        expect(content.toLowerCase()).not.toContain("viator");
      }
    });

    it("should document the book price hard-gate and idempotency pre-flight (VOY-1706)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // A real checkout requires a price gate; the doc must teach the flow.
        expect(content).toContain("--expect-total");
        expect(content).toContain("--max-total");
        expect(content).toContain("chargeableSubtotal");
        expect(content).toContain("PRICE_CHANGED");
        expect(content).toContain("ALREADY_BOOKED");
        expect(content).toContain("--rebook");
        // CHECKOUT_PENDING / --new-session must NOT be documented: the server
        // excludes Pending rows from tripPlanPaymentCheckouts (WHERE status !=
        // Pending in nest-api), so a pending-session pre-flight is impossible
        // today — documenting it would promise idempotency that doesn't exist.
        expect(content).not.toContain("CHECKOUT_PENDING");
        expect(content).not.toContain("--new-session");
        // The doc must be honest that unpaid sessions are invisible to the CLI.
        expect(content.toLowerCase()).toMatch(/pending.*(invisible|excluded|not (visible|returned))/);
        // The gate must not overclaim: point-in-time snapshot, not a guarantee.
        expect(content.toLowerCase()).not.toMatch(/gate guarantees/);
        // book --types / --only-bookable are SERVER-side filters and the
        // checkout is always item-pinned (itemIds on createTripPlanCheckout,
        // introspection-verified 2026-07-20). No stale client-side framing.
        expect(content.toLowerCase()).toContain("server-side");
        expect(content).toContain("itemIds");
        expect(content.toLowerCase()).not.toMatch(/client-side (preflight )?gates/);
      }
    });

    it("should document quote/send honestly (VOY-1212: two closes, no doc rendering, no embedded pay links)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Both closes must be taught: self-serve (send → webapp) and
        // advisor-mediated (quote → book --expect-total).
        expect(content).toContain("voyagier quote");
        expect(content).toContain("voyagier send");
        expect(content).toContain("CONFIRMATION_REQUIRED");
        // quote's total and book's gate share one rounding — the doc makes
        // the quoted ≡ gated promise, which quote.spec proves by execution.
        expect(content.toLowerCase()).toMatch(/quoted\s*≡\s*gated|quoted ≡ gated/);
        // send is not idempotent and must require --yes non-interactively.
        expect(content.toLowerCase()).toMatch(/send.*not idempotent|not idempotent.*send/);
        // quote must NOT promise document rendering or embedded payment links
        // (killed in planning: webapp is the offer surface; links go stale).
        expect(content).not.toMatch(/quote[^\n]*--format/);
        expect(content).not.toMatch(/quote[^\n]*(pdf|--output)/i);
      }
    });

    it("should document the cold-agent UX contract (VOY-1714: compact search, third pick, unverified blockers, drift classes)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Search: compact envelope is the default; the full dump is opt-in.
        expect(content).toContain("topOptions");
        expect(content).toContain("--full");
        expect(content).toContain("optionCount");
        // The stale pre-VOY-1692 async narrative must NOT come back: options
        // are inline when the reused selection already has inventory. The
        // original stale phrasings were "often **no options yet**" (markdown
        // bold between the words), "options often empty initially", and the
        // Known Quirks "Search is asynchronous." — pin all three shapes.
        expect(content).not.toMatch(/often\s+(\*\*)?no options yet/);
        expect(content).not.toMatch(/options often empty/);
        expect(content).not.toMatch(/Search is asynchronous/);
        // The fare/cabin third pick is a first-class Quick Start step.
        expect(content).toContain("Flight Booking Details");
        expect(content).toMatch(/defaults to Economy/i);
        // Leg-mirrored option ids are documented as intended behavior.
        expect(content).toMatch(/leg-mirrored/i);
        // Unverified blockers + the dry-run tie-breaker rule.
        expect(content).toContain("unverified");
        expect(content).toMatch(/checkout truth/i);
        // plans goals is documented as Style A (was wrongly Style B).
        expect(content).not.toMatch(/Goals \(readiness view, Style B/);
        // doctor drift classes: peripheral drift must carry a go-ahead.
        expect(content).toMatch(/safe to proceed/i);
        expect(content).toContain("coreDrifted");
      }
    });

    it("should describe the actual state-file layout (global, not per-plan)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // The CLI uses a single global last-search.json + last-options.json,
        // not per-plan files. Cross-plan corruption is prevented by --plan
        // mismatch checks at the command layer. The doc must reflect this.
        expect(content).toContain("last-search.json");
        expect(content).toContain("last-options.json");
        expect(content.toLowerCase()).toMatch(/global.*single|single.*global|not\s+per-plan/);
        // No last-clients.json cache exists today; the doc should NOT
        // claim one.
        expect(content).not.toContain("last-clients.json");
      }
    });

    it("should document --idempotency-key as a per-command flag, not universal", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // --idempotency-key exists on listings add-to-selection and a few
        // places mutations. It was REMOVED from `book` in VOY-1706 (it was a
        // JSON-echo no-op there; real idempotency is the checkout pre-flight).
        expect(content).toContain("--idempotency-key");
        expect(content).toContain("listings add-to-selection");
        expect(content).not.toMatch(/voyagier book <planId> --idempotency-key/);
        // Doc should NOT say it's accepted by every mutation.
        expect(content.toLowerCase()).not.toMatch(/every mutating command accepts/);
      }
    });

    it("should not contain hardcoded calendar dates in flag examples without context", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Concrete calendar dates inside a runnable Quick Start block are
        // acceptable as illustrative ISO timestamps; what we want to avoid
        // is auto-staleness from things like "release notes mention --date 2024-01-01"
        // in marketing copy. The current AGENT.md uses 2026 dates as part of
        // working examples, which is fine. This guard is preserved as a
        // tripwire: if dates ever appear inline in normative prose, flag it.
        const calendarDateMatches = content.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
        // We expect a small number of ISO dates inside example payloads;
        // a sudden explosion of them likely indicates hand-baked dates
        // creeping into the doc. Keep the threshold generous but bounded.
        expect(calendarDateMatches.length).toBeLessThan(40);
      }
    });
  });
});
