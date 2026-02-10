export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "ok";

export interface AgentHealthInfo {
  agent: string;
  installed: boolean;
  running: boolean;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: HealthStatus | string;
  version: string;
  uptime_ms: number;
  agents: AgentHealthInfo[];
  // Backward-compatible field from earlier v2 payloads.
  api_version?: string;
  [key: string]: unknown;
}

export type ServerStatus = "running" | "stopped" | "error";

export interface ServerStatusInfo {
  status: ServerStatus | string;
  base_url?: string | null;
  baseUrl?: string | null;
  uptime_ms?: number | null;
  uptimeMs?: number | null;
  restart_count?: number;
  restartCount?: number;
  last_error?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface AgentModelInfo {
  id?: string;
  model_id?: string;
  modelId?: string;
  name?: string | null;
  description?: string | null;
  default_variant?: string | null;
  defaultVariant?: string | null;
  variants?: string[] | null;
  [key: string]: unknown;
}

export interface AgentModeInfo {
  id: string;
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface AgentCapabilities {
  plan_mode?: boolean;
  permissions?: boolean;
  questions?: boolean;
  tool_calls?: boolean;
  tool_results?: boolean;
  text_messages?: boolean;
  images?: boolean;
  file_attachments?: boolean;
  session_lifecycle?: boolean;
  error_events?: boolean;
  reasoning?: boolean;
  status?: boolean;
  command_execution?: boolean;
  file_changes?: boolean;
  mcp_tools?: boolean;
  streaming_deltas?: boolean;
  item_started?: boolean;
  shared_process?: boolean;
  unstable_methods?: boolean;
  [key: string]: unknown;
}

export interface AgentInfo {
  id: string;
  installed?: boolean;
  credentials_available?: boolean;
  native_required?: boolean;
  native_installed?: boolean;
  native_version?: string | null;
  agent_process_installed?: boolean;
  agent_process_source?: string | null;
  agent_process_version?: string | null;
  version?: string | null;
  path?: string | null;
  server_status?: ServerStatusInfo | null;
  models?: AgentModelInfo[] | null;
  default_model?: string | null;
  modes?: AgentModeInfo[] | null;
  capabilities: AgentCapabilities;
  [key: string]: unknown;
}

export interface AgentListResponse {
  agents: AgentInfo[];
}

export interface AgentInstallRequest {
  reinstall?: boolean;
  agentVersion?: string;
  agentProcessVersion?: string;
}

export interface AgentInstallArtifact {
  kind: string;
  path: string;
  source: string;
  version?: string | null;
}

export interface AgentInstallResponse {
  already_installed: boolean;
  artifacts: AgentInstallArtifact[];
}

export type SessionEndReason = "completed" | "error" | "terminated";
export type TerminatedBy = "agent" | "daemon";

export interface StderrOutput {
  head?: string | null;
  tail?: string | null;
  truncated: boolean;
  total_lines?: number | null;
}

export interface SessionTerminationInfo {
  reason: SessionEndReason | string;
  terminated_by: TerminatedBy | string;
  message?: string | null;
  exit_code?: number | null;
  stderr?: StderrOutput | null;
  [key: string]: unknown;
}

export interface SessionInfo {
  session_id: string;
  sessionId?: string;
  agent?: string;
  cwd?: string;
  title?: string | null;
  ended?: boolean;
  created_at?: string | number | null;
  createdAt?: string | number | null;
  updated_at?: string | number | null;
  updatedAt?: string | number | null;
  model?: string | null;
  metadata?: Record<string, unknown> | null;
  agent_mode?: string;
  agentMode?: string;
  permission_mode?: string;
  permissionMode?: string;
  native_session_id?: string | null;
  nativeSessionId?: string | null;
  event_count?: number;
  eventCount?: number;
  directory?: string | null;
  variant?: string | null;
  mcp?: Record<string, unknown> | null;
  skills?: Record<string, unknown> | null;
  termination_info?: SessionTerminationInfo | null;
  terminationInfo?: SessionTerminationInfo | null;
  [key: string]: unknown;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
}

export interface SessionTerminateResponse {
  terminated?: boolean;
  reason?: SessionEndReason | string;
  terminated_by?: TerminatedBy | string;
  terminatedBy?: TerminatedBy | string;
  [key: string]: unknown;
}

export interface SessionEndedParams {
  session_id?: string;
  sessionId?: string;
  data?: SessionTerminationInfo;
  reason?: SessionEndReason | string;
  terminated_by?: TerminatedBy | string;
  terminatedBy?: TerminatedBy | string;
  message?: string | null;
  exit_code?: number | null;
  stderr?: StderrOutput | null;
  [key: string]: unknown;
}

export interface SessionEndedNotification {
  jsonrpc: "2.0";
  method: "_sandboxagent/session/ended";
  params: SessionEndedParams;
  [key: string]: unknown;
}

export interface FsPathQuery {
  path: string;
  session_id?: string | null;
  sessionId?: string | null;
}

export interface FsEntriesQuery {
  path?: string | null;
  session_id?: string | null;
  sessionId?: string | null;
}

export interface FsSessionQuery {
  session_id?: string | null;
  sessionId?: string | null;
}

export interface FsDeleteQuery {
  path: string;
  recursive?: boolean | null;
  session_id?: string | null;
  sessionId?: string | null;
}

export interface FsUploadBatchQuery {
  path?: string | null;
  session_id?: string | null;
  sessionId?: string | null;
}

export type FsEntryType = "file" | "directory";

export interface FsEntry {
  name: string;
  path: string;
  size: number;
  entry_type?: FsEntryType;
  entryType?: FsEntryType;
  modified?: string | null;
}

export interface FsStat {
  path: string;
  size: number;
  entry_type?: FsEntryType;
  entryType?: FsEntryType;
  modified?: string | null;
}

export interface FsWriteResponse {
  path: string;
  bytes_written?: number;
  bytesWritten?: number;
}

export interface FsMoveRequest {
  from: string;
  to: string;
  overwrite?: boolean | null;
}

export interface FsMoveResponse {
  from: string;
  to: string;
}

export interface FsActionResponse {
  path: string;
}

export interface FsUploadBatchResponse {
  paths: string[];
  truncated: boolean;
}
