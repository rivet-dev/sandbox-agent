import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import { useStyletron } from "baseui";
import { LabelSmall } from "baseui/typography";
import { Archive, ArrowUpFromLine, ChevronRight, FileCode, FilePlus, FileX, FolderOpen, GitPullRequest, PanelRight } from "lucide-react";

import { useFoundryTokens } from "../../app/theme";
import { createErrorContext } from "@sandbox-agent/foundry-shared";
import { logger } from "../../logging.js";
import { type ContextMenuItem, ContextMenuOverlay, PanelHeaderBar, SPanel, ScrollBody, useContextMenu } from "./ui";
import { type FileTreeNode, type Task, diffTabId } from "./view-model";

const FileTree = memo(function FileTree({
  nodes,
  depth,
  onSelectFile,
  onFileContextMenu,
  changedPaths,
}: {
  nodes: FileTreeNode[];
  depth: number;
  onSelectFile: (path: string) => void;
  onFileContextMenu: (event: MouseEvent, path: string) => void;
  changedPaths: Set<string>;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.path);
        const isChanged = changedPaths.has(node.path);
        return (
          <div key={node.path}>
            <div
              onClick={() => {
                if (node.isDir) {
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(node.path)) {
                      next.delete(node.path);
                    } else {
                      next.add(node.path);
                    }
                    return next;
                  });
                  return;
                }

                onSelectFile(node.path);
              }}
              onContextMenu={node.isDir ? undefined : (event) => onFileContextMenu(event, node.path)}
              className={css({
                display: "flex",
                alignItems: "center",
                gap: "4px",
                paddingTop: "3px",
                paddingRight: "10px",
                paddingBottom: "3px",
                paddingLeft: `${10 + depth * 16}px`,
                cursor: "pointer",
                fontSize: "12px",
                fontFamily: '"IBM Plex Mono", monospace',
                color: isChanged ? t.textPrimary : t.textTertiary,
                ":hover": { backgroundColor: t.interactiveHover },
              })}
            >
              {node.isDir ? (
                <>
                  <ChevronRight
                    size={12}
                    className={css({
                      transform: isCollapsed ? undefined : "rotate(90deg)",
                      transition: "transform 0.1s",
                    })}
                  />
                  <FolderOpen size={13} />
                </>
              ) : (
                <FileCode size={13} color={isChanged ? t.textPrimary : undefined} style={{ marginLeft: "16px" }} />
              )}
              <span>{node.name}</span>
            </div>
            {node.isDir && !isCollapsed && node.children ? (
              <FileTree nodes={node.children} depth={depth + 1} onSelectFile={onSelectFile} onFileContextMenu={onFileContextMenu} changedPaths={changedPaths} />
            ) : null}
          </div>
        );
      })}
    </>
  );
});

