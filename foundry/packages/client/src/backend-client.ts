import { createClient } from "rivetkit/client";
import type {
  AgentType,
  AddRepoInput,
  AppConfig,
  FoundryAppSnapshot,
  FoundryBillingPlanId,
  CreateTaskInput,
  TaskRecord,
  TaskSummary,
  TaskWorkbenchChangeModelInput,
  TaskWorkbenchCreateTaskInput,
  TaskWorkbenchCreateTaskResponse,
  TaskWorkbenchDiffInput,
  TaskWorkbenchRenameInput,
  TaskWorkbenchRenameSessionInput,
  TaskWorkbenchSelectInput,
  TaskWorkbenchSetSessionUnreadInput,
  TaskWorkbenchSendMessageInput,
  TaskWorkbenchSnapshot,
  TaskWorkbenchTabInput,
  TaskWorkbenchUpdateDraftInput,
  HistoryEvent,
  HistoryQueryInput,
  ProviderId,
  RepoOverview,
  RepoStackActionInput,
  RepoStackActionResult,
  RepoRecord,
  StarSandboxAgentRepoInput,
  StarSandboxAgentRepoResult,
  SwitchResult,
  UpdateFoundryOrganizationProfileInput,
} from "@sandbox-agent/foundry-shared";
import type { ProcessCreateRequest, ProcessInfo, ProcessLogFollowQuery, ProcessLogsResponse, ProcessSignalQuery } from "sandbox-agent";
import { createMockBackendClient } from "./mock/backend-client.js";
import { sandboxInstanceKey, workspaceKey } from "./keys.js";

export type TaskAction = "push" | "sync" | "merge" | "archive" | "kill";

type RivetMetadataResponse = {
  runtime?: string;
  actorNames?: Record<string, unknown>;
  clientEndpoint?: string;
  clientNamespace?: string;
  clientToken?: string;
};

export interface SandboxSessionRecord {
  id: string;
  agent: string;
  agentSessionId: string;
  lastConnectionId: string;
  createdAt: number;
  destroyedAt?: number;
  status?: "running" | "idle" | "error";
}

export interface SandboxSessionEventRecord {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: "client" | "agent";
  payload: unknown;
}

export type SandboxProcessRecord = ProcessInfo;

interface WorkspaceHandle {
  addRepo(input: AddRepoInput): Promise<RepoRecord>;
  listRepos(input: { workspaceId: string }): Promise<RepoRecord[]>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  listTasks(input: { workspaceId: string; repoId?: string }): Promise<TaskSummary[]>;
  getRepoOverview(input: { workspaceId: string; repoId: string }): Promise<RepoOverview>;
  runRepoStackAction(input: RepoStackActionInput): Promise<RepoStackActionResult>;
  history(input: HistoryQueryInput): Promise<HistoryEvent[]>;
  switchTask(taskId: string): Promise<SwitchResult>;
  getTask(input: { workspaceId: string; taskId: string }): Promise<TaskRecord>;
  attachTask(input: { workspaceId: string; taskId: string; reason?: string }): Promise<{ target: string; sessionId: string | null }>;
  pushTask(input: { workspaceId: string; taskId: string; reason?: string }): Promise<void>;
  syncTask(input: { workspaceId: string; taskId: string; reason?: string }): Promise<void>;
  mergeTask(input: { workspaceId: string; taskId: string; reason?: string }): Promise<void>;
  archiveTask(input: { workspaceId: string; taskId: string; reason?: string }): Promise<void>;
  killTask(input: { workspaceId: string; taskId: string; reason?: string }): Promise<void>;
  useWorkspace(input: { workspaceId: string }): Promise<{ workspaceId: string }>;
  starSandboxAgentRepo(input: StarSandboxAgentRepoInput): Promise<StarSandboxAgentRepoResult>;
  getWorkbench(input: { workspaceId: string }): Promise<TaskWorkbenchSnapshot>;
  createWorkbenchTask(input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse>;
  markWorkbenchUnread(input: TaskWorkbenchSelectInput): Promise<void>;
  renameWorkbenchTask(input: TaskWorkbenchRenameInput): Promise<void>;
  renameWorkbenchBranch(input: TaskWorkbenchRenameInput): Promise<void>;
  createWorkbenchSession(input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }>;
  renameWorkbenchSession(input: TaskWorkbenchRenameSessionInput): Promise<void>;
  setWorkbenchSessionUnread(input: TaskWorkbenchSetSessionUnreadInput): Promise<void>;
  updateWorkbenchDraft(input: TaskWorkbenchUpdateDraftInput): Promise<void>;
  changeWorkbenchModel(input: TaskWorkbenchChangeModelInput): Promise<void>;
  sendWorkbenchMessage(input: TaskWorkbenchSendMessageInput): Promise<void>;
  stopWorkbenchSession(input: TaskWorkbenchTabInput): Promise<void>;
  closeWorkbenchSession(input: TaskWorkbenchTabInput): Promise<void>;
  publishWorkbenchPr(input: TaskWorkbenchSelectInput): Promise<void>;
  revertWorkbenchFile(input: TaskWorkbenchDiffInput): Promise<void>;
}

interface SandboxInstanceHandle {
  createSession(input: {
    prompt: string;
    cwd?: string;
    agent?: AgentType | "opencode";
  }): Promise<{ id: string | null; status: "running" | "idle" | "error"; error?: string }>;
  listSessions(input?: { cursor?: string; limit?: number }): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }>;
  listSessionEvents(input: { sessionId: string; cursor?: string; limit?: number }): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }>;
  createProcess(input: ProcessCreateRequest): Promise<SandboxProcessRecord>;
  listProcesses(): Promise<{ processes: SandboxProcessRecord[] }>;
  getProcessLogs(input: { processId: string; query?: ProcessLogFollowQuery }): Promise<ProcessLogsResponse>;
  stopProcess(input: { processId: string; query?: ProcessSignalQuery }): Promise<SandboxProcessRecord>;
  killProcess(input: { processId: string; query?: ProcessSignalQuery }): Promise<SandboxProcessRecord>;
  deleteProcess(input: { processId: string }): Promise<void>;
  sendPrompt(input: { sessionId: string; prompt: string; notification?: boolean }): Promise<void>;
  sessionStatus(input: { sessionId: string }): Promise<{ id: string; status: "running" | "idle" | "error" }>;
  sandboxAgentConnection(): Promise<{ endpoint: string; token?: string }>;
  providerState(): Promise<{ providerId: ProviderId; sandboxId: string; state: string; at: number }>;
}

