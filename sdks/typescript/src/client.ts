import {
  AcpHttpClient,
  PROTOCOL_VERSION,
  type AcpEnvelopeDirection,
  type AnyMessage,
  type AuthMethod,
  type CancelNotification,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionModeRequest,
} from "acp-http-client";
import type { SandboxAgentSpawnHandle, SandboxAgentSpawnOptions } from "./spawn.ts";
import {
  type AcpServerListResponse,
  type AgentInfo,
  type AgentInstallRequest,
  type AgentInstallResponse,
  type AgentListResponse,
  type FsActionResponse,
  type FsDeleteQuery,
  type FsEntriesQuery,
  type FsEntry,
  type FsMoveRequest,
  type FsMoveResponse,
  type FsPathQuery,
  type FsStat,
  type FsUploadBatchQuery,
  type FsUploadBatchResponse,
  type FsWriteResponse,
  type HealthResponse,
  InMemorySessionPersistDriver,
  type ListEventsRequest,
  type ListPage,
  type ListPageRequest,
  type McpConfigQuery,
  type McpServerConfig,
  type ProblemDetails,
  type SessionEvent,
  type SessionPersistDriver,
  type SessionRecord,
  type SkillsConfig,
  type SkillsConfigQuery,
} from "./types.ts";

const API_PREFIX = "/v1";
const FS_PATH = `${API_PREFIX}/fs`;

const DEFAULT_REPLAY_MAX_EVENTS = 50;
const DEFAULT_REPLAY_MAX_CHARS = 12_000;
const EVENT_INDEX_SCAN_EVENTS_LIMIT = 500;

export interface SandboxAgentConnectOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
}

export interface SandboxAgentStartOptions extends Omit<SandboxAgentConnectOptions, "baseUrl" | "token"> {
  spawn?: SandboxAgentSpawnOptions | boolean;
}

export interface SessionCreateRequest {
  id?: string;
  agent: string;
  sessionInit?: Omit<NewSessionRequest, "_meta">;
}

export interface SessionResumeOrCreateRequest {
  id: string;
  agent: string;
  sessionInit?: Omit<NewSessionRequest, "_meta">;
}

export interface SessionSendOptions {
  notification?: boolean;
}

export type SessionEventListener = (event: SessionEvent) => void;

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

export class Session {
  private record: SessionRecord;
  private readonly sandbox: SandboxAgent;

  constructor(sandbox: SandboxAgent, record: SessionRecord) {
    this.sandbox = sandbox;
    this.record = { ...record };
  }

  get id(): string {
    return this.record.id;
  }

  get agent(): string {
    return this.record.agent;
  }

  get agentSessionId(): string {
    return this.record.agentSessionId;
  }

  get lastConnectionId(): string {
    return this.record.lastConnectionId;
  }

  get createdAt(): number {
    return this.record.createdAt;
  }

  get destroyedAt(): number | undefined {
    return this.record.destroyedAt;
  }

  async refresh(): Promise<Session> {
    const latest = await this.sandbox.getSession(this.id);
    if (!latest) {
      throw new Error(`session '${this.id}' no longer exists`);
    }
    this.apply(latest.toRecord());
    return this;
  }

  async send(method: string, params: Record<string, unknown> = {}, options: SessionSendOptions = {}): Promise<unknown> {
    const updated = await this.sandbox.sendSessionMethod(this.id, method, params, options);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async prompt(prompt: PromptRequest["prompt"]): Promise<PromptResponse> {
    const response = await this.send("session/prompt", { prompt });
    return response as PromptResponse;
  }

  onEvent(listener: SessionEventListener): () => void {
    return this.sandbox.onSessionEvent(this.id, listener);
  }

  toRecord(): SessionRecord {
    return { ...this.record };
  }

  apply(record: SessionRecord): void {
    this.record = { ...record };
  }
}

export class LiveAcpConnection {
  readonly connectionId: string;
  readonly agent: string;

  private readonly acp: AcpHttpClient;
  private readonly sessionByLocalId = new Map<string, string>();
  private readonly localByAgentSessionId = new Map<string, string>();
  private readonly pendingNewSessionLocals: string[] = [];
  private readonly pendingRequestSessionById = new Map<string, string>();
  private readonly pendingReplayByLocalSessionId = new Map<string, string>();

