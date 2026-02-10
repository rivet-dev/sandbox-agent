import {
  SandboxAgent,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SandboxAgentAcpClient,
  type SandboxAgentConnectOptions,
  type SessionNotification,
} from "sandbox-agent";
import type {
  AgentInfo,
  AgentModelInfo,
  AgentModeInfo,
  AgentModelsResponse,
  AgentModesResponse,
  CreateSessionRequest,
  EventsQuery,
  EventsResponse,
  MessageRequest,
  PermissionEventData,
  PermissionReplyRequest,
  QuestionEventData,
  QuestionReplyRequest,
  SessionInfo,
  SessionListResponse,
  TurnStreamQuery,
  UniversalEvent,
} from "../types/legacyApi";

type PendingPermission = {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  autoEndTurnOnResolve?: boolean;
};

type PendingQuestion = {
  prompt: string;
  options: string[];
  autoEndTurnOnResolve?: boolean;
};

type RuntimeSession = {
  aliasSessionId: string;
  realSessionId: string;
  agent: string;
  connection: SandboxAgentAcpClient;
  events: UniversalEvent[];
  nextSequence: number;
  listeners: Set<(event: UniversalEvent) => void>;
  info: SessionInfo;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
};

const TDOO_PERMISSION_MODE =
  "TDOO: ACP permission mode preconfiguration is not implemented in inspector compatibility.";
const TDOO_VARIANT =
  "TDOO: ACP session variants are not implemented in inspector compatibility.";
const TDOO_SKILLS =
  "TDOO: ACP skills source configuration is not implemented in inspector compatibility.";
const TDOO_MODE_DISCOVERY =
  "TDOO: ACP mode discovery before session creation is not implemented; returning cached/empty modes.";
const TDOO_MODEL_DISCOVERY =
  "TDOO: ACP model discovery before session creation is not implemented; returning cached/empty models.";

export class InspectorLegacyClient {
  private readonly base: SandboxAgent;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly aliasByRealSessionId = new Map<string, string>();
  private readonly modeCache = new Map<string, AgentModeInfo[]>();
  private readonly modelCache = new Map<string, AgentModelsResponse>();
  private permissionCounter = 0;

  private constructor(base: SandboxAgent) {
    this.base = base;
  }

  static async connect(options: SandboxAgentConnectOptions): Promise<InspectorLegacyClient> {
    const base = await SandboxAgent.connect(options);
    return new InspectorLegacyClient(base);
  }

  async getHealth() {
    return this.base.getHealth();
  }

  async listAgents(): Promise<{ agents: AgentInfo[] }> {
    const response = await this.base.listAgents();

    return {
      agents: response.agents.map((agent) => {
        const installed =
          agent.agent_process_installed &&
          (!agent.native_required || agent.native_installed);
        return {
          id: agent.id,
          installed,
          credentialsAvailable: true,
          version: agent.agent_process_version ?? agent.native_version ?? null,
          path: null,
          capabilities: {
            unstable_methods: agent.capabilities.unstable_methods,
          },
          native_required: agent.native_required,
          native_installed: agent.native_installed,
          native_version: agent.native_version,
          agent_process_installed: agent.agent_process_installed,
          agent_process_source: agent.agent_process_source,
          agent_process_version: agent.agent_process_version,
        };
      }),
    };
  }

  async installAgent(agent: string, request: { reinstall?: boolean } = {}) {
    return this.base.installAgent(agent, request);
  }

  async getAgentModes(agentId: string): Promise<AgentModesResponse> {
    const modes = this.modeCache.get(agentId);
    if (modes) {
      return { modes };
    }

    console.warn(TDOO_MODE_DISCOVERY);
    return { modes: [] };
  }

  async getAgentModels(agentId: string): Promise<AgentModelsResponse> {
    const models = this.modelCache.get(agentId);
    if (models) {
      return models;
    }

    console.warn(TDOO_MODEL_DISCOVERY);
    return { models: [], defaultModel: null };
  }

