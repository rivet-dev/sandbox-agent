export type WorkbenchHandoffStatus = "running" | "idle" | "new" | "archived";
export type WorkbenchAgentKind = "Claude" | "Codex" | "Cursor";
export type WorkbenchModelId = "claude-sonnet-4" | "claude-opus-4" | "gpt-4o" | "o3";

export interface WorkbenchTranscriptEvent {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: "client" | "agent";
  payload: unknown;
}

export interface WorkbenchComposerDraft {
  text: string;
  attachments: WorkbenchLineAttachment[];
  updatedAtMs: number | null;
}

export interface WorkbenchAgentTab {
  id: string;
  sessionId: string | null;
  sessionName: string;
  agent: WorkbenchAgentKind;
  model: WorkbenchModelId;
  status: "running" | "idle" | "error";
  thinkingSinceMs: number | null;
  unread: boolean;
  created: boolean;
  draft: WorkbenchComposerDraft;
  transcript: WorkbenchTranscriptEvent[];
}

export interface WorkbenchFileChange {
  path: string;
  added: number;
  removed: number;
  type: "M" | "A" | "D";
}

export interface WorkbenchFileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: WorkbenchFileTreeNode[];
}

export interface WorkbenchLineAttachment {
  id: string;
  filePath: string;
  lineNumber: number;
  lineContent: string;
}

export interface WorkbenchHistoryEvent {
  id: string;
  messageId: string;
  preview: string;
  sessionName: string;
  tabId: string;
  createdAtMs: number;
  detail: string;
}

export type WorkbenchDiffLineKind = "context" | "add" | "remove" | "hunk";

export interface WorkbenchParsedDiffLine {
  kind: WorkbenchDiffLineKind;
  lineNumber: number;
  text: string;
}

export interface WorkbenchPullRequestSummary {
  number: number;
  status: "draft" | "ready";
}

export interface WorkbenchHandoff {
  id: string;
  repoId: string;
  title: string;
  status: WorkbenchHandoffStatus;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkbenchPullRequestSummary | null;
  tabs: WorkbenchAgentTab[];
  fileChanges: WorkbenchFileChange[];
  diffs: Record<string, string>;
  fileTree: WorkbenchFileTreeNode[];
}

export interface WorkbenchRepo {
  id: string;
  label: string;
}

export interface WorkbenchProjectSection {
  id: string;
  label: string;
  updatedAtMs: number;
  handoffs: WorkbenchHandoff[];
}

export interface HandoffWorkbenchSnapshot {
  workspaceId: string;
  repos: WorkbenchRepo[];
  projects: WorkbenchProjectSection[];
  handoffs: WorkbenchHandoff[];
}

export interface WorkbenchModelOption {
  id: WorkbenchModelId;
  label: string;
}

export interface WorkbenchModelGroup {
  provider: string;
  models: WorkbenchModelOption[];
}

export interface HandoffWorkbenchSelectInput {
  handoffId: string;
}

export interface HandoffWorkbenchCreateHandoffInput {
  repoId: string;
  task: string;
  title?: string;
  branch?: string;
  model?: WorkbenchModelId;
}

export interface HandoffWorkbenchRenameInput {
  handoffId: string;
  value: string;
}

export interface HandoffWorkbenchSendMessageInput {
  handoffId: string;
  tabId: string;
  text: string;
  attachments: WorkbenchLineAttachment[];
}

export interface HandoffWorkbenchTabInput {
  handoffId: string;
  tabId: string;
}

export interface HandoffWorkbenchRenameSessionInput extends HandoffWorkbenchTabInput {
  title: string;
}

export interface HandoffWorkbenchChangeModelInput extends HandoffWorkbenchTabInput {
  model: WorkbenchModelId;
}

export interface HandoffWorkbenchUpdateDraftInput extends HandoffWorkbenchTabInput {
  text: string;
  attachments: WorkbenchLineAttachment[];
}

export interface HandoffWorkbenchSetSessionUnreadInput extends HandoffWorkbenchTabInput {
  unread: boolean;
}

export interface HandoffWorkbenchDiffInput {
  handoffId: string;
  path: string;
}

export interface HandoffWorkbenchCreateHandoffResponse {
  handoffId: string;
  tabId?: string;
}

export interface HandoffWorkbenchAddTabResponse {
  tabId: string;
}
