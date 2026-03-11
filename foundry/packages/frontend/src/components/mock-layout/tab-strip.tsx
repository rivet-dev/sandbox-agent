import { memo } from "react";
import { useStyletron } from "baseui";
import { LabelXSmall } from "baseui/typography";
import { FileCode, Plus, X } from "lucide-react";

import { ContextMenuOverlay, TabAvatar, useContextMenu } from "./ui";
import { diffTabId, fileName, type Handoff } from "./view-model";

export const TabStrip = memo(function TabStrip({
  handoff,
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
  handoff: Handoff;
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
      <style>{`
        [data-tab]:hover [data-tab-close] { opacity: 0.5 !important; }
        [data-tab]:hover [data-tab-close]:hover { opacity: 1 !important; }
      `}</style>
      <div
        className={css({
          display: "flex",
          alignItems: "stretch",
          borderBottom: `1px solid ${theme.colors.borderOpaque}`,
          gap: "4px",
          backgroundColor: "#09090b",
          paddingLeft: "6px",
          height: "41px",
          minHeight: "41px",
          overflowX: "auto",
          scrollbarWidth: "none",
          flexShrink: 0,
          "::-webkit-scrollbar": { display: "none" },
        })}
      >
        {handoff.tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => onSwitchTab(tab.id)}
              onDoubleClick={() => onStartRenamingTab(tab.id)}
              onMouseDown={(event) => {
                if (event.button === 1 && handoff.tabs.length > 1) {
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
                  ...(handoff.tabs.length > 1 ? [{ label: "Close tab", onClick: () => onCloseTab(tab.id) }] : []),
                ])
              }
              data-tab
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                marginTop: "6px",
                marginBottom: "6px",
                borderRadius: "8px",
                backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "transparent",
                cursor: "pointer",
                transition: "color 200ms ease, background-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: "#e4e4e7", backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.04)" },
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
                    appearance: "none",
                    WebkitAppearance: "none",
                    background: "none",
                    border: "none",
                    padding: "0",
                    margin: "0",
                    outline: "none",
                    minWidth: "72px",
                    maxWidth: "180px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: theme.colors.contentPrimary,
                    borderBottom: "1px solid rgba(255, 255, 255, 0.3)",
                  })}
                />
              ) : (
                <LabelXSmall color={isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary} $style={{ fontWeight: 500 }}>
                  {tab.sessionName}
                </LabelXSmall>
              )}
              {handoff.tabs.length > 1 ? (
                <X
                  size={11}
                  color={theme.colors.contentTertiary}
                  data-tab-close
                  className={css({ cursor: "pointer", opacity: 0 })}
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
              data-tab
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                marginTop: "6px",
                marginBottom: "6px",
                borderRadius: "8px",
                backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "transparent",
                cursor: "pointer",
                transition: "color 200ms ease, background-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: "#e4e4e7", backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.04)" },
              })}
            >
              <FileCode size={12} color={isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary} />
              <LabelXSmall
                color={isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary}
                $style={{ fontWeight: 500, fontFamily: '"IBM Plex Mono", monospace' }}
              >
                {fileName(path)}
              </LabelXSmall>
              <X
                size={11}
                color={theme.colors.contentTertiary}
                data-tab-close
                className={css({ cursor: "pointer", opacity: 0 })}
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
            lineHeight: 0,
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
