import type {
  TaskWorkbenchAddTabResponse,
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
} from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "../backend-client.js";
import { groupWorkbenchProjects } from "../workbench-model.js";
import type { TaskWorkbenchClient } from "../workbench-client.js";

export interface RemoteWorkbenchClientOptions {
  backend: BackendClient;
  workspaceId: string;
}

class RemoteWorkbenchStore implements TaskWorkbenchClient {
  private readonly backend: BackendClient;
  private readonly workspaceId: string;
  private snapshot: TaskWorkbenchSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeWorkbench: (() => void) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteWorkbenchClientOptions) {
    this.backend = options.backend;
    this.workspaceId = options.workspaceId;
    this.snapshot = {
      workspaceId: options.workspaceId,
      repos: [],
      projects: [],
      tasks: [],
    };
  }

  getSnapshot(): TaskWorkbenchSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.ensureStarted();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.refreshRetryTimeout) {
        clearTimeout(this.refreshRetryTimeout);
        this.refreshRetryTimeout = null;
      }
      if (this.listeners.size === 0 && this.unsubscribeWorkbench) {
        this.unsubscribeWorkbench();
        this.unsubscribeWorkbench = null;
      }
    };
  }

  async createTask(input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse> {
    const created = await this.backend.createWorkbenchTask(this.workspaceId, input);
    await this.refresh();
    return created;
  }

  async markTaskUnread(input: TaskWorkbenchSelectInput): Promise<void> {
    await this.backend.markWorkbenchUnread(this.workspaceId, input);
    await this.refresh();
  }

  async renameTask(input: TaskWorkbenchRenameInput): Promise<void> {
    await this.backend.renameWorkbenchTask(this.workspaceId, input);
    await this.refresh();
  }

  async renameBranch(input: TaskWorkbenchRenameInput): Promise<void> {
    await this.backend.renameWorkbenchBranch(this.workspaceId, input);
    await this.refresh();
  }

  async archiveTask(input: TaskWorkbenchSelectInput): Promise<void> {
    await this.backend.runAction(this.workspaceId, input.taskId, "archive");
    await this.refresh();
  }

  async publishPr(input: TaskWorkbenchSelectInput): Promise<void> {
    await this.backend.publishWorkbenchPr(this.workspaceId, input);
    await this.refresh();
  }

  async revertFile(input: TaskWorkbenchDiffInput): Promise<void> {
    await this.backend.revertWorkbenchFile(this.workspaceId, input);
    await this.refresh();
  }

  async updateDraft(input: TaskWorkbenchUpdateDraftInput): Promise<void> {
    await this.backend.updateWorkbenchDraft(this.workspaceId, input);
    await this.refresh();
  }

  async sendMessage(input: TaskWorkbenchSendMessageInput): Promise<void> {
    await this.backend.sendWorkbenchMessage(this.workspaceId, input);
    await this.refresh();
  }

  async stopAgent(input: TaskWorkbenchTabInput): Promise<void> {
    await this.backend.stopWorkbenchSession(this.workspaceId, input);
    await this.refresh();
  }

  async setSessionUnread(input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
    await this.backend.setWorkbenchSessionUnread(this.workspaceId, input);
    await this.refresh();
  }

  async renameSession(input: TaskWorkbenchRenameSessionInput): Promise<void> {
    await this.backend.renameWorkbenchSession(this.workspaceId, input);
    await this.refresh();
  }

  async closeTab(input: TaskWorkbenchTabInput): Promise<void> {
    await this.backend.closeWorkbenchSession(this.workspaceId, input);
    await this.refresh();
  }

  async addTab(input: TaskWorkbenchSelectInput): Promise<TaskWorkbenchAddTabResponse> {
    const created = await this.backend.createWorkbenchSession(this.workspaceId, input);
    await this.refresh();
    return created;
  }

  async changeModel(input: TaskWorkbenchChangeModelInput): Promise<void> {
    await this.backend.changeWorkbenchModel(this.workspaceId, input);
    await this.refresh();
  }

  private ensureStarted(): void {
    if (!this.unsubscribeWorkbench) {
      this.unsubscribeWorkbench = this.backend.subscribeWorkbench(this.workspaceId, () => {
        void this.refresh().catch(() => {
          this.scheduleRefreshRetry();
        });
      });
    }
    void this.refresh().catch(() => {
      this.scheduleRefreshRetry();
    });
  }

  private scheduleRefreshRetry(): void {
    if (this.refreshRetryTimeout || this.listeners.size === 0) {
      return;
    }

    this.refreshRetryTimeout = setTimeout(() => {
      this.refreshRetryTimeout = null;
      void this.refresh().catch(() => {
        this.scheduleRefreshRetry();
      });
    }, 1_000);
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      const nextSnapshot = await this.backend.getWorkbench(this.workspaceId);
      if (this.refreshRetryTimeout) {
        clearTimeout(this.refreshRetryTimeout);
        this.refreshRetryTimeout = null;
      }
      this.snapshot = {
        ...nextSnapshot,
        projects: nextSnapshot.projects ?? groupWorkbenchProjects(nextSnapshot.repos, nextSnapshot.tasks),
      };
      for (const listener of [...this.listeners]) {
        listener();
      }
    })().finally(() => {
      this.refreshPromise = null;
    });

    await this.refreshPromise;
  }
}

export function createRemoteWorkbenchClient(options: RemoteWorkbenchClientOptions): TaskWorkbenchClient {
  return new RemoteWorkbenchStore(options);
}
