import { createClient } from "rivetkit/client";
import type {
  AgentType,
  AppConfig,
  FoundryAppSnapshot,
  FoundryBillingPlanId,
  CreateTaskInput,
  AppEvent,
  SessionEvent,
  SandboxProcessesEvent,
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
  TaskWorkbenchSessionInput,
  TaskWorkbenchUpdateDraftInput,
  TaskEvent,
  WorkbenchTaskDetail,
  WorkbenchTaskSummary,
  WorkbenchSessionDetail,
  OrganizationEvent,
  OrganizationSummarySnapshot,
  HistoryEvent,
  HistoryQueryInput,
  SandboxProviderId,
  RepoOverview,
  RepoRecord,
  StarSandboxAgentRepoInput,
  StarSandboxAgentRepoResult,
  SwitchResult,
  UpdateFoundryOrganizationProfileInput,
} from "@sandbox-agent/foundry-shared";
import type { ProcessCreateRequest, ProcessInfo, ProcessLogFollowQuery, ProcessLogsResponse, ProcessSignalQuery } from "sandbox-agent";
import { createMockBackendClient } from "./mock/backend-client.js";
import { taskKey, taskSandboxKey, organizationKey } from "./keys.js";

export type TaskAction = "push" | "sync" | "merge" | "archive" | "kill";

