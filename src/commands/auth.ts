import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { openBrowser } from "../utils.js";

import { saveCredentials, getToken, getApiUrl, clearCredentials, credentialsExist, saveUserContext, getUserContext } from "../config.js";
import type { UserContext } from "../config.js";
import { graphql } from "../api.js";
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";

// City → common airport suggestions
const CITY_AIRPORTS: Record<string, string[]> = {
  "Baltimore": ["BWI"],
  "Washington": ["DCA", "IAD"],
  "New York": ["JFK", "EWR", "LGA"],
  "Los Angeles": ["LAX"],
  "Chicago": ["ORD", "MDW"],
  "San Francisco": ["SFO", "OAK", "SJC"],
  "Dallas": ["DFW", "DAL"],
  "Houston": ["IAH", "HOU"],
  "Atlanta": ["ATL"],
  "Miami": ["MIA", "FLL"],
  "Boston": ["BOS"],
  "Denver": ["DEN"],
  "Seattle": ["SEA"],
  "Phoenix": ["PHX"],
  "Detroit": ["DTW"],
  "Minneapolis": ["MSP"],
  "Orlando": ["MCO"],
  "Philadelphia": ["PHL"],
  "Charlotte": ["CLT"],
  "Nashville": ["BNA"],
  "Austin": ["AUS"],
  "Portland": ["PDX"],
  "San Diego": ["SAN"],
  "Tampa": ["TPA"],
  "Salt Lake City": ["SLC"],
  "St. Louis": ["STL"],
  "Pittsburgh": ["PIT"],
  "Cleveland": ["CLE"],
  "Indianapolis": ["IND"],
  "Cincinnati": ["CVG"],
  "Kansas City": ["MCI"],
  "Raleigh": ["RDU"],
  "San Juan": ["SJU"],
  "Honolulu": ["HNL"],
};

const CABIN_OPTIONS = ["economy", "premium_economy", "business", "first"] as const;
const CABIN_LABELS: Record<string, string> = {
  economy: "Economy",
  premium_economy: "Premium Economy",
  business: "Business",
  first: "First",
};

function validateIataCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

function maskNumber(num: string, showLast = 4): string {
  if (num.length <= showLast) return num;
  return "••••" + num.slice(-showLast);
}

/**
 * L3: frequent-flyer numbers are account-takeover-grade data for airline
 * programs and are only ever displayed (never sent back to the API). Store them
 * masked (last 4) so credentials.json never holds a full membership number.
 */
