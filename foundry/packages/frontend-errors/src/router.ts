import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import type { FrontendErrorContext, FrontendErrorKind, FrontendErrorLogEvent } from "./types.js";

const DEFAULT_RELATIVE_LOG_PATH = ".foundry/logs/frontend-errors.ndjson";
const DEFAULT_REPORTER = "foundry-frontend";
const MAX_FIELD_LENGTH = 12_000;

export interface FrontendErrorCollectorRouterOptions {
  logFilePath?: string;
  reporter?: string;
}

export function findProjectRoot(startDirectory: string = process.cwd()): string {
  let currentDirectory = resolve(startDirectory);
  while (true) {
    if (existsSync(join(currentDirectory, ".git"))) {
      return currentDirectory;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return resolve(startDirectory);
    }
    currentDirectory = parentDirectory;
  }
}

export function defaultFrontendErrorLogPath(startDirectory: string = process.cwd()): string {
  const root = findProjectRoot(startDirectory);
  return resolve(root, DEFAULT_RELATIVE_LOG_PATH);
}

export function createFrontendErrorCollectorRouter(options: FrontendErrorCollectorRouterOptions = {}): Hono {
  const logFilePath = options.logFilePath ?? defaultFrontendErrorLogPath();
  const reporter = trimText(options.reporter, 128) ?? DEFAULT_REPORTER;
  let ensureLogPathPromise: Promise<void> | null = null;

  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      logFilePath,
      reporter,
    }),
  );

  app.post("/events", async (c) => {
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Expected JSON body" }, 400);
    }

    const inputEvents = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    if (inputEvents.length === 0) {
      return c.json({ ok: false, error: "Expected at least one event" }, 400);
    }

    const receivedAt = Date.now();
    const userAgent = trimText(c.req.header("user-agent"), 512);
    const clientIp = readClientIp(c.req.header("x-forwarded-for"));
    const normalizedEvents: FrontendErrorLogEvent[] = [];

    for (const candidate of inputEvents) {
      if (!isObject(candidate)) {
        continue;
      }
      normalizedEvents.push(
        normalizeEvent({
          candidate,
          reporter,
          userAgent: userAgent ?? null,
          clientIp: clientIp ?? null,
          receivedAt,
        }),
      );
    }

    if (normalizedEvents.length === 0) {
      return c.json({ ok: false, error: "No valid events found in request" }, 400);
    }

    await ensureLogPath();

    const payload = `${normalizedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await appendFile(logFilePath, payload, "utf8");

    return c.json(
      {
        ok: true,
        accepted: normalizedEvents.length,
      },
      202,
    );
  });

  return app;

  async function ensureLogPath(): Promise<void> {
    ensureLogPathPromise ??= mkdir(dirname(logFilePath), { recursive: true }).then(() => undefined);
    await ensureLogPathPromise;
  }
}

interface NormalizeEventInput {
  candidate: Record<string, unknown>;
  reporter: string;
  userAgent: string | null;
  clientIp: string | null;
  receivedAt: number;
}

function normalizeEvent(input: NormalizeEventInput): FrontendErrorLogEvent {
  const kind = normalizeKind(input.candidate.kind);
  return {
    id: createEventId(),
    kind,
    message: trimText(input.candidate.message, MAX_FIELD_LENGTH) ?? "(no message)",
    stack: trimText(input.candidate.stack, MAX_FIELD_LENGTH) ?? null,
    source: trimText(input.candidate.source, 1024) ?? null,
    line: normalizeNumber(input.candidate.line),
    column: normalizeNumber(input.candidate.column),
    url: trimText(input.candidate.url, 2048) ?? null,
    timestamp: normalizeTimestamp(input.candidate.timestamp),
    receivedAt: input.receivedAt,
    userAgent: input.userAgent,
    clientIp: input.clientIp,
    reporter: input.reporter,
    context: normalizeContext(input.candidate.context),
    extra: normalizeExtra(input.candidate.extra),
  };
}

function normalizeKind(value: unknown): FrontendErrorKind {
  switch (value) {
    case "window-error":
    case "resource-error":
    case "unhandled-rejection":
    case "console-error":
    case "fetch-error":
    case "fetch-response-error":
      return value;
    default:
      return "window-error";
  }
}

function normalizeTimestamp(value: unknown): number {
  const parsed = normalizeNumber(value);
  if (parsed === null) {
    return Date.now();
  }
  return parsed;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeContext(value: unknown): FrontendErrorContext {
  if (!isObject(value)) {
    return {};
  }

  const context: FrontendErrorContext = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isAllowedContextValue(candidate)) {
      continue;
    }
    const safeKey = trimText(key, 128);
    if (!safeKey) {
      continue;
    }
    if (typeof candidate === "string") {
      context[safeKey] = trimText(candidate, 1024);
      continue;
    }
    context[safeKey] = candidate;
  }

  return context;
}

function normalizeExtra(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const safeKey = trimText(key, 128);
    if (!safeKey) {
      continue;
    }
    normalized[safeKey] = normalizeUnknown(candidate);
  }
  return normalized;
}

function normalizeUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return trimText(value, 1024) ?? "";
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => normalizeUnknown(item));
  }
  if (isObject(value)) {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, 25);
    for (const [key, candidate] of entries) {
      const safeKey = trimText(key, 128);
      if (!safeKey) {
        continue;
      }
      output[safeKey] = normalizeUnknown(candidate);
    }
    return output;
  }
  return String(value);
}

function trimText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...(truncated)`;
}

function createEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readClientIp(forwardedFor: string | undefined): string | null {
  if (!forwardedFor) {
    return null;
  }
  const [first] = forwardedFor.split(",");
  return trimText(first, 64) ?? null;
}

function isAllowedContextValue(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
