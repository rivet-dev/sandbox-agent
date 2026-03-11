import { memo, useRef, useState } from "react";
import { useStyletron } from "baseui";
import { LabelSmall, LabelXSmall } from "baseui/typography";
import { ChevronDown, ChevronUp, CloudUpload, GitPullRequestDraft, ListChecks, Plus } from "lucide-react";

import { formatRelativeAge, type Task, type ProjectSection } from "./view-model";
import { ContextMenuOverlay, TaskIndicator, PanelHeaderBar, SPanel, ScrollBody, useContextMenu } from "./ui";

const PROJECT_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"];

function projectInitial(label: string): string {
  const parts = label.split("/");
  const name = parts[parts.length - 1] ?? label;
  return name.charAt(0).toUpperCase();
}

function projectIconColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length]!;
}

export const Sidebar = memo(function Sidebar({
  projects,
  activeId,
  onSelect,
  onCreate,
  onMarkUnread,
  onRenameTask,
  onRenameBranch,
  onReorderProjects,
}: {
  projects: ProjectSection[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMarkUnread: (id: string) => void;
  onRenameTask: (id: string) => void;
  onRenameBranch: (id: string) => void;
  onReorderProjects: (fromIndex: number, toIndex: number) => void;
}) {
  const [css, theme] = useStyletron();
  const contextMenu = useContextMenu();
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <SPanel>
      <style>{`
        [data-project-header]:hover [data-chevron] {
          display: inline-flex !important;
        }
        [data-project-header]:hover [data-project-icon] {
          display: none !important;
        }
      `}</style>
      <PanelHeaderBar $style={{ backgroundColor: "transparent", borderBottom: "none" }}>
        <LabelSmall
          color={theme.colors.contentPrimary}
          $style={{ fontWeight: 500, flex: 1, fontSize: "13px", display: "flex", alignItems: "center", gap: "6px", lineHeight: 1 }}
        >
          <ListChecks size={14} />
          Tasks
        </LabelSmall>
        <div
          role="button"
          tabIndex={0}
          onClick={onCreate}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onCreate();
          }}
          className={css({
            width: "26px",
            height: "26px",
            borderRadius: "8px",
            backgroundColor: "rgba(255, 255, 255, 0.12)",
            color: "#e4e4e7",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 200ms ease",
            flexShrink: 0,
            ":hover": { backgroundColor: "rgba(255, 255, 255, 0.20)" },
          })}
        >
          <Plus size={14} style={{ display: "block" }} />
        </div>
      </PanelHeaderBar>
      <ScrollBody>
        <div className={css({ padding: "8px", display: "flex", flexDirection: "column", gap: "4px" })}>
          {projects.map((project, projectIndex) => {
            const isCollapsed = collapsedProjects[project.id] === true;
            const isDragOver = dragOverIndex === projectIndex && dragIndexRef.current !== projectIndex;

            return (
              <div
                key={project.id}
                draggable
                onDragStart={(event) => {
                  dragIndexRef.current = projectIndex;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", String(projectIndex));
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverIndex(projectIndex);
                }}
                onDragLeave={() => {
                  setDragOverIndex((current) => (current === projectIndex ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const fromIndex = dragIndexRef.current;
                  if (fromIndex != null && fromIndex !== projectIndex) {
                    onReorderProjects(fromIndex, projectIndex);
                  }
                  dragIndexRef.current = null;
                  setDragOverIndex(null);
                }}
                onDragEnd={() => {
                  dragIndexRef.current = null;
                  setDragOverIndex(null);
                }}
                className={css({
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  borderTop: isDragOver ? "2px solid #ff4f00" : "2px solid transparent",
                  transition: "border-color 150ms ease",
                })}
              >
                <div
                  onClick={() =>
                    setCollapsedProjects((current) => ({
                      ...current,
                      [project.id]: !current[project.id],
                    }))
                  }
                  data-project-header
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 8px 4px",
                    gap: "8px",
                    cursor: "grab",
                    userSelect: "none",
                    ":hover": { opacity: 0.8 },
                  })}
                >
                  <div className={css({ display: "flex", alignItems: "center", gap: "4px", overflow: "hidden" })}>
                    <div className={css({ position: "relative", width: "14px", height: "14px", flexShrink: 0 })}>
                      <span
                        className={css({
                          position: "absolute",
                          inset: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: "3px",
                          fontSize: "9px",
                          fontWeight: 700,
                          lineHeight: 1,
                          color: "#fff",
                          backgroundColor: projectIconColor(project.label),
                        })}
                        data-project-icon
                      >
                        {projectInitial(project.label)}
                      </span>
                      <span className={css({ position: "absolute", inset: 0, display: "none", alignItems: "center", justifyContent: "center" })} data-chevron>
                        {isCollapsed ? (
                          <ChevronDown size={12} color={theme.colors.contentTertiary} />
                        ) : (
                          <ChevronUp size={12} color={theme.colors.contentTertiary} />
                        )}
                      </span>
                    </div>
                    <LabelSmall
                      color={theme.colors.contentSecondary}
                      $style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {project.label}
                    </LabelSmall>
                  </div>
                  {isCollapsed ? <LabelXSmall color={theme.colors.contentTertiary}>{formatRelativeAge(project.updatedAtMs)}</LabelXSmall> : null}
                </div>

                {!isCollapsed &&
                  project.tasks.map((task) => {
                    const isActive = task.id === activeId;
                    const isDim = task.status === "archived";
                    const isRunning = task.tabs.some((tab) => tab.status === "running");
                    const hasUnread = task.tabs.some((tab) => tab.unread);
                    const isDraft = task.pullRequest == null || task.pullRequest.status === "draft";
                    const totalAdded = task.fileChanges.reduce((sum, file) => sum + file.added, 0);
                    const totalRemoved = task.fileChanges.reduce((sum, file) => sum + file.removed, 0);
                    const hasDiffs = totalAdded > 0 || totalRemoved > 0;

                    return (
                      <div
                        key={task.id}
                        onClick={() => onSelect(task.id)}
                        onContextMenu={(event) =>
                          contextMenu.open(event, [
                            { label: "Rename task", onClick: () => onRenameTask(task.id) },
                            { label: "Rename branch", onClick: () => onRenameBranch(task.id) },
                            { label: "Mark as unread", onClick: () => onMarkUnread(task.id) },
                          ])
                        }
                        className={css({
                          padding: "8px 12px",
                          borderRadius: "8px",
                          border: "1px solid transparent",
                          backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "transparent",
                          cursor: "pointer",
                          transition: "all 200ms ease",
                          ":hover": {
                            backgroundColor: "rgba(255, 255, 255, 0.06)",
                          },
                        })}
                      >
                        <div className={css({ display: "flex", alignItems: "center", gap: "8px" })}>
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
                            <TaskIndicator isRunning={isRunning} hasUnread={hasUnread} isDraft={isDraft} />
                          </div>
                          <LabelSmall
                            $style={{
                              fontWeight: hasUnread ? 600 : 400,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              minWidth: 0,
                              flexShrink: 1,
                            }}
                            color={hasUnread ? "#ffffff" : theme.colors.contentSecondary}
                          >
                            {task.title}
                          </LabelSmall>
                          {task.pullRequest != null ? (
                            <span className={css({ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0 })}>
                              <LabelXSmall color={theme.colors.contentSecondary} $style={{ fontWeight: 600 }}>
                                #{task.pullRequest.number}
                              </LabelXSmall>
                              {task.pullRequest.status === "draft" ? <CloudUpload size={11} color="#ff4f00" /> : null}
                            </span>
                          ) : (
                            <GitPullRequestDraft size={11} color={theme.colors.contentTertiary} />
                          )}
                          {hasDiffs ? (
                            <div className={css({ display: "flex", gap: "4px", flexShrink: 0, marginLeft: "auto" })}>
                              <span className={css({ fontSize: "11px", color: "#7ee787" })}>+{totalAdded}</span>
                              <span className={css({ fontSize: "11px", color: "#ffa198" })}>-{totalRemoved}</span>
                            </div>
                          ) : null}
                          <LabelXSmall color={theme.colors.contentTertiary} $style={{ flexShrink: 0, marginLeft: hasDiffs ? undefined : "auto" }}>
                            {formatRelativeAge(task.updatedAtMs)}
                          </LabelXSmall>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </ScrollBody>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </SPanel>
  );
});
