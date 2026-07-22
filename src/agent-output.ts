/**
 * Agent output helpers — plain markdown, no ANSI codes.
 * Safe for pasting into Discord, Slack, Telegram, and any chat surface.
 */
import { formatPrice } from "./utils.js";
import { hotelStayLabel } from "./hotel-format.js";

/**
 * Format a numbered list of flight options for agent output.
 */
export function agentFlightOptions(
  options: Array<{ airline?: string; duration?: string; price?: number }>
): string {
  if (options.length === 0) return "_No flights found._";
  return options
    .map((opt, i) => {
      const parts: string[] = [];
      if (opt.airline) parts.push(opt.airline);
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
      const label = hotelStayLabel(opt.price, opt.bookingData);
      return `${i + 1}. ${opt.name}${label ? ` · ${label}` : ""}`;
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
