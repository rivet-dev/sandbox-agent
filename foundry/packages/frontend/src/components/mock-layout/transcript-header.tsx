import { memo } from "react";
import { useStyletron } from "baseui";
import { LabelSmall } from "baseui/typography";
import { MailOpen } from "lucide-react";

import { PanelHeaderBar } from "./ui";
import { type AgentTab, type Task } from "./view-model";

export const TranscriptHeader = memo(function TranscriptHeader({
  task,
  activeTab,
  editingField,
  editValue,
  onEditValueChange,
  onStartEditingField,
  onCommitEditingField,
  onCancelEditingField,
  onSetActiveTabUnread,
}: {
  task: Task;
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
    <PanelHeaderBar>
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
            all: "unset",
            fontWeight: 600,
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
          $style={{ fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", ":hover": { textDecoration: "underline" } }}
          onClick={() => onStartEditingField("title", task.title)}
        >
          {task.title}
        </LabelSmall>
      )}
      {task.branch ? (
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
              all: "unset",
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
            onClick={() => onStartEditingField("branch", task.branch ?? "")}
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
            {task.branch}
          </span>
        )
      ) : null}
      <div className={css({ flex: 1 })} />
      {activeTab ? (
        <button
          onClick={() => onSetActiveTabUnread(!activeTab.unread)}
          className={css({
            all: "unset",
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "4px 10px",
            borderRadius: "6px",
            fontSize: "11px",
            fontWeight: 500,
            color: theme.colors.contentSecondary,
            cursor: "pointer",
            transition: "all 200ms ease",
            ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: theme.colors.contentPrimary },
          })}
        >
          <MailOpen size={12} /> {activeTab.unread ? "Mark read" : "Mark unread"}
        </button>
      ) : null}
    </PanelHeaderBar>
  );
});