interface RivetClient {
  workspace: {
    getOrCreate(key?: string | string[], opts?: { createWithInput?: unknown }): WorkspaceHandle;
  };
  sandboxInstance: {
    getOrCreate(key?: string | string[], opts?: { createWithInput?: unknown }): SandboxInstanceHandle;
  };
}

export interface BackendClientOptions {
  endpoint: string;
  defaultWorkspaceId?: string;
  mode?: "remote" | "mock";
}

export interface BackendMetadata {
  runtime?: string;
  actorNames?: Record<string, unknown>;
  clientEndpoint?: string;
  clientNamespace?: string;
  clientToken?: string;
}

export interface BackendClient {
  getAppSnapshot(): Promise<FoundryAppSnapshot>;
  signInWithGithub(): Promise<void>;
  signOutApp(): Promise<FoundryAppSnapshot>;
  skipAppStarterRepo(): Promise<FoundryAppSnapshot>;
  starAppStarterRepo(organizationId: string): Promise<FoundryAppSnapshot>;
  selectAppOrganization(organizationId: string): Promise<FoundryAppSnapshot>;
  updateAppOrganizationProfile(input: UpdateFoundryOrganizationProfileInput): Promise<FoundryAppSnapshot>;
  triggerAppRepoImport(organizationId: string): Promise<FoundryAppSnapshot>;
  reconnectAppGithub(organizationId: string): Promise<void>;
  completeAppHostedCheckout(organizationId: string, planId: FoundryBillingPlanId): Promise<void>;
  openAppBillingPortal(organizationId: string): Promise<void>;
  cancelAppScheduledRenewal(organizationId: string): Promise<FoundryAppSnapshot>;
  resumeAppSubscription(organizationId: string): Promise<FoundryAppSnapshot>;
  recordAppSeatUsage(workspaceId: string): Promise<FoundryAppSnapshot>;
  addRepo(workspaceId: string, remoteUrl: string): Promise<RepoRecord>;
  listRepos(workspaceId: string): Promise<RepoRecord[]>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  listTasks(workspaceId: string, repoId?: string): Promise<TaskSummary[]>;
  getRepoOverview(workspaceId: string, repoId: string): Promise<RepoOverview>;
  runRepoStackAction(input: RepoStackActionInput): Promise<RepoStackActionResult>;
  getTask(workspaceId: string, taskId: string): Promise<TaskRecord>;
  listHistory(input: HistoryQueryInput): Promise<HistoryEvent[]>;
  switchTask(workspaceId: string, taskId: string): Promise<SwitchResult>;
  attachTask(workspaceId: string, taskId: string): Promise<{ target: string; sessionId: string | null }>;
  runAction(workspaceId: string, taskId: string, action: TaskAction): Promise<void>;
  createSandboxSession(input: {
    workspaceId: string;
    providerId: ProviderId;
    sandboxId: string;
    prompt: string;
    cwd?: string;
    agent?: AgentType | "opencode";
  }): Promise<{ id: string; status: "running" | "idle" | "error" }>;
  listSandboxSessions(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }>;
  listSandboxSessionEvents(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    input: { sessionId: string; cursor?: string; limit?: number },
  ): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }>;
  createSandboxProcess(input: { workspaceId: string; providerId: ProviderId; sandboxId: string; request: ProcessCreateRequest }): Promise<SandboxProcessRecord>;
  listSandboxProcesses(workspaceId: string, providerId: ProviderId, sandboxId: string): Promise<{ processes: SandboxProcessRecord[] }>;
  getSandboxProcessLogs(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    processId: string,
    query?: ProcessLogFollowQuery,
  ): Promise<ProcessLogsResponse>;
  stopSandboxProcess(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    processId: string,
    query?: ProcessSignalQuery,
  ): Promise<SandboxProcessRecord>;
  killSandboxProcess(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    processId: string,
    query?: ProcessSignalQuery,
  ): Promise<SandboxProcessRecord>;
  deleteSandboxProcess(workspaceId: string, providerId: ProviderId, sandboxId: string, processId: string): Promise<void>;
  subscribeSandboxProcesses(workspaceId: string, providerId: ProviderId, sandboxId: string, listener: () => void): () => void;
  sendSandboxPrompt(input: {
    workspaceId: string;
    providerId: ProviderId;
    sandboxId: string;
    sessionId: string;
    prompt: string;
    notification?: boolean;
  }): Promise<void>;
  sandboxSessionStatus(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    sessionId: string,
  ): Promise<{ id: string; status: "running" | "idle" | "error" }>;
  sandboxProviderState(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
  ): Promise<{ providerId: ProviderId; sandboxId: string; state: string; at: number }>;
  getSandboxAgentConnection(workspaceId: string, providerId: ProviderId, sandboxId: string): Promise<{ endpoint: string; token?: string }>;
  getWorkbench(workspaceId: string): Promise<TaskWorkbenchSnapshot>;
  subscribeWorkbench(workspaceId: string, listener: () => void): () => void;
  createWorkbenchTask(workspaceId: string, input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse>;
  markWorkbenchUnread(workspaceId: string, input: TaskWorkbenchSelectInput): Promise<void>;
  renameWorkbenchTask(workspaceId: string, input: TaskWorkbenchRenameInput): Promise<void>;
  renameWorkbenchBranch(workspaceId: string, input: TaskWorkbenchRenameInput): Promise<void>;
  createWorkbenchSession(workspaceId: string, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }>;
  renameWorkbenchSession(workspaceId: string, input: TaskWorkbenchRenameSessionInput): Promise<void>;
  setWorkbenchSessionUnread(workspaceId: string, input: TaskWorkbenchSetSessionUnreadInput): Promise<void>;
  updateWorkbenchDraft(workspaceId: string, input: TaskWorkbenchUpdateDraftInput): Promise<void>;
  changeWorkbenchModel(workspaceId: string, input: TaskWorkbenchChangeModelInput): Promise<void>;
  sendWorkbenchMessage(workspaceId: string, input: TaskWorkbenchSendMessageInput): Promise<void>;
  stopWorkbenchSession(workspaceId: string, input: TaskWorkbenchTabInput): Promise<void>;
  closeWorkbenchSession(workspaceId: string, input: TaskWorkbenchTabInput): Promise<void>;
  publishWorkbenchPr(workspaceId: string, input: TaskWorkbenchSelectInput): Promise<void>;
  revertWorkbenchFile(workspaceId: string, input: TaskWorkbenchDiffInput): Promise<void>;
  health(): Promise<{ ok: true }>;
  useWorkspace(workspaceId: string): Promise<{ workspaceId: string }>;
  starSandboxAgentRepo(workspaceId: string): Promise<StarSandboxAgentRepoResult>;
}

