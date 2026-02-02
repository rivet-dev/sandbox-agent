import { createInterface, Interface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxAgent } from "sandbox-agent";
import type { PermissionReply, PermissionEventData, QuestionEventData } from "sandbox-agent";

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

export function buildInspectorUrl({
  baseUrl,
  token,
  headers,
}: {
  baseUrl: string;
  token?: string;
  headers?: Record<string, string>;
}): string {
  const normalized = normalizeBaseUrl(ensureUrl(baseUrl));
  const params = new URLSearchParams();
  if (token) {
    params.set("token", token);
  }
  if (headers && Object.keys(headers).length > 0) {
    params.set("headers", JSON.stringify(headers));
  }
  const queryString = params.toString();
  return `${normalized}/ui/${queryString ? `?${queryString}` : ""}`;
}

export function logInspectorUrl({
  baseUrl,
  token,
  headers,
}: {
  baseUrl: string;
  token?: string;
  headers?: Record<string, string>;
}): void {
  console.log(`Inspector: ${buildInspectorUrl({ baseUrl, token, headers })}`);
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
    agent: agentId || detectAgent(),
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

export async function sendMessageStream({
  baseUrl,
  token,
  extraHeaders,
  sessionId,
  message,
  onText,
}: {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  sessionId: string;
  message: string;
  onText?: (text: string) => void;
}): Promise<string> {
  const normalized = normalizeBaseUrl(baseUrl);
  const headers = buildHeaders({ token, extraHeaders, contentType: true });

  const response = await fetch(`${normalized}/v1/sessions/${sessionId}/messages/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);

        // Handle text deltas (delta can be a string or an object with type: "text")
        if (event.type === "item.delta" && event.data?.delta) {
          const delta = event.data.delta;
          const text = typeof delta === "string" ? delta : delta.type === "text" ? delta.text || "" : "";
          if (text) {
            fullText += text;
            onText?.(text);
          }
        }

        // Handle completed assistant message
        if (
          event.type === "item.completed" &&
          event.data?.item?.kind === "message" &&
          event.data?.item?.role === "assistant"
        ) {
          const itemText = extractTextFromItem(event.data.item);
          if (itemText && !fullText) {
            fullText = itemText;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return fullText;
}

function detectAgent(): string {
  // Prefer explicit setting
  if (process.env.SANDBOX_AGENT) return process.env.SANDBOX_AGENT;
  // Select based on available API key
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.OPENAI_API_KEY) return "codex";
  return "claude";
}

export type PermissionHandler = (
  data: PermissionEventData
) => Promise<PermissionReply> | PermissionReply;

export type QuestionHandler = (
  data: QuestionEventData
) => Promise<string[][] | null> | string[][] | null;

export interface RunPromptOptions {
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  agentId?: string;
  agentMode?: string;
  permissionMode?: string;
  model?: string;
  /** Auto-approve all permissions with "once" (default: false, prompts interactively) */
  autoApprovePermissions?: boolean;
  /** Custom permission handler (overrides autoApprovePermissions) */
  onPermission?: PermissionHandler;
  /** Custom question handler (return null to reject) */
  onQuestion?: QuestionHandler;
}

async function promptForPermission(
  rl: Interface,
  data: PermissionEventData
): Promise<PermissionReply> {
  console.log(`\n[Permission Required] ${data.action}`);
  if (data.metadata) {
    console.log(`  Details: ${JSON.stringify(data.metadata, null, 2)}`);
  }
  while (true) {
    const answer = await rl.question("  Allow? [y]es / [n]o / [a]lways: ");
    const lower = answer.trim().toLowerCase();
    if (lower === "y" || lower === "yes") return "once";
    if (lower === "a" || lower === "always") return "always";
    if (lower === "n" || lower === "no") return "reject";
    console.log("  Please enter y, n, or a");
  }
}

async function promptForQuestion(
  rl: Interface,
  data: QuestionEventData
): Promise<string[][] | null> {
  console.log(`\n[Question] ${data.prompt}`);
  if (data.options.length > 0) {
    console.log("  Options:");
    data.options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt}`));
    const answer = await rl.question("  Enter option number (or 'skip' to reject): ");
    if (answer.trim().toLowerCase() === "skip") return null;
    const idx = parseInt(answer.trim(), 10) - 1;
    if (idx >= 0 && idx < data.options.length) {
      return [[data.options[idx]]];
    }
    console.log("  Invalid option, rejecting question");
    return null;
  }
  const answer = await rl.question("  Your answer (or 'skip' to reject): ");
  if (answer.trim().toLowerCase() === "skip") return null;
  return [[answer.trim()]];
}

