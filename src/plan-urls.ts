/**
 * Plan URL emission — the single source of truth for the web app routes the
 * CLI/MCP surface hands back to callers.
 *
 * The web app's plan routes are audience-split:
 *   - clientUrl  = <base>/me/trips/plans/{id}  — the traveller-facing view a
 *     client opens (also the `url` field, kept for back-compat).
 *   - advisorUrl = <base>/advisor/plans/{id}   — the advisor-facing workspace.
 *
 * The older `<base>/plans/{id}` route no longer resolves; every emission site
 * routes through here so the two audiences get the right link and the `url`
 * alias stays stable for existing consumers.
 */
import { getApiUrl } from "./config.js";
import { deriveBaseUrl } from "./utils.js";

/** The plan-URL trio emitted in `--json` payloads and planContext blocks. */
export interface PlanUrls {
  /** Back-compat alias of `clientUrl`. */
  url: string;
  /** Traveller-facing plan view: `<base>/me/trips/plans/{id}`. */
  clientUrl: string;
  /** Advisor-facing plan workspace: `<base>/advisor/plans/{id}`. */
  advisorUrl: string;
}

function base(baseUrl?: string): string {
  return baseUrl ?? deriveBaseUrl(getApiUrl());
}

/** Traveller-facing plan URL. Pass a pre-derived base to avoid recomputing it. */
export function clientPlanUrl(id: string, baseUrl?: string): string {
  return `${base(baseUrl)}/me/trips/plans/${id}`;
}

/** Advisor-facing plan URL. Pass a pre-derived base to avoid recomputing it. */
export function advisorPlanUrl(id: string, baseUrl?: string): string {
  return `${base(baseUrl)}/advisor/plans/${id}`;
}

/**
 * The full `{ url, clientUrl, advisorUrl }` trio for `id`. Spread into a JSON
 * payload or planContext to attach all three (with `url` aliasing `clientUrl`).
 */
export function planUrls(id: string, baseUrl?: string): PlanUrls {
  const b = base(baseUrl);
  const clientUrl = clientPlanUrl(id, b);
  return { url: clientUrl, clientUrl, advisorUrl: advisorPlanUrl(id, b) };
}
