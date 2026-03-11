import type {
  AddRepoInput,
  CreateTaskInput,
  FoundryAppSnapshot,
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
  RepoRecord,
  RepoStackActionInput,
  RepoStackActionResult,
  StarSandboxAgentRepoResult,
  SwitchResult,
} from "@sandbox-agent/foundry-shared";
import type { ProcessCreateRequest, ProcessLogFollowQuery, ProcessLogsResponse, ProcessSignalQuery } from "sandbox-agent";
import type { BackendClient, SandboxProcessRecord, SandboxSessionEventRecord, SandboxSessionRecord } from "../backend-client.js";
import { getSharedMockWorkbenchClient } from "./workbench-client.js";

interface MockProcessRecord extends SandboxProcessRecord {
  logText: string;
}

function notSupported(name: string): never {
  throw new Error(`${name} is not supported by the mock backend client.`);
}

function encodeBase64Utf8(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  return globalThis.btoa(unescape(encodeURIComponent(value)));
}

function nowMs(): number {
  return Date.now();
}

function mockRepoRemote(label: string): string {
  return `https://example.test/${label}.git`;
}

function mockCwd(repoLabel: string, taskId: string): string {
  return `/mock/${repoLabel.replace(/\//g, "-")}/${taskId}`;
}

function unsupportedAppSnapshot(): FoundryAppSnapshot {
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

function toTaskStatus(status: TaskRecord["status"], archived: boolean): TaskRecord["status"] {
  if (archived) {
    return "archived";
  }
  return status;
}

export function createMockBackendClient(defaultWorkspaceId = "default"): BackendClient {
  const workbench = getSharedMockWorkbenchClient();
  const listenersBySandboxId = new Map<string, Set<() => void>>();
  const processesBySandboxId = new Map<string, MockProcessRecord[]>();
  let nextPid = 4000;
  let nextProcessId = 1;

  const requireTask = (taskId: string) => {
    const task = workbench.getSnapshot().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unknown mock task ${taskId}`);
    }
    return task;
  };

  const ensureProcessList = (sandboxId: string): MockProcessRecord[] => {
    const existing = processesBySandboxId.get(sandboxId);
    if (existing) {
      return existing;
    }
    const created: MockProcessRecord[] = [];
    processesBySandboxId.set(sandboxId, created);
    return created;
  };

  const notifySandbox = (sandboxId: string): void => {
    const listeners = listenersBySandboxId.get(sandboxId);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const buildTaskRecord = (taskId: string): TaskRecord => {
    const task = requireTask(taskId);
    const cwd = mockCwd(task.repoName, task.id);
    const archived = task.status === "archived";
    return {
      workspaceId: defaultWorkspaceId,
      repoId: task.repoId,
      repoRemote: mockRepoRemote(task.repoName),
      taskId: task.id,
      branchName: task.branch,
      title: task.title,
      task: task.title,
      providerId: "local",
      status: toTaskStatus(archived ? "archived" : "running", archived),
      statusMessage: archived ? "archived" : "mock sandbox ready",
      activeSandboxId: task.id,
      activeSessionId: task.tabs[0]?.sessionId ?? null,
      sandboxes: [
        {
          sandboxId: task.id,
          providerId: "local",
          sandboxActorId: "mock-sandbox",
          switchTarget: `mock://${task.id}`,
          cwd,
          createdAt: task.updatedAtMs,
          updatedAt: task.updatedAtMs,
        },
      ],
      agentType: task.tabs[0]?.agent === "Codex" ? "codex" : "claude",
      prSubmitted: Boolean(task.pullRequest),
      diffStat: task.fileChanges.length > 0 ? `+${task.fileChanges.length}/-${task.fileChanges.length}` : "+0/-0",
      prUrl: task.pullRequest ? `https://example.test/pr/${task.pullRequest.number}` : null,
      prAuthor: task.pullRequest ? "mock" : null,
      ciStatus: null,
      reviewStatus: null,
      reviewer: null,
      conflictsWithMain: "0",
      hasUnpushed: task.fileChanges.length > 0 ? "1" : "0",
      parentBranch: null,
      createdAt: task.updatedAtMs,
      updatedAt: task.updatedAtMs,
    };
  };

  const cloneProcess = (process: MockProcessRecord): MockProcessRecord => ({ ...process });

  const createProcessRecord = (sandboxId: string, cwd: string, request: ProcessCreateRequest): MockProcessRecord => {
    const processId = `proc_${nextProcessId++}`;
    const createdAtMs = nowMs();
    const args = request.args ?? [];
    const interactive = request.interactive ?? false;
    const tty = request.tty ?? false;
    const statusLine = interactive && tty ? "Mock terminal session created.\nInteractive transport is unavailable in mock mode.\n" : "Mock process created.\n";
    const commandLine = `$ ${[request.command, ...args].join(" ").trim()}\n`;
    return {
      id: processId,
      command: request.command,
      args,
      createdAtMs,
      cwd: request.cwd ?? cwd,
      exitCode: null,
      exitedAtMs: null,
      interactive,
      pid: nextPid++,
      status: "running",
      tty,
      logText: `${statusLine}${commandLine}`,
    };
  };

  return {
    async getAppSnapshot(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async signInWithGithub(): Promise<void> {
      notSupported("signInWithGithub");
    },

    async signOutApp(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async skipAppStarterRepo(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async starAppStarterRepo(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async selectAppOrganization(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async updateAppOrganizationProfile(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async triggerAppRepoImport(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async reconnectAppGithub(): Promise<void> {
      notSupported("reconnectAppGithub");
    },

    async completeAppHostedCheckout(): Promise<void> {
      notSupported("completeAppHostedCheckout");
    },

    async openAppBillingPortal(): Promise<void> {
      notSupported("openAppBillingPortal");
    },

    async cancelAppScheduledRenewal(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async resumeAppSubscription(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async recordAppSeatUsage(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async addRepo(_workspaceId: string, _remoteUrl: string): Promise<RepoRecord> {
      notSupported("addRepo");
    },

    async listRepos(_workspaceId: string): Promise<RepoRecord[]> {
      return workbench.getSnapshot().repos.map((repo) => ({
        workspaceId: defaultWorkspaceId,
        repoId: repo.id,
        remoteUrl: mockRepoRemote(repo.label),
        createdAt: nowMs(),
        updatedAt: nowMs(),
      }));
    },

    async createTask(_input: CreateTaskInput): Promise<TaskRecord> {
      notSupported("createTask");
    },

    async listTasks(_workspaceId: string, repoId?: string): Promise<TaskSummary[]> {
      return workbench
        .getSnapshot()
        .tasks.filter((task) => !repoId || task.repoId === repoId)
        .map((task) => ({
          workspaceId: defaultWorkspaceId,
          repoId: task.repoId,
          taskId: task.id,
          branchName: task.branch,
          title: task.title,
          status: task.status === "archived" ? "archived" : "running",
          updatedAt: task.updatedAtMs,
        }));
    },

    async getRepoOverview(_workspaceId: string, _repoId: string): Promise<RepoOverview> {
      notSupported("getRepoOverview");
    },

    async runRepoStackAction(_input: RepoStackActionInput): Promise<RepoStackActionResult> {
      notSupported("runRepoStackAction");
    },

    async getTask(_workspaceId: string, taskId: string): Promise<TaskRecord> {
      return buildTaskRecord(taskId);
    },

    async listHistory(_input: HistoryQueryInput): Promise<HistoryEvent[]> {
      return [];
    },

    async switchTask(_workspaceId: string, taskId: string): Promise<SwitchResult> {
      return {
        workspaceId: defaultWorkspaceId,
        taskId,
        providerId: "local",
        switchTarget: `mock://${taskId}`,
      };
    },

    async attachTask(_workspaceId: string, taskId: string): Promise<{ target: string; sessionId: string | null }> {
      return {
        target: `mock://${taskId}`,
        sessionId: requireTask(taskId).tabs[0]?.sessionId ?? null,
      };
    },

    async runAction(_workspaceId: string, _taskId: string): Promise<void> {
      notSupported("runAction");
    },

    async createSandboxSession(): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      notSupported("createSandboxSession");
    },

    async listSandboxSessions(): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }> {
      return { items: [] };
    },

    async listSandboxSessionEvents(): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }> {
      return { items: [] };
    },

    async createSandboxProcess(input: {
      workspaceId: string;
      providerId: ProviderId;
      sandboxId: string;
      request: ProcessCreateRequest;
    }): Promise<SandboxProcessRecord> {
      const task = requireTask(input.sandboxId);
      const processes = ensureProcessList(input.sandboxId);
      const created = createProcessRecord(input.sandboxId, mockCwd(task.repoName, task.id), input.request);
      processes.unshift(created);
      notifySandbox(input.sandboxId);
      return cloneProcess(created);
    },

    async listSandboxProcesses(_workspaceId: string, _providerId: ProviderId, sandboxId: string): Promise<{ processes: SandboxProcessRecord[] }> {
      return {
        processes: ensureProcessList(sandboxId).map((process) => cloneProcess(process)),
      };
    },

    async getSandboxProcessLogs(
      _workspaceId: string,
      _providerId: ProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessLogFollowQuery,
    ): Promise<ProcessLogsResponse> {
      const process = ensureProcessList(sandboxId).find((candidate) => candidate.id === processId);
      if (!process) {
        throw new Error(`Unknown mock process ${processId}`);
      }
      return {
        processId,
        stream: query?.stream ?? (process.tty ? "pty" : "combined"),
        entries: process.logText
          ? [
              {
                data: encodeBase64Utf8(process.logText),
                encoding: "base64",
                sequence: 1,
                stream: query?.stream ?? (process.tty ? "pty" : "combined"),
                timestampMs: process.createdAtMs,
              },
            ]
          : [],
      };
    },

    async stopSandboxProcess(
      _workspaceId: string,
      _providerId: ProviderId,
      sandboxId: string,
      processId: string,
      _query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      const process = ensureProcessList(sandboxId).find((candidate) => candidate.id === processId);
      if (!process) {
        throw new Error(`Unknown mock process ${processId}`);
      }
      process.status = "exited";
      process.exitCode = 0;
      process.exitedAtMs = nowMs();
      process.logText += "\n[stopped]\n";
      notifySandbox(sandboxId);
      return cloneProcess(process);
    },

    async killSandboxProcess(
      _workspaceId: string,
      _providerId: ProviderId,
      sandboxId: string,
      processId: string,
      _query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      const process = ensureProcessList(sandboxId).find((candidate) => candidate.id === processId);
      if (!process) {
        throw new Error(`Unknown mock process ${processId}`);
      }
      process.status = "exited";
      process.exitCode = 137;
      process.exitedAtMs = nowMs();
      process.logText += "\n[killed]\n";
      notifySandbox(sandboxId);
      return cloneProcess(process);
    },

    async deleteSandboxProcess(_workspaceId: string, _providerId: ProviderId, sandboxId: string, processId: string): Promise<void> {
      processesBySandboxId.set(
        sandboxId,
        ensureProcessList(sandboxId).filter((candidate) => candidate.id !== processId),
      );
      notifySandbox(sandboxId);
    },

    subscribeSandboxProcesses(_workspaceId: string, _providerId: ProviderId, sandboxId: string, listener: () => void): () => void {
      let listeners = listenersBySandboxId.get(sandboxId);
      if (!listeners) {
        listeners = new Set();
        listenersBySandboxId.set(sandboxId, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = listenersBySandboxId.get(sandboxId);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listenersBySandboxId.delete(sandboxId);
        }
      };
    },

    async sendSandboxPrompt(): Promise<void> {
      notSupported("sendSandboxPrompt");
    },

    async sandboxSessionStatus(sessionId: string): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      return { id: sessionId, status: "idle" };
    },

    async sandboxProviderState(
      _workspaceId: string,
      _providerId: ProviderId,
      sandboxId: string,
    ): Promise<{ providerId: ProviderId; sandboxId: string; state: string; at: number }> {
      return { providerId: "local", sandboxId, state: "running", at: nowMs() };
    },

    async getSandboxAgentConnection(): Promise<{ endpoint: string; token?: string }> {
      return { endpoint: "mock://terminal-unavailable" };
    },

    async getWorkbench(): Promise<TaskWorkbenchSnapshot> {
      return workbench.getSnapshot();
    },

    subscribeWorkbench(_workspaceId: string, listener: () => void): () => void {
      return workbench.subscribe(listener);
    },

    async createWorkbenchTask(_workspaceId: string, input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse> {
      return await workbench.createTask(input);
    },

    async markWorkbenchUnread(_workspaceId: string, input: TaskWorkbenchSelectInput): Promise<void> {
      await workbench.markTaskUnread(input);
    },

    async renameWorkbenchTask(_workspaceId: string, input: TaskWorkbenchRenameInput): Promise<void> {
      await workbench.renameTask(input);
    },

    async renameWorkbenchBranch(_workspaceId: string, input: TaskWorkbenchRenameInput): Promise<void> {
      await workbench.renameBranch(input);
    },

    async createWorkbenchSession(_workspaceId: string, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }> {
      return await workbench.addTab(input);
    },

    async renameWorkbenchSession(_workspaceId: string, input: TaskWorkbenchRenameSessionInput): Promise<void> {
      await workbench.renameSession(input);
    },

    async setWorkbenchSessionUnread(_workspaceId: string, input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
      await workbench.setSessionUnread(input);
    },

    async updateWorkbenchDraft(_workspaceId: string, input: TaskWorkbenchUpdateDraftInput): Promise<void> {
      await workbench.updateDraft(input);
    },

    async changeWorkbenchModel(_workspaceId: string, input: TaskWorkbenchChangeModelInput): Promise<void> {
      await workbench.changeModel(input);
    },

    async sendWorkbenchMessage(_workspaceId: string, input: TaskWorkbenchSendMessageInput): Promise<void> {
      await workbench.sendMessage(input);
    },

    async stopWorkbenchSession(_workspaceId: string, input: TaskWorkbenchTabInput): Promise<void> {
      await workbench.stopAgent(input);
    },

    async closeWorkbenchSession(_workspaceId: string, input: TaskWorkbenchTabInput): Promise<void> {
      await workbench.closeTab(input);
    },

    async publishWorkbenchPr(_workspaceId: string, input: TaskWorkbenchSelectInput): Promise<void> {
      await workbench.publishPr(input);
    },

    async revertWorkbenchFile(_workspaceId: string, input: TaskWorkbenchDiffInput): Promise<void> {
      await workbench.revertFile(input);
    },

    async health(): Promise<{ ok: true }> {
      return { ok: true };
    },

    async useWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
      return { workspaceId };
    },

    async starSandboxAgentRepo(): Promise<StarSandboxAgentRepoResult> {
      return {
        repo: "rivet-dev/sandbox-agent",
        starredAt: nowMs(),
      };
    },
  };
}
