import chalk from "chalk";
import { graphql } from "./api.js";
import { getApiUrl } from "./config.js";
import { deriveBaseUrl, formatDateRange } from "./utils.js";

interface PlanFooterData {
  title: string;
  startDate?: string;
  endDate?: string;
  itemCount?: number;
  travellers: Array<{ id: string }>;
}

const PLAN_FOOTER_QUERY = `query PlanFooter($id: String!) { tripPlan(id: $id) { title startDate endDate itemCount travellers { id } } }`;

// Fetches minimal plan data and prints a 2-line footer. Fails silently.
export async function printPlanFooter(planId: string): Promise<void> {
  try {
    const data = await graphql<{ tripPlan: PlanFooterData }>(
      PLAN_FOOTER_QUERY,
      { id: planId }
    );
    const p = data.tripPlan;
    const url = `${deriveBaseUrl(getApiUrl())}/plans/${planId}`;
    const dates = formatDateRange(p.startDate, p.endDate);
    const tc = p.travellers?.length ?? 0;
    const ic = p.itemCount ?? 0;
    const parts = [p.title, dates, `${tc} traveller${tc !== 1 ? "s" : ""}`, `${ic} item${ic !== 1 ? "s" : ""}`].filter(Boolean);
    console.log(chalk.dim(`\n  Plan: ${url}`));
    console.log(chalk.dim(`  📋 ${parts.join(" · ")}`));
  } catch { /* best-effort */ }
}

// Returns plan summary object for --json mode. Returns null on failure.
export async function getPlanSummary(planId: string): Promise<object | null> {
  try {
    const data = await graphql<{ tripPlan: PlanFooterData }>(
      PLAN_FOOTER_QUERY,
      { id: planId }
    );
    const p = data.tripPlan;
    return {
      title: p.title,
      url: `${deriveBaseUrl(getApiUrl())}/plans/${planId}`,
      dates: formatDateRange(p.startDate, p.endDate),
      travellerCount: p.travellers?.length ?? 0,
      itemCount: p.itemCount ?? 0,
    };
  } catch { return null; }
}
