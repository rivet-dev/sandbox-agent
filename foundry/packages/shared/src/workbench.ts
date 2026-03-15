import type { AgentType, SandboxProviderId, TaskStatus } from "./contracts.js";

export type WorkbenchTaskStatus = TaskStatus | "new";
export type WorkbenchAgentKind = "Claude" | "Codex" | "Cursor";
export type WorkbenchModelId =
  | "claude-sonnet-4"
  | "claude-opus-4"
  | "gpt-5.3-codex"
  | "gpt-5.4"
  | "gpt-5.2-codex"
  | "gpt-5.1-codex-max"
  | "gpt-5.2"
  | "gpt-5.1-codex-mini";
export type WorkbenchSessionStatus = "pending_provision" | "pending_session_create" | "ready" | "running" | "idle" | "error";

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

/** Session metadata without transcript content. */
export interface WorkbenchSessionSummary {
  id: string;
  /** Stable UI session id used for routing and task-local identity. */
  sessionId: string;
  /** Underlying sandbox session id when provisioning has completed. */
  sandboxSessionId?: string | null;
  sessionName: string;
  agent: WorkbenchAgentKind;
  model: WorkbenchModelId;
  status: WorkbenchSessionStatus;
  thinkingSinceMs: number | null;
  unread: boolean;
  created: boolean;
  errorMessage?: string | null;
}

/** Full session content — only fetched when viewing a specific session. */
export interface WorkbenchSessionDetail {
  /** Stable UI session id used for the session topic key and routing. */
  sessionId: string;
  sandboxSessionId: string | null;
  sessionName: string;
  agent: WorkbenchAgentKind;
  model: WorkbenchModelId;
  status: WorkbenchSessionStatus;
  thinkingSinceMs: number | null;
  unread: boolean;
  created: boolean;
  errorMessage?: string | null;
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
  sessionId: string;
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

export interface WorkbenchOpenPrSummary {
  prId: string;
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  isDraft: boolean;
  updatedAtMs: number;
}

export interface WorkbenchSandboxSummary {
  sandboxProviderId: SandboxProviderId;
  sandboxId: string;
  cwd: string | null;
}

/** Sidebar-level task data. Materialized in the organization actor's SQLite. */
export interface WorkbenchTaskSummary {
  id: string;
  repoId: string;
  title: string;
  status: WorkbenchTaskStatus;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkbenchPullRequestSummary | null;
  /** Summary of sessions — no transcript content. */
  sessionsSummary: WorkbenchSessionSummary[];
}

/** Full task detail — only fetched when viewing a specific task. */
export interface WorkbenchTaskDetail extends WorkbenchTaskSummary {
  /** Original task prompt/instructions shown in the detail view. */
  task: string;
  /** Agent choice used when creating new sandbox sessions for this task. */
  agentType: AgentType | null;
  /** Underlying task runtime status preserved for detail views and error handling. */
  runtimeStatus: TaskStatus;
  statusMessage: string | null;
  activeSessionId: string | null;
  diffStat: string | null;
  prUrl: string | null;
  reviewStatus: string | null;
  fileChanges: WorkbenchFileChange[];
  diffs: Record<string, string>;
  fileTree: WorkbenchFileTreeNode[];
  minutesUsed: number;
  /** Sandbox info for this task. */
  sandboxes: WorkbenchSandboxSummary[];
  activeSandboxId: string | null;
}

/** Repo-level summary for organization sidebar. */
export interface WorkbenchRepositorySummary {
  id: string;
  label: string;
  /** Aggregated branch/task overview state (replaces getRepoOverview polling). */
  taskCount: number;
  latestActivityMs: number;
}

/** Organization-level snapshot — initial fetch for the organization topic. */
export interface OrganizationSummarySnapshot {
  organizationId: string;
  repos: WorkbenchRepositorySummary[];
  taskSummaries: WorkbenchTaskSummary[];
  openPullRequests: WorkbenchOpenPrSummary[];
}

export interface WorkbenchSession extends WorkbenchSessionSummary {
  draft: WorkbenchComposerDraft;
  transcript: WorkbenchTranscriptEvent[];
}

export interface WorkbenchTask {
  id: string;
  repoId: string;
  title: string;
  status: WorkbenchTaskStatus;
  runtimeStatus?: TaskStatus;
  statusMessage?: string | null;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkbenchPullRequestSummary | null;
  sessions: WorkbenchSession[];
  fileChanges: WorkbenchFileChange[];
  diffs: Record<string, string>;
  fileTree: WorkbenchFileTreeNode[];
  minutesUsed: number;
  activeSandboxId?: string | null;
}

export interface WorkbenchRepo {
  id: string;
  label: string;
}

export interface WorkbenchRepositorySection {
  id: string;
  label: string;
  updatedAtMs: number;
  tasks: WorkbenchTask[];
}

export interface TaskWorkbenchSnapshot {
  organizationId: string;
  repos: WorkbenchRepo[];
  repositories: WorkbenchRepositorySection[];
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
  onBranch?: string;
  model?: WorkbenchModelId;
}

export interface TaskWorkbenchRenameInput {
  taskId: string;
  value: string;
}

export interface TaskWorkbenchSendMessageInput {
  taskId: string;
  sessionId: string;
  text: string;
  attachments: WorkbenchLineAttachment[];
}

export interface TaskWorkbenchSessionInput {
  taskId: string;
  sessionId: string;
}

export interface TaskWorkbenchRenameSessionInput extends TaskWorkbenchSessionInput {
  title: string;
}

export interface TaskWorkbenchChangeModelInput extends TaskWorkbenchSessionInput {
  model: WorkbenchModelId;
}

export interface TaskWorkbenchUpdateDraftInput extends TaskWorkbenchSessionInput {
  text: string;
  attachments: WorkbenchLineAttachment[];
}

export interface TaskWorkbenchSetSessionUnreadInput extends TaskWorkbenchSessionInput {
  unread: boolean;
}

export interface TaskWorkbenchDiffInput {
  taskId: string;
  path: string;
}

export interface TaskWorkbenchCreateTaskResponse {
  taskId: string;
  sessionId?: string;
}

export interface TaskWorkbenchAddSessionResponse {
  sessionId: string;
}
