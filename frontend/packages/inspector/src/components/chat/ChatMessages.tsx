import { useState } from "react";
import { getAvatarLabel, getMessageClass } from "./messageUtils";
import renderContentPart from "./renderContentPart";
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

          // Other status messages - collapsible
          return (
            <CollapsibleMessage
              key={entry.id}
              id={entry.id}
              icon={isError ? <AlertTriangle size={14} className="error-icon" /> : <Settings size={14} className="system-icon" />}
              label={title}
              className={isError ? "error" : "system"}
            >
              {entry.meta?.detail && <div className="part-body">{entry.meta.detail}</div>}
            </CollapsibleMessage>
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
        const isTool = messageClass === "tool";

        // Tool results - collapsible
        if (isTool) {
          return (
            <CollapsibleMessage
              key={entry.id}
              id={entry.id}
              icon={<span className="tool-icon">T</span>}
              label={`${kindLabel}${statusLabel ? ` (${statusLabel})` : ""}`}
              className="tool"
            >
              {hasParts ? (
                (item.content ?? []).map(renderContentPart)
              ) : entry.deltaText ? (
                <span>{entry.deltaText}</span>
              ) : (
                <span className="muted">No content.</span>
              )}
            </CollapsibleMessage>
          );
        }

        return (
          <div key={entry.id} className={`message ${messageClass} ${isFailed ? "error no-avatar" : ""}`}>
            {!isFailed && <div className="avatar">{getAvatarLabel(messageClass)}</div>}
            <div className="message-content">
              {(item.kind !== "message" || item.status !== "completed") && (
                <div className="message-meta">
                  {isFailed && <AlertTriangle size={14} className="error-icon" />}
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
              ) : isInProgress ? (
                <span className="thinking-indicator">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                </span>
              ) : (
                <span className="muted">No content yet.</span>
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
