import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { validateDate, warnPastDate, formatPrice, deriveBaseUrl } from "../utils.js";
import { fatal, jsonOutput } from "../output.js";
import { GET_PLAN_DEEP } from "../queries.js";

interface DeepSubSelection {
  id: string;
  type: string;
  selectedOptionId?: string;
  options: Array<{ id: string }>;
}

interface DeepSelectedOption {
  id: string;
  name: string;
  price?: number;
  status: string;
  subSelections?: DeepSubSelection[];
}

interface DeepSelection {
  id: string;
  isLocked: boolean;
  selectedOption?: DeepSelectedOption;
}

interface DeepItem {
  id: string;
  type: string;
  title: string;
  selection?: DeepSelection;
}

function inferItemType(title: string): "flight" | "hotel" | "other" {
  const t = title.toLowerCase();
  if (t.includes("hotel")) return "hotel";
  if (t.includes("flight")) return "flight";
  return "other";
}

function itemStatus(item: DeepItem): "selected" | "pending" | "needs_sub_selection" {
  if (!item.selection?.selectedOption) return "pending";
  const subs = item.selection.selectedOption.subSelections ?? [];
  const hasPendingSub = subs.some(s => !s.selectedOptionId && s.options.length > 0);
  return hasPendingSub ? "needs_sub_selection" : "selected";
}

interface TripPlan {
  id: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  itemCount?: number;
}

interface TripPlanItem {
  id: string;
  type: string;
  title: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  day?: number;
}

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
  declaredTravellerType?: string;
}

interface SelectionInfo {
  id: string;
  selectedOption?: { id: string; name: string; price?: number; status: string };
}

interface TripPlanItemDetail extends TripPlanItem {
  selection?: SelectionInfo;
}

interface PaginatedTripPlans {
  tripPlans: {
    items: TripPlan[];
    count: number;
    page: number;
    limit: number;
  };
}

interface TripPlanDetail {
  tripPlan: TripPlan & {
    items: TripPlanItemDetail[];
    travellers: Traveller[];
  };
}

function planUrl(id: string): string {
  const baseUrl = deriveBaseUrl(getApiUrl());
  return `${baseUrl}/plans/${id}`;
}

