import type {
  WorkbenchAgentKind as AgentKind,
  WorkbenchAgentTab as AgentTab,
  WorkbenchDiffLineKind as DiffLineKind,
  WorkbenchFileChange as FileChange,
  WorkbenchFileTreeNode as FileTreeNode,
  WorkbenchTask as Task,
  WorkbenchHistoryEvent as HistoryEvent,
  WorkbenchLineAttachment as LineAttachment,
  WorkbenchModelGroup as ModelGroup,
  WorkbenchModelId as ModelId,
  WorkbenchParsedDiffLine as ParsedDiffLine,
  WorkbenchProjectSection as ProjectSection,
  WorkbenchTranscriptEvent as TranscriptEvent,
} from "@sandbox-agent/foundry-shared";
import { extractEventText } from "../../features/sessions/model";

export type { ProjectSection };

export const MODEL_GROUPS: ModelGroup[] = [
  {
    provider: "Claude",
    models: [
      { id: "claude-sonnet-4", label: "Sonnet 4" },
      { id: "claude-opus-4", label: "Opus 4" },
    ],
  },
  {
    provider: "OpenAI",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "o3", label: "o3" },
    ],
  },
];

export function formatRelativeAge(updatedAtMs: number, nowMs = Date.now()): string {
  const deltaSeconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatMessageTimestamp(createdAtMs: number, nowMs = Date.now()): string {
  const createdAt = new Date(createdAtMs);
  const now = new Date(nowMs);
  const sameDay = createdAt.toDateString() === now.toDateString();

  const timeLabel = createdAt.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  if (sameDay) {
    return timeLabel;
  }

  const deltaDays = Math.floor((nowMs - createdAtMs) / (24 * 60 * 60 * 1000));
  if (deltaDays < 7) {
    const weekdayLabel = createdAt.toLocaleDateString([], { weekday: "short" });
    return `${weekdayLabel} ${timeLabel}`;
  }

  return createdAt.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

export function formatThinkingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatMessageDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function modelLabel(id: ModelId): string {
  const group = MODEL_GROUPS.find((candidate) => candidate.models.some((model) => model.id === id));
  const model = group?.models.find((candidate) => candidate.id === id);
  return model && group ? `${group.provider} ${model.label}` : id;
}

export function providerAgent(provider: string): AgentKind {
  if (provider === "Claude") return "Claude";
  if (provider === "OpenAI") return "Codex";
  return "Cursor";
}

const DIFF_PREFIX = "diff:";

export function isDiffTab(id: string): boolean {
  return id.startsWith(DIFF_PREFIX);
}

export function diffPath(id: string): string {
  return id.slice(DIFF_PREFIX.length);
}

export function diffTabId(path: string): string {
  return `${DIFF_PREFIX}${path}`;
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function eventOrder(id: string): number {
  const match = id.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function historyPreview(event: TranscriptEvent): string {
  const content = extractEventText(event.payload).trim() || "Untitled event";
  return content.length > 42 ? `${content.slice(0, 39)}...` : content;
}

function historyDetail(event: TranscriptEvent): string {
  const content = extractEventText(event.payload).trim();
  return content || "Untitled event";
}

export function buildHistoryEvents(tabs: AgentTab[]): HistoryEvent[] {
  return tabs
    .flatMap((tab) =>
      tab.transcript
        .filter((event) => event.sender === "client")
        .map((event) => ({
          id: `history-${tab.id}-${event.id}`,
          messageId: event.id,
          preview: historyPreview(event),
          sessionName: tab.sessionName,
          tabId: tab.id,
          createdAtMs: event.createdAt,
          detail: historyDetail(event),
        })),
    )
    .sort((left, right) => eventOrder(left.messageId) - eventOrder(right.messageId));
}

export interface Message {
  id: string;
  sender: "client" | "agent";
  text: string;
  createdAtMs: number;
  durationMs?: number;
  event: TranscriptEvent;
}

function isAgentChunkEvent(event: TranscriptEvent): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") {
    return null;
  }

  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== "object") {
    return null;
  }

  if ((update as { sessionUpdate?: unknown }).sessionUpdate !== "agent_message_chunk") {
    return null;
  }

  const content = (update as { content?: unknown }).content;
  if (!content || typeof content !== "object") {
    return null;
  }

  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

function isClientPromptEvent(event: TranscriptEvent): boolean {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return (payload as { method?: unknown }).method === "session/prompt";
}

function shouldDisplayEvent(event: TranscriptEvent): boolean {
  const payload = event.payload;
  if (event.sender === "client") {
    return isClientPromptEvent(event) && Boolean(extractEventText(payload).trim());
  }

  if (!payload || typeof payload !== "object") {
    return Boolean(extractEventText(payload).trim());
  }

  if ((payload as { error?: unknown }).error) {
    return true;
  }

  if (isAgentChunkEvent(event) !== null) {
    return false;
  }

  if ((payload as { method?: unknown }).method === "session/update") {
    return false;
  }

  const result = (payload as { result?: unknown }).result;
  if (result && typeof result === "object") {
    if (typeof (result as { stopReason?: unknown }).stopReason === "string") {
      return false;
    }
    if (typeof (result as { text?: unknown }).text !== "string") {
      return false;
    }
  }

  const params = (payload as { params?: unknown }).params;
  if (params && typeof params === "object") {
    const update = (params as { update?: unknown }).update;
    if (update && typeof update === "object") {
      const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
      if (
        sessionUpdate === "usage_update" ||
        sessionUpdate === "available_commands_update" ||
        sessionUpdate === "config_options_update" ||
        sessionUpdate === "available_modes_update" ||
        sessionUpdate === "available_models_update"
      ) {
        return false;
      }
    }
  }

  return Boolean(extractEventText(payload).trim());
}

export function buildDisplayMessages(tab: AgentTab | null | undefined): Message[] {
  if (!tab) {
    return [];
  }

  const messages: Message[] = [];
  let pendingAgentMessage: Message | null = null;

  const flushPendingAgentMessage = () => {
    if (pendingAgentMessage && pendingAgentMessage.text.length > 0) {
      messages.push(pendingAgentMessage);
    }
    pendingAgentMessage = null;
  };

  for (const event of tab.transcript) {
    const chunkText = isAgentChunkEvent(event);
    if (chunkText !== null) {
      if (!pendingAgentMessage) {
        pendingAgentMessage = {
          id: event.id,
          sender: "agent",
          text: chunkText,
          createdAtMs: event.createdAt,
          event,
        };
      } else {
        pendingAgentMessage.text += chunkText;
      }
      continue;
    }

    flushPendingAgentMessage();

    if (!shouldDisplayEvent(event)) {
      continue;
    }

    messages.push({
      id: event.id,
      sender: event.sender,
      text: extractEventText(event.payload),
      createdAtMs: event.createdAt,
      durationMs:
        event.payload && typeof event.payload === "object"
          ? typeof (event.payload as { result?: { durationMs?: unknown } }).result?.durationMs === "number"
            ? ((event.payload as { result?: { durationMs?: number } }).result?.durationMs ?? undefined)
            : undefined
          : undefined,
      event,
    });
  }

  flushPendingAgentMessage();
  return messages;
}

export function parseDiffLines(diff: string): ParsedDiffLine[] {
  return diff.split("\n").map((text, index) => {
    if (text.startsWith("@@")) {
      return { kind: "hunk", lineNumber: index + 1, text };
    }
    if (text.startsWith("+")) {
      return { kind: "add", lineNumber: index + 1, text };
    }
    if (text.startsWith("-")) {
      return { kind: "remove", lineNumber: index + 1, text };
    }
    return { kind: "context", lineNumber: index + 1, text };
  });
}

export type {
  AgentKind,
  AgentTab,
  DiffLineKind,
  FileChange,
  FileTreeNode,
  Task,
  HistoryEvent,
  LineAttachment,
  ModelGroup,
  ModelId,
  ParsedDiffLine,
  TranscriptEvent,
};
