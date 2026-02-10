import {
  AcpHttpClient,
  PROTOCOL_VERSION,
  type AcpEnvelopeDirection,
  type AnyMessage,
  type CancelNotification,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "acp-http-client";
import type { SandboxAgentSpawnHandle, SandboxAgentSpawnOptions } from "./spawn.ts";
import type {
  AgentInstallRequest,
  AgentInstallResponse,
  AgentListResponse,
  FsActionResponse,
  FsDeleteQuery,
  FsEntriesQuery,
  FsEntry,
  FsMoveRequest,
  FsMoveResponse,
  FsPathQuery,
  FsSessionQuery,
  FsStat,
  FsUploadBatchQuery,
  FsUploadBatchResponse,
  FsWriteResponse,
  HealthResponse,
  ProblemDetails,
  SessionEndedNotification,
  SessionInfo,
  SessionListResponse,
  SessionTerminateResponse,
} from "./types.ts";

const API_PREFIX = "/v2";
const FS_PATH = `${API_PREFIX}/fs`;
const SANDBOX_META_KEY = "sandboxagent.dev";
const SESSION_DETACH_METHOD = "_sandboxagent/session/detach";
const SESSION_TERMINATE_METHOD = "_sandboxagent/session/terminate";
const SESSION_LIST_MODELS_METHOD = "_sandboxagent/session/list_models";
const SESSION_SET_METADATA_METHOD = "_sandboxagent/session/set_metadata";
const SESSION_ENDED_METHOD = "_sandboxagent/session/ended";
const AGENT_UNPARSED_METHOD = "_sandboxagent/agent/unparsed";
const AGENT_LIST_METHOD = "_sandboxagent/agent/list";
const AGENT_INSTALL_METHOD = "_sandboxagent/agent/install";
const SESSION_LIST_METHOD = "_sandboxagent/session/list";
const SESSION_GET_METHOD = "_sandboxagent/session/get";
const FS_LIST_ENTRIES_METHOD = "_sandboxagent/fs/list_entries";
const FS_DELETE_ENTRY_METHOD = "_sandboxagent/fs/delete_entry";
const FS_MKDIR_METHOD = "_sandboxagent/fs/mkdir";
const FS_MOVE_METHOD = "_sandboxagent/fs/move";
const FS_STAT_METHOD = "_sandboxagent/fs/stat";
const V1_REMOVED_MESSAGE = "v1 API removed; use session methods on SandboxAgentClient";

type QueryValue = string | number | boolean | null | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  headers?: HeadersInit;
  accept?: string;
  signal?: AbortSignal;
};

export interface SandboxAgentConnectOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}

export interface SandboxAgentClientConnectOptions {
  agent?: string;
  initialize?: Partial<InitializeRequest>;
}

export interface SandboxAgentClientOptions extends SandboxAgentConnectOptions {
  agent?: string;
  autoConnect?: boolean;
  onEvent?: SandboxAgentEventObserver;
  onSessionUpdate?: (notification: SessionUpdateNotification) => Promise<void> | void;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>;
}

export interface SandboxAgentStartOptions {
  spawn?: SandboxAgentSpawnOptions | boolean;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  agent?: string;
  autoConnect?: boolean;
  onEvent?: SandboxAgentEventObserver;
  onSessionUpdate?: (notification: SessionUpdateNotification) => Promise<void> | void;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>;
}

export interface SandboxMetadata {
  title?: string;
  model?: string;
  mode?: string;
  variant?: string;
  requestedSessionId?: string;
  permissionMode?: string;
  skills?: Record<string, unknown> | null;
  agentVersionRequested?: string;
  agent?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  ended?: boolean;
  eventCount?: number;
  [key: string]: unknown;
}

export type SessionCreateRequest = Omit<NewSessionRequest, "_meta"> & {
  metadata?: SandboxMetadata;
};

export type PermissionRequest = RequestPermissionRequest;
export type PermissionResponse = RequestPermissionResponse;
export type SessionUpdateNotification = SessionNotification;

