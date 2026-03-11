import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { actor, queue } from "rivetkit";
import { Loop, workflow } from "rivetkit/workflow";
import type { ProviderId } from "@sandbox-agent/foundry-shared";
import type {
  ProcessCreateRequest,
  ProcessInfo,
  ProcessLogFollowQuery,
  ProcessLogsResponse,
  ProcessSignalQuery,
  SessionEvent,
  SessionRecord,
} from "sandbox-agent";
import { sandboxInstanceDb } from "./db/db.js";
import { sandboxInstance as sandboxInstanceTable } from "./db/schema.js";
import { SandboxInstancePersistDriver } from "./persist.js";
import { getActorRuntimeContext } from "../context.js";
import { selfSandboxInstance } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { expectQueueResponse } from "../../services/queue.js";

export interface SandboxInstanceInput {
  workspaceId: string;
  providerId: ProviderId;
  sandboxId: string;
}

interface SandboxAgentConnection {
  endpoint: string;
  token?: string;
}

const SANDBOX_ROW_ID = 1;
const CREATE_SESSION_MAX_ATTEMPTS = 3;
const CREATE_SESSION_RETRY_BASE_MS = 1_000;
const CREATE_SESSION_STEP_TIMEOUT_MS = 10 * 60_000;

function normalizeStatusFromEventPayload(payload: unknown): "running" | "idle" | "error" | null {
  if (payload && typeof payload === "object") {
    const envelope = payload as {
      error?: unknown;
      method?: unknown;
      result?: unknown;
    };

    if (envelope.error) {
      return "error";
    }

    if (envelope.result && typeof envelope.result === "object") {
      const stopReason = (envelope.result as { stopReason?: unknown }).stopReason;
      if (typeof stopReason === "string" && stopReason.length > 0) {
        return "idle";
      }
    }

    if (typeof envelope.method === "string") {
      const lowered = envelope.method.toLowerCase();
      if (lowered.includes("error") || lowered.includes("failed")) {
        return "error";
      }
      if (lowered.includes("ended") || lowered.includes("complete") || lowered.includes("stopped")) {
        return "idle";
      }
    }
  }

  return null;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    return item;
  });
}

