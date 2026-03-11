import { memo } from "react";
import { useStyletron } from "baseui";
import { LabelXSmall } from "baseui/typography";
import { FileCode, Plus, X } from "lucide-react";

import { ContextMenuOverlay, TabAvatar, useContextMenu } from "./ui";
import { diffTabId, fileName, type Task } from "./view-model";

export const TabStrip = memo(function TabStrip({
  task,
  activeTabId,
  openDiffs,
  editingSessionTabId,
  editingSessionName,
  onEditingSessionNameChange,
  onSwitchTab,
  onStartRenamingTab,
  onCommitSessionRename,
  onCancelSessionRename,
  onSetTabUnread,
  onCloseTab,
  onCloseDiffTab,
  onAddTab,
}: {
  task: Task;
  activeTabId: string | null;
  openDiffs: string[];
  editingSessionTabId: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onSwitchTab: (tabId: string) => void;
  onStartRenamingTab: (tabId: string) => void;
  onCommitSessionRename: () => void;
  onCancelSessionRename: () => void;
  onSetTabUnread: (tabId: string, unread: boolean) => void;
  onCloseTab: (tabId: string) => void;
  onCloseDiffTab: (path: string) => void;
  onAddTab: () => void;
}) {
  const [css, theme] = useStyletron();
  const contextMenu = useContextMenu();

  return (
    <>
      <div
        className={css({
          display: "flex",
          alignItems: "stretch",
          borderBottom: `1px solid ${theme.colors.borderOpaque}`,
          backgroundColor: theme.colors.backgroundSecondary,
          height: "41px",
          minHeight: "41px",
          overflowX: "auto",
          scrollbarWidth: "none",
          flexShrink: 0,
          "::-webkit-scrollbar": { display: "none" },
        })}
      >
        {task.tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSwitchTab(tab.id)}
              onDoubleClick={() => onStartRenamingTab(tab.id)}
              onMouseDown={(event) => {
                if (event.button === 1 && task.tabs.length > 1) {
                  event.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onContextMenu={(event) =>
                contextMenu.open(event, [
                  { label: "Rename session", onClick: () => onStartRenamingTab(tab.id) },
                  {
                    label: tab.unread ? "Mark as read" : "Mark as unread",
                    onClick: () => onSetTabUnread(tab.id, !tab.unread),
                  },
                  ...(task.tabs.length > 1 ? [{ label: "Close tab", onClick: () => onCloseTab(tab.id) }] : []),
                ])
              }
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "0 14px",
                borderBottom: isActive ? "2px solid #ff4f00" : "2px solid transparent",
                cursor: "pointer",
                transition: "color 200ms ease, border-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: "#e4e4e7" },
              })}
            >
              <div
                className={css({
                  width: "14px",
                  minWidth: "14px",
                  height: "14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                })}
              >
                <TabAvatar tab={tab} />
              </div>
              {editingSessionTabId === tab.id ? (
                <input
                  autoFocus
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onBlur={onCommitSessionRename}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onCommitSessionRename();
                    } else if (event.key === "Escape") {
                      onCancelSessionRename();
                    }
                  }}
                  className={css({
                    all: "unset",
                    minWidth: "72px",
                    maxWidth: "180px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: theme.colors.contentPrimary,
                    borderBottom: "1px solid rgba(255, 255, 255, 0.3)",
                  })}
                />
              ) : (
                <LabelXSmall color={isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary} $style={{ fontWeight: 600 }}>
                  {tab.sessionName}
                </LabelXSmall>
              )}
              {task.tabs.length > 1 ? (
                <X
                  size={11}
                  color={theme.colors.contentTertiary}
                  className={css({ cursor: "pointer", opacity: 0.5, ":hover": { opacity: 1 } })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                />
              ) : null}
            </div>
          );
        })}
        {openDiffs.map((path) => {
          const tabId = diffTabId(path);
          const isActive = tabId === activeTabId;
          return (
            <div
              key={tabId}
              onClick={() => onSwitchTab(tabId)}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseDiffTab(path);
                }
              }}
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "0 14px",
                borderBottom: "2px solid transparent",
                cursor: "pointer",
                transition: "color 200ms ease, border-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: "#e4e4e7" },
              })}
            >
              <FileCode size={12} color={isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary} />
              <LabelXSmall
                color={isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary}
                $style={{ fontWeight: 600, fontFamily: '"IBM Plex Mono", monospace' }}
              >
                {fileName(path)}
              </LabelXSmall>
              <X
                size={11}
                color={theme.colors.contentTertiary}
                className={css({ cursor: "pointer", opacity: 0.5, ":hover": { opacity: 1 } })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseDiffTab(path);
                }}
              />
            </div>
          );
        })}
        <div
          onClick={onAddTab}
          className={css({
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            cursor: "pointer",
            opacity: 0.4,
            ":hover": { opacity: 0.7 },
            flexShrink: 0,
          })}
        >
          <Plus size={14} color={theme.colors.contentTertiary} />
        </div>
      </div>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </>
  );
});
