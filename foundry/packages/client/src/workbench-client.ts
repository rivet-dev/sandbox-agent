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
import type { BackendClient } from "./backend-client.js";
import { getSharedMockWorkbenchClient } from "./mock/workbench-client.js";
import { createRemoteWorkbenchClient } from "./remote/workbench-client.js";

export type HandoffWorkbenchClientMode = "mock" | "remote";

export interface CreateHandoffWorkbenchClientOptions {
  mode: HandoffWorkbenchClientMode;
  backend?: BackendClient;
  workspaceId?: string;
}

export interface HandoffWorkbenchClient {
  getSnapshot(): HandoffWorkbenchSnapshot;
  subscribe(listener: () => void): () => void;
  createHandoff(input: HandoffWorkbenchCreateHandoffInput): Promise<HandoffWorkbenchCreateHandoffResponse>;
  markHandoffUnread(input: HandoffWorkbenchSelectInput): Promise<void>;
  renameHandoff(input: HandoffWorkbenchRenameInput): Promise<void>;
  renameBranch(input: HandoffWorkbenchRenameInput): Promise<void>;
  archiveHandoff(input: HandoffWorkbenchSelectInput): Promise<void>;
  publishPr(input: HandoffWorkbenchSelectInput): Promise<void>;
  revertFile(input: HandoffWorkbenchDiffInput): Promise<void>;
  updateDraft(input: HandoffWorkbenchUpdateDraftInput): Promise<void>;
  sendMessage(input: HandoffWorkbenchSendMessageInput): Promise<void>;
  stopAgent(input: HandoffWorkbenchTabInput): Promise<void>;
  setSessionUnread(input: HandoffWorkbenchSetSessionUnreadInput): Promise<void>;
  renameSession(input: HandoffWorkbenchRenameSessionInput): Promise<void>;
  closeTab(input: HandoffWorkbenchTabInput): Promise<void>;
  addTab(input: HandoffWorkbenchSelectInput): Promise<HandoffWorkbenchAddTabResponse>;
  changeModel(input: HandoffWorkbenchChangeModelInput): Promise<void>;
}

export function createHandoffWorkbenchClient(options: CreateHandoffWorkbenchClientOptions): HandoffWorkbenchClient {
  if (options.mode === "mock") {
    return getSharedMockWorkbenchClient();
  }

  if (!options.backend) {
    throw new Error("Remote handoff workbench client requires a backend client");
  }
  if (!options.workspaceId) {
    throw new Error("Remote handoff workbench client requires a workspace id");
  }

  return createRemoteWorkbenchClient({
    backend: options.backend,
    workspaceId: options.workspaceId,
  });
}
