import { BookOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SandboxAgent,
  SandboxAgentError,
  type AgentInfo,
  type SessionEvent,
  type Session,
  InMemorySessionPersistDriver,
  type SessionPersistDriver,
} from "sandbox-agent";

type ConfigSelectOption = { value: string; name: string; description?: string };
type ConfigOption = {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: ConfigSelectOption[] | Array<{ group: string; name: string; options: ConfigSelectOption[] }>;
};
type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };
import { IndexedDbSessionPersistDriver } from "@sandbox-agent/persist-indexeddb";
import ChatPanel from "./components/chat/ChatPanel";
import type { TimelineEntry } from "./components/chat/types";
import ConnectScreen from "./components/ConnectScreen";
import DebugPanel, { type DebugTab } from "./components/debug/DebugPanel";
import SessionSidebar from "./components/SessionSidebar";
import type { RequestLog } from "./types/requestLog";
import { buildCurl } from "./utils/http";

const flattenSelectOptions = (
  options: ConfigSelectOption[] | Array<{ group: string; name: string; options: ConfigSelectOption[] }>
): ConfigSelectOption[] => {
  if (options.length === 0) return [];
  if ("value" in options[0]) return options as ConfigSelectOption[];
  return (options as Array<{ options: ConfigSelectOption[] }>).flatMap((g) => g.options);
};

const logoUrl = `${import.meta.env.BASE_URL}logos/sandboxagent.svg`;
const defaultAgents = ["claude", "codex", "opencode", "amp", "pi", "cursor"];

type ErrorToast = {
  id: number;
  message: string;
};

type SessionListItem = {
  sessionId: string;
  agent: string;
  ended: boolean;
};

const ERROR_TOAST_MS = 6000;
const MAX_ERROR_TOASTS = 3;
const HTTP_ERROR_EVENT = "inspector-http-error";

const DEFAULT_ENDPOINT = "http://localhost:2468";

const getCurrentOriginEndpoint = () => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.location.origin;
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof SandboxAgentError) {
    return error.problem?.detail ?? error.problem?.title ?? error.message;
  }
  if (error instanceof Error) {
    // ACP RequestError may carry a data object with a hint or details field.
    const data = (error as { data?: Record<string, unknown> }).data;
    if (data && typeof data === "object") {
      const hint = typeof data.hint === "string" ? data.hint : null;
      const details = typeof data.details === "string" ? data.details : null;
      if (hint) return hint;
      if (details) return details;
    }
    return error.message;
  }
  return fallback;
};

const getHttpErrorMessage = (status: number, statusText: string, responseBody: string) => {
  const base = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
  const body = responseBody.trim();
  if (!body) {
    return base;
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) {
        return detail;
      }
      const title = (parsed as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) {
        return title;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  } catch {
    // Ignore parse failures and fall through to body text.
  }
  const clippedBody = body.length > 240 ? `${body.slice(0, 240)}...` : body;
  return `${base}: ${clippedBody}`;
};

const getSessionIdFromPath = (): string => {
  const basePath = import.meta.env.BASE_URL;
  const path = window.location.pathname;
  const relative = path.startsWith(basePath) ? path.slice(basePath.length) : path;
  const match = relative.match(/^sessions\/(.+)/);
  return match ? match[1] : "";
};

const updateSessionPath = (id: string) => {
  const basePath = import.meta.env.BASE_URL;
  const params = window.location.search;
  const newPath = id ? `${basePath}sessions/${id}${params}` : `${basePath}${params}`;
  if (window.location.pathname + window.location.search !== newPath) {
    window.history.replaceState(null, "", newPath);
  }
};

