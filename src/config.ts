import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from "fs";
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

/**
 * The only thing the CLI keeps about an account: the Personal Access Token.
 * Identity, roles, home base and traveller details are read from the MCP
 * server (`whoami`, `list_travellers`) on demand and never cached here.
 */
interface Credentials {
  token: string;
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
 * MCP endpoint on every request. A plaintext `http://` endpoint would leak
 * the token over the wire, so reject any non-`https:` URL — the sole
 * exception being loopback hosts for local development.
 *
 * Applied to `VOYAGIER_MCP_URL` (see mcp-client/url.ts) and to any other
 * endpoint the token travels to.
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
      `Invalid URL: "${url}".\n  Expected an absolute https:// URL (e.g. https://mcp.voyagier.com/api/mcp).`,
    );
  }
  const host = parsed.hostname;
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopback) return;
  throw new CliError(
    CliErrorCode.VALIDATION,
    `Insecure URL: "${url}".\n` +
      `  Your access token would be sent over cleartext ${parsed.protocol}// — anyone on the network path could read it.\n` +
      `  Fix: use an https:// URL (e.g. https://mcp.voyagier.com/api/mcp).\n` +
      `  Plain http:// is allowed only for localhost / 127.0.0.1 / ::1 during local development.`,
  );
}

function readCredentialsFile(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8");
    const creds = JSON.parse(raw) as { token?: unknown };
    if (typeof creds.token !== "string" || !creds.token) return null;
    return { token: creds.token };
  } catch {
    return null;
  }
}

export function saveCredentials(token: string): void {
  ensureConfigDir();
  const creds: Credentials = { token };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // chmod after write so a pre-existing loose-perm file gets corrected (L2).
  chmodSync(CREDENTIALS_FILE, 0o600);
}

/** `VOYAGIER_TOKEN` wins over the saved file; neither → null. */
export function loadCredentials(): Credentials | null {
  const envToken = process.env.VOYAGIER_TOKEN;
  if (envToken) return { token: envToken };
  return readCredentialsFile();
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    unlinkSync(CREDENTIALS_FILE);
  }
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