export interface AgentUnparsedNotification {
  jsonrpc: "2.0";
  method: typeof AGENT_UNPARSED_METHOD;
  params: Record<string, unknown>;
  [key: string]: unknown;
}

export type AgentEvent =
  | {
      type: "sessionUpdate";
      notification: SessionUpdateNotification;
    }
  | {
      type: "sessionEnded";
      notification: SessionEndedNotification;
    }
  | {
      type: "agentUnparsed";
      notification: AgentUnparsedNotification;
    };

export type SandboxAgentEventObserver = (event: AgentEvent) => void;

export interface SessionModelInfo {
  modelId: string;
  name?: string | null;
  description?: string | null;
  defaultVariant?: string | null;
  variants?: string[] | null;
  [key: string]: unknown;
}

export interface ListModelsResponse {
  availableModels: SessionModelInfo[];
  currentModelId?: string | null;
  [key: string]: unknown;
}

export interface ListModelsRequest {
  sessionId?: string;
  agent?: string;
}

export class SandboxAgentError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly response: Response;

  constructor(status: number, problem: ProblemDetails | undefined, response: Response) {
    super(problem?.title ?? `Request failed with status ${status}`);
    this.name = "SandboxAgentError";
    this.status = status;
    this.problem = problem;
    this.response = response;
  }
}

export class NotConnectedError extends Error {
  constructor() {
    super("ACP session is not connected. Call connect() first.");
    this.name = "NotConnectedError";
  }
}

export class AlreadyConnectedError extends Error {
  constructor() {
    super("ACP session is already connected.");
    this.name = "AlreadyConnectedError";
  }
}

