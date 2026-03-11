import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import { useStyletron } from "baseui";
import { LabelSmall } from "baseui/typography";
import { Archive, ArrowUpFromLine, ChevronRight, FileCode, FilePlus, FileX, FolderOpen, GitPullRequest } from "lucide-react";

import { type ContextMenuItem, ContextMenuOverlay, PanelHeaderBar, SPanel, ScrollBody, useContextMenu } from "./ui";
import { type FileTreeNode, type Task, diffTabId } from "./view-model";

const StatusCard = memo(function StatusCard({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const [css, theme] = useStyletron();

  return (
    <div
      className={css({
        padding: "10px 12px",
        borderRadius: "8px",
        backgroundColor: theme.colors.backgroundSecondary,
        border: `1px solid ${theme.colors.borderOpaque}`,
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      })}
    >
      <LabelSmall color={theme.colors.contentTertiary} $style={{ fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {label}
      </LabelSmall>
      <div
        className={css({
          color: theme.colors.contentPrimary,
          fontSize: "12px",
          fontWeight: 600,
          fontFamily: mono ? '"IBM Plex Mono", monospace' : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        })}
      >
        {value}
      </div>
    </div>
  );
});

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
  const [css, theme] = useStyletron();
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
                padding: "3px 10px",
                paddingLeft: `${10 + depth * 16}px`,
                cursor: "pointer",
                fontSize: "12px",
                fontFamily: '"IBM Plex Mono", monospace',
                color: isChanged ? theme.colors.contentPrimary : theme.colors.contentTertiary,
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)" },
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
                <FileCode size={13} color={isChanged ? theme.colors.contentPrimary : undefined} style={{ marginLeft: "16px" }} />
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
  activeTabId,
  onOpenDiff,
  onArchive,
  onPush,
  onRevertFile,
  onPublishPr,
}: {
  task: Task;
  activeTabId: string | null;
  onOpenDiff: (path: string) => void;
  onArchive: () => void;
  onPush: () => void;
  onRevertFile: (path: string) => void;
  onPublishPr: () => void;
}) {
  const [css, theme] = useStyletron();
  const [rightTab, setRightTab] = useState<"changes" | "files">("changes");
  const contextMenu = useContextMenu();
  const changedPaths = useMemo(() => new Set(task.fileChanges.map((file) => file.path)), [task.fileChanges]);
  const isTerminal = task.status === "archived";
  const canPush = !isTerminal && Boolean(task.branch);
  const pullRequestUrl = task.pullRequest != null ? `https://github.com/${task.repoName}/pull/${task.pullRequest.number}` : null;
  const pullRequestStatus =
    task.pullRequest == null ? "Not published" : `#${task.pullRequest.number} ${task.pullRequest.status === "draft" ? "Draft" : "Ready"}`;

  const copyFilePath = useCallback(async (path: string) => {
    try {
      if (!window.navigator.clipboard) {
        throw new Error("Clipboard API unavailable in mock layout");
      }

      await window.navigator.clipboard.writeText(path);
    } catch (error) {
      console.error("Failed to copy file path", error);
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
    <SPanel>
      <PanelHeaderBar>
        <div className={css({ flex: 1 })} />
        {!isTerminal ? (
          <div className={css({ display: "flex", alignItems: "center", gap: "4px" })}>
            <button
              onClick={() => {
                if (pullRequestUrl) {
                  window.open(pullRequestUrl, "_blank", "noopener,noreferrer");
                  return;
                }

                onPublishPr();
              }}
              className={css({
                all: "unset",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 500,
                color: "#e4e4e7",
                cursor: "pointer",
                transition: "all 200ms ease",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#ffffff" },
              })}
            >
              <GitPullRequest size={12} />
              {pullRequestUrl ? "Open PR" : "Publish PR"}
            </button>
            <button
              onClick={canPush ? onPush : undefined}
              className={css({
                all: "unset",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 500,
                color: canPush ? "#e4e4e7" : theme.colors.contentTertiary,
                cursor: canPush ? "pointer" : "not-allowed",
                opacity: canPush ? 1 : 0.5,
                transition: "all 200ms ease",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#ffffff" },
              })}
            >
              <ArrowUpFromLine size={12} /> Push
            </button>
            <button
              onClick={onArchive}
              className={css({
                all: "unset",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 500,
                color: "#e4e4e7",
                cursor: "pointer",
                transition: "all 200ms ease",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#ffffff" },
              })}
            >
              <Archive size={12} /> Archive
            </button>
          </div>
        ) : null}
      </PanelHeaderBar>

      <div
        className={css({
          display: "flex",
          alignItems: "stretch",
          borderBottom: `1px solid ${theme.colors.borderOpaque}`,
          backgroundColor: theme.colors.backgroundSecondary,
          height: "41px",
          minHeight: "41px",
          flexShrink: 0,
        })}
      >
        <button
          onClick={() => setRightTab("changes")}
          className={css({
            all: "unset",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            height: "100%",
            padding: "0 16px",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: 600,
            whiteSpace: "nowrap",
            color: rightTab === "changes" ? theme.colors.contentPrimary : theme.colors.contentSecondary,
            borderBottom: `2px solid ${rightTab === "changes" ? "#ff4f00" : "transparent"}`,
            marginBottom: "-1px",
            transitionProperty: "color, border-color",
            transitionDuration: "200ms",
            transitionTimingFunction: "ease",
            ":hover": { color: "#e4e4e7" },
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
                background: "#3f3f46",
                color: "#a1a1aa",
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
            all: "unset",
            display: "flex",
            alignItems: "center",
            height: "100%",
            padding: "0 16px",
            cursor: "pointer",
            fontSize: "12px",
            fontWeight: 600,
            whiteSpace: "nowrap",
            color: rightTab === "files" ? theme.colors.contentPrimary : theme.colors.contentSecondary,
            borderBottom: `2px solid ${rightTab === "files" ? "#ff4f00" : "transparent"}`,
            marginBottom: "-1px",
            transitionProperty: "color, border-color",
            transitionDuration: "200ms",
            transitionTimingFunction: "ease",
            ":hover": { color: "#e4e4e7" },
          })}
        >
          All Files
        </button>
      </div>

      <ScrollBody>
        <div className={css({ padding: "12px 14px 0", display: "grid", gap: "8px" })}>
          <StatusCard label="Branch" value={task.branch ?? "Not created"} mono />
          <StatusCard label="Pull Request" value={pullRequestStatus} />
        </div>
        {rightTab === "changes" ? (
          <div className={css({ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "2px" })}>
            {task.fileChanges.length === 0 ? (
              <div className={css({ padding: "20px 0", textAlign: "center" })}>
                <LabelSmall color={theme.colors.contentTertiary}>No changes yet</LabelSmall>
              </div>
            ) : null}
            {task.fileChanges.map((file) => {
              const isActive = activeTabId === diffTabId(file.path);
              const TypeIcon = file.type === "A" ? FilePlus : file.type === "D" ? FileX : FileCode;
              const iconColor = file.type === "A" ? "#7ee787" : file.type === "D" ? "#ffa198" : theme.colors.contentTertiary;
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
                    backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "transparent",
                    cursor: "pointer",
                    ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)" },
                  })}
                >
                  <TypeIcon size={14} color={iconColor} style={{ flexShrink: 0 }} />
                  <div
                    className={css({
                      flex: 1,
                      minWidth: 0,
                      fontFamily: '"IBM Plex Mono", monospace',
                      fontSize: "12px",
                      color: isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary,
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
                    <span className={css({ color: "#7ee787" })}>+{file.added}</span>
                    <span className={css({ color: "#ffa198" })}>-{file.removed}</span>
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
                <LabelSmall color={theme.colors.contentTertiary}>No files yet</LabelSmall>
              </div>
            )}
          </div>
        )}
      </ScrollBody>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </SPanel>
  );
});
