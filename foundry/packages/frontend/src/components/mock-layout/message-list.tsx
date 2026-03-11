import { AgentTranscript, type AgentTranscriptClassNames, type TranscriptEntry } from "@sandbox-agent/react";
import { memo, useMemo, type MutableRefObject, type Ref } from "react";
import { useStyletron } from "baseui";
import { LabelSmall, LabelXSmall } from "baseui/typography";
import { Copy } from "lucide-react";

import { HistoryMinimap } from "./history-minimap";
import { SpinnerDot } from "./ui";
import { buildDisplayMessages, formatMessageDuration, formatMessageTimestamp, type AgentTab, type HistoryEvent, type Message } from "./view-model";

const TranscriptMessageBody = memo(function TranscriptMessageBody({
  message,
  messageRefs,
  copiedMessageId,
  onCopyMessage,
}: {
  message: Message;
  messageRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  copiedMessageId: string | null;
  onCopyMessage: (message: Message) => void;
}) {
  const [css, theme] = useStyletron();
  const isUser = message.sender === "client";
  const isCopied = copiedMessageId === message.id;
  const messageTimestamp = formatMessageTimestamp(message.createdAtMs);
  const displayFooter = isUser ? messageTimestamp : message.durationMs ? `${messageTimestamp} • Took ${formatMessageDuration(message.durationMs)}` : null;

  return (
    <div
      ref={(node) => {
        if (node) {
          messageRefs.current.set(message.id, node);
        } else {
          messageRefs.current.delete(message.id);
        }
      }}
      className={css({
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: "6px",
      })}
    >
      <div
        className={css({
          maxWidth: "100%",
          padding: "12px 16px",
          borderTopLeftRadius: "16px",
          borderTopRightRadius: "16px",
          ...(isUser
            ? {
                backgroundColor: "rgba(255, 255, 255, 0.10)",
                color: "#e4e4e7",
                borderBottomLeftRadius: "16px",
                borderBottomRightRadius: "4px",
              }
            : {
                backgroundColor: "transparent",
                border: "none",
                color: "#e4e4e7",
                borderRadius: "0",
                padding: "0",
              }),
        })}
      >
        <div
          data-selectable
          className={css({
            fontSize: "13px",
            lineHeight: "1.6",
            whiteSpace: "pre-wrap",
            wordWrap: "break-word",
          })}
        >
          {message.text}
        </div>
      </div>
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "10px",
          justifyContent: isUser ? "flex-end" : "flex-start",
          minHeight: "16px",
          paddingLeft: isUser ? undefined : "2px",
        })}
      >
        {displayFooter ? (
          <LabelXSmall color={theme.colors.contentTertiary} $style={{ fontFamily: '"IBM Plex Mono", monospace', letterSpacing: "0.01em" }}>
            {displayFooter}
          </LabelXSmall>
        ) : null}
        <button
          type="button"
          data-copy-action="true"
          onClick={() => onCopyMessage(message)}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            padding: "0",
            margin: "0",
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            fontSize: "11px",
            cursor: "pointer",
            color: isCopied ? theme.colors.contentPrimary : theme.colors.contentSecondary,
            transition: "color 160ms ease",
            ":hover": { color: theme.colors.contentPrimary },
          })}
        >
          <Copy size={11} />
          {isCopied ? "Copied" : null}
        </button>
      </div>
    </div>
  );
});

export const MessageList = memo(function MessageList({
  tab,
  scrollRef,
  messageRefs,
  historyEvents,
  onSelectHistoryEvent,
  copiedMessageId,
  onCopyMessage,
  thinkingTimerLabel,
}: {
  tab: AgentTab | null | undefined;
  scrollRef: Ref<HTMLDivElement>;
  messageRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  historyEvents: HistoryEvent[];
  onSelectHistoryEvent: (event: HistoryEvent) => void;
  copiedMessageId: string | null;
  onCopyMessage: (message: Message) => void;
  thinkingTimerLabel: string | null;
}) {
  const [css, theme] = useStyletron();
  const messages = useMemo(() => buildDisplayMessages(tab), [tab]);
  const messagesById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const transcriptEntries = useMemo<TranscriptEntry[]>(
    () =>
      messages.map((message) => ({
        id: message.id,
        eventId: message.id,
        kind: "message",
        time: new Date(message.createdAtMs).toISOString(),
        role: message.sender === "client" ? "user" : "assistant",
        text: message.text,
      })),
    [messages],
  );

  const messageContentClass = css({
    maxWidth: "80%",
    display: "flex",
    flexDirection: "column",
  });

  const transcriptClassNames: Partial<AgentTranscriptClassNames> = {
    root: css({
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    }),
    message: css({
      display: "flex",
    }),
    messageContent: messageContentClass,
    messageText: css({
      width: "100%",
    }),
    thinkingRow: css({
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "4px 0",
    }),
    thinkingIndicator: css({
      display: "flex",
      alignItems: "center",
      gap: "8px",
      color: "#ff4f00",
      fontSize: "11px",
      fontFamily: '"IBM Plex Mono", monospace',
      letterSpacing: "0.01em",
    }),
  };

  return (
    <>
      <style>{`
        [data-variant="user"] > [data-slot="message-content"] {
          margin-left: auto;
        }
      `}</style>
      {historyEvents.length > 0 ? <HistoryMinimap events={historyEvents} onSelect={onSelectHistoryEvent} /> : null}
      <div
        ref={scrollRef}
        className={css({
          padding: "16px 220px 16px 44px",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
        })}
      >
        {tab && transcriptEntries.length === 0 ? (
          <div
            className={css({
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              minHeight: "200px",
              gap: "8px",
            })}
          >
            <LabelSmall color={theme.colors.contentTertiary}>
              {!tab.created ? "Choose an agent and model, then send your first message" : "No messages yet in this session"}
            </LabelSmall>
          </div>
        ) : (
          <AgentTranscript
            entries={transcriptEntries}
            classNames={transcriptClassNames}
            renderMessageText={(entry) => {
              const message = messagesById.get(entry.id);
              if (!message) {
                return null;
              }

              return <TranscriptMessageBody message={message} messageRefs={messageRefs} copiedMessageId={copiedMessageId} onCopyMessage={onCopyMessage} />;
            }}
            isThinking={Boolean(tab && tab.status === "running" && transcriptEntries.length > 0)}
            renderThinkingState={() => (
              <div className={transcriptClassNames.thinkingRow}>
                <SpinnerDot size={12} />
                <LabelXSmall color="#ff4f00" $style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>Agent is thinking</span>
                  {thinkingTimerLabel ? (
                    <span
                      className={css({
                        padding: "2px 7px",
                        borderRadius: "999px",
                        backgroundColor: "rgba(255, 79, 0, 0.12)",
                        border: "1px solid rgba(255, 79, 0, 0.2)",
                        fontFamily: '"IBM Plex Mono", monospace',
                        fontSize: "10px",
                        letterSpacing: "0.04em",
                      })}
                    >
                      {thinkingTimerLabel}
                    </span>
                  ) : null}
                </LabelXSmall>
              </div>
            )}
          />
        )}
      </div>
    </>
  );
});
