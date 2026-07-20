import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import chalk from "chalk";
import { join } from "path";
import { homedir } from "os";
import { CliError, CliErrorCode, authFailedMessage } from "./errors.js";

/**
 * Config dir chokepoint. `VOYAGIER_CONFIG_DIR` overrides the default
 * `~/.voyagier` — set by the jest bootstrap for EVERY test run so specs can
 * never read or wipe real credentials/state (a live PAT was deleted by a
 * crashed test run before this existed), and available to users for
 * sandboxed/multi-account setups.
 */
export const CONFIG_DIR = process.env.VOYAGIER_CONFIG_DIR || join(homedir(), ".voyagier");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface UserContext {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  email: string;
  dateOfBirth?: string;
  gender?: string;
  location?: string;
  city?: string;
  country?: string;
  homeAirports: string[];
  preferredCabin?: "economy" | "premium_economy" | "business" | "first";
  passport?: {
    last4: string;
    issueCountry: string;
    nationalityCountry: string;
    expirationDate: string;
  };
  frequentFlyerPrograms?: Array<{
    airlineCode: string;
    membershipNumber: string;
  }>;
}

interface Credentials {
  token: string;
  apiUrl: string;
  user?: UserContext;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// Load credentials directly from file, ignoring environment variables.
// Used when we need to preserve/merge on-disk data (user context).
function loadFileCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
    const creds = JSON.parse(raw) as Credentials;
    if (!creds.token) return null;
    return creds;
  } catch {
    return null;
  }
}

export function saveCredentials(token: string, apiUrl: string = "https://travel.voyagier.com/api"): void {
  ensureConfigDir();
  // Preserve existing user context from file (not env vars)
  const existing = loadFileCredentials();
  const creds: Credentials = { token, apiUrl };
  if (existing?.user) creds.user = existing.user;
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function saveUserContext(user: UserContext): void {
  ensureConfigDir();
  // Read from file only — don't persist env-based tokens to disk
  const existing = loadFileCredentials();
  if (!existing) {
    throw new Error("Not authenticated. Run: voyagier auth set-token <token>");
  }
  const creds: Credentials = { ...existing, user };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function getUserContext(): UserContext | null {
  const creds = loadCredentials();
  return creds?.user ?? null;
}

export function getHomeAirports(): string[] {
  const user = getUserContext();
  return user?.homeAirports ?? [];
}

export function getPreferredCabin(): string | null {
  const user = getUserContext();
  return user?.preferredCabin ?? null;
}

export function loadCredentials(): Credentials | null {
  const envToken = process.env.VOYAGIER_TOKEN;
  const envUrl = process.env.VOYAGIER_API_URL;
  if (envToken) {
    return { token: envToken, apiUrl: envUrl ?? "https://travel.voyagier.com/api" };
  }

  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
    const creds = JSON.parse(raw) as Credentials;
    if (!creds.token) return null;
    return creds;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    unlinkSync(CREDENTIALS_FILE);
  }
}

export function getApiUrl(): string {
  const creds = loadCredentials();
  return creds?.apiUrl ?? "https://travel.voyagier.com/api";
}

export function getToken(): string {
  const creds = loadCredentials();
  if (!creds?.token) {
    throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Not authenticated."));
  }
  return creds.token;
}

export function credentialsExist(): boolean {
  if (process.env.VOYAGIER_TOKEN) return true;
  return existsSync(CREDENTIALS_FILE);
}
