import type {
  HandoffWorkbenchAddTabResponse,
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
} from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "../backend-client.js";
import { groupWorkbenchProjects } from "../workbench-model.js";
import type { HandoffWorkbenchClient } from "../workbench-client.js";

export interface RemoteWorkbenchClientOptions {
  backend: BackendClient;
  workspaceId: string;
}

class RemoteWorkbenchStore implements HandoffWorkbenchClient {
  private readonly backend: BackendClient;
  private readonly workspaceId: string;
  private snapshot: HandoffWorkbenchSnapshot;
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
      handoffs: [],
    };
  }

  getSnapshot(): HandoffWorkbenchSnapshot {
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

  async createHandoff(input: HandoffWorkbenchCreateHandoffInput): Promise<HandoffWorkbenchCreateHandoffResponse> {
    const created = await this.backend.createWorkbenchHandoff(this.workspaceId, input);
    await this.refresh();
    return created;
  }

  async markHandoffUnread(input: HandoffWorkbenchSelectInput): Promise<void> {
    await this.backend.markWorkbenchUnread(this.workspaceId, input);
    await this.refresh();
  }

  async renameHandoff(input: HandoffWorkbenchRenameInput): Promise<void> {
    await this.backend.renameWorkbenchHandoff(this.workspaceId, input);
    await this.refresh();
  }

  async renameBranch(input: HandoffWorkbenchRenameInput): Promise<void> {
    await this.backend.renameWorkbenchBranch(this.workspaceId, input);
    await this.refresh();
  }

  async archiveHandoff(input: HandoffWorkbenchSelectInput): Promise<void> {
    await this.backend.runAction(this.workspaceId, input.handoffId, "archive");
    await this.refresh();
  }

  async publishPr(input: HandoffWorkbenchSelectInput): Promise<void> {
    await this.backend.publishWorkbenchPr(this.workspaceId, input);
    await this.refresh();
  }

  async revertFile(input: HandoffWorkbenchDiffInput): Promise<void> {
    await this.backend.revertWorkbenchFile(this.workspaceId, input);
    await this.refresh();
  }

  async updateDraft(input: HandoffWorkbenchUpdateDraftInput): Promise<void> {
    await this.backend.updateWorkbenchDraft(this.workspaceId, input);
    await this.refresh();
  }

  async sendMessage(input: HandoffWorkbenchSendMessageInput): Promise<void> {
    await this.backend.sendWorkbenchMessage(this.workspaceId, input);
    await this.refresh();
  }

  async stopAgent(input: HandoffWorkbenchTabInput): Promise<void> {
    await this.backend.stopWorkbenchSession(this.workspaceId, input);
    await this.refresh();
  }

  async setSessionUnread(input: HandoffWorkbenchSetSessionUnreadInput): Promise<void> {
    await this.backend.setWorkbenchSessionUnread(this.workspaceId, input);
    await this.refresh();
  }

  async renameSession(input: HandoffWorkbenchRenameSessionInput): Promise<void> {
    await this.backend.renameWorkbenchSession(this.workspaceId, input);
    await this.refresh();
  }

  async closeTab(input: HandoffWorkbenchTabInput): Promise<void> {
    await this.backend.closeWorkbenchSession(this.workspaceId, input);
    await this.refresh();
  }

  async addTab(input: HandoffWorkbenchSelectInput): Promise<HandoffWorkbenchAddTabResponse> {
    const created = await this.backend.createWorkbenchSession(this.workspaceId, input);
    await this.refresh();
    return created;
  }

  async changeModel(input: HandoffWorkbenchChangeModelInput): Promise<void> {
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
        projects: nextSnapshot.projects ?? groupWorkbenchProjects(nextSnapshot.repos, nextSnapshot.handoffs),
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

export function createRemoteWorkbenchClient(options: RemoteWorkbenchClientOptions): HandoffWorkbenchClient {
  return new RemoteWorkbenchStore(options);
}
