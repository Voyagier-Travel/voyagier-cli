import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from "fs";
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
  // RBAC role flags mirrored from the `me` query (VOY-1748). Optional: an old
  // backend (pre-isTripPlanner) omits them, and whoami leaves them undefined so
  // downstream "regular traveller" rendering stays honest.
  isAdmin?: boolean;
  isTravelAdvisor?: boolean;
  isTripPlanner?: boolean;
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
    // 0o700: the dir holds credentials/state — keep it owner-only (L1).
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  // L1: `mode` only applies on creation — correct a pre-existing loose-perm
  // dir too (same correct-after pattern as the 0600 file chmods).
  chmodSync(CONFIG_DIR, 0o700);
}

/**
 * M2 (HTTPS enforcement): the access token is sent as a Bearer header to the
 * configured API URL on every request. A plaintext `http://` endpoint would
 * leak the token over the wire, so reject any non-`https:` URL — the sole
 * exception being loopback hosts for local development.
 *
 * Applied on BOTH the write path (`auth set-token --url`) and the read path
 * (`VOYAGIER_API_URL` env + `credentials.json`), so a token can never be sent
 * over cleartext regardless of how the URL was configured.
 *
 * @throws CliError(VALIDATION) for unparseable or insecure URLs.
 */
export function assertSecureApiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Invalid API URL: "${url}".\n  Expected an absolute https:// URL (e.g. https://travel.voyagier.com/api).`,
    );
  }
  const host = parsed.hostname;
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback) return;
  throw new CliError(
    CliErrorCode.VALIDATION,
    `Insecure API URL: "${url}".\n` +
      `  Your access token would be sent over cleartext ${parsed.protocol}// — anyone on the network path could read it.\n` +
      `  Fix: use an https:// URL (e.g. https://travel.voyagier.com/api).\n` +
      `  Plain http:// is allowed only for localhost / 127.0.0.1 / ::1 during local development.`,
  );
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
  // Reject cleartext endpoints before persisting (M2) — the token is sent to
  // this URL on every request.
  assertSecureApiUrl(apiUrl);
  ensureConfigDir();
  // Preserve existing user context from file (not env vars)
  const existing = loadFileCredentials();
  const creds: Credentials = { token, apiUrl };
  if (existing?.user) creds.user = existing.user;
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // chmod after write so a pre-existing loose-perm file gets corrected (L2).
  chmodSync(CREDENTIALS_FILE, 0o600);
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
  chmodSync(CREDENTIALS_FILE, 0o600);
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

let warnedIgnoredEnvUrl = false;

/**
 * Test-only: reset the warn-once flag for the ignored-VOYAGIER_API_URL
 * warning. Jest cannot isolate ESM module registries (isolateModules is
 * CJS-only), so specs use this to make the warn-once assertion
 * order-independent instead of relying on a fresh module instance.
 */
export function resetEnvUrlWarningForTests(): void {
  warnedIgnoredEnvUrl = false;
}

export function loadCredentials(): Credentials | null {
  const envToken = process.env.VOYAGIER_TOKEN;
  const envUrl = process.env.VOYAGIER_API_URL;
  if (envToken) {
    return { token: envToken, apiUrl: envUrl ?? "https://travel.voyagier.com/api" };
  }

  // VOYAGIER_API_URL is only honored together with VOYAGIER_TOKEN — file
  // credentials always travel with their own saved URL so a token is never
  // redirected to a host it wasn't saved for. Setting the URL var alone
  // is almost always a mistake; say so instead of silently ignoring it.
  if (envUrl && !warnedIgnoredEnvUrl) {
    warnedIgnoredEnvUrl = true;
    process.stderr.write(
      "Warning: VOYAGIER_API_URL is ignored unless VOYAGIER_TOKEN is also set (saved credentials use their own URL). To switch APIs: voyagier auth set-token - --url <url>\n",
    );
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
  const apiUrl = creds?.apiUrl ?? "https://travel.voyagier.com/api";
  // Read-path enforcement (M2): a token from VOYAGIER_API_URL env or an
  // on-disk credentials.json written by an older/hand-edited version must not
  // be sent over cleartext. Throws a clear CliError (surfaced by the top-level
  // handler), never crashes.
  assertSecureApiUrl(apiUrl);
  return apiUrl;
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
