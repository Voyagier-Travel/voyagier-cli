/**
 * Agent output helpers — plain markdown, no ANSI codes.
 * Safe for pasting into Discord, Slack, Telegram, and any chat surface.
 */
import { formatPrice } from "./utils.js";

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
      if (opt.price != null) parts.push(`${formatPrice(opt.price)}/pp`);
      return `${i + 1}. ${parts.join(" · ")}`;
    })
    .join("\n");
}

/**
 * Format a numbered list of hotel options for agent output.
 */
export function agentHotelOptions(
  options: Array<{ name: string; price?: number }>
): string {
  if (options.length === 0) return "_No hotels found._";
  return options
    .map((opt, i) => {
      const price = opt.price != null ? ` · ${formatPrice(opt.price)}/night` : "";
      return `${i + 1}. ${opt.name}${price}`;
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
