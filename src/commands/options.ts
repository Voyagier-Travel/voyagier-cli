import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { formatPrice } from "../utils.js";
import { saveSearchState, loadSearchState, clearSearchState } from "../state.js";

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
  selectedOption?: { id: string; name: string; price?: number };
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

const GET_PLAN_DEEP = `
  query TripPlanDeep($id: String!) {
    tripPlan(id: $id) {
      id
      title
      items {
        id
        title
        selection {
          id
          isLocked
          selectedOption {
            id
            name
            price
            status
            subSelections {
              id
              type
              selectedOptionId
              selectedOption { id name price description }
              options {
                id
                name
                description
                price
                currency
                optionType
                status
                isBookable
                sortOrder
              }
            }
          }
        }
      }
    }
  }
`;

const SET_SUB_SELECTION = `
  mutation SetTripPlanSubSelectionOption($subSelectionId: String!, $optionId: String!) {
    setTripPlanSubSelectionOption(subSelectionId: $subSelectionId, optionId: $optionId) {
      id
      selectedOptionId
      selectedOption {
        id
        name
        price
      }
    }
  }
`;

const REFRESH_SUB_SELECTION = `
  mutation RefreshTripPlanSubSelectionOptions($subSelectionId: String!) {
    refreshTripPlanSubSelectionOptions(subSelectionId: $subSelectionId) {
      id
      name
      description
      price
      optionType
      status
      isBookable
      sortOrder
    }
  }
`;

function typeLabel(type: string): string {
  switch (type) {
    case "FLIGHT_CLASS": return "cabin class";
    case "HOTEL_ROOM": return "room type";
    case "ACTIVITY_BOOKABLE_ITEM": return "activity option";
    default: return type.toLowerCase().replace(/_/g, " ");
  }
}

function typeIcon(type: string): string {
  switch (type) {
    case "FLIGHT_CLASS": return "💺";
    case "HOTEL_ROOM": return "🛏️";
    default: return "📋";
  }
}

interface PendingSubSelection {
  itemTitle: string;
  parentOptionName: string;
  subSelection: SubSelection;
}

function findPendingSubSelections(items: PlanItemWithSubs[]): PendingSubSelection[] {
  const pending: PendingSubSelection[] = [];
  for (const item of items) {
    if (!item.selection?.selectedOption?.subSelections) continue;
    if (item.selection.isLocked) continue;
    for (const sub of item.selection.selectedOption.subSelections) {
      if (sub.options.length > 0) {
        pending.push({
          itemTitle: item.title,
          parentOptionName: item.selection.selectedOption.name,
          subSelection: sub,
        });
      }
    }
  }
  return pending;
}

