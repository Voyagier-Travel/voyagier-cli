/**
 * Participant-choice commands (VOY-1896).
 *
 * Two thin wrappers over the platform's participant-choice surface, added for
 * parity with the first-party MCP tool registry:
 *   - `choices-view <planId>`      → tripPlanChoicesView (read)
 *   - `choose-room-slot <selId>`   → upsertParticipantChoice (mutation)
 *
 * Both are thin graphql() calls in the same style as `select` / `selection-
 * options`; the MCP layer wraps them (choices_view / choose_room_slot) with
 * --json exactly like every other tool.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { TRIP_PLAN_CHOICES_VIEW, UPSERT_PARTICIPANT_CHOICE } from "../queries.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import { validateId, validateOptionId } from "../utils.js";

/** One row of the flat participant-choice view. Optional/nullable throughout —
 * the CLI reports what the backend exposes and never invents fields. */
interface ChoiceRow {
  id: string;
  selectionId?: string | null;
  selectionType?: string | null;
  isActiveBranch?: boolean | null;
  goalId?: string | null;
  optionId?: string | null;
  optionStatus?: string | null;
  isBookable?: boolean | null;
  scope?: string | null;
  travellerIds?: string[] | null;
  travellerGroupId?: string | null;
  locked?: boolean | null;
  selectionIsLocked?: boolean | null;
}

export function registerParticipantChoicesCommands(program: Command): void {
  // -- choices-view --
  program
    .command("choices-view <planId>")
    .description(
      "Flat view of every participant choice on a plan (decided + open slots) across all branches. Filter on isActiveBranch to see the rows the cart counts; room/rate slots are selectionType HotelRoom/HotelRoomRate.",
    )
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
      const id = validateId(planId, "planId");
      try {
        const data = await graphql<{ tripPlanChoicesView: ChoiceRow[] | null }>(
          TRIP_PLAN_CHOICES_VIEW,
          { tripPlanId: id },
        );
        const choices = data.tripPlanChoicesView ?? [];
        if (opts.json) {
          jsonOutput({ ok: true, choices, total: choices.length });
          return;
        }
        if (choices.length === 0) {
          console.log(chalk.dim("No participant choices on this plan yet."));
          return;
        }
        for (const c of choices) {
          const active = c.isActiveBranch ? chalk.green("●") : chalk.dim("○");
          const lock = c.locked ? chalk.red(" 🔒") : "";
          const pick = c.optionId ? chalk.green(c.optionId) : chalk.yellow("— open");
          console.log(`${active} ${chalk.cyan(`[${c.selectionType ?? "?"}]`)} ${pick}${lock}  ${chalk.dim(c.id)}`);
        }
        console.log(chalk.dim(`\n${choices.length} choice row${choices.length === 1 ? "" : "s"} (● = active branch)`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load choices view: ${message}`);
      }
    });

  // -- choose-room-slot --
  program
    .command("choose-room-slot <selectionId>")
    .description(
      "Create or update a participant choice (room/rate slot) on a selection. Target an existing slot with --participant-choice-id (from choices-view), or open a fresh one with --create-new-choice.",
    )
    .option("--option-id <id>", "Option id to choose for the slot")
    .option("--travellers <ids>", "Comma-separated traveller ids the choice applies to (subset scope)")
    .option("--for-all", "Apply the choice to all assigned travellers")
    .option("--group <groupId>", "Apply the choice to a traveller group")
    .option("--participant-choice-id <id>", "Target this exact participant choice (room slot) and replace it in place")
    .option("--replace-existing", "Replace an existing overlapping choice instead of merging")
    .option("--create-new-choice", "Create a fresh choice for a new room slot")
    .option("--json", "Output raw JSON")
    .action(async (selectionId: string, opts) => {
      const id = validateId(selectionId, "selectionId");
      const travellerIds = opts.travellers
        ? String(opts.travellers).split(",").map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      if (opts.travellers !== undefined && (!travellerIds || travellerIds.length === 0)) {
        throw new CliError(CliErrorCode.VALIDATION, "--travellers requires a comma-separated list of traveller ids.");
      }
      // Send only the variables the caller supplied — optional arguments are
      // omitted rather than sent as explicit null, so server-side defaults and
      // "absent vs null" distinctions are preserved.
      const variables: Record<string, unknown> = { selectionId: id };
      // Option ids must be full uuids — a truncated one matches no option (VOY-2044).
      if (opts.optionId !== undefined) variables.optionId = validateOptionId(opts.optionId, "--option-id");
      if (travellerIds) variables.travellerIds = travellerIds;
      if (opts.forAll) variables.forAll = true;
      if (opts.group !== undefined) variables.groupId = validateId(opts.group, "--group");
      if (opts.participantChoiceId !== undefined) variables.participantChoiceId = validateId(opts.participantChoiceId, "--participant-choice-id");
      if (opts.replaceExisting) variables.replaceExisting = true;
      if (opts.createNewChoice) variables.createNewChoice = true;

      try {
        const data = await graphql<{ upsertParticipantChoice: { id: string } | null }>(
          UPSERT_PARTICIPANT_CHOICE,
          variables,
        );
        // An empty payload means the upsert matched nothing server-side; report
        // that instead of echoing the input id back as a success (VOY-2044).
        const resultId = data.upsertParticipantChoice?.id;
        if (!resultId) {
          throw new CliError(
            CliErrorCode.API_ERROR,
            `The choice was not recorded: the server returned no participant choice for selection ${id}.\n` +
              `  Re-read the plan's slots and target a current id: voyagier choices-view <planId> --json`,
          );
        }
        if (opts.json) {
          jsonOutput({ ok: true, selectionId: resultId });
          return;
        }
        console.log(chalk.green(`✓ Choice recorded on selection ${resultId}.`));
        console.log(chalk.dim(`  Next: voyagier plan-status <planId>  (or voyagier choices-view <planId>)`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to record room-slot choice: ${message}`);
      }
    });
}
