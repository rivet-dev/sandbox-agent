export type WorkbenchTaskStatus = "running" | "idle" | "new" | "archived";
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

export interface WorkbenchTask {
  id: string;
  repoId: string;
  title: string;
  status: WorkbenchTaskStatus;
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
  tasks: WorkbenchTask[];
}

export interface TaskWorkbenchSnapshot {
  workspaceId: string;
  repos: WorkbenchRepo[];
  projects: WorkbenchProjectSection[];
  tasks: WorkbenchTask[];
}

export interface WorkbenchModelOption {
  id: WorkbenchModelId;
  label: string;
}

export interface WorkbenchModelGroup {
  provider: string;
  models: WorkbenchModelOption[];
}

export interface TaskWorkbenchSelectInput {
  taskId: string;
}

export interface TaskWorkbenchCreateTaskInput {
  repoId: string;
  task: string;
  title?: string;
  branch?: string;
  model?: WorkbenchModelId;
}

export interface TaskWorkbenchRenameInput {
  taskId: string;
  value: string;
}

export interface TaskWorkbenchSendMessageInput {
  taskId: string;
  tabId: string;
  text: string;
  attachments: WorkbenchLineAttachment[];
}

export interface TaskWorkbenchTabInput {
  taskId: string;
  tabId: string;
}

export interface TaskWorkbenchRenameSessionInput extends TaskWorkbenchTabInput {
  title: string;
}

export interface TaskWorkbenchChangeModelInput extends TaskWorkbenchTabInput {
  model: WorkbenchModelId;
}

export interface TaskWorkbenchUpdateDraftInput extends TaskWorkbenchTabInput {
  text: string;
  attachments: WorkbenchLineAttachment[];
}

export interface TaskWorkbenchSetSessionUnreadInput extends TaskWorkbenchTabInput {
  unread: boolean;
}

export interface TaskWorkbenchDiffInput {
  taskId: string;
  path: string;
}

export interface TaskWorkbenchCreateTaskResponse {
  taskId: string;
  tabId?: string;
}

export interface TaskWorkbenchAddTabResponse {
  tabId: string;
}