export function rivetEndpoint(config: AppConfig): string {
  return `http://${config.backend.host}:${config.backend.port}/api/rivet`;
}

export function createBackendClientFromConfig(config: AppConfig): BackendClient {
  return createBackendClient({
    endpoint: rivetEndpoint(config),
    defaultWorkspaceId: config.workspace.default,
  });
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "0.0.0.0" || h === "::1";
}

function rewriteLoopbackClientEndpoint(clientEndpoint: string, fallbackOrigin: string): string {
  const clientUrl = new URL(clientEndpoint);
  if (!isLoopbackHost(clientUrl.hostname)) {
    return clientUrl.toString().replace(/\/$/, "");
  }

  const originUrl = new URL(fallbackOrigin);
  // Keep the manager port from clientEndpoint; only rewrite host/protocol to match the origin.
  clientUrl.hostname = originUrl.hostname;
  clientUrl.protocol = originUrl.protocol;
  return clientUrl.toString().replace(/\/$/, "");
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMetadataWithRetry(
  endpoint: string,
  namespace: string | undefined,
  opts: { timeoutMs: number; requestTimeoutMs: number },
): Promise<RivetMetadataResponse> {
  const base = new URL(endpoint);
  base.pathname = base.pathname.replace(/\/$/, "") + "/metadata";
  if (namespace) {
    base.searchParams.set("namespace", namespace);
  }

  const start = Date.now();
  let delayMs = 250;
  // Keep this bounded: callers (UI/CLI) should not hang forever if the backend is down.
  for (;;) {
    try {
      const json = await fetchJsonWithTimeout(base.toString(), opts.requestTimeoutMs);
      if (!json || typeof json !== "object") return {};
      const data = json as Record<string, unknown>;
      return {
        runtime: typeof data.runtime === "string" ? data.runtime : undefined,
        actorNames: data.actorNames && typeof data.actorNames === "object" ? (data.actorNames as Record<string, unknown>) : undefined,
        clientEndpoint: typeof data.clientEndpoint === "string" ? data.clientEndpoint : undefined,
        clientNamespace: typeof data.clientNamespace === "string" ? data.clientNamespace : undefined,
        clientToken: typeof data.clientToken === "string" ? data.clientToken : undefined,
      };
    } catch (err) {
      if (Date.now() - start > opts.timeoutMs) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 2_000);
    }
  }
}

