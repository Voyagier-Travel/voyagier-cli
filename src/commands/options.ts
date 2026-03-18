import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { formatPrice, subSelectionLabel, deriveBaseUrl } from "../utils.js";
import { hintCabinClass, hintHotelRoom } from "../hints.js";
import { saveOptionsState, loadOptionsState, clearOptionsState } from "../state.js";
import { GET_PLAN_DEEP, SET_SUB_SELECTION, REFRESH_SUB_SELECTION } from "../queries.js";
import { progress, jsonOutput, jsonOutputWithPlan } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";

interface SubSelectionOption {
  id: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  optionType: string;
  status: string;
  isBookable: boolean;
  sortOrder: number;
}

interface SubSelection {
  id: string;
  type: string;
  selectedOptionId?: string;
  selectedOption?: { id: string; name: string; price?: number; description?: string };
  options: SubSelectionOption[];
}

interface PlanItemWithSubs {
  id: string;
  title: string;
  selection?: {
    id: string;
    isLocked: boolean;
    selectedOption?: {
      id: string;
      name: string;
      price?: number;
      status: string;
      subSelections?: SubSelection[];
    };
  };
}

interface PendingSubSelectionFull {
  itemTitle: string;
  parentOptionName: string;
  subSelection: SubSelection;
}

function findAllSubSelections(items: PlanItemWithSubs[]): PendingSubSelectionFull[] {
  const result: PendingSubSelectionFull[] = [];
  for (const item of items) {
    if (!item.selection?.selectedOption?.subSelections) continue;
    if (item.selection.isLocked) continue;
    for (const sub of item.selection.selectedOption.subSelections) {
      if (sub.options.length > 0) {
        result.push({
          itemTitle: item.title,
          parentOptionName: item.selection.selectedOption.name,
          subSelection: sub,
        });
      }
    }
  }
  return result;
}

function typeIcon(type: string): string {
  switch (type) {
    case "FLIGHT_CLASS": return "💺";
    case "HOTEL_ROOM": return "🛏️";
    default: return "📋";
  }
}