export function registerOptionsCommands(program: Command): void {
  const cmd = program
    .command("options <planId>")
    .description("View and select sub-options (cabin class, room type) for a trip plan")
    .option("--json", "Output raw JSON")
    .option("--refresh", "Refresh sub-selection options from provider")
    .action(async (planId: string, opts) => {
      try {
        const data = await graphql<{
          tripPlan: { id: string; title: string; items: PlanItemWithSubs[] };
        }>(GET_PLAN_DEEP, { id: planId });

        const plan = data.tripPlan;
        const allPending = findPendingSubSelections(plan.items);

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            planId: plan.id,
            title: plan.title,
            subSelections: allPending.map((p, idx) => ({
              index: idx + 1,
              itemTitle: p.itemTitle,
              parentOption: p.parentOptionName,
              type: p.subSelection.type,
              selected: p.subSelection.selectedOption ?? null,
              options: p.subSelection.options.map((o, oi) => ({
                index: oi + 1,
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

        if (allPending.length === 0) {
          console.log(chalk.dim("  No sub-selection choices needed. All items are ready."));
          console.log(chalk.dim(`  Run: voyagier cart ${planId}\n`));
          return;
        }

        // If --refresh, refresh all pending sub-selections
        if (opts.refresh) {
          process.stderr.write(chalk.dim("Refreshing options from provider...\n"));
          for (const pending of allPending) {
            try {
              const refreshed = await graphql<{
                refreshTripPlanSubSelectionOptions: SubSelectionOption[];
              }>(REFRESH_SUB_SELECTION, { subSelectionId: pending.subSelection.id });
              pending.subSelection.options = refreshed.refreshTripPlanSubSelectionOptions;
              process.stderr.write(chalk.dim(`  ✓ ${pending.itemTitle}: ${pending.subSelection.options.length} options\n`));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(chalk.yellow(`  ⚠ ${pending.itemTitle}: ${msg}\n`));
            }
          }
          console.log();
        }

        let globalIndex = 1;
        const optionMap: Array<{ subSelectionId: string; optionId: string; summary: string }> = [];

        for (const pending of allPending) {
          const sub = pending.subSelection;
          const label = typeLabel(sub.type);
          const icon = typeIcon(sub.type);

          console.log(`  ${icon}  ${chalk.white.bold(pending.itemTitle)} — pick ${label}`);
          console.log(chalk.dim(`      Parent: ${pending.parentOptionName}`));

          if (sub.selectedOption) {
            const sel = sub.selectedOption;
            const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
            console.log(chalk.green(`      ✓ Selected: ${sel.name}${price}`));
          }

          console.log();

          const sorted = [...sub.options].sort((a, b) => a.sortOrder - b.sortOrder);
          for (const opt of sorted) {
            const idx = chalk.bold.cyan(`[${globalIndex}]`);
            const name = chalk.white(opt.name);
            const price = opt.price != null ? chalk.green(formatPrice(opt.price)) : "";
            const desc = opt.description ? chalk.dim(` — ${opt.description}`) : "";
            const selected = sub.selectedOptionId === opt.id ? chalk.green(" ✓") : "";

            console.log(`      ${idx}  ${name}  ${price}${desc}${selected}`);

            optionMap.push({
              subSelectionId: sub.id,
              optionId: opt.id,
              summary: `${opt.name}${opt.price != null ? ` · ${formatPrice(opt.price)}` : ""}`,
            });
            globalIndex++;
          }
          console.log();
        }

        // Save option map to state for `options select <n>`
        saveSearchState({
          type: "flights", // reuse type field — doesn't matter for sub-selections
          tripPlanId: planId,
          selectionId: "sub-selection",
          results: optionMap.map((o, i) => ({
            index: i + 1,
            optionId: o.optionId,
            flightToken: o.subSelectionId, // repurpose flightToken to carry subSelectionId
            summary: o.summary,
          })),
          timestamp: new Date().toISOString(),
        });

        console.log(chalk.dim(`  Select with: voyagier options select <number>`));
        console.log(chalk.dim(`  Example: voyagier options select 1\n`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to load options: ${message}\n`));
        process.exit(1);
      }
    });

  program
    .command("options-select <number>")
    .description("Select a sub-option by number (from `voyagier options`)")
    .option("--json", "Output raw JSON")
    .action(async (numberStr: string, opts) => {
      const num = parseInt(numberStr, 10);
      if (isNaN(num) || num < 1) {
        process.stderr.write(chalk.red("Invalid selection number. Run `voyagier options <planId>` first.\n"));
        process.exit(1);
      }

      const state = loadSearchState();
      if (!state || state.selectionId !== "sub-selection") {
        process.stderr.write(chalk.red("No options context found. Run `voyagier options <planId>` first.\n"));
        process.exit(1);
      }

      const result = state.results.find(r => r.index === num);
      if (!result) {
        process.stderr.write(chalk.red(`Option [${num}] not found. Valid range: 1-${state.results.length}\n`));
        process.exit(1);
      }

      const subSelectionId = result.flightToken!; // stored in flightToken field
      const optionId = result.optionId;

      try {
        const data = await graphql<{
          setTripPlanSubSelectionOption: {
            id: string;
            selectedOptionId: string;
            selectedOption: { id: string; name: string; price?: number };
          };
        }>(SET_SUB_SELECTION, { subSelectionId, optionId });

        const selected = data.setTripPlanSubSelectionOption.selectedOption;

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            subSelectionId,
            selected: {
              id: selected.id,
              name: selected.name,
              price: selected.price,
            },
            tripPlanUrl: `https://voyagier.com/plans/${state.tripPlanId}`,
          }, null, 2) + "\n");
          return;
        }

        const price = selected.price != null ? ` · ${formatPrice(selected.price)}` : "";
        console.log(chalk.green(`\n  ✓ Selected: ${selected.name}${price}\n`));
        console.log(chalk.dim(`  View cart: voyagier cart ${state.tripPlanId}`));
        console.log(chalk.dim(`  Plan: https://voyagier.com/plans/${state.tripPlanId}\n`));

        // Clear the sub-selection state
        clearSearchState();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to select option: ${message}\n`));
        process.exit(1);
      }
    });
}
