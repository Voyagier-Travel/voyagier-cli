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

export async function streamChat(
  sessionId: string,
  message: string,
  onChunk: (text: string) => void
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
      if (!line.startsWith("0:")) continue;
      // Vercel AI SDK format: 0:"text chunk"
      try {
        const text = JSON.parse(line.slice(2));
        if (typeof text === "string") {
          onChunk(text);
        }
      } catch {
        // Skip non-text parts (tool calls, metadata, etc.)
      }
    }
  }
}
