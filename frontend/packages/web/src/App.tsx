import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Cloud,
  Download,
  HelpCircle,
  PauseCircle,
  PlayCircle,
  PlugZap,
  RefreshCw,
  Send,
  Shield,
  TerminalSquare
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_PREFIX = "/v1";

type AgentInfo = {
  id: string;
  installed: boolean;
  version?: string;
  path?: string;
};

type AgentMode = {
  id: string;
  name: string;
  description?: string;
};

type UniversalEvent = {
  id: number;
  timestamp: string;
  sessionId: string;
  agent: string;
  agentSessionId?: string;
  data: UniversalEventData;
};

type UniversalEventData =
  | { message: UniversalMessage }
  | { started: StartedInfo }
  | { error: CrashInfo }
  | { questionAsked: QuestionRequest }
  | { permissionAsked: PermissionRequest };

type UniversalMessage = {
  role?: string;
  content?: string;
  type?: string;
  raw?: unknown;
};

type StartedInfo = {
  message?: string;
  pid?: number;
  [key: string]: unknown;
};

type CrashInfo = {
  message?: string;
  code?: string;
  detail?: string;
  [key: string]: unknown;
};

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

type QuestionRequest = {
  id: string;
  sessionID?: string;
  questions: QuestionItem[];
  tool?: { messageID?: string; callID?: string };
};

type PermissionRequest = {
  id: string;
  sessionID?: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string };
};

type RequestLog = {
  id: number;
  method: string;
  url: string;
  body?: string;
  status?: number;
  time: string;
  curl: string;
  error?: string;
};

const defaultAgents = ["claude", "codex", "opencode", "amp"];

const buildUrl = (endpoint: string, path: string, query?: Record<string, string>) => {
  const base = endpoint.replace(/\/$/, "");
  const fullPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${fullPath}`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== "") {
        url.searchParams.set(key, value);
      }
    });
  }
  return url.toString();
};

const safeJson = (text: string) => {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const formatJson = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'\\''`);

const buildCurl = (method: string, url: string, body?: string, token?: string) => {
  const headers: string[] = [];
  if (token) {
    headers.push(`-H 'x-sandbox-token: ${escapeSingleQuotes(token)}'`);
  }
  if (body) {
    headers.push(`-H 'Content-Type: application/json'`);
  }
  const data = body ? `-d '${escapeSingleQuotes(body)}'` : "";
  return `curl -X ${method} ${headers.join(" ")} ${data} '${escapeSingleQuotes(url)}'`
    .replace(/\s+/g, " ")
    .trim();
};

const getEventType = (event: UniversalEvent) => {
  if ("message" in event.data) return "message";
  if ("started" in event.data) return "started";
  if ("error" in event.data) return "error";
  if ("questionAsked" in event.data) return "question";
  if ("permissionAsked" in event.data) return "permission";
  return "event";
};

const formatTime = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
};

