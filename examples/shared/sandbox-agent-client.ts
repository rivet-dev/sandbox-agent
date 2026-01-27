import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function ensureUrl(rawUrl: string): string {
  if (!rawUrl) {
    throw new Error("Missing sandbox URL");
  }
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  return `https://${rawUrl}`;
}

type HeaderOptions = {
  token?: string;
  extraHeaders?: Record<string, string>;
  contentType?: boolean;
};

export function buildHeaders({ token, extraHeaders, contentType = false }: HeaderOptions): HeadersInit {
  const headers: Record<string, string> = {
    ...(extraHeaders || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (contentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function fetchJson(
  url: string,
  {
    token,
    extraHeaders,
    method = "GET",
    body,
  }: {
    token?: string;
    extraHeaders?: Record<string, string>;
    method?: string;
    body?: unknown;
  } = {}
): Promise<any> {
  const headers = buildHeaders({
    token,
    extraHeaders,
    contentType: body !== undefined,
  });
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function waitForHealth({
  baseUrl,
  token,
  extraHeaders,
  timeoutMs = 120_000,
}: {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const data = await fetchJson(`${normalized}/v1/health`, { token, extraHeaders });
      if (data?.status === "ok") {
        return;
      }
      lastError = new Error(`Unexpected health response: ${JSON.stringify(data)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw (lastError ?? new Error("Timed out waiting for /v1/health")) as Error;
}

export async function createSession({
  baseUrl,
  token,
  extraHeaders,
  agentId,
  agentMode,
  permissionMode,
  model,
  variant,
  agentVersion,
}: {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  agentId?: string;
  agentMode?: string;
  permissionMode?: string;
  model?: string;
  variant?: string;
  agentVersion?: string;
}): Promise<string> {
  const normalized = normalizeBaseUrl(baseUrl);
  const sessionId = randomUUID();
  const body: Record<string, string> = {
    agent: agentId || process.env.SANDBOX_AGENT || "codex",
  };
  const envAgentMode = agentMode || process.env.SANDBOX_AGENT_MODE;
  const envPermissionMode = permissionMode || process.env.SANDBOX_PERMISSION_MODE;
  const envModel = model || process.env.SANDBOX_MODEL;
  const envVariant = variant || process.env.SANDBOX_VARIANT;
  const envAgentVersion = agentVersion || process.env.SANDBOX_AGENT_VERSION;

  if (envAgentMode) body.agentMode = envAgentMode;
  if (envPermissionMode) body.permissionMode = envPermissionMode;
  if (envModel) body.model = envModel;
  if (envVariant) body.variant = envVariant;
  if (envAgentVersion) body.agentVersion = envAgentVersion;

  await fetchJson(`${normalized}/v1/sessions/${sessionId}`, {
    token,
    extraHeaders,
    method: "POST",
    body,
  });
  return sessionId;
}

export async function sendMessage({
  baseUrl,
  token,
  extraHeaders,
  sessionId,
  message,
}: {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  sessionId: string;
  message: string;
}): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl);
  await fetchJson(`${normalized}/v1/sessions/${sessionId}/messages`, {
    token,
    extraHeaders,
    method: "POST",
    body: { message },
  });
}

function extractTextFromItem(item: any): string {
  if (!item?.content) return "";
  const textParts = item.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text || "")
    .join("");
  if (textParts.trim()) {
    return textParts;
  }
  return JSON.stringify(item.content, null, 2);
}

export async function waitForAssistantComplete({
  baseUrl,
  token,
  extraHeaders,
  sessionId,
  offset = 0,
  timeoutMs = 120_000,
}: {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  sessionId: string;
  offset?: number;
  timeoutMs?: number;
}): Promise<{ text: string; offset: number }> {
  const normalized = normalizeBaseUrl(baseUrl);
  const deadline = Date.now() + timeoutMs;
  let currentOffset = offset;

  while (Date.now() < deadline) {
    const data = await fetchJson(
      `${normalized}/v1/sessions/${sessionId}/events?offset=${currentOffset}&limit=100`,
      { token, extraHeaders }
    );

    for (const event of data.events || []) {
      if (typeof event.sequence === "number") {
        currentOffset = Math.max(currentOffset, event.sequence);
      }
      if (
        event.type === "item.completed" &&
        event.data?.item?.kind === "message" &&
        event.data?.item?.role === "assistant"
      ) {
        return {
          text: extractTextFromItem(event.data.item),
          offset: currentOffset,
        };
      }
    }

    if (!data.hasMore) {
      await delay(300);
    }
  }

  throw new Error("Timed out waiting for assistant response");
}

export async function runPrompt({
  baseUrl,
  token,
  extraHeaders,
  agentId,
}: {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  agentId?: string;
}): Promise<void> {
  const sessionId = await createSession({ baseUrl, token, extraHeaders, agentId });
  let offset = 0;

  console.log(`Session ${sessionId} ready. Type /exit to quit.`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed === "/exit") {
      rl.close();
      return;
    }

    try {
      await sendMessage({ baseUrl, token, extraHeaders, sessionId, message: trimmed });
      const result = await waitForAssistantComplete({
        baseUrl,
        token,
        extraHeaders,
        sessionId,
        offset,
      });
      offset = result.offset;
      process.stdout.write(`${result.text}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }

    rl.prompt();
  };

  rl.on("line", (line) => {
    void handleLine(line);
  });

  rl.on("close", () => {
    process.exit(0);
  });

  rl.prompt();
}
