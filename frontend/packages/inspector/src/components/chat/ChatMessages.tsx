import { getAvatarLabel, getMessageClass } from "./messageUtils";
import renderContentPart from "./renderContentPart";
import type { TimelineEntry } from "./types";

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
        const statusValue = item.status ?? "";
        const statusLabel =
          statusValue && statusValue !== "completed" ? statusValue.replace("_", " ") : "";
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
