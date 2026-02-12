import { useState } from "react";
import { getAvatarLabel, getMessageClass } from "./messageUtils";
import type { TimelineEntry } from "./types";
import { AlertTriangle, Settings, ChevronRight, ChevronDown } from "lucide-react";

const CollapsibleMessage = ({
  id,
  icon,
  label,
  children,
  className = ""
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  className?: string;
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`collapsible-message ${className}`}>
      <button className="collapsible-header" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        <span>{label}</span>
      </button>
      {expanded && <div className="collapsible-content">{children}</div>}
    </div>
  );
};

const ChatMessages = ({
  entries,
  sessionError,
  eventError,
  messagesEndRef
}: {
  entries: TimelineEntry[];
  sessionError: string | null;
  eventError: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}) => {
  return (
    <div className="messages">
      {entries.map((entry) => {
        if (entry.kind === "meta") {
          const isError = entry.meta?.severity === "error";
          const title = entry.meta?.title ?? "Status";
          const isStatusDivider = ["Session Started", "Turn Started", "Turn Ended"].includes(title);

          if (isStatusDivider) {
            return (
              <div key={entry.id} className="status-divider">
                <div className="status-divider-line" />
                <span className="status-divider-text">
                  <Settings size={12} />
                  {title}
                </span>
                <div className="status-divider-line" />
              </div>
            );
          }

          // Other status messages - collapsible only if there's detail
          const hasDetail = Boolean(entry.meta?.detail);
          if (hasDetail) {
            return (
              <CollapsibleMessage
                key={entry.id}
                id={entry.id}
                icon={isError ? <AlertTriangle size={14} className="error-icon" /> : <Settings size={14} className="system-icon" />}
                label={title}
                className={isError ? "error" : "system"}
              >
                <div className="part-body">{entry.meta?.detail}</div>
              </CollapsibleMessage>
            );
          }

          // No detail - simple non-collapsible message
          return (
            <div key={entry.id} className={`simple-status-message ${isError ? "error" : "system"}`}>
              {isError ? <AlertTriangle size={14} className="error-icon" /> : <Settings size={14} className="system-icon" />}
              <span>{title}</span>
            </div>
          );
        }

        if (entry.kind === "reasoning") {
          return (
            <CollapsibleMessage
              key={entry.id}
              id={entry.id}
              icon={<Settings size={14} className="system-icon" />}
              label={`Reasoning${entry.reasoning?.visibility ? ` (${entry.reasoning.visibility})` : ""}`}
              className="system"
            >
              <div className="part-body muted">{entry.reasoning?.text}</div>
            </CollapsibleMessage>
          );
        }

        if (entry.kind === "tool") {
          const isComplete = entry.toolStatus === "completed" || entry.toolStatus === "failed";
          const isFailed = entry.toolStatus === "failed";
          const statusLabel = entry.toolStatus && entry.toolStatus !== "completed"
            ? entry.toolStatus.replace("_", " ")
            : "";

          return (
            <CollapsibleMessage
              key={entry.id}
              id={entry.id}
              icon={<span className="tool-icon">T</span>}
              label={`${entry.toolName ?? "tool"}${statusLabel ? ` (${statusLabel})` : ""}`}
              className={`tool${isFailed ? " error" : ""}`}
            >
              {entry.toolInput && (
                <div className="part">
                  <div className="part-title">input</div>
                  <pre className="code-block">{entry.toolInput}</pre>
                </div>
              )}
              {isComplete && entry.toolOutput && (
                <div className="part">
                  <div className="part-title">output</div>
                  <pre className="code-block">{entry.toolOutput}</pre>
                </div>
              )}
              {!isComplete && !entry.toolInput && (
                <span className="thinking-indicator">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                </span>
              )}
            </CollapsibleMessage>
          );
        }

        // Regular message
        const messageClass = getMessageClass(entry);

        return (
          <div key={entry.id} className={`message ${messageClass}`}>
            <div className="avatar">{getAvatarLabel(messageClass)}</div>
            <div className="message-content">
              {entry.text ? (
                <div className="part-body">{entry.text}</div>
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
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatMessages;
