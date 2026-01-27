import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SandboxAgentError,
  SandboxAgent,
  type AgentInfo,
  type AgentModeInfo,
  type PermissionEventData,
  type QuestionEventData,
  type SessionInfo,
  type UniversalEvent,
  type UniversalItem
} from "sandbox-agent";
import ChatPanel from "./components/chat/ChatPanel";
import type { TimelineEntry } from "./components/chat/types";
import ConnectScreen from "./components/ConnectScreen";
import DebugPanel, { type DebugTab } from "./components/debug/DebugPanel";
import SessionSidebar from "./components/SessionSidebar";
import type { RequestLog } from "./types/requestLog";
import { buildCurl } from "./utils/http";

const defaultAgents = ["claude", "codex", "opencode", "amp", "mock"];

type ItemEventData = {
  item: UniversalItem;
};

type ItemDeltaEventData = {
  item_id: string;
  native_item_id?: string | null;
  delta: string;
};

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

const getDefaultEndpoint = () => {
  if (typeof window === "undefined") return "http://127.0.0.1:2468";
  const { origin, protocol } = window.location;
  if (!origin || origin === "null" || protocol === "file:") {
    return "http://127.0.0.1:2468";
  }
  return origin;
};

export default function App() {
  const issueTrackerUrl = "https://github.com/rivet-dev/sandbox-agent/issues/new";
  const [endpoint, setEndpoint] = useState(getDefaultEndpoint);
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [modesByAgent, setModesByAgent] = useState<Record<string, AgentModeInfo[]>>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [modesLoadingByAgent, setModesLoadingByAgent] = useState<Record<string, boolean>>({});
  const [modesErrorByAgent, setModesErrorByAgent] = useState<Record<string, string | null>>({});

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
  const [eventsLoading, setEventsLoading] = useState(false);

  const [polling, setPolling] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const [turnStreaming, setTurnStreaming] = useState(false);
  const [streamMode, setStreamMode] = useState<"poll" | "sse" | "turn">("sse");
  const [eventError, setEventError] = useState<string | null>(null);

  const [questionSelections, setQuestionSelections] = useState<Record<string, string[][]>>({});
  const [questionStatus, setQuestionStatus] = useState<Record<string, "replied" | "rejected">>({});
  const [permissionStatus, setPermissionStatus] = useState<Record<string, "replied" | "rejected">>({});

  const [requestLog, setRequestLog] = useState<RequestLog[]>([]);
  const logIdRef = useRef(1);
  const [copiedLogId, setCopiedLogId] = useState<number | null>(null);

  const [debugTab, setDebugTab] = useState<DebugTab>("events");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<SandboxAgent | null>(null);
  const sseAbortRef = useRef<AbortController | null>(null);
  const turnAbortRef = useRef<AbortController | null>(null);

  const logRequest = useCallback((entry: RequestLog) => {
    setRequestLog((prev) => {
      const next = [entry, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  const createClient = useCallback(async () => {
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
        const messageText = error instanceof Error ? error.message : "Request failed";
        if (!logged) {
          logRequest({ ...entry, status: 0, error: messageText });
        }
        throw error;
      }
    };

    const client = await SandboxAgent.connect({
      baseUrl: endpoint,
      token: token || undefined,
      fetch: fetchWithLog
    });
    clientRef.current = client;
    return client;
  }, [endpoint, token, logRequest]);

  const getClient = useCallback((): SandboxAgent => {
    if (!clientRef.current) {
      throw new Error("Not connected");
    }
    return clientRef.current;
  }, []);

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof SandboxAgentError) {
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
      const client = await createClient();
      await client.getHealth();
      setConnected(true);
      await refreshAgents();
      await fetchSessions();
      if (reportError) {
        setConnectError(null);
      }
    } catch (error) {
      if (reportError) {
        const messageText = getErrorMessage(error, "Unable to connect");
        setConnectError(messageText);
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
    stopTurnStream();
    setAgents([]);
    setSessions([]);
    setAgentsLoading(false);
    setSessionsLoading(false);
    setAgentsError(null);
    setSessionsError(null);
  };

  const refreshAgents = async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const data = await getClient().listAgents();
      const agentList = data.agents ?? [];
      setAgents(agentList);
      for (const agent of agentList) {
        if (agent.installed) {
          loadModes(agent.id);
        }
      }
    } catch (error) {
      setAgentsError(getErrorMessage(error, "Unable to refresh agents"));
    } finally {
      setAgentsLoading(false);
    }
  };

  const fetchSessions = async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const data = await getClient().listSessions();
      const sessionList = data.sessions ?? [];
      setSessions(sessionList);
    } catch {
      setSessionsError("Unable to load sessions.");
    } finally {
      setSessionsLoading(false);
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
    setModesLoadingByAgent((prev) => ({ ...prev, [targetId]: true }));
    setModesErrorByAgent((prev) => ({ ...prev, [targetId]: null }));
    try {
      const data = await getClient().getAgentModes(targetId);
      const modes = data.modes ?? [];
      setModesByAgent((prev) => ({ ...prev, [targetId]: modes }));
    } catch {
      setModesErrorByAgent((prev) => ({ ...prev, [targetId]: "Unable to load modes." }));
    } finally {
      setModesLoadingByAgent((prev) => ({ ...prev, [targetId]: false }));
    }
  };

  const sendMessage = async () => {
    const prompt = message.trim();
    if (!prompt || !sessionId || turnStreaming) return;
    setSessionError(null);
    setMessage("");

    if (streamMode === "turn") {
      await startTurnStream(prompt);
      return;
    }

    try {
      await getClient().postMessage(sessionId, { message: prompt });
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

  const selectSession = (session: SessionInfo) => {
    stopTurnStream();
    setSessionId(session.sessionId);
    setAgentId(session.agent);
    setAgentMode(session.agentMode);
    setPermissionMode(session.permissionMode);
    setModel(session.model ?? "");
    setVariant(session.variant ?? "");
    setEvents([]);
    setOffset(0);
    offsetRef.current = 0;
    setSessionError(null);
  };

  const createNewSession = async (nextAgentId?: string) => {
    stopTurnStream();
    const selectedAgent = nextAgentId ?? agentId;
    if (nextAgentId) {
      setAgentId(nextAgentId);
    }
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

    try {
      const body: {
        agent: string;
        agentMode?: string;
        permissionMode?: string;
        model?: string;
        variant?: string;
      } = { agent: selectedAgent };
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
    setEventsLoading(true);
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
    } finally {
      setEventsLoading(false);
    }
  }, [appendEvents, getClient, sessionId]);

  const startPolling = () => {
    stopSse();
    if (pollTimerRef.current) return;
    setPolling(true);
    fetchEvents();
    pollTimerRef.current = window.setInterval(fetchEvents, 500);
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

  const startTurnStream = async (prompt: string) => {
    stopPolling();
    stopSse();
    if (turnAbortRef.current) return;
    if (!sessionId) {
      setEventError("Select or create a session first.");
      return;
    }
    setEventError(null);
    setTurnStreaming(true);
    const controller = new AbortController();
    turnAbortRef.current = controller;
    try {
      for await (const event of getClient().streamTurn(
        sessionId,
        { message: prompt },
        undefined,
        controller.signal
      )) {
        appendEvents([event]);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setEventError(getErrorMessage(error, "Turn stream error."));
    } finally {
      if (turnAbortRef.current === controller) {
        turnAbortRef.current = null;
        setTurnStreaming(false);
      }
    }
  };

  const stopTurnStream = () => {
    if (turnAbortRef.current) {
      turnAbortRef.current.abort();
      turnAbortRef.current = null;
    }
    setTurnStreaming(false);
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
      stopTurnStream();
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
    if (!connected || !sessionId || polling) return;
    if (streamMode === "turn") return;
    const hasSession = sessions.some((session) => session.sessionId === sessionId);
    if (!hasSession) return;
    if (streamMode === "poll") {
      startPolling();
    } else {
      startSse();
    }
  }, [connected, sessionId, polling, streamMode, sessions]);

  useEffect(() => {
    if (streamMode === "turn") {
      stopPolling();
      stopSse();
    } else if (turnStreaming) {
      stopTurnStream();
    }
  }, [streamMode, turnStreaming]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptEntries]);

  useEffect(() => {
    if (connected && agentId && !modesByAgent[agentId]) {
      loadModes(agentId);
    }
  }, [connected, agentId]);

  useEffect(() => {
    const modes = modesByAgent[agentId];
    if (modes && modes.length > 0 && !agentMode) {
      setAgentMode(modes[0].id);
    }
  }, [modesByAgent, agentId]);

  const availableAgents = agents.length ? agents.map((agent) => agent.id) : defaultAgents;
  const currentAgent = agents.find((agent) => agent.id === agentId);
  const activeModes = modesByAgent[agentId] ?? [];
  const modesLoading = modesLoadingByAgent[agentId] ?? false;
  const modesError = modesErrorByAgent[agentId] ?? null;
  const agentDisplayNames: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    amp: "Amp",
    mock: "Mock"
  };
  const agentLabel = agentDisplayNames[agentId] ?? agentId;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const toggleStream = () => {
    if (streamMode === "turn") {
      return;
    }
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
      <ConnectScreen
        endpoint={endpoint}
        token={token}
        connectError={connectError}
        connecting={connecting}
        onEndpointChange={setEndpoint}
        onTokenChange={setToken}
        onConnect={connect}
        reportUrl={issueTrackerUrl}
      />
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
          <a className="button ghost small" href={issueTrackerUrl} target="_blank" rel="noreferrer">
            Report Bug
          </a>
          <span className="header-endpoint">{endpoint}</span>
          <button className="button secondary small" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <main className="main-layout">
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={sessionId}
          onSelectSession={selectSession}
          onRefresh={fetchSessions}
          onCreateSession={createNewSession}
          availableAgents={availableAgents}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
        />

        <ChatPanel
          sessionId={sessionId}
          polling={polling}
          turnStreaming={turnStreaming}
          transcriptEntries={transcriptEntries}
          sessionError={sessionError}
          message={message}
          onMessageChange={setMessage}
          onSendMessage={sendMessage}
          onKeyDown={handleKeyDown}
          onCreateSession={createNewSession}
          messagesEndRef={messagesEndRef}
          agentLabel={agentLabel}
          agentMode={agentMode}
          permissionMode={permissionMode}
          model={model}
          variant={variant}
          streamMode={streamMode}
          activeModes={activeModes}
          currentAgentVersion={currentAgent?.version ?? null}
          modesLoading={modesLoading}
          modesError={modesError}
          onAgentModeChange={setAgentMode}
          onPermissionModeChange={setPermissionMode}
          onModelChange={setModel}
          onVariantChange={setVariant}
          onStreamModeChange={setStreamMode}
          onToggleStream={toggleStream}
          hasSession={Boolean(sessionId)}
          eventError={eventError}
          questionRequests={questionRequests}
          permissionRequests={permissionRequests}
          questionSelections={questionSelections}
          onSelectQuestionOption={selectQuestionOption}
          onAnswerQuestion={answerQuestion}
          onRejectQuestion={rejectQuestion}
          onReplyPermission={replyPermission}
        />

        <DebugPanel
          debugTab={debugTab}
          onDebugTabChange={setDebugTab}
          events={events}
          offset={offset}
          onFetchEvents={fetchEvents}
          onResetEvents={resetEvents}
          eventsLoading={eventsLoading}
          eventsError={eventError}
          requestLog={requestLog}
          copiedLogId={copiedLogId}
          onClearRequestLog={() => setRequestLog([])}
          onCopyRequestLog={handleCopy}
          agents={agents}
          defaultAgents={defaultAgents}
          modesByAgent={modesByAgent}
          onRefreshAgents={refreshAgents}
          onInstallAgent={installAgent}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
        />
      </main>
    </div>
  );
}
