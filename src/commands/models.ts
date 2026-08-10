/**
 * Chat model surface (VOY-1897 — bring-your-own-key provider/model selection).
 *
 * Backed by the availableChatModels catalog plus the setMyDefaultChatModel /
 * clearMyDefaultChatModel / updateChatSessionModel mutations.
 *
 * Surface:
 *   voyagier models                         list available chat models
 *   voyagier models set-default <modelId>   save a per-user default model
 *   voyagier models clear-default           drop the per-user default
 *
 * The catalog is the single source of truth for provider resolution: the CLI
 * never guesses which AiProvider a modelId belongs to — it looks the id up in
 * availableChatModels. `chat --model` reuses applySessionModel() from here.
 *
 * Graceful degradation: a deployment that predates this surface rejects the
 * documents as unknown-field schema drift; byokUnsupported() maps that to a
 * clear "not supported by this server yet" error instead of a raw drift/stack.
 */
import { Command } from "commander";
import chalk from "chalk";
import { graphql } from "../api.js";
import { jsonOutput } from "../output.js";
import { CliError, CliErrorCode } from "../errors.js";
import {
  AVAILABLE_CHAT_MODELS,
  UPDATE_CHAT_SESSION_MODEL,
  SET_MY_DEFAULT_CHAT_MODEL,
  CLEAR_MY_DEFAULT_CHAT_MODEL,
} from "../queries.js";

/** AiProvider enum as exposed by the GraphQL schema. */
export type AiProvider = "Anthropic" | "Gemini" | "OpenAi";

/** Where the key backing a model comes from. */
export type ChatModelSource = "user" | "house-stored" | "house-env";

export interface ChatModel {
  provider: AiProvider;
  modelId: string;
  displayName: string;
  isProviderDefault: boolean;
  isUserDefault: boolean;
  source: ChatModelSource;
}

interface UserDefaultChatModel {
  userId: string;
  defaultAiProvider: AiProvider | null;
  defaultAiModelId: string | null;
}

/**
 * The GraphQL operations and types that make up the model-selection surface.
 * Drift errors naming one of these mean the server predates the surface; drift
 * on anything else is a different CLI/server mismatch and must not be masked.
 */
const BYOK_SCHEMA_NAMES = [
  "availableChatModels",
  "updateChatSessionModel",
  "setMyDefaultChatModel",
  "clearMyDefaultChatModel",
  "AvailableChatModel",
  "AiProvider",
  "UserAiPreference",
];

/**
 * Run a BYOK chat-model operation, mapping an older-deployment rejection to a
 * clear error. A backend that predates VOY-1897 rejects these documents as
 * SCHEMA_DRIFT ("Cannot query field …") naming one of the model-selection
 * fields/types; only that drift is mapped — unrelated drift and everything
 * else (auth, network, a real server error) propagates untouched, so the user
 * never sees a stack trace or a misleading "not supported" message.
 */
async function byokUnsupported<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof CliError &&
      err.code === CliErrorCode.SCHEMA_DRIFT &&
      BYOK_SCHEMA_NAMES.some((name) => err.message.includes(name))
    ) {
      throw new CliError(
        CliErrorCode.API_ERROR,
        "Chat model selection is not supported by this server yet.\n  This deployment predates the model-selection surface. Update the Voyagier server, or run `voyagier chat` without --model.",
      );
    }
    throw err;
  }
}

/** Fetch the caller's available chat models. */
async function fetchAvailableModels(): Promise<ChatModel[]> {
  const data = await byokUnsupported(() =>
    graphql<{ availableChatModels: ChatModel[] }>(AVAILABLE_CHAT_MODELS),
  );
  return data.availableChatModels ?? [];
}

/**
 * Resolve a modelId to its provider via the catalog. Throws NOT_FOUND with the
 * valid ids listed when the id isn't in availableChatModels.
 */
export async function resolveModel(modelId: string): Promise<ChatModel> {
  const models = await fetchAvailableModels();
  const match = models.find((m) => m.modelId === modelId);
  if (!match) {
    const ids = models.length ? models.map((m) => m.modelId).join(", ") : "(none available)";
    throw new CliError(
      CliErrorCode.NOT_FOUND,
      `Unknown chat model "${modelId}".\n  Valid model ids: ${ids}\n  List them: voyagier models`,
    );
  }
  return match;
}

/**
 * Resolve a model from the catalog and set it on a chat session before the
 * first message. Used by both `chat --model` (REPL) and `chat -m --model`
 * (single turn). Accepts a pre-resolved ChatModel so callers can validate the
 * id BEFORE creating a session (avoids orphaning a fresh session on an
 * unknown id). Returns the applied provider + modelId for confirmation.
 */
