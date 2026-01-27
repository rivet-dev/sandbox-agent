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
import {
  SandboxDaemonError,
  createSandboxDaemonClient,
  type SandboxDaemonClient,
  type AgentInfo,
  type AgentCapabilities,
  type AgentModeInfo,
  type PermissionEventData,
  type QuestionEventData,
  type SessionInfo,
  type UniversalEvent,
  type UniversalItem,
  type ContentPart
} from "sandbox-agent";

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

type ItemEventData = {
  item: UniversalItem;
};

type ItemDeltaEventData = {
  item_id: string;
  native_item_id?: string | null;
  delta: string;
};

type TimelineEntry = {
  id: string;
  kind: "item" | "meta";
  time: string;
  item?: UniversalItem;
  deltaText?: string;
  meta?: {
    title: string;
    detail?: string;
    severity?: "info" | "error";
  };
};

type DebugTab = "log" | "events" | "approvals" | "agents";

const defaultAgents = ["claude", "codex", "opencode", "amp"];
const emptyCapabilities: AgentCapabilities = {
  planMode: false,
  permissions: false,
  questions: false,
  toolCalls: false
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

const formatCapabilities = (capabilities: AgentCapabilities) => {
  const parts = [
    `planMode ${capabilities.planMode ? "✓" : "—"}`,
    `permissions ${capabilities.permissions ? "✓" : "—"}`,
    `questions ${capabilities.questions ? "✓" : "—"}`,
    `toolCalls ${capabilities.toolCalls ? "✓" : "—"}`
  ];
  return parts.join(" · ");
};

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

const getEventType = (event: UniversalEvent) => event.type;

const formatTime = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
};

const getEventCategory = (type: string) => type.split(".")[0] ?? type;

const getEventClass = (type: string) => type.replace(/\./g, "-");

const buildStubItem = (itemId: string, nativeItemId?: string | null): UniversalItem => {
  return {
    item_id: itemId,
    native_item_id: nativeItemId ?? null,
    parent_id: null,
    kind: "message",
    role: null,
    content: [],
    status: "in_progress"
  } as UniversalItem;
};

const getMessageClass = (item: UniversalItem) => {
  if (item.kind === "tool_call" || item.kind === "tool_result") return "tool";
  if (item.kind === "system" || item.kind === "status") return "system";
  if (item.role === "user") return "user";
  if (item.role === "tool") return "tool";
  if (item.role === "system") return "system";
  return "assistant";
};

const getAvatarLabel = (messageClass: string) => {
  if (messageClass === "user") return "U";
  if (messageClass === "tool") return "T";
  if (messageClass === "system") return "S";
  if (messageClass === "error") return "!";
  return "AI";
};

const renderContentPart = (part: ContentPart, index: number) => {
  const partType = (part as { type?: string }).type ?? "unknown";
  const key = `${partType}-${index}`;
  switch (partType) {
    case "text":
      return (
        <div key={key} className="part">
          <div className="part-body">{(part as { text: string }).text}</div>
        </div>
      );
    case "json":
      return (
        <div key={key} className="part">
          <div className="part-title">json</div>
          <pre className="code-block">{formatJson((part as { json: unknown }).json)}</pre>
        </div>
      );
    case "tool_call": {
      const { name, arguments: args, call_id } = part as {
        name: string;
        arguments: string;
        call_id: string;
      };
      return (
        <div key={key} className="part">
          <div className="part-title">
            tool call - {name}
            {call_id ? ` - ${call_id}` : ""}
          </div>
          {args ? <pre className="code-block">{args}</pre> : <div className="muted">No arguments</div>}
        </div>
      );
    }
    case "tool_result": {
      const { call_id, output } = part as { call_id: string; output: string };
      return (
        <div key={key} className="part">
          <div className="part-title">tool result - {call_id}</div>
          {output ? <pre className="code-block">{output}</pre> : <div className="muted">No output</div>}
        </div>
      );
    }
    case "file_ref": {
      const { path, action, diff } = part as { path: string; action: string; diff?: string | null };
      return (
        <div key={key} className="part">
          <div className="part-title">file - {action}</div>
          <div className="part-body mono">{path}</div>
          {diff && <pre className="code-block">{diff}</pre>}
        </div>
      );
    }
    case "reasoning": {
      const { text, visibility } = part as { text: string; visibility: string };
      return (
        <div key={key} className="part">
          <div className="part-title">reasoning - {visibility}</div>
          <div className="part-body muted">{text}</div>
        </div>
      );
    }
    case "image": {
      const { path, mime } = part as { path: string; mime?: string | null };
      return (
        <div key={key} className="part">
          <div className="part-title">image {mime ? `- ${mime}` : ""}</div>
          <div className="part-body mono">{path}</div>
        </div>
      );
    }
    case "status": {
      const { label, detail } = part as { label: string; detail?: string | null };
      return (
        <div key={key} className="part">
          <div className="part-title">status - {label}</div>
          {detail && <div className="part-body">{detail}</div>}
        </div>
      );
    }
    default:
      return (
        <div key={key} className="part">
          <div className="part-title">unknown</div>
          <pre className="code-block">{formatJson(part)}</pre>
        </div>
      );
  }
};

