import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { createServer } from "http";
import { openBrowser } from "../utils.js";

import { saveCredentials, getToken, getApiUrl, clearCredentials, credentialsExist, saveUserContext, getUserContext } from "../config.js";
import type { UserContext } from "../config.js";
import { graphql } from "../api.js";

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

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

interface MeResponse {
  me: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    name?: string;
    passport?: { last4: string; issueCountry: string; nationalityCountry: string; expirationDate: string } | null;
    frequentFlyerPrograms?: Array<{ airlineCode: string; membershipNumber: string }>;
    profile?: {
      location?: string;
      city?: { name: string } | null;
      country?: { name: string } | null;
    };
  };
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("set-token <token>")
    .description("Save a personal access token")
    .option("--url <apiUrl>", "API base URL", "https://voyagier.com")
    .action((token: string, opts) => {
      saveCredentials(token, opts.url);
      console.log(chalk.green("✓ Token saved."));
      console.log(chalk.dim(`  API URL: ${opts.url}`));
      console.log(chalk.dim("  Next: voyagier auth setup"));
    });

  auth
    .command("status")
    .description("Check authentication status and profile")
    .action(async () => {
      if (!credentialsExist()) {
        console.log(chalk.red("✗ Not authenticated."));
        console.log(chalk.dim("  Run: voyagier auth set-token <token>"));
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
    .description("Log in via browser (opens browser, receives token via callback)")
    .option("--url <apiUrl>", "API base URL", "https://voyagier.com")
    .option("--port <port>", "Local callback port", "9876")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const apiUrl = opts.url as string;

      console.log(chalk.bold("\nVoyagier CLI Login\n"));
      console.log(chalk.dim("Starting local server to receive auth callback...\n"));

      const tokenPromise = new Promise<string>((resolve, reject) => {
        let server: ReturnType<typeof createServer>;

        const timeout = setTimeout(() => {
          server?.close();
          reject(new Error("Login timed out after 5 minutes."));
        }, 5 * 60 * 1000);

        server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", `http://localhost:${port}`);

          if (url.pathname === "/callback") {
            const token = url.searchParams.get("token");

            if (token) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(`
                <html><body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                  <div style="text-align: center;">
                    <h1>✓ Authenticated</h1>
                    <p>You can close this window and return to the terminal.</p>
                  </div>
                </body></html>
              `);
              clearTimeout(timeout);
              server.close();
              resolve(token);
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Missing token parameter.");
            }
            return;
          }

          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        });

        server.listen(port, () => {
          const loginUrl = `${apiUrl}/auth/cli?callback=http://localhost:${port}/callback`;
          console.log(`  Open this URL in your browser:\n`);
          console.log(chalk.cyan(`  ${loginUrl}\n`));
          console.log(chalk.dim("  Waiting for authentication...\n"));
          openBrowser(loginUrl);
        });

        server.on("error", (err) => {
          clearTimeout(timeout);
          reject(new Error(`Could not start local server on port ${port}: ${err.message}`));
        });
      });

      try {
        const token = await tokenPromise;
        saveCredentials(token, apiUrl);
        console.log(chalk.green("✓ Login successful! Token saved.\n"));
        console.log(chalk.dim("  Next: voyagier auth setup"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Login failed: ${message}\n`));
        process.exit(1);
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
        console.log(chalk.red("✗ Not authenticated."));
        console.log(chalk.dim("  Run: voyagier auth set-token <token>  or  voyagier auth login"));
        return;
      }

      console.log(chalk.bold("\n  Voyagier CLI Setup"));
      console.log(chalk.dim("  ──────────────────\n"));

      // Fetch user profile from API
      let me: MeResponse["me"];
      try {
        const data = await graphql<MeResponse>(
          `{ me { id firstName lastName email name passport { last4 issueCountry nationalityCountry expirationDate } frequentFlyerPrograms { airlineCode membershipNumber } profile { location city { name } country { name } } } }`
        );
        me = data.me;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(chalk.red(`Failed to fetch profile: ${message}\n`));
        process.exit(1);
      }

      const displayName = me.name ?? `${me.firstName} ${me.lastName}`;
      console.log(`  ${chalk.green("✓")} Connected as ${chalk.bold(displayName)} (${me.email})\n`);

      const location = me.profile?.location;
      const city = me.profile?.city?.name;
      const country = me.profile?.country?.name;

      if (location || city || country) {
        console.log(`  📍 ${chalk.bold("Location")}`);
        const parts = [location, city, country].filter(Boolean);
        console.log(`     ${parts.join(" · ")}\n`);
      }

      // Build user context
      const userCtx: UserContext = {
        id: me.id,
        name: displayName,
        email: me.email,
        location: location ?? undefined,
        city: city ?? undefined,
        country: country ?? undefined,
        homeAirports: [],
      };

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
            process.stderr.write(chalk.red(`     Invalid airport code(s): ${invalid.join(", ")} (must be 3 letters)\n`));
            process.exit(1);
          }
          userCtx.homeAirports = codes;
        } else {
          // Suggest based on city
          const suggestion = city ? CITY_AIRPORTS[city] : undefined;
          if (suggestion) {
            console.log(chalk.dim(`     Your city is ${city}. Common airports: ${suggestion.join(", ")}`));
          }
          const airportInput = await prompt(rl!, "     Enter your home airport(s), comma-separated (e.g. BWI,DCA): ");
          if (airportInput) {
            const codes = airportInput.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
            const invalid = codes.filter(c => !validateIataCode(c));
            if (invalid.length > 0) {
              console.log(chalk.yellow(`     ⚠ Skipping invalid code(s): ${invalid.join(", ")}`));
            }
            userCtx.homeAirports = codes.filter(c => validateIataCode(c));
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
          }
        }

        // ── Frequent Flyer Programs ──
        if (!opts.skipFf) {
          console.log(`  ✈️  ${chalk.bold("Frequent Flyer Programs")}`);
          if (me.frequentFlyerPrograms && me.frequentFlyerPrograms.length > 0) {
            userCtx.frequentFlyerPrograms = me.frequentFlyerPrograms;
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
                    programs.push({ airlineCode: airline, membershipNumber: number });
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
          const ffs = userCtx.frequentFlyerPrograms.map(ff => `${ff.airlineCode} ${maskNumber(ff.membershipNumber)}`).join(", ");
          console.log(`     FF:        ${ffs}`);
        }
        console.log(chalk.dim(`\n     Search flights: voyagier search flights --to SJU --date 2026-05-14\n`));

      } finally {
        rl?.close();
      }
    });
}
