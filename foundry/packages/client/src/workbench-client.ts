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
import type { BackendClient } from "./backend-client.js";
import { getSharedMockWorkbenchClient } from "./mock/workbench-client.js";
import { createRemoteWorkbenchClient } from "./remote/workbench-client.js";

export type TaskWorkbenchClientMode = "mock" | "remote";

export interface CreateTaskWorkbenchClientOptions {
  mode: TaskWorkbenchClientMode;
  backend?: BackendClient;
  workspaceId?: string;
}

export interface TaskWorkbenchClient {
  getSnapshot(): TaskWorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  createTask(input: TaskWorkbenchCreateTaskInput): Promise<TaskWorkbenchCreateTaskResponse>;
  markTaskUnread(input: TaskWorkbenchSelectInput): Promise<void>;
  renameTask(input: TaskWorkbenchRenameInput): Promise<void>;
  renameBranch(input: TaskWorkbenchRenameInput): Promise<void>;
  archiveTask(input: TaskWorkbenchSelectInput): Promise<void>;
  publishPr(input: TaskWorkbenchSelectInput): Promise<void>;
  revertFile(input: TaskWorkbenchDiffInput): Promise<void>;
  updateDraft(input: TaskWorkbenchUpdateDraftInput): Promise<void>;
  sendMessage(input: TaskWorkbenchSendMessageInput): Promise<void>;
  stopAgent(input: TaskWorkbenchTabInput): Promise<void>;
  setSessionUnread(input: TaskWorkbenchSetSessionUnreadInput): Promise<void>;
  renameSession(input: TaskWorkbenchRenameSessionInput): Promise<void>;
  closeTab(input: TaskWorkbenchTabInput): Promise<void>;
  addTab(input: TaskWorkbenchSelectInput): Promise<TaskWorkbenchAddTabResponse>;
  changeModel(input: TaskWorkbenchChangeModelInput): Promise<void>;
}

export function createTaskWorkbenchClient(options: CreateTaskWorkbenchClientOptions): TaskWorkbenchClient {
  if (options.mode === "mock") {
    return getSharedMockWorkbenchClient();
  }

  if (!options.backend) {
    throw new Error("Remote task workbench client requires a backend client");
  }
  if (!options.workspaceId) {
    throw new Error("Remote task workbench client requires a workspace id");
  }

  return createRemoteWorkbenchClient({
    backend: options.backend,
    workspaceId: options.workspaceId,
  });
}