export async function runPrompt(options: RunPromptOptions): Promise<void> {
  const {
    baseUrl,
    token,
    extraHeaders,
    agentId,
    agentMode,
    permissionMode,
    model,
    autoApprovePermissions = false,
    onPermission,
    onQuestion,
  } = options;

  const client = await SandboxAgent.connect({
    baseUrl,
    token,
    headers: extraHeaders,
  });

  const agent = agentId || detectAgent();
  console.log(`Using agent: ${agent}`);
  const sessionId = randomUUID();
  await client.createSession(sessionId, {
    agent,
    agentMode,
    permissionMode,
    model,
  });
  console.log(`Session ${sessionId}. Press Ctrl+C to quit.`);

  // Create readline interface for interactive prompts
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let isThinking = false;
  let hasStartedOutput = false;
  let turnResolve: (() => void) | null = null;
  let sessionEnded = false;

  // Handle permission request
  const handlePermission = async (data: PermissionEventData): Promise<void> => {
    try {
      let reply: PermissionReply;
      if (onPermission) {
        reply = await onPermission(data);
      } else if (autoApprovePermissions) {
        console.log(`\n[Auto-approved] ${data.action}`);
        reply = "once";
      } else {
        reply = await promptForPermission(rl, data);
      }
      await client.replyPermission(sessionId, data.permission_id, { reply });
    } catch (err) {
      console.error("Failed to reply to permission:", err instanceof Error ? err.message : err);
    }
  };

  // Handle question request
  const handleQuestion = async (data: QuestionEventData): Promise<void> => {
    try {
      let answers: string[][] | null;
      if (onQuestion) {
        answers = await onQuestion(data);
      } else {
        answers = await promptForQuestion(rl, data);
      }
      if (answers === null) {
        await client.rejectQuestion(sessionId, data.question_id);
      } else {
        await client.replyQuestion(sessionId, data.question_id, { answers });
      }
    } catch (err) {
      console.error("Failed to reply to question:", err instanceof Error ? err.message : err);
    }
  };

  // Stream events in background using SDK
  const processEvents = async () => {
    for await (const event of client.streamEvents(sessionId)) {
      // Show thinking indicator when assistant starts
      if (event.type === "item.started") {
        const item = (event.data as any)?.item;
        if (item?.role === "assistant") {
          isThinking = true;
          hasStartedOutput = false;
          process.stdout.write("Thinking...");
        }
      }

      // Print text deltas (only during assistant turn)
      if (event.type === "item.delta" && isThinking) {
        const delta = (event.data as any)?.delta;
        if (delta) {
          if (!hasStartedOutput) {
            process.stdout.write("\r\x1b[K"); // Clear line
            hasStartedOutput = true;
          }
          const text = typeof delta === "string" ? delta : delta.type === "text" ? delta.text || "" : "";
          if (text) process.stdout.write(text);
        }
      }

      // Signal turn complete
      if (event.type === "item.completed") {
        const item = (event.data as any)?.item;
        if (item?.role === "assistant") {
          isThinking = false;
          process.stdout.write("\n");
          turnResolve?.();
          turnResolve = null;
        }
      }

      // Handle permission requests
      if (event.type === "permission.requested") {
        const data = event.data as PermissionEventData;
        // Clear thinking indicator if shown
        if (isThinking && !hasStartedOutput) {
          process.stdout.write("\r\x1b[K");
        }
        await handlePermission(data);
      }

      // Handle question requests
      if (event.type === "question.requested") {
        const data = event.data as QuestionEventData;
        // Clear thinking indicator if shown
        if (isThinking && !hasStartedOutput) {
          process.stdout.write("\r\x1b[K");
        }
        await handleQuestion(data);
      }

      // Handle errors
      if (event.type === "error") {
        const data = event.data as any;
        console.error(`\nError: ${data?.message || JSON.stringify(data)}`);
      }

      // Handle session ended
      if (event.type === "session.ended") {
        const data = event.data as any;
        const reason = data?.reason || "unknown";
        const exitCode = data?.exit_code;
        const message = data?.message;
        const stderr = data?.stderr;

        if (reason === "error") {
          console.error(`\nAgent exited with error:`);
          if (exitCode !== undefined) {
            console.error(`  Exit code: ${exitCode}`);
          }
          if (message) {
            console.error(`  Message: ${message}`);
          }
          if (stderr) {
            console.error(`\n--- Agent Stderr ---`);
            if (stderr.head) {
              console.error(stderr.head);
            }
            if (stderr.truncated && stderr.tail) {
              const omitted = stderr.total_lines
                ? stderr.total_lines - 70 // 20 head + 50 tail
                : "...";
              console.error(`\n... ${omitted} lines omitted ...\n`);
              console.error(stderr.tail);
            }
            console.error(`--- End Stderr ---`);
          }
        } else {
          console.log(`Agent session ${reason}`);
        }
        sessionEnded = true;
        turnResolve?.();
        turnResolve = null;
      }
    }
  };
  processEvents().catch((err) => {
    if (!sessionEnded) {
      console.error("Event stream error:", err instanceof Error ? err.message : err);
    }
  });

  // Read user input and post messages
  while (true) {
    const line = await rl.question("> ");
    if (!line.trim()) continue;

    const turnComplete = new Promise<void>((resolve) => {
      turnResolve = resolve;
    });

    try {
      await client.postMessage(sessionId, { message: line.trim() });
      await turnComplete;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      turnResolve = null;
    }
  }
}