export function registerOptionsCommands(program: Command): void {
  program
    .command("options <planId>")
    .description("View sub-options (cabin class, room type) for a trip plan")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--refresh", "Refresh sub-selection options from provider")
    .action(async (planId: string, opts) => {
      try {
        const data = await graphql<{
          tripPlan: { id: string; title: string; items: PlanItemWithSubs[] };
        }>(GET_PLAN_DEEP, { id: planId });

        const plan = data.tripPlan;
        const allSubs = findAllSubSelections(plan.items);

        // If --refresh, refresh all sub-selections first
        if (opts.refresh) {
          progress("Refreshing options from provider...");
          for (const entry of allSubs) {
            try {
              const refreshed = await graphql<{
                refreshTripPlanSubSelectionOptions: SubSelectionOption[];
              }>(REFRESH_SUB_SELECTION, { subSelectionId: entry.subSelection.id });
              entry.subSelection.options = refreshed.refreshTripPlanSubSelectionOptions;
              process.stderr.write(chalk.dim(`  ✓ ${entry.itemTitle}: ${entry.subSelection.options.length} options\n`));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(chalk.yellow(`  ⚠ ${entry.itemTitle}: ${msg}\n`));
            }
          }
          console.log();
        }

        // Build global index map
        const optionMap: Array<{ subSelectionId: string; optionId: string; summary: string }> = [];

        for (const entry of allSubs) {
          const sorted = [...entry.subSelection.options].sort((a, b) => a.sortOrder - b.sortOrder);
          for (const opt of sorted) {
            optionMap.push({
              subSelectionId: entry.subSelection.id,
              optionId: opt.id,
              summary: `${opt.name}${opt.price != null ? ` · ${formatPrice(opt.price)}` : ""}`,
            });
          }
        }

        // Save options state so `pick` works in both human and scripted flows
        const stateToSave = {
          tripPlanId: plan.id,
          results: optionMap.map((entry, i) => ({
            index: i + 1,
            subSelectionId: entry.subSelectionId,
            optionId: entry.optionId,
            summary: entry.summary,
          })),
          timestamp: new Date().toISOString(),
        };
        saveOptionsState(stateToSave);

        if (opts.json) {
          let jsonIdx = 1;
          process.stdout.write(JSON.stringify({
            planId: plan.id,
            title: plan.title,
            subSelections: allSubs.map(entry => ({
              itemTitle: entry.itemTitle,
              parentOption: entry.parentOptionName,
              type: entry.subSelection.type,
              selected: entry.subSelection.selectedOption ?? null,
              options: [...entry.subSelection.options]
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map(o => ({
                  index: jsonIdx++,
                  id: o.id,
                  name: o.name,
                  description: o.description,
                  price: o.price,
                  optionType: o.optionType,
                })),
            })),
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const planUrl = `${deriveBaseUrl(getApiUrl())}/plans/${planId}`;
          const lines: string[] = [];
          lines.push(`## Sub-options — ${plan.title}`);
          lines.push("");

          if (allSubs.length === 0) {
            lines.push("_No sub-selection choices needed. All items are ready._");
            lines.push("");
            lines.push(`👉 **Plan:** ${planUrl}`);
            lines.push(`**Next:** \`voyagier cart ${planId}\``);
          } else {
            let displayIndex = 1;
            for (const entry of allSubs) {
              const sub = entry.subSelection;
              const label = subSelectionLabel(sub.type);
              lines.push(`### ${entry.itemTitle} — pick ${label}`);
              if (sub.selectedOption) {
                const price = sub.selectedOption.price != null ? ` · ${formatPrice(sub.selectedOption.price)}` : "";
                lines.push(`✅ **Currently selected:** ${sub.selectedOption.name}${price}`);
              }
              const sorted = [...sub.options].sort((a, b) => a.sortOrder - b.sortOrder);
              for (const opt of sorted) {
                const price = opt.price != null ? ` · ${formatPrice(opt.price)}` : "";
                const desc = opt.description ? ` — ${opt.description}` : "";
                const sel = sub.selectedOptionId === opt.id ? " ✅" : "";
                lines.push(`${displayIndex}. ${opt.name}${price}${desc}${sel}`);
                displayIndex++;
              }
              lines.push("");
            }
            lines.push(`👉 **Plan:** ${planUrl}`);
            lines.push("");
            lines.push("**Next:** `voyagier pick <number>`");
          }

          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        console.log(chalk.bold(`\n📋  Options — ${plan.title}\n`));

        if (allSubs.length === 0) {
          console.log(chalk.dim("  No sub-selection choices needed. All items are ready."));
          console.log(chalk.dim(`  Run: voyagier cart ${planId}`));
          console.log(chalk.dim(`  Plan: ${deriveBaseUrl(getApiUrl())}/plans/${planId}\n`));
          return;
        }

        let displayIndex = 1;
        for (const entry of allSubs) {
          const sub = entry.subSelection;
          const label = subSelectionLabel(sub.type);
          const icon = typeIcon(sub.type);

          console.log(`  ${icon}  ${chalk.white.bold(entry.itemTitle)} — pick ${label}`);
          console.log(chalk.dim(`      Parent: ${entry.parentOptionName}`));

          if (sub.selectedOption) {
            const sel = sub.selectedOption;
            const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
            console.log(chalk.green(`      ✓ Selected: ${sel.name}${price}`));
          }

          console.log();

          const sorted = [...sub.options].sort((a, b) => a.sortOrder - b.sortOrder);
          for (const opt of sorted) {
            const idx = chalk.bold.cyan(`[${displayIndex}]`);
            const name = chalk.white(opt.name);
            const price = opt.price != null ? chalk.green(formatPrice(opt.price)) : "";
            const desc = opt.description ? chalk.dim(` — ${opt.description}`) : "";
            const selected = sub.selectedOptionId === opt.id ? chalk.green(" ✓") : "";

            console.log(`      ${idx}  ${name}  ${price}${desc}${selected}`);
            displayIndex++;
          }
          console.log();
        }

        // Show hint based on what types of sub-selections are present
        const hasFlightClass = allSubs.some(s => s.subSelection.type === "FLIGHT_CLASS");
        const hasHotelRoom = allSubs.some(s => s.subSelection.type === "HOTEL_ROOM");
        if (hasFlightClass) console.log(hintCabinClass());
        if (hasHotelRoom) console.log(hintHotelRoom());

        console.log(chalk.dim(`\n  Select with: voyagier pick <number>`));
        console.log(chalk.dim(`  Example: voyagier pick 1`));
        console.log(chalk.dim(`  Plan: ${deriveBaseUrl(getApiUrl())}/plans/${planId}\n`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to load options: ${message}`);
      }
    });

  // `pick` command — selects a sub-option by number from `options` output
  program
    .command("pick <number>")
    .description("Select a sub-option by number (from `voyagier options`)")
    .option("--sub-selection-id <id>", "Explicit sub-selection ID (direct mode, skips state file)")
    .option("--option-id <id>", "Explicit option ID (direct mode)")
    .option("--plan <id>", "Assert that cached options belong to this trip plan (safety check for agent mode)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (numberStr: string, opts) => {
      // Direct mode: --sub-selection-id + --option-id
      if ((opts.subSelectionId && !opts.optionId) || (!opts.subSelectionId && opts.optionId)) {
        throw new CliError(CliErrorCode.VALIDATION, "Direct mode requires both --sub-selection-id and --option-id.");
      }
      if (opts.subSelectionId && opts.optionId) {
        try {
          const data = await graphql<{
            setTripPlanSubSelectionOption: {
              id: string;
              selectedOptionId: string;
              selectedOption: { id: string; name: string; price?: number };
            };
          }>(SET_SUB_SELECTION, { subSelectionId: opts.subSelectionId, optionId: opts.optionId });

          const selected = data.setTripPlanSubSelectionOption.selectedOption;

          if (opts.json) {
            jsonOutput({
              subSelectionId: opts.subSelectionId,
              selected: {
                id: selected.id,
                name: selected.name,
                price: selected.price,
              },
            });
          } else if (opts.agent) {
            const price = selected.price != null ? ` · ${formatPrice(selected.price)}` : "";
            process.stdout.write(`✅ **Selected:** ${selected.name}${price}\n`);
          } else {
            const price = selected.price != null ? ` · ${formatPrice(selected.price)}` : "";
            console.log(chalk.green(`\n  ✓ Selected: ${selected.name}${price}\n`));
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(CliErrorCode.API_ERROR, `Failed to select option: ${message}`);
        }
        return;
      }

      // Indexed mode: use state file
      const num = parseInt(numberStr, 10);
      if (isNaN(num) || num < 1) {
        throw new CliError(CliErrorCode.VALIDATION, "Invalid selection number. Run `voyagier options <planId>` first.");
      }

      const state = loadOptionsState();
      if (!state) {
        throw new CliError(CliErrorCode.VALIDATION, "No options context found. Run `voyagier options <planId>` first.");
      }

      if (opts.plan && state.tripPlanId !== opts.plan) {
        throw new CliError(CliErrorCode.VALIDATION, `Plan mismatch: options belong to plan ${state.tripPlanId}, not ${opts.plan}. Re-run voyagier options ${opts.plan}.`);
      }

      if (state.results.length === 0) {
        throw new CliError(CliErrorCode.VALIDATION, "No pending sub-selections found. All items may already have selections chosen.\n  Run: voyagier options <planId> to check current state");
      }

      const result = state.results.find(r => r.index === num);
      if (!result) {
        throw new CliError(CliErrorCode.NOT_FOUND, `Option [${num}] not found. Valid range: 1-${state.results.length}`);
      }

      try {
        const baseUrl = deriveBaseUrl(getApiUrl());

        const data = await graphql<{
          setTripPlanSubSelectionOption: {
            id: string;
            selectedOptionId: string;
            selectedOption: { id: string; name: string; price?: number };
          };
        }>(SET_SUB_SELECTION, { subSelectionId: result.subSelectionId, optionId: result.optionId });

        const selected = data.setTripPlanSubSelectionOption.selectedOption;

        if (opts.json) {
          jsonOutputWithPlan({
            subSelectionId: result.subSelectionId,
            selected: {
              id: selected.id,
              name: selected.name,
              price: selected.price,
            },
            url: `${baseUrl}/plans/${state.tripPlanId}`,
          }, state.tripPlanId);
          return;
        }

        if (opts.agent) {
          const planUrl = `${baseUrl}/plans/${state.tripPlanId}`;
          const price = selected.price != null ? ` · ${formatPrice(selected.price)}` : "";
          const lines = [
            `✅ **Selected:** ${selected.name}${price}`,
            "",
            `👉 **View & edit:** ${planUrl}`,
            "",
            `**Next:** \`voyagier cart ${state.tripPlanId}\``,
          ];
          process.stdout.write(lines.join("\n") + "\n");
          clearOptionsState();
          return;
        }

        const price = selected.price != null ? ` · ${formatPrice(selected.price)}` : "";
        console.log(chalk.green(`\n  ✓ Selected: ${selected.name}${price}\n`));
        console.log(chalk.dim(`  View cart: voyagier cart ${state.tripPlanId}`));
        console.log(chalk.dim(`  Plan: ${baseUrl}/plans/${state.tripPlanId}\n`));

        clearOptionsState();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to select option: ${message}`);
      }
    });
}
