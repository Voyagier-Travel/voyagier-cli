import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { printPlanFooter, getPlanSummary } from "../../plan-footer.js";
import { validateDate, warnPastDate, formatPrice, formatDateRange, shellArg } from "../../utils.js";
import { resolvePlanArg } from "../../resolve-plan-arg.js";
import { fatal, jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { scaffoldPlan, generateTripTitle } from "../scaffold.js";
import { isInteractive, promptText } from "../../prompt.js";
import { planUrl, typeIcon, chosenOption, TripPlan, TripPlanDetail, PaginatedTripPlans } from "./types.js";
import { planUrls } from "../../plan-urls.js";
import {
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
    .description("Create a new trip plan (alias of `plan-trip` — the full trip starter)")
    .option("--title <title>", "Trip plan title; prompted when omitted at a TTY")
    .option("--client <ref>", "Client id, email, or name. Omit to auto-resolve when exactly one ACTIVE client exists.")
    .option("--json", "Output raw JSON")
    .option("--dry-run", "Show the GraphQL query without executing")
    .option("--no-input", "Never prompt for missing input; fail instead (for scripts, agents, CI)")
    .action(async (opts, command) => {
      // Title was a commander requiredOption; now optional so a human at a TTY
      // can be prompted (VOY-1762). Non-interactively, synthesize commander's
      // missing-required-option failure via `command.error(...)`: `error:
      // required option '--title <title>' not specified`. WITHOUT --json that
      // renders as commander's text on stderr with an empty stdout; WITH --json
      // in argv the build-program hook routes it to the uniform { error: true,
      // code: "VALIDATION", message } envelope on stdout (VOY-1829, superseding
      // the VOY-1762 byte-identity note for the --json path only). Exit 1 either
      // way. Resolved BEFORE the try below so the thrown CommanderError (under
      // exitOverride, in tests) is not caught and re-wrapped as an API_ERROR.
      if (!opts.title) {
        if (isInteractive(opts)) {
          opts.title = await promptText("Trip title: ", { default: generateTripTitle({}) });
        }
        if (!opts.title) {
          command.error("error: required option '--title <title>' not specified", {
            exitCode: 1,
            code: "commander.missingMandatoryOptionValue",
          });
        }
      }
      try {
        // `plans create` is a thin alias over the shared scaffold helper — the
        // same create path `plan-trip` (the canonical creation verb) uses. It
        // keeps its minimal surface (no travellers, no shape flags): create
        // accepts only { clientId, title }; dates/description are set via
        // `plans update`. The server attaches the default goal graph either
        // way, so delegating does not change what gets created.
        const { plan } = await scaffoldPlan({
          client: opts.client,
          title: opts.title,
          dryRun: opts.dryRun,
          interactive: isInteractive(opts),
          clientHintFlags: opts.title ? `--title ${shellArg(opts.title)}` : undefined,
          // Pre-VOY-1763 contract: `plans create` always wrote the
          // auto-resolved-client note to stderr (even under --json) but never
          // emitted progress lines. progress:false preserves exactly that.
          progress: false,
        });

        if (opts.json) {
          const planSummary = await getPlanSummary(plan.id);
          jsonOutput({ ...plan, ...planUrls(plan.id), planSummary });
          return;
        }

        console.log(chalk.green(`✓ Created trip plan: ${plan.title}`));
        console.log(chalk.dim(`  ID:  ${plan.id}`));
        console.log(chalk.dim(`  URL: ${planUrl(plan.id)}`));
        if (plan.startDate || plan.endDate) {
          const dateRange = formatDateRange(plan.startDate, plan.endDate);
          if (dateRange) console.log(chalk.dim(`  Dates: ${dateRange}`));
        }
        console.log(chalk.dim(`\n  Tip: voyagier plan-trip is the full trip starter (travellers, trip shape, first searches).`));
        console.log(chalk.dim(`  Next: voyagier travellers add --plan ${shellArg(plan.id)} --first <name> --last <name> --type ADULT`));
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
            items: items.map((p) => ({ ...p, ...planUrls(p.id) })),
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
    .command("get [id]")
    .description("Show trip plan details")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (idInput: string | undefined, opts) => {
      const id = resolvePlanArg(idInput, opts, "plans get");
      try {
        const data = await graphql<TripPlanDetail>(
          GET_TRIP_PLAN,
          { id }
        );

        const plan = data.tripPlan;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...plan, ...planUrls(plan.id) }, null, 2) + "\n");
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
              const selections = item.selections ?? [];
              if (selections.length === 0) {
                lines.push(`- ${icon} **${item.title}**`);
                continue;
              }
              // Render one line per selection so partially-pending items are not
              // hidden when a sibling selection is already chosen (VOY-1407 review).
              lines.push(`- ${icon} **${item.title}**`);
              for (const s of selections) {
                const sel = chosenOption(s);
                if (sel) {
                  const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
                  const status = sel.status && sel.status !== "NONE" && sel.status !== "None" ? ` [${sel.status}]` : "";
                  lines.push(`  → ${sel.name}${price}${status}`);
                } else {
                  lines.push(`  → ⏳ awaiting selection`);
                }
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
            const selections = item.selections ?? [];
            if (selections.length === 0) {
              console.log(`    ${icon}  ${item.title}`);
              continue;
            }
            // One line per selection so a partially-pending item is not shown as
            // fully resolved when a sibling selection is already chosen (VOY-1407 review).
            console.log(`    ${icon}  ${item.title}`);
            for (const s of selections) {
              const sel = chosenOption(s);
              if (sel) {
                const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
                const status = sel.status && sel.status !== "NONE" && sel.status !== "None" ? ` [${sel.status}]` : "";
                console.log(chalk.green(`        → ${sel.name}${price}${status}`));
              } else {
                console.log(chalk.yellow(`        → awaiting selection`));
              }
            }
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
    .command("summary [id]")
    .description("Compact one-screen summary of a trip plan")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (idInput: string | undefined, opts) => {
      const id = resolvePlanArg(idInput, opts, "plans summary");
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
              selections: (item.selections ?? []).map((s) => {
                const opt = chosenOption(s);
                return {
                  type: s.type ?? null,
                  isLocked: s.isLocked ?? null,
                  selected: opt?.name ?? null,
                  price: opt?.price ?? null,
                  status: opt?.status ?? null,
                };
              }),
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
            const selections = item.selections ?? [];
            const chosen = selections
              .map((s) => chosenOption(s))
              .filter((o): o is NonNullable<typeof o> => o != null);
            if (chosen.length > 0) {
              for (const sel of chosen) {
                const price = sel.price != null ? ` · ${formatPrice(sel.price)}` : "";
                const status = sel.status && sel.status !== "NONE" && sel.status !== "None" ? ` [${sel.status}]` : "";
                lines.push(`- ${icon} ${sel.name}${price}${status}`);
              }
            } else if (selections.length > 0) {
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
            const selections = item.selections ?? [];
            const chosen = selections
              .map((s) => chosenOption(s))
              .filter((o): o is NonNullable<typeof o> => o != null);
            if (chosen.length > 0) {
              for (const sel of chosen) {
                const price = sel.price != null ? chalk.green(` ${formatPrice(sel.price)}`) : "";
                const status = sel.status && sel.status !== "NONE" && sel.status !== "None" ? chalk.dim(` [${sel.status}]`) : "";
                console.log(`  ${icon}  ${sel.name}${price}${status}`);
              }
            } else if (selections.length > 0) {
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
    .command("update [id]")
    .description("Update a trip plan's title, dates, or description")
    .option("--title <title>", "New title")
    .option("--start <date>", "New start date (YYYY-MM-DD)")
    .option("--end <date>", "New end date (YYYY-MM-DD)")
    .option("--description <text>", "New description")
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (idInput: string | undefined, opts) => {
      const id = resolvePlanArg(idInput, opts, "plans update");
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
    .command("delete [id]")
    .description("Delete a trip plan (use --force to confirm)")
    .option("--force", "Required to confirm deletion", false)
    .option("--json", "Output raw JSON")
    .option("--plan <id>", "Trip plan ID (alternative to the positional argument)")
    .action(async (idInput: string | undefined, opts) => {
      const id = resolvePlanArg(idInput, opts, "plans delete");
      try {
        // Same confirmation convention as goal-remove: destructive ops take
        // --force. Deleting a plan drops its goals/selections/cart with it.
        if (!opts.force) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            "plans delete requires --force. Deleting a plan also removes its goals, selections, and cart; pass --force to confirm.",
          );
        }
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
