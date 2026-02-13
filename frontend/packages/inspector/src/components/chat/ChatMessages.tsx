import { useState } from "react";
import { getMessageClass } from "./messageUtils";
import type { TimelineEntry } from "./types";
import { AlertTriangle, ChevronRight, ChevronDown, Wrench, Brain, Info, ExternalLink, PlayCircle } from "lucide-react";
import MarkdownText from "./MarkdownText";

const ToolItem = ({
  entry,
  isLast,
  onEventClick
}: {
  entry: TimelineEntry;
  isLast: boolean;
  onEventClick?: (eventId: string) => void;
}) => {
  const [expanded, setExpanded] = useState(false);

  const isTool = entry.kind === "tool";
  const isReasoning = entry.kind === "reasoning";
  const isMeta = entry.kind === "meta";

  const isComplete = isTool && (entry.toolStatus === "completed" || entry.toolStatus === "failed");
  const isFailed = isTool && entry.toolStatus === "failed";
  const isInProgress = isTool && entry.toolStatus === "in_progress";

  let label = "";
  let icon = <Info size={12} />;

  if (isTool) {
    const statusLabel = entry.toolStatus && entry.toolStatus !== "completed"
      ? ` (${entry.toolStatus.replace("_", " ")})`
      : "";
    label = `${entry.toolName ?? "tool"}${statusLabel}`;
    icon = <Wrench size={12} />;
  } else if (isReasoning) {
    label = `Reasoning${entry.reasoning?.visibility ? ` (${entry.reasoning.visibility})` : ""}`;
    icon = <Brain size={12} />;
  } else if (isMeta) {
    label = entry.meta?.title ?? "Status";
    icon = entry.meta?.severity === "error" ? <AlertTriangle size={12} /> : <Info size={12} />;
  }

  const hasContent = isTool
    ? Boolean(entry.toolInput || entry.toolOutput)
    : isReasoning
      ? Boolean(entry.reasoning?.text?.trim())
      : Boolean(entry.meta?.detail?.trim());
  const canOpenEvent = Boolean(
    entry.eventId &&
    onEventClick &&
    !(isMeta && entry.meta?.title === "Available commands update"),
  );

  return (
    <div className={`tool-item ${isLast ? "last" : ""} ${isFailed ? "failed" : ""}`}>
      <div className="tool-item-connector">
        <div className="tool-item-dot" />
        {!isLast && <div className="tool-item-line" />}
      </div>
      <div className="tool-item-content">
        <button
          className={`tool-item-header ${expanded ? "expanded" : ""}`}
          onClick={() => hasContent && setExpanded(!expanded)}
          disabled={!hasContent}
        >
          <span className="tool-item-icon">{icon}</span>
          <span className="tool-item-label">{label}</span>
          {isInProgress && (
            <span className="tool-item-spinner">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </span>
          )}
          {canOpenEvent && (
            <span
              className="tool-item-link"
              onClick={(e) => {
                e.stopPropagation();
                onEventClick(entry.eventId!);
              }}
              title="View in Events"
            >
              <ExternalLink size={10} />
            </span>
          )}
          {hasContent && (
            <span className="tool-item-chevron">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>
        {expanded && hasContent && (
          <div className="tool-item-body">
            {isTool && entry.toolInput && (
              <div className="tool-section">
                <div className="tool-section-title">Input</div>
                <pre className="tool-code">{entry.toolInput}</pre>
              </div>
            )}
            {isTool && isComplete && entry.toolOutput && (
              <div className="tool-section">
                <div className="tool-section-title">Output</div>
                <pre className="tool-code">{entry.toolOutput}</pre>
              </div>
            )}
            {isReasoning && entry.reasoning?.text && (
              <div className="tool-section">
                <pre className="tool-code muted">{entry.reasoning.text}</pre>
              </div>
            )}
            {isMeta && entry.meta?.detail && (
              <div className="tool-section">
                <pre className="tool-code">{entry.meta.detail}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const ToolGroup = ({ entries, onEventClick }: { entries: TimelineEntry[]; onEventClick?: (eventId: string) => void }) => {
  const [expanded, setExpanded] = useState(false);

  // If only one item, render it directly without macro wrapper
  if (entries.length === 1) {
    return (
      <div className="tool-group-single">
        <ToolItem entry={entries[0]} isLast={true} onEventClick={onEventClick} />
      </div>
    );
  }

  const totalCount = entries.length;
  const summary = `${totalCount} Event${totalCount > 1 ? "s" : ""}`;

  // Check if any are in progress
  const hasInProgress = entries.some(e => e.kind === "tool" && e.toolStatus === "in_progress");
  const hasFailed = entries.some(e => e.kind === "tool" && e.toolStatus === "failed");

  return (
    <div className={`tool-group-container ${hasFailed ? "failed" : ""}`}>
      <button
        className={`tool-group-header ${expanded ? "expanded" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-group-icon">
          <PlayCircle size={14} />
        </span>
        <span className="tool-group-label">{summary}</span>
        <span className="tool-group-chevron">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {expanded && (
        <div className="tool-group">
          {entries.map((entry, idx) => (
            <ToolItem
              key={entry.id}
              entry={entry}
              isLast={idx === entries.length - 1}
              onEventClick={onEventClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const agentLogos: Record<string, string> = {
  claude: `${import.meta.env.BASE_URL}logos/claude.svg`,
  codex: `${import.meta.env.BASE_URL}logos/openai.svg`,
  opencode: `${import.meta.env.BASE_URL}logos/opencode.svg`,
  amp: `${import.meta.env.BASE_URL}logos/amp.svg`,
  pi: `${import.meta.env.BASE_URL}logos/pi.svg`,
};

const ChatMessages = ({
  entries,
  sessionError,
  eventError,
  messagesEndRef,
  onEventClick,
  isThinking,
  agentId
}: {
  entries: TimelineEntry[];
  sessionError: string | null;
  eventError?: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  onEventClick?: (eventId: string) => void;
  isThinking?: boolean;
  agentId?: string;
}) => {
  // Group consecutive tool/reasoning/meta entries together
  const groupedEntries: Array<{ type: "message" | "tool-group" | "divider"; entries: TimelineEntry[] }> = [];

  let currentToolGroup: TimelineEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      groupedEntries.push({ type: "tool-group", entries: currentToolGroup });
      currentToolGroup = [];
    }
  };

  for (const entry of entries) {
    const isStatusDivider = entry.kind === "meta" &&
      ["Session Started", "Turn Started", "Turn Ended"].includes(entry.meta?.title ?? "");

    if (isStatusDivider) {
      flushToolGroup();
      groupedEntries.push({ type: "divider", entries: [entry] });
    } else if (entry.kind === "tool" || entry.kind === "reasoning" || (entry.kind === "meta" && entry.meta?.detail)) {
      currentToolGroup.push(entry);
    } else if (entry.kind === "meta" && !entry.meta?.detail) {
      // Simple meta without detail - add to tool group as single item
      currentToolGroup.push(entry);
    } else {
      // Regular message
      flushToolGroup();
      groupedEntries.push({ type: "message", entries: [entry] });
    }
  }
  flushToolGroup();

  return (
    <div className="messages">
      {groupedEntries.map((group, idx) => {
        if (group.type === "divider") {
          const entry = group.entries[0];
          const title = entry.meta?.title ?? "Status";
          return (
            <div key={entry.id} className="status-divider">
              <div className="status-divider-line" />
              <span className="status-divider-text">{title}</span>
              <div className="status-divider-line" />
            </div>
          );
        }

        if (group.type === "tool-group") {
          return <ToolGroup key={`group-${idx}`} entries={group.entries} onEventClick={onEventClick} />;
        }

        // Regular message
        const entry = group.entries[0];
        const messageClass = getMessageClass(entry);

        return (
          <div key={entry.id} className={`message ${messageClass} no-avatar`}>
            <div className="message-content">
              {entry.text ? (
                <MarkdownText text={entry.text} />
              ) : (
                <span className="thinking-indicator">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                </span>
              )}
            </div>
          </div>
        );
      })}
      {sessionError && <div className="message-error">{sessionError}</div>}
      {eventError && <div className="message-error">{eventError}</div>}
      {isThinking && (
        <div className="thinking-row">
          <div className="thinking-avatar">
            {agentId && agentLogos[agentId] ? (
              <img src={agentLogos[agentId]} alt="" className="thinking-avatar-img" />
            ) : (
              <span className="ai-label">AI</span>
            )}
          </div>
          <span className="thinking-indicator">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </span>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatMessages;
