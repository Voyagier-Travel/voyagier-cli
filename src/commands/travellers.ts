import { printPlanFooter } from "../plan-footer.js";
import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { graphql } from "../api.js";
import { getApiUrl, getUserContext } from "../config.js";
import { validateDate, deriveBaseUrl, shellArg, maskLoyaltyValue } from "../utils.js";
import { clientPlanUrl, planUrls } from "../plan-urls.js";
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

/** Commander collector for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Passport metadata is only sent inside the passport object, which is only
 * built when --passport-number is present — without this guard the metadata
 * flags would be silently dropped (accidental no-op).
 */
function requirePassportNumberWithMetadata(opts: Record<string, unknown>): void {
  if (opts.passportNumber) return;
  const provided = [
    opts.passportCountry && "--passport-country",
    opts.passportNationality && "--passport-nationality",
    opts.passportExpiry && "--passport-expiry",
  ].filter(Boolean);
  if (provided.length > 0) {
    throw new CliError(
      CliErrorCode.VALIDATION,
      `${provided.join(", ")} require${provided.length === 1 ? "s" : ""} --passport-number — passport metadata is ignored without it`,
    );
  }
}

/**
 * Parse a repeatable loyalty flag value ("CODE:NUMBER").
 *
 * kind "air": frequent-flyer — the member number is sent to the airline
 * verbatim, so whatever shape the airline issued is correct here.
 * kind "hotel": the member number must be DIGITS ONLY and must NOT include
 * the chain code — checkout builds booking-api's loyaltyId as
 * chainCode + memberNumber (/^[A-Z]{2}\d+$/), so a prefixed number would
 * produce "HIHI…" and the program would silently never apply.
 */
function parseLoyalty(raw: string, kind: "air" | "hotel"): { code: string; membershipNumber: string } {
  const label = kind === "air" ? "--frequent-flyer" : "--hotel-loyalty";
  const example = kind === "air" ? "DL:1234567" : "HI:12345678";
  const sep = raw.indexOf(":");
  if (sep === -1) {
    throw new CliError(CliErrorCode.VALIDATION, `${label} expects CODE:NUMBER (e.g. ${example}), got: "${maskLoyaltyValue(raw)}"`);
  }
  const code = raw.slice(0, sep).trim().toUpperCase();
  const membershipNumber = raw.slice(sep + 1).trim();
  const codePattern = kind === "air" ? /^[A-Z0-9]{2}$/ : /^[A-Z]{2}$/;
  if (!codePattern.test(code)) {
    const kindWord = kind === "air" ? "airline code" : "chain code";
    throw new CliError(CliErrorCode.VALIDATION, `${label}: ${kindWord} must be exactly 2 ${kind === "air" ? "characters" : "letters"} (e.g. ${example.split(":")[0]}), got: "${code}"`);
  }
  if (membershipNumber.length === 0) {
    throw new CliError(CliErrorCode.VALIDATION, `${label}: missing member number after "${code}:"`);
  }
  if (kind === "hotel" && !/^\d+$/.test(membershipNumber)) {
    const hint = membershipNumber.toUpperCase().startsWith(code)
      ? ` — do not include the chain code, checkout prefixes "${code}" automatically`
      : "";
    throw new CliError(CliErrorCode.VALIDATION, `${label}: member number must be digits only${hint}, got: "${maskLoyaltyValue(membershipNumber)}"`);
  }
  return { code, membershipNumber };
}

function toAirLoyaltyInput(values: string[]): Array<{ airlineCode: string; membershipNumber: string }> {
  return values.map((v) => {
    const p = parseLoyalty(v, "air");
    return { airlineCode: p.code, membershipNumber: p.membershipNumber };
  });
}

function toHotelLoyaltyInput(values: string[]): Array<{ chainCode: string; membershipNumber: string }> {
  return values.map((v) => {
    const p = parseLoyalty(v, "hotel");
    return { chainCode: p.code, membershipNumber: p.membershipNumber };
  });
}

