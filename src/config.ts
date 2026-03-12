import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const CONFIG_DIR = join(homedir(), ".voyagier");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface UserContext {
  id: string;
  name: string;
  email: string;
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

export function saveCredentials(token: string, apiUrl: string = "https://voyagier.com"): void {
  ensureConfigDir();
  // Preserve existing user context if present
  const existing = loadCredentials();
  const creds: Credentials = { token, apiUrl };
  if (existing?.user) creds.user = existing.user;
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function saveUserContext(user: UserContext): void {
  ensureConfigDir();
  const existing = loadCredentials();
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
    return { token: envToken, apiUrl: envUrl ?? "https://voyagier.com" };
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
  return creds?.apiUrl ?? "https://voyagier.com";
}

export function getToken(): string {
  const creds = loadCredentials();
  if (!creds?.token) {
    process.stderr.write("Not authenticated. Run: voyagier auth setup\n");
    process.exit(1);
  }
  return creds.token;
}

export function credentialsExist(): boolean {
  if (process.env.VOYAGIER_TOKEN) return true;
  return existsSync(CREDENTIALS_FILE);
}