export default function App() {
  const [endpoint, setEndpoint] = useState("http://localhost:8787");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [modesByAgent, setModesByAgent] = useState<Record<string, AgentMode[]>>({});

  const [agentId, setAgentId] = useState("claude");
  const [agentMode, setAgentMode] = useState("build");
  const [permissionMode, setPermissionMode] = useState("default");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");
  const [agentVersion, setAgentVersion] = useState("");
  const [sessionId, setSessionId] = useState("demo-session");
  const [sessionInfo, setSessionInfo] = useState<{ healthy: boolean; agentSessionId?: string } | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<UniversalEvent[]>([]);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);

  const [polling, setPolling] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const [streamMode, setStreamMode] = useState<"poll" | "sse">("poll");
  const eventSourceRef = useRef<EventSource | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);

  const [questionSelections, setQuestionSelections] = useState<Record<string, string[][]>>({});
  const [questionStatus, setQuestionStatus] = useState<Record<string, "replied" | "rejected">>({});
  const [permissionStatus, setPermissionStatus] = useState<Record<string, "replied" | "rejected">>({});

  const [requestLog, setRequestLog] = useState<RequestLog[]>([]);
  const logIdRef = useRef(1);
  const [copiedLogId, setCopiedLogId] = useState<number | null>(null);

  const logRequest = useCallback((entry: RequestLog) => {
    setRequestLog((prev) => {
      const next = [entry, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  const apiFetch = useCallback(
    async (
      path: string,
      options?: {
        method?: string;
        body?: unknown;
        query?: Record<string, string>;
      }
    ) => {
      const method = options?.method ?? "GET";
      const url = buildUrl(endpoint, path, options?.query);
      const bodyText = options?.body ? JSON.stringify(options.body) : undefined;
      const headers: Record<string, string> = {};
      if (bodyText) {
        headers["Content-Type"] = "application/json";
      }
      if (token) {
        headers["x-sandbox-token"] = token;
      }
      const curl = buildCurl(method, url, bodyText, token);
      const logId = logIdRef.current++;
      const entry: RequestLog = {
        id: logId,
        method,
        url,
        body: bodyText,
        time: new Date().toLocaleTimeString(),
        curl
      };
      let logged = false;

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: bodyText
        });
        const text = await response.text();
        const data = safeJson(text);
        logRequest({ ...entry, status: response.status });
        logged = true;
        if (!response.ok) {
          const errorMessage =
            (typeof data === "object" && data && "detail" in data && data.detail) ||
            (typeof data === "object" && data && "title" in data && data.title) ||
            (typeof data === "string" ? data : `Request failed with ${response.status}`);
          throw new Error(String(errorMessage));
        }
        return data;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        if (!logged) {
          logRequest({ ...entry, status: 0, error: message });
        }
        throw error;
      }
    },
    [endpoint, token, logRequest]
  );

  const connect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const data = await apiFetch(`${API_PREFIX}/agents`);
      const list = (data as { agents?: AgentInfo[] })?.agents ?? [];
      setAgents(list);
      if (list.length > 0) {
        setAgentId(list[0]?.id ?? "claude");
      }
      setConnected(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to connect";
      setConnectError(message);
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    setConnected(false);
    setSessionInfo(null);
    setSessionError(null);
    setEvents([]);
    setOffset(0);
    offsetRef.current = 0;
    setEventError(null);
    stopPolling();
    stopSse();
  };

  const refreshAgents = async () => {
    try {
      const data = await apiFetch(`${API_PREFIX}/agents`);
      setAgents((data as { agents?: AgentInfo[] })?.agents ?? []);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Unable to refresh agents");
    }
  };

  const installAgent = async (targetId: string, reinstall: boolean) => {
    try {
      await apiFetch(`${API_PREFIX}/agents/${targetId}/install`, {
        method: "POST",
        body: { reinstall }
      });
      await refreshAgents();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Install failed");
    }
  };

  const loadModes = async (targetId: string) => {
    try {
      const data = await apiFetch(`${API_PREFIX}/agents/${targetId}/modes`);
      const modes = (data as { modes?: AgentMode[] })?.modes ?? [];
      setModesByAgent((prev) => ({ ...prev, [targetId]: modes }));
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Unable to load modes");
    }
  };

  const createSession = async () => {
    setSessionError(null);
    try {
      const body: Record<string, string> = { agent: agentId };
      if (agentMode) body.agentMode = agentMode;
      if (permissionMode) body.permissionMode = permissionMode;
      if (model) body.model = model;
      if (variant) body.variant = variant;
      if (agentVersion) body.agentVersion = agentVersion;
      const data = await apiFetch(`${API_PREFIX}/sessions/${sessionId}`, {
        method: "POST",
        body
      });
      const response = data as { healthy?: boolean; agentSessionId?: string };
      setSessionInfo({ healthy: Boolean(response.healthy), agentSessionId: response.agentSessionId });
      setEvents([]);
      setOffset(0);
      offsetRef.current = 0;
      setEventError(null);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to create session");
      setSessionInfo(null);
    }
  };

  const sendMessage = async () => {
    if (!message.trim()) return;
    try {
      await apiFetch(`${API_PREFIX}/sessions/${sessionId}/messages`, {
        method: "POST",
        body: { message }
      });
      setMessage("");
    } catch (error) {
      setEventError(error instanceof Error ? error.message : "Unable to send message");
    }
  };

  const appendEvents = useCallback((incoming: UniversalEvent[]) => {
    if (!incoming.length) return;
    setEvents((prev) => [...prev, ...incoming]);
    const lastId = incoming[incoming.length - 1]?.id ?? offsetRef.current;
    offsetRef.current = lastId;
    setOffset(lastId);
  }, []);

  const fetchEvents = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await apiFetch(`${API_PREFIX}/sessions/${sessionId}/events`, {
        query: {
          offset: String(offsetRef.current),
          limit: "200"
        }
      });
      const response = data as { events?: UniversalEvent[]; hasMore?: boolean };
      const newEvents = response.events ?? [];
      appendEvents(newEvents);
      setEventError(null);
    } catch (error) {
      setEventError(error instanceof Error ? error.message : "Unable to fetch events");
    }
  }, [apiFetch, appendEvents, sessionId]);

  const startPolling = () => {
    stopSse();
    if (pollTimerRef.current) return;
    setPolling(true);
    fetchEvents();
    pollTimerRef.current = window.setInterval(fetchEvents, 2500);
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPolling(false);
  };

  const startSse = () => {
    stopPolling();
    if (eventSourceRef.current) return;
    if (token) {
      setEventError("SSE streams cannot send auth headers. Use polling or run daemon with --no-token.");
      return;
    }
    const url = buildUrl(endpoint, `${API_PREFIX}/sessions/${sessionId}/events/sse`, {
      offset: String(offsetRef.current)
    });
    const source = new EventSource(url);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      try {
        const parsed = safeJson(event.data);
        if (Array.isArray(parsed)) {
          appendEvents(parsed as UniversalEvent[]);
        } else if (parsed && typeof parsed === "object") {
          appendEvents([parsed as UniversalEvent]);
        }
      } catch (error) {
        setEventError(error instanceof Error ? error.message : "SSE parse error");
      }
    };
    source.onerror = () => {
      setEventError("SSE connection error. Falling back to polling.");
      stopSse();
    };
  };

  const stopSse = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const resetEvents = () => {
    setEvents([]);
    setOffset(0);
    offsetRef.current = 0;
  };

  const handleCopy = async (entry: RequestLog) => {
    try {
      await navigator.clipboard.writeText(entry.curl);
      setCopiedLogId(entry.id);
      window.setTimeout(() => setCopiedLogId(null), 1500);
    } catch {
      setCopiedLogId(null);
    }
  };

  const toggleQuestionOption = (
    requestId: string,
    questionIndex: number,
    optionLabel: string,
    multiSelect: boolean
  ) => {
    setQuestionSelections((prev) => {
      const next = { ...prev };
      const currentAnswers = next[requestId] ? [...next[requestId]] : [];
      const selections = currentAnswers[questionIndex] ? [...currentAnswers[questionIndex]] : [];
      if (multiSelect) {
        if (selections.includes(optionLabel)) {
          currentAnswers[questionIndex] = selections.filter((label) => label !== optionLabel);
        } else {
          currentAnswers[questionIndex] = [...selections, optionLabel];
        }
      } else {
        currentAnswers[questionIndex] = [optionLabel];
      }
      next[requestId] = currentAnswers;
      return next;
    });
  };

  const answerQuestion = async (request: QuestionRequest) => {
    const answers = questionSelections[request.id] ?? [];
    try {
      await apiFetch(`${API_PREFIX}/sessions/${sessionId}/questions/${request.id}/reply`, {
        method: "POST",
        body: { answers }
      });
      setQuestionStatus((prev) => ({ ...prev, [request.id]: "replied" }));
    } catch (error) {
      setEventError(error instanceof Error ? error.message : "Unable to reply");
    }
  };

  const rejectQuestion = async (requestId: string) => {
    try {
      await apiFetch(`${API_PREFIX}/sessions/${sessionId}/questions/${requestId}/reject`, {
        method: "POST",
        body: {}
      });
      setQuestionStatus((prev) => ({ ...prev, [requestId]: "rejected" }));
    } catch (error) {
      setEventError(error instanceof Error ? error.message : "Unable to reject");
    }
  };

  const replyPermission = async (requestId: string, reply: "once" | "always" | "reject") => {
    try {
      await apiFetch(`${API_PREFIX}/sessions/${sessionId}/permissions/${requestId}/reply`, {
        method: "POST",
        body: { reply }
      });
      setPermissionStatus((prev) => ({ ...prev, [requestId]: "replied" }));
    } catch (error) {
      setEventError(error instanceof Error ? error.message : "Unable to reply");
    }
  };

  const questionRequests = useMemo(() => {
    return events
      .filter((event) => "questionAsked" in event.data)
      .map((event) => (event.data as { questionAsked: QuestionRequest }).questionAsked)
      .filter((request) => !questionStatus[request.id]);
  }, [events, questionStatus]);

  const permissionRequests = useMemo(() => {
    return events
      .filter((event) => "permissionAsked" in event.data)
      .map((event) => (event.data as { permissionAsked: PermissionRequest }).permissionAsked)
      .filter((request) => !permissionStatus[request.id]);
  }, [events, permissionStatus]);

  const transcriptEvents = useMemo(() => {
    return events.filter(
      (event): event is UniversalEvent & { data: { message: UniversalMessage } } => "message" in event.data
    );
  }, [events]);

  useEffect(() => {
    return () => {
      stopPolling();
      stopSse();
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    refreshAgents();
  }, [connected]);

  const availableAgents = agents.length ? agents.map((agent) => agent.id) : defaultAgents;
  const activeModes = modesByAgent[agentId] ?? [];

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" />
          Sandbox Daemon Console
        </div>
        <div className="inline-row">
          <span className={`status-pill ${connected ? "success" : "warning"}`}>
            <span className="status-dot" />
            {connected ? "Connected" : "Disconnected"}
          </span>
          {connected && (
            <button className="button secondary" onClick={disconnect} type="button">
              Disconnect
            </button>
          )}
        </div>
      </header>

      {!connected ? (
        <main className="connect-screen">
          <section className="connect-hero reveal">
            <div className="hero-title">Bring the agent fleet online.</div>
            <div className="hero-subtitle">
              Point this console at a running sandbox-daemon, then manage sessions, messages, and approvals in
              one place.
            </div>
            <div className="callout mono">
              sandbox-daemon --host 0.0.0.0 --port 8787 --token &lt;token&gt; --cors-allowed-origin
              http://localhost:5173 --cors-allowed-methods GET,POST --cors-allowed-headers Authorization,x-sandbox-token
            </div>
            <div className="tag-list">
              <span className="pill">CORS required for browser access</span>
              <span className="pill neutral">Token optional with --no-token</span>
              <span className="pill">HTTP API under /v1</span>
            </div>
            <div className="muted">
              If you see a network or CORS error, make sure CORS flags are enabled in the daemon CLI.
            </div>
          </section>
          <section className="panel reveal">
            <div className="panel-header">
              <span className="inline-row">
                <PlugZap className="button-icon" />
                Connect
              </span>
            </div>
            <div className="panel-body">
              <label className="field">
                <span className="label">Endpoint</span>
                <input
                  className="input"
                  placeholder="http://localhost:8787"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="label">Token (optional)</span>
                <input
                  className="input"
                  placeholder="x-sandbox-token"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              {connectError && (
                <div className="banner">
                  <strong>Connection failed:</strong> {connectError}
                  <div className="muted">If this is a CORS error, enable CORS flags on the daemon.</div>
                </div>
              )}
              <button className="button primary" onClick={connect} disabled={connecting} type="button">
                {connecting ? (
                  <span className="inline-row">
                    <span className="spinner" /> Connecting
                  </span>
                ) : (
                  "Connect"
                )}
              </button>
            </div>
          </section>
        </main>
      ) : (
        <main className="grid">
          <section className="panel reveal">
            <div className="panel-header">
              <span className="inline-row">
                <Cloud className="button-icon" />
                Agents
              </span>
              <button className="button ghost" type="button" onClick={refreshAgents}>
                <RefreshCw className="button-icon" /> Refresh
              </button>
            </div>
            <div className="panel-body">
              {agents.length === 0 && <div className="muted">No agents reported yet. Refresh when ready.</div>}
              <div className="card-list">
                {(agents.length ? agents : defaultAgents.map((id) => ({ id, installed: false }))).map((agent) => (
                  <div key={agent.id} className="card">
                    <div className="inline-row">
                      <span className="card-title">{agent.id}</span>
                      <span className={`pill ${agent.installed ? "success" : "danger"}`}>
                        {agent.installed ? "Installed" : "Missing"}
                      </span>
                    </div>
                    <div className="card-meta">
                      {agent.version ? `Version ${agent.version}` : "Version unknown"}
                    </div>
                    {agent.path && <div className="mono muted">{agent.path}</div>}
                    <div className="inline-row">
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => installAgent(agent.id, false)}
                      >
                        <Download className="button-icon" /> Install
                      </button>
                      <button
                        className="button ghost"
                        type="button"
                        onClick={() => installAgent(agent.id, true)}
                      >
                        Reinstall
                      </button>
                      <button className="button ghost" type="button" onClick={() => loadModes(agent.id)}>
                        Modes
                      </button>
                    </div>
                    {modesByAgent[agent.id] && modesByAgent[agent.id].length > 0 && (
                      <div className="stack">
                        {modesByAgent[agent.id].map((mode) => (
                          <div key={mode.id} className="card-meta">
                            <strong>{mode.name}</strong> - {mode.description ?? mode.id}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.05s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <TerminalSquare className="button-icon" />
                Session Setup
              </span>
            </div>
            <div className="panel-body">
              <label className="field">
                <span className="label">Session Id</span>
                <input className="input" value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
              </label>
              <label className="field">
                <span className="label">Agent</span>
                <select className="select" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                  {availableAgents.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">Agent Mode</span>
                <input
                  className="input"
                  value={agentMode}
                  onChange={(event) => setAgentMode(event.target.value)}
                  placeholder="build"
                />
                {activeModes.length > 0 && (
                  <div className="muted">Available modes: {activeModes.map((mode) => mode.id).join(", ")}</div>
                )}
              </label>
              <label className="field">
                <span className="label">Permission Mode</span>
                <select
                  className="select"
                  value={permissionMode}
                  onChange={(event) => setPermissionMode(event.target.value)}
                >
                  <option value="default">default</option>
                  <option value="plan">plan</option>
                  <option value="bypass">bypass</option>
                </select>
              </label>
              <div className="inline-row">
                <label className="field" style={{ flex: 1 }}>
                  <span className="label">Model</span>
                  <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span className="label">Variant</span>
                  <input className="input" value={variant} onChange={(event) => setVariant(event.target.value)} />
                </label>
              </div>
              <label className="field">
                <span className="label">Agent Version</span>
                <input
                  className="input"
                  value={agentVersion}
                  onChange={(event) => setAgentVersion(event.target.value)}
                />
              </label>
              {sessionInfo && (
                <div className={sessionInfo.healthy ? "success-banner" : "banner"}>
                  {sessionInfo.healthy ? "Session ready." : "Session unhealthy."}
                  {sessionInfo.agentSessionId && (
                    <div className="mono muted">Agent session id: {sessionInfo.agentSessionId}</div>
                  )}
                </div>
              )}
              {sessionError && <div className="banner">{sessionError}</div>}
              <button className="button primary" type="button" onClick={createSession}>
                Create / Attach Session
              </button>
              <div className="muted">
                Agent mode controls behavior. Permission mode controls what the agent can do.
              </div>
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.1s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <Send className="button-icon" />
                Message
              </span>
              <span className="pill neutral">POST /sessions/:id/messages</span>
            </div>
            <div className="panel-body">
              <label className="field">
                <span className="label">Prompt</span>
                <textarea
                  className="textarea"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Ask the agent to do something..."
                />
              </label>
              <div className="inline-row">
                <button className="button primary" type="button" onClick={sendMessage}>
                  Send Message
                </button>
                <button className="button ghost" type="button" onClick={fetchEvents}>
                  Fetch Events
                </button>
              </div>
              {eventError && <div className="banner">{eventError}</div>}
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.15s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <HelpCircle className="button-icon" />
                Questions
              </span>
            </div>
            <div className="panel-body">
              {questionRequests.length === 0 && <div className="muted">No pending questions.</div>}
              <div className="card-list">
                {questionRequests.map((request) => {
                  const selections = questionSelections[request.id] ?? [];
                  const answeredAll = request.questions.every((question, idx) => {
                    const answer = selections[idx] ?? [];
                    return answer.length > 0;
                  });
                  return (
                    <div key={request.id} className="card">
                      <div className="inline-row">
                        <span className="card-title">Question {request.id}</span>
                        <span className="pill">question.asked</span>
                      </div>
                      {request.questions.map((question, index) => (
                        <div key={`${request.id}-${index}`} className="stack">
                          <div className="card-meta">
                            {question.header && <strong>{question.header}: </strong>}
                            {question.question}
                          </div>
                          <div className="stack">
                            {question.options.map((option) => {
                              const selected = selections[index]?.includes(option.label) ?? false;
                              return (
                                <label key={option.label} className="inline-row" style={{ gap: "8px" }}>
                                  <input
                                    type={question.multiSelect ? "checkbox" : "radio"}
                                    checked={selected}
                                    onChange={() =>
                                      toggleQuestionOption(
                                        request.id,
                                        index,
                                        option.label,
                                        Boolean(question.multiSelect)
                                      )
                                    }
                                  />
                                  <span>
                                    {option.label}
                                    {option.description ? ` - ${option.description}` : ""}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      <div className="inline-row">
                        <button
                          className="button success"
                          type="button"
                          disabled={!answeredAll}
                          onClick={() => answerQuestion(request)}
                        >
                          Reply
                        </button>
                        <button className="button danger" type="button" onClick={() => rejectQuestion(request.id)}>
                          Reject
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.2s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <Shield className="button-icon" />
                Permissions
              </span>
            </div>
            <div className="panel-body">
              {permissionRequests.length === 0 && <div className="muted">No pending permissions.</div>}
              <div className="card-list">
                {permissionRequests.map((request) => (
                  <div key={request.id} className="card">
                    <div className="inline-row">
                      <span className="card-title">Permission {request.id}</span>
                      <span className="pill">permission.asked</span>
                    </div>
                    <div className="card-meta">{request.permission}</div>
                    {request.patterns && request.patterns.length > 0 && (
                      <div className="mono muted">{request.patterns.join(", ")}</div>
                    )}
                    {request.metadata && (
                      <pre className="code-block mono">{formatJson(request.metadata)}</pre>
                    )}
                    <div className="inline-row">
                      <button
                        className="button success"
                        type="button"
                        onClick={() => replyPermission(request.id, "once")}
                      >
                        Allow Once
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => replyPermission(request.id, "always")}
                      >
                        Allow Always
                      </button>
                      <button
                        className="button danger"
                        type="button"
                        onClick={() => replyPermission(request.id, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.25s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <PlayCircle className="button-icon" />
                Event Stream
              </span>
              <span className="pill neutral">GET /sessions/:id/events</span>
            </div>
            <div className="panel-body">
              <div className="inline-row">
                <label className="inline-row" style={{ gap: "8px" }}>
                  <input
                    type="radio"
                    checked={streamMode === "poll"}
                    onChange={() => setStreamMode("poll")}
                  />
                  Polling
                </label>
                <label className="inline-row" style={{ gap: "8px" }}>
                  <input
                    type="radio"
                    checked={streamMode === "sse"}
                    onChange={() => setStreamMode("sse")}
                  />
                  SSE
                </label>
              </div>
              <div className="inline-row">
                {streamMode === "poll" ? (
                  polling ? (
                    <button className="button secondary" type="button" onClick={stopPolling}>
                      <PauseCircle className="button-icon" /> Stop Polling
                    </button>
                  ) : (
                    <button className="button primary" type="button" onClick={startPolling}>
                      <PlayCircle className="button-icon" /> Start Polling
                    </button>
                  )
                ) : (
                  <button className="button primary" type="button" onClick={startSse}>
                    <PlayCircle className="button-icon" /> Start SSE
                  </button>
                )}
                <button className="button ghost" type="button" onClick={() => (streamMode === "poll" ? stopPolling() : stopSse())}>
                  Stop
                </button>
                <button className="button ghost" type="button" onClick={resetEvents}>
                  Clear
                </button>
              </div>
              <div className="muted">Offset: {offset}</div>
              <div className="event-list">
                {events.length === 0 && <div className="muted">No events yet.</div>}
                {events.map((event) => {
                  const type = getEventType(event);
                  return (
                    <div key={`${event.id}-${type}`} className="event-item">
                      <div className="event-title">
                        <span className="event-type">{type}</span>
                        <span className="event-time">{formatTime(event.timestamp)}</span>
                      </div>
                      <div className="mono muted">Event {event.id}</div>
                      <pre className="code-block mono">{formatJson(event.data)}</pre>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.3s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <CheckCircle2 className="button-icon" />
                Transcript
              </span>
              <span className="pill neutral">Messages</span>
            </div>
            <div className="panel-body">
              {transcriptEvents.length === 0 && <div className="muted">No messages captured yet.</div>}
              <div className="event-list">
                {transcriptEvents.map((event) => (
                  <div key={`msg-${event.id}`} className="event-item">
                    <div className="event-title">
                      <span className="event-type">{event.data.message?.role ?? "message"}</span>
                      <span className="event-time">{formatTime(event.timestamp)}</span>
                    </div>
                    <pre className="code-block mono">{formatJson(event.data.message)}</pre>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel reveal" style={{ animationDelay: "0.35s" }}>
            <div className="panel-header">
              <span className="inline-row">
                <AlertCircle className="button-icon" />
                Request Log
              </span>
              <button className="button ghost" type="button" onClick={() => setRequestLog([])}>
                Clear
              </button>
            </div>
            <div className="panel-body">
              <div className="log-list">
                {requestLog.length === 0 && <div className="muted">No requests logged yet.</div>}
                {requestLog.map((entry) => (
                  <div key={entry.id} className="log-item">
                    <div className="log-method">{entry.method}</div>
                    <div className="log-url mono">{entry.url}</div>
                    <div className={`log-status ${entry.status && entry.status < 400 ? "ok" : "error"}`}>
                      {entry.status ?? "ERR"}
                    </div>
                    <div className="mono muted" style={{ gridColumn: "1 / -1" }}>
                      {entry.time}
                      {entry.error ? ` - ${entry.error}` : ""}
                    </div>
                    <div className="inline-row" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}>
                      <button className="copy-button" type="button" onClick={() => handleCopy(entry)}>
                        <Clipboard className="button-icon" />
                        {copiedLogId === entry.id ? "Copied" : "Copy curl"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
