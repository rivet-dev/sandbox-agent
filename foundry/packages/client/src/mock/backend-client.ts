import type {
  AddRepoInput,
  CreateHandoffInput,
  FoundryAppSnapshot,
  HandoffRecord,
  HandoffSummary,
  HandoffWorkbenchChangeModelInput,
  HandoffWorkbenchCreateHandoffInput,
  HandoffWorkbenchCreateHandoffResponse,
  HandoffWorkbenchDiffInput,
  HandoffWorkbenchRenameInput,
  HandoffWorkbenchRenameSessionInput,
  HandoffWorkbenchSelectInput,
  HandoffWorkbenchSetSessionUnreadInput,
  HandoffWorkbenchSendMessageInput,
  HandoffWorkbenchSnapshot,
  HandoffWorkbenchTabInput,
  HandoffWorkbenchUpdateDraftInput,
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

function mockCwd(repoLabel: string, handoffId: string): string {
  return `/mock/${repoLabel.replace(/\//g, "-")}/${handoffId}`;
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

function toHandoffStatus(status: HandoffRecord["status"], archived: boolean): HandoffRecord["status"] {
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

  const requireHandoff = (handoffId: string) => {
    const handoff = workbench.getSnapshot().handoffs.find((candidate) => candidate.id === handoffId);
    if (!handoff) {
      throw new Error(`Unknown mock handoff ${handoffId}`);
    }
    return handoff;
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

  const buildHandoffRecord = (handoffId: string): HandoffRecord => {
    const handoff = requireHandoff(handoffId);
    const cwd = mockCwd(handoff.repoName, handoff.id);
    const archived = handoff.status === "archived";
    return {
      workspaceId: defaultWorkspaceId,
      repoId: handoff.repoId,
      repoRemote: mockRepoRemote(handoff.repoName),
      handoffId: handoff.id,
      branchName: handoff.branch,
      title: handoff.title,
      task: handoff.title,
      providerId: "local",
      status: toHandoffStatus(archived ? "archived" : "running", archived),
      statusMessage: archived ? "archived" : "mock sandbox ready",
      activeSandboxId: handoff.id,
      activeSessionId: handoff.tabs[0]?.sessionId ?? null,
      sandboxes: [
        {
          sandboxId: handoff.id,
          providerId: "local",
          sandboxActorId: "mock-sandbox",
          switchTarget: `mock://${handoff.id}`,
          cwd,
          createdAt: handoff.updatedAtMs,
          updatedAt: handoff.updatedAtMs,
        },
      ],
      agentType: handoff.tabs[0]?.agent === "Codex" ? "codex" : "claude",
      prSubmitted: Boolean(handoff.pullRequest),
      diffStat: handoff.fileChanges.length > 0 ? `+${handoff.fileChanges.length}/-${handoff.fileChanges.length}` : "+0/-0",
      prUrl: handoff.pullRequest ? `https://example.test/pr/${handoff.pullRequest.number}` : null,
      prAuthor: handoff.pullRequest ? "mock" : null,
      ciStatus: null,
      reviewStatus: null,
      reviewer: null,
      conflictsWithMain: "0",
      hasUnpushed: handoff.fileChanges.length > 0 ? "1" : "0",
      parentBranch: null,
      createdAt: handoff.updatedAtMs,
      updatedAt: handoff.updatedAtMs,
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

    async createHandoff(_input: CreateHandoffInput): Promise<HandoffRecord> {
      notSupported("createHandoff");
    },

    async listHandoffs(_workspaceId: string, repoId?: string): Promise<HandoffSummary[]> {
      return workbench
        .getSnapshot()
        .handoffs.filter((handoff) => !repoId || handoff.repoId === repoId)
        .map((handoff) => ({
          workspaceId: defaultWorkspaceId,
          repoId: handoff.repoId,
          handoffId: handoff.id,
          branchName: handoff.branch,
          title: handoff.title,
          status: handoff.status === "archived" ? "archived" : "running",
          updatedAt: handoff.updatedAtMs,
        }));
    },

    async getRepoOverview(_workspaceId: string, _repoId: string): Promise<RepoOverview> {
      notSupported("getRepoOverview");
    },

    async runRepoStackAction(_input: RepoStackActionInput): Promise<RepoStackActionResult> {
      notSupported("runRepoStackAction");
    },

    async getHandoff(_workspaceId: string, handoffId: string): Promise<HandoffRecord> {
      return buildHandoffRecord(handoffId);
    },

    async listHistory(_input: HistoryQueryInput): Promise<HistoryEvent[]> {
      return [];
    },

    async switchHandoff(_workspaceId: string, handoffId: string): Promise<SwitchResult> {
      return {
        workspaceId: defaultWorkspaceId,
        handoffId,
        providerId: "local",
        switchTarget: `mock://${handoffId}`,
      };
    },

    async attachHandoff(_workspaceId: string, handoffId: string): Promise<{ target: string; sessionId: string | null }> {
      return {
        target: `mock://${handoffId}`,
        sessionId: requireHandoff(handoffId).tabs[0]?.sessionId ?? null,
      };
    },

    async runAction(_workspaceId: string, _handoffId: string): Promise<void> {
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
      const handoff = requireHandoff(input.sandboxId);
      const processes = ensureProcessList(input.sandboxId);
      const created = createProcessRecord(input.sandboxId, mockCwd(handoff.repoName, handoff.id), input.request);
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

    async getWorkbench(): Promise<HandoffWorkbenchSnapshot> {
      return workbench.getSnapshot();
    },

    subscribeWorkbench(_workspaceId: string, listener: () => void): () => void {
      return workbench.subscribe(listener);
    },

    async createWorkbenchHandoff(_workspaceId: string, input: HandoffWorkbenchCreateHandoffInput): Promise<HandoffWorkbenchCreateHandoffResponse> {
      return await workbench.createHandoff(input);
    },

    async markWorkbenchUnread(_workspaceId: string, input: HandoffWorkbenchSelectInput): Promise<void> {
      await workbench.markHandoffUnread(input);
    },

    async renameWorkbenchHandoff(_workspaceId: string, input: HandoffWorkbenchRenameInput): Promise<void> {
      await workbench.renameHandoff(input);
    },

    async renameWorkbenchBranch(_workspaceId: string, input: HandoffWorkbenchRenameInput): Promise<void> {
      await workbench.renameBranch(input);
    },

    async createWorkbenchSession(_workspaceId: string, input: HandoffWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }> {
      return await workbench.addTab(input);
    },

    async renameWorkbenchSession(_workspaceId: string, input: HandoffWorkbenchRenameSessionInput): Promise<void> {
      await workbench.renameSession(input);
    },

    async setWorkbenchSessionUnread(_workspaceId: string, input: HandoffWorkbenchSetSessionUnreadInput): Promise<void> {
      await workbench.setSessionUnread(input);
    },

    async updateWorkbenchDraft(_workspaceId: string, input: HandoffWorkbenchUpdateDraftInput): Promise<void> {
      await workbench.updateDraft(input);
    },

    async changeWorkbenchModel(_workspaceId: string, input: HandoffWorkbenchChangeModelInput): Promise<void> {
      await workbench.changeModel(input);
    },

    async sendWorkbenchMessage(_workspaceId: string, input: HandoffWorkbenchSendMessageInput): Promise<void> {
      await workbench.sendMessage(input);
    },

    async stopWorkbenchSession(_workspaceId: string, input: HandoffWorkbenchTabInput): Promise<void> {
      await workbench.stopAgent(input);
    },

    async closeWorkbenchSession(_workspaceId: string, input: HandoffWorkbenchTabInput): Promise<void> {
      await workbench.closeTab(input);
    },

    async publishWorkbenchPr(_workspaceId: string, input: HandoffWorkbenchSelectInput): Promise<void> {
      await workbench.publishPr(input);
    },

    async revertWorkbenchFile(_workspaceId: string, input: HandoffWorkbenchDiffInput): Promise<void> {
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
