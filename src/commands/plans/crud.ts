import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../../api.js";
import { getApiUrl } from "../../config.js";
import { printPlanFooter, getPlanSummary } from "../../plan-footer.js";
import { validateDate, warnPastDate, formatPrice, formatDateRange, shellArg, deriveBaseUrl } from "../../utils.js";
import { resolvePlanArg } from "../../resolve-plan-arg.js";
import { fatal, jsonOutput } from "../../output.js";
import { CliError, CliErrorCode } from "../../errors.js";
import { scaffoldPlan, generateTripTitle } from "../scaffold.js";
import { isInteractive, promptText } from "../../prompt.js";
import { planUrl, typeIcon, chosenOption, TripPlan, TripPlanDetail, PaginatedTripPlans } from "./types.js";
import { planUrls, clientPlanUrl } from "../../plan-urls.js";
import {
  GET_TRIP_PLANS,
  GET_SHARED_TRIP_PLANS,
  GET_TRIP_PLAN,
  GET_TRIP_PLAN_SUMMARY,
  UPDATE_TRIP_PLAN,
  GET_TRIP_PLAN_WITH_DESC,
  DELETE_TRIP_PLAN,
} from "../../queries.js";

/** A plan in the unified `plans list` view, tagged by how the caller relates to it. */
type PlanRelationship = "owner" | "shared";
type ListedPlan = TripPlan & { relationship: PlanRelationship };

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
          jsonOutput({ ok: true, ...plan, ...planUrls(plan.id), planSummary });
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
    .description("List plans you own AND plans shared with you (each tagged owner/shared)")
    .option("--page <n>", "Page number", "1")
    .option("--limit <n>", "Results per page", "20")
    .option("--active", "Show only future/ongoing plans (endDate >= today or no dates set)")
    .option("--relationship <owner|shared>", "Filter to plans you own or plans shared with you")
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
        if (opts.relationship && opts.relationship !== "owner" && opts.relationship !== "shared") {
          fatal('--relationship must be "owner" or "shared".');
        }

        // Fetch page 1 of BOTH the owned (tripPlans) and shared (sharedTripPlans)
        // queries — up to 100 of each, the same precedent the old --active path
        // used — then merge, tag, filter, sort, and paginate client-side. tripPlans
        // returns only OWNED plans; collaborator-shared plans surface only via
        // sharedTripPlans, so a single unified list needs both. Accounts holding
        // >100 of either kind are truncated to the most recent 100 — surfaced via
        // `truncated: true` in JSON and a notice in the text outputs.
        const [ownData, sharedData] = await Promise.all([
          graphql<PaginatedTripPlans>(GET_TRIP_PLANS, { page: 1, limit: 100 }),
          graphql<{ sharedTripPlans: { count: number; items: TripPlan[] } }>(
            GET_SHARED_TRIP_PLANS,
            { limit: 100, page: 1 }
          ),
        ]);
        // Truncation is tracked per side so a --relationship filter only reports
        // truncation of the side actually shown.
        const ownTruncated = ownData.tripPlans.count > ownData.tripPlans.items.length;
        const sharedTruncated = sharedData.sharedTripPlans.count > sharedData.sharedTripPlans.items.length;
        const truncated =
          opts.relationship === "owner" ? ownTruncated :
          opts.relationship === "shared" ? sharedTruncated :
          ownTruncated || sharedTruncated;

        let merged: ListedPlan[] = [
          ...ownData.tripPlans.items.map((p) => ({ ...p, relationship: "owner" as const })),
          ...sharedData.sharedTripPlans.items.map((p) => ({ ...p, relationship: "shared" as const })),
        ];

        if (opts.relationship) {
          merged = merged.filter((p) => p.relationship === opts.relationship);
        }

        if (opts.active) {
          const today = new Date().toISOString().slice(0, 10);
          merged = merged.filter((p) => !p.endDate || p.endDate >= today);
        }

        // Sort startDate DESC, undated plans last (the existing --active ordering,
        // now applied to the whole merged list).
        merged.sort((a, b) => {
          if (!a.startDate && !b.startDate) return 0;
          if (!a.startDate) return 1;
          if (!b.startDate) return -1;
          return b.startDate.localeCompare(a.startDate);
        });

        const total = merged.length;
        const pageItems = merged.slice((page - 1) * limit, (page - 1) * limit + limit);
        const baseUrl = deriveBaseUrl(getApiUrl());
        // Re-issuable flags for the next-page hint, so following it keeps the
        // same result set and page geometry.
        const hintFlags =
          (opts.active ? " --active" : "") +
          (opts.relationship ? ` --relationship ${opts.relationship}` : "") +
          (opts.limit !== "20" ? ` --limit ${limit}` : "");

        if (opts.json) {
          process.stdout.write(JSON.stringify({
            items: pageItems.map((p) =>
              p.relationship === "shared"
                ? { ...p, url: clientPlanUrl(p.id, baseUrl) }
                : { ...p, ...planUrls(p.id, baseUrl) }
            ),
            total,
            page,
            limit,
            ...(opts.active ? { filtered: true } : {}),
            ...(truncated ? { truncated: true } : {}),
          }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const lines: string[] = [];
          lines.push(opts.active ? "## Your Active Trip Plans" : "## Your Trip Plans");
          lines.push("");
          if (pageItems.length === 0) {
            lines.push("_No trip plans found._");
          } else {
            pageItems.forEach((p, i) => {
              const dates = formatDateRange(p.startDate, p.endDate);
              const suffix = p.relationship === "shared" ? "  _(shared with you)_" : "";
              const url = p.relationship === "shared" ? clientPlanUrl(p.id, baseUrl) : planUrl(p.id);
              lines.push(`${i + 1}. **${p.title}**${dates ? `  —  ${dates}` : ""}${suffix}`);
              lines.push(`   👉 ${url}`);
            });
            if (total > page * limit) {
              lines.push("");
              lines.push(`_Page ${page} of ${Math.ceil(total / limit)}. Next: \`voyagier plans list --agent${hintFlags} --page ${page + 1}\`_`);
            }
            if (truncated) {
              lines.push("");
              lines.push("_Note: this account holds more than 100 owned or 100 shared plans; the list covers the most recent 100 of each._");
            }
          }
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (pageItems.length === 0) {
          console.log(chalk.dim(opts.active ? "No active trip plans found." : "No trip plans found."));
          return;
        }

        const pageInfo = total > limit ? ` (page ${page}, showing ${pageItems.length} of ${total})` : "";
        const label = opts.active ? " active" : "";
        console.log(chalk.bold(`\n${total}${label} trip plan${total !== 1 ? "s" : ""}${pageInfo}:\n`));
        for (const plan of pageItems) {
          const dates = formatDateRange(plan.startDate, plan.endDate);
          const icon = plan.relationship === "shared" ? "🤝" : "📋";
          const url = plan.relationship === "shared" ? clientPlanUrl(plan.id, baseUrl) : planUrl(plan.id);
          console.log(`  ${icon}  ${chalk.white(plan.title)}  ${chalk.dim(dates)}`);
          console.log(chalk.dim(`      ${url}`));
        }

        if (total > page * limit) {
          console.log(chalk.dim(`\n  Next page: voyagier plans list${hintFlags} --page ${page + 1}`));
        }
        if (truncated) {
          console.log(chalk.dim("\n  Note: more than 100 owned or 100 shared plans exist; showing the most recent 100 of each."));
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
              const icon = typeIcon(item.selectionType, item.title);
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
            const icon = typeIcon(item.selectionType, item.title);
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
              selectionType: item.selectionType,
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
            const icon = typeIcon(item.selectionType, item.title);
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
            const icon = typeIcon(item.selectionType, item.title);
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
          jsonOutput({ ok: true, ...plan, url: planUrl(plan.id) });
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
          process.stdout.write(JSON.stringify({ ok: true, success: true, id }) + "\n");
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
