export type SkillSourceType = "github" | "local" | "git";

export type SkillSource = {
  type: SkillSourceType;
  source: string;
  skills?: string[];
  ref?: string;
  subpath?: string;
};

export type CreateSessionRequest = {
  agent: string;
  agentMode?: string;
  permissionMode?: string;
  model?: string;
  variant?: string;
  mcp?: Record<string, unknown>;
  skills?: {
    sources: SkillSource[];
  };
};

export type AgentModeInfo = {
  id: string;
  name?: string;
  description?: string;
};

export type AgentModelInfo = {
  id: string;
  name?: string;
  description?: string;
  variants?: string[];
};

export type AgentInfo = {
  id: string;
  installed: boolean;
  credentialsAvailable: boolean;
  version?: string | null;
  path?: string | null;
  capabilities: Record<string, boolean | undefined>;
  native_required?: boolean;
  native_installed?: boolean;
  native_version?: string | null;
  agent_process_installed?: boolean;
  agent_process_source?: string | null;
  agent_process_version?: string | null;
};

export type ContentPart = {
  type?: string;
  [key: string]: unknown;
};

export type UniversalItem = {
  item_id: string;
  native_item_id?: string | null;
  parent_id?: string | null;
  kind: string;
  role?: string | null;
  content?: ContentPart[];
  status?: string | null;
  [key: string]: unknown;
};

export type UniversalEvent = {
  event_id: string;
  sequence: number;
  type: string;
  source: string;
  time: string;
  synthetic?: boolean;
  data: unknown;
  [key: string]: unknown;
};

export type PermissionEventData = {
  permission_id: string;
  status: "requested" | "resolved";
  action: string;
  metadata?: unknown;
};

export type QuestionEventData = {
  question_id: string;
  status: "requested" | "resolved";
  prompt: string;
  options: string[];
};

export type SessionInfo = {
  sessionId: string;
  agent: string;
  eventCount: number;
  ended?: boolean;
  model?: string | null;
  variant?: string | null;
  permissionMode?: string | null;
  mcp?: Record<string, unknown>;
  skills?: {
    sources?: SkillSource[];
  };
  title?: string | null;
  updatedAt?: string | null;
};

export type EventsQuery = {
  offset?: number;
  limit?: number;
  includeRaw?: boolean;
};

export type EventsResponse = {
  events: UniversalEvent[];
};

export type SessionListResponse = {
  sessions: SessionInfo[];
};

export type AgentModesResponse = {
  modes: AgentModeInfo[];
};

export type AgentModelsResponse = {
  models: AgentModelInfo[];
  defaultModel?: string | null;
};

export type MessageRequest = {
  message: string;
};

export type TurnStreamQuery = {
  includeRaw?: boolean;
};

export type PermissionReplyRequest = {
  reply: "once" | "always" | "reject";
};

export type QuestionReplyRequest = {
  answers: string[][];
};
