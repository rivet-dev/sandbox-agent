import { memo, useCallback, useRef, useState } from "react";
import { useStyletron } from "baseui";
import { FileText, List, MessageSquare, Settings, Terminal as TerminalIcon } from "lucide-react";
import { useFoundryTokens } from "../../app/theme";

import type { WorkbenchProjectSection, WorkbenchRepo } from "@sandbox-agent/foundry-shared";
import { RightSidebar } from "./right-sidebar";
import { Sidebar } from "./sidebar";
import { TerminalPane, type ProcessTab } from "./terminal-pane";
import type { Task } from "./view-model";

type MobileView = "tasks" | "chat" | "changes" | "terminal";
const VIEW_ORDER: MobileView[] = ["tasks", "chat", "changes", "terminal"];

const SWIPE_THRESHOLD = 50;
const SWIPE_MAX_VERTICAL = 80;

interface MobileLayoutProps {
  workspaceId: string;
  task: Task;
  tasks: Task[];
  projects: WorkbenchProjectSection[];
  repos: WorkbenchRepo[];
  selectedNewTaskRepoId: string;
  onSelectNewTaskRepo: (id: string) => void;
  onSelectTask: (id: string) => void;
  onCreateTask: (repoId?: string) => void;
  onMarkUnread: (id: string) => void;
  onRenameTask: (id: string) => void;
  onRenameBranch: (id: string) => void;
  onReorderProjects: (from: number, to: number) => void;
  taskOrderByProject: Record<string, string[]>;
  onReorderTasks: (projectId: string, from: number, to: number) => void;
  // Transcript panel (rendered by parent)
  transcriptPanel: React.ReactNode;
  // Diff/file actions
  onOpenDiff: (path: string) => void;
  onArchive: () => void;
  onRevertFile: (path: string) => void;
  onPublishPr: () => void;
  // Tab state
  activeTabId: string | null;
  // Terminal state
  terminalProcessTabs: ProcessTab[];
  onTerminalProcessTabsChange: (tabs: ProcessTab[]) => void;
  terminalActiveTabId: string | null;
  onTerminalActiveTabIdChange: (id: string | null) => void;
  terminalCustomNames: Record<string, string>;
  onTerminalCustomNamesChange: (names: Record<string, string>) => void;
  onOpenSettings?: () => void;
}

export const MobileLayout = memo(function MobileLayout(props: MobileLayoutProps) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const [activeView, setActiveView] = useState<MobileView>("tasks");

  // Swipe gesture tracking
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (touch) {
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    }
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchStartRef.current;
      const touch = e.changedTouches[0];
      if (!start || !touch) return;
      touchStartRef.current = null;

      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > SWIPE_MAX_VERTICAL) return;

      const currentIndex = VIEW_ORDER.indexOf(activeView);
      if (dx > 0 && currentIndex > 0) {
        // Swipe right -> go back
        setActiveView(VIEW_ORDER[currentIndex - 1]!);
      } else if (dx < 0 && currentIndex < VIEW_ORDER.length - 1) {
        // Swipe left -> go forward
        setActiveView(VIEW_ORDER[currentIndex + 1]!);
      }
    },
    [activeView],
  );

  const handleSelectTask = useCallback(
    (id: string) => {
      props.onSelectTask(id);
      setActiveView("chat");
    },
    [props.onSelectTask],
  );

  return (
    <div
      className={css({
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        backgroundColor: t.surfacePrimary,
        paddingTop: "max(var(--safe-area-top), 47px)",
        overflow: "hidden",
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      })}
    >
      {/* Header - show task info when not on tasks view */}
      {activeView !== "tasks" && <MobileHeader task={props.task} />}

      {/* Content area */}
      <div
        className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" })}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {activeView === "tasks" ? (
          <div className={css({ flex: 1, minHeight: 0, overflow: "auto" })}>
            <Sidebar
              projects={props.projects}
              newTaskRepos={props.repos}
              selectedNewTaskRepoId={props.selectedNewTaskRepoId}
              activeId={props.task.id}
              onSelect={handleSelectTask}
              onCreate={props.onCreateTask}
              onSelectNewTaskRepo={props.onSelectNewTaskRepo}
              onMarkUnread={props.onMarkUnread}
              onRenameTask={props.onRenameTask}
              onRenameBranch={props.onRenameBranch}
              onReorderProjects={props.onReorderProjects}
              taskOrderByProject={props.taskOrderByProject}
              onReorderTasks={props.onReorderTasks}
              onToggleSidebar={undefined}
              hideSettings
              panelStyle={{ backgroundColor: t.surfacePrimary }}
            />
          </div>
        ) : activeView === "chat" ? (
          <div className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" })}>{props.transcriptPanel}</div>
        ) : activeView === "changes" ? (
          <div className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" })}>
            <RightSidebar
              task={props.task}
              activeTabId={props.activeTabId}
              onOpenDiff={props.onOpenDiff}
              onArchive={props.onArchive}
              onRevertFile={props.onRevertFile}
              onPublishPr={props.onPublishPr}
              mobile
            />
          </div>
        ) : (
          <div className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" })}>
            <TerminalPane
              workspaceId={props.workspaceId}
              taskId={props.task.id}
              hideHeader
              processTabs={props.terminalProcessTabs}
              onProcessTabsChange={props.onTerminalProcessTabsChange}
              activeProcessTabId={props.terminalActiveTabId}
              onActiveProcessTabIdChange={props.onTerminalActiveTabIdChange}
              customTabNames={props.terminalCustomNames}
              onCustomTabNamesChange={props.onTerminalCustomNamesChange}
            />
          </div>
        )}
      </div>

      {/* Bottom tab bar - always fixed at bottom */}
      <MobileTabBar
        activeView={activeView}
        onViewChange={setActiveView}
        changesCount={Object.keys(props.task.diffs).length}
        onOpenSettings={props.onOpenSettings}
      />
    </div>
  );
});

