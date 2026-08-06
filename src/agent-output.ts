/**
 * Agent output helpers — plain markdown, no ANSI codes.
 * Safe for pasting into Discord, Slack, Telegram, and any chat surface.
 */
import { formatPrice } from "./utils.js";
import { hotelStayLabel, deriveHotelFacts } from "./hotel-format.js";
import { deriveFlightDetail, flightRouteLabel, extractRankScore, rankScoreLabel, analyzeFlightDuplicates, collapsedAlternatesLabel } from "./flight-format.js";
import type { FlightDupRole } from "./flight-format.js";

/**
 * Format a numbered list of flight options for agent output.
 *
 * VOY-1783: when the option carries leg detail, render a decision-grade line —
 * `DL 1043 · BWI 07:15 → AUS 10:05 (1 stop, ATL) · 5h50m · $412`. Without leg
 * data it degrades to the original `airline · duration · price`.
 */
export function agentFlightOptions(
  options: Array<{ id?: string; airline?: string; duration?: string; price?: number; bookingData?: Record<string, unknown> | null }>,
  roles?: FlightDupRole[],
  markers?: Array<string | undefined>,
): string {
  if (options.length === 0) return "_No flights found._";
  // VOY-1877: fold/annotate display-identical rows, matching the human + JSON
  // surfaces. Numbers are kept positional so `select <n>` still resolves a
  // collapsed option (identical to the shown primary).
  const dupRoles = roles ?? analyzeFlightDuplicates(options);
  return options
    .map((opt, i) => {
      const role = dupRoles[i] ?? {};
      if (role.collapsed) return null;
      const detail = deriveFlightDetail(opt.bookingData);
      const parts: string[] = [];
      const lead = detail?.flightNumber ?? opt.airline;
      if (lead) parts.push(lead);
      const route = detail ? flightRouteLabel(detail) : "";
      if (route) parts.push(route);
      if (opt.duration) parts.push(opt.duration);
      // VOY-1724: the fare reflects the searched party — NOT a per-person price.
      // Dropping the old "/pp" suffix that wrongly implied "× traveller count".
      if (opt.price != null) parts.push(formatPrice(opt.price));
      // VOY-1824: platform value score, plain (no ANSI), only when present.
      const rank = extractRankScore(opt.bookingData);
      if (rank !== undefined) parts.push(rankScoreLabel(rank));
      // VOY-1877: fare annotation for a distinguishable identical-schedule row.
      if (role.annotate) parts.push(`fare: ${role.annotate}`);
      // VOY-1874: nearby-airport substitution marker (--nearby / all-nearby mode).
      const marker = markers?.[i];
      if (marker) parts.push(marker);
      let line = `${i + 1}. ${parts.join(" · ")}`;
      if (role.collapsedAlternates?.length) {
        line += ` (${collapsedAlternatesLabel(role.collapsedAlternates)})`;
      }
      return line;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Format a numbered list of hotel options for agent output.
 */
export function agentHotelOptions(
  options: Array<{ name: string; price?: number; bookingData?: Record<string, unknown> | null }>
): string {
  if (options.length === 0) return "_No hotels found._";
  // VOY-1724: minRate is the STAY TOTAL — render it honestly.
  return options
    .map((opt, i) => {
      // VOY-1783: surface rating + salient amenities between name and stay total.
      const facts = deriveHotelFacts(opt.bookingData);
      const parts: string[] = [opt.name];
      if (facts?.rating != null) parts.push(`⭐${facts.rating}`);
      if (facts?.amenities.length) parts.push(facts.amenities.join(", "));
      const label = hotelStayLabel(opt.price, opt.bookingData);
      if (label) parts.push(label);
      return `${i + 1}. ${parts.join(" · ")}`;
    })
    .join("\n");
}

/**
 * Format a numbered list of activity options for agent output.
 */
export function agentActivityOptions(
  options: Array<{ name: string; price?: number; duration?: string }>
): string {
  if (options.length === 0) return "_No activities found._";
  return options
    .map((opt, i) => {
      const parts: string[] = [opt.name];
      if (opt.price != null) parts.push(formatPrice(opt.price));
      if (opt.duration) parts.push(opt.duration);
      return `${i + 1}. ${parts.join(" · ")}`;
    })
    .join("\n");
}