  async createSession(aliasSessionId: string, request: CreateSessionRequest): Promise<void> {
    await this.terminateSession(aliasSessionId).catch(() => {
      // Ignore if it doesn't exist yet.
    });

    const acp = await this.base.createAcpClient({
      agent: request.agent,
      client: {
        sessionUpdate: async (notification) => {
          this.handleSessionUpdate(notification);
        },
        requestPermission: async (permissionRequest) => {
          return this.handlePermissionRequest(permissionRequest);
        },
      },
    });

    await acp.initialize();

    const created = await acp.newSession({
      cwd: "/",
      mcpServers: convertMcpConfig(request.mcp ?? {}),
    });

    if (created.modes?.availableModes) {
      this.modeCache.set(
        request.agent,
        created.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? undefined,
        })),
      );
    }

    if (created.models?.availableModels) {
      this.modelCache.set(request.agent, {
        models: created.models.availableModels.map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description ?? undefined,
        })),
        defaultModel: created.models.currentModelId ?? null,
      });
    }

    const runtime: RuntimeSession = {
      aliasSessionId,
      realSessionId: created.sessionId,
      agent: request.agent,
      connection: acp,
      events: [],
      nextSequence: 1,
      listeners: new Set(),
      info: {
        sessionId: aliasSessionId,
        agent: request.agent,
        eventCount: 0,
        ended: false,
        model: request.model ?? null,
        variant: request.variant ?? null,
        permissionMode: request.permissionMode ?? null,
        mcp: request.mcp,
        skills: request.skills,
      },
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
    };

    this.sessions.set(aliasSessionId, runtime);
    this.aliasByRealSessionId.set(created.sessionId, aliasSessionId);

    if (request.agentMode) {
      try {
        await acp.setSessionMode({ sessionId: created.sessionId, modeId: request.agentMode });
      } catch {
        this.emitError(aliasSessionId, `TDOO: Unable to apply mode \"${request.agentMode}\" via ACP.`);
      }
    }

    if (request.model) {
      try {
        await acp.unstableSetSessionModel({
          sessionId: created.sessionId,
          modelId: request.model,
        });
      } catch {
        this.emitError(aliasSessionId, `TDOO: Unable to apply model \"${request.model}\" via ACP.`);
      }
    }

    if (request.permissionMode) {
      this.emitError(aliasSessionId, TDOO_PERMISSION_MODE);
    }

    if (request.variant) {
      this.emitError(aliasSessionId, TDOO_VARIANT);
    }

    if (request.skills?.sources && request.skills.sources.length > 0) {
      this.emitError(aliasSessionId, TDOO_SKILLS);
    }

    this.emitEvent(aliasSessionId, "session.started", {
      session_id: aliasSessionId,
      agent: request.agent,
    });
  }

  async listSessions(): Promise<SessionListResponse> {
    const sessions = Array.from(this.sessions.values()).map((session) => {
      return {
        ...session.info,
        eventCount: session.events.length,
      };
    });

    return { sessions };
  }

  async postMessage(sessionId: string, request: MessageRequest): Promise<void> {
    const runtime = this.requireActiveSession(sessionId);
    const message = request.message.trim();
    if (!message) {
      return;
    }

    this.emitEvent(sessionId, "inspector.turn_started", {
      session_id: sessionId,
    });

    this.emitEvent(sessionId, "inspector.user_message", {
      session_id: sessionId,
      text: message,
    });

    try {
      await runtime.connection.prompt({
        sessionId: runtime.realSessionId,
        prompt: [{ type: "text", text: message }],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "prompt failed";
      this.emitError(sessionId, detail);
      throw error;
    } finally {
      this.emitEvent(sessionId, "inspector.turn_ended", {
        session_id: sessionId,
      });
    }
  }

  async getEvents(sessionId: string, query: EventsQuery = {}): Promise<EventsResponse> {
    const runtime = this.requireSession(sessionId);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 200;

    const events = runtime.events.filter((event) => event.sequence > offset).slice(0, limit);
    return { events };
  }

  async *streamEvents(
    sessionId: string,
    query: EventsQuery = {},
    signal?: AbortSignal,
  ): AsyncIterable<UniversalEvent> {
    const runtime = this.requireSession(sessionId);
    let cursor = query.offset ?? 0;

    for (const event of runtime.events) {
      if (event.sequence <= cursor) {
        continue;
      }
      cursor = event.sequence;
      yield event;
    }

    const queue: UniversalEvent[] = [];
    let wake: (() => void) | null = null;

    const listener = (event: UniversalEvent) => {
      if (event.sequence <= cursor) {
        return;
      }
      queue.push(event);
      if (wake) {
        wake();
        wake = null;
      }
    };

    runtime.listeners.add(listener);

    try {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await waitForSignalOrEvent(signal, () => {
            wake = () => {};
            return new Promise<void>((resolve) => {
              wake = resolve;
            });
          });
          continue;
        }

        const next = queue.shift();
        if (!next) {
          continue;
        }

        cursor = next.sequence;
        yield next;
      }
    } finally {
      runtime.listeners.delete(listener);
    }
  }

  async *streamTurn(
    sessionId: string,
    request: MessageRequest,
    _query?: TurnStreamQuery,
    signal?: AbortSignal,
  ): AsyncIterable<UniversalEvent> {
    if (signal?.aborted) {
      return;
    }

    const runtime = this.requireActiveSession(sessionId);
    let cursor = runtime.nextSequence - 1;
    const queue: UniversalEvent[] = [];
    let wake: (() => void) | null = null;
    let promptDone = false;
    let promptError: unknown = null;

    const notify = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };

    const listener = (event: UniversalEvent) => {
      if (event.sequence <= cursor) {
        return;
      }
      queue.push(event);
      notify();
    };

    runtime.listeners.add(listener);

    const promptPromise = this.postMessage(sessionId, request)
      .catch((error) => {
        promptError = error;
      })
      .finally(() => {
        promptDone = true;
        notify();
      });

    try {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          if (promptDone) {
            break;
          }

          await waitForSignalOrEvent(signal, () => {
            wake = () => {};
            return new Promise<void>((resolve) => {
              wake = resolve;
            });
          });
          continue;
        }

        const next = queue.shift();
        if (!next) {
          continue;
        }

        cursor = next.sequence;
        yield next;
      }
    } finally {
      runtime.listeners.delete(listener);
    }

    await promptPromise;
    if (promptError) {
      throw promptError;
    }
  }

  async replyQuestion(
    sessionId: string,
    questionId: string,
    request: QuestionReplyRequest,
  ): Promise<void> {
    const runtime = this.requireSession(sessionId);
    const pending = runtime.pendingQuestions.get(questionId);
    if (!pending) {
      throw new Error("TDOO: Question request no longer pending.");
    }

    runtime.pendingQuestions.delete(questionId);
    const response = request.answers?.[0]?.[0] ?? null;
    const resolved: QuestionEventData & { response?: string | null } = {
      question_id: questionId,
      status: "resolved",
      prompt: pending.prompt,
      options: pending.options,
      response,
    };
    this.emitEvent(sessionId, "question.resolved", resolved);
    if (pending.autoEndTurnOnResolve) {
      this.emitEvent(sessionId, "turn.ended", { session_id: sessionId });
    }
  }

  async rejectQuestion(sessionId: string, questionId: string): Promise<void> {
    const runtime = this.requireSession(sessionId);
    const pending = runtime.pendingQuestions.get(questionId);
    if (!pending) {
      throw new Error("TDOO: Question request no longer pending.");
    }

    runtime.pendingQuestions.delete(questionId);
    const resolved: QuestionEventData & { response?: string | null } = {
      question_id: questionId,
      status: "resolved",
      prompt: pending.prompt,
      options: pending.options,
      response: null,
    };
    this.emitEvent(sessionId, "question.resolved", resolved);
    if (pending.autoEndTurnOnResolve) {
      this.emitEvent(sessionId, "turn.ended", { session_id: sessionId });
    }
  }

  async replyPermission(
    sessionId: string,
    permissionId: string,
    request: PermissionReplyRequest,
  ): Promise<void> {
    const runtime = this.requireSession(sessionId);
    const pending = runtime.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error("TDOO: Permission request no longer pending.");
    }

    const optionId = selectPermissionOption(pending.request.options, request.reply);
    const response: RequestPermissionResponse = optionId
      ? {
          outcome: {
            outcome: "selected",
            optionId,
          },
        }
      : {
          outcome: {
            outcome: "cancelled",
          },
        };

    pending.resolve(response);
    runtime.pendingPermissions.delete(permissionId);

    const action = pending.request.toolCall.title ?? pending.request.toolCall.kind ?? "permission";
    const resolved: PermissionEventData = {
      permission_id: permissionId,
      status: "resolved",
      action,
      metadata: {
        reply: request.reply,
      },
    };

    this.emitEvent(sessionId, "permission.resolved", resolved);
    if (pending.autoEndTurnOnResolve) {
      this.emitEvent(sessionId, "turn.ended", { session_id: sessionId });
    }
  }

  async terminateSession(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }

    this.emitEvent(sessionId, "session.ended", {
      reason: "terminated_by_user",
      terminated_by: "inspector",
    });

    runtime.info.ended = true;

    for (const pending of runtime.pendingPermissions.values()) {
      pending.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
    }
    runtime.pendingPermissions.clear();
    runtime.pendingQuestions.clear();

    try {
      await runtime.connection.close();
    } catch {
      // Best-effort close.
    }

    this.aliasByRealSessionId.delete(runtime.realSessionId);
  }

  async dispose(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.terminateSession(sessionId);
    }

    await this.base.dispose();
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const aliasSessionId = this.aliasByRealSessionId.get(notification.sessionId);
    if (!aliasSessionId) {
      return;
    }

    const runtime = this.sessions.get(aliasSessionId);
    if (!runtime || runtime.info.ended) {
      return;
    }

    const update = notification.update;

    // Still handle session_info_update for sidebar metadata
    if (update.sessionUpdate === "session_info_update") {
      runtime.info.title = update.title ?? runtime.info.title;
      runtime.info.updatedAt = update.updatedAt ?? runtime.info.updatedAt;
    }

    // Emit the raw notification as the event data, using the ACP discriminator as the type
    this.emitEvent(aliasSessionId, `acp.${update.sessionUpdate}`, notification);
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const aliasSessionId = this.aliasByRealSessionId.get(request.sessionId);
    if (!aliasSessionId) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    const runtime = this.sessions.get(aliasSessionId);
    if (!runtime || runtime.info.ended) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    this.permissionCounter += 1;
    const permissionId = `permission-${this.permissionCounter}`;

    const action = request.toolCall.title ?? request.toolCall.kind ?? "permission";
    const pendingEvent: PermissionEventData = {
      permission_id: permissionId,
      status: "requested",
      action,
      metadata: request,
    };

    this.emitEvent(aliasSessionId, "permission.requested", pendingEvent);

    return await new Promise<RequestPermissionResponse>((resolve) => {
      runtime.pendingPermissions.set(permissionId, { request, resolve });
    });
  }

  private emitError(sessionId: string, message: string): void {
    this.emitEvent(sessionId, "error", {
      message,
    });
  }

  private emitEvent(sessionId: string, type: string, data: unknown): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      return;
    }

    const event: UniversalEvent = {
      event_id: `${sessionId}-${runtime.nextSequence}`,
      sequence: runtime.nextSequence,
      type,
      source: "inspector.acp",
      time: new Date().toISOString(),
      synthetic: true,
      data,
    };

    runtime.nextSequence += 1;
    runtime.events.push(event);
    runtime.info.eventCount = runtime.events.length;

    for (const listener of runtime.listeners) {
      listener(event);
    }
  }

  private requireSession(sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return runtime;
  }

  private requireActiveSession(sessionId: string): RuntimeSession {
    const runtime = this.requireSession(sessionId);
    if (runtime.info.ended) {
      throw new Error(`Session ended: ${sessionId}`);
    }
    return runtime;
  }

}