function MobileHeader({ task }: { task: Task }) {
  const [css] = useStyletron();
  const t = useFoundryTokens();

  return (
    <div
      className={css({
        display: "flex",
        alignItems: "center",
        padding: "6px 12px",
        gap: "8px",
        flexShrink: 0,
        borderBottom: `1px solid ${t.borderDefault}`,
        minHeight: "40px",
      })}
    >
      <div className={css({ flex: 1, minWidth: 0, overflow: "hidden" })}>
        <div
          className={css({
            fontSize: "14px",
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          })}
        >
          {task.title}
        </div>
        <div
          className={css({
            fontSize: "11px",
            color: t.textTertiary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          })}
        >
          {task.repoName}
        </div>
      </div>
    </div>
  );
}

function MobileTabBar({
  activeView,
  onViewChange,
  changesCount,
  onOpenSettings,
}: {
  activeView: MobileView;
  onViewChange: (view: MobileView) => void;
  changesCount: number;
  onOpenSettings?: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();

  const tabs: { id: MobileView; icon: React.ReactNode; badge?: number }[] = [
    { id: "tasks", icon: <List size={20} /> },
    { id: "chat", icon: <MessageSquare size={20} /> },
    { id: "changes", icon: <FileText size={20} />, badge: changesCount > 0 ? changesCount : undefined },
    { id: "terminal", icon: <TerminalIcon size={20} /> },
  ];

  const iconButtonClass = css({
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "42px",
    height: "42px",
    borderRadius: "12px",
    cursor: "pointer",
    position: "relative",
    transition: "background 150ms ease, color 150ms ease",
  });

  return (
    <div
      className={css({
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "8px 16px",
        paddingBottom: "calc(8px + var(--safe-area-bottom))",
        flexShrink: 0,
      })}
    >
      {/* Pill container */}
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "4px",
          backgroundColor: t.surfaceElevated,
          borderRadius: "16px",
          padding: "4px",
        })}
      >
        {tabs.map((tab) => {
          const isActive = activeView === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onViewChange(tab.id)}
              className={iconButtonClass}
              style={{
                background: isActive ? t.interactiveHover : "transparent",
                color: isActive ? t.textPrimary : t.textTertiary,
              }}
            >
              <div className={css({ position: "relative", display: "flex" })}>
                {tab.icon}
                {tab.badge ? (
                  <div
                    className={css({
                      position: "absolute",
                      top: "-4px",
                      right: "-8px",
                      backgroundColor: t.accent,
                      color: "#fff",
                      fontSize: "10px",
                      fontWeight: 700,
                      borderRadius: "8px",
                      minWidth: "16px",
                      height: "16px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "0 4px",
                    })}
                  >
                    {tab.badge}
                  </div>
                ) : null}
              </div>
            </button>
          );
        })}
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} className={iconButtonClass} style={{ color: t.textTertiary }}>
            <Settings size={20} />
          </button>
        )}
      </div>
    </div>
  );
}