const getDefaultEndpoint = () => {
  if (typeof window === "undefined") return "http://127.0.0.1:2468";
  const { origin, protocol } = window.location;
  if (!origin || origin === "null" || protocol === "file:") {
    return "http://127.0.0.1:2468";
  }
  return origin;
};

export default function App() {
  const [endpoint, setEndpoint] = useState(getDefaultEndpoint);
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [modesByAgent, setModesByAgent] = useState<Record<string, AgentModeInfo[]>>({});
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
  const [eventError, setEventError] = useState<string | null>(null);

  const [questionSelections, setQuestionSelections] = useState<Record<string, string[][]>>({});
  const [questionStatus, setQuestionStatus] = useState<Record<string, "replied" | "rejected">>({});
  const [permissionStatus, setPermissionStatus] = useState<Record<string, "replied" | "rejected">>({});

  const [requestLog, setRequestLog] = useState<RequestLog[]>([]);
  const logIdRef = useRef(1);
  const [copiedLogId, setCopiedLogId] = useState<number | null>(null);

  const [debugTab, setDebugTab] = useState<DebugTab>("events");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<SandboxDaemonClient | null>(null);
  const sseAbortRef = useRef<AbortController | null>(null);

  const logRequest = useCallback((entry: RequestLog) => {
    setRequestLog((prev) => {
      const next = [entry, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  const createClient = useCallback(() => {
    const fetchWithLog: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const bodyText = typeof init?.body === "string" ? init.body : undefined;
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
        const response = await fetch(input, init);
        logRequest({ ...entry, status: response.status });
        logged = true;
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        if (!logged) {
          logRequest({ ...entry, status: 0, error: message });
        }
        throw error;
      }
    };

    const client = createSandboxDaemonClient({
      baseUrl: endpoint,
      token: token || undefined,
      fetch: fetchWithLog
    });
    clientRef.current = client;
    return client;
  }, [endpoint, token, logRequest]);

  const getClient = useCallback((): SandboxDaemonClient => {
    if (!clientRef.current) {
      throw new Error("Not connected");
    }
    return clientRef.current;
  }, []);

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof SandboxDaemonError) {
      return error.problem?.detail ?? error.problem?.title ?? error.message;
    }
    return error instanceof Error ? error.message : fallback;
  };

  const connectToDaemon = async (reportError: boolean) => {
    setConnecting(true);
    if (reportError) {
      setConnectError(null);
    }
    try {
      const client = createClient();
      await client.getHealth();
      setConnected(true);
      await refreshAgents();
      await fetchSessions();
      if (reportError) {
        setConnectError(null);
      }
    } catch (error) {
      if (reportError) {
        const message = getErrorMessage(error, "Unable to connect");
        setConnectError(message);
      }
      setConnected(false);
      clientRef.current = null;
    } finally {
      setConnecting(false);
    }
  };

  const connect = () => connectToDaemon(true);

  const disconnect = () => {
    setConnected(false);
    clientRef.current = null;
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
      const data = await getClient().listAgents();
      const agentList = data.agents ?? [];
      setAgents(agentList);
      // Auto-load modes for installed agents
      for (const agent of agentList) {
        if (agent.installed) {
          loadModes(agent.id);
        }
      }
    } catch (error) {
      setConnectError(getErrorMessage(error, "Unable to refresh agents"));
    }
  };

  const fetchSessions = async () => {
    try {
      const data = await getClient().listSessions();
      const sessionList = data.sessions ?? [];
      setSessions(sessionList);
    } catch {
      // Silently fail - sessions list is supplementary
    }
  };

  const installAgent = async (targetId: string, reinstall: boolean) => {
    try {
      await getClient().installAgent(targetId, { reinstall });
      await refreshAgents();
    } catch (error) {
      setConnectError(getErrorMessage(error, "Install failed"));
    }
  };

  const loadModes = async (targetId: string) => {
    try {
      const data = await getClient().getAgentModes(targetId);
      const modes = data.modes ?? [];
      setModesByAgent((prev) => ({ ...prev, [targetId]: modes }));
    } catch {
      // Silently fail - modes are optional
    }
  };

  const sendMessage = async () => {
    if (!message.trim()) return;
    setSessionError(null);
    try {
      await getClient().postMessage(sessionId, { message });
      setMessage("");

      // Auto-start polling if not already
      if (!polling) {
        if (streamMode === "poll") {
          startPolling();
        } else {
          startSse();
        }
      }
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to send message"));
    }
  };

  const createSession = async () => {
    setSessionError(null);
    try {
      const body: {
        agent: string;
        agentMode?: string;
        permissionMode?: string;
        model?: string;
        variant?: string;
      } = { agent: agentId };
      if (agentMode) body.agentMode = agentMode;
      if (permissionMode) body.permissionMode = permissionMode;
      if (model) body.model = model;
      if (variant) body.variant = variant;

      await getClient().createSession(sessionId, body);
      await fetchSessions();
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to create session"));
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
      const body: {
        agent: string;
        agentMode?: string;
        permissionMode?: string;
        model?: string;
        variant?: string;
      } = { agent: agentId };
      if (agentMode) body.agentMode = agentMode;
      if (permissionMode) body.permissionMode = permissionMode;
      if (model) body.model = model;
      if (variant) body.variant = variant;

      await getClient().createSession(id, body);
      await fetchSessions();
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to create session"));
    }
  };

  const appendEvents = useCallback((incoming: UniversalEvent[]) => {
    if (!incoming.length) return;
    setEvents((prev) => [...prev, ...incoming]);
    const lastSeq = incoming[incoming.length - 1]?.sequence ?? offsetRef.current;
    offsetRef.current = lastSeq;
    setOffset(lastSeq);
  }, []);

  const fetchEvents = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await getClient().getEvents(sessionId, {
        offset: offsetRef.current,
        limit: 200
      });
      const newEvents = response.events ?? [];
      appendEvents(newEvents);
      setEventError(null);
    } catch (error) {
      setEventError(getErrorMessage(error, "Unable to fetch events"));
    }
  }, [appendEvents, getClient, sessionId]);

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
    if (sseAbortRef.current) return;
    if (!sessionId) {
      setEventError("Select or create a session first.");
      return;
    }
    setEventError(null);
    setPolling(true);
    const controller = new AbortController();
    sseAbortRef.current = controller;
    const start = async () => {
      try {
        for await (const event of getClient().streamEvents(
          sessionId,
          { offset: offsetRef.current },
          controller.signal
        )) {
          appendEvents([event]);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setEventError(getErrorMessage(error, "SSE connection error. Falling back to polling."));
        stopSse();
        startPolling();
      } finally {
        if (sseAbortRef.current === controller) {
          sseAbortRef.current = null;
          setPolling(false);
        }
      }
    };
    void start();
  };

  const stopSse = () => {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
    }
    setPolling(false);
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

  const selectQuestionOption = (requestId: string, optionLabel: string) => {
    setQuestionSelections((prev) => ({
      ...prev,
      [requestId]: [[optionLabel]]
    }));
  };

  const answerQuestion = async (request: QuestionEventData) => {
    const answers = questionSelections[request.question_id] ?? [];
    try {
      await getClient().replyQuestion(sessionId, request.question_id, { answers });
      setQuestionStatus((prev) => ({ ...prev, [request.question_id]: "replied" }));
    } catch (error) {
      setEventError(getErrorMessage(error, "Unable to reply"));
    }
  };

  const rejectQuestion = async (requestId: string) => {
    try {
      await getClient().rejectQuestion(sessionId, requestId);
      setQuestionStatus((prev) => ({ ...prev, [requestId]: "rejected" }));
    } catch (error) {
      setEventError(getErrorMessage(error, "Unable to reject"));
    }
  };

  const replyPermission = async (requestId: string, reply: "once" | "always" | "reject") => {
    try {
      await getClient().replyPermission(sessionId, requestId, { reply });
      setPermissionStatus((prev) => ({ ...prev, [requestId]: "replied" }));
    } catch (error) {
      setEventError(getErrorMessage(error, "Unable to reply"));
    }
  };

  const questionRequests = useMemo(() => {
    const latestById = new Map<string, QuestionEventData>();
    for (const event of events) {
      if (event.type === "question.requested" || event.type === "question.resolved") {
        const data = event.data as QuestionEventData;
        latestById.set(data.question_id, data);
      }
    }
    return Array.from(latestById.values()).filter(
      (request) => request.status === "requested" && !questionStatus[request.question_id]
    );
  }, [events, questionStatus]);

  const permissionRequests = useMemo(() => {
    const latestById = new Map<string, PermissionEventData>();
    for (const event of events) {
      if (event.type === "permission.requested" || event.type === "permission.resolved") {
        const data = event.data as PermissionEventData;
        latestById.set(data.permission_id, data);
      }
    }
    return Array.from(latestById.values()).filter(
      (request) => request.status === "requested" && !permissionStatus[request.permission_id]
    );
  }, [events, permissionStatus]);

  const transcriptEntries = useMemo(() => {
    const entries: TimelineEntry[] = [];
    const itemMap = new Map<string, TimelineEntry>();

    const upsertItemEntry = (item: UniversalItem, time: string) => {
      let entry = itemMap.get(item.item_id);
      if (!entry) {
        entry = {
          id: item.item_id,
          kind: "item",
          time,
          item,
          deltaText: ""
        };
        itemMap.set(item.item_id, entry);
        entries.push(entry);
      } else {
        entry.item = item;
        entry.time = time;
      }
      return entry;
    };

    for (const event of events) {
      switch (event.type) {
        case "item.started": {
          const data = event.data as ItemEventData;
          upsertItemEntry(data.item, event.time);
          break;
        }
        case "item.delta": {
          const data = event.data as ItemDeltaEventData;
          const stub = buildStubItem(data.item_id, data.native_item_id);
          const entry = upsertItemEntry(stub, event.time);
          entry.deltaText = `${entry.deltaText ?? ""}${data.delta ?? ""}`;
          break;
        }
        case "item.completed": {
          const data = event.data as ItemEventData;
          const entry = upsertItemEntry(data.item, event.time);
          entry.deltaText = "";
          break;
        }
        case "error": {
          const data = event.data as { message: string; code?: string | null };
          entries.push({
            id: event.event_id,
            kind: "meta",
            time: event.time,
            meta: {
              title: data.code ? `Error - ${data.code}` : "Error",
              detail: data.message,
              severity: "error"
            }
          });
          break;
        }
        case "agent.unparsed": {
          const data = event.data as { error: string; location: string };
          entries.push({
            id: event.event_id,
            kind: "meta",
            time: event.time,
            meta: {
              title: "Agent parse failure",
              detail: `${data.location}: ${data.error}`,
              severity: "error"
            }
          });
          break;
        }
        case "session.started": {
          entries.push({
            id: event.event_id,
            kind: "meta",
            time: event.time,
            meta: {
              title: "Session started",
              severity: "info"
            }
          });
          break;
        }
        case "session.ended": {
          const data = event.data as { reason: string; terminated_by: string };
          entries.push({
            id: event.event_id,
            kind: "meta",
            time: event.time,
            meta: {
              title: "Session ended",
              detail: `${data.reason} - ${data.terminated_by}`,
              severity: "info"
            }
          });
          break;
        }
        default:
          break;
      }
    }

    return entries;
  }, [events]);

  useEffect(() => {
    return () => {
      stopPolling();
      stopSse();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const attempt = async () => {
      await connectToDaemon(false);
    };
    attempt().catch(() => {
      if (!active) return;
      setConnecting(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    refreshAgents();
  }, [connected]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptEntries]);

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
      if (streamMode === "poll") {
        stopPolling();
      } else {
        stopSse();
      }
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
                <code>sandbox-daemon server --cors-allow-origin http://localhost:5173</code>
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
            ) : transcriptEntries.length === 0 && !sessionError ? (
              <div className="empty-state">
                <Terminal className="empty-state-icon" />
                <div className="empty-state-title">Ready to Chat</div>
                <p className="empty-state-text">
                  Send a message to start a conversation with the agent.
                </p>
              </div>
            ) : (
              <div className="messages">
                {transcriptEntries.map((entry) => {
                  if (entry.kind === "meta") {
                    const messageClass = entry.meta?.severity === "error" ? "error" : "system";
                    return (
                      <div key={entry.id} className={`message ${messageClass}`}>
                        <div className="avatar">{getAvatarLabel(messageClass)}</div>
                        <div className="message-content">
                          <div className="message-meta">
                            <span>{entry.meta?.title ?? "Status"}</span>
                          </div>
                          {entry.meta?.detail && <div className="part-body">{entry.meta.detail}</div>}
                        </div>
                      </div>
                    );
                  }

                  const item = entry.item;
                  if (!item) return null;
                  const hasParts = (item.content ?? []).length > 0;
                  const isInProgress = item.status === "in_progress";
                  const isFailed = item.status === "failed";
                  const messageClass = getMessageClass(item);
                  const statusLabel = item.status !== "completed" ? item.status.replace("_", " ") : "";
                  const kindLabel = item.kind.replace("_", " ");

                  return (
                    <div key={entry.id} className={`message ${messageClass} ${isFailed ? "error" : ""}`}>
                      <div className="avatar">{getAvatarLabel(isFailed ? "error" : messageClass)}</div>
                      <div className="message-content">
                        {(item.kind !== "message" || item.status !== "completed") && (
                          <div className="message-meta">
                            <span>{kindLabel}</span>
                            {statusLabel && (
                              <span className={`pill ${item.status === "failed" ? "danger" : "accent"}`}>
                                {statusLabel}
                              </span>
                            )}
                          </div>
                        )}
                        {hasParts ? (
                          (item.content ?? []).map(renderContentPart)
                        ) : entry.deltaText ? (
                          <span>
                            {entry.deltaText}
                            {isInProgress && <span className="cursor" />}
                          </span>
                        ) : (
                          <span className="muted">No content yet.</span>
                        )}
                      </div>
                    </div>
                  );
                })}
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
                      const category = getEventCategory(type);
                      const eventClass = `${category} ${getEventClass(type)}`;
                      return (
                        <div key={event.event_id ?? event.sequence} className="event-item">
                          <div className="event-header">
                            <span className={`event-type ${eventClass}`}>{type}</span>
                            <span className="event-time">{formatTime(event.time)}</span>
                          </div>
                          <div className="event-id">
                            Event #{event.event_id || event.sequence} - seq {event.sequence} - {event.source}
                            {event.synthetic ? " (synthetic)" : ""}
                          </div>
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
                      const selections = questionSelections[request.question_id] ?? [];
                      const selected = selections[0] ?? [];
                      const answered = selected.length > 0;
                      return (
                        <div key={request.question_id} className="card">
                          <div className="card-header">
                            <span className="card-title">
                              <HelpCircle className="button-icon" style={{ marginRight: 6 }} />
                              Question
                            </span>
                            <span className="pill accent">Pending</span>
                          </div>
                          <div style={{ marginTop: 12 }}>
                            <div style={{ fontSize: 12, marginBottom: 8 }}>{request.prompt}</div>
                            <div className="option-list">
                              {request.options.map((option) => {
                                const isSelected = selected.includes(option);
                                return (
                                  <label key={option} className="option-item">
                                    <input
                                      type="radio"
                                      checked={isSelected}
                                      onChange={() => selectQuestionOption(request.question_id, option)}
                                    />
                                    <span>{option}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                          <div className="card-actions">
                            <button
                              className="button success small"
                              disabled={!answered}
                              onClick={() => answerQuestion(request)}
                            >
                              Reply
                            </button>
                            <button
                              className="button danger small"
                              onClick={() => rejectQuestion(request.question_id)}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {permissionRequests.map((request) => (
                      <div key={request.permission_id} className="card">
                        <div className="card-header">
                          <span className="card-title">
                            <Shield className="button-icon" style={{ marginRight: 6 }} />
                            Permission
                          </span>
                          <span className="pill accent">Pending</span>
                        </div>
                        <div className="card-meta" style={{ marginTop: 8 }}>
                          {request.action}
                        </div>
                        {request.metadata !== null && request.metadata !== undefined && (
                          <pre className="code-block">{formatJson(request.metadata)}</pre>
                        )}
                        <div className="card-actions">
                          <button
                            className="button success small"
                            onClick={() => replyPermission(request.permission_id, "once")}
                          >
                            Allow Once
                          </button>
                          <button
                            className="button secondary small"
                            onClick={() => replyPermission(request.permission_id, "always")}
                          >
                            Always
                          </button>
                          <button
                            className="button danger small"
                            onClick={() => replyPermission(request.permission_id, "reject")}
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

                {(agents.length
                  ? agents
                  : defaultAgents.map((id) => ({
                      id,
                      installed: false,
                      version: undefined,
                      path: undefined,
                      capabilities: emptyCapabilities
                    }))).map((agent) => (
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
                    <div className="card-meta" style={{ marginTop: 8 }}>
                      Capabilities: {formatCapabilities(agent.capabilities ?? emptyCapabilities)}
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
