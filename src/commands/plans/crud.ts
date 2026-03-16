import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { printPlanFooter, getPlanSummary } from "../../plan-footer.js";
import { validateDate, warnPastDate, formatPrice, formatDateRange } from "../../utils.js";
import { fatal, jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { planUrl, typeIcon, TripPlan, TripPlanDetail, PaginatedTripPlans } from "./types.js";
import {
  CREATE_TRIP_PLAN,
  GET_TRIP_PLANS,
  GET_TRIP_PLAN,
  GET_TRIP_PLAN_SUMMARY,
  UPDATE_TRIP_PLAN,
  GET_TRIP_PLAN_WITH_DESC,
  DELETE_TRIP_PLAN,
} from "../../queries.js";

export function registerCrudCommands(plans: Command): void {
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
          CREATE_TRIP_PLAN,
          { input },
          { dryRun: opts.dryRun }
        );

        const plan = data.createTripPlan;

        if (opts.json) {
          const planSummary = await getPlanSummary(plan.id);
          jsonOutput({ ...plan, url: planUrl(plan.id), planSummary });
          return;
        }

        console.log(chalk.green(`✓ Created trip plan: ${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        console.log(chalk.dim(`  URL: ${planUrl(plan.id)}`));
        if (plan.startDate || plan.endDate) {
          const dateRange = formatDateRange(plan.startDate, plan.endDate);
          if (dateRange) console.log(chalk.dim(`  Dates: ${dateRange}`));
        }
        console.log(chalk.dim(`\n  Next: voyagier travellers add --plan ${plan.id} --first <name> --last <name> --type ADULT`));
        await printPlanFooter(plan.id);
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to create plan: ${message}`);
      }
    });

  plans
    .command("list")
    .description("List your trip plans")
    .option("--page <n>", "Page number", "1")
    .option("--limit <n>", "Results per page", "20")
    .option("--active", "Show only future/ongoing plans (endDate >= today or no dates set)")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
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

        const fetchLimit = opts.active ? 100 : limit;
        const fetchPage = opts.active ? 1 : page;

        const data = await graphql<PaginatedTripPlans>(
          GET_TRIP_PLANS,
          { page: fetchPage, limit: fetchLimit }
        );

        let { items } = data.tripPlans;
        const total = data.tripPlans.count;

        if (opts.active) {
          const today = new Date().toISOString().slice(0, 10);
          items = items.filter((p) => !p.endDate || p.endDate >= today);
          items.sort((a, b) => {
            if (!a.startDate && !b.startDate) return 0;
            if (!a.startDate) return 1;
            if (!b.startDate) return -1;
            return b.startDate.localeCompare(a.startDate);
          });
        }

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            items: items.map((p) => ({ ...p, url: planUrl(p.id) })),
            total: opts.active ? items.length : total,
            page: opts.active ? 1 : page,
            limit: opts.active ? items.length : limit,
            ...(opts.active ? { filtered: true } : {}),
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const lines: string[] = [];
          lines.push(opts.active ? "## Your Active Trip Plans" : "## Your Trip Plans");
          lines.push("");
          if (items.length === 0) {
            lines.push("_No trip plans found._");
          } else {
            items.forEach((p, i) => {
              const dates = formatDateRange(p.startDate, p.endDate);
              lines.push(`${i + 1}. **${p.title}**${dates ? `  —  ${dates}` : ""}`);
              lines.push(`   👉 ${planUrl(p.id)}`);
            });
            if (!opts.active && total > page * limit) {
              lines.push("");
              lines.push(`_Page ${page} of ${Math.ceil(total / limit)}. Next: \`voyagier plans list --page ${page + 1}\`_`);
            }
          }
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (items.length === 0) {
          console.log(chalk.dim(opts.active ? "No active trip plans found." : "No trip plans found."));
          return;
        }

        const displayTotal = opts.active ? items.length : total;
        const pageInfo = !opts.active && total > limit ? ` (page ${page}, showing ${items.length} of ${total})` : "";
        const label = opts.active ? " active" : "";
        console.log(chalk.bold(`\n${displayTotal}${label} trip plan${displayTotal > 1 ? "s" : ""}${pageInfo}:\n`));
        for (const plan of items) {
          const dates = formatDateRange(plan.startDate, plan.endDate);
          console.log(`  📋  ${chalk.white(plan.title)}  ${chalk.dim(dates)}`);
          console.log(chalk.dim(`      ${plan.id}`));
        }

        if (!opts.active && total > page * limit) {
          console.log(chalk.dim(`\n  Next page: voyagier plans list --page ${page + 1}`));
        }
        console.log();
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to list plans: ${message}`);
      }
    });

  plans
    .command("get <id>")
    .description("Show trip plan details")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (id: string, opts) => {
      try {
        const data = await graphql<TripPlanDetail>(
          GET_TRIP_PLAN,
          { id }
        );

        const plan = data.tripPlan;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...plan, url: planUrl(plan.id) }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const url = planUrl(plan.id);
          const dateRange = formatDateRange(plan.startDate, plan.endDate);
          const lines: string[] = [];
          lines.push(`## ${plan.title}`);
          if (dateRange) lines.push(`**${dateRange}**`);
          if (plan.description) lines.push(`_${plan.description}_`);
          lines.push("");
          lines.push(`👉 **View & edit:** ${url}`);

          if (plan.travellers?.length) {
            lines.push("");
            lines.push("### Travellers");
            for (const t of plan.travellers) {
              lines.push(`👤 ${t.firstName} ${t.lastName} — ${t.declaredTravellerType ?? "ADULT"}`);
            }
          }

          if (plan.items?.length) {
            lines.push("");
            lines.push("### Items");
            for (const item of plan.items) {
              const icon = typeIcon(item.type, item.title);
              if (item.selection?.selectedOption) {
                const sel = item.selection.selectedOption;
                const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
                const status = sel.status && sel.status !== "NONE" ? ` [${sel.status}]` : "";
                lines.push(`- ${icon} **${item.title}** → ${sel.name}${price}${status}`);
              } else if (item.selection) {
                lines.push(`- ${icon} **${item.title}** → ⏳ awaiting selection`);
              } else {
                lines.push(`- ${icon} **${item.title}**`);
              }
            }
          }

          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        console.log(chalk.bold(`\n${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        console.log(chalk.dim(`  URL: ${planUrl(plan.id)}`));
        if (plan.startDate || plan.endDate) {
          const dateRange = formatDateRange(plan.startDate, plan.endDate);
          if (dateRange) console.log(chalk.dim(`  Dates: ${dateRange}`));
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
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to get plan: ${message}`);
      }
    });

  plans
    .command("summary <id>")
    .description("Compact one-screen summary of a trip plan")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (id: string, opts) => {
      try {
        const data = await graphql<TripPlanDetail>(
          GET_TRIP_PLAN_SUMMARY,
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

        if (opts.agent) {
          const url = planUrl(plan.id);
          const dateRange = formatDateRange(plan.startDate, plan.endDate);
          const travellers = plan.travellers ?? [];
          const items = plan.items ?? [];
          const lines: string[] = [];

          lines.push(`## ${plan.title}`);
          if (dateRange) lines.push(`**${dateRange}**`);
          lines.push("");

          if (travellers.length > 0) {
            const names = travellers.map((t) => `${t.firstName} ${t.lastName}`).join(", ");
            lines.push(`👤 ${names}`);
            lines.push("");
          }

          for (const item of items) {
            const icon = typeIcon(item.type, item.title);
            const sel = item.selection?.selectedOption;
            if (sel) {
              const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
              const status = sel.status && sel.status !== "NONE" ? ` [${sel.status}]` : "";
              lines.push(`- ${icon} ${sel.name}${price}${status}`);
            } else if (item.selection) {
              lines.push(`- ${icon} ${item.title} ⏳ pending`);
            } else {
              lines.push(`- ${icon} ${item.title}`);
            }
          }

          if (items.length === 0) lines.push("_No items yet._");
          lines.push("");
          lines.push(`👉 **View & edit:** ${url}`);

          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        const dateRange = formatDateRange(plan.startDate, plan.endDate);
        const dates = dateRange ? `  ${chalk.dim(dateRange)}` : "";
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
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to get plan summary: ${message}`);
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

        await graphql<{ updateTripPlan: { id: string } }>(
          UPDATE_TRIP_PLAN,
          { id, input }
        );

        // Re-fetch to get the updated fields (mutation return is incomplete)
        const refetch = await graphql<{ tripPlan: TripPlan }>(
          GET_TRIP_PLAN_WITH_DESC,
          { id }
        );
        const plan = refetch.tripPlan;

        if (opts.json) {
          jsonOutput({ ...plan, url: planUrl(plan.id) });
          return;
        }

        console.log(chalk.green(`✓ Updated trip plan: ${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        if (plan.startDate || plan.endDate) {
          const dateRange = formatDateRange(plan.startDate, plan.endDate);
          if (dateRange) console.log(chalk.dim(`  Dates: ${dateRange}`));
        }
        if (plan.description) console.log(chalk.dim(`  ${plan.description}`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to update plan: ${message}`);
      }
    });

  plans
    .command("delete <id>")
    .description("Delete a trip plan")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await graphql<{ deleteTripPlan: boolean }>(
          DELETE_TRIP_PLAN,
          { id }
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify({ success: true, id }) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Deleted trip plan ${id}`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to delete plan: ${message}`);
      }
    });
}
