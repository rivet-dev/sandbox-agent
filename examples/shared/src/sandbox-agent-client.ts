/**
 * Simple shared utilities for sandbox-agent examples.
 * Provides minimal helpers for connecting to and interacting with sandbox-agent servers.
 */

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxAgent } from "sandbox-agent";
import type { PermissionEventData, QuestionEventData } from "sandbox-agent";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function ensureUrl(rawUrl: string): string {
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

export function buildHeaders({
  token,
  extraHeaders,
  contentType = false,
}: {
  token?: string;
  extraHeaders?: Record<string, string>;
  contentType?: boolean;
}): HeadersInit {
  const headers: Record<string, string> = { ...(extraHeaders || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (contentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
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
      const headers = buildHeaders({ token, extraHeaders });
      const response = await fetch(`${normalized}/v1/health`, { headers });
      if (response.ok) {
        const data = await response.json();
        if (data?.status === "ok") {
          return;
        }
        lastError = new Error(`Unexpected health response: ${JSON.stringify(data)}`);
      } else {
        lastError = new Error(`Health check failed: ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw (lastError ?? new Error("Timed out waiting for /v1/health")) as Error;
}

function detectAgent(): string {
  if (process.env.SANDBOX_AGENT) return process.env.SANDBOX_AGENT;
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.OPENAI_API_KEY) return "codex";
  return "claude";
}

export async function runPrompt(baseUrl: string): Promise<void> {
  console.log(`UI: ${buildInspectorUrl({ baseUrl })}`);

  const client = await SandboxAgent.connect({ baseUrl });

  const agent = detectAgent();
  console.log(`Using agent: ${agent}`);
  const sessionId = randomUUID();
  await client.createSession(sessionId, { agent });
  console.log(`Session ${sessionId}. Press Ctrl+C to quit.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let isThinking = false;
  let hasStartedOutput = false;
  let turnResolve: (() => void) | null = null;
  let sessionEnded = false;

  const processEvents = async () => {
    for await (const event of client.streamEvents(sessionId)) {
      if (event.type === "item.started") {
        const item = (event.data as any)?.item;
        if (item?.role === "assistant") {
          isThinking = true;
          hasStartedOutput = false;
          process.stdout.write("Thinking...");
        }
      }

      if (event.type === "item.delta" && isThinking) {
        const delta = (event.data as any)?.delta;
        if (delta) {
          if (!hasStartedOutput) {
            process.stdout.write("\r\x1b[K");
            hasStartedOutput = true;
          }
          const text = typeof delta === "string" ? delta : delta.type === "text" ? delta.text || "" : "";
          if (text) process.stdout.write(text);
        }
      }

      if (event.type === "item.completed") {
        const item = (event.data as any)?.item;
        if (item?.role === "assistant") {
          isThinking = false;
          process.stdout.write("\n");
          turnResolve?.();
          turnResolve = null;
        }
      }

      if (event.type === "permission.requested") {
        const data = event.data as PermissionEventData;
        if (isThinking && !hasStartedOutput) {
          process.stdout.write("\r\x1b[K");
        }
        console.log(`[Auto-approved] ${data.action}`);
        await client.replyPermission(sessionId, data.permission_id, { reply: "once" });
      }

      if (event.type === "question.requested") {
        const data = event.data as QuestionEventData;
        if (isThinking && !hasStartedOutput) {
          process.stdout.write("\r\x1b[K");
        }
        console.log(`[Question rejected] ${data.prompt}`);
        await client.rejectQuestion(sessionId, data.question_id);
      }

      if (event.type === "error") {
        const data = event.data as any;
        console.error(`\nError: ${data?.message || JSON.stringify(data)}`);
      }

      if (event.type === "session.ended") {
        const data = event.data as any;
        const reason = data?.reason || "unknown";
        if (reason === "error") {
          console.error(`\nAgent exited with error: ${data?.message || ""}`);
          if (data?.exit_code !== undefined) {
            console.error(`  Exit code: ${data.exit_code}`);
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
