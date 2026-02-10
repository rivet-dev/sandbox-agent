import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
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
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
} from "@agentclientprotocol/sdk";

const ACP_PATH = "/v2/rpc";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export type AcpEnvelopeDirection = "inbound" | "outbound";

export type AcpEnvelopeObserver = (envelope: AnyMessage, direction: AcpEnvelopeDirection) => void;

export interface AcpHttpClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  client?: Partial<Client>;
  onEnvelope?: AcpEnvelopeObserver;
}

export class AcpHttpError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly response: Response;

  constructor(status: number, problem: ProblemDetails | undefined, response: Response) {
    super(problem?.title ?? `Request failed with status ${status}`);
    this.name = "AcpHttpError";
    this.status = status;
    this.problem = problem;
    this.response = response;
  }
}

export class AcpHttpClient {
  private readonly transport: StreamableHttpAcpTransport;
  private readonly connection: ClientSideConnection;

  constructor(options: AcpHttpClientOptions) {
    const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetcher) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }

    this.transport = new StreamableHttpAcpTransport({
      baseUrl: options.baseUrl,
      fetcher,
      token: options.token,
      defaultHeaders: options.headers,
      onEnvelope: options.onEnvelope,
    });

    const clientHandlers = buildClientHandlers(options.client);
    this.connection = new ClientSideConnection(() => clientHandlers, this.transport.stream);
  }

  get clientId(): string | undefined {
    return this.transport.clientId ?? undefined;
  }

  async initialize(request: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    const params: InitializeRequest = {
      protocolVersion: request.protocolVersion ?? PROTOCOL_VERSION,
      clientCapabilities: request.clientCapabilities,
      clientInfo: request.clientInfo ?? {
        name: "acp-http-client",
        version: "v2",
      },
    };

    if (request._meta !== undefined) {
      params._meta = request._meta;
    }

    return this.connection.initialize(params);
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.connection.authenticate(request);
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return this.connection.newSession(request);
  }

  async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.connection.loadSession(request);
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    return this.connection.prompt(request);
  }

  async cancel(notification: CancelNotification): Promise<void> {
    return this.connection.cancel(notification);
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    return this.connection.setSessionMode(request);
  }

  async setSessionConfigOption(
    request: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return this.connection.setSessionConfigOption(request);
  }

  async unstableListSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.connection.unstable_listSessions(request);
  }

  async unstableForkSession(request: ForkSessionRequest): Promise<ForkSessionResponse> {
    return this.connection.unstable_forkSession(request);
  }

  async unstableResumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.connection.unstable_resumeSession(request);
  }

  async unstableSetSessionModel(
    request: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    return this.connection.unstable_setSessionModel(request);
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.connection.extMethod(method, params);
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.connection.extNotification(method, params);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  get clientSideConnection(): ClientSideConnection {
    return this.connection;
  }
}

type StreamableHttpAcpTransportOptions = {
  baseUrl: string;
  fetcher: typeof fetch;
  token?: string;
  defaultHeaders?: HeadersInit;
  onEnvelope?: AcpEnvelopeObserver;
};

class StreamableHttpAcpTransport {
  readonly stream: Stream;

  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly token?: string;
  private readonly defaultHeaders?: HeadersInit;
  private readonly onEnvelope?: AcpEnvelopeObserver;

  private readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
  private sseAbortController: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;
  private lastEventId: string | null = null;
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  private _clientId: string | null = null;

