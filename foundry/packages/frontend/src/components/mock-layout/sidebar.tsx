import { memo, useState } from "react";
import { useStyletron } from "baseui";
import { LabelSmall, LabelXSmall } from "baseui/typography";
import { CloudUpload, GitPullRequestDraft, Plus } from "lucide-react";

import { SidebarSkeleton } from "./skeleton";
import { formatRelativeAge, type Task, type RepoSection } from "./view-model";
import { ContextMenuOverlay, TaskIndicator, PanelHeaderBar, SPanel, ScrollBody, useContextMenu } from "./ui";

export const Sidebar = memo(function Sidebar({
  workspaceId,
  repoCount,
  repos,
  activeId,
  title,
  subtitle,
  actions,
  onSelect,
  onCreate,
  onMarkUnread,
  onRenameTask,
  onRenameBranch,
}: {
  workspaceId: string;
  repoCount: number;
  repos: RepoSection[];
  activeId: string;
  title?: string;
  subtitle?: string;
  actions?: Array<{
    label: string;
    onClick: () => void;
  }>;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMarkUnread: (id: string) => void;
  onRenameTask: (id: string) => void;
  onRenameBranch: (id: string) => void;
}) {
  const [css, theme] = useStyletron();
  const contextMenu = useContextMenu();
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});

  return (
    <SPanel>
      <PanelHeaderBar>
        <div className={css({ flex: 1, minWidth: 0 })}>
          <LabelSmall color={theme.colors.contentPrimary} $style={{ fontWeight: 600, fontSize: "13px" }}>
            {title ?? workspaceId}
          </LabelSmall>
          <LabelXSmall color={theme.colors.contentTertiary}>{subtitle ?? `${repoCount} ${repoCount === 1 ? "repo" : "repos"}`}</LabelXSmall>
        </div>
        <button
          onClick={onCreate}
          aria-label="Create task"
          className={css({
            all: "unset",
            width: "24px",
            height: "24px",
            borderRadius: "4px",
            backgroundColor: "#ff4f00",
            color: "#ffffff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 200ms ease",
            ":hover": { backgroundColor: "#ff6a00" },
          })}
        >
          <Plus size={14} />
        </button>
      </PanelHeaderBar>
      {actions && actions.length > 0 ? (
        <div
          className={css({
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            padding: "10px 14px 0",
            borderBottom: `1px solid ${theme.colors.borderOpaque}`,
            backgroundColor: theme.colors.backgroundTertiary,
          })}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className={css({
                border: `1px solid ${theme.colors.borderOpaque}`,
                borderRadius: "999px",
                backgroundColor: "rgba(255, 255, 255, 0.04)",
                color: theme.colors.contentPrimary,
                cursor: "pointer",
                padding: "6px 10px",
                fontSize: "12px",
                fontWeight: 600,
                marginBottom: "10px",
                ":hover": { backgroundColor: "rgba(255, 255, 255, 0.08)" },
              })}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      <ScrollBody>
        {repos.length === 0 && repoCount === 0 ? (
          <SidebarSkeleton />
        ) : repos.length === 0 ? (
          <div className={css({ padding: "16px", textAlign: "center", opacity: 0.5, fontSize: "13px" })}>No tasks yet</div>
        ) : (
          <div className={css({ padding: "8px", display: "flex", flexDirection: "column", gap: "4px" })}>
            {repos.map((repo) => {
              const visibleCount = expandedRepos[repo.id] ? repo.tasks.length : Math.min(repo.tasks.length, 5);
              const hiddenCount = Math.max(0, repo.tasks.length - visibleCount);

              return (
                <div key={repo.id} className={css({ display: "flex", flexDirection: "column", gap: "4px" })}>
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 8px 4px",
                      gap: "8px",
                    })}
                  >
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
                      {repo.label}
                    </LabelSmall>
                    <LabelXSmall color={theme.colors.contentTertiary}>{repo.updatedAtMs > 0 ? formatRelativeAge(repo.updatedAtMs) : "No tasks"}</LabelXSmall>
                  </div>

                  {repo.tasks.length === 0 ? (
                    <div
                      className={css({
                        padding: "0 12px 10px 34px",
                        color: theme.colors.contentTertiary,
                        fontSize: "12px",
                      })}
                    >
                      No tasks yet
                    </div>
                  ) : null}

                  {repo.tasks.slice(0, visibleCount).map((task) => {
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
                          padding: "12px",
                          borderRadius: "8px",
                          border: isActive ? "1px solid rgba(255, 255, 255, 0.2)" : "1px solid transparent",
                          backgroundColor: isActive ? "rgba(255, 255, 255, 0.06)" : "transparent",
                          cursor: "pointer",
                          transition: "all 200ms ease",
                          ":hover": {
                            backgroundColor: "rgba(255, 255, 255, 0.06)",
                            borderColor: theme.colors.borderOpaque,
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
                              fontWeight: 600,
                              flex: 1,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            color={isDim ? theme.colors.contentSecondary : theme.colors.contentPrimary}
                          >
                            {task.title}
                          </LabelSmall>
                          {hasDiffs ? (
                            <div className={css({ display: "flex", gap: "4px", flexShrink: 0 })}>
                              <span className={css({ fontSize: "11px", color: "#7ee787" })}>+{totalAdded}</span>
                              <span className={css({ fontSize: "11px", color: "#ffa198" })}>-{totalRemoved}</span>
                            </div>
                          ) : null}
                        </div>
                        <div className={css({ display: "flex", alignItems: "center", marginTop: "4px", gap: "6px" })}>
                          <LabelXSmall
                            color={theme.colors.contentTertiary}
                            $style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flexShrink: 1,
                            }}
                          >
                            {task.repoName}
                          </LabelXSmall>
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
                          <LabelXSmall color={theme.colors.contentTertiary} $style={{ marginLeft: "auto", flexShrink: 0 }}>
                            {formatRelativeAge(task.updatedAtMs)}
                          </LabelXSmall>
                        </div>
                      </div>
                    );
                  })}

                  {hiddenCount > 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRepos((current) => ({
                          ...current,
                          [repo.id]: true,
                        }))
                      }
                      className={css({
                        all: "unset",
                        padding: "8px 12px 10px 34px",
                        color: theme.colors.contentSecondary,
                        fontSize: "12px",
                        cursor: "pointer",
                        ":hover": { color: theme.colors.contentPrimary },
                      })}
                    >
                      Show {hiddenCount} more
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </ScrollBody>
      {contextMenu.menu ? <ContextMenuOverlay menu={contextMenu.menu} onClose={contextMenu.close} /> : null}
    </SPanel>
  );
});
