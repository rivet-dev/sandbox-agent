import { memo } from "react";
import { useStyletron } from "baseui";
import { LabelSmall } from "baseui/typography";
import { Clock, MailOpen } from "lucide-react";

import { PanelHeaderBar } from "./ui";
import { type AgentTab, type Handoff } from "./view-model";

export const TranscriptHeader = memo(function TranscriptHeader({
  handoff,
  activeTab,
  editingField,
  editValue,
  onEditValueChange,
  onStartEditingField,
  onCommitEditingField,
  onCancelEditingField,
  onSetActiveTabUnread,
}: {
  handoff: Handoff;
  activeTab: AgentTab | null | undefined;
  editingField: "title" | "branch" | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onStartEditingField: (field: "title" | "branch", value: string) => void;
  onCommitEditingField: (field: "title" | "branch") => void;
  onCancelEditingField: () => void;
  onSetActiveTabUnread: (unread: boolean) => void;
}) {
  const [css, theme] = useStyletron();

  return (
    <PanelHeaderBar $style={{ backgroundColor: "#0f0f11", borderBottom: "none" }}>
      {editingField === "title" ? (
        <input
          autoFocus
          value={editValue}
          onChange={(event) => onEditValueChange(event.target.value)}
          onBlur={() => onCommitEditingField("title")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommitEditingField("title");
            } else if (event.key === "Escape") {
              onCancelEditingField();
            }
          }}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            padding: "0",
            margin: "0",
            outline: "none",
            fontWeight: 500,
            fontSize: "14px",
            color: theme.colors.contentPrimary,
            borderBottom: "1px solid rgba(255, 255, 255, 0.3)",
            minWidth: "80px",
            maxWidth: "300px",
          })}
        />
      ) : (
        <LabelSmall
          title="Rename"
          color={theme.colors.contentPrimary}
          $style={{ fontWeight: 400, whiteSpace: "nowrap", cursor: "pointer", ":hover": { textDecoration: "underline" } }}
          onClick={() => onStartEditingField("title", handoff.title)}
        >
          {handoff.title}
        </LabelSmall>
      )}
      {handoff.branch ? (
        editingField === "branch" ? (
          <input
            autoFocus
            value={editValue}
            onChange={(event) => onEditValueChange(event.target.value)}
            onBlur={() => onCommitEditingField("branch")}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onCommitEditingField("branch");
              } else if (event.key === "Escape") {
                onCancelEditingField();
              }
            }}
            className={css({
              appearance: "none",
              WebkitAppearance: "none",
              background: "none",
              margin: "0",
              outline: "none",
              padding: "2px 8px",
              borderRadius: "999px",
              border: "1px solid rgba(255, 255, 255, 0.3)",
              backgroundColor: "rgba(255, 255, 255, 0.03)",
              color: "#e4e4e7",
              fontSize: "11px",
              whiteSpace: "nowrap",
              fontFamily: '"IBM Plex Mono", monospace',
              minWidth: "60px",
            })}
          />
        ) : (
          <span
            title="Rename"
            onClick={() => onStartEditingField("branch", handoff.branch ?? "")}
            className={css({
              padding: "2px 8px",
              borderRadius: "999px",
              border: "1px solid rgba(255, 255, 255, 0.14)",
              backgroundColor: "rgba(255, 255, 255, 0.03)",
              color: "#e4e4e7",
              fontSize: "11px",
              whiteSpace: "nowrap",
              fontFamily: '"IBM Plex Mono", monospace',
              cursor: "pointer",
              ":hover": { borderColor: "rgba(255, 255, 255, 0.3)" },
            })}
          >
            {handoff.branch}
          </span>
        )
      ) : null}
      <div className={css({ flex: 1 })} />
      <div
        className={css({
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "3px 10px",
          borderRadius: "6px",
          backgroundColor: "rgba(255, 255, 255, 0.05)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          fontSize: "11px",
          fontWeight: 500,
          lineHeight: 1,
          color: theme.colors.contentSecondary,
          whiteSpace: "nowrap",
        })}
      >
        <Clock size={11} style={{ flexShrink: 0 }} />
        <span>847 min used</span>
      </div>
      {activeTab ? (
        <button
          onClick={() => onSetActiveTabUnread(!activeTab.unread)}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            margin: "0",
            boxSizing: "border-box",
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "4px 10px",
            borderRadius: "6px",
            fontSize: "11px",
            fontWeight: 500,
            lineHeight: 1,
            color: theme.colors.contentSecondary,
            cursor: "pointer",
            transition: "all 200ms ease",
            ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: theme.colors.contentPrimary },
          })}
        >
          <MailOpen size={12} style={{ flexShrink: 0 }} /> {activeTab.unread ? "Mark read" : "Mark unread"}
        </button>
      ) : null}
    </PanelHeaderBar>
  );
});
