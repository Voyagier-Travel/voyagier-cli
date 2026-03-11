import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { formatPrice, subSelectionLabel, deriveBaseUrl } from "../utils.js";
import { saveOptionsState, loadOptionsState, clearOptionsState } from "../state.js";
import { GET_PLAN_DEEP, SET_SUB_SELECTION, REFRESH_SUB_SELECTION } from "../queries.js";

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
    .option("--refresh", "Refresh sub-selection options from provider")
    .action(async (planId: string, opts) => {
      try {
        const data = await graphql<{
          tripPlan: { id: string; title: string; items: PlanItemWithSubs[] };
        }>(GET_PLAN_DEEP, { id: planId });

        const plan = data.tripPlan;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const allSubs = findAllSubSelections(plan.items);

        // If --refresh, refresh all sub-selections first
        if (opts.refresh && !opts.json) {
          process.stderr.write(chalk.dim("Refreshing options from provider...\n"));
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
        let globalIndex = 1;
        const optionMap: Array<{ subSelectionId: string; optionId: string; summary: string }> = [];

        for (const entry of allSubs) {
          const sorted = [...entry.subSelection.options].sort((a, b) => a.sortOrder - b.sortOrder);
          for (const opt of sorted) {
            optionMap.push({
              subSelectionId: entry.subSelection.id,
              optionId: opt.id,
              summary: `${opt.name}${opt.price != null ? ` · ${formatPrice(opt.price)}` : ""}`,
            });
            globalIndex++;
          }
        }

        if (opts.json) {
          // Use global indices in JSON to match what `pick` expects
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

        console.log(chalk.bold(`\n📋  Options — ${plan.title}\n`));

        if (allSubs.length === 0) {
          console.log(chalk.dim("  No sub-selection choices needed. All items are ready."));
          console.log(chalk.dim(`  Run: voyagier cart ${planId}\n`));
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

        // Save to separate options state file (does NOT clobber search state)
        saveOptionsState({
          tripPlanId: planId,
          results: optionMap.map((o, i) => ({
            index: i + 1,
            subSelectionId: o.subSelectionId,
            optionId: o.optionId,
            summary: o.summary,
          })),
          timestamp: new Date().toISOString(),
        });

        console.log(chalk.dim(`  Select with: voyagier pick <number>`));
        console.log(chalk.dim(`  Example: voyagier pick 1\n`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to load options: ${message}\n`));
        process.exit(1);
      }
    });

  // `pick` command — selects a sub-option by number from `options` output
  program
    .command("pick <number>")
    .description("Select a sub-option by number (from `voyagier options`)")
    .option("--json", "Output raw JSON")
    .action(async (numberStr: string, opts) => {
      const num = parseInt(numberStr, 10);
      if (isNaN(num) || num < 1) {
        process.stderr.write(chalk.red("Invalid selection number. Run `voyagier options <planId>` first.\n"));
        process.exit(1);
      }

      const state = loadOptionsState();
      if (!state) {
        process.stderr.write(chalk.red("No options context found. Run `voyagier options <planId>` first.\n"));
        process.exit(1);
      }

      const result = state.results.find(r => r.index === num);
      if (!result) {
        process.stderr.write(chalk.red(`Option [${num}] not found. Valid range: 1-${state.results.length}\n`));
        process.exit(1);
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
          process.stdout.write(JSON.stringify({
            subSelectionId: result.subSelectionId,
            selected: {
              id: selected.id,
              name: selected.name,
              price: selected.price,
            },
            tripPlanUrl: `${baseUrl}/plans/${state.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        const price = selected.price != null ? ` · ${formatPrice(selected.price)}` : "";
        console.log(chalk.green(`\n  ✓ Selected: ${selected.name}${price}\n`));
        console.log(chalk.dim(`  View cart: voyagier cart ${state.tripPlanId}`));
        console.log(chalk.dim(`  Plan: ${baseUrl}/plans/${state.tripPlanId}\n`));

        clearOptionsState();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to select option: ${message}\n`));
        process.exit(1);
      }
    });
}
