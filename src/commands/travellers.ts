import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { graphql } from "../api.js";
import { getApiUrl, getUserContext } from "../config.js";
import { validateDate, deriveBaseUrl, shellArg } from "../utils.js";
import { jsonOutput, fatal, warn } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import {
  CREATE_TRAVELLER,
  GET_TRAVELLERS,
  DELETE_TRAVELLER,
  UPDATE_TRAVELLER,
} from "../queries.js";

/** Convert an enum value to PascalCase (e.g. "adult" → "Adult", "MALE" → "Male"). */
function toPascalCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

interface Traveller {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  dateOfBirth?: string;
  gender?: string;
  declaredTravellerType?: string;
  passport?: { last4?: string; issueCountry?: string } | null;
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
    .option("--phone <number>", "Contact phone number")
    .option("--passport-number <number>", "Passport number (international flights)")
    .option("--passport-country <code>", "Passport issue country (e.g. US)")
    .option("--passport-nationality <code>", "Passport nationality country (e.g. US)")
    .option("--passport-expiry <date>", "Passport expiration (YYYY-MM)")
    .option("--self", "Auto-fill from your saved profile (voyagier auth setup)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      try {
        let firstName = opts.first as string;
        let lastName = opts.last as string;
        let email = opts.email as string | undefined;
        let dob = opts.dob as string | undefined;
        let gender = opts.gender as string | undefined;
        let phone = opts.phone as string | undefined;

        // --self: auto-fill from saved profile
        if (opts.self) {
          const ctx = getUserContext();
          if (ctx) {
            if (!email && ctx.email) email = ctx.email;
            if (!dob && ctx.dateOfBirth) dob = ctx.dateOfBirth;
            if (!gender && ctx.gender) gender = ctx.gender;
            if (ctx.firstName && firstName === opts.first) {
              // Use profile name if user passed the required --first/--last
              // (they had to pass something — --self enriches it)
            }
            const filled: string[] = [];
            if (ctx.email && !opts.email) filled.push("email");
            if (ctx.dateOfBirth && !opts.dob) filled.push("DOB");
            if (ctx.gender && !opts.gender) filled.push("gender");
            if (!opts.json && filled.length > 0) {
              console.log(chalk.dim(`  Auto-filled from profile: ${filled.join(", ")}`));
            }
          } else {
            warn("No saved profile. Run: voyagier auth setup");
          }
        }

        // Interactive prompts for missing required booking fields
        const isInteractive = process.stdin.isTTY === true && !process.env.CI;

        if (isInteractive && !opts.json) {
          const rl = createInterface({ input: stdin, output: stdout });
          try {
            if (!dob) {
              const dobInput = (await rl.question(chalk.bold("  Date of birth (YYYY-MM-DD): "))).trim();
              if (dobInput) {
                validateDate(dobInput, "date of birth");
                dob = dobInput;
              }
            }
            if (!gender) {
              const genderInput = (await rl.question(chalk.bold("  Gender (M/F/X): "))).trim().toUpperCase();
              if (genderInput) {
                const genderMap: Record<string, string> = { M: "Male", F: "Female", X: "Unspecified", MALE: "Male", FEMALE: "Female", UNSPECIFIED: "Unspecified" };
                gender = genderMap[genderInput] ?? genderInput;
              }
            }
            if (!email) {
              const emailInput = (await rl.question(chalk.bold("  Email (for booking confirmation): "))).trim();
              if (emailInput) email = emailInput;
            }
            if (!phone) {
              const phoneInput = (await rl.question(chalk.bold("  Phone (for airline contact, or Enter to skip): "))).trim();
              if (phoneInput) phone = phoneInput;
            }
          } finally {
            rl.close();
          }
        }

        // Warn in non-interactive mode if booking-critical fields are missing
        if (!isInteractive && !opts.json) {
          const missing: string[] = [];
          if (!dob) missing.push("--dob (date of birth)");
          if (!gender) missing.push("--gender (M/F/X)");
          if (missing.length > 0) {
            warn(`Missing fields required for flight booking: ${missing.join(", ")}`);
            process.stderr.write(chalk.dim("  Flights cannot be booked without these. Add later with: voyagier travellers update <id> --dob YYYY-MM-DD --gender M\n"));
          }
        }

        const input: Record<string, unknown> = {
          firstName,
          lastName,
          declaredTravellerType: toPascalCase(opts.type),
        };
        if (email) input.email = email;
        if (dob) {
          validateDate(dob, "--dob");
          input.dateOfBirth = dob;
        }
        if (gender) {
          const addGenderMap: Record<string, string> = { M: "Male", F: "Female", X: "Unspecified", MALE: "Male", FEMALE: "Female", UNSPECIFIED: "Unspecified" };
          const normalizedGender = gender.toUpperCase();
          input.gender = addGenderMap[normalizedGender] ?? toPascalCase(gender);
        }

        // Phone contact
        if (phone) {
          input.contactNumbers = [{ useType: "H", phone }];
        }

        // Passport fields
        if (opts.passportNumber) {
          const passportInput: Record<string, string> = {
            passportNumber: opts.passportNumber,
            issueCountry: (opts.passportCountry ?? "US").toUpperCase(),
            nationalityCountry: (opts.passportNationality ?? opts.passportCountry ?? "US").toUpperCase(),
          };
          if (opts.passportExpiry) passportInput.expirationDate = opts.passportExpiry;
          input.passport = passportInput;
        }

        const data = await graphql<{ createTripPlanTraveller: Traveller }>(
          CREATE_TRAVELLER,
          { tripPlanId: opts.plan, input }
        );

        const t = data.createTripPlanTraveller;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const planUrl = `${baseUrl}/plans/${opts.plan}`;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...t, url: planUrl }, null, 2) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Added traveller: ${t.firstName} ${t.lastName}`));
        console.log(chalk.dim(`  ID: ${t.id}`));
        console.log(chalk.dim(`  Type: ${t.declaredTravellerType ?? "ADULT"}`));
        if (t.email) console.log(chalk.dim(`  Email: ${t.email}`));
        if (t.dateOfBirth) console.log(chalk.dim(`  DOB: ${t.dateOfBirth}`));
        if (t.gender) console.log(chalk.dim(`  Gender: ${t.gender}`));
        await printPlanFooter(opts.plan as string);
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to add traveller: ${message}`);
      }
    });

  travellers
    .command("list")
    .description("List travellers on a trip plan")
    .requiredOption("--plan <id>", "Trip plan ID")
    .option("--json", "Output raw JSON")
    .option("--agent", "Output plain markdown for AI agents")
    .action(async (opts) => {
      try {
        const data = await graphql<{ tripPlanTravellers: Traveller[] }>(
          GET_TRAVELLERS,
          { tripPlanId: opts.plan }
        );

        const list = data.tripPlanTravellers;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const planUrl = `${baseUrl}/plans/${opts.plan}`;

        if (opts.json) {
          process.stdout.write(JSON.stringify({ travellers: list, url: planUrl }, null, 2) + "\n");
          return;
        }

        if (opts.agent) {
          const lines: string[] = [];
          lines.push(`### Travellers (${list.length})`);
          lines.push("");
          if (list.length === 0) {
            lines.push("_No travellers on this plan._");
          } else {
            list.forEach((t, i) => {
              const type = t.declaredTravellerType ?? "ADULT";
              lines.push(`${i + 1}. ${t.firstName} ${t.lastName} — ${type}`);
            });
          }
          lines.push("");
          lines.push(`👉 **Plan:** ${planUrl}`);
          process.stdout.write(lines.join("\n") + "\n");
          return;
        }

        if (list.length === 0) {
          console.log(chalk.dim("No travellers on this plan."));
          console.log(chalk.dim(`Add one: voyagier travellers add --plan ${shellArg(opts.plan)} --first <name> --last <name> --type ADULT`));
          console.log(chalk.dim(`Plan: ${planUrl}`));
          return;
        }

        console.log(chalk.bold(`\n${list.length} traveller${list.length > 1 ? "s" : ""}:\n`));
        for (const t of list) {
          const type = t.declaredTravellerType ?? "ADULT";
          console.log(`  👤  ${t.firstName} ${t.lastName}  ·  ${type}`);
          const details: string[] = [`ID: ${t.id}`];
          if (t.email) details.push(t.email);
          if (t.dateOfBirth) details.push(`DOB: ${t.dateOfBirth}`);
          if (t.gender) details.push(t.gender);
          console.log(chalk.dim(`      ${details.join("  ·  ")}`));

          // Booking readiness check
          const missing: string[] = [];
          if (!t.dateOfBirth) missing.push("DOB");
          if (!t.gender) missing.push("gender");
          if (missing.length > 0) {
            console.log(chalk.yellow(`      ⚠ Missing for flight booking: ${missing.join(", ")}`));
          }
        }
        console.log(chalk.dim(`\n  Plan: ${planUrl}\n`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to list travellers: ${message}`);
      }
    });

  travellers
    .command("remove <id>")
    .description("Remove a traveller")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        await graphql<{ deleteTripPlanTraveller: boolean }>(
          DELETE_TRAVELLER,
          { id }
        );

        if (opts.json) {
          process.stdout.write(JSON.stringify({ success: true, id }) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Removed traveller ${id}`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to remove traveller: ${message}`);
      }
    });

  travellers
    .command("update <id>")
    .description("Update a traveller's details")
    .option("--first <name>", "First name")
    .option("--last <name>", "Last name")
    .option("--dob <date>", "Date of birth (YYYY-MM-DD)")
    .option("--gender <gender>", "Gender: M, F, X (or MALE, FEMALE, UNSPECIFIED)")
    .option("--email <email>", "Email address")
    .option("--phone <number>", "Contact phone number")
    .option("--type <type>", "Traveller type: adult, child, infant")
    .option("--passport-number <number>", "Passport number")
    .option("--passport-country <code>", "Passport issue country (e.g. US)")
    .option("--passport-nationality <code>", "Passport nationality country")
    .option("--passport-expiry <date>", "Passport expiration (YYYY-MM)")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts) => {
      try {
        const input: Record<string, unknown> = {};
        if (opts.first) input.firstName = opts.first;
        if (opts.last) input.lastName = opts.last;
        if (opts.email) input.email = opts.email;
        if (opts.dob) {
          validateDate(opts.dob, "--dob");
          input.dateOfBirth = opts.dob;
        }
        if (opts.gender) {
          const genderMap: Record<string, string> = { M: "Male", F: "Female", X: "Unspecified" };
          const normalized = opts.gender.toUpperCase();
          input.gender = genderMap[normalized] ?? toPascalCase(opts.gender);
        }
        if (opts.type) input.declaredTravellerType = toPascalCase(opts.type);

        if (opts.phone) {
          input.contactNumbers = [{ useType: "H", phone: opts.phone }];
        }

        if (opts.passportNumber) {
          const passportInput: Record<string, string> = {
            passportNumber: opts.passportNumber,
            issueCountry: (opts.passportCountry ?? "US").toUpperCase(),
            nationalityCountry: (opts.passportNationality ?? opts.passportCountry ?? "US").toUpperCase(),
          };
          if (opts.passportExpiry) passportInput.expirationDate = opts.passportExpiry;
          input.passport = passportInput;
        }

        if (Object.keys(input).length === 0) {
          fatal("Nothing to update. Provide at least one of: --first, --last, --email, --dob, --gender, --type, --phone, --passport-number");
        }

        const data = await graphql<{ updateTripPlanTraveller: Traveller }>(
          UPDATE_TRAVELLER,
          { id, input }
        );

        const t = data.updateTripPlanTraveller;

        if (opts.json) {
          jsonOutput(t);
          return;
        }

        console.log(chalk.green(`✓ Updated traveller: ${t.firstName} ${t.lastName}`));
        console.log(chalk.dim(`  ID: ${t.id}`));
        console.log(chalk.dim(`  Type: ${t.declaredTravellerType ?? "ADULT"}`));
        if (t.email) console.log(chalk.dim(`  Email: ${t.email}`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to update traveller: ${message}`);
      }
    });
}