function maskFFPrograms(
  programs: Array<{ airlineCode: string; membershipNumber: string }>,
): Array<{ airlineCode: string; membershipNumber: string }> {
  return programs.map((ff) => ({ airlineCode: ff.airlineCode, membershipNumber: maskNumber(ff.membershipNumber) }));
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

/** Read all of stdin as UTF-8 (used by `set-token -`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

interface MeResponse {
  me: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    name?: string;
    dateOfBirth?: string | null;
    gender?: string | null;
    passport?: { last4: string; issueCountry: string; nationalityCountry: string; expirationDate: string } | null;
    frequentFlyerPrograms?: Array<{ airlineCode: string; membershipNumber: string }>;
    profile?: {
      location?: string;
      city?: { name: string } | null;
      country?: { name: string } | null;
    };
  };
}

const ME_QUERY = `{ me { id firstName lastName email name dateOfBirth gender passport { last4 issueCountry nationalityCountry expirationDate } frequentFlyerPrograms { airlineCode membershipNumber } profile { location city { name } country { name } } } }`;

/**
 * Fetch the full user profile and build a UserContext with smart defaults.
 * Shared by both `auth login` and `auth setup`.
 */
async function fetchAndBuildContext(): Promise<{ ctx: UserContext; me: MeResponse["me"] }> {
  const data = await graphql<MeResponse>(ME_QUERY);
  const me = data.me;

  // Preserve existing preferences if user already ran setup
  const existingCtx = getUserContext();

  const rawName = me.name ?? `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim();
  const displayName = rawName || me.email;
  const location = me.profile?.location;
  const city = me.profile?.city?.name;
  const country = me.profile?.country?.name;

  // Auto-detect home airports from city (preserve existing if already configured)
  const detectedAirports = existingCtx?.homeAirports?.length
    ? existingCtx.homeAirports
    : (city ? (CITY_AIRPORTS[city] ?? []) : []);

  const ctx: UserContext = {
    id: me.id,
    name: displayName,
    firstName: me.firstName,
    lastName: me.lastName,
    email: me.email,
    dateOfBirth: me.dateOfBirth ?? undefined,
    gender: me.gender ?? undefined,
    location: location ?? undefined,
    city: city ?? undefined,
    country: country ?? undefined,
    homeAirports: detectedAirports,
    preferredCabin: existingCtx?.preferredCabin ?? "economy",
  };

  // Import passport if on profile
  if (me.passport) {
    ctx.passport = me.passport;
  }

  // Import frequent flyer programs if on profile (stored masked — L3)
  if (me.frequentFlyerPrograms && me.frequentFlyerPrograms.length > 0) {
    ctx.frequentFlyerPrograms = maskFFPrograms(me.frequentFlyerPrograms);
  }

  return { ctx, me };
}

/**
 * Print a summary of the saved profile context.
 */
function printProfileSummary(ctx: UserContext, me: MeResponse["me"]): void {
  const parts: string[] = [];

  // Location + airports
  const locParts = [ctx.location, ctx.city, ctx.country].filter(Boolean);
  if (locParts.length > 0) {
    const airportStr = ctx.homeAirports.length > 0 ? ` (${ctx.homeAirports.join(", ")})` : "";
    parts.push(`  📍 ${locParts.join(" · ")}${airportStr}`);
  } else if (ctx.homeAirports.length > 0) {
    parts.push(`  ✈️  Home: ${ctx.homeAirports.join(", ")}`);
  }

  // Cabin
  if (ctx.preferredCabin) {
    parts.push(`  💺 ${CABIN_LABELS[ctx.preferredCabin] ?? ctx.preferredCabin}`);
  }

  // Traveller data
  const travellerParts: string[] = [];
  if (me.dateOfBirth) travellerParts.push(`DOB: ${me.dateOfBirth}`);
  if (me.gender) travellerParts.push(me.gender);
  if (me.passport) travellerParts.push(`Passport: ••••${me.passport.last4}`);
  if (travellerParts.length > 0) {
    parts.push(`  👤 ${travellerParts.join(" · ")}`);
  }

  // Frequent flyer
  if (me.frequentFlyerPrograms && me.frequentFlyerPrograms.length > 0) {
    const ffs = me.frequentFlyerPrograms.map(ff => `${ff.airlineCode} ${maskNumber(ff.membershipNumber)}`).join(", ");
    parts.push(`  ✈️  ${ffs}`);
  }

  if (parts.length > 0) {
    console.log(parts.join("\n"));
  }
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("set-token <token>")
    .description("Save a personal access token (use '-' to read the token from stdin, keeping it out of shell history)")
    .option("--url <apiUrl>", "API base URL", "https://travel.voyagier.com/api")
    .action(async (token: string, opts) => {
      // M4: `set-token -` reads the token from stdin (trimmed) so scripts can
      // pipe it in without it landing in argv (shell history / `ps`).
      let tokenValue = token;
      if (token === "-") {
        tokenValue = (await readStdin()).trim();
        if (!tokenValue) {
          throw new CliError(
            CliErrorCode.VALIDATION,
            'No token received on stdin.\n  Pipe a token: echo "$VOYAGIER_PAT" | voyagier auth set-token -',
          );
        }
      }
      saveCredentials(tokenValue, opts.url);
      console.log(chalk.green("✓ Token saved."));
      console.log(chalk.dim(`  API URL: ${opts.url}`));
      console.log(chalk.dim("  Next: voyagier auth setup"));
    });

  auth
    .command("status")
    .description("Check authentication status and profile")
    .action(async () => {
      if (!credentialsExist()) {
        console.log(chalk.red(authFailedMessage("Not authenticated.")));
        return;
      }

      const apiUrl = getApiUrl();
      const token = getToken();
      const masked = token.length > 12 ? token.slice(0, 8) + "••••" + token.slice(-4) : "••••";

      console.log(chalk.bold("\nVoyagier CLI Status\n"));
      console.log(`  Token:   ${chalk.dim(masked)}`);
      console.log(`  API URL: ${chalk.dim(apiUrl)}`);

      try {
        const data = await graphql<{ me: { email: string; name?: string } }>(
          `{ me { email name } }`
        );
        const user = data.me;
        const displayName = user.name ? `${user.name} (${user.email})` : user.email;
        console.log(`  User:    ${chalk.green(displayName)}`);
        console.log(`\n  ${chalk.green("✓")} GraphQL: connected`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("401") || message.includes("Authentication")) {
          console.log(`\n  ${chalk.red("✗")} GraphQL: authentication failed`);
        } else {
          console.log(`\n  ${chalk.red("✗")} GraphQL: ${message}`);
        }
      }

      // Show cached profile
      const ctx = getUserContext();
      if (ctx) {
        console.log(chalk.bold("\n  Profile (cached)\n"));
        if (ctx.location) console.log(`  📍 Location:   ${ctx.location}${ctx.city ? ` · ${ctx.city}` : ""}${ctx.country ? ` · ${ctx.country}` : ""}`);
        if (ctx.homeAirports.length > 0) {
          const airports = ctx.homeAirports.map((a, i) => i === 0 ? `${a} (primary)` : a).join(", ");
          console.log(`  ✈️  Airports:   ${airports}`);
        }
        if (ctx.preferredCabin) console.log(`  💺 Cabin:      ${CABIN_LABELS[ctx.preferredCabin] ?? ctx.preferredCabin}`);
        if (ctx.passport) {
          console.log(`  🛂 Passport:   ••••${ctx.passport.last4} (${ctx.passport.issueCountry}, exp ${ctx.passport.expirationDate})`);
        }
        if (ctx.frequentFlyerPrograms && ctx.frequentFlyerPrograms.length > 0) {
          // Stored masked (L3); re-mask on display too (idempotent) so a
          // credentials.json written by an older version is masked as well.
          const ffs = ctx.frequentFlyerPrograms.map(ff => `${ff.airlineCode} ${maskNumber(ff.membershipNumber)}`).join(", ");
          console.log(`  ✈️  FF:         ${ffs}`);
        }
      } else {
        console.log(chalk.dim("\n  No profile cached. Run: voyagier auth setup"));
      }

      console.log();
    });
  auth
    .command("login")
    .description("Log in to Voyagier")
    .option("--url <apiUrl>", "API base URL", "https://travel.voyagier.com/api")
    .action(async (opts) => {
      const apiUrl = opts.url as string;
      const isInteractive = process.stdin.isTTY === true && !process.env.CI;

      console.log(chalk.bold("\nVoyagier CLI Login\n"));

      // Derive web URL from API URL (strip /api suffix)
      const webUrl = apiUrl.replace(/\/api\/?$/, "");

      if (!isInteractive) {
        // Non-interactive: just show instructions
        console.log("  Generate a Personal Access Token at:\n");
        console.log(chalk.cyan(`    ${webUrl}/settings\n`));
        console.log("  Then run:\n");
        console.log(chalk.cyan("    voyagier auth set-token <your-token>\n"));
        return;
      }

      // Interactive: open browser + prompt for token
      const settingsUrl = `${webUrl}/settings`;
      console.log(`  1. Go to ${chalk.cyan(settingsUrl)}`);
      console.log(`  2. Generate a Personal Access Token`);
      console.log(`  3. Paste it below\n`);
      openBrowser(settingsUrl);

      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const token = (await rl.question(chalk.bold("  Token: "))).trim();
        if (!token) {
          console.log(chalk.dim("\n  Cancelled.\n"));
          return;
        }

        saveCredentials(token, apiUrl);

        // Verify + auto-setup profile
        try {
          const { ctx, me } = await fetchAndBuildContext();
          saveUserContext(ctx);

          const displayName = ctx.name || me.email;
          console.log(chalk.green(`\n  ✓ Logged in as ${chalk.bold(displayName)} (${me.email})\n`));

          printProfileSummary(ctx, me);

          // Show what was auto-detected
          if (ctx.homeAirports.length > 0) {
            console.log(chalk.dim(`\n  Home airport auto-detected from your profile. Change with: voyagier auth setup --airports DCA,IAD`));
          }

          console.log(chalk.dim(`\n  Ready! Try: voyagier search flights --to EDI --date 2026-05-29\n`));
        } catch {
          console.log(chalk.green("\n  ✓ Token saved.\n"));
          console.log(chalk.yellow("  ⚠ Could not verify — token may be invalid. Check: voyagier auth status\n"));
        }
      } finally {
        rl.close();
      }
    });


  auth
    .command("logout")
    .description("Clear saved credentials")
    .action(() => {
      clearCredentials();
      console.log(chalk.green("✓ Credentials cleared."));
    });

  auth
    .command("setup")
    .description("Configure your traveller profile (airports, cabin, passport, frequent flyer)")
    .option("--airports <codes>", "Home airport(s), comma-separated (e.g. BWI,DCA,IAD)")
    .option("--cabin <class>", "Preferred cabin: economy, premium_economy, business, first")
    .option("--skip-passport", "Skip passport setup")
    .option("--skip-ff", "Skip frequent flyer setup")
    .action(async (opts) => {
      if (!credentialsExist()) {
        console.log(chalk.red(authFailedMessage("Not authenticated.")));
        return;
      }

      console.log(chalk.bold("\n  Voyagier CLI Setup"));
      console.log(chalk.dim("  ──────────────────\n"));

      // Fetch user profile and build context with smart defaults
      let me: MeResponse["me"];
      let userCtx: UserContext;
      try {
        const result = await fetchAndBuildContext();
        me = result.me;
        userCtx = result.ctx;
      } catch (err) {
        if (err instanceof CliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError(CliErrorCode.API_ERROR, `Failed to fetch profile: ${message}`);
      }

      const displayName = userCtx.name;
      console.log(`  ${chalk.green("✓")} Connected as ${chalk.bold(displayName)} (${me.email})\n`);

      const location = userCtx.location;
      const city = userCtx.city;
      const country = userCtx.country;

      if (location || city || country) {
        console.log(`  📍 ${chalk.bold("Location")}`);
        const parts = [location, city, country].filter(Boolean);
        console.log(`     ${parts.join(" · ")}\n`);
      }

      // Show imported traveller data from web profile
      if (me.dateOfBirth || me.gender) {
        console.log(`  👤 ${chalk.bold("Traveller Info")} ${chalk.dim("(from your profile)")}`);
        if (me.dateOfBirth) console.log(`     DOB: ${me.dateOfBirth}`);
        if (me.gender) console.log(`     Gender: ${me.gender}`);
        console.log();
      }

      const isInteractive = process.stdin.isTTY === true && !process.env.CI;
      let rl: ReturnType<typeof createInterface> | null = null;
      if (isInteractive) {
        rl = createInterface({ input: stdin, output: stdout });
      }

      try {
        // ── Home Airports ──
        console.log(`  ✈️  ${chalk.bold("Home Airports")}`);
        if (opts.airports) {
          // Non-interactive
          const codes = (opts.airports as string).split(",").map((c: string) => c.trim().toUpperCase()).filter(Boolean);
          const invalid = codes.filter((c: string) => !validateIataCode(c));
          if (invalid.length > 0) {
            throw new CliError(CliErrorCode.VALIDATION, `Invalid airport code(s): ${invalid.join(", ")} (must be 3 letters)`);
          }
          userCtx.homeAirports = codes;
        } else {
          // Show auto-detected or suggest based on city
          const autoDetected = userCtx.homeAirports.length > 0 ? userCtx.homeAirports : [];
          const suggestion = city ? CITY_AIRPORTS[city] : undefined;
          if (autoDetected.length > 0) {
            console.log(chalk.dim(`     Auto-detected from your profile: ${autoDetected.join(", ")}`));
          } else if (suggestion) {
            console.log(chalk.dim(`     Your city is ${city}. Common airports: ${suggestion.join(", ")}`));
          }
          if (rl) {
            const defaultStr = autoDetected.length > 0 ? autoDetected.join(",") : "";
            const promptText = defaultStr
              ? `     Home airport(s) [${defaultStr}]: `
              : "     Enter your home airport(s), comma-separated (e.g. BWI,DCA): ";
            const airportInput = await prompt(rl, promptText);
            if (airportInput) {
              const codes = airportInput.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
              const invalid = codes.filter(c => !validateIataCode(c));
              if (invalid.length > 0) {
                console.log(chalk.yellow(`     ⚠ Skipping invalid code(s): ${invalid.join(", ")}`));
              }
              userCtx.homeAirports = codes.filter(c => validateIataCode(c));
            }
            // If user pressed Enter with no input, keep the auto-detected value
          } else {
            if (autoDetected.length === 0) {
              console.log(chalk.dim("     Non-interactive mode. Use: voyagier auth setup --airports BWI,DCA"));
            }
          }
        }
        if (userCtx.homeAirports.length > 0) {
          const display = userCtx.homeAirports.map((a, i) => i === 0 ? `${a} (primary)` : a).join(", ");
          console.log(chalk.green(`     ✓ ${display}`));
          console.log(chalk.dim(`     Flight searches will default to ${userCtx.homeAirports[0]} when --from is omitted.\n`));
        } else {
          console.log(chalk.dim("     Skipped. You can set this later with: voyagier auth setup --airports BWI,DCA\n"));
        }

        // ── Preferred Cabin ──
        console.log(`  💺 ${chalk.bold("Preferred Cabin")}`);
        if (opts.cabin) {
          const cabin = (opts.cabin as string).toLowerCase();
          if (CABIN_OPTIONS.includes(cabin as typeof CABIN_OPTIONS[number])) {
            userCtx.preferredCabin = cabin as typeof CABIN_OPTIONS[number];
          } else {
            console.log(chalk.yellow(`     ⚠ Invalid cabin "${cabin}". Valid: ${CABIN_OPTIONS.join(", ")}`));
          }
        } else if (rl) {
          console.log(chalk.dim("     1. Economy  2. Premium Economy  3. Business  4. First"));
          const cabinInput = await prompt(rl, "     Select (1-4, or press Enter for Economy): ");
          const idx = parseInt(cabinInput, 10);
          if (idx >= 1 && idx <= 4) {
            userCtx.preferredCabin = CABIN_OPTIONS[idx - 1];
          } else {
            userCtx.preferredCabin = "economy";
          }
        } else if (!opts.cabin) {
          userCtx.preferredCabin = "economy";
          console.log(chalk.dim("     Defaulting to Economy. Use: voyagier auth setup --cabin business"));
        }
        if (userCtx.preferredCabin) {
          console.log(chalk.green(`     ✓ ${CABIN_LABELS[userCtx.preferredCabin]}\n`));
        }

        // ── Passport ──
        if (!opts.skipPassport) {
          console.log(`  🛂 ${chalk.bold("Passport")}`);
          if (me.passport) {
            console.log(chalk.dim(`     On file: ••••${me.passport.last4} (${me.passport.issueCountry}, exp ${me.passport.expirationDate})`));
            userCtx.passport = me.passport;
            console.log(chalk.green("     ✓ Imported from profile\n"));
          } else if (rl) {
            const last4 = await prompt(rl, "     Passport number (last 4 digits, or Enter to skip): ");
            if (last4 && /^\d{4}$/.test(last4)) {
              const issueCountry = await prompt(rl, "     Issue country (e.g. US): ") || "US";
              const nationality = await prompt(rl, "     Nationality (e.g. US): ") || issueCountry;
              const expiration = await prompt(rl, "     Expiration (YYYY-MM): ");
              userCtx.passport = {
                last4,
                issueCountry: issueCountry.toUpperCase(),
                nationalityCountry: nationality.toUpperCase(),
                expirationDate: expiration || "unknown",
              };
              console.log(chalk.green(`     ✓ ••••${last4} (${userCtx.passport.issueCountry}, exp ${userCtx.passport.expirationDate})\n`));
            } else {
              console.log(chalk.dim("     Skipped.\n"));
            }
          } else {
            console.log(chalk.dim("     Skipped (non-interactive).\n"));
          }
        }

        // ── Frequent Flyer Programs ──
        if (!opts.skipFf) {
          console.log(`  ✈️  ${chalk.bold("Frequent Flyer Programs")}`);
          if (me.frequentFlyerPrograms && me.frequentFlyerPrograms.length > 0) {
            userCtx.frequentFlyerPrograms = maskFFPrograms(me.frequentFlyerPrograms);
            const display = me.frequentFlyerPrograms.map(ff => `${ff.airlineCode} ${maskNumber(ff.membershipNumber)}`).join(", ");
            console.log(chalk.dim(`     On file: ${display}`));
            console.log(chalk.green("     ✓ Imported from profile\n"));
          } else if (rl) {
            const programs: Array<{ airlineCode: string; membershipNumber: string }> = [];
            let adding = true;
            while (adding) {
              const ffInput = await prompt(rl, programs.length === 0
                ? "     Add a program (e.g. DL 1234567890, or Enter to skip): "
                : "     Add another (or Enter to finish): ");
              if (!ffInput) {
                adding = false;
              } else {
                const parts = ffInput.split(/\s+/);
                if (parts.length >= 2) {
                  const airline = parts[0].toUpperCase();
                  const number = parts.slice(1).join("");
                  if (/^[A-Z0-9]{2}$/.test(airline)) {
                    // Store masked (L3) — the full number is never persisted
                    // (the confirmation echo below is masked too).
                    programs.push({ airlineCode: airline, membershipNumber: maskNumber(number) });
                    console.log(chalk.green(`     ✓ ${airline} ${maskNumber(number)}`));
                  } else {
                    console.log(chalk.yellow(`     ⚠ Invalid airline code "${airline}" (expected 2 characters)`));
                  }
                } else {
                  console.log(chalk.yellow("     ⚠ Format: AIRLINE NUMBER (e.g. DL 1234567890)"));
                }
              }
            }
            if (programs.length > 0) {
              userCtx.frequentFlyerPrograms = programs;
            }
            console.log();
          } else {
            console.log(chalk.dim("     Skipped (non-interactive).\n"));
          }
        }

        // Save
        saveUserContext(userCtx);

        // Summary
        console.log(chalk.dim("  ──────────────────"));
        console.log(`\n  ${chalk.green("✓")} ${chalk.bold("Setup complete!")}\n`);
        if (userCtx.homeAirports.length > 0) {
          const display = userCtx.homeAirports.map((a, i) => i === 0 ? `${a} (primary)` : a).join(", ");
          console.log(`     Home:      ${display}`);
        }
        if (userCtx.preferredCabin) console.log(`     Cabin:     ${CABIN_LABELS[userCtx.preferredCabin]}`);
        if (userCtx.passport) console.log(`     Passport:  ••••${userCtx.passport.last4} (${userCtx.passport.issueCountry}, exp ${userCtx.passport.expirationDate})`);
        if (userCtx.frequentFlyerPrograms && userCtx.frequentFlyerPrograms.length > 0) {
          // Stored masked (L3); re-mask on display (idempotent) for legacy files.
          const ffs = userCtx.frequentFlyerPrograms.map(ff => `${ff.airlineCode} ${maskNumber(ff.membershipNumber)}`).join(", ");
          console.log(`     FF:        ${ffs}`);
        }
        console.log(chalk.dim(`\n     Search flights: voyagier search flights --to SJU --date 2026-05-14\n`));

      } finally {
        rl?.close();
      }
    });
}