export async function readBackendMetadata(input: { endpoint: string; namespace?: string; timeoutMs?: number }): Promise<BackendMetadata> {
  const base = new URL(input.endpoint);
  base.pathname = base.pathname.replace(/\/$/, "") + "/metadata";
  if (input.namespace) {
    base.searchParams.set("namespace", input.namespace);
  }

  const json = await fetchJsonWithTimeout(base.toString(), input.timeoutMs ?? 4_000);
  if (!json || typeof json !== "object") {
    return {};
  }
  const data = json as Record<string, unknown>;
  return {
    runtime: typeof data.runtime === "string" ? data.runtime : undefined,
    actorNames: data.actorNames && typeof data.actorNames === "object" ? (data.actorNames as Record<string, unknown>) : undefined,
    clientEndpoint: typeof data.clientEndpoint === "string" ? data.clientEndpoint : undefined,
    clientNamespace: typeof data.clientNamespace === "string" ? data.clientNamespace : undefined,
    clientToken: typeof data.clientToken === "string" ? data.clientToken : undefined,
  };
}

export async function checkBackendHealth(input: { endpoint: string; namespace?: string; timeoutMs?: number }): Promise<boolean> {
  try {
    const metadata = await readBackendMetadata(input);
    return metadata.runtime === "rivetkit" && Boolean(metadata.actorNames);
  } catch {
    return false;
  }
}

