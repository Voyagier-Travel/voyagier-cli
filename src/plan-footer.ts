import chalk from "chalk";
import { graphql } from "./api.js";
import { getApiUrl } from "./config.js";
import { deriveBaseUrl, formatDateRange } from "./utils.js";

interface PlanFooterData {
  title: string;
  startDate?: string;
  endDate?: string;
  travellers: Array<{ id: string }>;
  items: Array<{ id: string }>;
}

const PLAN_FOOTER_QUERY = `query PlanFooter($id: String!) { tripPlan(id: $id) { title startDate endDate travellers { id } items { id } } }`;

// Fetches minimal plan data and prints a 2-line footer. Fails silently.
export async function printPlanFooter(planId: string): Promise<void> {
  try {
    const data = await graphql<{ tripPlan: PlanFooterData | null }>(
      PLAN_FOOTER_QUERY,
      { id: planId }
    );
    const p = data.tripPlan;
    if (!p) return;
    const url = `${deriveBaseUrl(getApiUrl())}/plans/${planId}`;
    const dates = formatDateRange(p.startDate, p.endDate);
    const tc = p.travellers?.length ?? 0;
    // `items` are goal-graph nodes (a fresh plan scaffolds ~25), NOT user-added
    // bookings. Label honestly as goals so the agent doesn't read it as progress.
    const gc = p.items?.length ?? 0;
    const parts = [p.title, dates, `${tc} traveller${tc !== 1 ? "s" : ""}`, `${gc} goal${gc !== 1 ? "s" : ""}`].filter(Boolean);
    console.log(chalk.dim(`\n  Plan: ${url}`));
    console.log(chalk.dim(`  📋 ${parts.join(" · ")}`));
  } catch { /* best-effort */ }
}

/**
 * Shape of the plan summary embedded in `plans create --json`. This is part of
 * the CLI's public --json contract, so it carries a concrete type: a future key
 * rename (e.g. the itemCount -> goalCount change) breaks the build instead of
 * silently shipping drift to agent consumers.
 */
export interface PlanSummary {
  title: string;
  url: string;
  dates: string;
  travellerCount: number;
  goalCount: number;
}

// Returns plan summary for --json mode. Returns null on failure.
export async function getPlanSummary(planId: string): Promise<PlanSummary | null> {
  try {
    const data = await graphql<{ tripPlan: PlanFooterData | null }>(
      PLAN_FOOTER_QUERY,
      { id: planId }
    );
    const p = data.tripPlan;
    if (!p) return null;
    return {
      title: p.title,
      url: `${deriveBaseUrl(getApiUrl())}/plans/${planId}`,
      dates: formatDateRange(p.startDate, p.endDate),
      travellerCount: p.travellers?.length ?? 0,
      // `items` are goal-graph nodes (fresh plan scaffolds ~25), not user items.
      goalCount: p.items?.length ?? 0,
    };
  } catch { return null; }
}