/** Masked one-line render of a traveller's loyalty programs (server only ever returns code + last4). */
function loyaltySummary(t: Traveller): string | undefined {
  const bits: string[] = [];
  for (const p of t.frequentFlyerPrograms ?? []) bits.push(`✈ ${p.airlineCode}${p.last4 ? ` ••••${p.last4}` : ""}`);
  for (const p of t.hotelLoyaltyPrograms ?? []) bits.push(`🏨 ${p.chainCode}${p.last4 ? ` ••••${p.last4}` : ""}`);
  return bits.length > 0 ? bits.join("  ·  ") : undefined;
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
  frequentFlyerPrograms?: Array<{ airlineCode: string; last4?: string | null }> | null;
  hotelLoyaltyPrograms?: Array<{ chainCode: string; last4?: string | null }> | null;
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
    .option("--frequent-flyer <program>", "Frequent-flyer program AIRLINE:NUMBER (repeatable, e.g. DL:1234567)", collect, [])
    .option("--hotel-loyalty <program>", "Hotel loyalty program CHAIN:NUMBER — member number digits only, no chain prefix (repeatable, e.g. HI:12345678)", collect, [])
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
        let selfHotelLoyalty: Array<{ chainCode: string; membershipNumber: string }> | undefined;
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
            // Hotel loyalty: apply the local profile default only when the user
            // gave no explicit --hotel-loyalty flag (explicit flags always win).
            // Frequent-flyer programs are intentionally NOT auto-applied — the
            // server backfills them for linked users at booking time, so sending
            // them here could duplicate entries.
            if (ctx.hotelLoyaltyPrograms?.length && (opts.hotelLoyalty as string[]).length === 0) {
              selfHotelLoyalty = ctx.hotelLoyaltyPrograms.map((p) => ({
                chainCode: p.chainCode,
                membershipNumber: p.membershipNumber,
              }));
              filled.push(`hotel loyalty (${selfHotelLoyalty.map((p) => p.chainCode).join(", ")})`);
            }
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
        requirePassportNumberWithMetadata(opts);
        if (opts.passportNumber) {
          const passportInput: Record<string, string> = {
            passportNumber: opts.passportNumber,
            issueCountry: (opts.passportCountry ?? "US").toUpperCase(),
            nationalityCountry: (opts.passportNationality ?? opts.passportCountry ?? "US").toUpperCase(),
          };
          if (opts.passportExpiry) passportInput.expirationDate = opts.passportExpiry;
          input.passport = passportInput;
        }

        // Loyalty programs (validated client-side; encrypted server-side, only
        // code + last4 ever come back)
        if ((opts.frequentFlyer as string[]).length > 0) input.frequentFlyerPrograms = toAirLoyaltyInput(opts.frequentFlyer);
        if ((opts.hotelLoyalty as string[]).length > 0) input.hotelLoyaltyPrograms = toHotelLoyaltyInput(opts.hotelLoyalty);
        else if (selfHotelLoyalty) input.hotelLoyaltyPrograms = selfHotelLoyalty;

        const data = await graphql<{ createTripPlanTraveller: Traveller }>(
          CREATE_TRAVELLER,
          { tripPlanId: opts.plan, input }
        );

        const t = data.createTripPlanTraveller;
        const baseUrl = deriveBaseUrl(getApiUrl());
        const planUrl = clientPlanUrl(opts.plan, baseUrl);

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...t, ...planUrls(opts.plan, baseUrl) }, null, 2) + "\n");
          return;
        }

        console.log(chalk.green(`✓ Added traveller: ${t.firstName} ${t.lastName}`));
        console.log(chalk.dim(`  ID: ${t.id}`));
        console.log(chalk.dim(`  Type: ${t.declaredTravellerType ?? "ADULT"}`));
        if (t.email) console.log(chalk.dim(`  Email: ${t.email}`));
        if (t.dateOfBirth) console.log(chalk.dim(`  DOB: ${t.dateOfBirth}`));
        if (t.gender) console.log(chalk.dim(`  Gender: ${t.gender}`));
        const loyalty = loyaltySummary(t);
        if (loyalty) console.log(chalk.dim(`  Loyalty: ${loyalty}`));
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
        const planUrl = clientPlanUrl(opts.plan, baseUrl);

        if (opts.json) {
          process.stdout.write(JSON.stringify({ travellers: list, ...planUrls(opts.plan, baseUrl) }, null, 2) + "\n");
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
          const loyalty = loyaltySummary(t);
          if (loyalty) console.log(chalk.dim(`      Loyalty: ${loyalty}`));

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
    .option("--frequent-flyer <program>", "Replace frequent-flyer programs with AIRLINE:NUMBER (repeatable, e.g. DL:1234567)", collect, [])
    .option("--hotel-loyalty <program>", "Replace hotel loyalty programs with CHAIN:NUMBER — member number digits only, no chain prefix (repeatable, e.g. HI:12345678)", collect, [])
    .option("--clear-frequent-flyer", "Remove all frequent-flyer programs")
    .option("--clear-hotel-loyalty", "Remove all hotel loyalty programs")
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

        requirePassportNumberWithMetadata(opts);
        if (opts.passportNumber) {
          const passportInput: Record<string, string> = {
            passportNumber: opts.passportNumber,
            issueCountry: (opts.passportCountry ?? "US").toUpperCase(),
            nationalityCountry: (opts.passportNationality ?? opts.passportCountry ?? "US").toUpperCase(),
          };
          if (opts.passportExpiry) passportInput.expirationDate = opts.passportExpiry;
          input.passport = passportInput;
        }

        // Loyalty programs — server contract: explicit array replaces, [] clears,
        // absent leaves untouched. --clear-* sends the explicit [].
        if ((opts.frequentFlyer as string[]).length > 0 && opts.clearFrequentFlyer) {
          throw new CliError(CliErrorCode.VALIDATION, "--frequent-flyer and --clear-frequent-flyer are mutually exclusive");
        }
        if ((opts.hotelLoyalty as string[]).length > 0 && opts.clearHotelLoyalty) {
          throw new CliError(CliErrorCode.VALIDATION, "--hotel-loyalty and --clear-hotel-loyalty are mutually exclusive");
        }
        if (opts.clearFrequentFlyer) input.frequentFlyerPrograms = [];
        else if ((opts.frequentFlyer as string[]).length > 0) input.frequentFlyerPrograms = toAirLoyaltyInput(opts.frequentFlyer);
        if (opts.clearHotelLoyalty) input.hotelLoyaltyPrograms = [];
        else if ((opts.hotelLoyalty as string[]).length > 0) input.hotelLoyaltyPrograms = toHotelLoyaltyInput(opts.hotelLoyalty);

        if (Object.keys(input).length === 0) {
          fatal("Nothing to update. Provide at least one of: --first, --last, --email, --dob, --gender, --type, --phone, --passport-number, --passport-country, --passport-nationality, --passport-expiry, --frequent-flyer, --hotel-loyalty, --clear-frequent-flyer, --clear-hotel-loyalty");
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
        const loyalty = loyaltySummary(t);
        if (loyalty) console.log(chalk.dim(`  Loyalty: ${loyalty}`));
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to update traveller: ${message}`);
      }
    });
}