const convertMcpConfig = (mcp: Record<string, unknown>) => {
  return Object.entries(mcp)
    .map(([name, config]) => {
      if (!config || typeof config !== "object") {
        return null;
      }

      const value = config as Record<string, unknown>;
      const type = value.type;

      if (type === "local") {
        const commandValue = value.command;
        const argsValue = value.args;

        let command = "";
        let args: string[] = [];

        if (Array.isArray(commandValue) && commandValue.length > 0) {
          command = String(commandValue[0] ?? "");
          args = commandValue.slice(1).map((part) => String(part));
        } else if (typeof commandValue === "string") {
          command = commandValue;
        }

        if (Array.isArray(argsValue)) {
          args = argsValue.map((part) => String(part));
        }

        const envObject =
          value.env && typeof value.env === "object" ? (value.env as Record<string, unknown>) : {};
        const env = Object.entries(envObject).map(([envName, envValue]) => ({
          name: envName,
          value: String(envValue),
        }));

        return {
          name,
          command,
          args,
          env,
        };
      }

      if (type === "remote") {
        const headersObject =
          value.headers && typeof value.headers === "object"
            ? (value.headers as Record<string, unknown>)
            : {};
        const headers = Object.entries(headersObject).map(([headerName, headerValue]) => ({
          name: headerName,
          value: String(headerValue),
        }));

        return {
          type: "http" as const,
          name,
          url: String(value.url ?? ""),
          headers,
        };
      }

      return null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
};

const selectPermissionOption = (
  options: PermissionOption[],
  reply: PermissionReplyRequest["reply"],
): string | null => {
  const pick = (...kinds: PermissionOption["kind"][]) => {
    return options.find((option) => kinds.includes(option.kind))?.optionId ?? null;
  };

  if (reply === "always") {
    return pick("allow_always", "allow_once");
  }

  if (reply === "once") {
    return pick("allow_once", "allow_always");
  }

  return pick("reject_once", "reject_always");
};

const waitForSignalOrEvent = async (
  signal: AbortSignal | undefined,
  createWaitPromise: () => Promise<void>,
) => {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    };

    const onAbort = () => finish();

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    createWaitPromise().then(finish).catch(finish);
  });
};
