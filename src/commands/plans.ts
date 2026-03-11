import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";

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

interface TripPlanUser {
  id: string;
  user: { id: string; name?: string; email?: string };
}

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
  declaredTravellerType?: string;
}

interface PaginatedTripPlans {
  tripPlans: {
    items: TripPlan[];
    total: number;
    page: number;
    limit: number;
  };
}

interface TripPlanDetail {
  tripPlan: TripPlan & {
    items: TripPlanItem[];
    users: TripPlanUser[];
    travellers: Traveller[];
  };
}

function planUrl(id: string): string {
  return `https://voyagier.com/plans/${id}`;
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
    .action(async (opts) => {
      try {
        const input: Record<string, unknown> = { title: opts.title };
        if (opts.start) input.startDate = opts.start;
        if (opts.end) input.endDate = opts.end;
        if (opts.description) input.description = opts.description;

        const data = await graphql<{ createTripPlan: TripPlan }>(
          `mutation CreateTripPlan($input: CreateTripPlanInput!) {
            createTripPlan(input: $input) { id title startDate endDate description }
          }`,
          { input }
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
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const data = await graphql<PaginatedTripPlans>(
          `query TripPlans {
            tripPlans(page: 1, limit: 20) {
              items {
                id
                title
                startDate
                endDate
                itemCount
              }
              total
              page
              limit
            }
          }`
        );

        const { items, total } = data.tripPlans;

        if (opts.json) {
          process.stdout.write(JSON.stringify(items.map((p) => ({ ...p, url: planUrl(p.id) })), null, 2) + "\n");
          return;
        }

        if (items.length === 0) {
          console.log(chalk.dim("No trip plans found."));
          return;
        }

        console.log(chalk.bold(`\n${total} trip plan${total > 1 ? "s" : ""}${total > 20 ? ` (showing first 20)` : ""}:\n`));
        for (const plan of items) {
          const dates = plan.startDate ? `${plan.startDate}${plan.endDate ? ` → ${plan.endDate}` : ""}` : "";
          const items_count = plan.itemCount ? `${plan.itemCount} items` : "empty";
          console.log(`  📋  ${chalk.white(plan.title)}  ${chalk.dim(dates)}`);
          console.log(chalk.dim(`      ${plan.id}  ·  ${items_count}`));
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
              id
              title
              description
              startDate
              endDate
              items {
                id
                type
                title
                date
                startTime
                endTime
                day
              }
              users {
                id
                user { id name email }
              }
              travellers {
                id
                firstName
                lastName
                declaredTravellerType
              }
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
            const icon = typeIcon(item.type);
            const time = item.startTime ? ` at ${item.startTime}` : "";
            const day = item.day ? ` Day ${item.day}` : "";
            console.log(`    ${icon}  ${item.title}${day}${time}`);
          }
        }

        if (plan.users?.length) {
          console.log(chalk.bold(`\n  Collaborators:`));
          for (const u of plan.users) {
            console.log(`    👥  ${u.user.name ?? u.user.email ?? u.user.id}`);
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
    .command("delete <id>")
    .description("Delete a trip plan")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await graphql<{ deleteTripPlan: boolean }>(
          `mutation DeleteTripPlan($id: String!) {
            deleteTripPlan(id: $id)
          }`,
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
}

function typeIcon(type: string): string {
  switch (type?.toLowerCase()) {
    case "flight":
    case "selection":
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