function parseMetadata(metadataJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

async function loadPersistedAgentConfig(c: any): Promise<SandboxAgentConnection | null> {
  try {
    const row = await c.db
      .select({ metadataJson: sandboxInstanceTable.metadataJson })
      .from(sandboxInstanceTable)
      .where(eq(sandboxInstanceTable.id, SANDBOX_ROW_ID))
      .get();

    if (row?.metadataJson) {
      const metadata = parseMetadata(row.metadataJson);
      const endpoint = typeof metadata.agentEndpoint === "string" ? metadata.agentEndpoint.trim() : "";
      const token = typeof metadata.agentToken === "string" ? metadata.agentToken.trim() : "";
      if (endpoint) {
        return token ? { endpoint, token } : { endpoint };
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function loadFreshDaytonaAgentConfig(c: any): Promise<SandboxAgentConnection> {
  const { config, driver } = getActorRuntimeContext();
  const daytona = driver.daytona.createClient({
    apiUrl: config.providers.daytona.endpoint,
    apiKey: config.providers.daytona.apiKey,
  });
  const sandbox = await daytona.getSandbox(c.state.sandboxId);
  const state = String(sandbox.state ?? "unknown").toLowerCase();
  if (state !== "started" && state !== "running") {
    await daytona.startSandbox(c.state.sandboxId, 60);
  }
  const preview = await daytona.getPreviewEndpoint(c.state.sandboxId, 2468);
  return preview.token ? { endpoint: preview.url, token: preview.token } : { endpoint: preview.url };
}

async function loadFreshProviderAgentConfig(c: any): Promise<SandboxAgentConnection> {
  const { providers } = getActorRuntimeContext();
  const provider = providers.get(c.state.providerId);
  return await provider.ensureSandboxAgent({
    workspaceId: c.state.workspaceId,
    sandboxId: c.state.sandboxId,
  });
}

async function loadAgentConfig(c: any): Promise<SandboxAgentConnection> {
  const persisted = await loadPersistedAgentConfig(c);
  if (c.state.providerId === "daytona") {
    // Keep one stable signed preview endpoint per sandbox-instance actor.
    // Rotating preview URLs on every call fragments SDK client state (sessions/events)
    // because client caching keys by endpoint.
    if (persisted) {
      return persisted;
    }
    return await loadFreshDaytonaAgentConfig(c);
  }

  // Local sandboxes are tied to the current backend process, so the sandbox-agent
  // token can rotate on restart. Always refresh from the provider instead of
  // trusting persisted metadata.
  if (c.state.providerId === "local") {
    return await loadFreshProviderAgentConfig(c);
  }

  if (persisted) {
    return persisted;
  }

  return await loadFreshProviderAgentConfig(c);
}

async function derivePersistedSessionStatus(
  persist: SandboxInstancePersistDriver,
  sessionId: string,
): Promise<{ id: string; status: "running" | "idle" | "error" }> {
  const session = await persist.getSession(sessionId);
  if (!session) {
    return { id: sessionId, status: "error" };
  }

  if (session.destroyedAt) {
    return { id: sessionId, status: "idle" };
  }

  const events = await persist.listEvents({
    sessionId,
    limit: 25,
  });

  for (let index = events.items.length - 1; index >= 0; index -= 1) {
    const event = events.items[index];
    if (!event) continue;
    const status = normalizeStatusFromEventPayload(event.payload);
    if (status) {
      return { id: sessionId, status };
    }
  }

  return { id: sessionId, status: "idle" };
}

function isTransientSessionCreateError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  if (lowered.includes("timed out") || lowered.includes("timeout") || lowered.includes("504") || lowered.includes("gateway timeout")) {
    // ACP timeout errors are expensive and usually deterministic for the same
    // request; immediate retries spawn additional sessions/processes and make
    // recovery harder.
    return false;
  }

  return (
    lowered.includes("502") || lowered.includes("503") || lowered.includes("bad gateway") || lowered.includes("econnreset") || lowered.includes("econnrefused")
  );
}

interface EnsureSandboxCommand {
  metadata: Record<string, unknown>;
  status: string;
  agentEndpoint?: string;
  agentToken?: string;
}

interface HealthSandboxCommand {
  status: string;
  message: string;
}

interface CreateSessionCommand {
  prompt: string;
  cwd?: string;
  agent?: "claude" | "codex" | "opencode";
}

interface CreateSessionResult {
  id: string | null;
  status: "running" | "idle" | "error";
  error?: string;
}

interface ListSessionsCommand {
  cursor?: string;
  limit?: number;
}

interface ListSessionEventsCommand {
  sessionId: string;
  cursor?: string;
  limit?: number;
}

interface SendPromptCommand {
  sessionId: string;
  prompt: string;
  notification?: boolean;
}

interface SessionStatusCommand {
  sessionId: string;
}

interface SessionControlCommand {
  sessionId: string;
}

const SANDBOX_INSTANCE_QUEUE_NAMES = [
  "sandboxInstance.command.ensure",
  "sandboxInstance.command.updateHealth",
  "sandboxInstance.command.destroy",
  "sandboxInstance.command.createSession",
  "sandboxInstance.command.sendPrompt",
  "sandboxInstance.command.cancelSession",
  "sandboxInstance.command.destroySession",
] as const;

type SandboxInstanceQueueName = (typeof SANDBOX_INSTANCE_QUEUE_NAMES)[number];

function sandboxInstanceWorkflowQueueName(name: SandboxInstanceQueueName): SandboxInstanceQueueName {
  return name;
}

async function getSandboxAgentClient(c: any) {
  const { driver } = getActorRuntimeContext();
  const persist = new SandboxInstancePersistDriver(c.db);
  const { endpoint, token } = await loadAgentConfig(c);
  return driver.sandboxAgent.createClient({
    endpoint,
    token,
    persist,
  });
}

function broadcastProcessesUpdated(c: any): void {
  c.broadcast("processesUpdated", {
    sandboxId: c.state.sandboxId,
    at: Date.now(),
  });
}

async function ensureSandboxMutation(c: any, command: EnsureSandboxCommand): Promise<void> {
  const now = Date.now();
  const metadata = {
    ...command.metadata,
    agentEndpoint: command.agentEndpoint ?? null,
    agentToken: command.agentToken ?? null,
  };

  const metadataJson = stringifyJson(metadata);
  await c.db
    .insert(sandboxInstanceTable)
    .values({
      id: SANDBOX_ROW_ID,
      metadataJson,
      status: command.status,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sandboxInstanceTable.id,
      set: {
        metadataJson,
        status: command.status,
        updatedAt: now,
      },
    })
    .run();
}

async function updateHealthMutation(c: any, command: HealthSandboxCommand): Promise<void> {
  await c.db
    .update(sandboxInstanceTable)
    .set({
      status: `${command.status}:${command.message}`,
      updatedAt: Date.now(),
    })
    .where(eq(sandboxInstanceTable.id, SANDBOX_ROW_ID))
    .run();
}

async function destroySandboxMutation(c: any): Promise<void> {
  await c.db.delete(sandboxInstanceTable).where(eq(sandboxInstanceTable.id, SANDBOX_ROW_ID)).run();
}

async function createSessionMutation(c: any, command: CreateSessionCommand): Promise<CreateSessionResult> {
  let lastDetail = "sandbox-agent createSession failed";
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= CREATE_SESSION_MAX_ATTEMPTS; attempt += 1) {
    attemptsMade = attempt;
    try {
      const client = await getSandboxAgentClient(c);

      const session = await client.createSession({
        prompt: command.prompt,
        cwd: command.cwd,
        agent: command.agent,
      });

      return { id: session.id, status: session.status };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lastDetail = detail;
      const retryable = isTransientSessionCreateError(detail);
      const canRetry = retryable && attempt < CREATE_SESSION_MAX_ATTEMPTS;

      if (!canRetry) {
        break;
      }

      const waitMs = CREATE_SESSION_RETRY_BASE_MS * attempt;
      logActorWarning("sandbox-instance", "createSession transient failure; retrying", {
        workspaceId: c.state.workspaceId,
        providerId: c.state.providerId,
        sandboxId: c.state.sandboxId,
        attempt,
        maxAttempts: CREATE_SESSION_MAX_ATTEMPTS,
        waitMs,
        error: detail,
      });
      await delay(waitMs);
    }
  }

  const attemptLabel = attemptsMade === 1 ? "attempt" : "attempts";
  return {
    id: null,
    status: "error",
    error: `sandbox-agent createSession failed after ${attemptsMade} ${attemptLabel}: ${lastDetail}`,
  };
}

async function sendPromptMutation(c: any, command: SendPromptCommand): Promise<void> {
  const client = await getSandboxAgentClient(c);
  await client.sendPrompt({
    sessionId: command.sessionId,
    prompt: command.prompt,
    notification: command.notification,
  });
}

async function cancelSessionMutation(c: any, command: SessionControlCommand): Promise<void> {
  const client = await getSandboxAgentClient(c);
  await client.cancelSession(command.sessionId);
}

async function destroySessionMutation(c: any, command: SessionControlCommand): Promise<void> {
  const client = await getSandboxAgentClient(c);
  await client.destroySession(command.sessionId);
}

async function runSandboxInstanceWorkflow(ctx: any): Promise<void> {
  await ctx.loop("sandbox-instance-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-sandbox-instance-command", {
      names: [...SANDBOX_INSTANCE_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.ensure") {
      await loopCtx.step("sandbox-instance-ensure", async () => ensureSandboxMutation(loopCtx, msg.body as EnsureSandboxCommand));
      await msg.complete({ ok: true });
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.updateHealth") {
      await loopCtx.step("sandbox-instance-update-health", async () => updateHealthMutation(loopCtx, msg.body as HealthSandboxCommand));
      await msg.complete({ ok: true });
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.destroy") {
      await loopCtx.step("sandbox-instance-destroy", async () => destroySandboxMutation(loopCtx));
      await msg.complete({ ok: true });
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.createSession") {
      const result = await loopCtx.step({
        name: "sandbox-instance-create-session",
        timeout: CREATE_SESSION_STEP_TIMEOUT_MS,
        run: async () => createSessionMutation(loopCtx, msg.body as CreateSessionCommand),
      });
      await msg.complete(result);
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.sendPrompt") {
      await loopCtx.step("sandbox-instance-send-prompt", async () => sendPromptMutation(loopCtx, msg.body as SendPromptCommand));
      await msg.complete({ ok: true });
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.cancelSession") {
      await loopCtx.step("sandbox-instance-cancel-session", async () => cancelSessionMutation(loopCtx, msg.body as SessionControlCommand));
      await msg.complete({ ok: true });
      return Loop.continue(undefined);
    }

    if (msg.name === "sandboxInstance.command.destroySession") {
      await loopCtx.step("sandbox-instance-destroy-session", async () => destroySessionMutation(loopCtx, msg.body as SessionControlCommand));
      await msg.complete({ ok: true });
    }

    return Loop.continue(undefined);
  });
}

export const sandboxInstance = actor({
  db: sandboxInstanceDb,
  queues: Object.fromEntries(SANDBOX_INSTANCE_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: SandboxInstanceInput) => ({
    workspaceId: input.workspaceId,
    providerId: input.providerId,
    sandboxId: input.sandboxId,
  }),
  actions: {
    async sandboxAgentConnection(c: any): Promise<SandboxAgentConnection> {
      return await loadAgentConfig(c);
    },

    async createProcess(c: any, request: ProcessCreateRequest): Promise<ProcessInfo> {
      const client = await getSandboxAgentClient(c);
      const created = await client.createProcess(request);
      broadcastProcessesUpdated(c);
      return created;
    },

    async listProcesses(c: any): Promise<{ processes: ProcessInfo[] }> {
      const client = await getSandboxAgentClient(c);
      return await client.listProcesses();
    },

    async getProcessLogs(c: any, request: { processId: string; query?: ProcessLogFollowQuery }): Promise<ProcessLogsResponse> {
      const client = await getSandboxAgentClient(c);
      return await client.getProcessLogs(request.processId, request.query);
    },

    async stopProcess(c: any, request: { processId: string; query?: ProcessSignalQuery }): Promise<ProcessInfo> {
      const client = await getSandboxAgentClient(c);
      const stopped = await client.stopProcess(request.processId, request.query);
      broadcastProcessesUpdated(c);
      return stopped;
    },

    async killProcess(c: any, request: { processId: string; query?: ProcessSignalQuery }): Promise<ProcessInfo> {
      const client = await getSandboxAgentClient(c);
      const killed = await client.killProcess(request.processId, request.query);
      broadcastProcessesUpdated(c);
      return killed;
    },

    async deleteProcess(c: any, request: { processId: string }): Promise<void> {
      const client = await getSandboxAgentClient(c);
      await client.deleteProcess(request.processId);
      broadcastProcessesUpdated(c);
    },

    async providerState(c: any): Promise<{ providerId: ProviderId; sandboxId: string; state: string; at: number }> {
      const at = Date.now();
      const { config, driver } = getActorRuntimeContext();

      if (c.state.providerId === "daytona") {
        const daytona = driver.daytona.createClient({
          apiUrl: config.providers.daytona.endpoint,
          apiKey: config.providers.daytona.apiKey,
        });
        const sandbox = await daytona.getSandbox(c.state.sandboxId);
        const state = String(sandbox.state ?? "unknown").toLowerCase();
        return { providerId: c.state.providerId, sandboxId: c.state.sandboxId, state, at };
      }

      return {
        providerId: c.state.providerId,
        sandboxId: c.state.sandboxId,
        state: "unknown",
        at,
      };
    },

    async ensure(c, command: EnsureSandboxCommand): Promise<void> {
      const self = selfSandboxInstance(c);
      await self.send(sandboxInstanceWorkflowQueueName("sandboxInstance.command.ensure"), command, {
        wait: true,
        timeout: 60_000,
      });
    },

    async updateHealth(c, command: HealthSandboxCommand): Promise<void> {
      const self = selfSandboxInstance(c);
      await self.send(sandboxInstanceWorkflowQueueName("sandboxInstance.command.updateHealth"), command, {
        wait: true,
        timeout: 60_000,
      });
    },

    async destroy(c): Promise<void> {
      const self = selfSandboxInstance(c);
      await self.send(
        sandboxInstanceWorkflowQueueName("sandboxInstance.command.destroy"),
        {},
        {
          wait: true,
          timeout: 60_000,
        },
      );
    },

    async createSession(c: any, command: CreateSessionCommand): Promise<CreateSessionResult> {
      const self = selfSandboxInstance(c);
      return expectQueueResponse<CreateSessionResult>(
        await self.send(sandboxInstanceWorkflowQueueName("sandboxInstance.command.createSession"), command, {
          wait: true,
          timeout: 5 * 60_000,
        }),
      );
    },

    async listSessions(c: any, command?: ListSessionsCommand): Promise<{ items: SessionRecord[]; nextCursor?: string }> {
      const persist = new SandboxInstancePersistDriver(c.db);
      try {
        const client = await getSandboxAgentClient(c);

        const page = await client.listSessions({
          cursor: command?.cursor,
          limit: command?.limit,
        });

        return {
          items: page.items,
          nextCursor: page.nextCursor,
        };
      } catch (error) {
        logActorWarning("sandbox-instance", "listSessions remote read failed; using persisted fallback", {
          workspaceId: c.state.workspaceId,
          providerId: c.state.providerId,
          sandboxId: c.state.sandboxId,
          error: resolveErrorMessage(error),
        });
        return await persist.listSessions({
          cursor: command?.cursor,
          limit: command?.limit,
        });
      }
    },

    async listSessionEvents(c: any, command: ListSessionEventsCommand): Promise<{ items: SessionEvent[]; nextCursor?: string }> {
      const persist = new SandboxInstancePersistDriver(c.db);
      return await persist.listEvents({
        sessionId: command.sessionId,
        cursor: command.cursor,
        limit: command.limit,
      });
    },

    async sendPrompt(c, command: SendPromptCommand): Promise<void> {
      const self = selfSandboxInstance(c);
      await self.send(sandboxInstanceWorkflowQueueName("sandboxInstance.command.sendPrompt"), command, {
        wait: true,
        timeout: 5 * 60_000,
      });
    },

    async cancelSession(c, command: SessionControlCommand): Promise<void> {
      const self = selfSandboxInstance(c);
      await self.send(sandboxInstanceWorkflowQueueName("sandboxInstance.command.cancelSession"), command, {
        wait: true,
        timeout: 60_000,
      });
    },

    async destroySession(c, command: SessionControlCommand): Promise<void> {
      const self = selfSandboxInstance(c);
      await self.send(sandboxInstanceWorkflowQueueName("sandboxInstance.command.destroySession"), command, {
        wait: true,
        timeout: 60_000,
      });
    },

    async sessionStatus(c, command: SessionStatusCommand): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      return await derivePersistedSessionStatus(new SandboxInstancePersistDriver(c.db), command.sessionId);
    },
  },
  run: workflow(runSandboxInstanceWorkflow),
});