  private readonly onObservedEnvelope: (
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
  ) => void;

  private constructor(
    agent: string,
    connectionId: string,
    acp: AcpHttpClient,
    onObservedEnvelope: (
      connection: LiveAcpConnection,
      envelope: AnyMessage,
      direction: AcpEnvelopeDirection,
      localSessionId: string | null,
    ) => void,
  ) {
    this.agent = agent;
    this.connectionId = connectionId;
    this.acp = acp;
    this.onObservedEnvelope = onObservedEnvelope;
  }

  static async create(options: {
    baseUrl: string;
    token?: string;
    fetcher: typeof fetch;
    headers?: HeadersInit;
    agent: string;
    serverId: string;
    onObservedEnvelope: (
      connection: LiveAcpConnection,
      envelope: AnyMessage,
      direction: AcpEnvelopeDirection,
      localSessionId: string | null,
    ) => void;
  }): Promise<LiveAcpConnection> {
    const connectionId = randomId();

    let live: LiveAcpConnection | null = null;
    const acp = new AcpHttpClient({
      baseUrl: options.baseUrl,
      token: options.token,
      fetch: options.fetcher,
      headers: options.headers,
      transport: {
        path: `${API_PREFIX}/acp/${encodeURIComponent(options.serverId)}`,
        bootstrapQuery: { agent: options.agent },
      },
      client: {
        sessionUpdate: async (_notification: SessionNotification) => {
          // Session updates are observed via envelope persistence.
        },
      },
      onEnvelope: (envelope, direction) => {
        if (!live) {
          return;
        }
        live.handleEnvelope(envelope, direction);
      },
    });

    live = new LiveAcpConnection(options.agent, connectionId, acp, options.onObservedEnvelope);

    const initResult = await acp.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: "sandbox-agent-sdk",
        version: "v1",
      },
    });
    if (initResult.authMethods && initResult.authMethods.length > 0) {
      await autoAuthenticate(acp, initResult.authMethods);
    }
    return live;
  }

  async close(): Promise<void> {
    await this.acp.disconnect();
  }

  hasBoundSession(localSessionId: string, agentSessionId?: string): boolean {
    const bound = this.sessionByLocalId.get(localSessionId);
    if (!bound) {
      return false;
    }
    if (agentSessionId && bound !== agentSessionId) {
      return false;
    }
    return true;
  }

  bindSession(localSessionId: string, agentSessionId: string): void {
    this.sessionByLocalId.set(localSessionId, agentSessionId);
    this.localByAgentSessionId.set(agentSessionId, localSessionId);
  }

  queueReplay(localSessionId: string, replayText: string | null): void {
    if (!replayText) {
      this.pendingReplayByLocalSessionId.delete(localSessionId);
      return;
    }
    this.pendingReplayByLocalSessionId.set(localSessionId, replayText);
  }

  async createRemoteSession(
    localSessionId: string,
    sessionInit: Omit<NewSessionRequest, "_meta">,
  ): Promise<NewSessionResponse> {
    this.pendingNewSessionLocals.push(localSessionId);

    try {
      const response = await this.acp.newSession(sessionInit);
      this.bindSession(localSessionId, response.sessionId);
      return response;
    } catch (error) {
      const index = this.pendingNewSessionLocals.indexOf(localSessionId);
      if (index !== -1) {
        this.pendingNewSessionLocals.splice(index, 1);
      }
      throw error;
    }
  }

  async sendSessionMethod(
    localSessionId: string,
    method: string,
    params: Record<string, unknown>,
    options: SessionSendOptions,
  ): Promise<unknown> {
    const agentSessionId = this.sessionByLocalId.get(localSessionId);
    if (!agentSessionId) {
      throw new Error(`session '${localSessionId}' is not bound to live ACP connection '${this.connectionId}'`);
    }

    const mappedParams = mapSessionParams(params, agentSessionId);

    if (method === "session/prompt") {
      const replayText = this.pendingReplayByLocalSessionId.get(localSessionId);
      if (replayText) {
        // TODO: Replace this synthesized replay text with ACP-native restore once standardized.
        this.pendingReplayByLocalSessionId.delete(localSessionId);
        injectReplayPrompt(mappedParams, replayText);
      }

      if (options.notification) {
        await this.acp.extNotification(method, mappedParams);
        return undefined;
      }

      return this.acp.prompt(mappedParams as PromptRequest);
    }

    if (method === "session/cancel") {
      await this.acp.cancel(mappedParams as CancelNotification);
      return undefined;
    }

    if (method === "session/set_mode") {
      return this.acp.setSessionMode(mappedParams as SetSessionModeRequest);
    }

    if (method === "session/set_config_option") {
      return this.acp.setSessionConfigOption(mappedParams as SetSessionConfigOptionRequest);
    }

    if (options.notification) {
      await this.acp.extNotification(method, mappedParams);
      return undefined;
    }

    return this.acp.extMethod(method, mappedParams);
  }

  private handleEnvelope(envelope: AnyMessage, direction: AcpEnvelopeDirection): void {
    const localSessionId = this.resolveSessionId(envelope, direction);
    this.onObservedEnvelope(this, envelope, direction, localSessionId);
  }

  private resolveSessionId(envelope: AnyMessage, direction: AcpEnvelopeDirection): string | null {
    const id = envelopeId(envelope);
    const method = envelopeMethod(envelope);

    if (direction === "outbound") {
      if (id && method === "session/new") {
        const localSessionId = this.pendingNewSessionLocals.shift() ?? null;
        if (localSessionId) {
          this.pendingRequestSessionById.set(id, localSessionId);
        }
        return localSessionId;
      }

      const localFromParams = this.localFromEnvelopeParams(envelope);
      if (id && localFromParams) {
        this.pendingRequestSessionById.set(id, localFromParams);
      }
      return localFromParams;
    }

    if (id) {
      const pending = this.pendingRequestSessionById.get(id) ?? null;
      if (pending) {
        this.pendingRequestSessionById.delete(id);
        const sessionIdFromResult = envelopeSessionIdFromResult(envelope);
        if (sessionIdFromResult) {
          this.bindSession(pending, sessionIdFromResult);
        }
        return pending;
      }
    }

    return this.localFromEnvelopeParams(envelope);
  }

  private localFromEnvelopeParams(envelope: AnyMessage): string | null {
    const agentSessionId = envelopeSessionIdFromParams(envelope);
    if (!agentSessionId) {
      return null;
    }
    return this.localByAgentSessionId.get(agentSessionId) ?? null;
  }
}

