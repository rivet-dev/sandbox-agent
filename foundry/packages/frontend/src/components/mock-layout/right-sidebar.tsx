import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import { useStyletron } from "baseui";
import { LabelSmall } from "baseui/typography";
import { Archive, ArrowUpFromLine, ChevronRight, FileCode, FilePlus, FileX, FolderOpen, GitPullRequest } from "lucide-react";

import { type ContextMenuItem, ContextMenuOverlay, PanelHeaderBar, SPanel, ScrollBody, useContextMenu } from "./ui";
import { type FileTreeNode, type Handoff, diffTabId } from "./view-model";

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
  handoff,
  activeTabId,
  onOpenDiff,
  onArchive,
  onRevertFile,
  onPublishPr,
}: {
  handoff: Handoff;
  activeTabId: string | null;
  onOpenDiff: (path: string) => void;
  onArchive: () => void;
  onRevertFile: (path: string) => void;
  onPublishPr: () => void;
}) {
  const [css, theme] = useStyletron();
  const [rightTab, setRightTab] = useState<"changes" | "files">("changes");
  const contextMenu = useContextMenu();
  const changedPaths = useMemo(() => new Set(handoff.fileChanges.map((file) => file.path)), [handoff.fileChanges]);
  const isTerminal = handoff.status === "archived";
  const pullRequestUrl = handoff.pullRequest != null ? `https://github.com/${handoff.repoName}/pull/${handoff.pullRequest.number}` : null;

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
    <SPanel $style={{ backgroundColor: "#09090b" }}>
      <PanelHeaderBar $style={{ backgroundColor: "#0f0f11", borderBottom: "none" }}>
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
                appearance: "none",
                WebkitAppearance: "none",
                background: "none",
                border: "none",
                margin: "0",
                boxSizing: "border-box",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 500,
                lineHeight: 1,
                color: "#e4e4e7",
                cursor: "pointer",
                transition: "all 200ms ease",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#ffffff" },
              })}
            >
              <GitPullRequest size={12} style={{ flexShrink: 0 }} />
              {pullRequestUrl ? "Open PR" : "Publish PR"}
            </button>
            <button
              className={css({
                appearance: "none",
                WebkitAppearance: "none",
                background: "none",
                border: "none",
                margin: "0",
                boxSizing: "border-box",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 500,
                lineHeight: 1,
                color: "#e4e4e7",
                cursor: "pointer",
                transition: "all 200ms ease",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#ffffff" },
              })}
            >
              <ArrowUpFromLine size={12} style={{ flexShrink: 0 }} /> Push
            </button>
            <button
              onClick={onArchive}
              className={css({
                appearance: "none",
                WebkitAppearance: "none",
                background: "none",
                border: "none",
                margin: "0",
                boxSizing: "border-box",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                fontWeight: 500,
                lineHeight: 1,
                color: "#e4e4e7",
                cursor: "pointer",
                transition: "all 200ms ease",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#ffffff" },
              })}
            >
              <Archive size={12} style={{ flexShrink: 0 }} /> Archive
            </button>
          </div>
        ) : null}
      </PanelHeaderBar>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", borderTop: "1px solid rgba(255, 255, 255, 0.10)" }}>
        <div
          className={css({
            display: "flex",
            alignItems: "stretch",
            gap: "4px",
            borderBottom: `1px solid ${theme.colors.borderOpaque}`,
            backgroundColor: "#09090b",
            height: "41px",
            minHeight: "41px",
            flexShrink: 0,
          })}
        >
          <button
            onClick={() => setRightTab("changes")}
            className={css({
              appearance: "none",
              WebkitAppearance: "none",
              background: "none",
              border: "none",
              margin: "0",
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 12px",
              marginTop: "6px",
              marginBottom: "6px",
              marginLeft: "6px",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1,
              whiteSpace: "nowrap",
              color: rightTab === "changes" ? theme.colors.contentPrimary : theme.colors.contentSecondary,
              backgroundColor: rightTab === "changes" ? "rgba(255, 255, 255, 0.06)" : "transparent",
              transitionProperty: "color, background-color",
              transitionDuration: "200ms",
              transitionTimingFunction: "ease",
              ":hover": { color: "#e4e4e7", backgroundColor: rightTab === "changes" ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.04)" },
            })}
          >
            Changes
            {handoff.fileChanges.length > 0 ? (
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
                {handoff.fileChanges.length}
              </span>
            ) : null}
          </button>
          <button
            onClick={() => setRightTab("files")}
            className={css({
              appearance: "none",
              WebkitAppearance: "none",
              background: "none",
              border: "none",
              margin: "0",
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 12px",
              marginTop: "6px",
              marginBottom: "6px",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1,
              whiteSpace: "nowrap",
              color: rightTab === "files" ? theme.colors.contentPrimary : theme.colors.contentSecondary,
              backgroundColor: rightTab === "files" ? "rgba(255, 255, 255, 0.06)" : "transparent",
              transitionProperty: "color, background-color",
              transitionDuration: "200ms",
              transitionTimingFunction: "ease",
              ":hover": { color: "#e4e4e7", backgroundColor: rightTab === "files" ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.04)" },
            })}
          >
            All Files
          </button>
        </div>

        <ScrollBody>
          {rightTab === "changes" ? (
            <div className={css({ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "2px" })}>
              {handoff.fileChanges.length === 0 ? (
                <div className={css({ padding: "20px 0", textAlign: "center" })}>
                  <LabelSmall color={theme.colors.contentTertiary}>No changes yet</LabelSmall>
                </div>
              ) : null}
              {handoff.fileChanges.map((file) => {
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
              {handoff.fileTree.length > 0 ? (
                <FileTree nodes={handoff.fileTree} depth={0} onSelectFile={onOpenDiff} onFileContextMenu={openFileMenu} changedPaths={changedPaths} />
              ) : (
                <div className={css({ padding: "20px 0", textAlign: "center" })}>
                  <LabelSmall color={theme.colors.contentTertiary}>No files yet</LabelSmall>
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