export const RightSidebar = memo(function RightSidebar({
  task,
  activeSessionId,
  onOpenDiff,
  onArchive,
  onRevertFile,
  onPublishPr,
  onToggleSidebar,
}: {
  task: Task;
  activeSessionId: string | null;
  onOpenDiff: (path: string) => void;
  onArchive: () => void;
  onRevertFile: (path: string) => void;
  onPublishPr: () => void;
  onToggleSidebar?: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [rightTab, setRightTab] = useState<"changes" | "files">("changes");
  const contextMenu = useContextMenu();
  const changedPaths = useMemo(() => new Set(task.fileChanges.map((file) => file.path)), [task.fileChanges]);
  const isTerminal = task.status === "archived";
  const [compact, setCompact] = useState(false);
  const headerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < 400);
      }
    });
    observer.observe(node);
  }, []);
  const pullRequestUrl = task.pullRequest != null ? `https://github.com/${task.repoName}/pull/${task.pullRequest.number}` : null;

  const copyFilePath = useCallback(async (path: string) => {
    try {
      if (!window.navigator.clipboard) {
        throw new Error("Clipboard API unavailable in mock layout");
      }

      await window.navigator.clipboard.writeText(path);
    } catch (error) {
      logger.error(
        {
          path,
          ...createErrorContext(error),
        },
        "failed_to_copy_file_path",
      );
    }
  }, []);

  const openFileMenu = useCallback(
    (event: MouseEvent, path: string) => {
      const items: ContextMenuItem[] = [];

      if (changedPaths.has(path)) {
        items.push({ label: "Revert", onClick: () => onRevertFile(path) });
      }

      items.push({ label: "Copy Path", onClick: () => void copyFilePath(path) });
      contextMenu.open(event, items);
    },
    [changedPaths, contextMenu, copyFilePath, onRevertFile],
  );

  return (
    <SPanel $style={{ backgroundColor: t.surfacePrimary, minWidth: 0 }}>
      <PanelHeaderBar $style={{ backgroundColor: t.surfaceSecondary, borderBottom: "none", overflow: "hidden" }}>
        <div ref={headerRef} className={css({ display: "flex", alignItems: "center", flex: 1, minWidth: 0, justifyContent: "flex-end", gap: "2px" })}>
          {!isTerminal ? (
            <div className={css({ display: "flex", alignItems: "center", gap: "2px", flexShrink: 1, minWidth: 0 })}>
              <button
                onClick={() => {
                  if (pullRequestUrl) {
                    window.open(pullRequestUrl, "_blank", "noopener,noreferrer");
                    return;
                  }

                  onPublishPr();
                }}
                className={css({
                  appearance: "none",
                  WebkitAppearance: "none",
                  backgroundColor: "transparent",
                  border: "none",
                  margin: "0",
                  boxSizing: "border-box",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: compact ? "4px 6px" : "4px 10px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  fontWeight: 500,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  color: t.textSecondary,
                  cursor: "pointer",
                  transition: "all 200ms ease",
                  ":hover": { backgroundColor: t.interactiveHover, color: t.textPrimary },
                })}
              >
                <GitPullRequest size={12} style={{ flexShrink: 0 }} />
                {!compact && <span>{pullRequestUrl ? "Open PR" : "Publish PR"}</span>}
              </button>
              <button
                className={css({
                  appearance: "none",
                  WebkitAppearance: "none",
                  backgroundColor: "transparent",
                  border: "none",
                  margin: "0",
                  boxSizing: "border-box",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: compact ? "4px 6px" : "4px 10px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  fontWeight: 500,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  color: t.textSecondary,
                  cursor: "pointer",
                  transition: "all 200ms ease",
                  ":hover": { backgroundColor: t.interactiveHover, color: t.textPrimary },
                })}
              >
                <ArrowUpFromLine size={12} style={{ flexShrink: 0 }} />
                {!compact && <span>Push</span>}
              </button>
              <button
                onClick={onArchive}
                className={css({
                  appearance: "none",
                  WebkitAppearance: "none",
                  backgroundColor: "transparent",
                  border: "none",
                  margin: "0",
                  boxSizing: "border-box",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: compact ? "4px 6px" : "4px 10px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  fontWeight: 500,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  color: t.textSecondary,
                  cursor: "pointer",
                  transition: "all 200ms ease",
                  ":hover": { backgroundColor: t.interactiveHover, color: t.textPrimary },
                })}
              >
                <Archive size={12} style={{ flexShrink: 0 }} />
                {!compact && <span>Archive</span>}
              </button>
            </div>
          ) : null}
          {onToggleSidebar ? (
            <div
              role="button"
              tabIndex={0}
              onClick={onToggleSidebar}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onToggleSidebar();
              }}
              className={css({
                width: "26px",
                height: "26px",
                borderRadius: "6px",
                color: t.textTertiary,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
              })}
            >
              <PanelRight size={14} />
            </div>
          ) : null}
        </div>
      </PanelHeaderBar>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          borderTop: `1px solid ${t.borderDefault}`,
          borderRight: `1px solid ${t.borderDefault}`,
          borderTopRightRadius: "12px",
          overflow: "hidden",
        }}
      >
        <div
          className={css({
            display: "flex",
            alignItems: "stretch",
            gap: "4px",
            borderBottom: `1px solid ${t.borderDefault}`,
            backgroundColor: t.surfacePrimary,
            height: "41px",
            minHeight: "41px",
            flexShrink: 0,
            borderTopRightRadius: "12px",
          })}
        >
          <button
            onClick={() => setRightTab("changes")}
            className={css({
              appearance: "none",
              WebkitAppearance: "none",
              border: "none",
              marginTop: "6px",
              marginRight: "0",
              marginBottom: "6px",
              marginLeft: "6px",
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 12px",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1,
              whiteSpace: "nowrap",
              color: rightTab === "changes" ? t.textPrimary : t.textSecondary,
              backgroundColor: rightTab === "changes" ? t.interactiveHover : "transparent",
              transitionProperty: "color, background-color",
              transitionDuration: "200ms",
              transitionTimingFunction: "ease",
              ":hover": { color: t.textPrimary, backgroundColor: rightTab === "changes" ? t.interactiveHover : t.interactiveSubtle },
            })}
          >
            Changes
            {task.fileChanges.length > 0 ? (
              <span
                className={css({
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: "16px",
                  height: "16px",
                  padding: "0 5px",
                  background: t.surfaceElevated,
                  color: t.textSecondary,
                  fontSize: "9px",
                  fontWeight: 700,
                  borderRadius: "8px",
                })}
              >
                {task.fileChanges.length}
              </span>
            ) : null}
          </button>
          <button
            onClick={() => setRightTab("files")}
            className={css({
              appearance: "none",
              WebkitAppearance: "none",
              border: "none",
              marginTop: "6px",
              marginRight: "0",
              marginBottom: "6px",
              marginLeft: "0",
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 12px",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1,
              whiteSpace: "nowrap",
              color: rightTab === "files" ? t.textPrimary : t.textSecondary,
              backgroundColor: rightTab === "files" ? t.interactiveHover : "transparent",
              transitionProperty: "color, background-color",
              transitionDuration: "200ms",
              transitionTimingFunction: "ease",
              ":hover": { color: t.textPrimary, backgroundColor: rightTab === "files" ? t.interactiveHover : t.interactiveSubtle },
            })}
          >
            All Files
          </button>
        </div>

        <ScrollBody>
          {rightTab === "changes" ? (
            <div className={css({ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "2px" })}>
              {task.fileChanges.length === 0 ? (
                <div className={css({ padding: "20px 0", textAlign: "center" })}>
                  <LabelSmall color={t.textTertiary}>No changes yet</LabelSmall>
                </div>
              ) : null}
              {task.fileChanges.map((file) => {
                const isActive = activeSessionId === diffTabId(file.path);
                const TypeIcon = file.type === "A" ? FilePlus : file.type === "D" ? FileX : FileCode;
                const iconColor = file.type === "A" ? t.statusSuccess : file.type === "D" ? t.statusError : t.textTertiary;
                return (
                  <div
                    key={file.path}
                    onClick={() => onOpenDiff(file.path)}
                    onContextMenu={(event) => openFileMenu(event, file.path)}
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "6px 10px",
                      borderRadius: "6px",
                      backgroundColor: isActive ? t.interactiveHover : "transparent",
                      cursor: "pointer",
                      ":hover": { backgroundColor: t.interactiveHover },
                    })}
                  >
                    <TypeIcon size={14} color={iconColor} style={{ flexShrink: 0 }} />
                    <div
                      className={css({
                        flex: 1,
                        minWidth: 0,
                        fontFamily: '"IBM Plex Mono", monospace',
                        fontSize: "12px",
                        color: isActive ? t.textPrimary : t.textSecondary,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      })}
                    >
                      {file.path}
                    </div>
                    <div
                      className={css({
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        flexShrink: 0,
                        fontSize: "11px",
                        fontFamily: '"IBM Plex Mono", monospace',
                      })}
                    >
                      <span className={css({ color: t.statusSuccess })}>+{file.added}</span>
                      <span className={css({ color: t.statusError })}>-{file.removed}</span>
                      <span className={css({ color: iconColor, fontWeight: 600, width: "10px", textAlign: "center" })}>{file.type}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={css({ padding: "6px 0" })}>
              {task.fileTree.length > 0 ? (
                <FileTree nodes={task.fileTree} depth={0} onSelectFile={onOpenDiff} onFileContextMenu={openFileMenu} changedPaths={changedPaths} />
              ) : (
                <div className={css({ padding: "20px 0", textAlign: "center" })}>
                  <LabelSmall color={t.textTertiary}>No files yet</LabelSmall>
                </div>
              )}
            </div>
          )}
        </ScrollBody>
      </div>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </SPanel>
  );
});
