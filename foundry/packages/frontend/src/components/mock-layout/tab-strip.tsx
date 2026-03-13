import { memo } from "react";
import { useStyletron } from "baseui";
import { LabelXSmall } from "baseui/typography";
import { FileCode, Plus, SquareTerminal, X } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { ContextMenuOverlay, TabAvatar, Tooltip, useContextMenu } from "./ui";
import { diffTabId, fileName, terminalTabId, type Task } from "./view-model";

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
  terminalTabOpen,
  onCloseTerminalTab,
  sidebarCollapsed,
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
  terminalTabOpen?: boolean;
  onCloseTerminalTab?: () => void;
  sidebarCollapsed?: boolean;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const isDesktop = !!import.meta.env.VITE_DESKTOP;
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
          borderBottom: `1px solid ${t.borderDefault}`,
          gap: "4px",
          backgroundColor: t.surfacePrimary,
          paddingLeft: sidebarCollapsed ? "14px" : "6px",
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
              data-tab
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                marginTop: "6px",
                marginBottom: "6px",
                borderRadius: "8px",
                backgroundColor: isActive ? t.interactiveHover : "transparent",
                cursor: "pointer",
                transition: "color 200ms ease, background-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: t.textPrimary, backgroundColor: isActive ? t.interactiveHover : t.interactiveSubtle },
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
                    color: t.textPrimary,
                    borderBottom: `1px solid ${t.borderFocus}`,
                  })}
                />
              ) : (
                <LabelXSmall color={isActive ? t.textPrimary : t.textSecondary} $style={{ fontWeight: 500 }}>
                  {tab.sessionName}
                </LabelXSmall>
              )}
              {task.tabs.length > 1 ? (
                <X
                  size={11}
                  color={t.textTertiary}
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
                backgroundColor: isActive ? t.interactiveHover : "transparent",
                cursor: "pointer",
                transition: "color 200ms ease, background-color 200ms ease",
                flexShrink: 0,
                ":hover": { color: t.textPrimary, backgroundColor: isActive ? t.interactiveHover : t.interactiveSubtle },
              })}
            >
              <FileCode size={12} color={isActive ? t.textPrimary : t.textSecondary} />
              <LabelXSmall color={isActive ? t.textPrimary : t.textSecondary} $style={{ fontWeight: 500, fontFamily: '"IBM Plex Mono", monospace' }}>
                {fileName(path)}
              </LabelXSmall>
              <X
                size={11}
                color={t.textTertiary}
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
        {terminalTabOpen
          ? (() => {
              const tabId = terminalTabId();
              const isActive = tabId === activeTabId;
              return (
                <div
                  key={tabId}
                  onClick={() => onSwitchTab(tabId)}
                  onMouseDown={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onCloseTerminalTab?.();
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
                    backgroundColor: isActive ? t.interactiveHover : "transparent",
                    cursor: "pointer",
                    transition: "color 200ms ease, background-color 200ms ease",
                    flexShrink: 0,
                    ":hover": { color: t.textPrimary, backgroundColor: isActive ? t.interactiveHover : t.interactiveSubtle },
                  })}
                >
                  <SquareTerminal size={12} color={isActive ? t.textPrimary : t.textSecondary} />
                  <LabelXSmall color={isActive ? t.textPrimary : t.textSecondary} $style={{ fontWeight: 500 }}>
                    Terminal
                  </LabelXSmall>
                  <X
                    size={11}
                    color={t.textTertiary}
                    data-tab-close
                    className={css({ cursor: "pointer", opacity: 0 })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTerminalTab?.();
                    }}
                  />
                </div>
              );
            })()
          : null}
        <Tooltip label="New session" placement="bottom">
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
            <Plus size={14} color={t.textTertiary} />
          </div>
        </Tooltip>
      </div>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </>
  );
});
