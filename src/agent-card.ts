import { graphql } from "./api.js";
import { getApiUrl } from "./config.js";
import { formatDateRange } from "./utils.js";
import { deriveBaseUrl, formatPrice } from "./utils.js";

interface AgentCardPlan {
  id: string;
  title: string;
  startDate?: string;
  endDate?: string;
  items: Array<{
    id: string;
    type: string;
    title: string;
    selection?: {
      id: string;
      selectedOption?: { id: string; name: string; price?: number; status: string };
    };
  }>;
  travellers: Array<{ id: string; firstName: string; lastName: string }>;
}

export interface AgentSearchResult {
  index: number;
  summary: string;
  optionId: string;
  flightToken?: string;
}

export interface AgentSearchContext {
  from?: string;
  to?: string;
  date?: string;
  location?: string;
}

function planUrl(id: string): string {
  return `${deriveBaseUrl(getApiUrl())}/plans/${id}`;
}

function typeIcon(type: string): string {
  switch (type?.toLowerCase()) {
    case "flight":
    case "selection":
      return "✈️";
    case "hotel":
      return "🏨";
    case "activity":
      return "🎯";
    case "transport":
      return "🚗";
    default:
      return "📌";
  }
}

/**
 * Fetches full plan data and returns a markdown card for AI agents.
 * Plan URL is always the hero/last element.
 */
export async function formatAgentCard(planId: string): Promise<string> {
  const data = await graphql<{ tripPlan: AgentCardPlan }>(
    `query TripPlan($id: String!) {
      tripPlan(id: $id) {
        id title startDate endDate
        items {
          id type title
          selection { id selectedOption { id name price status } }
        }
        travellers { id firstName lastName }
      }
    }`,
    { id: planId }
  );

  const plan = data.tripPlan;
  return buildAgentCardFromData(plan);
}

/**
 * Build the markdown card from pre-fetched plan data.
 * Exported for testing and reuse in commands that already have plan data.
 */
export function buildAgentCardFromData(plan: AgentCardPlan): string {
  const url = planUrl(plan.id);
  const lines: string[] = [];

  // Header
  lines.push(`## ✈️ ${plan.title}`);

  const datePart =
    plan.startDate && plan.endDate
      ? `**${formatDateRange(plan.startDate, plan.endDate)}**`
      : "";
  const travellerCount = plan.travellers?.length ?? 0;
  const travellerPart =
    travellerCount > 0
      ? `${travellerCount} traveller${travellerCount !== 1 ? "s" : ""}`
      : "";

  const subtitle = [datePart, travellerPart].filter(Boolean).join(" · ");
  if (subtitle) lines.push(subtitle);
  lines.push("");

  // Items
  const items = plan.items ?? [];
  const visibleItems = items.filter((item) => item.selection !== undefined || item.type);
  if (visibleItems.length > 0) {
    for (const item of visibleItems) {
      const icon = typeIcon(item.type);
      if (item.selection?.selectedOption) {
        const sel = item.selection.selectedOption;
        const price = sel.price != null ? ` · ${formatPrice(sel.price)}/pp` : "";
        lines.push(`${icon} ${sel.name}${price}`);
      } else if (item.selection) {
        lines.push(`${icon} ${item.title} · ⏳ pending`);
      }
    }
    lines.push("");
  }

  // Travellers
  if (travellerCount > 0) {
    const names = plan.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(", ");
    lines.push(`👤 ${names}`);
    lines.push("");
  }

  // CTA — plan URL is always last
  lines.push(`👉 **View & edit:** ${url}`);

  return lines.join("\n");
}

/**
 * Compact search results card for AI agents.
 */
export function formatAgentSearchCard(
  results: AgentSearchResult[],
  planId: string,
  searchType: string,
  context?: AgentSearchContext
): string {
  const url = planUrl(planId);
  const lines: string[] = [];
  const top5 = results.slice(0, 5);

  if (searchType === "flights") {
    const route =
      context?.from && context?.to
        ? `${context.from} → ${context.to}`
        : "Flight Search";
    const dateLabel = context?.date ? ` (${context.date})` : "";
    lines.push(`### ✈️ Flight Results: ${route}${dateLabel}`);
  } else {
    const loc = context?.location ?? "Hotel Search";
    lines.push(`### 🏨 Hotel Results: ${loc}`);
  }

  lines.push(
    `Found ${results.length} option${results.length !== 1 ? "s" : ""}. Top ${Math.min(5, results.length)}:`
  );
  lines.push("");

  for (const r of top5) {
    lines.push(`${r.index}. ${r.summary}`);
  }

  lines.push("");
  lines.push("Select: `voyagier select <number>`");
  lines.push(`👉 **Plan:** ${url}`);

  return lines.join("\n");
}

/**
 * Selection confirmation card for AI agents.
 */
export function formatAgentSelectCard(summary: string, planId: string): string {
  const url = planUrl(planId);
  const lines: string[] = [];
  lines.push(`✅ **Selected:** ${summary}`);
  lines.push("");
  lines.push(`👉 **View plan:** ${url}`);
  return lines.join("\n");
}
