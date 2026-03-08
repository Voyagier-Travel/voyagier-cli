import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";

const LIST_PLANS = `
  query TripPlans($page: Int, $limit: Int) {
    tripPlans(page: $page, limit: $limit) {
      items {
        id
        title
        startDate
        endDate
        updatedAt
        items {
          id
          type
        }
      }
      count
      page
    }
  }
`;

const GET_PLAN = `
  query TripPlan($id: String!) {
    tripPlan(id: $id) {
      id
      title
      description
      startDate
      endDate
      createdAt
      updatedAt
      items {
        id
        type
        title
        subtitle
        date
        startTime
        endTime
        day
      }
      travellers {
        id
        firstName
        lastName
        type
      }
      collaborators {
        id
        role
      }
    }
  }
`;

interface TripPlan {
  id: string;
  title: string;
  startDate?: string;
  endDate?: string;
  updatedAt: string;
  items: Array<{ id: string; type: string }>;
}

interface TripPlanDetail {
  id: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
  items: Array<{
    id: string;
    type: string;
    title: string;
    subtitle?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    day?: number;
  }>;
  travellers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    type: string;
  }>;
  collaborators: Array<{
    id: string;
    role: string;
  }>;
}

export function registerPlanCommands(program: Command): void {
  const plans = program.command("plans").description("Manage trip plans");

  plans
    .command("list")
    .description("List your trip plans")
    .action(async () => {
      try {
        const data = await graphql<{
          tripPlans: { items: TripPlan[]; count: number };
        }>(LIST_PLANS, { page: 1, limit: 20 });

        const plans = data.tripPlans.items;
        if (plans.length === 0) {
          console.log(chalk.dim("No trip plans found."));
          return;
        }

        console.log(chalk.bold(`Trip Plans (${data.tripPlans.count} total):\n`));
        for (const p of plans) {
          const dates = p.startDate
            ? `${new Date(p.startDate).toLocaleDateString()} → ${p.endDate ? new Date(p.endDate).toLocaleDateString() : "?"}`
            : "No dates";
          const itemCount = p.items.length;

          console.log(
            `  ${chalk.cyan(p.id.slice(0, 8))}  ${chalk.bold(p.title || "(untitled)")}  ${chalk.dim(dates)}  ${chalk.dim(`${itemCount} items`)}`
          );
        }
        console.log(chalk.dim(`\nView details: voyagier plans get <id>`));
      } catch (err) {
        console.error(chalk.red(`Failed to list plans: ${err}`));
      }
    });

  plans
    .command("get <id>")
    .description("Show trip plan details")
    .action(async (id: string) => {
      try {
        const data = await graphql<{ tripPlan: TripPlanDetail }>(GET_PLAN, { id });
        const plan = data.tripPlan;

        console.log(chalk.bold.blue(`\n${plan.title || "(untitled)"}`));
        console.log(chalk.dim(`ID: ${plan.id}`));

        if (plan.description) {
          console.log(chalk.dim(plan.description));
        }

        if (plan.startDate) {
          console.log(
            `Dates: ${new Date(plan.startDate).toLocaleDateString()} → ${plan.endDate ? new Date(plan.endDate).toLocaleDateString() : "TBD"}`
          );
        }

        if (plan.travellers.length > 0) {
          console.log(chalk.bold("\nTravellers:"));
          for (const t of plan.travellers) {
            console.log(`  • ${t.firstName} ${t.lastName} (${t.type})`);
          }
        }

        if (plan.items.length > 0) {
          console.log(chalk.bold("\nItems:"));
          for (const item of plan.items) {
            const time = item.startTime
              ? ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ""}`
              : "";
            const day = item.day ? `Day ${item.day}` : "";
            console.log(
              `  ${typeIcon(item.type)} ${item.title || "(untitled)"}${chalk.dim(time)}  ${chalk.dim(day)}`
            );
            if (item.subtitle) {
              console.log(`    ${chalk.dim(item.subtitle)}`);
            }
          }
        }

        console.log(
          chalk.dim(`\nChat about this plan: voyagier chat --plan ${plan.id}`)
        );
      } catch (err) {
        console.error(chalk.red(`Failed to get plan: ${err}`));
      }
    });
}

function typeIcon(type: string): string {
  switch (type?.toLowerCase()) {
    case "flight":
      return "✈️";
    case "hotel":
    case "lodging":
      return "🏨";
    case "activity":
    case "tour":
      return "🎯";
    case "transport":
    case "transfer":
      return "🚗";
    case "restaurant":
      return "🍽️";
    default:
      return "📌";
  }
}
