import chalk from "chalk";
import { getApiUrl, getToken } from "./config.js";
import { getTraceId } from "./telemetry.js";
import { verbose } from "./verbose.js";
import { CliError, CliErrorCode, authFailedMessage } from "./errors.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface GraphQLOptions {
  dryRun?: boolean;
}

export async function graphql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  options?: GraphQLOptions
): Promise<T> {
  const apiUrl = getApiUrl();
  const token = getToken();

  if (options?.dryRun) {
    const body = { query, variables };
    process.stderr.write("\n--- DRY RUN ---\n");
    process.stderr.write(`POST ${apiUrl}/graphql\n`);
    process.stderr.write(`Authorization: Bearer ${token.slice(0, 8)}••••\n\n`);
    process.stderr.write(JSON.stringify(body, null, 2) + "\n");
    process.stderr.write("--- END DRY RUN ---\n\n");
    process.exit(0);
  }

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-request-id": getTraceId(),
        "x-datadog-trace-id": getTraceId(),
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (fetchErr) {
    if (fetchErr instanceof CliError) throw fetchErr;
    const stack = verbose && fetchErr instanceof Error ? `\n${fetchErr.stack}` : "";
    throw new CliError(
      CliErrorCode.NETWORK,
      `Network error: Could not reach the API.\nHint: Check your connection and API URL: voyagier auth status${stack}`
    );
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Authentication failed. Your token may be invalid or expired."));
    }
    // Try to extract GraphQL error details from the response body
    let detail = "";
    try {
      const errorBody = (await res.json()) as GraphQLResponse;
      if (errorBody.errors?.length) {
        detail = " — " + errorBody.errors.map(e => e.message).join("; ");
      }
    } catch {
      // Response body wasn't valid JSON; fall through to generic message
    }
    const hint = detail === ""
      ? "\nHint: The API returned no data. This may be a permissions issue."
      : "";
    throw new CliError(CliErrorCode.API_ERROR, `API error: ${res.status} ${res.statusText}${detail}${hint}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    const err = json.errors[0];
    const code = (err as Record<string, unknown> & { extensions?: { code?: string } }).extensions?.code;
    if (code === "UNAUTHENTICATED" || err.message === "Unauthorized") {
      throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Authentication failed. Your token may be invalid or expired."));
    }
    const hint = err.message.includes("Cannot query field")
      ? "\nHint: Your CLI may be out of date. Check: voyagier --version"
      : "";
    throw new CliError(CliErrorCode.API_ERROR, `GraphQL error: ${err.message}${hint}`);
  }
  if (!json.data) {
    throw new CliError(CliErrorCode.API_ERROR, "No data returned from API");
  }
  return json.data;
}

export interface StreamCallbacks {
  onTextDelta(text: string): void;
  onToolCall?(toolName: string, args?: Record<string, unknown>): void;
  onToolResult?(toolName: string, result: unknown): void;
  onError?(errorText: string): void;
}

interface StreamPart {
  type: string;
  textDelta?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  errorText?: string;
}

export async function streamChat(
  sessionId: string,
  message: string,
  callbacks: StreamCallbacks
): Promise<void> {
  const apiUrl = getApiUrl();
  const token = getToken();

  const messageId = crypto.randomUUID();

  const res = await fetch(`${apiUrl}/chat/sessions/${sessionId}/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-request-id": getTraceId(),
      "x-datadog-trace-id": getTraceId(),
    },
    body: JSON.stringify({
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: message }],
    }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new CliError(CliErrorCode.AUTH_FAILED, authFailedMessage("Authentication failed."));
    }
    throw new CliError(CliErrorCode.API_ERROR, `Stream error: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  const toolCallMap = new Map<string, string>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const part = JSON.parse(payload) as StreamPart;
          handleStreamPart(part, callbacks, toolCallMap);
        } catch {
          // Skip malformed lines
        }
        continue;
      }
      if (line.startsWith("0:")) {
        try {
          const text = JSON.parse(line.slice(2)) as unknown;
          if (typeof text === "string") {
            callbacks.onTextDelta(text);
          }
        } catch {
          // Skip
        }
      }
    }
  }
}

function handleStreamPart(
  part: StreamPart,
  callbacks: StreamCallbacks,
  toolCallMap: Map<string, string>
): void {
  switch (part.type) {
    case "text-delta":
    case "text":
      if (part.textDelta) callbacks.onTextDelta(part.textDelta);
      break;
    case "tool-call":
      if (part.toolCallId && part.toolName) toolCallMap.set(part.toolCallId, part.toolName);
      callbacks.onToolCall?.(part.toolName ?? "unknown", part.args);
      break;
    case "tool-result":
      if (part.toolCallId) {
        const toolName = toolCallMap.get(part.toolCallId) ?? "unknown";
        callbacks.onToolResult?.(toolName, part.result);
      }
      break;
    case "error":
      callbacks.onError?.(part.errorText ?? "Unknown error");
      break;
    default:
      break;
  }
}
