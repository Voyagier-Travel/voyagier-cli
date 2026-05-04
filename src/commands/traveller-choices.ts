/**
 * Traveller Choices command surface (v2.1.0 — Section 6).
 *
 * Read-only inspection of per-traveller selection choices for a trip plan.
 * Choice application (setTripPlanTravellerChoiceFor*) ships in Section 5
 * behind --experimental once Mark's choice-mechanics rework stabilizes.
 *
 * Surface:
 *   voyagier traveller-choices list --plan <id>
 *                                    [--pending]           only questions with pending travellers
 *                                    [--traveller <tid>]   only questions this traveller hasn't answered
 *                                    [--goal <goalId>]     filter by goal
 *                                    [--type <selType>]    filter by SelectionType (case-insensitive)
 *                                    [--json]
 *
 * Exports:
 *   summarizeChoices(result)  — one-liner for plan-trip summary output
 *
 * Schema discovery: TripPlanSelectOption uses `name` not `label`
 * (see SECTION6-DISCOVERIES.md for full list of findings).
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { deriveBaseUrl } from "../utils.js";
import { getApiUrl } from "../config.js";
import { GET_TRAVELLER_CHOICES } from "../queries.js";

// ---------- Types ----------

export interface ChoiceTraveller {
  id: string;
  firstName: string;
  lastName: string;
}

export interface TripPlanSelectOption {
  id: string;
  name: string;
  isBookable: boolean;
}

export interface TripPlanSelectionInput {
  id: string;
  fieldName: string;
  fieldLabel?: string | null;
  isRequired: boolean;
}

export interface TravellerChoiceQuestion {
  selectionId: string;
  selectionType: string;
  title: string;
  goalId?: string | null;
  groupName?: string | null;
  questionTemplate?: string | null;
  options: TripPlanSelectOption[];
  inputs: TripPlanSelectionInput[];
  answeredTravellers: ChoiceTraveller[];
  pendingTravellers: ChoiceTraveller[];
}

export interface TravellerChoicesResult {
  title: string;
  startDate?: string | null;
  endDate?: string | null;
  numberOfDays?: number | null;
  numberOfNights?: number | null;
  travellers: ChoiceTraveller[];
  questions: TravellerChoiceQuestion[];
}

// ---------- Pure helpers (exported for reuse / tests) ----------

/**
 * Format a traveller for choice output (combined name, no email needed here).
 */
function formatChoiceTraveller(t: ChoiceTraveller): { id: string; name: string } {
  return {
    id: t.id,
    name: [t.firstName, t.lastName].filter(Boolean).join(" ").trim() || t.id,
  };
}

/**
 * Derive the nextStep scope and command for a question given its pending travellers.
 *
 * Scope logic:
 *   - all travellers pending → scope=all (no --participants needed)
 *   - exactly 1 pending → scope=individual, --participants <single-id>
 *   - multiple but not all → scope=subset, --participants <comma-list>
 */
export function buildNextStepCommand(
  question: TravellerChoiceQuestion,
  planId: string,
  allTravellerIds: string[],
): { command: string; note: string } {
  const pendingIds = question.pendingTravellers.map((t) => t.id);
  const note = "Choice application requires Section 5 (--experimental in v2.1.0)";

  if (pendingIds.length === 0 || pendingIds.length === allTravellerIds.length) {
    return {
      command: `voyagier select 1 --plan ${planId} --scope all`,
      note,
    };
  }
  if (pendingIds.length === 1) {
    return {
      command: `voyagier select 1 --plan ${planId} --participants ${pendingIds[0]} --scope individual`,
      note,
    };
  }
  return {
    command: `voyagier select 1 --plan ${planId} --participants ${pendingIds.join(",")} --scope subset`,
    note,
  };
}

/**
 * Produce a one-line summary of outstanding choices for a plan.
 * Used by plan-trip summary output. Exported for downstream consumers.
 *
 * Examples:
 *   "No questions on this plan yet."
 *   "All 5 questions answered."
 *   "3 of 5 questions pending across 2 travellers."
 */
export function summarizeChoices(result: TravellerChoicesResult): string {
  const total = result.questions.length;
  if (total === 0) return "No questions on this plan yet.";

  const pendingQs = result.questions.filter((q) => q.pendingTravellers.length > 0);
  const pendingCount = pendingQs.length;

  if (pendingCount === 0) {
    return `All ${total} question${total === 1 ? "" : "s"} answered.`;
  }

  const pendingTravellerIds = new Set(
    pendingQs.flatMap((q) => q.pendingTravellers.map((t) => t.id)),
  );
  const tc = pendingTravellerIds.size;
  return (
    `${pendingCount} of ${total} question${total === 1 ? "" : "s"} pending` +
    ` across ${tc} traveller${tc === 1 ? "" : "s"}.`
  );
}

/**
 * Apply all CLI filters to the questions array (client-side filtering since
 * the travellerChoices query doesn't expose server-side filter args).
 */