export interface SandboxSessionRecord {
  id: string;
  agent: string;
  agentSessionId: string;
  lastConnectionId: string;
  createdAt: number;
  destroyedAt?: number;
  status?: "pending_provision" | "pending_session_create" | "ready" | "running" | "idle" | "error";
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

export interface ActorConn {
  on(event: string, listener: (payload: any) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  dispose(): Promise<void>;
}

interface OrganizationHandle {
  connect(): ActorConn;
  listRepos(input: { organizationId: string }): Promise<RepoRecord[]>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  listTasks(input: { organizationId: string; repoId?: string }): Promise<TaskSummary[]>;
  getRepoOverview(input: { organizationId: string; repoId: string }): Promise<RepoOverview>;
  history(input: HistoryQueryInput): Promise<HistoryEvent[]>;
  switchTask(taskId: string): Promise<SwitchResult>;
  getTask(input: { organizationId: string; taskId: string }): Promise<TaskRecord>;
  attachTask(input: { organizationId: string; taskId: string; reason?: string }): Promise<{ target: string; sessionId: string | null }>;
  pushTask(input: { organizationId: string; taskId: string; reason?: string }): Promise<void>;
  syncTask(input: { organizationId: string; taskId: string; reason?: string }): Promise<void>;
  mergeTask(input: { organizationId: string; taskId: string; reason?: string }): Promise<void>;
  archiveTask(input: { organizationId: string; taskId: string; reason?: string }): Promise<void>;
  killTask(input: { organizationId: string; taskId: string; reason?: string }): Promise<void>;
  useOrganization(input: { organizationId: string }): Promise<{ organizationId: string }>;
  starSandboxAgentRepo(input: StarSandboxAgentRepoInput): Promise<StarSandboxAgentRepoResult>;
  getOrganizationSummary(input: { organizationId: string }): Promise<OrganizationSummarySnapshot>;
  applyTaskSummaryUpdate(input: { taskSummary: WorkbenchTaskSummary }): Promise<void>;
  removeTaskSummary(input: { taskId: string }): Promise<void>;
  reconcileWorkbenchState(input: { organizationId: string }): Promise<OrganizationSummarySnapshot>;
  createWorkbenchTask(input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse>;
  markWorkbenchUnread(input: TaskWorkbenchSelectInput): Promise<void>;
  renameWorkbenchTask(input: TaskWorkbenchRenameInput): Promise<void>;
  renameWorkbenchBranch(input: TaskWorkbenchRenameInput): Promise<void>;
  createWorkbenchSession(input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ sessionId: string }>;
  renameWorkbenchSession(input: TaskWorkbenchRenameSessionInput): Promise<void>;
  setWorkbenchSessionUnread(input: TaskWorkbenchSetSessionUnreadInput): Promise<void>;
  updateWorkbenchDraft(input: TaskWorkbenchUpdateDraftInput): Promise<void>;
  changeWorkbenchModel(input: TaskWorkbenchChangeModelInput): Promise<void>;
  sendWorkbenchMessage(input: TaskWorkbenchSendMessageInput): Promise<void>;
  stopWorkbenchSession(input: TaskWorkbenchSessionInput): Promise<void>;
  closeWorkbenchSession(input: TaskWorkbenchSessionInput): Promise<void>;
  publishWorkbenchPr(input: TaskWorkbenchSelectInput): Promise<void>;
  revertWorkbenchFile(input: TaskWorkbenchDiffInput): Promise<void>;
  reloadGithubOrganization(): Promise<void>;
  reloadGithubPullRequests(): Promise<void>;
  reloadGithubRepository(input: { repoId: string }): Promise<void>;
  reloadGithubPullRequest(input: { repoId: string; prNumber: number }): Promise<void>;
}

interface AppOrganizationHandle {
  connect(): ActorConn;
  getAppSnapshot(input: { sessionId: string }): Promise<FoundryAppSnapshot>;
  skipAppStarterRepo(input: { sessionId: string }): Promise<FoundryAppSnapshot>;
  starAppStarterRepo(input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot>;
  selectAppOrganization(input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot>;
  updateAppOrganizationProfile(input: UpdateFoundryOrganizationProfileInput & { sessionId: string }): Promise<FoundryAppSnapshot>;
  triggerAppRepoImport(input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot>;
  beginAppGithubInstall(input: { sessionId: string; organizationId: string }): Promise<{ url: string }>;
  createAppCheckoutSession(input: { sessionId: string; organizationId: string; planId: FoundryBillingPlanId }): Promise<{ url: string }>;
  createAppBillingPortalSession(input: { sessionId: string; organizationId: string }): Promise<{ url: string }>;
  cancelAppScheduledRenewal(input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot>;
  resumeAppSubscription(input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot>;
  recordAppSeatUsage(input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot>;
}

interface TaskHandle {
  getTaskSummary(): Promise<WorkbenchTaskSummary>;
  getTaskDetail(): Promise<WorkbenchTaskDetail>;
  getSessionDetail(input: { sessionId: string }): Promise<WorkbenchSessionDetail>;
  connect(): ActorConn;
}

interface TaskSandboxHandle {
  connect(): ActorConn;
  createSession(input: {
    id?: string;
    agent: string;
    model?: string;
    sessionInit?: {
      cwd?: string;
    };
  }): Promise<{ id: string }>;
  listSessions(input?: { cursor?: string; limit?: number }): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }>;
  getEvents(input: { sessionId: string; cursor?: string; limit?: number }): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }>;
  createProcess(input: ProcessCreateRequest): Promise<SandboxProcessRecord>;
  listProcesses(): Promise<{ processes: SandboxProcessRecord[] }>;
  getProcessLogs(processId: string, query?: ProcessLogFollowQuery): Promise<ProcessLogsResponse>;
  stopProcess(processId: string, query?: ProcessSignalQuery): Promise<SandboxProcessRecord>;
  killProcess(processId: string, query?: ProcessSignalQuery): Promise<SandboxProcessRecord>;
  deleteProcess(processId: string): Promise<void>;
  rawSendSessionMethod(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  destroySession(sessionId: string): Promise<void>;
  sandboxAgentConnection(): Promise<{ endpoint: string; token?: string }>;
  providerState(): Promise<{ sandboxProviderId: SandboxProviderId; sandboxId: string; state: string; at: number }>;
}

interface RivetClient {
  organization: {
    getOrCreate(key?: string | string[], opts?: { createWithInput?: unknown }): OrganizationHandle;
  };
  task: {
    get(key?: string | string[]): TaskHandle;
    getOrCreate(key?: string | string[], opts?: { createWithInput?: unknown }): TaskHandle;
  };
  taskSandbox: {
    get(key?: string | string[]): TaskSandboxHandle;
    getOrCreate(key?: string | string[], opts?: { createWithInput?: unknown }): TaskSandboxHandle;
    getForId(actorId: string): TaskSandboxHandle;
  };
}

export interface BackendClientOptions {
  endpoint: string;
  defaultOrganizationId?: string;
  mode?: "remote" | "mock";
}

export interface BackendClient {
  getAppSnapshot(): Promise<FoundryAppSnapshot>;
  connectOrganization(organizationId: string): Promise<ActorConn>;
  connectTask(organizationId: string, repoId: string, taskId: string): Promise<ActorConn>;
  connectSandbox(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): Promise<ActorConn>;
  subscribeApp(listener: () => void): () => void;
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
  recordAppSeatUsage(organizationId: string): Promise<FoundryAppSnapshot>;
  listRepos(organizationId: string): Promise<RepoRecord[]>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  listTasks(organizationId: string, repoId?: string): Promise<TaskSummary[]>;
  getRepoOverview(organizationId: string, repoId: string): Promise<RepoOverview>;
  getTask(organizationId: string, taskId: string): Promise<TaskRecord>;
  listHistory(input: HistoryQueryInput): Promise<HistoryEvent[]>;
  switchTask(organizationId: string, taskId: string): Promise<SwitchResult>;
  attachTask(organizationId: string, taskId: string): Promise<{ target: string; sessionId: string | null }>;
  runAction(organizationId: string, taskId: string, action: TaskAction): Promise<void>;
  createSandboxSession(input: {
    organizationId: string;
    sandboxProviderId: SandboxProviderId;
    sandboxId: string;
    prompt: string;
    cwd?: string;
    agent?: AgentType | "opencode";
  }): Promise<{ id: string; status: "running" | "idle" | "error" }>;
  listSandboxSessions(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }>;
  listSandboxSessionEvents(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    input: { sessionId: string; cursor?: string; limit?: number },
  ): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }>;
  createSandboxProcess(input: {
    organizationId: string;
    sandboxProviderId: SandboxProviderId;
    sandboxId: string;
    request: ProcessCreateRequest;
  }): Promise<SandboxProcessRecord>;
  listSandboxProcesses(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): Promise<{ processes: SandboxProcessRecord[] }>;
  getSandboxProcessLogs(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    processId: string,
    query?: ProcessLogFollowQuery,
  ): Promise<ProcessLogsResponse>;
  stopSandboxProcess(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    processId: string,
    query?: ProcessSignalQuery,
  ): Promise<SandboxProcessRecord>;
  killSandboxProcess(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    processId: string,
    query?: ProcessSignalQuery,
  ): Promise<SandboxProcessRecord>;
  deleteSandboxProcess(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string, processId: string): Promise<void>;
  subscribeSandboxProcesses(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string, listener: () => void): () => void;
  sendSandboxPrompt(input: {
    organizationId: string;
    sandboxProviderId: SandboxProviderId;
    sandboxId: string;
    sessionId: string;
    prompt: string;
    notification?: boolean;
  }): Promise<void>;
  sandboxSessionStatus(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    sessionId: string,
  ): Promise<{ id: string; status: "running" | "idle" | "error" }>;
  sandboxProviderState(
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
  ): Promise<{ sandboxProviderId: SandboxProviderId; sandboxId: string; state: string; at: number }>;
  getSandboxAgentConnection(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): Promise<{ endpoint: string; token?: string }>;
  getOrganizationSummary(organizationId: string): Promise<OrganizationSummarySnapshot>;
  getTaskDetail(organizationId: string, repoId: string, taskId: string): Promise<WorkbenchTaskDetail>;
  getSessionDetail(organizationId: string, repoId: string, taskId: string, sessionId: string): Promise<WorkbenchSessionDetail>;
  getWorkbench(organizationId: string): Promise<TaskWorkbenchSnapshot>;
  subscribeWorkbench(organizationId: string, listener: () => void): () => void;
  createWorkbenchTask(organizationId: string, input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse>;
  markWorkbenchUnread(organizationId: string, input: TaskWorkbenchSelectInput): Promise<void>;
  renameWorkbenchTask(organizationId: string, input: TaskWorkbenchRenameInput): Promise<void>;
  renameWorkbenchBranch(organizationId: string, input: TaskWorkbenchRenameInput): Promise<void>;
  createWorkbenchSession(organizationId: string, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ sessionId: string }>;
  renameWorkbenchSession(organizationId: string, input: TaskWorkbenchRenameSessionInput): Promise<void>;
  setWorkbenchSessionUnread(organizationId: string, input: TaskWorkbenchSetSessionUnreadInput): Promise<void>;
  updateWorkbenchDraft(organizationId: string, input: TaskWorkbenchUpdateDraftInput): Promise<void>;
  changeWorkbenchModel(organizationId: string, input: TaskWorkbenchChangeModelInput): Promise<void>;
  sendWorkbenchMessage(organizationId: string, input: TaskWorkbenchSendMessageInput): Promise<void>;
  stopWorkbenchSession(organizationId: string, input: TaskWorkbenchSessionInput): Promise<void>;
  closeWorkbenchSession(organizationId: string, input: TaskWorkbenchSessionInput): Promise<void>;
  publishWorkbenchPr(organizationId: string, input: TaskWorkbenchSelectInput): Promise<void>;
  revertWorkbenchFile(organizationId: string, input: TaskWorkbenchDiffInput): Promise<void>;
  reloadGithubOrganization(organizationId: string): Promise<void>;
  reloadGithubPullRequests(organizationId: string): Promise<void>;
  reloadGithubRepository(organizationId: string, repoId: string): Promise<void>;
  reloadGithubPullRequest(organizationId: string, repoId: string, prNumber: number): Promise<void>;
  health(): Promise<{ ok: true }>;
  useOrganization(organizationId: string): Promise<{ organizationId: string }>;
  starSandboxAgentRepo(organizationId: string): Promise<StarSandboxAgentRepoResult>;
}

export function rivetEndpoint(config: AppConfig): string {
  return `http://${config.backend.host}:${config.backend.port}/v1/rivet`;
}

export function createBackendClientFromConfig(config: AppConfig): BackendClient {
  return createBackendClient({
    endpoint: rivetEndpoint(config),
    defaultOrganizationId: config.organization.default,
  });
}

export interface BackendHealthCheckOptions {
  endpoint: string;
  timeoutMs?: number;
}

export interface BackendMetadata {
  clientEndpoint: string;
  appEndpoint: string;
  rivetEndpoint: string;
}

export async function checkBackendHealth(options: BackendHealthCheckOptions): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);

  try {
    const response = await fetch(normalizeLegacyBackendEndpoint(options.endpoint), {
      method: "GET",
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readBackendMetadata(options: BackendHealthCheckOptions): Promise<BackendMetadata> {
  const endpoints = deriveBackendEndpoints(options.endpoint);
  const clientEndpoint = endpoints.rivetEndpoint.replace(/\/v1\/rivet\/?$/, "");

  return {
    clientEndpoint,
    appEndpoint: endpoints.appEndpoint,
    rivetEndpoint: endpoints.rivetEndpoint,
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function normalizeLegacyBackendEndpoint(endpoint: string): string {
  const normalized = stripTrailingSlash(endpoint);
  if (normalized.endsWith("/api/rivet")) {
    return `${normalized.slice(0, -"/api/rivet".length)}/v1/rivet`;
  }
  return normalized;
}

function deriveBackendEndpoints(endpoint: string): { appEndpoint: string; rivetEndpoint: string } {
  const normalized = normalizeLegacyBackendEndpoint(endpoint);
  if (normalized.endsWith("/rivet")) {
    return {
      appEndpoint: normalized.slice(0, -"/rivet".length),
      rivetEndpoint: normalized,
    };
  }
  return {
    appEndpoint: normalized,
    rivetEndpoint: `${normalized}/rivet`,
  };
}

function signedOutAppSnapshot(): FoundryAppSnapshot {
  return {
    auth: { status: "signed_out", currentUserId: null },
    activeOrganizationId: null,
    onboarding: {
      starterRepo: {
        repoFullName: "rivet-dev/sandbox-agent",
        repoUrl: "https://github.com/rivet-dev/sandbox-agent",
        status: "pending",
        starredAt: null,
        skippedAt: null,
      },
    },
    users: [],
    organizations: [],
  };
}

export function createBackendClient(options: BackendClientOptions): BackendClient {
  if (options.mode === "mock") {
    return createMockBackendClient(options.defaultOrganizationId);
  }

  const endpoints = deriveBackendEndpoints(options.endpoint);
  const rivetApiEndpoint = endpoints.rivetEndpoint;
  const appApiEndpoint = endpoints.appEndpoint;
  const client = createClient({ endpoint: rivetApiEndpoint }) as unknown as RivetClient;
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
  const appSubscriptions = {
    listeners: new Set<() => void>(),
    disposeConnPromise: null as Promise<(() => Promise<void>) | null> | null,
  };

  const appRequest = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(`${appApiEndpoint}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`app request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  };

  const getSessionId = async (): Promise<string | null> => {
    const res = await fetch(`${appApiEndpoint}/auth/get-session`, {
      credentials: "include",
    });
    if (res.status === 401) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`auth session request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json().catch(() => null)) as { session?: { id?: string | null } | null } | null;
    const sessionId = data?.session?.id;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  };

  const organization = async (organizationId: string): Promise<OrganizationHandle> =>
    client.organization.getOrCreate(organizationKey(organizationId), {
      createWithInput: organizationId,
    });

  const appOrganization = async (): Promise<AppOrganizationHandle> =>
    client.organization.getOrCreate(organizationKey("app"), {
      createWithInput: "app",
    }) as unknown as AppOrganizationHandle;

  const task = async (organizationId: string, repoId: string, taskId: string): Promise<TaskHandle> => client.task.get(taskKey(organizationId, repoId, taskId));

  const sandboxByKey = async (organizationId: string, _providerId: SandboxProviderId, sandboxId: string): Promise<TaskSandboxHandle> => {
    return (client as any).taskSandbox.get(taskSandboxKey(organizationId, sandboxId));
  };

  function isActorNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Actor not found");
  }

  const sandboxByActorIdFromTask = async (
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
  ): Promise<TaskSandboxHandle | null> => {
    const ws = await organization(organizationId);
    const rows = await ws.listTasks({ organizationId });
    const candidates = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);

    for (const row of candidates) {
      try {
        const detail = await ws.getTask({ organizationId, taskId: row.taskId });
        if (detail.sandboxProviderId !== sandboxProviderId) {
          continue;
        }
        const sandbox = detail.sandboxes.find(
          (sb) =>
            sb.sandboxId === sandboxId &&
            sb.sandboxProviderId === sandboxProviderId &&
            typeof (sb as any).sandboxActorId === "string" &&
            (sb as any).sandboxActorId.length > 0,
        ) as { sandboxActorId?: string } | undefined;
        if (sandbox?.sandboxActorId) {
          return (client as any).taskSandbox.getForId(sandbox.sandboxActorId);
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
    organizationId: string,
    sandboxProviderId: SandboxProviderId,
    sandboxId: string,
    run: (handle: TaskSandboxHandle) => Promise<T>,
  ): Promise<T> => {
    const handle = await sandboxByKey(organizationId, sandboxProviderId, sandboxId);
    try {
      return await run(handle);
    } catch (error) {
      if (!isActorNotFoundError(error)) {
        throw error;
      }
      const fallback = await sandboxByActorIdFromTask(organizationId, sandboxProviderId, sandboxId);
      if (!fallback) {
        throw error;
      }
      return await run(fallback);
    }
  };

  const connectOrganization = async (organizationId: string): Promise<ActorConn> => {
    return (await organization(organizationId)).connect() as ActorConn;
  };

  const connectTask = async (organizationId: string, repoId: string, taskIdValue: string): Promise<ActorConn> => {
    return (await task(organizationId, repoId, taskIdValue)).connect() as ActorConn;
  };

  const connectSandbox = async (organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): Promise<ActorConn> => {
    try {
      return (await sandboxByKey(organizationId, sandboxProviderId, sandboxId)).connect() as ActorConn;
    } catch (error) {
      if (!isActorNotFoundError(error)) {
        throw error;
      }
      const fallback = await sandboxByActorIdFromTask(organizationId, sandboxProviderId, sandboxId);
      if (!fallback) {
        throw error;
      }
      return fallback.connect() as ActorConn;
    }
  };

  const getWorkbenchCompat = async (organizationId: string): Promise<TaskWorkbenchSnapshot> => {
    const summary = await (await organization(organizationId)).getOrganizationSummary({ organizationId });
    const tasks = (
      await Promise.all(
        summary.taskSummaries.map(async (taskSummary) => {
          let detail;
          try {
            detail = await (await task(organizationId, taskSummary.repoId, taskSummary.id)).getTaskDetail();
          } catch (error) {
            if (isActorNotFoundError(error)) {
              return null;
            }
            throw error;
          }
          const sessionDetails = await Promise.all(
            detail.sessionsSummary.map(async (session) => {
              try {
                const full = await (await task(organizationId, detail.repoId, detail.id)).getSessionDetail({ sessionId: session.id });
                return [session.id, full] as const;
              } catch (error) {
                if (isActorNotFoundError(error)) {
                  return null;
                }
                throw error;
              }
            }),
          );
          const sessionDetailsById = new Map(sessionDetails.filter((entry): entry is readonly [string, WorkbenchSessionDetail] => entry !== null));
          return {
            id: detail.id,
            repoId: detail.repoId,
            title: detail.title,
            status: detail.status,
            repoName: detail.repoName,
            updatedAtMs: detail.updatedAtMs,
            branch: detail.branch,
            pullRequest: detail.pullRequest,
            sessions: detail.sessionsSummary.map((session) => {
              const full = sessionDetailsById.get(session.id);
              return {
                id: session.id,
                sessionId: session.sessionId,
                sessionName: session.sessionName,
                agent: session.agent,
                model: session.model,
                status: session.status,
                thinkingSinceMs: session.thinkingSinceMs,
                unread: session.unread,
                created: session.created,
                draft: full?.draft ?? { text: "", attachments: [], updatedAtMs: null },
                transcript: full?.transcript ?? [],
              };
            }),
            fileChanges: detail.fileChanges,
            diffs: detail.diffs,
            fileTree: detail.fileTree,
            minutesUsed: detail.minutesUsed,
          };
        }),
      )
    ).filter((task): task is TaskWorkbenchSnapshot["tasks"][number] => task !== null);

    const repositories = summary.repos
      .map((repo) => ({
        id: repo.id,
        label: repo.label,
        updatedAtMs: tasks.filter((task) => task.repoId === repo.id).reduce((latest, task) => Math.max(latest, task.updatedAtMs), repo.latestActivityMs),
        tasks: tasks.filter((task) => task.repoId === repo.id).sort((left, right) => right.updatedAtMs - left.updatedAtMs),
      }))
      .filter((repo) => repo.tasks.length > 0);

    return {
      organizationId,
      repos: summary.repos.map((repo) => ({ id: repo.id, label: repo.label })),
      repositories,
      tasks: tasks.sort((left, right) => right.updatedAtMs - left.updatedAtMs),
    };
  };

  const subscribeWorkbench = (organizationId: string, listener: () => void): (() => void) => {
    let entry = workbenchSubscriptions.get(organizationId);
    if (!entry) {
      entry = {
        listeners: new Set(),
        disposeConnPromise: null,
      };
      workbenchSubscriptions.set(organizationId, entry);
    }

    entry.listeners.add(listener);

    if (!entry.disposeConnPromise) {
      entry.disposeConnPromise = (async () => {
        const handle = await organization(organizationId);
        const conn = (handle as any).connect();
        const unsubscribeEvent = conn.on("workbenchUpdated", () => {
          const current = workbenchSubscriptions.get(organizationId);
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
      const current = workbenchSubscriptions.get(organizationId);
      if (!current) {
        return;
      }
      current.listeners.delete(listener);
      if (current.listeners.size > 0) {
        return;
      }

      workbenchSubscriptions.delete(organizationId);
      void current.disposeConnPromise?.then(async (disposeConn) => {
        await disposeConn?.();
      });
    };
  };

  const sandboxProcessSubscriptionKey = (organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): string =>
    `${organizationId}:${sandboxProviderId}:${sandboxId}`;

  const subscribeSandboxProcesses = (organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string, listener: () => void): (() => void) => {
    const key = sandboxProcessSubscriptionKey(organizationId, sandboxProviderId, sandboxId);
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
        const conn = await connectSandbox(organizationId, sandboxProviderId, sandboxId);
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

  const subscribeApp = (listener: () => void): (() => void) => {
    appSubscriptions.listeners.add(listener);

    if (!appSubscriptions.disposeConnPromise) {
      appSubscriptions.disposeConnPromise = (async () => {
        const handle = await appOrganization();
        const conn = (handle as any).connect();
        const unsubscribeEvent = conn.on("appUpdated", () => {
          for (const currentListener of [...appSubscriptions.listeners]) {
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
      appSubscriptions.listeners.delete(listener);
      if (appSubscriptions.listeners.size > 0) {
        return;
      }

      void appSubscriptions.disposeConnPromise?.then(async (disposeConn) => {
        await disposeConn?.();
      });
      appSubscriptions.disposeConnPromise = null;
    };
  };

  return {
    async getAppSnapshot(): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        return signedOutAppSnapshot();
      }
      return await (await appOrganization()).getAppSnapshot({ sessionId });
    },

    async connectOrganization(organizationId: string): Promise<ActorConn> {
      return await connectOrganization(organizationId);
    },

    async connectTask(organizationId: string, repoId: string, taskIdValue: string): Promise<ActorConn> {
      return await connectTask(organizationId, repoId, taskIdValue);
    },

    async connectSandbox(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): Promise<ActorConn> {
      return await connectSandbox(organizationId, sandboxProviderId, sandboxId);
    },

    subscribeApp(listener: () => void): () => void {
      return subscribeApp(listener);
    },

    async signInWithGithub(): Promise<void> {
      const callbackURL = typeof window !== "undefined" ? `${window.location.origin}/organizations` : `${appApiEndpoint.replace(/\/$/, "")}/organizations`;
      const response = await appRequest<{ url: string; redirect?: boolean }>("/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider: "github",
          callbackURL,
          disableRedirect: true,
        }),
      });
      if (typeof window !== "undefined") {
        window.location.assign(response.url);
      }
    },

    async signOutApp(): Promise<FoundryAppSnapshot> {
      return await appRequest<FoundryAppSnapshot>("/app/sign-out", { method: "POST" });
    },

    async skipAppStarterRepo(): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).skipAppStarterRepo({ sessionId });
    },

    async starAppStarterRepo(organizationId: string): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).starAppStarterRepo({ sessionId, organizationId });
    },

    async selectAppOrganization(organizationId: string): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).selectAppOrganization({ sessionId, organizationId });
    },

    async updateAppOrganizationProfile(input: UpdateFoundryOrganizationProfileInput): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).updateAppOrganizationProfile({
        sessionId,
        organizationId: input.organizationId,
        displayName: input.displayName,
        slug: input.slug,
        primaryDomain: input.primaryDomain,
      });
    },

    async triggerAppRepoImport(organizationId: string): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).triggerAppRepoImport({ sessionId, organizationId });
    },

    async reconnectAppGithub(organizationId: string): Promise<void> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      const response = await (await appOrganization()).beginAppGithubInstall({ sessionId, organizationId });
      if (typeof window !== "undefined") {
        window.location.assign(response.url);
      }
    },

    async completeAppHostedCheckout(organizationId: string, planId: FoundryBillingPlanId): Promise<void> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      const response = await (await appOrganization()).createAppCheckoutSession({ sessionId, organizationId, planId });
      if (typeof window !== "undefined") {
        window.location.assign(response.url);
      }
    },

    async openAppBillingPortal(organizationId: string): Promise<void> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      const response = await (await appOrganization()).createAppBillingPortalSession({ sessionId, organizationId });
      if (typeof window !== "undefined") {
        window.location.assign(response.url);
      }
    },

    async cancelAppScheduledRenewal(organizationId: string): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).cancelAppScheduledRenewal({ sessionId, organizationId });
    },

    async resumeAppSubscription(organizationId: string): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).resumeAppSubscription({ sessionId, organizationId });
    },

    async recordAppSeatUsage(organizationId: string): Promise<FoundryAppSnapshot> {
      const sessionId = await getSessionId();
      if (!sessionId) {
        throw new Error("No active auth session");
      }
      return await (await appOrganization()).recordAppSeatUsage({ sessionId, organizationId });
    },

    async listRepos(organizationId: string): Promise<RepoRecord[]> {
      return (await organization(organizationId)).listRepos({ organizationId });
    },

    async createTask(input: CreateTaskInput): Promise<TaskRecord> {
      return (await organization(input.organizationId)).createTask(input);
    },

    async starSandboxAgentRepo(organizationId: string): Promise<StarSandboxAgentRepoResult> {
      return (await organization(organizationId)).starSandboxAgentRepo({ organizationId });
    },

    async listTasks(organizationId: string, repoId?: string): Promise<TaskSummary[]> {
      return (await organization(organizationId)).listTasks({ organizationId, repoId });
    },

    async getRepoOverview(organizationId: string, repoId: string): Promise<RepoOverview> {
      return (await organization(organizationId)).getRepoOverview({ organizationId, repoId });
    },

    async getTask(organizationId: string, taskId: string): Promise<TaskRecord> {
      return (await organization(organizationId)).getTask({
        organizationId,
        taskId,
      });
    },

    async listHistory(input: HistoryQueryInput): Promise<HistoryEvent[]> {
      return (await organization(input.organizationId)).history(input);
    },

    async switchTask(organizationId: string, taskId: string): Promise<SwitchResult> {
      return (await organization(organizationId)).switchTask(taskId);
    },

    async attachTask(organizationId: string, taskId: string): Promise<{ target: string; sessionId: string | null }> {
      return (await organization(organizationId)).attachTask({
        organizationId,
        taskId,
        reason: "cli.attach",
      });
    },

    async runAction(organizationId: string, taskId: string, action: TaskAction): Promise<void> {
      if (action === "push") {
        await (await organization(organizationId)).pushTask({
          organizationId,
          taskId,
          reason: "cli.push",
        });
        return;
      }
      if (action === "sync") {
        await (await organization(organizationId)).syncTask({
          organizationId,
          taskId,
          reason: "cli.sync",
        });
        return;
      }
      if (action === "merge") {
        await (await organization(organizationId)).mergeTask({
          organizationId,
          taskId,
          reason: "cli.merge",
        });
        return;
      }
      if (action === "archive") {
        await (await organization(organizationId)).archiveTask({
          organizationId,
          taskId,
          reason: "cli.archive",
        });
        return;
      }
      await (await organization(organizationId)).killTask({
        organizationId,
        taskId,
        reason: "cli.kill",
      });
    },

    async createSandboxSession(input: {
      organizationId: string;
      sandboxProviderId: SandboxProviderId;
      sandboxId: string;
      prompt: string;
      cwd?: string;
      agent?: AgentType | "opencode";
    }): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      const created = await withSandboxHandle(input.organizationId, input.sandboxProviderId, input.sandboxId, async (handle) =>
        handle.createSession({
          agent: input.agent ?? "claude",
          sessionInit: {
            cwd: input.cwd,
          },
        }),
      );
      if (input.prompt.trim().length > 0) {
        await withSandboxHandle(input.organizationId, input.sandboxProviderId, input.sandboxId, async (handle) =>
          handle.rawSendSessionMethod(created.id, "session/prompt", {
            prompt: [{ type: "text", text: input.prompt }],
          }),
        );
      }
      return {
        id: created.id,
        status: "idle",
      };
    },

    async listSandboxSessions(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
      input?: { cursor?: string; limit?: number },
    ): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.listSessions(input ?? {}));
    },

    async listSandboxSessionEvents(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
      input: { sessionId: string; cursor?: string; limit?: number },
    ): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.getEvents(input));
    },

    async createSandboxProcess(input: {
      organizationId: string;
      sandboxProviderId: SandboxProviderId;
      sandboxId: string;
      request: ProcessCreateRequest;
    }): Promise<SandboxProcessRecord> {
      return await withSandboxHandle(input.organizationId, input.sandboxProviderId, input.sandboxId, async (handle) => handle.createProcess(input.request));
    },

    async listSandboxProcesses(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
    ): Promise<{ processes: SandboxProcessRecord[] }> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.listProcesses());
    },

    async getSandboxProcessLogs(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessLogFollowQuery,
    ): Promise<ProcessLogsResponse> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.getProcessLogs(processId, query));
    },

    async stopSandboxProcess(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.stopProcess(processId, query));
    },

    async killSandboxProcess(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.killProcess(processId, query));
    },

    async deleteSandboxProcess(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string, processId: string): Promise<void> {
      await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.deleteProcess(processId));
    },

    subscribeSandboxProcesses(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string, listener: () => void): () => void {
      return subscribeSandboxProcesses(organizationId, sandboxProviderId, sandboxId, listener);
    },

    async sendSandboxPrompt(input: {
      organizationId: string;
      sandboxProviderId: SandboxProviderId;
      sandboxId: string;
      sessionId: string;
      prompt: string;
      notification?: boolean;
    }): Promise<void> {
      await withSandboxHandle(input.organizationId, input.sandboxProviderId, input.sandboxId, async (handle) =>
        handle.rawSendSessionMethod(input.sessionId, "session/prompt", {
          prompt: [{ type: "text", text: input.prompt }],
        }),
      );
    },

    async sandboxSessionStatus(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
      sessionId: string,
    ): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      return {
        id: sessionId,
        status: "idle",
      };
    },

    async sandboxProviderState(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
    ): Promise<{ sandboxProviderId: SandboxProviderId; sandboxId: string; state: string; at: number }> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.providerState());
    },

    async getSandboxAgentConnection(
      organizationId: string,
      sandboxProviderId: SandboxProviderId,
      sandboxId: string,
    ): Promise<{ endpoint: string; token?: string }> {
      return await withSandboxHandle(organizationId, sandboxProviderId, sandboxId, async (handle) => handle.sandboxAgentConnection());
    },

    async getOrganizationSummary(organizationId: string): Promise<OrganizationSummarySnapshot> {
      return (await organization(organizationId)).getOrganizationSummary({ organizationId });
    },

    async getTaskDetail(organizationId: string, repoId: string, taskIdValue: string): Promise<WorkbenchTaskDetail> {
      return (await task(organizationId, repoId, taskIdValue)).getTaskDetail();
    },

    async getSessionDetail(organizationId: string, repoId: string, taskIdValue: string, sessionId: string): Promise<WorkbenchSessionDetail> {
      return (await task(organizationId, repoId, taskIdValue)).getSessionDetail({ sessionId });
    },

    async getWorkbench(organizationId: string): Promise<TaskWorkbenchSnapshot> {
      return await getWorkbenchCompat(organizationId);
    },

    subscribeWorkbench(organizationId: string, listener: () => void): () => void {
      return subscribeWorkbench(organizationId, listener);
    },

    async createWorkbenchTask(organizationId: string, input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse> {
      return (await organization(organizationId)).createWorkbenchTask(input);
    },

    async markWorkbenchUnread(organizationId: string, input: TaskWorkbenchSelectInput): Promise<void> {
      await (await organization(organizationId)).markWorkbenchUnread(input);
    },

    async renameWorkbenchTask(organizationId: string, input: TaskWorkbenchRenameInput): Promise<void> {
      await (await organization(organizationId)).renameWorkbenchTask(input);
    },

    async renameWorkbenchBranch(organizationId: string, input: TaskWorkbenchRenameInput): Promise<void> {
      await (await organization(organizationId)).renameWorkbenchBranch(input);
    },

    async createWorkbenchSession(organizationId: string, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ sessionId: string }> {
      return await (await organization(organizationId)).createWorkbenchSession(input);
    },

    async renameWorkbenchSession(organizationId: string, input: TaskWorkbenchRenameSessionInput): Promise<void> {
      await (await organization(organizationId)).renameWorkbenchSession(input);
    },

    async setWorkbenchSessionUnread(organizationId: string, input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
      await (await organization(organizationId)).setWorkbenchSessionUnread(input);
    },

    async updateWorkbenchDraft(organizationId: string, input: TaskWorkbenchUpdateDraftInput): Promise<void> {
      await (await organization(organizationId)).updateWorkbenchDraft(input);
    },

    async changeWorkbenchModel(organizationId: string, input: TaskWorkbenchChangeModelInput): Promise<void> {
      await (await organization(organizationId)).changeWorkbenchModel(input);
    },

    async sendWorkbenchMessage(organizationId: string, input: TaskWorkbenchSendMessageInput): Promise<void> {
      await (await organization(organizationId)).sendWorkbenchMessage(input);
    },

    async stopWorkbenchSession(organizationId: string, input: TaskWorkbenchSessionInput): Promise<void> {
      await (await organization(organizationId)).stopWorkbenchSession(input);
    },

    async closeWorkbenchSession(organizationId: string, input: TaskWorkbenchSessionInput): Promise<void> {
      await (await organization(organizationId)).closeWorkbenchSession(input);
    },

    async publishWorkbenchPr(organizationId: string, input: TaskWorkbenchSelectInput): Promise<void> {
      await (await organization(organizationId)).publishWorkbenchPr(input);
    },

    async revertWorkbenchFile(organizationId: string, input: TaskWorkbenchDiffInput): Promise<void> {
      await (await organization(organizationId)).revertWorkbenchFile(input);
    },

    async reloadGithubOrganization(organizationId: string): Promise<void> {
      await (await organization(organizationId)).reloadGithubOrganization();
    },

    async reloadGithubPullRequests(organizationId: string): Promise<void> {
      await (await organization(organizationId)).reloadGithubPullRequests();
    },

    async reloadGithubRepository(organizationId: string, repoId: string): Promise<void> {
      await (await organization(organizationId)).reloadGithubRepository({ repoId });
    },

    async reloadGithubPullRequest(organizationId: string, repoId: string, prNumber: number): Promise<void> {
      await (await organization(organizationId)).reloadGithubPullRequest({ repoId, prNumber });
    },

    async health(): Promise<{ ok: true }> {
      const organizationId = options.defaultOrganizationId;
      if (!organizationId) {
        throw new Error("Backend client default organization is required for health checks");
      }

      await (await organization(organizationId)).useOrganization({
        organizationId,
      });
      return { ok: true };
    },

    async useOrganization(organizationId: string): Promise<{ organizationId: string }> {
      return (await organization(organizationId)).useOrganization({ organizationId });
    },
  };
}