export function registerPlanCommands(program: Command): void {
  const plans = program.command("plans").description("Manage trip plans");

  plans
    .command("create")
    .description("Create a new trip plan")
    .requiredOption("--title <title>", "Trip plan title")
    .option("--start <date>", "Start date (YYYY-MM-DD)")
    .option("--end <date>", "End date (YYYY-MM-DD)")
    .option("--description <text>", "Description")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL query without executing")
    .action(async (opts) => {
      try {
        if (opts.start) {
          validateDate(opts.start, "--start");
          warnPastDate(opts.start, "--start");
        }
        if (opts.end) {
          validateDate(opts.end, "--end");
          warnPastDate(opts.end, "--end");
        }

        const input: Record<string, unknown> = { title: opts.title };
        if (opts.start) input.startDate = opts.start;
        if (opts.end) input.endDate = opts.end;
        if (opts.description) input.description = opts.description;

        const data = await graphql<{ createTripPlan: TripPlan }>(
          `mutation CreateTripPlan($input: CreateTripPlanInput!) {
            createTripPlan(input: $input) { id title startDate endDate description }
          }`,
          { input },
          { dryRun: opts.dryRun }
        );

        const plan = data.createTripPlan;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...plan, url: planUrl(plan.id) }, null, 2) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Created trip plan: ${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        console.log(chalk.dim(`  URL: ${planUrl(plan.id)}`));
        if (plan.startDate || plan.endDate) {
          console.log(chalk.dim(`  Dates: ${plan.startDate ?? "?"} → ${plan.endDate ?? "?"}`));
        }
        console.log(chalk.dim(`\n  Next: voyagier travellers add --plan ${plan.id} --first <name> --last <name> --type ADULT`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to create plan: ${message}\n`));
        process.exit(1);
      }
    });

  plans
    .command("list")
    .description("List your trip plans")
    .option("--page <n>", "Page number", "1")
    .option("--limit <n>", "Results per page", "20")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const page = parseInt(opts.page, 10);
        const limit = parseInt(opts.limit, 10);

        if (!Number.isFinite(page) || page < 1) {
          fatal("--page must be an integer ≥ 1.");
        }
        if (!Number.isFinite(limit) || limit < 1) {
          fatal("--limit must be an integer ≥ 1.");
        }

        const data = await graphql<PaginatedTripPlans>(
          `query TripPlans($page: Int, $limit: Int) {
            tripPlans(page: $page, limit: $limit) {
              items { id title startDate endDate itemCount }
              count page limit
            }
          }`,
          { page, limit }
        );

        const { items, count: total } = data.tripPlans;

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            items: items.map((p) => ({ ...p, url: planUrl(p.id) })),
            total,
            page,
            limit,
          }, null, 2) + "\n");
          return;
        }

        if (items.length === 0) {
          console.log(chalk.dim("No trip plans found."));
          return;
        }

        const pageInfo = total > limit ? ` (page ${page}, showing ${items.length} of ${total})` : "";
        console.log(chalk.bold(`\n${total} trip plan${total > 1 ? "s" : ""}${pageInfo}:\n`));
        for (const plan of items) {
          const dates = plan.startDate ? `${plan.startDate}${plan.endDate ? ` → ${plan.endDate}` : ""}` : "";
          const itemsLabel = plan.itemCount ? `${plan.itemCount} items` : "empty";
          console.log(`  📋  ${chalk.white(plan.title)}  ${chalk.dim(dates)}`);
          console.log(chalk.dim(`      ${plan.id}  ·  ${itemsLabel}`));
        }

        if (total > page * limit) {
          console.log(chalk.dim(`\n  Next page: voyagier plans list --page ${page + 1}`));
        }
        console.log();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to list plans: ${message}\n`));
        process.exit(1);
      }
    });

  plans
    .command("get <id>")
    .description("Show trip plan details")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        const data = await graphql<TripPlanDetail>(
          `query TripPlan($id: String!) {
            tripPlan(id: $id) {
              id title description startDate endDate
              items {
                id type title date startTime endTime day
                selection { id selectedOption { id name price status } }
              }
              travellers { id firstName lastName declaredTravellerType }
            }
          }`,
          { id }
        );

        const plan = data.tripPlan;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...plan, url: planUrl(plan.id) }, null, 2) + "\n");
          return;
        }

        console.log(chalk.bold(`\n${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        console.log(chalk.dim(`  URL: ${planUrl(plan.id)}`));
        if (plan.startDate || plan.endDate) {
          console.log(chalk.dim(`  Dates: ${plan.startDate ?? "?"} → ${plan.endDate ?? "?"}`));
        }
        if (plan.description) console.log(chalk.dim(`  ${plan.description}`));

        if (plan.travellers?.length) {
          console.log(chalk.bold(`\n  Travellers:`));
          for (const t of plan.travellers) {
            console.log(`    👤  ${t.firstName} ${t.lastName}  ·  ${t.declaredTravellerType ?? "ADULT"}`);
          }
        }

        if (plan.items?.length) {
          console.log(chalk.bold(`\n  Items (${plan.items.length}):`));
          for (const item of plan.items) {
            const icon = typeIcon(item.type, item.title);
            const time = item.startTime ? ` at ${item.startTime}` : "";
            const day = item.day ? ` Day ${item.day}` : "";
            let line = `    ${icon}  ${item.title}${day}${time}`;

            if (item.selection?.selectedOption) {
              const sel = item.selection.selectedOption;
              const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
              const status = sel.status && sel.status !== "NONE" ? ` [${sel.status}]` : "";
              line += chalk.green(`  → ${sel.name}${price}${status}`);
            } else if (item.selection) {
              line += chalk.yellow("  → awaiting selection");
            }

            console.log(line);
          }
        }

        console.log();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to get plan: ${message}\n`));
        process.exit(1);
      }
    });

  plans
    .command("summary <id>")
    .description("Compact one-screen summary of a trip plan")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        const data = await graphql<TripPlanDetail>(
          `query TripPlan($id: String!) {
            tripPlan(id: $id) {
              id title startDate endDate
              items {
                id type title day
                selection { id selectedOption { id name price status } }
              }
              travellers { id firstName lastName declaredTravellerType }
            }
          }`,
          { id }
        );

        const plan = data.tripPlan;

        if (opts.json) {
          const summary = {
            id: plan.id,
            title: plan.title,
            url: planUrl(plan.id),
            dates: plan.startDate && plan.endDate ? `${plan.startDate} → ${plan.endDate}` : null,
            travellers: (plan.travellers ?? []).map((t) => `${t.firstName} ${t.lastName} (${t.declaredTravellerType ?? "ADULT"})`),
            items: (plan.items ?? []).map((item) => ({
              type: item.type,
              title: item.title,
              selected: item.selection?.selectedOption?.name ?? null,
              price: item.selection?.selectedOption?.price ?? null,
              status: item.selection?.selectedOption?.status ?? null,
            })),
          };
          process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
          return;
        }

        const dates = plan.startDate && plan.endDate ? `  ${chalk.dim(`${plan.startDate} → ${plan.endDate}`)}` : "";
        console.log(chalk.bold(`\n${plan.title}`) + dates);
        console.log(chalk.dim(`${planUrl(plan.id)}\n`));

        // Travellers line
        const travellers = plan.travellers ?? [];
        if (travellers.length > 0) {
          const names = travellers.map((t) => `${t.firstName} ${t.lastName}`).join(", ");
          console.log(`  👤  ${names}`);
        }

        // Items
        const items = plan.items ?? [];
        if (items.length > 0) {
          console.log();
          for (const item of items) {
            const icon = typeIcon(item.type, item.title);
            const sel = item.selection?.selectedOption;
            if (sel) {
              const price = sel.price != null ? chalk.green(` ${formatPrice(sel.price)}`) : "";
              const status = sel.status && sel.status !== "NONE" ? chalk.dim(` [${sel.status}]`) : "";
              console.log(`  ${icon}  ${sel.name}${price}${status}`);
            } else if (item.selection) {
              console.log(`  ${icon}  ${item.title}  ${chalk.yellow("⏳ pending")}`);
            } else {
              console.log(`  ${icon}  ${item.title}`);
            }
          }
        } else {
          console.log(chalk.dim("  No items yet."));
        }

        console.log();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to get plan summary: ${message}\n`));
        process.exit(1);
      }
    });

  plans
    .command("delete <id>")
    .description("Delete a trip plan")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await graphql<{ deleteTripPlan: boolean }>(
          `mutation DeleteTripPlan($id: String!) { deleteTripPlan(id: $id) }`,
          { id }
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify({ success: true, id }) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Deleted trip plan ${id}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to delete plan: ${message}\n`));
        process.exit(1);
      }
    });

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
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to get items: ${message}\n`));
        process.exit(1);
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
          items = items.filter(item => inferItemType(item.title) === opts.type.toLowerCase());
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
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to remove item(s): ${message}\n`));
        process.exit(1);
      }
    });

  plans
    .command("update <id>")
    .description("Update a trip plan's title, dates, or description")
    .option("--title <title>", "New title")
    .option("--start <date>", "New start date (YYYY-MM-DD)")
    .option("--end <date>", "New end date (YYYY-MM-DD)")
    .option("--description <text>", "New description")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        if (opts.start) {
          validateDate(opts.start, "--start");
          warnPastDate(opts.start, "--start");
        }
        if (opts.end) {
          validateDate(opts.end, "--end");
          warnPastDate(opts.end, "--end");
        }

        const input: Record<string, unknown> = {};
        if (opts.title) input.title = opts.title;
        if (opts.start) input.startDate = opts.start;
        if (opts.end) input.endDate = opts.end;
        if (opts.description) input.description = opts.description;

        if (Object.keys(input).length === 0) {
          fatal("At least one of --title, --start, --end, --description must be provided.");
        }

        const data = await graphql<{ updateTripPlan: TripPlan }>(
          `mutation UpdateTripPlan($id: String!, $input: UpdateTripPlanInput!) {
            updateTripPlan(id: $id, input: $input) { id title startDate endDate description }
          }`,
          { id, input }
        );

        const plan = data.updateTripPlan;

        if (opts.json) {
          jsonOutput({ ...plan, url: planUrl(plan.id) });
          return;
        }

        console.log(chalk.green(`✓ Updated trip plan: ${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        if (plan.startDate || plan.endDate) {
          console.log(chalk.dim(`  Dates: ${plan.startDate ?? "?"} → ${plan.endDate ?? "?"}`));
        }
        if (plan.description) console.log(chalk.dim(`  ${plan.description}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to update plan: ${message}\n`));
        process.exit(1);
      }
    });
}

function typeIcon(type: string, title?: string): string {
  const t = (type ?? "").toLowerCase();
  // API returns "Selection" for all search-created items — infer from title
  if (t === "selection" && title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes("hotel")) return "🏨";
    if (titleLower.includes("flight")) return "✈️";
    return "📋";
  }
  switch (t) {
    case "flight":
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