async function probeMetadataEndpoint(endpoint: string, namespace: string | undefined, timeoutMs: number): Promise<boolean> {
  try {
    const base = new URL(endpoint);
    base.pathname = base.pathname.replace(/\/$/, "") + "/metadata";
    if (namespace) {
      base.searchParams.set("namespace", namespace);
    }
    await fetchJsonWithTimeout(base.toString(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export function createBackendClient(options: BackendClientOptions): BackendClient {
  if (options.mode === "mock") {
    return createMockBackendClient(options.defaultWorkspaceId);
  }

  let clientPromise: Promise<RivetClient> | null = null;
  let appSessionId = typeof window !== "undefined" ? window.localStorage.getItem("sandbox-agent-foundry:remote-app-session") : null;
  const workbenchSubscriptions = new Map<
    string,
    {
      listeners: Set<() => void>;
      disposeConnPromise: Promise<(() => Promise<void>) | null> | null;
    }
  >();
  const sandboxProcessSubscriptions = new Map<
    string,
    {
      listeners: Set<() => void>;
      disposeConnPromise: Promise<(() => Promise<void>) | null> | null;
    }
  >();

  const persistAppSessionId = (nextSessionId: string | null): void => {
    appSessionId = nextSessionId;
    if (typeof window === "undefined") {
      return;
    }
    if (nextSessionId) {
      window.localStorage.setItem("sandbox-agent-foundry:remote-app-session", nextSessionId);
    } else {
      window.localStorage.removeItem("sandbox-agent-foundry:remote-app-session");
    }
  };

  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    const sessionFromUrl = url.searchParams.get("foundrySession");
    if (sessionFromUrl) {
      persistAppSessionId(sessionFromUrl);
      url.searchParams.delete("foundrySession");
      window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
    }
  }

  const appRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    if (appSessionId) {
      headers.set("x-foundry-session", appSessionId);
    }
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(`${options.endpoint.replace(/\/$/, "")}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    const nextSessionId = res.headers.get("x-foundry-session");
    if (nextSessionId) {
      persistAppSessionId(nextSessionId);
    }
    if (!res.ok) {
      throw new Error(`app request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  };

  const redirectTo = async (path: string, init?: RequestInit): Promise<void> => {
    const response = await appRequest<{ url: string }>(path, init);
    if (typeof window !== "undefined") {
      window.location.assign(response.url);
    }
  };

  const getClient = async (): Promise<RivetClient> => {
    if (clientPromise) {
      return clientPromise;
    }

    clientPromise = (async () => {
      // Use the serverless /metadata endpoint to discover the manager endpoint.
      // If the server reports a loopback clientEndpoint (127.0.0.1), rewrite to the same host
      // as the configured endpoint so remote browsers/clients can connect.
      const configured = new URL(options.endpoint);
      const configuredOrigin = `${configured.protocol}//${configured.host}`;

      const initialNamespace = undefined;
      const metadata = await fetchMetadataWithRetry(options.endpoint, initialNamespace, {
        timeoutMs: 30_000,
        requestTimeoutMs: 8_000,
      });

      // Candidate endpoint: manager endpoint if provided, otherwise stick to the configured endpoint.
      const candidateEndpoint = metadata.clientEndpoint ? rewriteLoopbackClientEndpoint(metadata.clientEndpoint, configuredOrigin) : options.endpoint;

      // If the manager port isn't reachable from this client (common behind reverse proxies),
      // fall back to the configured serverless endpoint to avoid hanging requests.
      const shouldUseCandidate = metadata.clientEndpoint ? await probeMetadataEndpoint(candidateEndpoint, metadata.clientNamespace, 1_500) : true;
      const resolvedEndpoint = shouldUseCandidate ? candidateEndpoint : options.endpoint;

      return createClient({
        endpoint: resolvedEndpoint,
        namespace: metadata.clientNamespace,
        token: metadata.clientToken,
        // Prevent rivetkit from overriding back to a loopback endpoint (or to an unreachable manager).
        disableMetadataLookup: true,
      }) as unknown as RivetClient;
    })();

    return clientPromise;
  };

  const workspace = async (workspaceId: string): Promise<WorkspaceHandle> =>
    (await getClient()).workspace.getOrCreate(workspaceKey(workspaceId), {
      createWithInput: workspaceId,
    });

  const sandboxByKey = async (workspaceId: string, providerId: ProviderId, sandboxId: string): Promise<SandboxInstanceHandle> => {
    const client = await getClient();
    return (client as any).sandboxInstance.get(sandboxInstanceKey(workspaceId, providerId, sandboxId));
  };

  function isActorNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Actor not found");
  }

  const sandboxByActorIdFromTask = async (workspaceId: string, providerId: ProviderId, sandboxId: string): Promise<SandboxInstanceHandle | null> => {
    const ws = await workspace(workspaceId);
    const rows = await ws.listTasks({ workspaceId });
    const candidates = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);

    for (const row of candidates) {
      try {
        const detail = await ws.getTask({ workspaceId, taskId: row.taskId });
        if (detail.providerId !== providerId) {
          continue;
        }
        const sandbox = detail.sandboxes.find(
          (sb) =>
            sb.sandboxId === sandboxId &&
            sb.providerId === providerId &&
            typeof (sb as any).sandboxActorId === "string" &&
            (sb as any).sandboxActorId.length > 0,
        ) as { sandboxActorId?: string } | undefined;
        if (sandbox?.sandboxActorId) {
          const client = await getClient();
          return (client as any).sandboxInstance.getForId(sandbox.sandboxActorId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isActorNotFoundError(error) && !message.includes("Unknown task")) {
          throw error;
        }
        // Best effort fallback path; ignore missing task actors here.
      }
    }

    return null;
  };

  const withSandboxHandle = async <T>(
    workspaceId: string,
    providerId: ProviderId,
    sandboxId: string,
    run: (handle: SandboxInstanceHandle) => Promise<T>,
  ): Promise<T> => {
    const handle = await sandboxByKey(workspaceId, providerId, sandboxId);
    try {
      return await run(handle);
    } catch (error) {
      if (!isActorNotFoundError(error)) {
        throw error;
      }
      const fallback = await sandboxByActorIdFromTask(workspaceId, providerId, sandboxId);
      if (!fallback) {
        throw error;
      }
      return await run(fallback);
    }
  };

  const subscribeWorkbench = (workspaceId: string, listener: () => void): (() => void) => {
    let entry = workbenchSubscriptions.get(workspaceId);
    if (!entry) {
      entry = {
        listeners: new Set(),
        disposeConnPromise: null,
      };
      workbenchSubscriptions.set(workspaceId, entry);
    }

    entry.listeners.add(listener);

    if (!entry.disposeConnPromise) {
      entry.disposeConnPromise = (async () => {
        const handle = await workspace(workspaceId);
        const conn = (handle as any).connect();
        const unsubscribeEvent = conn.on("workbenchUpdated", () => {
          const current = workbenchSubscriptions.get(workspaceId);
          if (!current) {
            return;
          }
          for (const currentListener of [...current.listeners]) {
            currentListener();
          }
        });
        const unsubscribeError = conn.onError(() => {});
        return async () => {
          unsubscribeEvent();
          unsubscribeError();
          await conn.dispose();
        };
      })().catch(() => null);
    }

    return () => {
      const current = workbenchSubscriptions.get(workspaceId);
      if (!current) {
        return;
      }
      current.listeners.delete(listener);
      if (current.listeners.size > 0) {
        return;
      }

      workbenchSubscriptions.delete(workspaceId);
      void current.disposeConnPromise?.then(async (disposeConn) => {
        await disposeConn?.();
      });
    };
  };

  const sandboxProcessSubscriptionKey = (workspaceId: string, providerId: ProviderId, sandboxId: string): string => `${workspaceId}:${providerId}:${sandboxId}`;

  const subscribeSandboxProcesses = (workspaceId: string, providerId: ProviderId, sandboxId: string, listener: () => void): (() => void) => {
    const key = sandboxProcessSubscriptionKey(workspaceId, providerId, sandboxId);
    let entry = sandboxProcessSubscriptions.get(key);
    if (!entry) {
      entry = {
        listeners: new Set(),
        disposeConnPromise: null,
      };
      sandboxProcessSubscriptions.set(key, entry);
    }

    entry.listeners.add(listener);

    if (!entry.disposeConnPromise) {
      entry.disposeConnPromise = (async () => {
        const handle = await sandboxByKey(workspaceId, providerId, sandboxId);
        const conn = (handle as any).connect();
        const unsubscribeEvent = conn.on("processesUpdated", () => {
          const current = sandboxProcessSubscriptions.get(key);
          if (!current) {
            return;
          }
          for (const currentListener of [...current.listeners]) {
            currentListener();
          }
        });
        const unsubscribeError = conn.onError(() => {});
        return async () => {
          unsubscribeEvent();
          unsubscribeError();
          await conn.dispose();
        };
      })().catch(() => null);
    }

    return () => {
      const current = sandboxProcessSubscriptions.get(key);
      if (!current) {
        return;
      }
      current.listeners.delete(listener);
      if (current.listeners.size > 0) {
        return;
      }

      sandboxProcessSubscriptions.delete(key);
      void current.disposeConnPromise?.then(async (disposeConn) => {
        await disposeConn?.();
      });
    };
  };

  return {
    async getAppSnapshot(): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>("/app/snapshot");
    },

    async signInWithGithub(): Promise<void> {
      if (typeof window !== "undefined") {
        window.location.assign(`${options.endpoint.replace(/\/$/, "")}/app/auth/github/start`);
        return;
      }
      await redirectTo("/app/auth/github/start");
    },

    async signOutApp(): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>("/app/sign-out", { method: "POST" });
    },

    async skipAppStarterRepo(): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>("/app/onboarding/starter-repo/skip", {
        method: "POST",
      });
    },

    async starAppStarterRepo(organizationId: string): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/organizations/${organizationId}/starter-repo/star`, {
        method: "POST",
      });
    },

    async selectAppOrganization(organizationId: string): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/organizations/${organizationId}/select`, {
        method: "POST",
      });
    },

    async updateAppOrganizationProfile(input: UpdateFoundryOrganizationProfileInput): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/organizations/${input.organizationId}/profile`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: input.displayName,
          slug: input.slug,
          primaryDomain: input.primaryDomain,
        }),
      });
    },

    async triggerAppRepoImport(organizationId: string): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/organizations/${organizationId}/import`, {
        method: "POST",
      });
    },

    async reconnectAppGithub(organizationId: string): Promise<void> {
      await redirectTo(`/app/organizations/${organizationId}/reconnect`, {
        method: "POST",
      });
    },

    async completeAppHostedCheckout(organizationId: string, planId: FoundryBillingPlanId): Promise<void> {
      await redirectTo(`/app/organizations/${organizationId}/billing/checkout`, {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
    },

    async openAppBillingPortal(organizationId: string): Promise<void> {
      await redirectTo(`/app/organizations/${organizationId}/billing/portal`, {
        method: "POST",
      });
    },

    async cancelAppScheduledRenewal(organizationId: string): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/organizations/${organizationId}/billing/cancel`, {
        method: "POST",
      });
    },

    async resumeAppSubscription(organizationId: string): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/organizations/${organizationId}/billing/resume`, {
        method: "POST",
      });
    },

    async recordAppSeatUsage(workspaceId: string): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>(`/app/workspaces/${workspaceId}/seat-usage`, {
        method: "POST",
      });
    },

    async addRepo(workspaceId: string, remoteUrl: string): Promise<RepoRecord> {
      return (await workspace(workspaceId)).addRepo({ workspaceId, remoteUrl });
    },

    async listRepos(workspaceId: string): Promise<RepoRecord[]> {
      return (await workspace(workspaceId)).listRepos({ workspaceId });
    },

    async createTask(input: CreateTaskInput): Promise<TaskRecord> {
      return (await workspace(input.workspaceId)).createTask(input);
    },

    async starSandboxAgentRepo(workspaceId: string): Promise<StarSandboxAgentRepoResult> {
      return (await workspace(workspaceId)).starSandboxAgentRepo({ workspaceId });
    },

    async listTasks(workspaceId: string, repoId?: string): Promise<TaskSummary[]> {
      return (await workspace(workspaceId)).listTasks({ workspaceId, repoId });
    },

    async getRepoOverview(workspaceId: string, repoId: string): Promise<RepoOverview> {
      return (await workspace(workspaceId)).getRepoOverview({ workspaceId, repoId });
    },

    async runRepoStackAction(input: RepoStackActionInput): Promise<RepoStackActionResult> {
      return (await workspace(input.workspaceId)).runRepoStackAction(input);
    },

    async getTask(workspaceId: string, taskId: string): Promise<TaskRecord> {
      return (await workspace(workspaceId)).getTask({
        workspaceId,
        taskId,
      });
    },

    async listHistory(input: HistoryQueryInput): Promise<HistoryEvent[]> {
      return (await workspace(input.workspaceId)).history(input);
    },

    async switchTask(workspaceId: string, taskId: string): Promise<SwitchResult> {
      return (await workspace(workspaceId)).switchTask(taskId);
    },

    async attachTask(workspaceId: string, taskId: string): Promise<{ target: string; sessionId: string | null }> {
      return (await workspace(workspaceId)).attachTask({
        workspaceId,
        taskId,
        reason: "cli.attach",
      });
    },

    async runAction(workspaceId: string, taskId: string, action: TaskAction): Promise<void> {
      if (action === "push") {
        await (await workspace(workspaceId)).pushTask({
          workspaceId,
          taskId,
          reason: "cli.push",
        });
        return;
      }
      if (action === "sync") {
        await (await workspace(workspaceId)).syncTask({
          workspaceId,
          taskId,
          reason: "cli.sync",
        });
        return;
      }
      if (action === "merge") {
        await (await workspace(workspaceId)).mergeTask({
          workspaceId,
          taskId,
          reason: "cli.merge",
        });
        return;
      }
      if (action === "archive") {
        await (await workspace(workspaceId)).archiveTask({
          workspaceId,
          taskId,
          reason: "cli.archive",
        });
        return;
      }
      await (await workspace(workspaceId)).killTask({
        workspaceId,
        taskId,
        reason: "cli.kill",
      });
    },

    async createSandboxSession(input: {
      workspaceId: string;
      providerId: ProviderId;
      sandboxId: string;
      prompt: string;
      cwd?: string;
      agent?: AgentType | "opencode";
    }): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      const created = await withSandboxHandle(input.workspaceId, input.providerId, input.sandboxId, async (handle) =>
        handle.createSession({
          prompt: input.prompt,
          cwd: input.cwd,
          agent: input.agent,
        }),
      );
      if (!created.id) {
        throw new Error(created.error ?? "sandbox session creation failed");
      }
      return {
        id: created.id,
        status: created.status,
      };
    },

    async listSandboxSessions(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
      input?: { cursor?: string; limit?: number },
    ): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.listSessions(input ?? {}));
    },

    async listSandboxSessionEvents(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
      input: { sessionId: string; cursor?: string; limit?: number },
    ): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.listSessionEvents(input));
    },

    async createSandboxProcess(input: {
      workspaceId: string;
      providerId: ProviderId;
      sandboxId: string;
      request: ProcessCreateRequest;
    }): Promise<SandboxProcessRecord> {
      return await withSandboxHandle(input.workspaceId, input.providerId, input.sandboxId, async (handle) => handle.createProcess(input.request));
    },

    async listSandboxProcesses(workspaceId: string, providerId: ProviderId, sandboxId: string): Promise<{ processes: SandboxProcessRecord[] }> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.listProcesses());
    },

    async getSandboxProcessLogs(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessLogFollowQuery,
    ): Promise<ProcessLogsResponse> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.getProcessLogs({ processId, query }));
    },

    async stopSandboxProcess(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.stopProcess({ processId, query }));
    },

    async killSandboxProcess(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.killProcess({ processId, query }));
    },

    async deleteSandboxProcess(workspaceId: string, providerId: ProviderId, sandboxId: string, processId: string): Promise<void> {
      await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.deleteProcess({ processId }));
    },

    subscribeSandboxProcesses(workspaceId: string, providerId: ProviderId, sandboxId: string, listener: () => void): () => void {
      return subscribeSandboxProcesses(workspaceId, providerId, sandboxId, listener);
    },

    async sendSandboxPrompt(input: {
      workspaceId: string;
      providerId: ProviderId;
      sandboxId: string;
      sessionId: string;
      prompt: string;
      notification?: boolean;
    }): Promise<void> {
      await withSandboxHandle(input.workspaceId, input.providerId, input.sandboxId, async (handle) =>
        handle.sendPrompt({
          sessionId: input.sessionId,
          prompt: input.prompt,
          notification: input.notification,
        }),
      );
    },

    async sandboxSessionStatus(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
      sessionId: string,
    ): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.sessionStatus({ sessionId }));
    },

    async sandboxProviderState(
      workspaceId: string,
      providerId: ProviderId,
      sandboxId: string,
    ): Promise<{ providerId: ProviderId; sandboxId: string; state: string; at: number }> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.providerState());
    },

    async getSandboxAgentConnection(workspaceId: string, providerId: ProviderId, sandboxId: string): Promise<{ endpoint: string; token?: string }> {
      return await withSandboxHandle(workspaceId, providerId, sandboxId, async (handle) => handle.sandboxAgentConnection());
    },

    async getWorkbench(workspaceId: string): Promise<TaskWorkbenchSnapshot> {
      return (await workspace(workspaceId)).getWorkbench({ workspaceId });
    },

    subscribeWorkbench(workspaceId: string, listener: () => void): () => void {
      return subscribeWorkbench(workspaceId, listener);
    },

    async createWorkbenchTask(workspaceId: string, input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse> {
      return (await workspace(workspaceId)).createWorkbenchTask(input);
    },

    async markWorkbenchUnread(workspaceId: string, input: TaskWorkbenchSelectInput): Promise<void> {
      await (await workspace(workspaceId)).markWorkbenchUnread(input);
    },

    async renameWorkbenchTask(workspaceId: string, input: TaskWorkbenchRenameInput): Promise<void> {
      await (await workspace(workspaceId)).renameWorkbenchTask(input);
    },

    async renameWorkbenchBranch(workspaceId: string, input: TaskWorkbenchRenameInput): Promise<void> {
      await (await workspace(workspaceId)).renameWorkbenchBranch(input);
    },

    async createWorkbenchSession(workspaceId: string, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }> {
      return await (await workspace(workspaceId)).createWorkbenchSession(input);
    },

    async renameWorkbenchSession(workspaceId: string, input: TaskWorkbenchRenameSessionInput): Promise<void> {
      await (await workspace(workspaceId)).renameWorkbenchSession(input);
    },

    async setWorkbenchSessionUnread(workspaceId: string, input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
      await (await workspace(workspaceId)).setWorkbenchSessionUnread(input);
    },

    async updateWorkbenchDraft(workspaceId: string, input: TaskWorkbenchUpdateDraftInput): Promise<void> {
      await (await workspace(workspaceId)).updateWorkbenchDraft(input);
    },

    async changeWorkbenchModel(workspaceId: string, input: TaskWorkbenchChangeModelInput): Promise<void> {
      await (await workspace(workspaceId)).changeWorkbenchModel(input);
    },

    async sendWorkbenchMessage(workspaceId: string, input: TaskWorkbenchSendMessageInput): Promise<void> {
      await (await workspace(workspaceId)).sendWorkbenchMessage(input);
    },

    async stopWorkbenchSession(workspaceId: string, input: TaskWorkbenchTabInput): Promise<void> {
      await (await workspace(workspaceId)).stopWorkbenchSession(input);
    },

    async closeWorkbenchSession(workspaceId: string, input: TaskWorkbenchTabInput): Promise<void> {
      await (await workspace(workspaceId)).closeWorkbenchSession(input);
    },

    async publishWorkbenchPr(workspaceId: string, input: TaskWorkbenchSelectInput): Promise<void> {
      await (await workspace(workspaceId)).publishWorkbenchPr(input);
    },

    async revertWorkbenchFile(workspaceId: string, input: TaskWorkbenchDiffInput): Promise<void> {
      await (await workspace(workspaceId)).revertWorkbenchFile(input);
    },

    async health(): Promise<{ ok: true }> {
      const workspaceId = options.defaultWorkspaceId;
      if (!workspaceId) {
        throw new Error("Backend client default workspace is required for health checks");
      }

      await (await workspace(workspaceId)).useWorkspace({
        workspaceId,
      });
      return { ok: true };
    },

    async useWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
      return (await workspace(workspaceId)).useWorkspace({ workspaceId });
    },
  };
}
