import {
  Clipboard,
  Cloud,
  Download,
  HelpCircle,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Send,
  Shield,
  Terminal,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_PREFIX = "/v1";

type AgentInfo = {
  id: string;
  installed: boolean;
  version?: string;
  path?: string;
};

type SessionInfo = {
  sessionId: string;
  agent: string;
  agentMode: string;
  permissionMode: string;
  model?: string;
  variant?: string;
  agentSessionId?: string;
  ended: boolean;
  eventCount: number;
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

type UniversalMessagePart = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
};

type UniversalMessage = {
  role?: string;
  parts?: UniversalMessagePart[];
  raw?: unknown;
  error?: string;
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

type DebugTab = "log" | "events" | "approvals" | "agents";

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
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const formatJson = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
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
    headers.push(`-H 'Authorization: Bearer ${escapeSingleQuotes(token)}'`);
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
  const [endpoint, setEndpoint] = useState("http://localhost:2468");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [modesByAgent, setModesByAgent] = useState<Record<string, AgentMode[]>>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const [agentId, setAgentId] = useState("claude");
  const [agentMode, setAgentMode] = useState("");
  const [permissionMode, setPermissionMode] = useState("default");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");
  const [sessionId, setSessionId] = useState("");
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

  const [debugTab, setDebugTab] = useState<DebugTab>("events");

  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        headers.Authorization = `Bearer ${token}`;
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
      await apiFetch(`${API_PREFIX}/health`);
      setConnected(true);
      await refreshAgents();
      await fetchSessions();
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
      const agentList = (data as { agents?: AgentInfo[] })?.agents ?? [];
      setAgents(agentList);
      // Auto-load modes for installed agents
      for (const agent of agentList) {
        if (agent.installed) {
          loadModes(agent.id);
        }
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "Unable to refresh agents");
    }
  };

  const fetchSessions = async () => {
    try {
      const data = await apiFetch(`${API_PREFIX}/sessions`);
      const sessionList = (data as { sessions?: SessionInfo[] })?.sessions ?? [];
      setSessions(sessionList);
    } catch {
      // Silently fail - sessions list is supplementary
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
    } catch {
      // Silently fail - modes are optional
    }
  };

  const sendMessage = async () => {
    if (!message.trim()) return;
    setSessionError(null);
    try {
      await apiFetch(`${API_PREFIX}/sessions/${sessionId}/messages`, {
        method: "POST",
        body: { message }
      });
      setMessage("");

      // Auto-start polling if not already
      if (!polling && streamMode === "poll") {
        startPolling();
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to send message");
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

      await apiFetch(`${API_PREFIX}/sessions/${sessionId}`, {
        method: "POST",
        body
      });
      await fetchSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to create session");
    }
  };

  const selectSession = (session: SessionInfo) => {
    setSessionId(session.sessionId);
    setAgentId(session.agent);
    setAgentMode(session.agentMode);
    setPermissionMode(session.permissionMode);
    setModel(session.model ?? "");
    setVariant(session.variant ?? "");
    // Reset events and offset when switching sessions
    setEvents([]);
    setOffset(0);
    offsetRef.current = 0;
    setSessionError(null);
  };

  const createNewSession = async () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "session-";
    for (let i = 0; i < 8; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    setSessionId(id);
    setEvents([]);
    setOffset(0);
    offsetRef.current = 0;
    setSessionError(null);

    // Create the session
    try {
      const body: Record<string, string> = { agent: agentId };
      if (agentMode) body.agentMode = agentMode;
      if (permissionMode) body.permissionMode = permissionMode;
      if (model) body.model = model;
      if (variant) body.variant = variant;

      await apiFetch(`${API_PREFIX}/sessions/${id}`, {
        method: "POST",
        body
      });
      await fetchSessions();
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Unable to create session");
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

  const transcriptMessages = useMemo(() => {
    return events
      .filter((event): event is UniversalEvent & { data: { message: UniversalMessage } } => "message" in event.data)
      .map((event) => {
        const msg = event.data.message;
        // Extract text from parts array
        const content = msg?.parts
          ?.filter((part) => part.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n") ?? "";
        return {
          id: event.id,
          role: msg?.role ?? "assistant",
          content,
          timestamp: event.timestamp
        };
      })
      .filter((msg) => msg.content);
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptMessages]);

  // Auto-load modes when agent changes
  useEffect(() => {
    if (connected && agentId && !modesByAgent[agentId]) {
      loadModes(agentId);
    }
  }, [connected, agentId]);

  // Set default mode when modes are loaded
  useEffect(() => {
    const modes = modesByAgent[agentId];
    if (modes && modes.length > 0 && !agentMode) {
      setAgentMode(modes[0].id);
    }
  }, [modesByAgent, agentId]);

  const availableAgents = agents.length ? agents.map((agent) => agent.id) : defaultAgents;
  const currentAgent = agents.find((a) => a.id === agentId);
  const activeModes = modesByAgent[agentId] ?? [];
  const pendingApprovals = questionRequests.length + permissionRequests.length;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const toggleStream = () => {
    if (polling) {
      stopPolling();
    } else if (streamMode === "poll") {
      startPolling();
    } else {
      startSse();
    }
  };

  if (!connected) {
    return (
      <div className="app">
        <header className="header">
          <div className="header-left">
            <div className="logo">SA</div>
            <span className="header-title">Sandbox Agent</span>
          </div>
        </header>

        <main className="landing">
          <div className="landing-container">
            <div className="landing-hero">
              <div className="landing-logo">SA</div>
              <h1 className="landing-title">Sandbox Agent</h1>
              <p className="landing-subtitle">
                Universal API for running Claude Code, Codex, OpenCode, and Amp inside sandboxes.
              </p>
            </div>

            <div className="connect-card">
              <div className="connect-card-title">Connect to Daemon</div>

              {connectError && (
                <div className="banner error">{connectError}</div>
              )}

              <label className="field">
                <span className="label">Endpoint</span>
                <input
                  className="input"
                  type="text"
                  placeholder="http://localhost:2468"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </label>

              <label className="field">
                <span className="label">Token (optional)</span>
                <input
                  className="input"
                  type="password"
                  placeholder="Bearer token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>

              <button
                className="button primary"
                onClick={connect}
                disabled={connecting}
              >
                {connecting ? (
                  <>
                    <span className="spinner" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Zap className="button-icon" />
                    Connect
                  </>
                )}
              </button>

              <p className="hint">
                Start the daemon with CORS enabled for browser access:<br />
                <code>sandbox-agent --cors-allow-origin http://localhost:5173</code>
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">SA</div>
          <span className="header-title">Sandbox Agent</span>
        </div>
        <div className="header-right">
          <span className="header-endpoint">{endpoint}</span>
          <button className="button secondary small" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <main className="main-layout">
        {/* Session Sidebar */}
        <div className="session-sidebar">
          <div className="sidebar-header">
            <span className="sidebar-title">Sessions</span>
            <div className="sidebar-header-actions">
              <button
                className="sidebar-icon-btn"
                onClick={fetchSessions}
                title="Refresh sessions"
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="sidebar-add-btn"
                onClick={createNewSession}
                title="New session"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          <div className="session-list">
            {sessions.length === 0 ? (
              <div className="sidebar-empty">
                No sessions yet.
              </div>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.sessionId}
                  className={`session-item ${session.sessionId === sessionId ? "active" : ""}`}
                  onClick={() => selectSession(session)}
                >
                  <div className="session-item-id">{session.sessionId}</div>
                  <div className="session-item-meta">
                    <span className="session-item-agent">{session.agent}</span>
                    <span className="session-item-events">{session.eventCount} events</span>
                    {session.ended && <span className="session-item-ended">ended</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Chat Panel */}
        <div className="chat-panel">
          <div className="panel-header">
            <div className="panel-header-left">
              <MessageSquare className="button-icon" />
              <span className="panel-title">Session</span>
              {sessionId && <span className="session-id-display">{sessionId}</span>}
            </div>
            {polling && (
              <span className="pill accent">Live</span>
            )}
          </div>

          <div className="messages-container">
            {!sessionId ? (
              <div className="empty-state">
                <MessageSquare className="empty-state-icon" />
                <div className="empty-state-title">No Session Selected</div>
                <p className="empty-state-text">
                  Create a new session to start chatting with an agent.
                </p>
                <button className="button primary" onClick={createNewSession}>
                  <Plus className="button-icon" />
                  Create Session
                </button>
              </div>
            ) : transcriptMessages.length === 0 && !sessionError ? (
              <div className="empty-state">
                <Terminal className="empty-state-icon" />
                <div className="empty-state-title">Ready to Chat</div>
                <p className="empty-state-text">
                  Send a message to start a conversation with the agent.
                </p>
              </div>
            ) : (
              <div className="messages">
                {transcriptMessages.map((msg) => (
                  <div key={msg.id} className={`message ${msg.role === "user" ? "user" : "assistant"}`}>
                    <div className="avatar">
                      {msg.role === "user" ? "U" : "AI"}
                    </div>
                    <div className="message-content">
                      {msg.content}
                    </div>
                  </div>
                ))}
                {sessionError && (
                  <div className="message-error">
                    {sessionError}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input Area */}
          <div className="input-container">
            <div className="input-wrapper">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={sessionId ? "Send a message..." : "Select or create a session first"}
                rows={1}
                disabled={!sessionId}
              />
              <button
                className="send-button"
                onClick={sendMessage}
                disabled={!sessionId || !message.trim()}
              >
                <Send />
              </button>
            </div>
          </div>

          {/* Setup Controls Row */}
          <div className="setup-row">
            <select
              className="setup-select"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              title="Agent"
            >
              {availableAgents.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>

            <select
              className="setup-select"
              value={agentMode}
              onChange={(e) => setAgentMode(e.target.value)}
              title="Mode"
            >
              {activeModes.length > 0 ? (
                activeModes.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.name || mode.id}</option>
                ))
              ) : (
                <option value="">mode</option>
              )}
            </select>

            <select
              className="setup-select"
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
              title="Permission Mode"
            >
              <option value="default">default</option>
              <option value="plan">plan</option>
              <option value="bypass">bypass</option>
            </select>

            <input
              className="setup-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model"
              title="Model"
            />

            <input
              className="setup-input"
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              placeholder="variant"
              title="Variant"
            />

            <div className="setup-stream">
              <select
                className="setup-select-small"
                value={streamMode}
                onChange={(e) => setStreamMode(e.target.value as "poll" | "sse")}
                title="Stream Mode"
              >
                <option value="poll">poll</option>
                <option value="sse">sse</option>
              </select>
              <button
                className={`setup-stream-btn ${polling ? "active" : ""}`}
                onClick={toggleStream}
                title={polling ? "Stop streaming" : "Start streaming"}
              >
                {polling ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
              </button>
            </div>

            {currentAgent?.version && (
              <span className="setup-version" title="Installed version">
                v{currentAgent.version}
              </span>
            )}
          </div>
        </div>

        {/* Debug Panel - Right */}
        <div className="debug-panel">
          <div className="debug-tabs">
            <button
              className={`debug-tab ${debugTab === "events" ? "active" : ""}`}
              onClick={() => setDebugTab("events")}
            >
              <PlayCircle className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
              Events
              {events.length > 0 && (
                <span className="debug-tab-badge">{events.length}</span>
              )}
            </button>
            <button
              className={`debug-tab ${debugTab === "log" ? "active" : ""}`}
              onClick={() => setDebugTab("log")}
            >
              <Terminal className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
              Request Log
            </button>
            <button
              className={`debug-tab ${debugTab === "approvals" ? "active" : ""}`}
              onClick={() => setDebugTab("approvals")}
            >
              <Shield className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
              Approvals
              {pendingApprovals > 0 && (
                <span className="debug-tab-badge">{pendingApprovals}</span>
              )}
            </button>
            <button
              className={`debug-tab ${debugTab === "agents" ? "active" : ""}`}
              onClick={() => setDebugTab("agents")}
            >
              <Cloud className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
              Agents
            </button>
          </div>

          <div className="debug-content">
            {/* Log Tab */}
            {debugTab === "log" && (
              <>
                <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
                  <span className="card-meta">{requestLog.length} requests</span>
                  <button className="button ghost small" onClick={() => setRequestLog([])}>
                    Clear
                  </button>
                </div>

                {requestLog.length === 0 ? (
                  <div className="card-meta">No requests logged yet.</div>
                ) : (
                  requestLog.map((entry) => (
                    <div key={entry.id} className="log-item">
                      <span className="log-method">{entry.method}</span>
                      <span className="log-url text-truncate">{entry.url}</span>
                      <span className={`log-status ${entry.status && entry.status < 400 ? "ok" : "error"}`}>
                        {entry.status || "ERR"}
                      </span>
                      <div className="log-meta">
                        <span>{entry.time}{entry.error && ` - ${entry.error}`}</span>
                        <button className="copy-button" onClick={() => handleCopy(entry)}>
                          <Clipboard />
                          {copiedLogId === entry.id ? "Copied" : "curl"}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </>
            )}

            {/* Events Tab */}
            {debugTab === "events" && (
              <>
                <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
                  <span className="card-meta">Offset: {offset}</span>
                  <div className="inline-row">
                    <button className="button ghost small" onClick={fetchEvents}>
                      Fetch
                    </button>
                    <button className="button ghost small" onClick={resetEvents}>
                      Clear
                    </button>
                  </div>
                </div>

                {events.length === 0 ? (
                  <div className="card-meta">No events yet. Start streaming to receive events.</div>
                ) : (
                  <div className="event-list">
                    {[...events].reverse().map((event) => {
                      const type = getEventType(event);
                      return (
                        <div key={event.id} className="event-item">
                          <div className="event-header">
                            <span className={`event-type ${type}`}>{type}</span>
                            <span className="event-time">{formatTime(event.timestamp)}</span>
                          </div>
                          <div className="event-id">Event #{event.id}</div>
                          <pre className="code-block">{formatJson(event.data)}</pre>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* Approvals Tab */}
            {debugTab === "approvals" && (
              <>
                {questionRequests.length === 0 && permissionRequests.length === 0 ? (
                  <div className="card-meta">No pending approvals.</div>
                ) : (
                  <>
                    {questionRequests.map((request) => {
                      const selections = questionSelections[request.id] ?? [];
                      const answeredAll = request.questions.every((q, idx) => {
                        const answer = selections[idx] ?? [];
                        return answer.length > 0;
                      });
                      return (
                        <div key={request.id} className="card">
                          <div className="card-header">
                            <span className="card-title">
                              <HelpCircle className="button-icon" style={{ marginRight: 6 }} />
                              Question
                            </span>
                            <span className="pill accent">Pending</span>
                          </div>
                          {request.questions.map((question, qIdx) => (
                            <div key={qIdx} style={{ marginTop: 12 }}>
                              <div style={{ fontSize: 12, marginBottom: 8 }}>
                                {question.header && <strong>{question.header}: </strong>}
                                {question.question}
                              </div>
                              <div className="option-list">
                                {question.options.map((option) => {
                                  const selected = selections[qIdx]?.includes(option.label) ?? false;
                                  return (
                                    <label key={option.label} className="option-item">
                                      <input
                                        type={question.multiSelect ? "checkbox" : "radio"}
                                        checked={selected}
                                        onChange={() =>
                                          toggleQuestionOption(
                                            request.id,
                                            qIdx,
                                            option.label,
                                            Boolean(question.multiSelect)
                                          )
                                        }
                                      />
                                      <span>
                                        {option.label}
                                        {option.description && (
                                          <span className="muted"> - {option.description}</span>
                                        )}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                          <div className="card-actions">
                            <button
                              className="button success small"
                              disabled={!answeredAll}
                              onClick={() => answerQuestion(request)}
                            >
                              Reply
                            </button>
                            <button
                              className="button danger small"
                              onClick={() => rejectQuestion(request.id)}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {permissionRequests.map((request) => (
                      <div key={request.id} className="card">
                        <div className="card-header">
                          <span className="card-title">
                            <Shield className="button-icon" style={{ marginRight: 6 }} />
                            Permission
                          </span>
                          <span className="pill accent">Pending</span>
                        </div>
                        <div className="card-meta" style={{ marginTop: 8 }}>
                          {request.permission}
                        </div>
                        {request.patterns && request.patterns.length > 0 && (
                          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {request.patterns.join(", ")}
                          </div>
                        )}
                        {request.metadata && (
                          <pre className="code-block">{formatJson(request.metadata)}</pre>
                        )}
                        <div className="card-actions">
                          <button
                            className="button success small"
                            onClick={() => replyPermission(request.id, "once")}
                          >
                            Allow Once
                          </button>
                          <button
                            className="button secondary small"
                            onClick={() => replyPermission(request.id, "always")}
                          >
                            Always
                          </button>
                          <button
                            className="button danger small"
                            onClick={() => replyPermission(request.id, "reject")}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            {/* Agents Tab */}
            {debugTab === "agents" && (
              <>
                <div className="inline-row" style={{ marginBottom: 16 }}>
                  <button className="button secondary small" onClick={refreshAgents}>
                    <RefreshCw className="button-icon" /> Refresh
                  </button>
                </div>

                {agents.length === 0 && (
                  <div className="card-meta">No agents reported. Click refresh to check.</div>
                )}

                {(agents.length ? agents : defaultAgents.map((id) => ({ id, installed: false, version: undefined, path: undefined }))).map((agent) => (
                  <div key={agent.id} className="card">
                    <div className="card-header">
                      <span className="card-title">{agent.id}</span>
                      <span className={`pill ${agent.installed ? "success" : "danger"}`}>
                        {agent.installed ? "Installed" : "Missing"}
                      </span>
                    </div>
                    <div className="card-meta">
                      {agent.version ? `v${agent.version}` : "Version unknown"}
                      {agent.path && <span className="mono muted" style={{ marginLeft: 8 }}>{agent.path}</span>}
                    </div>
                    {modesByAgent[agent.id] && modesByAgent[agent.id].length > 0 && (
                      <div className="card-meta" style={{ marginTop: 8 }}>
                        Modes: {modesByAgent[agent.id].map((m) => m.id).join(", ")}
                      </div>
                    )}
                    <div className="card-actions">
                      <button
                        className="button secondary small"
                        onClick={() => installAgent(agent.id, false)}
                      >
                        <Download className="button-icon" /> Install
                      </button>
                      <button
                        className="button ghost small"
                        onClick={() => installAgent(agent.id, true)}
                      >
                        Reinstall
                      </button>
                      <button
                        className="button ghost small"
                        onClick={() => loadModes(agent.id)}
                      >
                        Modes
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
