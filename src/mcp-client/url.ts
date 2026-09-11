import { assertSecureApiUrl } from "../config.js";

/** The hosted Voyagier MCP endpoint every command talks to unless overridden. */
export const DEFAULT_MCP_URL = "https://mcp.voyagier.com/api/mcp";

/**
 * Resolve the MCP endpoint: `VOYAGIER_MCP_URL` when set, else the hosted
 * server. The override must be https, or http only on a loopback host — the
 * same rule `VOYAGIER_API_URL` follows, because the PAT travels as a Bearer
 * header on every request.
 *
 * @throws CliError(VALIDATION) for an unparseable or insecure override.
 */
export function getMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VOYAGIER_MCP_URL?.trim();
  if (!override) return DEFAULT_MCP_URL;
  assertSecureApiUrl(override);
  return override;
}
