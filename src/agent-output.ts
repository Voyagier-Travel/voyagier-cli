/**
 * Agent output helpers — plain markdown, no ANSI codes.
 * Safe for pasting into Discord, Slack, Telegram, and any chat surface.
 */
import { formatPrice } from "./utils.js";
import { hotelStayLabel, deriveHotelFacts } from "./hotel-format.js";
import { deriveFlightDetail, flightRouteLabel } from "./flight-format.js";

/**
 * Format a numbered list of flight options for agent output.
 *
 * VOY-1783: when the option carries leg detail, render a decision-grade line —
 * `DL 1043 · BWI 07:15 → AUS 10:05 (1 stop, ATL) · 5h50m · $412`. Without leg
 * data it degrades to the original `airline · duration · price`.
 */
export function agentFlightOptions(
  options: Array<{ airline?: string; duration?: string; price?: number; bookingData?: Record<string, unknown> | null }>
): string {
  if (options.length === 0) return "_No flights found._";
  return options
    .map((opt, i) => {
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
      return `${i + 1}. ${parts.join(" · ")}`;
    })
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
