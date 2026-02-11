import { getAvatarLabel, getMessageClass } from "./messageUtils";
import type { TimelineEntry } from "./types";
import { formatJson } from "../../utils/format";

const ChatMessages = ({
  entries,
  sessionError,
  messagesEndRef
}: {
  entries: TimelineEntry[];
  sessionError: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
}) => {
  return (
    <div className="messages">
      {entries.map((entry) => {
        const messageClass = getMessageClass(entry);

        if (entry.kind === "meta") {
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

        if (entry.kind === "reasoning") {
          return (
            <div key={entry.id} className="message assistant">
              <div className="avatar">AI</div>
              <div className="message-content">
                <div className="message-meta">
                  <span>reasoning - {entry.reasoning?.visibility ?? "public"}</span>
                </div>
                <div className="part-body muted">{entry.reasoning?.text ?? ""}</div>
              </div>
            </div>
          );
        }

        if (entry.kind === "tool") {
          const isComplete = entry.toolStatus === "completed" || entry.toolStatus === "failed";
          const isFailed = entry.toolStatus === "failed";
          return (
            <div key={entry.id} className={`message tool ${isFailed ? "error" : ""}`}>
              <div className="avatar">{getAvatarLabel(isFailed ? "error" : "tool")}</div>
              <div className="message-content">
                <div className="message-meta">
                  <span>tool call - {entry.toolName}</span>
                  {entry.toolStatus && entry.toolStatus !== "completed" && (
                    <span className={`pill ${isFailed ? "danger" : "accent"}`}>
                      {entry.toolStatus.replace("_", " ")}
                    </span>
                  )}
                </div>
                {entry.toolInput && <pre className="code-block">{entry.toolInput}</pre>}
                {isComplete && entry.toolOutput && (
                  <div className="part">
                    <div className="part-title">result</div>
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
              </div>
            </div>
          );
        }

        // Message (user or assistant)
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
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ChatMessages;
