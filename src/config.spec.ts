import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, chmodSync } from "fs";
import { join } from "path";
import { loadCredentials, saveCredentials, clearCredentials, credentialsExist, getToken, CONFIG_DIR, assertSecureApiUrl } from "./config.js";
import { CliError, CliErrorCode } from "./errors.js";

const credFile = join(CONFIG_DIR, "credentials.json");

describe("config", () => {
  let originalCreds: string | null = null;

  beforeEach(() => {
    // Back up existing credentials
    if (existsSync(credFile)) {
      originalCreds = readFileSync(credFile, "utf-8");
    } else {
      originalCreds = null;
    }
    // Clear for clean test
    if (existsSync(credFile)) unlinkSync(credFile);
    delete process.env.VOYAGIER_TOKEN;
  });

  afterEach(() => {
    // Restore original credentials
    if (originalCreds !== null) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(credFile, originalCreds, { mode: 0o600 });
    } else if (existsSync(credFile)) {
      unlinkSync(credFile);
    }
    delete process.env.VOYAGIER_TOKEN;
  });

  describe("credentialsExist", () => {
    it("should return false when no credentials file exists", () => {
      expect(credentialsExist()).toBe(false);
    });

    it("should return true after saving credentials", () => {
      saveCredentials("test-token");
      expect(credentialsExist()).toBe(true);
    });

    it("should return true when VOYAGIER_TOKEN env var is set", () => {
      process.env.VOYAGIER_TOKEN = "env-tok";
      expect(credentialsExist()).toBe(true);
    });
  });

  describe("saveCredentials / loadCredentials", () => {
    it("saves and loads the token, and nothing else", () => {
      saveCredentials("my-token");
      expect(loadCredentials()).toEqual({ token: "my-token" });
      // The file holds exactly one key: no URL, no cached profile.
      expect(JSON.parse(readFileSync(credFile, "utf-8"))).toEqual({ token: "my-token" });
    });

    it("should set file permissions to 0600", () => {
      saveCredentials("tok");
      const { mode } = statSync(credFile);
      expect(mode & 0o777).toBe(0o600);
    });

    it("corrects a pre-existing loose-perm (0644) credentials file to 0600 (L2)", () => {
      // Simulate a credentials.json left world-readable by a hand-edit.
      // saveCredentials must chmod it back to owner-only.
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(credFile, "{}", { mode: 0o644 });
      chmodSync(credFile, 0o644); // defeat umask so the pre-state is truly 0644
      expect(statSync(credFile).mode & 0o777).toBe(0o644);

      saveCredentials("tok");
      expect(statSync(credFile).mode & 0o777).toBe(0o600);
    });

    it("corrects a pre-existing loose-perm (0755) config dir to 0700 (L1)", () => {
      // `mode` on mkdirSync only applies at creation — a dir left group/world
      // readable must be tightened on the next save.
      mkdirSync(CONFIG_DIR, { recursive: true });
      chmodSync(CONFIG_DIR, 0o755); // defeat umask so the pre-state is truly 0755
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o755);

      saveCredentials("tok");
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
    });

    it("should return null when credentials file doesn't exist", () => {
      expect(loadCredentials()).toBeNull();
    });

    it("returns null for a file without a token", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(credFile, JSON.stringify({ apiUrl: "https://example.com" }), { mode: 0o600 });
      expect(loadCredentials()).toBeNull();
      writeFileSync(credFile, "not json", { mode: 0o600 });
      expect(loadCredentials()).toBeNull();
    });

    it("reads only the token from a file that carries extra keys", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(credFile, JSON.stringify({ token: "t", apiUrl: "https://x", user: { name: "n" } }), { mode: 0o600 });
      expect(loadCredentials()).toEqual({ token: "t" });
    });

    it("should prefer VOYAGIER_TOKEN env var over file", () => {
      saveCredentials("file-token");
      process.env.VOYAGIER_TOKEN = "env-token";
      expect(loadCredentials()).toEqual({ token: "env-token" });
    });
  });

  describe("clearCredentials", () => {
    it("should remove the credentials file", () => {
      saveCredentials("tok");
      expect(existsSync(credFile)).toBe(true);
      clearCredentials();
      expect(existsSync(credFile)).toBe(false);
    });

    it("should not throw when file doesn't exist", () => {
      expect(() => clearCredentials()).not.toThrow();
    });

    it("should cause credentialsExist to return false", () => {
      saveCredentials("tok");
      clearCredentials();
      expect(credentialsExist()).toBe(false);
    });
  });

  describe("getToken", () => {
    it("should return token from saved credentials", () => {
      saveCredentials("saved-token");
      expect(getToken()).toBe("saved-token");
    });

    it("should prefer VOYAGIER_TOKEN env var", () => {
      saveCredentials("file-token");
      process.env.VOYAGIER_TOKEN = "env-token";
      expect(getToken()).toBe("env-token");
    });

    it("should throw CliError with AUTH_FAILED when no credentials exist", () => {
      try {
        getToken();
        fail("Expected CliError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(CliErrorCode.AUTH_FAILED);
        expect((err as CliError).message).toMatch(/Not authenticated/);
      }
    });
  });

  describe("assertSecureApiUrl", () => {
    it("accepts an https:// URL", () => {
      expect(() => assertSecureApiUrl("https://mcp.voyagier.com/api/mcp")).not.toThrow();
    });

    it("accepts http://localhost (loopback dev exemption)", () => {
      expect(() => assertSecureApiUrl("http://localhost:3000/api/mcp")).not.toThrow();
    });

    it("accepts http://127.0.0.1 (loopback dev exemption)", () => {
      expect(() => assertSecureApiUrl("http://127.0.0.1:8080")).not.toThrow();
    });

    it("rejects http:// on a non-loopback host with a VALIDATION CliError", () => {
      try {
        assertSecureApiUrl("http://evil.example.com/api");
        fail("Expected CliError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
        expect((err as CliError).message).toMatch(/Insecure URL/);
      }
    });

    it("rejects a non-http(s) scheme (ftp://) with a VALIDATION CliError", () => {
      try {
        assertSecureApiUrl("ftp://files.example.com/x");
        fail("Expected CliError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      }
    });

    it("rejects an unparseable URL with a VALIDATION CliError", () => {
      try {
        assertSecureApiUrl("not a url");
        fail("Expected CliError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
        expect((err as CliError).message).toMatch(/Invalid URL/);
      }
    });
  });
});
