import {
  MODEL_GROUPS,
  buildInitialMockLayoutViewModel,
  groupWorkbenchProjects,
  nowMs,
  providerAgent,
  randomReply,
  removeFileTreePath,
  slugify,
  uid,
} from "../workbench-model.js";
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
  WorkbenchAgentTab as AgentTab,
  WorkbenchTask as Task,
  WorkbenchTranscriptEvent as TranscriptEvent,
} from "@sandbox-agent/foundry-shared";
import type { TaskWorkbenchClient } from "../workbench-client.js";

function buildTranscriptEvent(params: {
  sessionId: string;
  sender: "client" | "agent";
  createdAt: number;
  payload: unknown;
  eventIndex: number;
}): TranscriptEvent {
  return {
    id: uid(),
    sessionId: params.sessionId,
    sender: params.sender,
    createdAt: params.createdAt,
    payload: params.payload,
    connectionId: "mock-connection",
    eventIndex: params.eventIndex,
  };
}

class MockWorkbenchStore implements TaskWorkbenchClient {
  private snapshot = buildInitialMockLayoutViewModel();
  private listeners = new Set<() => void>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getSnapshot(): TaskWorkbenchSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async createTask(input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse> {
    const id = uid();
    const tabId = `session-${id}`;
    const repo = this.snapshot.repos.find((candidate) => candidate.id === input.repoId);
    if (!repo) {
      throw new Error(`Cannot create mock task for unknown repo ${input.repoId}`);
    }
    const nextTask: Task = {
      id,
      repoId: repo.id,
      title: input.title?.trim() || "New Task",
      status: "new",
      repoName: repo.label,
      updatedAtMs: nowMs(),
      branch: input.branch?.trim() || null,
      pullRequest: null,
      tabs: [
        {
          id: tabId,
          sessionId: tabId,
          sessionName: "Session 1",
          agent: providerAgent(
            MODEL_GROUPS.find((group) => group.models.some((model) => model.id === (input.model ?? "claude-sonnet-4")))?.provider ?? "Claude",
          ),
          model: input.model ?? "claude-sonnet-4",
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: false,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: [],
        },
      ],
      fileChanges: [],
      diffs: {},
      fileTree: [],
    };

    this.updateState((current) => ({
      ...current,
      tasks: [nextTask, ...current.tasks],
    }));
    return { taskId: id, tabId };
  }

  async markTaskUnread(input: TaskWorkbenchSelectInput): Promise<void> {
    this.updateTask(input.taskId, (task) => {
      const targetTab = task.tabs[task.tabs.length - 1] ?? null;
      if (!targetTab) {
        return task;
      }

      return {
        ...task,
        tabs: task.tabs.map((tab) => (tab.id === targetTab.id ? { ...tab, unread: true } : tab)),
      };
    });
  }

  async renameTask(input: TaskWorkbenchRenameInput): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      throw new Error(`Cannot rename task ${input.taskId} to an empty title`);
    }
    this.updateTask(input.taskId, (task) => ({ ...task, title: value, updatedAtMs: nowMs() }));
  }

  async renameBranch(input: TaskWorkbenchRenameInput): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      throw new Error(`Cannot rename branch for task ${input.taskId} to an empty value`);
    }
    this.updateTask(input.taskId, (task) => ({ ...task, branch: value, updatedAtMs: nowMs() }));
  }

  async archiveTask(input: TaskWorkbenchSelectInput): Promise<void> {
    this.updateTask(input.taskId, (task) => ({ ...task, status: "archived", updatedAtMs: nowMs() }));
  }

  async publishPr(input: TaskWorkbenchSelectInput): Promise<void> {
    const nextPrNumber = Math.max(0, ...this.snapshot.tasks.map((task) => task.pullRequest?.number ?? 0)) + 1;
    this.updateTask(input.taskId, (task) => ({
      ...task,
      updatedAtMs: nowMs(),
      pullRequest: { number: nextPrNumber, status: "ready" },
    }));
  }

  async revertFile(input: TaskWorkbenchDiffInput): Promise<void> {
    this.updateTask(input.taskId, (task) => {
      const file = task.fileChanges.find((entry) => entry.path === input.path);
      const nextDiffs = { ...task.diffs };
      delete nextDiffs[input.path];

      return {
        ...task,
        fileChanges: task.fileChanges.filter((entry) => entry.path !== input.path),
        diffs: nextDiffs,
        fileTree: file?.type === "A" ? removeFileTreePath(task.fileTree, input.path) : task.fileTree,
      };
    });
  }

  async updateDraft(input: TaskWorkbenchUpdateDraftInput): Promise<void> {
    this.assertTab(input.taskId, input.tabId);
    this.updateTask(input.taskId, (task) => ({
      ...task,
      updatedAtMs: nowMs(),
      tabs: task.tabs.map((tab) =>
        tab.id === input.tabId
          ? {
              ...tab,
              draft: {
                text: input.text,
                attachments: input.attachments,
                updatedAtMs: nowMs(),
              },
            }
          : tab,
      ),
    }));
  }

  async sendMessage(input: TaskWorkbenchSendMessageInput): Promise<void> {
    const text = input.text.trim();
    if (!text) {
      throw new Error(`Cannot send an empty mock prompt for task ${input.taskId}`);
    }

    this.assertTab(input.taskId, input.tabId);
    const startedAtMs = nowMs();

    this.updateTask(input.taskId, (currentTask) => {
      const isFirstOnTask = currentTask.status === "new";
      const newTitle = isFirstOnTask ? (text.length > 50 ? `${text.slice(0, 47)}...` : text) : currentTask.title;
      const newBranch = isFirstOnTask ? `feat/${slugify(newTitle)}` : currentTask.branch;
      const userMessageLines = [text, ...input.attachments.map((attachment) => `@ ${attachment.filePath}:${attachment.lineNumber}`)];
      const userEvent = buildTranscriptEvent({
        sessionId: input.tabId,
        sender: "client",
        createdAt: startedAtMs,
        eventIndex: candidateEventIndex(currentTask, input.tabId),
        payload: {
          method: "session/prompt",
          params: {
            prompt: userMessageLines.map((line) => ({ type: "text", text: line })),
          },
        },
      });

      return {
        ...currentTask,
        title: newTitle,
        branch: newBranch,
        status: "running",
        updatedAtMs: startedAtMs,
        tabs: currentTask.tabs.map((candidate) =>
          candidate.id === input.tabId
            ? {
                ...candidate,
                created: true,
                status: "running",
                unread: false,
                thinkingSinceMs: startedAtMs,
                draft: { text: "", attachments: [], updatedAtMs: startedAtMs },
                transcript: [...candidate.transcript, userEvent],
              }
            : candidate,
        ),
      };
    });

    const existingTimer = this.pendingTimers.get(input.tabId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const task = this.requireTask(input.taskId);
      const replyTab = this.requireTab(task, input.tabId);
      const completedAtMs = nowMs();
      const replyEvent = buildTranscriptEvent({
        sessionId: input.tabId,
        sender: "agent",
        createdAt: completedAtMs,
        eventIndex: candidateEventIndex(task, input.tabId),
        payload: {
          result: {
            text: randomReply(),
            durationMs: completedAtMs - startedAtMs,
          },
        },
      });

      this.updateTask(input.taskId, (currentTask) => {
        const updatedTabs = currentTask.tabs.map((candidate) => {
          if (candidate.id !== input.tabId) {
            return candidate;
          }

          return {
            ...candidate,
            status: "idle" as const,
            thinkingSinceMs: null,
            unread: true,
            transcript: [...candidate.transcript, replyEvent],
          };
        });
        const anyRunning = updatedTabs.some((candidate) => candidate.status === "running");

        return {
          ...currentTask,
          updatedAtMs: completedAtMs,
          tabs: updatedTabs,
          status: currentTask.status === "archived" ? "archived" : anyRunning ? "running" : "idle",
        };
      });

      this.pendingTimers.delete(input.tabId);
    }, 2_500);

    this.pendingTimers.set(input.tabId, timer);
  }

  async stopAgent(input: TaskWorkbenchTabInput): Promise<void> {
    this.assertTab(input.taskId, input.tabId);
    const existing = this.pendingTimers.get(input.tabId);
    if (existing) {
      clearTimeout(existing);
      this.pendingTimers.delete(input.tabId);
    }

    this.updateTask(input.taskId, (currentTask) => {
      const updatedTabs = currentTask.tabs.map((candidate) =>
        candidate.id === input.tabId ? { ...candidate, status: "idle" as const, thinkingSinceMs: null } : candidate,
      );
      const anyRunning = updatedTabs.some((candidate) => candidate.status === "running");

      return {
        ...currentTask,
        updatedAtMs: nowMs(),
        tabs: updatedTabs,
        status: currentTask.status === "archived" ? "archived" : anyRunning ? "running" : "idle",
      };
    });
  }

  async setSessionUnread(input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      tabs: currentTask.tabs.map((candidate) => (candidate.id === input.tabId ? { ...candidate, unread: input.unread } : candidate)),
    }));
  }

  async renameSession(input: TaskWorkbenchRenameSessionInput): Promise<void> {
    const title = input.title.trim();
    if (!title) {
      throw new Error(`Cannot rename session ${input.tabId} to an empty title`);
    }
    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      tabs: currentTask.tabs.map((candidate) => (candidate.id === input.tabId ? { ...candidate, sessionName: title } : candidate)),
    }));
  }

  async closeTab(input: TaskWorkbenchTabInput): Promise<void> {
    this.updateTask(input.taskId, (currentTask) => {
      if (currentTask.tabs.length <= 1) {
        return currentTask;
      }

      return {
        ...currentTask,
        tabs: currentTask.tabs.filter((candidate) => candidate.id !== input.tabId),
      };
    });
  }

  async addTab(input: TaskWorkbenchSelectInput): Promise<TaskWorkbenchAddTabResponse> {
    this.assertTask(input.taskId);
    const nextTab: AgentTab = {
      id: uid(),
      sessionId: null,
      sessionName: `Session ${this.requireTask(input.taskId).tabs.length + 1}`,
      agent: "Claude",
      model: "claude-sonnet-4",
      status: "idle",
      thinkingSinceMs: null,
      unread: false,
      created: false,
      draft: { text: "", attachments: [], updatedAtMs: null },
      transcript: [],
    };

    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      updatedAtMs: nowMs(),
      tabs: [...currentTask.tabs, nextTab],
    }));
    return { tabId: nextTab.id };
  }

  async changeModel(input: TaskWorkbenchChangeModelInput): Promise<void> {
    const group = MODEL_GROUPS.find((candidate) => candidate.models.some((entry) => entry.id === input.model));
    if (!group) {
      throw new Error(`Unable to resolve model provider for ${input.model}`);
    }

    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      tabs: currentTask.tabs.map((candidate) =>
        candidate.id === input.tabId ? { ...candidate, model: input.model, agent: providerAgent(group.provider) } : candidate,
      ),
    }));
  }

  private updateState(updater: (current: TaskWorkbenchSnapshot) => TaskWorkbenchSnapshot): void {
    const nextSnapshot = updater(this.snapshot);
    this.snapshot = {
      ...nextSnapshot,
      projects: groupWorkbenchProjects(nextSnapshot.repos, nextSnapshot.tasks),
    };
    this.notify();
  }

  private updateTask(taskId: string, updater: (task: Task) => Task): void {
    this.assertTask(taskId);
    this.updateState((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? updater(task) : task)),
    }));
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private assertTask(taskId: string): void {
    this.requireTask(taskId);
  }

  private assertTab(taskId: string, tabId: string): void {
    const task = this.requireTask(taskId);
    this.requireTab(task, tabId);
  }

  private requireTask(taskId: string): Task {
    const task = this.snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unable to find mock task ${taskId}`);
    }
    return task;
  }

  private requireTab(task: Task, tabId: string): AgentTab {
    const tab = task.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new Error(`Unable to find mock tab ${tabId} in task ${task.id}`);
    }
    return tab;
  }
}

function candidateEventIndex(task: Task, tabId: string): number {
  const tab = task.tabs.find((candidate) => candidate.id === tabId);
  return (tab?.transcript.length ?? 0) + 1;
}

let sharedMockWorkbenchClient: TaskWorkbenchClient | null = null;

export function getSharedMockWorkbenchClient(): TaskWorkbenchClient {
  if (!sharedMockWorkbenchClient) {
    sharedMockWorkbenchClient = new MockWorkbenchStore();
  }
  return sharedMockWorkbenchClient;
}