export async function applySessionModel(
  sessionId: string,
  modelOrId: string | ChatModel,
): Promise<{ provider: AiProvider; modelId: string }> {
  const model = typeof modelOrId === "string" ? await resolveModel(modelOrId) : modelOrId;
  const data = await byokUnsupported(() =>
    graphql<{ updateChatSessionModel: { id: string; aiProvider: string; aiModelId: string } }>(
      UPDATE_CHAT_SESSION_MODEL,
      { sessionId, provider: model.provider, modelId: model.modelId },
    ),
  );
  // The server's echo is the source of truth for what was actually applied
  // (it may normalize the id); fall back to the request only if absent.
  const applied = data.updateChatSessionModel;
  return {
    provider: (applied?.aiProvider as AiProvider) ?? model.provider,
    modelId: applied?.aiModelId ?? model.modelId,
  };
}

/** Render a model's key source for humans: 'user' → "your key", house-* → "Voyagier". */
function sourceLabel(source: ChatModelSource): string {
  return source === "user" ? "your key" : "Voyagier";
}

function markerLabel(m: ChatModel): string {
  const parts: string[] = [];
  if (m.isUserDefault) parts.push(chalk.green("your default"));
  if (m.isProviderDefault) parts.push(chalk.cyan("provider default"));
  return parts.join(" ");
}

async function listModels(opts: { json?: boolean }): Promise<void> {
  const models = await fetchAvailableModels();

  if (opts.json) {
    jsonOutput({ models, total: models.length });
    return;
  }

  if (models.length === 0) {
    console.log(chalk.dim("No chat models available on this account."));
    console.log(chalk.dim("Add a provider key in the web UI, or ask about the Voyagier-provided models."));
    return;
  }

  // Align the bare columns (pad the plain text, then colorize) so ANSI codes
  // don't throw off the widths.
  const provW = Math.max("PROVIDER".length, ...models.map((m) => m.provider.length));
  const idW = Math.max("MODEL ID".length, ...models.map((m) => m.modelId.length));
  const nameW = Math.max("NAME".length, ...models.map((m) => m.displayName.length));
  const srcW = Math.max("KEY".length, ...models.map((m) => sourceLabel(m.source).length));

  console.log(
    chalk.dim(
      `${"PROVIDER".padEnd(provW)}  ${"MODEL ID".padEnd(idW)}  ${"NAME".padEnd(nameW)}  ${"KEY".padEnd(srcW)}`,
    ),
  );
  for (const m of models) {
    const line =
      `${chalk.cyan(m.provider.padEnd(provW))}  ${chalk.bold(m.modelId.padEnd(idW))}  ` +
      `${m.displayName.padEnd(nameW)}  ${chalk.dim(sourceLabel(m.source).padEnd(srcW))}`;
    const markers = markerLabel(m);
    console.log(markers ? `${line}  ${markers}` : line);
  }
  console.log(chalk.dim(`\n${models.length} model${models.length === 1 ? "" : "s"} available`));
  console.log(chalk.dim("Set a default: voyagier models set-default <modelId>"));
}

function printDefault(label: string, r: UserDefaultChatModel): void {
  if (r.defaultAiModelId) {
    console.log(chalk.green(`✓ ${label}: ${r.defaultAiModelId} (${r.defaultAiProvider})`));
  } else {
    console.log(chalk.green(`✓ ${label}: none (using the Voyagier default)`));
  }
}

export function registerModelsCommands(program: Command): void {
  const models = program
    .command("models")
    .description("List available AI chat models and manage your default")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      await listModels(opts);
    });

  // -- set-default --
  // NOTE: --json is declared on the parent `models` too, so Commander treats it
  // as an inherited (global-ish) option and routes the value to the parent's
  // opts — the subcommand's own opts() would come back empty. Read the merged
  // view via optsWithGlobals() so `models set-default x --json` is honored.
  models
    .command("set-default <modelId>")
    .description("Set your default chat model (used for new chat sessions)")
    .option("--json", "Output raw JSON")
    .action(async (modelId: string, _opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as { json?: boolean };
      const model = await resolveModel(modelId);
      const data = await byokUnsupported(() =>
        graphql<{ setMyDefaultChatModel: UserDefaultChatModel }>(SET_MY_DEFAULT_CHAT_MODEL, {
          provider: model.provider,
          modelId,
        }),
      );
      const r = data.setMyDefaultChatModel;
      if (opts.json) {
        jsonOutput({ ok: true, default: r });
        return;
      }
      printDefault("Default chat model set", r);
    });

  // -- clear-default --
  models
    .command("clear-default")
    .description("Clear your default chat model (fall back to the Voyagier default)")
    .option("--json", "Output raw JSON")
    .action(async (_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as { json?: boolean };
      const data = await byokUnsupported(() =>
        graphql<{ clearMyDefaultChatModel: UserDefaultChatModel }>(CLEAR_MY_DEFAULT_CHAT_MODEL),
      );
      const r = data.clearMyDefaultChatModel;
      if (opts.json) {
        jsonOutput({ ok: true, default: r });
        return;
      }
      printDefault("Default chat model cleared", r);
    });
}
