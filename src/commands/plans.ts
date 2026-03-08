import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";

const LIST_PLANS = `
  query MyTripPlans {
    myTripPlans {
      id
      title
      status
      startDate
      endDate
      updatedAt
      items {
        id
      }
    }
  }
`;

const GET_PLAN = `
  query TripPlan($id: String!) {
    tripPlan(id: $id) {
      id
      title
      status
      startDate
      endDate
      createdAt
      updatedAt
      items {
        id
        type
        title
        status
        startDate
        endDate
        metadata
      }
      travellers {
        id
        firstName
        lastName
        type
      }
    }
  }
`;

interface TripPlan {
  id: string;
  title: string;
  status: string;
  startDate?: string;
  endDate?: string;
  updatedAt: string;
  items: Array<{ id: string }>;
}

interface TripPlanDetail {
  id: string;
  title: string;
  status: string;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
  items: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    startDate?: string;
    endDate?: string;
    metadata?: unknown;
  }>;
  travellers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    type: string;
  }>;
}

export function registerPlanCommands(program: Command): void {
  const plans = program.command("plans").description("Manage trip plans");

  plans
    .command("list")
    .description("List your trip plans")
    .action(async () => {
      try {
        const data = await graphql<{ myTripPlans: TripPlan[] }>(LIST_PLANS);
        const plans = data.myTripPlans;

        if (plans.length === 0) {
          console.log(chalk.dim("No trip plans found."));
          return;
        }

        console.log(chalk.bold("Trip Plans:\n"));
        for (const p of plans) {
          const dates = p.startDate
            ? `${new Date(p.startDate).toLocaleDateString()} → ${p.endDate ? new Date(p.endDate).toLocaleDateString() : "?"}`
            : "No dates";
          const itemCount = p.items.length;

          console.log(
            `  ${chalk.cyan(p.id.slice(0, 8))}  ${chalk.bold(p.title || "(untitled)")}  ${chalk.dim(dates)}  ${chalk.dim(`${itemCount} items`)}  ${statusBadge(p.status)}`
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
        console.log(`Status: ${statusBadge(plan.status)}`);

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
            const dates = item.startDate
              ? ` ${new Date(item.startDate).toLocaleDateString()}`
              : "";
            console.log(
              `  ${typeIcon(item.type)} ${item.title || "(untitled)"}${chalk.dim(dates)}  ${statusBadge(item.status)}`
            );
          }
        }

        console.log(
          chalk.dim(`\nChat about this plan: voyagier chat --session <session-id>`)
        );
      } catch (err) {
        console.error(chalk.red(`Failed to get plan: ${err}`));
      }
    });
}

function statusBadge(status: string): string {
  switch (status?.toLowerCase()) {
    case "draft":
      return chalk.yellow("● Draft");
    case "active":
    case "confirmed":
      return chalk.green("● Active");
    case "completed":
      return chalk.blue("● Completed");
    case "cancelled":
      return chalk.red("● Cancelled");
    default:
      return chalk.dim(`● ${status || "Unknown"}`);
  }
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