  constructor(options: StreamableHttpAcpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetcher = options.fetcher;
    this.token = options.token;
    this.defaultHeaders = options.defaultHeaders;
    this.onEnvelope = options.onEnvelope;

    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.readableController = controller;
        },
        cancel: async () => {
          await this.close();
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          await this.writeMessage(message);
        },
        close: async () => {
          await this.close();
        },
        abort: async () => {
          await this.close();
        },
      }),
    };
  }

  get clientId(): string | null {
    return this._clientId;
  }

  async close(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }

    this.closingPromise = this.closeImpl();
    return this.closingPromise;
  }

  private async closeImpl(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }

    const clientId = this._clientId;
    if (clientId) {
      try {
        const response = await this.fetcher(`${this.baseUrl}${ACP_PATH}`, {
          method: "DELETE",
          headers: this.buildHeaders({
            "x-acp-connection-id": clientId,
            Accept: "application/json",
          }),
        });

        if (!response.ok && response.status !== 404) {
          throw new AcpHttpError(response.status, await readProblem(response), response);
        }
      } catch {
        // Ignore close errors; close must be best effort.
      }
    }

    try {
      this.readableController?.close();
    } catch {
      // no-op
    }

    this.readableController = null;
  }

  private async writeMessage(message: AnyMessage): Promise<void> {
    if (this.closed) {
      throw new Error("ACP client is closed");
    }

    this.observeEnvelope(message, "outbound");

    const headers = this.buildHeaders({
      "Content-Type": "application/json",
      Accept: "application/json",
    });

    if (this._clientId) {
      headers.set("x-acp-connection-id", this._clientId);
    }

    const response = await this.fetcher(`${this.baseUrl}${ACP_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new AcpHttpError(response.status, await readProblem(response), response);
    }

    const responseClientId = response.headers.get("x-acp-connection-id");
    if (responseClientId && responseClientId !== this._clientId) {
      this._clientId = responseClientId;
      this.ensureSseLoop();
    }

    if (response.status === 200) {
      const text = await response.text();
      if (text.trim()) {
        const envelope = JSON.parse(text) as AnyMessage;
        this.pushInbound(envelope);
      }
    }
  }

  private ensureSseLoop(): void {
    if (this.sseLoop || this.closed || !this._clientId) {
      return;
    }

    this.sseLoop = this.runSseLoop().finally(() => {
      this.sseLoop = null;
    });
  }

  private async runSseLoop(): Promise<void> {
    while (!this.closed && this._clientId) {
      this.sseAbortController = new AbortController();

      const headers = this.buildHeaders({
        "x-acp-connection-id": this._clientId,
        Accept: "text/event-stream",
      });

      if (this.lastEventId) {
        headers.set("Last-Event-ID", this.lastEventId);
      }

      try {
        const response = await this.fetcher(`${this.baseUrl}${ACP_PATH}`, {
          method: "GET",
          headers,
          signal: this.sseAbortController.signal,
        });

        if (!response.ok) {
          throw new AcpHttpError(response.status, await readProblem(response), response);
        }

        if (!response.body) {
          throw new Error("SSE stream is not readable in this environment.");
        }

        await this.consumeSse(response.body);

        if (!this.closed) {
          await delay(150);
        }
      } catch (error) {
        if (this.closed || isAbortError(error)) {
          return;
        }

        this.failReadable(error);
        return;
      }
    }
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const eventChunk = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          this.processSseEvent(eventChunk);
          separatorIndex = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processSseEvent(chunk: string): void {
    if (!chunk.trim()) {
      return;
    }

    let eventName = "message";
    let eventId: string | null = null;
    const dataLines: string[] = [];

    for (const line of chunk.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("id:")) {
        eventId = line.slice(3).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (eventId) {
      this.lastEventId = eventId;
    }

    if (eventName !== "message" || dataLines.length === 0) {
      return;
    }

    const payloadText = dataLines.join("\n");
    if (!payloadText.trim()) {
      return;
    }

    const envelope = JSON.parse(payloadText) as AnyMessage;
    this.pushInbound(envelope);
  }

  private pushInbound(envelope: AnyMessage): void {
    if (this.closed) {
      return;
    }

    this.observeEnvelope(envelope, "inbound");

    try {
      this.readableController?.enqueue(envelope);
    } catch (error) {
      this.failReadable(error);
    }
  }

  private failReadable(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    try {
      this.readableController?.error(error);
    } catch {
      // no-op
    }

    this.readableController = null;

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }
  }

  private observeEnvelope(message: AnyMessage, direction: AcpEnvelopeDirection): void {
    if (!this.onEnvelope) {
      return;
    }

    this.onEnvelope(message, direction);
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
}

function buildClientHandlers(client?: Partial<Client>): Client {
  const fallbackPermission: RequestPermissionResponse = {
    outcome: {
      outcome: "cancelled",
    } as RequestPermissionOutcome,
  };

  return {
    requestPermission: async (request: RequestPermissionRequest) => {
      if (client?.requestPermission) {
        return client.requestPermission(request);
      }
      return fallbackPermission;
    },
    sessionUpdate: async (notification: SessionNotification) => {
      if (client?.sessionUpdate) {
        await client.sessionUpdate(notification);
      }
    },
    readTextFile: client?.readTextFile,
    writeTextFile: client?.writeTextFile,
    createTerminal: client?.createTerminal,
    terminalOutput: client?.terminalOutput,
    releaseTerminal: client?.releaseTerminal,
    waitForTerminalExit: client?.waitForTerminalExit,
    killTerminal: client?.killTerminal,
    extMethod: client?.extMethod,
    extNotification: client?.extNotification,
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type * from "@agentclientprotocol/sdk";
