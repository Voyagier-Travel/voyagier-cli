import { spawn } from "child_process";
import { CliError, CliErrorCode } from "./errors.js";

// Re-exported from the leaf module so call sites can keep importing from utils.
export { formatPrice, cents, money } from "./format.js";

/**
 * Mask a potentially sensitive loyalty value for terminal output: member
 * numbers are write-only everywhere else (server returns code + last4 only),
 * so human-readable renders and error messages must not echo the full value to
 * terminals or agent transcripts. Storage and API sync keep the full value.
 */
export function maskLoyaltyValue(value: string): string {
  return value.length > 4 ? `••••${value.slice(-4)}` : "••••";
}

/**
 * Open a URL in the user's default browser. Throws CliError(VALIDATION) for
 * malformed or non-http(s) URLs; launch/spawn failures are still silent.
 *
 * L4: only http(s) URLs are launched. A hostile API-provided URL (e.g. a
 * checkoutUrl) using a `file:`/`smb:`/custom scheme could otherwise launch a
 * local file/UNC handler via the OS opener — refuse anything that isn't
 * http(s) before spawning.
 */
export function openBrowser(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(CliErrorCode.VALIDATION, `Refusing to open malformed URL: "${url}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `Refusing to open non-web URL: "${url}".\n  Only http:// and https:// links are opened in the browser.`,
    );
  }
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (platform === "win32") {
      spawn("powershell", ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`],
        { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // User can open URL manually
  }
}

// ── Untrusted-content sanitization (VOY-1709) ──
//
// API responses carry third-party supplier content (hotel names, option
// labels, GDS data) that ends up in terminals and in agent-consumed markdown.
// A hostile string could embed ANSI escape sequences (rewrite the visible
// terminal, spoof prompts) or raw control characters. Strip both at the API
// boundary — legitimate travel data never contains them.
//
// Kept: \n and \t (legitimate in multi-line descriptions).
// Stripped: well-formed ANSI CSI/OSC/single-char escape sequences first, then
// any remaining C0 control chars (including stray ESC) and DEL.

const ANSI_SEQUENCE =
  // CSI: ESC [ params intermediates final · OSC: ESC ] ... (BEL | ESC \) · other ESC x
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\^_]/g;
// \u007f-\u009f covers DEL plus the C1 range — U+009B is a single-codepoint
// CSI introducer (U+009D = OSC, U+0090 = DCS) that xterm-family terminals
// honor even in UTF-8 mode; leaving C1 intact would bypass the ANSI strip.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strip ANSI escape sequences and control characters from one string. */
export function sanitizeExternalText(value: string): string {
  return value.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

/**
 * Recursively sanitize every string in an API response (objects, arrays,
 * nested). Non-string primitives pass through untouched. Applied once at the
 * graphql() boundary so every command and output mode is covered.
 */
export function sanitizeExternalData<T>(data: T): T {
  if (typeof data === "string") {
    return sanitizeExternalText(data) as T;
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeExternalData(item)) as T;
  }
  if (data !== null && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      // A hostile response can carry an own "__proto__" key (JSON.parse
      // creates it as a plain own property). Assigning THAT key here would set
      // the rebuilt object's prototype to attacker data — skip it outright.
      // "constructor"/"prototype" don't have that effect on plain assignment;
      // they're dropped as defense-in-depth against prototype-pollution
      // gadgets in downstream deep-merge/clone patterns.
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = sanitizeExternalData(value);
    }
    return out as T;
  }
  return data;
}