export function filterQuestions(
  questions: TravellerChoiceQuestion[],
  filters: {
    pending?: boolean;
    travellerId?: string;
    goalId?: string;
    selectionType?: string;
  },
): TravellerChoiceQuestion[] {
  let out = questions;

  if (filters.pending) {
    out = out.filter((q) => q.pendingTravellers.length > 0);
  }
  if (filters.travellerId) {
    const tid = filters.travellerId;
    out = out.filter((q) => q.pendingTravellers.some((t) => t.id === tid));
  }
  if (filters.goalId) {
    const gid = filters.goalId;
    out = out.filter((q) => q.goalId === gid);
  }
  if (filters.selectionType) {
    const target = filters.selectionType.toLowerCase();
    out = out.filter((q) => q.selectionType.toLowerCase() === target);
  }

  return out;
}

// ---------- Command registration ----------

export function registerTravellerChoicesCommands(program: Command): void {
  const tc = program
    .command("traveller-choices")
    .description("Inspect per-traveller selection choices for a trip plan");

  // ---------- LIST ----------
  tc.command("list")
    .description("List traveller choice questions for a plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--pending", "Only show questions with pending travellers", false)
    .option("--traveller <tid>", "Only questions this traveller hasn't answered yet")
    .option("--goal <goalId>", "Filter by goal ID")
    .option("--type <selectionType>", "Filter by selection type (case-insensitive)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      const data = await graphql<{ travellerChoices: TravellerChoicesResult }>(
        GET_TRAVELLER_CHOICES,
        { tripPlanId: opts.plan },
      );

      const result = data.travellerChoices;
      const allTravellerIds = (result.travellers ?? []).map((t) => t.id);

      const filtered = filterQuestions(result.questions ?? [], {
        pending: opts.pending,
        travellerId: opts.traveller,
        goalId: opts.goal,
        selectionType: opts.type,
      });

      const pendingCount = filtered.filter((q) => q.pendingTravellers.length > 0).length;

      if (opts.json) {
        const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${opts.plan}`;
        jsonOutput({
          ok: true,
          data: {
            title: result.title,
            startDate: result.startDate ?? null,
            endDate: result.endDate ?? null,
            numberOfDays: result.numberOfDays ?? null,
            numberOfNights: result.numberOfNights ?? null,
            travellers: (result.travellers ?? []).map(formatChoiceTraveller),
            questions: filtered.map((q) => ({
              selectionId: q.selectionId,
              selectionType: q.selectionType,
              goalId: q.goalId ?? null,
              groupName: q.groupName ?? null,
              title: q.title,
              questionTemplate: q.questionTemplate ?? null,
              options: q.options.map((o) => ({
                id: o.id,
                name: o.name,
                isBookable: o.isBookable,
              })),
              inputs: q.inputs.map((i) => ({
                id: i.id,
                fieldName: i.fieldName,
                fieldLabel: i.fieldLabel ?? null,
                isRequired: i.isRequired,
              })),
              answeredTravellers: q.answeredTravellers.map(formatChoiceTraveller),
              pendingTravellers: q.pendingTravellers.map(formatChoiceTraveller),
              nextStep: buildNextStepCommand(q, opts.plan, allTravellerIds),
            })),
            total: filtered.length,
            pending: pendingCount,
          },
          planContext: {
            planId: opts.plan,
            title: result.title,
            url: planUrl,
            travellerCount: allTravellerIds.length,
          },
        });
        return;
      }

      // Human output
      console.log(`\n  ${chalk.bold(result.title)}  ${chalk.dim(`(${opts.plan})`)}`);
      if (result.startDate || result.endDate) {
        console.log(chalk.dim(`  ${result.startDate ?? "?"} → ${result.endDate ?? "?"}`));
      }
      console.log();

      if (filtered.length === 0) {
        const hasAny = (result.questions ?? []).length > 0;
        if (!hasAny) {
          console.log(chalk.dim("  No choice questions on this plan yet."));
        } else {
          console.log(chalk.dim(`  No questions match your filters. (${result.questions.length} total)`));
        }
        return;
      }

      for (let i = 0; i < filtered.length; i++) {
        const q = filtered[i];
        const answered = q.answeredTravellers.length;
        const pending = q.pendingTravellers.length;
        const badge =
          pending === 0
            ? chalk.green("✓ done")
            : chalk.yellow(`${pending} pending`);

        console.log(
          `  ${chalk.cyan(`[${i + 1}]`)} ${chalk.bold(q.title)}  ${chalk.dim(`[${q.selectionType}]`)}  ${badge}`,
        );
        console.log(chalk.dim(`      Selection: ${q.selectionId}`));
        if (q.goalId) console.log(chalk.dim(`      Goal: ${q.goalId}`));
        if (q.options.length > 0) {
          console.log(chalk.dim(`      Options: ${q.options.map((o) => o.name).join(", ")}`));
        }
        if (pending > 0) {
          const names = q.pendingTravellers
            .map((t) => [t.firstName, t.lastName].filter(Boolean).join(" ").trim())
            .join(", ");
          console.log(chalk.dim(`      Pending: ${names}`));
        }
        if (answered > 0) {
          const names = q.answeredTravellers
            .map((t) => [t.firstName, t.lastName].filter(Boolean).join(" ").trim())
            .join(", ");
          console.log(chalk.dim(`      Answered: ${names}`));
        }
      }

      console.log();
      console.log(chalk.dim(`  ${filtered.length} question${filtered.length === 1 ? "" : "s"} shown`));
      if (pendingCount > 0) {
        console.log(chalk.dim(`  ${pendingCount} with pending travellers`));
      }
    });
}
