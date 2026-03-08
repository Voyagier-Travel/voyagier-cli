import { getApiUrl, getToken } from "./config.js";

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function graphql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const apiUrl = getApiUrl();
  const token = getToken();

  const res = await fetch(`${apiUrl}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      console.error("Authentication failed. Your token may be invalid or expired.");
      process.exit(1);
    }
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }
  if (!json.data) {
    throw new Error("No data returned from API");
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
    },
    body: JSON.stringify({
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: message }],
    }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      console.error("Authentication failed.");
      process.exit(1);
    }
    throw new Error(`Stream error: ${res.status} ${res.statusText}`);
  }

  if (!res.body) {
    throw new Error("No response body");
  }

  // Track tool calls to map toolCallId → toolName for result rendering
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
      // UI Message Stream SSE format: "data: <json>" or "data: [DONE]"
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

      // Legacy Vercel AI SDK data stream format: "0:\"text\""
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
      if (part.textDelta) {
        callbacks.onTextDelta(part.textDelta);
      }
      break;

    case "tool-call":
      if (part.toolCallId && part.toolName) {
        toolCallMap.set(part.toolCallId, part.toolName);
      }
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

    // Ignore step boundaries, reasoning, sources, etc.
    default:
      break;
  }
}
