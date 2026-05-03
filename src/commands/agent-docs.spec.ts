import { describe, it, expect } from "@jest/globals";
import { loadAgentDocs, resolveAgentMdPath } from "./agent-docs.js";
import { existsSync } from "fs";

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

    it("should document the v2 envelope contract", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Standard JSON envelope shape
        expect(content).toContain("planContext");
        expect(content).toContain('"ok": true');
        expect(content).toContain('"ok": false');
        // Error envelope fields
        expect(content).toContain('"code"');
        expect(content).toContain('"fix"');
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

    it("should document the --plan safety rail", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).toContain("--plan");
        // Cross-plan state corruption rationale is part of the safety story.
        expect(content.toLowerCase()).toContain("cross-plan");
      }
    });

    it("should document agent-relevant error codes", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).toContain("AUTH_FAILED");
        expect(content).toContain("VALIDATION");
        // v2-specific codes worth surfacing for branching agents
        expect(content).toContain("CLIENT_REQUIRED");
        expect(content).toContain("BOOKING_BLOCKED");
        expect(content).toContain("SCHEMA_DRIFT");
      }
    });

    it("should document the bookability matrix", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Flights are explicitly non-bookable in v2.
        expect(content).toMatch(/Flight.*display only|display only.*Flight|Flight.*\u274c/i);
        // Activities (Viator) are the primary bookable path.
        expect(content.toLowerCase()).toContain("viator");
      }
    });

    it("should flag the known v2 gap (VOY-1189)", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // plan-trip --auto-select is broken on v2 schema; doc must say so
        // until VOY-1189 is fixed so agents don't try to use it.
        expect(content).toContain("VOY-1189");
      }
    });

    it("should not contain hardcoded calendar dates in flag examples", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Dates in ISO timestamps (e.g. "2026-09-15T18:30:00Z" inside a
        // JSON example) are illustrative and acceptable. Bare `--depart YYYY-MM-DD`
        // / `--return YYYY-MM-DD` flags should use placeholders so the doc
        // doesn't go stale.
        expect(content).not.toMatch(/--depart \d{4}-\d{2}-\d{2}\b/);
        expect(content).not.toMatch(/--return \d{4}-\d{2}-\d{2}\b/);
      }
    });
  });
});
