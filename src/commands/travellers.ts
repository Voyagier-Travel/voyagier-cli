import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { getApiUrl } from "../config.js";
import { validateDate, deriveBaseUrl } from "../utils.js";

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  declaredTravellerType?: string;
}

export function registerTravellerCommands(program: Command): void {
  const travellers = program.command("travellers").description("Manage trip plan travellers");

  travellers
    .command("add")
    .description("Add a traveller to a trip plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .requiredOption("--first <name>", "First name")
    .requiredOption("--last <name>", "Last name")
    .option("--type <type>", "Traveller type: ADULT, CHILD, INFANT", "ADULT")
    .option("--email <email>", "Email address")
    .option("--dob <date>", "Date of birth (YYYY-MM-DD)")
    .option("--gender <gender>", "Gender: MALE, FEMALE, UNSPECIFIED")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const input: Record<string, unknown> = {
          firstName: opts.first,
          lastName: opts.last,
          declaredTravellerType: opts.type.charAt(0).toUpperCase() + opts.type.slice(1).toLowerCase(),
        };
        if (opts.email) input.email = opts.email;
        if (opts.dob) {
          validateDate(opts.dob, "--dob");
          input.dateOfBirth = opts.dob;
        }
        if (opts.gender) input.gender = opts.gender.toUpperCase();

        const data = await graphql<{ createTripPlanTraveller: Traveller }>(
          `mutation CreateTraveller($tripPlanId: String!, $input: CreateTravellerInput!) {
            createTripPlanTraveller(tripPlanId: $tripPlanId, input: $input) {
              id firstName lastName email dateOfBirth gender declaredTravellerType
            }
          }`,
          { tripPlanId: opts.plan, input }
        );

        const t = data.createTripPlanTraveller;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const planUrl = `${baseUrl}/plans/${opts.plan}`;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...t, tripPlanUrl: planUrl }, null, 2) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Added traveller: ${t.firstName} ${t.lastName}`));
        console.log(chalk.dim(`  ID: ${t.id}`));
        console.log(chalk.dim(`  Type: ${t.declaredTravellerType ?? "ADULT"}`));
        if (t.email) console.log(chalk.dim(`  Email: ${t.email}`));
        console.log(chalk.dim(`  Plan: ${planUrl}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to add traveller: ${message}\n`));
        process.exit(1);
      }
    });

  travellers
    .command("list")
    .description("List travellers on a trip plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        const data = await graphql<{ tripPlanTravellers: Traveller[] }>(
          `query Travellers($tripPlanId: String!) {
            tripPlanTravellers(tripPlanId: $tripPlanId) {
              id firstName lastName email dateOfBirth declaredTravellerType
            }
          }`,
          { tripPlanId: opts.plan }
        );

        const list = data.tripPlanTravellers;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const planUrl = `${baseUrl}/plans/${opts.plan}`;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ travellers: list, tripPlanUrl: planUrl }, null, 2) + "\n");
          return;
        }

        if (list.length === 0) {
          console.log(chalk.dim("No travellers on this plan."));
          console.log(chalk.dim(`Add one: voyagier travellers add --plan ${opts.plan} --first <name> --last <name> --type ADULT`));
          console.log(chalk.dim(`Plan: ${planUrl}`));
          return;
        }

        console.log(chalk.bold(`\n${list.length} traveller${list.length > 1 ? "s" : ""}:\n`));
        for (const t of list) {
          const type = t.declaredTravellerType ?? "ADULT";
          console.log(`  👤  ${t.firstName} ${t.lastName}  ·  ${type}`);
          console.log(chalk.dim(`      ID: ${t.id}${t.email ? `  ·  ${t.email}` : ""}`));
        }
        console.log(chalk.dim(`\n  Plan: ${planUrl}\n`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to list travellers: ${message}\n`));
        process.exit(1);
      }
    });

  travellers
    .command("remove <id>")
    .description("Remove a traveller")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await graphql<{ deleteTripPlanTraveller: boolean }>(
          `mutation DeleteTraveller($id: String!) {
            deleteTripPlanTraveller(id: $id)
          }`,
          { id }
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify({ success: true, id }) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Removed traveller ${id}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to remove traveller: ${message}\n`));
        process.exit(1);
      }
    });
}