const getInitialConnection = () => {
  if (typeof window === "undefined") {
    return { endpoint: "http://127.0.0.1:2468", token: "", headers: {} as Record<string, string>, hasUrlParam: false };
  }
  const params = new URLSearchParams(window.location.search);
  const urlParam = params.get("url")?.trim();
  const tokenParam = params.get("token") ?? "";
  const headersParam = params.get("headers");
  let headers: Record<string, string> = {};
  if (headersParam) {
    try {
      headers = JSON.parse(headersParam);
    } catch {
      console.warn("Invalid headers query param, ignoring");
    }
  }
  const hasUrlParam = urlParam != null && urlParam.length > 0;
  return {
    endpoint: hasUrlParam ? urlParam : (getCurrentOriginEndpoint() ?? DEFAULT_ENDPOINT),
    token: tokenParam,
    headers,
    hasUrlParam
  };
};

const agentDisplayNames: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "Pi",
  cursor: "Cursor"
};

export default function App() {
  const issueTrackerUrl = "https://github.com/rivet-dev/sandbox-agent/issues";
  const docsUrl = "https://sandboxagent.dev/docs";
  const discordUrl = "https://rivet.dev/discord";
  const initialConnectionRef = useRef(getInitialConnection());
  const [endpoint, setEndpoint] = useState(initialConnectionRef.current.endpoint);
  const [token, setToken] = useState(initialConnectionRef.current.token);
  const [extraHeaders] = useState(initialConnectionRef.current.headers);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [agentId, setAgentId] = useState("claude");
  const [sessionId, setSessionId] = useState(getSessionIdFromPath());
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [sending, setSending] = useState(false);

  const [requestLog, setRequestLog] = useState<RequestLog[]>([]);
  const logIdRef = useRef(1);
  const [copiedLogId, setCopiedLogId] = useState<number | null>(null);
  const [errorToasts, setErrorToasts] = useState<ErrorToast[]>([]);
  const toastIdRef = useRef(1);
  const toastTimeoutsRef = useRef<Map<number, number>>(new Map());

  const [debugTab, setDebugTab] = useState<DebugTab>("events");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<SandboxAgent | null>(null);
  const activeSessionRef = useRef<Session | null>(null);
  const eventUnsubRef = useRef<(() => void) | null>(null);

  const logRequest = useCallback((entry: RequestLog) => {
    setRequestLog((prev) => {
      const next = [entry, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  const createClient = useCallback(async (overrideEndpoint?: string) => {
    const targetEndpoint = overrideEndpoint ?? endpoint;
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

      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers as HeadersInit);
        h.forEach((v, k) => { headers[k] = v; });
      }

      const entry: RequestLog = {
        id: logId,
        method,
        url,
        headers,
        body: bodyText,
        time: new Date().toLocaleTimeString(),
        curl
      };
      let logged = false;

      const fetchInit = {
        ...init,
        targetAddressSpace: "loopback"
      };

      try {
        const response = await fetch(input, fetchInit);
        const acceptsStream = headers["accept"]?.includes("text/event-stream");
        if (acceptsStream) {
          const ct = response.headers.get("content-type") ?? "";
          if (!ct.includes("text/event-stream")) {
            throw new Error(
              `Expected text/event-stream from ${method} ${url} but got ${ct || "(no content-type)"} (HTTP ${response.status})`
            );
          }
          logRequest({ ...entry, status: response.status, responseBody: "(SSE stream)" });
          logged = true;
          return response;
        }
        const clone = response.clone();
        const responseBody = await clone.text().catch(() => "");
        logRequest({ ...entry, status: response.status, responseBody });
        if (!response.ok && response.status >= 500) {
          const messageText = getHttpErrorMessage(response.status, response.statusText, responseBody);
          window.dispatchEvent(new CustomEvent<string>(HTTP_ERROR_EVENT, { detail: messageText }));
        }
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

    let persist: SessionPersistDriver;
    try {
      persist = new IndexedDbSessionPersistDriver({
        databaseName: "sandbox-agent-inspector",
      });
    } catch {
      persist = new InMemorySessionPersistDriver({
        maxSessions: 512,
        maxEventsPerSession: 5_000,
      });
    }

    const client = await SandboxAgent.connect({
      baseUrl: targetEndpoint,
      token: token || undefined,
      fetch: fetchWithLog,
      headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      persist,
    });
    clientRef.current = client;
    return client;
  }, [endpoint, token, extraHeaders, logRequest]);

  const getClient = useCallback((): SandboxAgent => {
    if (!clientRef.current) {
      throw new Error("Not connected");
    }
    return clientRef.current;
  }, []);

  const dismissErrorToast = useCallback((toastId: number) => {
    const timeoutId = toastTimeoutsRef.current.get(toastId);
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      toastTimeoutsRef.current.delete(toastId);
    }
    setErrorToasts((prev) => prev.filter((toast) => toast.id !== toastId));
  }, []);

  const pushErrorToast = useCallback((error: unknown, fallback: string) => {
    const messageText = getErrorMessage(error, fallback).trim() || fallback;
    const toastId = toastIdRef.current++;
    setErrorToasts((prev) => {
      if (prev.some((toast) => toast.message === messageText)) {
        return prev;
      }
      return [...prev, { id: toastId, message: messageText }].slice(-MAX_ERROR_TOASTS);
    });
    const timeoutId = window.setTimeout(() => {
      dismissErrorToast(toastId);
    }, ERROR_TOAST_MS);
    toastTimeoutsRef.current.set(toastId, timeoutId);
  }, [dismissErrorToast]);

  // Subscribe to events for the current active session
  const subscribeToSession = useCallback((session: Session) => {
    // Unsubscribe from previous
    if (eventUnsubRef.current) {
      eventUnsubRef.current();
      eventUnsubRef.current = null;
    }

    activeSessionRef.current = session;

    // Hydrate existing events from persistence
    const hydrateEvents = async () => {
      const allEvents: SessionEvent[] = [];
      let cursor: string | undefined;
      while (true) {
        const page = await getClient().getEvents({
          sessionId: session.id,
          cursor,
          limit: 250,
        });
        allEvents.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      setEvents(allEvents);
    };
    hydrateEvents().catch(() => {});

    // Subscribe to new events
    const unsub = session.onEvent((event) => {
      setEvents((prev) => [...prev, event]);
    });
    eventUnsubRef.current = unsub;
  }, [getClient]);

  const connectToDaemon = async (reportError: boolean, overrideEndpoint?: string) => {
    setConnecting(true);
    if (reportError) {
      setConnectError(null);
    }
    try {
      const client = await createClient(overrideEndpoint);
      await client.getHealth();
      if (overrideEndpoint) {
        setEndpoint(overrideEndpoint);
      }
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
      throw error;
    } finally {
      setConnecting(false);
    }
  };

  const connect = () => connectToDaemon(true);

  const disconnect = () => {
    if (eventUnsubRef.current) {
      eventUnsubRef.current();
      eventUnsubRef.current = null;
    }
    activeSessionRef.current = null;
    if (clientRef.current) {
      void clientRef.current.dispose();
    }
    setConnected(false);
    clientRef.current = null;
    setSessionError(null);
    setEvents([]);
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
      setAgents(data.agents ?? []);
    } catch (error) {
      setAgentsError(getErrorMessage(error, "Unable to refresh agents"));
    } finally {
      setAgentsLoading(false);
    }
  };

  const loadAgentConfig = useCallback(async (targetAgentId: string) => {
    try {
      const info = await getClient().getAgent(targetAgentId, { config: true });
      setAgents((prev) =>
        prev.map((a) => (a.id === targetAgentId ? { ...a, configOptions: info.configOptions, configError: info.configError } : a))
      );
    } catch {
      // Config loading is best-effort; the menu still works without it.
    }
  }, [getClient]);

  const fetchSessions = async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      // TODO: This eagerly paginates all sessions so we can reverse-sort to
      // show newest first. Replace with a server-side descending sort or a
      // dedicated "recent sessions" query once the API supports it.
      const all: SessionListItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await getClient().listSessions({ cursor, limit: 200 });
        for (const s of page.items) {
          all.push({
            sessionId: s.id,
            agent: s.agent,
            ended: s.destroyedAt != null,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      all.reverse();
      setSessions(all);
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

  const sendMessage = async () => {
    const prompt = message.trim();
    if (!prompt || !sessionId || sending) return;
    setSessionError(null);
    setMessage("");
    setSending(true);

    try {
      let session = activeSessionRef.current;
      if (!session || session.id !== sessionId) {
        session = await getClient().resumeSession(sessionId);
        subscribeToSession(session);
      }
      await session.prompt([{ type: "text", text: prompt }]);
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to send message"));
    } finally {
      setSending(false);
    }
  };

  const selectSession = async (session: SessionListItem) => {
    setSessionId(session.sessionId);
    updateSessionPath(session.sessionId);
    setAgentId(session.agent);
    setEvents([]);
    setSessionError(null);

    try {
      const sdkSession = await getClient().resumeSession(session.sessionId);
      subscribeToSession(sdkSession);
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to load session"));
    }
  };

  const createNewSession = async (nextAgentId: string, config: { agentMode: string; model: string }) => {
    setAgentId(nextAgentId);
    setSessionError(null);
    setEvents([]);

    try {
      const session = await getClient().createSession({
        agent: nextAgentId,
        sessionInit: {
          cwd: "/",
          mcpServers: [],
        },
      });

      setSessionId(session.id);
      updateSessionPath(session.id);
      subscribeToSession(session);

      // Apply mode if selected
      if (config.agentMode) {
        try {
          await session.send("session/set_mode", { modeId: config.agentMode });
        } catch {
          // Mode application is best-effort
        }
      }

      // Apply model if selected
      if (config.model) {
        try {
          await session.send("unstable/set_session_model", { modelId: config.model });
        } catch {
          // Model application is best-effort
        }
      }

      await fetchSessions();
    } catch (error) {
      const messageText = getErrorMessage(error, "Unable to create session");
      setSessionError(messageText);
      pushErrorToast(error, messageText);
    }
  };

  const endSession = async () => {
    if (!sessionId) return;
    try {
      await getClient().destroySession(sessionId);
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      activeSessionRef.current = null;
      await fetchSessions();
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to end session"));
    }
  };

  const handleCopy = (entry: RequestLog) => {
    const text = entry.curl;
    const onSuccess = () => {
      setCopiedLogId(entry.id);
      window.setTimeout(() => setCopiedLogId(null), 1500);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => {
        fallbackCopy(text, onSuccess);
      });
    } else {
      fallbackCopy(text, onSuccess);
    }
  };

  const fallbackCopy = (text: string, onSuccess?: () => void) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      onSuccess?.();
    } catch (err) {
      console.error("Failed to copy:", err);
    }
    document.body.removeChild(textarea);
  };

  // Build transcript entries from raw SessionEvents
  const transcriptEntries = useMemo(() => {
    const entries: TimelineEntry[] = [];

    // Accumulators for streaming chunks
    let assistantAccumId: string | null = null;
    let assistantAccumText = "";
    let thoughtAccumId: string | null = null;
    let thoughtAccumText = "";

    const flushAssistant = (time: string) => {
      if (assistantAccumId) {
        const existing = entries.find((e) => e.id === assistantAccumId);
        if (existing) {
          existing.text = assistantAccumText;
          existing.time = time;
        }
      }
      assistantAccumId = null;
      assistantAccumText = "";
    };

    const flushThought = (time: string) => {
      if (thoughtAccumId) {
        const existing = entries.find((e) => e.id === thoughtAccumId);
        if (existing && existing.reasoning) {
          existing.reasoning.text = thoughtAccumText;
          existing.time = time;
        }
      }
      thoughtAccumId = null;
      thoughtAccumText = "";
    };

    // Track tool calls by ID for updates
    const toolEntryMap = new Map<string, TimelineEntry>();

    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const method = typeof payload.method === "string" ? payload.method : null;
      const time = new Date(event.createdAt).toISOString();

      if (event.sender === "client" && method === "session/prompt") {
        // User message
        flushAssistant(time);
        flushThought(time);
        const params = payload.params as Record<string, unknown> | undefined;
        const promptArray = params?.prompt as Array<{ type: string; text?: string }> | undefined;
        const text = promptArray?.[0]?.text ?? "";
        entries.push({
          id: event.id,
          kind: "message",
          time,
          role: "user",
          text,
        });
        continue;
      }

      if (event.sender === "agent" && method === "session/update") {
        const params = payload.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (!update || typeof update.sessionUpdate !== "string") continue;

        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && content.text) {
              if (!assistantAccumId) {
                assistantAccumId = `assistant-${event.id}`;
                assistantAccumText = "";
                entries.push({
                  id: assistantAccumId,
                  kind: "message",
                  time,
                  role: "assistant",
                  text: "",
                });
              }
              assistantAccumText += content.text;
              const entry = entries.find((e) => e.id === assistantAccumId);
              if (entry) {
                entry.text = assistantAccumText;
                entry.time = time;
              }
            }
            break;
          }
          case "agent_thought_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && content.text) {
              if (!thoughtAccumId) {
                thoughtAccumId = `thought-${event.id}`;
                thoughtAccumText = "";
                entries.push({
                  id: thoughtAccumId,
                  kind: "reasoning",
                  time,
                  reasoning: { text: "", visibility: "public" },
                });
              }
              thoughtAccumText += content.text;
              const entry = entries.find((e) => e.id === thoughtAccumId);
              if (entry && entry.reasoning) {
                entry.reasoning.text = thoughtAccumText;
                entry.time = time;
              }
            }
            break;
          }
          case "user_message_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined;
            const text = content?.type === "text" ? (content.text ?? "") : JSON.stringify(content);
            entries.push({
              id: event.id,
              kind: "message",
              time,
              role: "user",
              text,
            });
            break;
          }
          case "tool_call": {
            flushAssistant(time);
            flushThought(time);
            const toolCallId = (update.toolCallId as string) ?? event.id;
            const existing = toolEntryMap.get(toolCallId);
            if (existing) {
              // Update existing entry instead of creating a duplicate
              if (update.status) existing.toolStatus = update.status as string;
              if (update.rawInput != null) existing.toolInput = JSON.stringify(update.rawInput, null, 2);
              if (update.rawOutput != null) existing.toolOutput = JSON.stringify(update.rawOutput, null, 2);
              if (update.title) existing.toolName = update.title as string;
              existing.time = time;
            } else {
              const entry: TimelineEntry = {
                id: `tool-${toolCallId}`,
                kind: "tool",
                time,
                toolName: (update.title as string) ?? "tool",
                toolInput: update.rawInput != null ? JSON.stringify(update.rawInput, null, 2) : undefined,
                toolOutput: update.rawOutput != null ? JSON.stringify(update.rawOutput, null, 2) : undefined,
                toolStatus: (update.status as string) ?? "in_progress",
              };
              toolEntryMap.set(toolCallId, entry);
              entries.push(entry);
            }
            break;
          }
          case "tool_call_update": {
            const toolCallId = update.toolCallId as string;
            const existing = toolEntryMap.get(toolCallId);
            if (existing) {
              if (update.status) existing.toolStatus = update.status as string;
              if (update.rawOutput != null) existing.toolOutput = JSON.stringify(update.rawOutput, null, 2);
              if (update.title) existing.toolName = (existing.toolName ?? "") + (update.title as string);
              existing.time = time;
            }
            break;
          }
          case "plan": {
            const planEntries = (update.entries as Array<{ content: string; status: string }>) ?? [];
            const detail = planEntries.map((e) => `[${e.status}] ${e.content}`).join("\n");
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: "Plan", detail, severity: "info" },
            });
            break;
          }
          case "session_info_update": {
            const title = update.title as string | undefined;
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: "Session info update", detail: title ? `Title: ${title}` : undefined, severity: "info" },
            });
            break;
          }
          case "usage_update": {
            const size = update.size as number | undefined;
            const used = update.used as number | undefined;
            const cost = update.cost as { total?: number } | undefined;
            const parts = [`${used ?? 0}/${size ?? 0} tokens`];
            if (cost?.total != null) {
              parts.push(`cost: $${cost.total.toFixed(4)}`);
            }
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: "Usage update", detail: parts.join(" | "), severity: "info" },
            });
            break;
          }
          case "current_mode_update": {
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: "Mode changed", detail: update.currentModeId as string, severity: "info" },
            });
            break;
          }
          case "config_option_update": {
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: "Config option update", severity: "info" },
            });
            break;
          }
          case "available_commands_update": {
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: "Available commands update", severity: "info" },
            });
            break;
          }
          default: {
            entries.push({
              id: event.id,
              kind: "meta",
              time,
              meta: { title: `session/update: ${update.sessionUpdate}`, severity: "info" },
            });
            break;
          }
        }
        continue;
      }

      if (event.sender === "agent" && method === "_sandboxagent/agent/unparsed") {
        const params = payload.params as { error?: string; location?: string } | undefined;
        entries.push({
          id: event.id,
          kind: "meta",
          time,
          meta: {
            title: "Agent parse failure",
            detail: `${params?.location ?? "unknown"}: ${params?.error ?? "unknown error"}`,
            severity: "error",
          },
        });
        continue;
      }

      // For any other ACP envelope, show as generic meta
      if (method) {
        entries.push({
          id: event.id,
          kind: "meta",
          time,
          meta: { title: method, detail: event.sender, severity: "info" },
        });
      }
    }

    return entries;
  }, [events]);

  useEffect(() => {
    return () => {
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      pushErrorToast(event.error ?? event.message, "Unexpected error");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      pushErrorToast(event.reason, "Unhandled promise rejection");
    };
    const handleHttpError = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) {
        pushErrorToast(new Error(detail), detail);
      }
    };
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener(HTTP_ERROR_EVENT, handleHttpError);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener(HTTP_ERROR_EVENT, handleHttpError);
    };
  }, [pushErrorToast]);

  useEffect(() => {
    return () => {
      for (const timeoutId of toastTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      toastTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const attempt = async () => {
      const { hasUrlParam } = initialConnectionRef.current;

      if (hasUrlParam) {
        try {
          await connectToDaemon(false);
        } catch {
          // Keep the URL param endpoint in the form even if connection failed
        }
        return;
      }

      const originEndpoint = getCurrentOriginEndpoint();
      if (originEndpoint) {
        try {
          await connectToDaemon(false, originEndpoint);
          return;
        } catch {
          // Origin failed, continue to fallback
        }
      }

      if (!active) return;
      try {
        await connectToDaemon(false, DEFAULT_ENDPOINT);
      } catch {
        setEndpoint(DEFAULT_ENDPOINT);
      }
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

  // Auto-load session when sessionId changes
  useEffect(() => {
    if (!connected || !sessionId) return;
    const hasSession = sessions.some((s) => s.sessionId === sessionId);
    if (!hasSession) return;
    if (activeSessionRef.current?.id === sessionId) return;

    getClient().resumeSession(sessionId).then((session) => {
      subscribeToSession(session);
    }).catch(() => {});
  }, [connected, sessionId, sessions, getClient, subscribeToSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptEntries]);

  const currentAgent = agents.find((agent) => agent.id === agentId);
  const agentLabel = agentDisplayNames[agentId] ?? agentId;
  const sessionEnded = sessions.find((s) => s.sessionId === sessionId)?.ended ?? false;

  // Extract modes and models from configOptions
  const modesByAgent = useMemo(() => {
    const result: Record<string, AgentModeInfo[]> = {};
    for (const agent of agents) {
      const options = (agent.configOptions ?? []) as ConfigOption[];
      for (const opt of options) {
        if (opt.category === "mode" && opt.type === "select" && opt.options) {
          result[agent.id] = flattenSelectOptions(opt.options).map((o) => ({
            id: o.value,
            name: o.name,
            description: o.description ?? "",
          }));
        }
      }
    }
    return result;
  }, [agents]);

  const modelsByAgent = useMemo(() => {
    const result: Record<string, AgentModelInfo[]> = {};
    for (const agent of agents) {
      const options = (agent.configOptions ?? []) as ConfigOption[];
      for (const opt of options) {
        if (opt.category === "model" && opt.type === "select" && opt.options) {
          result[agent.id] = flattenSelectOptions(opt.options).map((o) => ({
            id: o.value,
            name: o.name,
          }));
        }
      }
    }
    return result;
  }, [agents]);

  const defaultModelByAgent = useMemo(() => {
    const result: Record<string, string> = {};
    for (const agent of agents) {
      const options = (agent.configOptions ?? []) as ConfigOption[];
      for (const opt of options) {
        if (opt.category === "model" && opt.type === "select" && opt.currentValue) {
          result[agent.id] = opt.currentValue;
        }
      }
    }
    return result;
  }, [agents]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const toastStack = (
    <div className="toast-stack" aria-live="assertive" aria-atomic="false">
      {errorToasts.map((toast) => (
        <div key={toast.id} className="toast error" role="status">
          <div className="toast-content">
            <div className="toast-title">Request failed</div>
            <div className="toast-message">{toast.message}</div>
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss error"
            onClick={() => dismissErrorToast(toast.id)}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );

  if (!connected) {
    return (
      <>
        <ConnectScreen
          endpoint={endpoint}
          token={token}
          connectError={connectError}
          connecting={connecting}
          onEndpointChange={setEndpoint}
          onTokenChange={setToken}
          onConnect={connect}
          reportUrl={issueTrackerUrl}
          docsUrl={docsUrl}
          discordUrl={discordUrl}
        />
        {toastStack}
      </>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <img src={logoUrl} alt="Sandbox Agent" className="logo-text" style={{ height: '20px', width: 'auto' }} />
        </div>
        <div className="header-right">
          <a className="header-link" href={docsUrl} target="_blank" rel="noreferrer">
            <BookOpen size={12} />
            Docs
          </a>
          <a className="header-link" href={discordUrl} target="_blank" rel="noreferrer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
            Discord
          </a>
          <a className="header-link" href={issueTrackerUrl} target="_blank" rel="noreferrer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
            Issues
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
          onSelectAgent={loadAgentConfig}
          agents={agents.length ? agents : defaultAgents.map((id) => ({
            id,
            installed: false,
            credentialsAvailable: true,
            capabilities: {} as AgentInfo["capabilities"],
          }))}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          modesByAgent={modesByAgent}
          modelsByAgent={modelsByAgent}
          defaultModelByAgent={defaultModelByAgent}
        />

        <ChatPanel
          sessionId={sessionId}
          transcriptEntries={transcriptEntries}
          sessionError={sessionError}
          message={message}
          onMessageChange={setMessage}
          onSendMessage={sendMessage}
          onKeyDown={handleKeyDown}
          onCreateSession={createNewSession}
          onSelectAgent={loadAgentConfig}
          agents={agents.length ? agents : defaultAgents.map((id) => ({
            id,
            installed: false,
            credentialsAvailable: true,
            capabilities: {} as AgentInfo["capabilities"],
          }))}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          messagesEndRef={messagesEndRef}
          agentLabel={agentLabel}
          currentAgentVersion={currentAgent?.version ?? null}
          sessionEnded={sessionEnded}
          onEndSession={endSession}
          modesByAgent={modesByAgent}
          modelsByAgent={modelsByAgent}
          defaultModelByAgent={defaultModelByAgent}
        />

        <DebugPanel
          debugTab={debugTab}
          onDebugTabChange={setDebugTab}
          events={events}
          onResetEvents={() => setEvents([])}
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
          getClient={getClient}
        />
      </main>
      {toastStack}
    </div>
  );
}
