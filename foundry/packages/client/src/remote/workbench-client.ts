import type {
  TaskWorkbenchAddSessionResponse,
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
} from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "../backend-client.js";
import { groupWorkbenchRepositories } from "../workbench-model.js";
import type { TaskWorkbenchClient } from "../workbench-client.js";

export interface RemoteWorkbenchClientOptions {
  backend: BackendClient;
  organizationId: string;
}

class RemoteWorkbenchStore implements TaskWorkbenchClient {
  private readonly backend: BackendClient;
  private readonly organizationId: string;
  private snapshot: TaskWorkbenchSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeWorkbench: (() => void) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteWorkbenchClientOptions) {
    this.backend = options.backend;
    this.organizationId = options.organizationId;
    this.snapshot = {
      organizationId: options.organizationId,
      repos: [],
      repositories: [],
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
    const created = await this.backend.createWorkbenchTask(this.organizationId, input);
    await this.refresh();
    return created;
  }

  async markTaskUnread(input: TaskWorkbenchSelectInput): Promise<void> {
    await this.backend.markWorkbenchUnread(this.organizationId, input);
    await this.refresh();
  }

  async renameTask(input: TaskWorkbenchRenameInput): Promise<void> {
    await this.backend.renameWorkbenchTask(this.organizationId, input);
    await this.refresh();
  }

  async renameBranch(input: TaskWorkbenchRenameInput): Promise<void> {
    await this.backend.renameWorkbenchBranch(this.organizationId, input);
    await this.refresh();
  }

  async archiveTask(input: TaskWorkbenchSelectInput): Promise<void> {
    await this.backend.runAction(this.organizationId, input.taskId, "archive");
    await this.refresh();
  }

  async publishPr(input: TaskWorkbenchSelectInput): Promise<void> {
    await this.backend.publishWorkbenchPr(this.organizationId, input);
    await this.refresh();
  }

  async revertFile(input: TaskWorkbenchDiffInput): Promise<void> {
    await this.backend.revertWorkbenchFile(this.organizationId, input);
    await this.refresh();
  }

  async updateDraft(input: TaskWorkbenchUpdateDraftInput): Promise<void> {
    await this.backend.updateWorkbenchDraft(this.organizationId, input);
    // Skip refresh — the server broadcast will trigger it, and the frontend
    // holds local draft state to avoid the round-trip overwriting user input.
  }

  async sendMessage(input: TaskWorkbenchSendMessageInput): Promise<void> {
    await this.backend.sendWorkbenchMessage(this.organizationId, input);
    await this.refresh();
  }

  async stopAgent(input: TaskWorkbenchSessionInput): Promise<void> {
    await this.backend.stopWorkbenchSession(this.organizationId, input);
    await this.refresh();
  }

  async setSessionUnread(input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
    await this.backend.setWorkbenchSessionUnread(this.organizationId, input);
    await this.refresh();
  }

  async renameSession(input: TaskWorkbenchRenameSessionInput): Promise<void> {
    await this.backend.renameWorkbenchSession(this.organizationId, input);
    await this.refresh();
  }

  async closeSession(input: TaskWorkbenchSessionInput): Promise<void> {
    await this.backend.closeWorkbenchSession(this.organizationId, input);
    await this.refresh();
  }

  async addSession(input: TaskWorkbenchSelectInput): Promise<TaskWorkbenchAddSessionResponse> {
    const created = await this.backend.createWorkbenchSession(this.organizationId, input);
    await this.refresh();
    return created;
  }

  async changeModel(input: TaskWorkbenchChangeModelInput): Promise<void> {
    await this.backend.changeWorkbenchModel(this.organizationId, input);
    await this.refresh();
  }

  private ensureStarted(): void {
    if (!this.unsubscribeWorkbench) {
      this.unsubscribeWorkbench = this.backend.subscribeWorkbench(this.organizationId, () => {
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
      const nextSnapshot = await this.backend.getWorkbench(this.organizationId);
      if (this.refreshRetryTimeout) {
        clearTimeout(this.refreshRetryTimeout);
        this.refreshRetryTimeout = null;
      }
      this.snapshot = {
        ...nextSnapshot,
        repositories: nextSnapshot.repositories ?? groupWorkbenchRepositories(nextSnapshot.repos, nextSnapshot.tasks),
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
