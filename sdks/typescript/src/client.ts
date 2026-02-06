import type { SandboxAgentSpawnHandle, SandboxAgentSpawnOptions } from "./spawn.ts";
import type {
  AgentInstallRequest,
  AgentListResponse,
  AgentModelsResponse,
  AgentModesResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  EventsQuery,
  EventsResponse,
  HealthResponse,
  MessageRequest,
  PermissionReplyRequest,
  ProblemDetails,
  QuestionReplyRequest,
  SessionListResponse,
  TurnStreamQuery,
  UniversalEvent,
} from "./types.ts";

const API_PREFIX = "/v1";

export interface SandboxAgentConnectOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}

export interface SandboxAgentStartOptions {
  spawn?: SandboxAgentSpawnOptions | boolean;
  fetch?: typeof fetch;
  headers?: HeadersInit;
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

type QueryValue = string | number | boolean | null | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: HeadersInit;
  accept?: string;
  signal?: AbortSignal;
};

export class SandboxAgent {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultHeaders?: HeadersInit;
  private spawnHandle?: SandboxAgentSpawnHandle;

  private constructor(options: SandboxAgentConnectOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = options.headers;

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
    });
    client.spawnHandle = handle;
    return client;
  }

  async listAgents(): Promise<AgentListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/agents`);
  }

  async getHealth(): Promise<HealthResponse> {
    return this.requestJson("GET", `${API_PREFIX}/health`);
  }

  async installAgent(agent: string, request: AgentInstallRequest = {}): Promise<void> {
    await this.requestJson("POST", `${API_PREFIX}/agents/${encodeURIComponent(agent)}/install`, {
      body: request,
    });
  }

  async getAgentModes(agent: string): Promise<AgentModesResponse> {
    return this.requestJson("GET", `${API_PREFIX}/agents/${encodeURIComponent(agent)}/modes`);
  }

  async getAgentModels(agent: string): Promise<AgentModelsResponse> {
    return this.requestJson("GET", `${API_PREFIX}/agents/${encodeURIComponent(agent)}/models`);
  }

  async createSession(sessionId: string, request: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}`, {
      body: request,
    });
  }

  async listSessions(): Promise<SessionListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/sessions`);
  }

  async postMessage(sessionId: string, request: MessageRequest): Promise<void> {
    await this.requestJson("POST", `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/messages`, {
      body: request,
    });
  }

  async getEvents(sessionId: string, query?: EventsQuery): Promise<EventsResponse> {
    return this.requestJson("GET", `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/events`, {
      query,
    });
  }

  async getEventsSse(sessionId: string, query?: EventsQuery, signal?: AbortSignal): Promise<Response> {
    return this.requestRaw("GET", `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/events/sse`, {
      query,
      accept: "text/event-stream",
      signal,
    });
  }

  async postMessageStream(
    sessionId: string,
    request: MessageRequest,
    query?: TurnStreamQuery,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.requestRaw("POST", `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
      query,
      body: request,
      accept: "text/event-stream",
      signal,
    });
  }

  async *streamEvents(
    sessionId: string,
    query?: EventsQuery,
    signal?: AbortSignal,
  ): AsyncGenerator<UniversalEvent, void, void> {
    const response = await this.getEventsSse(sessionId, query, signal);
    yield* this.parseSseStream(response);
  }

  async *streamTurn(
    sessionId: string,
    request: MessageRequest,
    query?: TurnStreamQuery,
    signal?: AbortSignal,
  ): AsyncGenerator<UniversalEvent, void, void> {
    const response = await this.postMessageStream(sessionId, request, query, signal);
    yield* this.parseSseStream(response);
  }

  async replyQuestion(
    sessionId: string,
    questionId: string,
    request: QuestionReplyRequest,
  ): Promise<void> {
    await this.requestJson(
      "POST",
      `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/reply`,
      { body: request },
    );
  }

  async rejectQuestion(sessionId: string, questionId: string): Promise<void> {
    await this.requestJson(
      "POST",
      `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/reject`,
    );
  }

  async replyPermission(
    sessionId: string,
    permissionId: string,
    request: PermissionReplyRequest,
  ): Promise<void> {
    await this.requestJson(
      "POST",
      `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}/reply`,
      { body: request },
    );
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.requestJson("POST", `${API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/terminate`);
  }

  async dispose(): Promise<void> {
    if (this.spawnHandle) {
      await this.spawnHandle.dispose();
      this.spawnHandle = undefined;
    }
  }

  private async requestJson<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(method, path, {
      query: options.query,
      body: options.body,
      headers: options.headers,
      accept: options.accept ?? "application/json",
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
    const headers = new Headers(this.defaultHeaders ?? undefined);

    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    if (options.accept) {
      headers.set("Accept", options.accept);
    }

    const init: RequestInit = { method, headers, signal: options.signal };
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    if (options.headers) {
      const extra = new Headers(options.headers);
      extra.forEach((value, key) => headers.set(key, value));
    }

    const response = await this.fetcher(url, init);
    if (!response.ok) {
      const problem = await this.readProblem(response);
      throw new SandboxAgentError(response.status, problem, response);
    }

    return response;
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

  private async readProblem(response: Response): Promise<ProblemDetails | undefined> {
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

  private async *parseSseStream(response: Response): AsyncGenerator<UniversalEvent, void, void> {
    if (!response.body) {
      throw new Error("SSE stream is not readable in this environment.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Normalize CRLF to LF for consistent parsing
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLines = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"));
        if (dataLines.length > 0) {
          const payload = dataLines
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (payload) {
            yield JSON.parse(payload) as UniversalEvent;
          }
        }
        index = buffer.indexOf("\n\n");
      }
    }
  }
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
