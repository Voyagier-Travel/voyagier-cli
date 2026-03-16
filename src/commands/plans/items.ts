import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { GET_PLAN_DEEP } from "../../queries.js";
import { formatPrice } from "../../utils.js";
import { fatal, jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { typeIcon, inferItemType, itemStatus, DeepItem } from "./types.js";

export function registerItemCommands(plans: Command): void {
  plans
    .command("items <planId>")
    .description("List items in a trip plan with IDs and status")
    .option("--json", "Output raw JSON")
    .action(async (planId: string, opts) => {
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
              const sel = item.selection;
              return {
                id: item.id,
                type: item.type,
                title: item.title,
                inferredType,
                selectionId: sel?.id ?? null,
                selectedOption: sel?.selectedOption
                  ? { id: sel.selectedOption.id, name: sel.selectedOption.name, price: sel.selectedOption.price ?? null }
                  : null,
                status,
                subSelections: (sel?.selectedOption?.subSelections ?? []).map(s => ({
                  id: s.id,
                  type: s.type,
                  selectedOptionId: s.selectedOptionId ?? null,
                  optionCount: s.options.length,
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
          const sel = item.selection?.selectedOption;
          const price = sel?.price != null ? chalk.green(` ${formatPrice(sel.price)}`) : "";
          const selName = sel ? `  → ${sel.name}${price}` : "";
          console.log(`  ${icon}  ${chalk.white(item.title)}  ${statusLabel}${selName}`);
          console.log(chalk.dim(`      ID: ${item.id}${item.selection ? `  ·  sel: ${item.selection.id}` : ""}`));
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
            `mutation DeleteTripPlanItem($id: String!) { deleteTripPlanItem(id: $id) }`,
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
            `mutation DeleteTripPlanItem($id: String!) { deleteTripPlanItem(id: $id) }`,
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
