import { memo, useEffect, useState } from "react";
import { useStyletron } from "baseui";
import { LabelXSmall } from "baseui/typography";

import { formatMessageTimestamp, type HistoryEvent } from "./view-model";

export const HistoryMinimap = memo(function HistoryMinimap({ events, onSelect }: { events: HistoryEvent[]; onSelect: (event: HistoryEvent) => void }) {
  const [css, theme] = useStyletron();
  const [open, setOpen] = useState(false);
  const [activeEventId, setActiveEventId] = useState<string | null>(events[events.length - 1]?.id ?? null);

  useEffect(() => {
    if (!events.some((event) => event.id === activeEventId)) {
      setActiveEventId(events[events.length - 1]?.id ?? null);
    }
  }, [activeEventId, events]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div
      className={css({
        position: "absolute",
        top: "20px",
        right: "16px",
        zIndex: 3,
        display: "flex",
        alignItems: "flex-start",
        gap: "12px",
      })}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {open ? (
        <div
          className={css({
            width: "220px",
            maxHeight: "320px",
            overflowY: "auto",
          })}
        >
          <div className={css({ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" })}>
            <LabelXSmall color={theme.colors.contentTertiary} $style={{ letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Task Events
            </LabelXSmall>
            <LabelXSmall color={theme.colors.contentTertiary}>{events.length}</LabelXSmall>
          </div>
          <div className={css({ display: "flex", flexDirection: "column", gap: "6px" })}>
            {events.map((event) => {
              const isActive = event.id === activeEventId;
              return (
                <button
                  key={event.id}
                  type="button"
                  onMouseEnter={() => setActiveEventId(event.id)}
                  onFocus={() => setActiveEventId(event.id)}
                  onClick={() => onSelect(event)}
                  className={css({
                    all: "unset",
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: "10px",
                    alignItems: "center",
                    padding: "9px 10px",
                    borderRadius: "12px",
                    cursor: "pointer",
                    backgroundColor: isActive ? "rgba(255, 255, 255, 0.08)" : "transparent",
                    color: isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary,
                    transition: "background 160ms ease, color 160ms ease",
                    ":hover": {
                      backgroundColor: "rgba(255, 255, 255, 0.08)",
                      color: theme.colors.contentPrimary,
                    },
                  })}
                >
                  <div className={css({ minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" })}>
                    <div
                      className={css({
                        fontSize: "12px",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      })}
                    >
                      {event.preview}
                    </div>
                    <LabelXSmall color={theme.colors.contentTertiary}>{event.sessionName}</LabelXSmall>
                  </div>
                  <LabelXSmall color={theme.colors.contentTertiary}>{formatMessageTimestamp(event.createdAtMs)}</LabelXSmall>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div
        className={css({
          width: "18px",
          padding: "4px 0",
          display: "flex",
          flexDirection: "column",
          gap: "5px",
          alignItems: "stretch",
        })}
      >
        {events.map((event) => {
          const isActive = event.id === activeEventId;
          return (
            <div
              key={event.id}
              className={css({
                height: "3px",
                borderRadius: "999px",
                backgroundColor: isActive ? "#ff4f00" : "rgba(255, 255, 255, 0.22)",
                opacity: isActive ? 1 : 0.75,
                transition: "background 160ms ease, opacity 160ms ease",
              })}
            />
          );
        })}
      </div>
    </div>
  );
});
