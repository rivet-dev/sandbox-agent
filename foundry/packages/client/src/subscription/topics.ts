import type {
  AppEvent,
  FoundryAppSnapshot,
  SandboxProviderId,
  SandboxProcessesEvent,
  SessionEvent,
  TaskEvent,
  WorkbenchSessionDetail,
  WorkbenchTaskDetail,
  OrganizationEvent,
  OrganizationSummarySnapshot,
} from "@sandbox-agent/foundry-shared";
import type { ActorConn, BackendClient, SandboxProcessRecord } from "../backend-client.js";

/**
 * Topic definitions for the subscription manager.
 *
 * Each topic describes one actor connection plus one materialized read model.
 * Events always carry full replacement payloads for the changed entity so the
 * client can replace cached state directly instead of reconstructing patches.
 */
export interface TopicDefinition<TData, TParams, TEvent> {
  key: (params: TParams) => string;
  event: string;
  connect: (backend: BackendClient, params: TParams) => Promise<ActorConn>;
  fetchInitial: (backend: BackendClient, params: TParams) => Promise<TData>;
  applyEvent: (current: TData, event: TEvent) => TData;
}

export interface AppTopicParams {}
export interface OrganizationTopicParams {
  organizationId: string;
}
export interface TaskTopicParams {
  organizationId: string;
  repoId: string;
  taskId: string;
}
export interface SessionTopicParams {
  organizationId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}
export interface SandboxProcessesTopicParams {
  organizationId: string;
  sandboxProviderId: SandboxProviderId;
  sandboxId: string;
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T, sort: (left: T, right: T) => number): T[] {
  const filtered = items.filter((item) => item.id !== nextItem.id);
  return [...filtered, nextItem].sort(sort);
}

function upsertByPrId<T extends { prId: string }>(items: T[], nextItem: T, sort: (left: T, right: T) => number): T[] {
  const filtered = items.filter((item) => item.prId !== nextItem.prId);
  return [...filtered, nextItem].sort(sort);
}

export const topicDefinitions = {
  app: {
    key: () => "app",
    event: "appUpdated",
    connect: (backend: BackendClient, _params: AppTopicParams) => backend.connectOrganization("app"),
    fetchInitial: (backend: BackendClient, _params: AppTopicParams) => backend.getAppSnapshot(),
    applyEvent: (_current: FoundryAppSnapshot, event: AppEvent) => event.snapshot,
  } satisfies TopicDefinition<FoundryAppSnapshot, AppTopicParams, AppEvent>,

  organization: {
    key: (params: OrganizationTopicParams) => `organization:${params.organizationId}`,
    event: "organizationUpdated",
    connect: (backend: BackendClient, params: OrganizationTopicParams) => backend.connectOrganization(params.organizationId),
    fetchInitial: (backend: BackendClient, params: OrganizationTopicParams) => backend.getOrganizationSummary(params.organizationId),
    applyEvent: (current: OrganizationSummarySnapshot, event: OrganizationEvent) => {
      switch (event.type) {
        case "taskSummaryUpdated":
          return {
            ...current,
            taskSummaries: upsertById(current.taskSummaries, event.taskSummary, (left, right) => right.updatedAtMs - left.updatedAtMs),
          };
        case "taskRemoved":
          return {
            ...current,
            taskSummaries: current.taskSummaries.filter((task) => task.id !== event.taskId),
          };
        case "repoAdded":
        case "repoUpdated":
          return {
            ...current,
            repos: upsertById(current.repos, event.repo, (left, right) => right.latestActivityMs - left.latestActivityMs),
          };
        case "repoRemoved":
          return {
            ...current,
            repos: current.repos.filter((repo) => repo.id !== event.repoId),
          };
        case "pullRequestUpdated":
          return {
            ...current,
            openPullRequests: upsertByPrId(current.openPullRequests, event.pullRequest, (left, right) => right.updatedAtMs - left.updatedAtMs),
          };
        case "pullRequestRemoved":
          return {
            ...current,
            openPullRequests: current.openPullRequests.filter((pullRequest) => pullRequest.prId !== event.prId),
          };
      }
    },
  } satisfies TopicDefinition<OrganizationSummarySnapshot, OrganizationTopicParams, OrganizationEvent>,

  task: {
    key: (params: TaskTopicParams) => `task:${params.organizationId}:${params.taskId}`,
    event: "taskUpdated",
    connect: (backend: BackendClient, params: TaskTopicParams) => backend.connectTask(params.organizationId, params.repoId, params.taskId),
    fetchInitial: (backend: BackendClient, params: TaskTopicParams) => backend.getTaskDetail(params.organizationId, params.repoId, params.taskId),
    applyEvent: (_current: WorkbenchTaskDetail, event: TaskEvent) => event.detail,
  } satisfies TopicDefinition<WorkbenchTaskDetail, TaskTopicParams, TaskEvent>,

  session: {
    key: (params: SessionTopicParams) => `session:${params.organizationId}:${params.taskId}:${params.sessionId}`,
    event: "sessionUpdated",
    connect: (backend: BackendClient, params: SessionTopicParams) => backend.connectTask(params.organizationId, params.repoId, params.taskId),
    fetchInitial: (backend: BackendClient, params: SessionTopicParams) =>
      backend.getSessionDetail(params.organizationId, params.repoId, params.taskId, params.sessionId),
    applyEvent: (current: WorkbenchSessionDetail, event: SessionEvent) => {
      if (event.session.sessionId !== current.sessionId) {
        return current;
      }
      return event.session;
    },
  } satisfies TopicDefinition<WorkbenchSessionDetail, SessionTopicParams, SessionEvent>,

  sandboxProcesses: {
    key: (params: SandboxProcessesTopicParams) => `sandbox:${params.organizationId}:${params.sandboxProviderId}:${params.sandboxId}`,
    event: "processesUpdated",
    connect: (backend: BackendClient, params: SandboxProcessesTopicParams) =>
      backend.connectSandbox(params.organizationId, params.sandboxProviderId, params.sandboxId),
    fetchInitial: async (backend: BackendClient, params: SandboxProcessesTopicParams) =>
      (await backend.listSandboxProcesses(params.organizationId, params.sandboxProviderId, params.sandboxId)).processes,
    applyEvent: (_current: SandboxProcessRecord[], event: SandboxProcessesEvent) => event.processes,
  } satisfies TopicDefinition<SandboxProcessRecord[], SandboxProcessesTopicParams, SandboxProcessesEvent>,
} as const;

export type TopicKey = keyof typeof topicDefinitions;
export type TopicParams<K extends TopicKey> = Parameters<(typeof topicDefinitions)[K]["fetchInitial"]>[1];
export type TopicData<K extends TopicKey> = Awaited<ReturnType<(typeof topicDefinitions)[K]["fetchInitial"]>>;
