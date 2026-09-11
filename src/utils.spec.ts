import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { openBrowser, sanitizeExternalText, sanitizeExternalData } from "./utils.js";
import { CliError, CliErrorCode } from "./errors.js";

describe("openBrowser", () => {

  it("does not throw on any platform", () => {
    // openBrowser swallows errors — just verify it doesn't throw
    expect(() => openBrowser("https://example.com")).not.toThrow();
  });

  it("does not throw for an http:// URL (allowed web scheme)", () => {
    expect(() => openBrowser("http://example.com/path")).not.toThrow();
  });

  it("refuses a file:// URL before spawning (L4)", () => {
    // The scheme guard runs before spawn, so nothing is ever launched.
    try {
      openBrowser("file:///etc/passwd");
      fail("Expected CliError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      expect((err as CliError).message).toMatch(/non-web URL/);
    }
  });

  it("refuses a custom-scheme URL (L4)", () => {
    try {
      openBrowser("voyagier://checkout/steal");
      fail("Expected CliError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
    }
  });

  it("refuses a malformed URL (L4)", () => {
    try {
      openBrowser("not a url");
      fail("Expected CliError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      expect((err as CliError).message).toMatch(/malformed URL/);
    }
  });
});

describe("sanitizeExternalText", () => {
  it("strips ANSI CSI sequences (color, cursor movement, screen clear)", () => {
    expect(sanitizeExternalText("\u001b[31mRed Hotel\u001b[0m")).toBe("Red Hotel");
    expect(sanitizeExternalText("\u001b[2J\u001b[HGrand Plaza")).toBe("Grand Plaza");
  });

  it("strips OSC sequences (terminal title spoofing)", () => {
    expect(sanitizeExternalText("\u001b]0;pwned\u0007Hilton")).toBe("Hilton");
    expect(sanitizeExternalText("\u001b]8;;https://evil.example\u001b\\Click\u001b]8;;\u001b\\")).toBe("Click");
  });

  it("strips stray control characters and DEL but keeps newline/tab", () => {
    expect(sanitizeExternalText("a\u0000b\u0007c\u007fd")).toBe("abcd");
    expect(sanitizeExternalText("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it("strips a bare ESC that is not part of a well-formed sequence", () => {
    expect(sanitizeExternalText("safe\u001bhotel")).toBe("safehotel");
  });

  it("leaves legitimate travel data untouched", () => {
    expect(sanitizeExternalText("Fairmont Château Lake Louise — Deluxe, $1,299")).toBe(
      "Fairmont Château Lake Louise — Deluxe, $1,299",
    );
  });
});

describe("sanitizeExternalData", () => {
  it("recursively sanitizes nested objects and arrays", () => {
    const dirty = {
      plan: {
        title: "\u001b[31mTrip\u001b[0m",
        options: [{ name: "Hotel\u0007 A", price: 100 }, { name: "OK", price: null }],
      },
    };
    expect(sanitizeExternalData(dirty)).toEqual({
      plan: {
        title: "Trip",
        options: [{ name: "Hotel A", price: 100 }, { name: "OK", price: null }],
      },
    });
  });

  it("passes through non-string primitives and null untouched", () => {
    expect(sanitizeExternalData(42)).toBe(42);
    expect(sanitizeExternalData(true)).toBe(true);
    expect(sanitizeExternalData(null)).toBe(null);
    expect(sanitizeExternalData([1, "a\u0000b"])).toEqual([1, "ab"]);
  });
});

describe("sanitizeExternalText — C1 controls and prototype safety (verifier findings)", () => {
  it("strips C1 single-codepoint controls (CSI U+009B, OSC U+009D, DCS U+0090)", () => {
    expect(sanitizeExternalText("\u009b2JEvil")).toBe("2JEvil");
    expect(sanitizeExternalText("\u009b31mRed Hotel")).toBe("31mRed Hotel");
    expect(sanitizeExternalText("a\u009db\u0090c\u009fd")).toBe("abcd");
  });
});

describe("sanitizeExternalData — prototype pollution resistance", () => {
  it("drops own __proto__/constructor/prototype keys instead of assigning them", () => {
    const hostile = JSON.parse('{"name":"ok","__proto__":{"polluted":"yes"},"constructor":{"x":1}}');
    const out = sanitizeExternalData(hostile) as Record<string, unknown>;
    expect(out.name).toBe("ok");
    expect(out.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
