import { Command } from "commander";
import chalk from "chalk";
import { credentialsExist, getUserContext, getApiUrl, saveUserContext } from "../config.js";
import { graphql } from "../api.js";
import { CliError, CliErrorCode, authFailedMessage } from "../errors.js";
import { deriveBaseUrl } from "../utils.js";

const CABIN_LABELS: Record<string, string> = {
  economy: "Economy",
  premium_economy: "Premium Economy",
  business: "Business",
  first: "First",
};

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Show your identity and profile summary (live-verifies the token)")
    .option("--json", "Output raw JSON")
    .option("--cached", "Show cached identity without the live token check (falls back to a live fetch when nothing is cached)")
    .action(async (opts) => {
      if (!credentialsExist()) {
        throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Not authenticated."));
      }

      let ctx = getUserContext();

      // Default: LIVE-verify the token (VOY-1703). A revoked/stale PAT must
      // never render a cached identity as if logged in — that lie costs real
      // debugging time. --cached is the explicit offline escape hatch.
      if (!opts.cached || !ctx) {
        interface MeData {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
          name?: string;
          dateOfBirth?: string | null;
          gender?: string | null;
          passport?: { last4: string; issueCountry: string; nationalityCountry: string; expirationDate: string } | null;
        }

        let me: MeData | null = null;

        try {
          const data = await graphql<{ me: MeData }>(
            `{ me { id firstName lastName email name dateOfBirth gender passport { last4 issueCountry nationalityCountry expirationDate } } }`,
          );
          me = data.me;
        } catch (err) {
          // graphql() already normalizes 401/UNAUTHENTICATED into
          // CliError(AUTH_FAILED) — re-throw those with whoami-specific context
          // (which API URL rejected the token, and that the cached identity is
          // deliberately withheld). The regex below is the fallback for raw
          // errors that bypass that normalization (e.g. transport-level).
          const message = err instanceof Error ? err.message : String(err);
          const isAuthFailure =
            (err instanceof CliError && err.code === CliErrorCode.AUTH_FAILED) ||
            (!(err instanceof CliError) &&
              /unauthorized|unauthenticated|forbidden|401|403|invalid token/i.test(message));
          if (isAuthFailure) {
            throw new CliError(
              CliErrorCode.AUTH_FAILED,
              `Token rejected by ${getApiUrl()} — it is stale or revoked.\n` +
                `Fix: voyagier auth set-token --url ${getApiUrl()} <PAT>\n` +
                `(Cached identity deliberately NOT shown; use --cached only for offline reads.)`,
            );
          }
          if (err instanceof CliError) throw err;
          throw new CliError(
            CliErrorCode.API_ERROR,
            `Could not verify identity against ${getApiUrl()}: ${message}\n` +
              `If you are offline, re-run with --cached.`,
          );
        }

        if (me) {
          const rawName = me.name ?? `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim();

          if (ctx) {
            // Update existing context — overwrite with fresh API values (null = cleared server-side)
            ctx.name = rawName || me.email;
            ctx.email = me.email;
            ctx.dateOfBirth = me.dateOfBirth ?? undefined;
            ctx.gender = me.gender ?? undefined;
            ctx.passport = me.passport ?? undefined;
          } else {
            // No cached context — create minimal one from API
            ctx = {
              id: me.id,
              name: rawName || me.email,
              email: me.email,
              dateOfBirth: me.dateOfBirth ?? undefined,
              gender: me.gender ?? undefined,
              passport: me.passport ?? undefined,
              homeAirports: [],
              preferredCabin: "economy",
            };
          }

          try {
            saveUserContext(ctx);
          } catch {
            // Filesystem save failed — continue with in-memory ctx
          }
        }
      }

      // Guaranteed non-null after the block above (either cached or created; throws if neither)
      const profile = ctx!;

      const apiUrl = getApiUrl();
      const baseUrl = deriveBaseUrl(apiUrl);
      const env = baseUrl.includes("dev.") ? "dev" : baseUrl.includes("staging.") ? "staging" : "prod";

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            name: profile.name,
            email: profile.email,
            homeAirports: profile.homeAirports,
            preferredCabin: profile.preferredCabin ?? "economy",
            dateOfBirth: profile.dateOfBirth ?? null,
            gender: profile.gender ?? null,
            hasPassport: !!profile.passport,
            apiUrl,
            environment: env,
          }, null, 2) + "\n",
        );
        return;
      }

      // Compact one-line + details format
      console.log(chalk.bold(`\n  ${profile.name}`) + chalk.dim(` (${profile.email})`));

      const infoParts: string[] = [];
      if (profile.homeAirports.length > 0) infoParts.push(profile.homeAirports.join("/"));
      if (profile.preferredCabin) infoParts.push(CABIN_LABELS[profile.preferredCabin] ?? profile.preferredCabin);
      infoParts.push(env === "prod" ? baseUrl.replace("https://", "") : chalk.yellow(env));

      console.log(chalk.dim(`  ${infoParts.join(" · ")}`));

      // Traveller readiness
      const ready: string[] = [];
      const missing: string[] = [];
      if (profile.dateOfBirth) ready.push("DOB"); else missing.push("DOB");
      if (profile.gender) ready.push("gender"); else missing.push("gender");
      if (profile.passport) ready.push("passport"); else missing.push("passport");

      if (missing.length === 0) {
        console.log(chalk.green(`  ✓ Booking-ready (DOB, gender, passport on file)`));
      } else if (ready.length > 0) {
        console.log(chalk.dim(`  ✓ ${ready.join(", ")}`) + chalk.yellow(` · missing: ${missing.join(", ")}`));
      } else {
        console.log(chalk.yellow(`  ⚠ No traveller data on file. Run: voyagier auth setup`));
      }

      console.log();
    });
}
