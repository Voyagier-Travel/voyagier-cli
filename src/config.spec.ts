import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, chmodSync } from "fs";
import { join } from "path";
import { loadCredentials, saveCredentials, clearCredentials, credentialsExist, getToken, getApiUrl, CONFIG_DIR, saveUserContext, getUserContext, getHomeAirports, getPreferredCabin, assertSecureApiUrl } from "./config.js";
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
    delete process.env.VOYAGIER_API_URL;
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
    delete process.env.VOYAGIER_API_URL;
  });

  describe("credentialsExist", () => {
    it("should return false when no credentials file exists", () => {
      expect(credentialsExist()).toBe(false);
    });

    it("should return true after saving credentials", () => {
      saveCredentials("test-token", "https://api.example.com");
      expect(credentialsExist()).toBe(true);
    });

    it("should return true when VOYAGIER_TOKEN env var is set", () => {
      process.env.VOYAGIER_TOKEN = "env-tok";
      expect(credentialsExist()).toBe(true);
    });
  });

  describe("saveCredentials / loadCredentials", () => {
    it("should save and load token + apiUrl", () => {
      saveCredentials("my-token", "https://api.voyagier.com");
      const creds = loadCredentials();
      expect(creds).toEqual({
        token: "my-token",
        apiUrl: "https://api.voyagier.com",
      });
    });

    it("should set file permissions to 0600", () => {
      saveCredentials("tok", "https://example.com");
      const { mode } = statSync(credFile);
      expect(mode & 0o777).toBe(0o600);
    });

    it("corrects a pre-existing loose-perm (0644) credentials file to 0600 (L2)", () => {
      // Simulate a credentials.json left world-readable by an older version or a
      // hand-edit. saveCredentials must chmod it back to owner-only.
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(credFile, "{}", { mode: 0o644 });
      chmodSync(credFile, 0o644); // defeat umask so the pre-state is truly 0644
      expect(statSync(credFile).mode & 0o777).toBe(0o644);

      saveCredentials("tok", "https://example.com");
      expect(statSync(credFile).mode & 0o777).toBe(0o600);
    });

    it("corrects a pre-existing loose-perm (0755) config dir to 0700 (L1)", () => {
      // `mode` on mkdirSync only applies at creation — a dir left group/world
      // readable by an older version must be tightened on the next save.
      mkdirSync(CONFIG_DIR, { recursive: true });
      chmodSync(CONFIG_DIR, 0o755); // defeat umask so the pre-state is truly 0755
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o755);

      saveCredentials("tok", "https://example.com");
      expect(statSync(CONFIG_DIR).mode & 0o777).toBe(0o700);
    });

    it("should return null when credentials file doesn't exist", () => {
      expect(loadCredentials()).toBeNull();
    });

    it("should prefer VOYAGIER_TOKEN env var over file", () => {
      saveCredentials("file-token", "https://file.com");
      process.env.VOYAGIER_TOKEN = "env-token";
      const creds = loadCredentials();
      expect(creds?.token).toBe("env-token");
    });

    it("should use VOYAGIER_API_URL with VOYAGIER_TOKEN", () => {
      process.env.VOYAGIER_TOKEN = "env-tok";
      process.env.VOYAGIER_API_URL = "https://env-api.com";
      const creds = loadCredentials();
      expect(creds?.apiUrl).toBe("https://env-api.com");
    });
  });

  describe("clearCredentials", () => {
    it("should remove the credentials file", () => {
      saveCredentials("tok", "https://example.com");
      expect(existsSync(credFile)).toBe(true);
      clearCredentials();
      expect(existsSync(credFile)).toBe(false);
    });

    it("should not throw when file doesn't exist", () => {
      expect(() => clearCredentials()).not.toThrow();
    });

    it("should cause credentialsExist to return false", () => {
      saveCredentials("tok", "https://example.com");
      clearCredentials();
      expect(credentialsExist()).toBe(false);
    });
  });

  describe("getToken", () => {
    it("should return token from saved credentials", () => {
      saveCredentials("saved-token", "https://api.voyagier.com");
      expect(getToken()).toBe("saved-token");
    });

    it("should prefer VOYAGIER_TOKEN env var", () => {
      saveCredentials("file-token", "https://api.voyagier.com");
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

  describe("getApiUrl", () => {
    it("should return saved apiUrl", () => {
      saveCredentials("tok", "https://custom-api.voyagier.com");
      expect(getApiUrl()).toBe("https://custom-api.voyagier.com");
    });

    it("should prefer env vars when VOYAGIER_TOKEN is set", () => {
      process.env.VOYAGIER_TOKEN = "env-tok";
      process.env.VOYAGIER_API_URL = "https://env-override.com";
      expect(getApiUrl()).toBe("https://env-override.com");
    });

    it("should fall back to default when no credentials", () => {
      const url = getApiUrl();
      expect(url).toBe("https://travel.voyagier.com/api");
    });
  });

  describe("saveUserContext / getUserContext", () => {
    it("saves and retrieves user context", () => {
      saveCredentials("tok_test", "https://test.com");
      const user = {
        id: "u1",
        name: "Test User",
        email: "test@test.com",
        homeAirports: ["BWI", "DCA"],
        preferredCabin: "business" as const,
      };
      saveUserContext(user);
      const ctx = getUserContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.name).toBe("Test User");
      expect(ctx!.homeAirports).toEqual(["BWI", "DCA"]);
      expect(ctx!.preferredCabin).toBe("business");
    });

    it("returns null when no user context saved", () => {
      saveCredentials("tok_test", "https://test.com");
      expect(getUserContext()).toBeNull();
    });

    it("throws when not authenticated", () => {
      expect(() => saveUserContext({
        id: "u1", name: "X", email: "x@x.com", homeAirports: [],
      })).toThrow("Not authenticated");
    });

    it("preserves user context when saveCredentials is called", () => {
      saveCredentials("tok_old", "https://test.com");
      saveUserContext({
        id: "u1", name: "Test", email: "t@t.com", homeAirports: ["JFK"],
      });
      // Re-save credentials (simulating set-token)
      saveCredentials("tok_new", "https://test2.com");
      const ctx = getUserContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.homeAirports).toEqual(["JFK"]);
    });

    it("does not persist env token to disk via saveUserContext", () => {
      // Write file credentials first
      saveCredentials("tok_file", "https://test.com");
      // Set env override
      process.env.VOYAGIER_TOKEN = "tok_env";
      // Save user context — should use file token, not env
      saveUserContext({
        id: "u1", name: "Test", email: "t@t.com", homeAirports: ["BWI"],
      });
      delete process.env.VOYAGIER_TOKEN;
      // Read back — token should still be file token
      const creds = loadCredentials();
      expect(creds!.token).toBe("tok_file");
    });
  });

  describe("getHomeAirports", () => {
    it("returns empty array when no context", () => {
      expect(getHomeAirports()).toEqual([]);
    });

    it("returns airports from saved context", () => {
      saveCredentials("tok", "https://test.com");
      saveUserContext({
        id: "u1", name: "T", email: "t@t.com", homeAirports: ["BWI", "IAD", "DCA"],
      });
      expect(getHomeAirports()).toEqual(["BWI", "IAD", "DCA"]);
    });
  });

  describe("getPreferredCabin", () => {
    it("returns null when no context", () => {
      expect(getPreferredCabin()).toBeNull();
    });

    it("returns cabin from saved context", () => {
      saveCredentials("tok", "https://test.com");
      saveUserContext({
        id: "u1", name: "T", email: "t@t.com", homeAirports: [],
        preferredCabin: "first",
      });
      expect(getPreferredCabin()).toBe("first");
    });
  });

  describe("assertSecureApiUrl", () => {
    it("accepts an https:// URL", () => {
      expect(() => assertSecureApiUrl("https://travel.voyagier.com/api")).not.toThrow();
    });

    it("accepts http://localhost (loopback dev exemption)", () => {
      expect(() => assertSecureApiUrl("http://localhost:3000/api")).not.toThrow();
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
        expect((err as CliError).message).toMatch(/Insecure API URL/);
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
        expect((err as CliError).message).toMatch(/Invalid API URL/);
      }
    });

    it("is enforced on the read path: a cleartext VOYAGIER_API_URL makes getApiUrl throw", () => {
      // A token + insecure URL supplied via env must never be consumed — the
      // token would otherwise be sent as a Bearer header over cleartext http://.
      process.env.VOYAGIER_TOKEN = "env-tok";
      process.env.VOYAGIER_API_URL = "http://evil.example.com/api";
      try {
        getApiUrl();
        fail("Expected CliError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(CliErrorCode.VALIDATION);
      }
    });
  });

});