export class SandboxAgentClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultHeaders?: HeadersInit;
  private spawnHandle?: SandboxAgentSpawnHandle;

  private readonly autoConnect: boolean;
  private agent?: string;
  private acpClient: AcpHttpClient | null = null;
  private connectPromise: Promise<InitializeResponse> | null = null;
  private connectError: unknown;

  private readonly onEvent?: SandboxAgentEventObserver;
  private readonly onSessionUpdate?: (notification: SessionUpdateNotification) => Promise<void> | void;
  private readonly onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionResponse>;

  constructor(options: SandboxAgentClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = options.headers;
    this.autoConnect = options.autoConnect ?? true;
    this.agent = options.agent;
    this.onEvent = options.onEvent;
    this.onSessionUpdate = options.onSessionUpdate;
    this.onPermissionRequest = options.onPermissionRequest;

    if (!this.fetcher) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }

    if (this.autoConnect) {
      if (!this.agent) {
        throw new Error("agent is required when autoConnect is enabled.");
      }
      this.connectPromise = this.connectInternal({});
      this.connectPromise.catch(() => {
        // Prevent unhandled rejection; ACP calls will surface stored error.
      });
    }
  }

  static async start(options: SandboxAgentStartOptions = {}): Promise<SandboxAgentClient> {
    const spawnOptions = normalizeSpawnOptions(options.spawn, true);
    if (!spawnOptions.enabled) {
      throw new Error("SandboxAgentClient.start requires spawn to be enabled.");
    }
    const { spawnSandboxAgent } = await import("./spawn.js");
    const handle = await spawnSandboxAgent(spawnOptions, options.fetch ?? globalThis.fetch);
    const client = new SandboxAgentClient({
      baseUrl: handle.baseUrl,
      token: handle.token,
      fetch: options.fetch,
      headers: options.headers,
      agent: options.agent,
      autoConnect: options.autoConnect,
      onEvent: options.onEvent,
      onSessionUpdate: options.onSessionUpdate,
      onPermissionRequest: options.onPermissionRequest,
    });
    client.spawnHandle = handle;
    return client;
  }

  get connected(): boolean {
    return this.acpClient !== null;
  }

  get clientId(): string | undefined {
    return this.acpClient?.clientId;
  }

  async connect(options: SandboxAgentClientConnectOptions = {}): Promise<InitializeResponse> {
    if (this.acpClient || this.connectPromise) {
      throw new AlreadyConnectedError();
    }

    if (options.agent) {
      this.agent = options.agent;
    }

    this.connectPromise = this.connectInternal(options);
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise.catch(() => {
        // Ignore here; state reset below.
      });
    }

    const acp = this.acpClient;
    this.acpClient = null;
    this.connectError = undefined;

    if (acp) {
      await acp.disconnect();
    }
  }

  async newSession(request: SessionCreateRequest): Promise<NewSessionResponse> {
    const acp = await this.requireAcpConnection();
    if (!request.metadata || typeof request.metadata.agent !== "string" || !request.metadata.agent.trim()) {
      throw new Error('newSession requires metadata.agent');
    }
    return acp.newSession(injectSandboxMetadata(request));
  }

  async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    const acp = await this.requireAcpConnection();
    return acp.loadSession(request);
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const acp = await this.requireAcpConnection();
    return acp.prompt(request);
  }

  async cancel(notification: CancelNotification): Promise<void> {
    const acp = await this.requireAcpConnection();
    return acp.cancel(notification);
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    const acp = await this.requireAcpConnection();
    return acp.setSessionMode(request);
  }

  async setSessionConfigOption(
    request: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const acp = await this.requireAcpConnection();
    return acp.setSessionConfigOption(request);
  }

  async unstableListSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    const acp = await this.requireAcpConnection();
    const response = await acp.unstableListSessions(request);
    return normalizeAcpListSessionsResponse(response);
  }

  async unstableForkSession(request: ForkSessionRequest): Promise<ForkSessionResponse> {
    const acp = await this.requireAcpConnection();
    return acp.unstableForkSession(request);
  }

  async unstableResumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const acp = await this.requireAcpConnection();
    return acp.unstableResumeSession(request);
  }

  async setSessionModel(request: SetSessionModelRequest): Promise<SetSessionModelResponse | void> {
    const acp = await this.requireAcpConnection();
    return acp.unstableSetSessionModel(request);
  }

  async listModels(request: ListModelsRequest = {}): Promise<ListModelsResponse> {
    if (!request.sessionId && (!request.agent || !request.agent.trim())) {
      throw new Error("listModels requires request.agent when request.sessionId is absent.");
    }
    const acp = await this.requireAcpConnection();
    const params: Record<string, unknown> = {};
    if (request.sessionId) {
      params.sessionId = request.sessionId;
    }
    if (request.agent && request.agent.trim()) {
      params.agent = request.agent.trim();
    }
    const result = await acp.extMethod(SESSION_LIST_MODELS_METHOD, params);
    return normalizeListModelsResponse(result);
  }

  async setMetadata(sessionId: string, metadata: SandboxMetadata): Promise<Record<string, unknown>> {
    const acp = await this.requireAcpConnection();
    return acp.extMethod(SESSION_SET_METADATA_METHOD, {
      sessionId,
      metadata,
    });
  }

  async detachSession(sessionId: string): Promise<Record<string, unknown>> {
    const acp = await this.requireAcpConnection();
    return acp.extMethod(SESSION_DETACH_METHOD, {
      sessionId,
    });
  }

  async terminateSession(sessionId: string): Promise<SessionTerminateResponse> {
    const acp = await this.requireAcpConnection();
    const result = await acp.extMethod(SESSION_TERMINATE_METHOD, {
      sessionId,
    });
    return result as SessionTerminateResponse;
  }

  async getHealth(): Promise<HealthResponse> {
    return this.requestJson("GET", `${API_PREFIX}/health`);
  }

  async listAgents(): Promise<AgentListResponse> {
    const acp = await this.requireAcpConnection();
    return (await acp.extMethod(AGENT_LIST_METHOD, {})) as unknown as AgentListResponse;
  }

  async installAgent(agent: string, request: AgentInstallRequest = {}): Promise<AgentInstallResponse> {
    const acp = await this.requireAcpConnection();
    return (await acp.extMethod(AGENT_INSTALL_METHOD, {
      agent,
      ...request,
    })) as unknown as AgentInstallResponse;
  }

  // v1 session-creation/message endpoints remain removed in ACP-native v2.
  async createSession(_sessionId: string, _request: unknown): Promise<never> {
    throw new Error(V1_REMOVED_MESSAGE);
  }

  async listSessions(): Promise<SessionListResponse> {
    const acp = await this.requireAcpConnection();
    const response = (await acp.extMethod(SESSION_LIST_METHOD, {})) as unknown as SessionListResponse;
    return normalizeSessionListResponse(response);
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const acp = await this.requireAcpConnection();
    const response = (await acp.extMethod(SESSION_GET_METHOD, {
      sessionId,
    })) as unknown as SessionInfo;
    return normalizeSessionInfo(response);
  }

  async postMessage(_sessionId: string, _request: unknown): Promise<never> {
    throw new Error(V1_REMOVED_MESSAGE);
  }

  async getEvents(_sessionId: string, _query?: unknown): Promise<never> {
    throw new Error(V1_REMOVED_MESSAGE);
  }

  async listFsEntries(query?: FsEntriesQuery): Promise<FsEntry[]> {
    const acp = await this.requireAcpConnection();
    const result = await acp.extMethod(FS_LIST_ENTRIES_METHOD, withSessionQueryAliases(query) ?? {});
    const entries = isRecord(result) && Array.isArray(result.entries) ? result.entries : [];
    return entries.map((entry) => normalizeFsEntry(entry as FsEntry));
  }

  async readFsFile(query: FsPathQuery): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${FS_PATH}/file`, {
      query: withSessionQueryAliases(query),
      accept: "application/octet-stream",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFsFile(query: FsPathQuery, body: BodyInit): Promise<FsWriteResponse> {
    const response = await this.requestRaw("PUT", `${FS_PATH}/file`, {
      query: withSessionQueryAliases(query),
      rawBody: body,
      contentType: "application/octet-stream",
      accept: "application/json",
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as FsWriteResponse) : { path: "", bytes_written: 0 };
    return normalizeFsWriteResponse(parsed);
  }

  async deleteFsEntry(query: FsDeleteQuery): Promise<FsActionResponse> {
    const acp = await this.requireAcpConnection();
    return (await acp.extMethod(
      FS_DELETE_ENTRY_METHOD,
      withSessionQueryAliases(query) ?? {},
    )) as unknown as FsActionResponse;
  }

  async mkdirFs(query: FsPathQuery): Promise<FsActionResponse> {
    const acp = await this.requireAcpConnection();
    return (await acp.extMethod(
      FS_MKDIR_METHOD,
      withSessionQueryAliases(query) ?? {},
    )) as unknown as FsActionResponse;
  }

  async moveFs(request: FsMoveRequest, query?: FsSessionQuery): Promise<FsMoveResponse> {
    const acp = await this.requireAcpConnection();
    return (await acp.extMethod(FS_MOVE_METHOD, {
      ...(withSessionQueryAliases(query) ?? {}),
      ...request,
    })) as unknown as FsMoveResponse;
  }

  async statFs(query: FsPathQuery): Promise<FsStat> {
    const acp = await this.requireAcpConnection();
    const stat = (await acp.extMethod(
      FS_STAT_METHOD,
      withSessionQueryAliases(query) ?? {},
    )) as unknown as FsStat;
    return normalizeFsStat(stat);
  }

  async uploadFsBatch(body: BodyInit, query?: FsUploadBatchQuery): Promise<FsUploadBatchResponse> {
    const response = await this.requestRaw("POST", `${FS_PATH}/upload-batch`, {
      query: withSessionQueryAliases(query),
      rawBody: body,
      contentType: "application/x-tar",
      accept: "application/json",
    });
    const text = await response.text();
    return text ? (JSON.parse(text) as FsUploadBatchResponse) : { paths: [], truncated: false };
  }

  async dispose(): Promise<void> {
    await this.disconnect();

    if (this.spawnHandle) {
      await this.spawnHandle.dispose();
      this.spawnHandle = undefined;
    }
  }

  private async connectInternal(options: SandboxAgentClientConnectOptions): Promise<InitializeResponse> {
    const agent = options.agent ?? this.agent;
    if (!agent) {
      this.connectPromise = null;
      throw new Error("agent is required to connect.");
    }

    const acpClient = new AcpHttpClient({
      baseUrl: this.baseUrl,
      fetch: this.fetcher,
      token: this.token,
      headers: this.defaultHeaders,
      client: {
        sessionUpdate: async (notification) => {
          if (this.onSessionUpdate) {
            await this.onSessionUpdate(notification);
          }
          this.emitEvent({
            type: "sessionUpdate",
            notification,
          });
        },
        requestPermission: this.onPermissionRequest,
        extNotification: async (method, params) => {
          this.handleEnvelope(
            {
              jsonrpc: "2.0",
              method,
              params,
            } as AnyMessage,
            "inbound",
          );
        },
      },
    });

    try {
      const initializeResponse = await acpClient.initialize({
        protocolVersion: options.initialize?.protocolVersion ?? PROTOCOL_VERSION,
        clientCapabilities: options.initialize?.clientCapabilities,
        clientInfo: options.initialize?.clientInfo ?? {
          name: "sandbox-agent-sdk",
          version: "v2",
        },
        _meta: mergeSandboxMeta(options.initialize?._meta, { agent }),
      });

      this.acpClient = acpClient;
      this.connectError = undefined;
      this.agent = agent;
      return initializeResponse;
    } catch (error) {
      this.connectError = error;
      await acpClient.disconnect().catch(() => {
        // best effort
      });
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  private async requireAcpConnection(): Promise<AcpHttpClient> {
    if (this.connectPromise) {
      await this.connectPromise;
    }

    if (!this.acpClient) {
      if (this.connectError) {
        throw this.connectError;
      }
      throw new NotConnectedError();
    }

    return this.acpClient;
  }

  private handleEnvelope(envelope: AnyMessage, direction: AcpEnvelopeDirection): void {
    if (direction !== "inbound") {
      return;
    }

    const method = notificationMethod(envelope);
    if (!method) {
      return;
    }

    if (method === SESSION_ENDED_METHOD) {
      const notification = normalizeSessionEndedNotification(envelope);
      this.emitEvent({
        type: "sessionEnded",
        notification,
      });
      return;
    }

    if (method === AGENT_UNPARSED_METHOD) {
      this.emitEvent({
        type: "agentUnparsed",
        notification: normalizeAgentUnparsedNotification(envelope),
      });
    }
  }

  private emitEvent(event: AgentEvent): void {
    if (!this.onEvent) {
      return;
    }
    this.onEvent(event);
  }

  private async requestJson<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(method, path, {
      query: options.query,
      body: options.body,
      headers: options.headers,
      accept: options.accept ?? "application/json",
      signal: options.signal,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text) as T;
  }

  private async requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers);

    if (options.accept) {
      headers.set("Accept", options.accept);
    }

    const init: RequestInit = { method, headers, signal: options.signal };
    if (options.rawBody !== undefined && options.body !== undefined) {
      throw new Error("requestRaw received both rawBody and body");
    }
    if (options.rawBody !== undefined) {
      if (options.contentType) {
        headers.set("Content-Type", options.contentType);
      }
      init.body = options.rawBody;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetcher(url, init);
    if (!response.ok) {
      const problem = await readProblem(response);
      throw new SandboxAgentError(response.status, problem, response);
    }

    return response;
  }

  private buildHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(this.defaultHeaders ?? undefined);
    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    if (extra) {
      const merged = new Headers(extra);
      merged.forEach((value, key) => headers.set(key, value));
    }

    return headers;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null) {
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }
    return url.toString();
  }
}

// Backward-compatible convenience static entrypoint.
export class SandboxAgent {
  static async connect(options: SandboxAgentClientOptions): Promise<SandboxAgentClient> {
    const autoConnect = options.autoConnect ?? !!options.agent;
    return new SandboxAgentClient({ ...options, autoConnect });
  }

  static async start(options: SandboxAgentStartOptions = {}): Promise<SandboxAgentClient> {
    const autoConnect = options.autoConnect ?? !!options.agent;
    return SandboxAgentClient.start({ ...options, autoConnect });
  }
}

function injectSandboxMetadata(request: SessionCreateRequest): NewSessionRequest {
  const { metadata, ...rest } = request;
  if (!metadata) {
    return rest as NewSessionRequest;
  }

  return {
    ...(rest as NewSessionRequest),
    _meta: mergeSandboxMeta((rest as Record<string, unknown>)._meta, metadata),
  };
}

function mergeSandboxMeta(
  existing: unknown,
  sandboxAdditions: Record<string, unknown>,
): Record<string, unknown> {
  const base = isRecord(existing) ? existing : {};
  const existingSandbox = isRecord(base[SANDBOX_META_KEY]) ? base[SANDBOX_META_KEY] : {};
  return {
    ...base,
    [SANDBOX_META_KEY]: {
      ...existingSandbox,
      ...sandboxAdditions,
    },
  };
}

function normalizeAcpListSessionsResponse(response: ListSessionsResponse): ListSessionsResponse {
  const raw = response as unknown as Record<string, unknown>;
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];

  return {
    ...(response as Record<string, unknown>),
    sessions: sessions.map((entry) => normalizeAcpSessionInfo(entry)),
  } as ListSessionsResponse;
}

function normalizeAcpSessionInfo(entry: unknown): Record<string, unknown> {
  const session = isRecord(entry) ? { ...entry } : {};
  const meta = isRecord(session._meta) ? session._meta : {};
  const sandboxMeta = isRecord(meta[SANDBOX_META_KEY]) ? meta[SANDBOX_META_KEY] : undefined;

  if (!sandboxMeta) {
    return session;
  }

  if (session.metadata === undefined) {
    session.metadata = sandboxMeta;
  }

  if (session.model === undefined && typeof sandboxMeta.model === "string") {
    session.model = sandboxMeta.model;
  }

  if (session.title === undefined && typeof sandboxMeta.title === "string") {
    session.title = sandboxMeta.title;
  }

  if (session.agent === undefined && typeof sandboxMeta.agent === "string") {
    session.agent = sandboxMeta.agent;
  }

  if (session.createdAt === undefined && sandboxMeta.createdAt !== undefined) {
    session.createdAt = sandboxMeta.createdAt;
  }

  if (session.updatedAt === undefined && sandboxMeta.updatedAt !== undefined) {
    session.updatedAt = sandboxMeta.updatedAt;
  }

  if (session.ended === undefined && typeof sandboxMeta.ended === "boolean") {
    session.ended = sandboxMeta.ended;
  }

  if (session.eventCount === undefined && typeof sandboxMeta.eventCount === "number") {
    session.eventCount = sandboxMeta.eventCount;
  }

  return session;
}

function normalizeListModelsResponse(result: Record<string, unknown>): ListModelsResponse {
  const availableModels = Array.isArray(result.availableModels)
    ? result.availableModels.map((entry) => normalizeModelInfo(entry))
    : [];

  return {
    ...result,
    availableModels,
    currentModelId:
      typeof result.currentModelId === "string" || result.currentModelId === null
        ? (result.currentModelId as string | null)
        : undefined,
  };
}

function normalizeModelInfo(value: unknown): SessionModelInfo {
  if (!isRecord(value)) {
    return { modelId: "" };
  }

  const modelId =
    typeof value.modelId === "string"
      ? value.modelId
      : typeof value.id === "string"
        ? value.id
        : "";

  return {
    ...value,
    modelId,
  };
}

function normalizeSessionEndedNotification(envelope: AnyMessage): SessionEndedNotification {
  const source: Record<string, unknown> = isRecord(envelope) ? envelope : {};
  const sourceParams = source["params"];
  const params = isRecord(sourceParams) ? { ...sourceParams } : {};

  const sessionId =
    typeof params.sessionId === "string"
      ? params.sessionId
      : typeof params.session_id === "string"
        ? params.session_id
        : undefined;

  if (sessionId) {
    params.sessionId = sessionId;
    params.session_id = sessionId;
  }

  return {
    ...(source as Record<string, unknown>),
    jsonrpc: "2.0",
    method: SESSION_ENDED_METHOD,
    params,
  } as SessionEndedNotification;
}

function normalizeAgentUnparsedNotification(envelope: AnyMessage): AgentUnparsedNotification {
  const source: Record<string, unknown> = isRecord(envelope) ? envelope : {};
  const sourceParams = source["params"];
  const params = isRecord(sourceParams) ? sourceParams : {};

  return {
    ...(source as Record<string, unknown>),
    jsonrpc: "2.0",
    method: AGENT_UNPARSED_METHOD,
    params,
  } as AgentUnparsedNotification;
}

function notificationMethod(message: AnyMessage): string | null {
  if (!isRecord(message)) {
    return null;
  }

  if ("id" in message) {
    return null;
  }

  return typeof message.method === "string" ? message.method : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  try {
    const text = await response.clone().text();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text) as ProblemDetails;
  } catch {
    return undefined;
  }
}

function normalizeSessionListResponse(response: SessionListResponse): SessionListResponse {
  return {
    ...response,
    sessions: response.sessions.map((session) => normalizeSessionInfo(session)),
  };
}

function normalizeSessionInfo(session: SessionInfo): SessionInfo {
  const normalized = { ...session };
  const sessionId = typeof normalized.session_id === "string" ? normalized.session_id : normalized.sessionId;
  if (typeof sessionId === "string") {
    normalized.session_id = sessionId;
    normalized.sessionId = sessionId;
  }
  return normalized;
}

function normalizeFsEntry(entry: FsEntry): FsEntry {
  const normalized = { ...entry };
  const entryType = normalized.entry_type ?? normalized.entryType;
  if (entryType) {
    normalized.entry_type = entryType;
    normalized.entryType = entryType;
  }
  return normalized;
}

function normalizeFsStat(stat: FsStat): FsStat {
  const normalized = { ...stat };
  const entryType = normalized.entry_type ?? normalized.entryType;
  if (entryType) {
    normalized.entry_type = entryType;
    normalized.entryType = entryType;
  }
  return normalized;
}

function normalizeFsWriteResponse(response: FsWriteResponse): FsWriteResponse {
  const normalized = { ...response };
  const bytes = normalized.bytes_written ?? normalized.bytesWritten;
  if (typeof bytes === "number") {
    normalized.bytes_written = bytes;
    normalized.bytesWritten = bytes;
  }
  return normalized;
}

function withSessionQueryAliases<T extends object>(query?: T): Record<string, QueryValue> | undefined {
  if (!query) {
    return undefined;
  }

  const normalized = { ...(query as Record<string, QueryValue>) };
  const sessionId = normalized.session_id ?? normalized.sessionId;
  if (sessionId !== undefined) {
    normalized.session_id = sessionId;
    normalized.sessionId = sessionId;
  }

  return normalized;
}

const normalizeSpawnOptions = (
  spawn: SandboxAgentSpawnOptions | boolean | undefined,
  defaultEnabled: boolean,
): SandboxAgentSpawnOptions => {
  if (typeof spawn === "boolean") {
    return { enabled: spawn };
  }
  if (spawn) {
    return { enabled: spawn.enabled ?? defaultEnabled, ...spawn };
  }
  return { enabled: defaultEnabled };
};
