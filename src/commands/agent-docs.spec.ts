import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
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
      // AGENT.md exists in the repo root during tests
      if (existsSync(resolveAgentMdPath())) {
        expect(fromFallback).toBe(false);
        expect(content).toContain("Voyagier CLI");
        expect(content).toContain("auto-select");
        expect(content).toContain("navigator");
        expect(content).toContain("--json");
      } else {
        // Fallback path
        expect(fromFallback).toBe(true);
        expect(content).toContain("Agent Quick Start");
      }
    });

    it("should include JSON response contract in AGENT.md", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).toContain("planContext");
        expect(content).toContain("alternatives");
        expect(content).toContain("nextSteps");
        expect(content).toContain("rankReason");
      }
    });

    it("should include safety rails documentation", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).toContain("--plan");
        expect(content).toContain("actionRequired");
        expect(content).toContain("Safety rails");
      }
    });

    it("should include error handling documentation", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        expect(content).toContain("AUTH_FAILED");
        expect(content).toContain("VALIDATION");
        expect(content).toContain("error");
      }
    });

    it("should not contain hardcoded dates", () => {
      const { content, fromFallback } = loadAgentDocs();
      if (!fromFallback) {
        // Dates in example JSON values (like "PT10H5M") are fine,
        // but full calendar dates should use placeholders
        expect(content).not.toMatch(/--depart \d{4}-\d{2}-\d{2}/);
        expect(content).not.toMatch(/--return \d{4}-\d{2}-\d{2}/);
      }
    });
  });
});
