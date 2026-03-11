import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { loadCredentials, saveCredentials, clearCredentials, credentialsExist, getToken, getApiUrl, CONFIG_DIR } from "./config.js";

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

    it("should exit when no credentials exist", () => {
      const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(() => getToken()).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      stderrSpy.mockRestore();
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
      expect(url).toBe("https://voyagier.com");
    });
  });
});
