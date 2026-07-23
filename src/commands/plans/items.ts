import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { GET_PLAN_DEEP, DELETE_TRIP_PLAN_ITEM } from "../../queries.js";
import { formatPrice } from "../../utils.js";
import { resolvePlanArg } from "../../resolve-plan-arg.js";
import { fatal, jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { typeIcon, inferItemType, itemStatus, deepChosenOption, deepSubSelections, DeepItem } from "./types.js";
import { deriveChosen } from "../../choices.js";

export function registerItemCommands(plans: Command): void {
  plans
    .command("items [planId]")
    .description("List items in a trip plan with IDs and status")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (planIdInput: string | undefined, opts) => {
      const planId = resolvePlanArg(planIdInput, opts, "plans items");
      try {
        const data = await graphql<{ tripPlan: { id: string; title: string; items: DeepItem[] } }>(
          GET_PLAN_DEEP, { id: planId }
        );
        const plan = data.tripPlan;

        if (opts.json) {
          jsonOutput({
            planId: plan.id,
            items: plan.items.map(item => {
              const inferredType = inferItemType(item.title);
              const status = itemStatus(item);
              const selections = item.selections ?? [];
              return {
                id: item.id,
                type: item.type,
                title: item.title,
                inferredType,
                status,
                selections: selections.map(sel => {
                  const chosen = deepChosenOption(sel);
                  return {
                    id: sel.id,
                    type: sel.type ?? null,
                    isLocked: sel.isLocked ?? null,
                    selectedOption: chosen
                      ? { id: chosen.id, name: chosen.name, price: chosen.price ?? null }
                      : null,
                  };
                }),
                subSelections: deepSubSelections(item).map(({ selection }) => ({
                  id: selection.id,
                  type: selection.type ?? null,
                  // Consensus-derived (VOY-1701): new-model picks never write parentOptionId.
                  selectedOptionId: deriveChosen(selection).chosenOptionId,
                  optionCount: (selection.options ?? []).length,
                })),
              };
            }),
          });
          return;
        }

        console.log(chalk.bold(`\n  Items — ${plan.title}\n`));
        if (plan.items.length === 0) {
          console.log(chalk.dim("  No items yet."));
          console.log();
          return;
        }
        for (const item of plan.items) {
          const icon = typeIcon(item.type, item.title);
          const status = itemStatus(item);
          const statusLabel = status === "selected"
            ? chalk.green("✓ selected")
            : status === "needs_sub_selection"
              ? chalk.yellow("⚠ needs sub-selection")
              : chalk.dim("pending");
          // Show the chosen option from the first selection that has one (if any),
          // and print THAT selection's id (not selections[0]) so the displayed sel
          // matches the shown option. Fall back to the first selection when none chosen.
          const selections = item.selections ?? [];
          const chosenSel = selections.find((s) => deepChosenOption(s) != null) ?? null;
          const firstChosen = chosenSel ? deepChosenOption(chosenSel) : null;
          const price = firstChosen?.price != null ? chalk.green(` ${formatPrice(firstChosen.price)}`) : "";
          const selName = firstChosen ? `  → ${firstChosen.name}${price}` : "";
          const shownSelId = (chosenSel ?? selections[0])?.id;
          console.log(`  ${icon}  ${chalk.white(item.title)}  ${statusLabel}${selName}`);
          console.log(chalk.dim(`      ID: ${item.id}${shownSelId ? `  ·  sel: ${shownSelId}` : ""}`));
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to get items: ${message}`);
      }
    });

  plans
    .command("remove-item [itemId]")
    .description("Remove item(s) from a trip plan")
    .option("--plan <planId>", "Trip plan ID (for --type and --all)")
    .option("--type <type>", "Remove all items of type: flight or hotel")
    .option("--all", "Remove all items from the plan")
    .option("--json", "Output raw JSON")
    .action(async (itemId: string | undefined, opts) => {
      try {
        // Single item by ID
        if (itemId && !opts.type && !opts.all) {
          await graphql<{ deleteTripPlanItem: boolean }>(
            DELETE_TRIP_PLAN_ITEM,
            { id: itemId }
          );
          if (opts.json) {
            jsonOutput({ success: true, deleted: [itemId] });
          } else {
            console.log(chalk.green(`✓ Removed item ${itemId}`));
          }
          return;
        }

        // Bulk delete: requires --plan
        if (!opts.plan) {
          fatal("--plan <planId> is required for --type and --all");
        }

        const data = await graphql<{ tripPlan: { id: string; items: DeepItem[] } }>(
          GET_PLAN_DEEP, { id: opts.plan }
        );

        let items = data.tripPlan.items;

        if (opts.type) {
          const validTypes = ["flight", "hotel"];
          const normalizedType = opts.type.toLowerCase();
          if (!validTypes.includes(normalizedType)) {
            fatal(`Invalid --type "${opts.type}". Valid values: ${validTypes.join(", ")}`);
          }
          items = items.filter(item => inferItemType(item.title) === normalizedType);
        }

        const deleted: string[] = [];
        for (const item of items) {
          await graphql<{ deleteTripPlanItem: boolean }>(
            DELETE_TRIP_PLAN_ITEM,
            { id: item.id }
          );
          deleted.push(item.id);
        }

        if (opts.json) {
          jsonOutput({ success: true, deleted });
        } else {
          console.log(chalk.green(`✓ Removed ${deleted.length} item${deleted.length !== 1 ? "s" : ""}`));
        }
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to remove item(s): ${message}`);
      }
    });
}