export class SandboxAgent {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultHeaders?: HeadersInit;

  private readonly persist: SessionPersistDriver;
  private readonly replayMaxEvents: number;
  private readonly replayMaxChars: number;

  private spawnHandle?: SandboxAgentSpawnHandle;

  private readonly liveConnections = new Map<string, LiveAcpConnection>();
  private readonly sessionHandles = new Map<string, Session>();
  private readonly eventListeners = new Map<string, Set<SessionEventListener>>();
  private readonly nextSessionEventIndexBySession = new Map<string, number>();
  private readonly seedSessionEventIndexBySession = new Map<string, Promise<void>>();

  constructor(options: SandboxAgentConnectOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = options.headers;
    this.persist = options.persist ?? new InMemorySessionPersistDriver();

    this.replayMaxEvents = normalizePositiveInt(options.replayMaxEvents, DEFAULT_REPLAY_MAX_EVENTS);
    this.replayMaxChars = normalizePositiveInt(options.replayMaxChars, DEFAULT_REPLAY_MAX_CHARS);

    if (!this.fetcher) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }
  }

  static async connect(options: SandboxAgentConnectOptions): Promise<SandboxAgent> {
    return new SandboxAgent(options);
  }

  static async start(options: SandboxAgentStartOptions = {}): Promise<SandboxAgent> {
    const spawnOptions = normalizeSpawnOptions(options.spawn, true);
    if (!spawnOptions.enabled) {
      throw new Error("SandboxAgent.start requires spawn to be enabled.");
    }

    const { spawnSandboxAgent } = await import("./spawn.js");
    const handle = await spawnSandboxAgent(spawnOptions, options.fetch ?? globalThis.fetch);

    const client = new SandboxAgent({
      baseUrl: handle.baseUrl,
      token: handle.token,
      fetch: options.fetch,
      headers: options.headers,
      persist: options.persist,
      replayMaxEvents: options.replayMaxEvents,
      replayMaxChars: options.replayMaxChars,
    });

    client.spawnHandle = handle;
    return client;
  }

  async dispose(): Promise<void> {
    const connections = [...this.liveConnections.values()];
    this.liveConnections.clear();

    await Promise.all(
      connections.map(async (connection) => {
        await connection.close();
      }),
    );

    if (this.spawnHandle) {
      await this.spawnHandle.dispose();
      this.spawnHandle = undefined;
    }
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<Session>> {
    const page = await this.persist.listSessions(request);
    return {
      items: page.items.map((record) => this.upsertSessionHandle(record)),
      nextCursor: page.nextCursor,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    const record = await this.persist.getSession(id);
    if (!record) {
      return null;
    }
    return this.upsertSessionHandle(record);
  }

  async getEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    return this.persist.listEvents(request);
  }

  async createSession(request: SessionCreateRequest): Promise<Session> {
    if (!request.agent.trim()) {
      throw new Error("createSession requires a non-empty agent");
    }

    const localSessionId = request.id?.trim() || randomId();
    const live = await this.getLiveConnection(request.agent.trim());
    const sessionInit = normalizeSessionInit(request.sessionInit);

    const response = await live.createRemoteSession(localSessionId, sessionInit);

    const record: SessionRecord = {
      id: localSessionId,
      agent: request.agent.trim(),
      agentSessionId: response.sessionId,
      lastConnectionId: live.connectionId,
      createdAt: nowMs(),
      sessionInit,
    };

    await this.persist.updateSession(record);
    this.nextSessionEventIndexBySession.set(record.id, 1);
    live.bindSession(record.id, record.agentSessionId);
    return this.upsertSessionHandle(record);
  }

  async resumeSession(id: string): Promise<Session> {
    const existing = await this.persist.getSession(id);
    if (!existing) {
      throw new Error(`session '${id}' not found`);
    }

    const live = await this.getLiveConnection(existing.agent);
    if (existing.lastConnectionId === live.connectionId && live.hasBoundSession(id, existing.agentSessionId)) {
      return this.upsertSessionHandle(existing);
    }

    const replaySource = await this.collectReplayEvents(existing.id, this.replayMaxEvents);
    const replayText = buildReplayText(replaySource, this.replayMaxChars);

    const recreated = await live.createRemoteSession(existing.id, normalizeSessionInit(existing.sessionInit));

    const updated: SessionRecord = {
      ...existing,
      agentSessionId: recreated.sessionId,
      lastConnectionId: live.connectionId,
      destroyedAt: undefined,
    };

    await this.persist.updateSession(updated);
    live.bindSession(updated.id, updated.agentSessionId);
    live.queueReplay(updated.id, replayText);

    return this.upsertSessionHandle(updated);
  }

  async resumeOrCreateSession(request: SessionResumeOrCreateRequest): Promise<Session> {
    const existing = await this.persist.getSession(request.id);
    if (existing) {
      return this.resumeSession(existing.id);
    }
    return this.createSession(request);
  }

  async destroySession(id: string): Promise<Session> {
    const existing = await this.persist.getSession(id);
    if (!existing) {
      throw new Error(`session '${id}' not found`);
    }

    const updated: SessionRecord = {
      ...existing,
      destroyedAt: nowMs(),
    };

    await this.persist.updateSession(updated);
    return this.upsertSessionHandle(updated);
  }

  async sendSessionMethod(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    options: SessionSendOptions = {},
  ): Promise<{ session: Session; response: unknown }> {
    const record = await this.persist.getSession(sessionId);
    if (!record) {
      throw new Error(`session '${sessionId}' not found`);
    }

    const live = await this.getLiveConnection(record.agent);
    if (!live.hasBoundSession(record.id, record.agentSessionId)) {
      // The persisted session points at a stale connection; restore lazily.
      const restored = await this.resumeSession(record.id);
      return this.sendSessionMethod(restored.id, method, params, options);
    }

    const response = await live.sendSessionMethod(record.id, method, params, options);
    const refreshed = await this.requireSessionRecord(record.id);
    return {
      session: this.upsertSessionHandle(refreshed),
      response,
    };
  }

  onSessionEvent(sessionId: string, listener: SessionEventListener): () => void {
    const listeners = this.eventListeners.get(sessionId) ?? new Set<SessionEventListener>();
    listeners.add(listener);
    this.eventListeners.set(sessionId, listeners);

    return () => {
      const set = this.eventListeners.get(sessionId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.eventListeners.delete(sessionId);
      }
    };
  }

  async getHealth(): Promise<HealthResponse> {
    return this.requestJson("GET", `${API_PREFIX}/health`);
  }

  async listAgents(options?: { config?: boolean }): Promise<AgentListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/agents`, {
      query: options?.config ? { config: "true" } : undefined,
    });
  }

  async getAgent(agent: string, options?: { config?: boolean }): Promise<AgentInfo> {
    return this.requestJson("GET", `${API_PREFIX}/agents/${encodeURIComponent(agent)}`, {
      query: options?.config ? { config: "true" } : undefined,
    });
  }

  async installAgent(agent: string, request: AgentInstallRequest = {}): Promise<AgentInstallResponse> {
    return this.requestJson("POST", `${API_PREFIX}/agents/${encodeURIComponent(agent)}/install`, {
      body: request,
    });
  }

  async listAcpServers(): Promise<AcpServerListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/acp`);
  }

  async listFsEntries(query: FsEntriesQuery = {}): Promise<FsEntry[]> {
    return this.requestJson("GET", `${FS_PATH}/entries`, {
      query,
    });
  }

  async readFsFile(query: FsPathQuery): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${FS_PATH}/file`, {
      query,
      accept: "application/octet-stream",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFsFile(query: FsPathQuery, body: BodyInit): Promise<FsWriteResponse> {
    const response = await this.requestRaw("PUT", `${FS_PATH}/file`, {
      query,
      rawBody: body,
      contentType: "application/octet-stream",
      accept: "application/json",
    });
    return (await response.json()) as FsWriteResponse;
  }

  async deleteFsEntry(query: FsDeleteQuery): Promise<FsActionResponse> {
    return this.requestJson("DELETE", `${FS_PATH}/entry`, { query });
  }

  async mkdirFs(query: FsPathQuery): Promise<FsActionResponse> {
    return this.requestJson("POST", `${FS_PATH}/mkdir`, { query });
  }

  async moveFs(request: FsMoveRequest): Promise<FsMoveResponse> {
    return this.requestJson("POST", `${FS_PATH}/move`, { body: request });
  }

  async statFs(query: FsPathQuery): Promise<FsStat> {
    return this.requestJson("GET", `${FS_PATH}/stat`, { query });
  }

  async uploadFsBatch(body: BodyInit, query?: FsUploadBatchQuery): Promise<FsUploadBatchResponse> {
    const response = await this.requestRaw("POST", `${FS_PATH}/upload-batch`, {
      query,
      rawBody: body,
      contentType: "application/x-tar",
      accept: "application/json",
    });
    return (await response.json()) as FsUploadBatchResponse;
  }

  async getMcpConfig(query: McpConfigQuery): Promise<McpServerConfig> {
    return this.requestJson("GET", `${API_PREFIX}/config/mcp`, { query });
  }

  async setMcpConfig(query: McpConfigQuery, config: McpServerConfig): Promise<void> {
    await this.requestRaw("PUT", `${API_PREFIX}/config/mcp`, { query, body: config });
  }

  async deleteMcpConfig(query: McpConfigQuery): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/config/mcp`, { query });
  }

  async getSkillsConfig(query: SkillsConfigQuery): Promise<SkillsConfig> {
    return this.requestJson("GET", `${API_PREFIX}/config/skills`, { query });
  }

  async setSkillsConfig(query: SkillsConfigQuery, config: SkillsConfig): Promise<void> {
    await this.requestRaw("PUT", `${API_PREFIX}/config/skills`, { query, body: config });
  }

  async deleteSkillsConfig(query: SkillsConfigQuery): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/config/skills`, { query });
  }

  private async getLiveConnection(agent: string): Promise<LiveAcpConnection> {
    const existing = this.liveConnections.get(agent);
    if (existing) {
      return existing;
    }

    const serverId = `sdk-${agent}-${randomId()}`;
    const created = await LiveAcpConnection.create({
      baseUrl: this.baseUrl,
      token: this.token,
      fetcher: this.fetcher,
      headers: this.defaultHeaders,
      agent,
      serverId,
      onObservedEnvelope: (connection, envelope, direction, localSessionId) => {
        void this.persistObservedEnvelope(connection, envelope, direction, localSessionId);
      },
    });

    this.liveConnections.set(agent, created);
    return created;
  }

  private async persistObservedEnvelope(
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
  ): Promise<void> {
    if (!localSessionId) {
      return;
    }

    const event: SessionEvent = {
      id: randomId(),
      eventIndex: await this.allocateSessionEventIndex(localSessionId),
      sessionId: localSessionId,
      createdAt: nowMs(),
      connectionId: connection.connectionId,
      sender: direction === "outbound" ? "client" : "agent",
      payload: cloneEnvelope(envelope),
    };

    await this.persist.insertEvent(event);

    const listeners = this.eventListeners.get(localSessionId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private async allocateSessionEventIndex(sessionId: string): Promise<number> {
    await this.ensureSessionEventIndexSeeded(sessionId);
    const nextIndex = this.nextSessionEventIndexBySession.get(sessionId) ?? 1;
    this.nextSessionEventIndexBySession.set(sessionId, nextIndex + 1);
    return nextIndex;
  }

  private async ensureSessionEventIndexSeeded(sessionId: string): Promise<void> {
    if (this.nextSessionEventIndexBySession.has(sessionId)) {
      return;
    }

    if (!this.seedSessionEventIndexBySession.has(sessionId)) {
      const pending = (async () => {
        const maxPersistedIndex = await this.findMaxPersistedSessionEventIndex(sessionId);
        this.nextSessionEventIndexBySession.set(sessionId, Math.max(1, maxPersistedIndex + 1));
      })().finally(() => {
        this.seedSessionEventIndexBySession.delete(sessionId);
      });
      this.seedSessionEventIndexBySession.set(sessionId, pending);
    }

    const pending = this.seedSessionEventIndexBySession.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  private async findMaxPersistedSessionEventIndex(sessionId: string): Promise<number> {
    let maxIndex = 0;
    let eventCursor: string | undefined;

    while (true) {
      const eventsPage = await this.persist.listEvents({
        sessionId,
        cursor: eventCursor,
        limit: EVENT_INDEX_SCAN_EVENTS_LIMIT,
      });

      for (const event of eventsPage.items) {
        if (Number.isFinite(event.eventIndex) && event.eventIndex > maxIndex) {
          maxIndex = Math.floor(event.eventIndex);
        }
      }

      if (!eventsPage.nextCursor) {
        break;
      }
      eventCursor = eventsPage.nextCursor;
    }

    return maxIndex;
  }

  private async collectReplayEvents(sessionId: string, maxEvents: number): Promise<SessionEvent[]> {
    const all: SessionEvent[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.persist.listEvents({
        sessionId,
        cursor,
        limit: Math.max(100, maxEvents),
      });

      all.push(...page.items);

      if (!page.nextCursor) {
        break;
      }

      cursor = page.nextCursor;
    }

    return all.slice(-maxEvents);
  }

  private upsertSessionHandle(record: SessionRecord): Session {
    const existing = this.sessionHandles.get(record.id);
    if (existing) {
      existing.apply(record);
      return existing;
    }

    const created = new Session(this, record);
    this.sessionHandles.set(record.id, created);
    return created;
  }

  private async requireSessionRecord(id: string): Promise<SessionRecord> {
    const record = await this.persist.getSession(id);
    if (!record) {
      throw new Error(`session '${id}' not found`);
    }
    return record;
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

    return (await response.json()) as T;
  }

  private async requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers);

    if (options.accept) {
      headers.set("Accept", options.accept);
    }

    const init: RequestInit = {
      method,
      headers,
      signal: options.signal,
    };

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

/**
 * Auto-select and call `authenticate` based on the agent's advertised auth methods.
 * Prefers env-var-based methods that the server process already has configured.
 */
async function autoAuthenticate(acp: AcpHttpClient, methods: AuthMethod[]): Promise<void> {
  // Only attempt env-var-based methods that the server process can satisfy
  // automatically.  Interactive methods (e.g. "claude-login") cannot be
  // fulfilled programmatically and must be skipped.
  const envBased = methods.find(
    (m) =>
      m.id === "codex-api-key" ||
      m.id === "openai-api-key" ||
      m.id === "anthropic-api-key",
  );

  if (!envBased) {
    return;
  }

  try {
    await acp.authenticate({ methodId: envBased.id });
  } catch {
    // Authentication is best-effort; the agent may already have credentials
    // from env vars or credential files configured on the server side.
  }
}

function normalizeSessionInit(
  value: Omit<NewSessionRequest, "_meta"> | undefined,
): Omit<NewSessionRequest, "_meta"> {
  if (!value) {
    return {
      cwd: defaultCwd(),
      mcpServers: [],
    };
  }

  return {
    ...value,
    cwd: value.cwd ?? defaultCwd(),
    mcpServers: value.mcpServers ?? [],
  };
}

function mapSessionParams(params: Record<string, unknown>, agentSessionId: string): Record<string, unknown> {
  return {
    ...params,
    sessionId: agentSessionId,
  };
}

function injectReplayPrompt(params: Record<string, unknown>, replayText: string): void {
  const prompt = Array.isArray(params.prompt) ? [...params.prompt] : [];
  prompt.unshift({
    type: "text",
    text: replayText,
  });
  params.prompt = prompt;
}

function buildReplayText(events: SessionEvent[], maxChars: number): string | null {
  if (events.length === 0) {
    return null;
  }

  const prefix =
    "Previous session history is replayed below as JSON-RPC envelopes. Use it as context before responding to the latest user prompt.\n";
  let text = prefix;

  for (const event of events) {
    const line = JSON.stringify({
      createdAt: event.createdAt,
      sender: event.sender,
      payload: event.payload,
    });

    if (text.length + line.length + 1 > maxChars) {
      text += "\n[history truncated]";
      break;
    }

    text += `${line}\n`;
  }

  return text;
}

function envelopeMethod(message: AnyMessage): string | null {
  if (!isRecord(message) || !("method" in message) || typeof message["method"] !== "string") {
    return null;
  }
  return message["method"];
}

function envelopeId(message: AnyMessage): string | null {
  if (!isRecord(message) || !("id" in message) || message["id"] === undefined || message["id"] === null) {
    return null;
  }
  return String(message["id"]);
}

function envelopeSessionIdFromParams(message: AnyMessage): string | null {
  if (!isRecord(message) || !("params" in message) || !isRecord(message["params"])) {
    return null;
  }

  const params = message["params"];
  if (typeof params.sessionId === "string" && params.sessionId.length > 0) {
    return params.sessionId;
  }

  return null;
}

function envelopeSessionIdFromResult(message: AnyMessage): string | null {
  if (!isRecord(message) || !("result" in message) || !isRecord(message["result"])) {
    return null;
  }

  const result = message["result"];
  if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
    return result.sessionId;
  }

  return null;
}

function cloneEnvelope(envelope: AnyMessage): AnyMessage {
  return JSON.parse(JSON.stringify(envelope)) as AnyMessage;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs(): number {
  return Date.now();
}

function defaultCwd(): string {
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    return process.cwd();
  }
  return "/";
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.floor(value as number);
}

function normalizeSpawnOptions(
  spawn: SandboxAgentSpawnOptions | boolean | undefined,
  defaultEnabled: boolean,
): SandboxAgentSpawnOptions & { enabled: boolean } {
  if (spawn === false) {
    return { enabled: false };
  }

  if (spawn === true || spawn === undefined) {
    return { enabled: defaultEnabled };
  }

  return {
    ...spawn,
    enabled: spawn.enabled ?? defaultEnabled,
  };
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
