import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TaskWorkbenchClient } from "@sandbox-agent/foundry-client";
import type { FoundryGithubState } from "@sandbox-agent/foundry-shared";
import { useNavigate } from "@tanstack/react-router";

import { DiffContent } from "./mock-layout/diff-content";
import { MessageList } from "./mock-layout/message-list";
import { PromptComposer } from "./mock-layout/prompt-composer";
import { RightSidebar } from "./mock-layout/right-sidebar";
import { Sidebar } from "./mock-layout/sidebar";
import { TabStrip } from "./mock-layout/tab-strip";
import { TranscriptHeader } from "./mock-layout/transcript-header";
import { RightSidebarSkeleton, SidebarSkeleton, TranscriptSkeleton } from "./mock-layout/skeleton";
import { PROMPT_TEXTAREA_MAX_HEIGHT, PROMPT_TEXTAREA_MIN_HEIGHT, PanelHeaderBar, SPanel, ScrollBody, Shell } from "./mock-layout/ui";
import {
  buildDisplayMessages,
  buildHistoryEvents,
  diffPath,
  diffTabId,
  formatThinkingDuration,
  isDiffTab,
  type Task,
  type HistoryEvent,
  type LineAttachment,
  type Message,
  type ModelId,
} from "./mock-layout/view-model";

function firstAgentTabId(task: Task): string | null {
  return task.tabs[0]?.id ?? null;
}

function sanitizeOpenDiffs(task: Task, paths: string[] | undefined): string[] {
  if (!paths) {
    return [];
  }

  return paths.filter((path) => task.diffs[path] != null);
}

function sanitizeLastAgentTabId(task: Task, tabId: string | null | undefined): string | null {
  if (tabId && task.tabs.some((tab) => tab.id === tabId)) {
    return tabId;
  }

  return firstAgentTabId(task);
}

function sanitizeActiveTabId(task: Task, tabId: string | null | undefined, openDiffs: string[], lastAgentTabId: string | null): string | null {
  if (tabId) {
    if (task.tabs.some((tab) => tab.id === tabId)) {
      return tabId;
    }
    if (isDiffTab(tabId) && openDiffs.includes(diffPath(tabId))) {
      return tabId;
    }
  }

  return openDiffs.length > 0 ? diffTabId(openDiffs[openDiffs.length - 1]!) : lastAgentTabId;
}

const TranscriptPanel = memo(function TranscriptPanel({
  client,
  task,
  activeTabId,
  lastAgentTabId,
  openDiffs,
  onSyncRouteSession,
  onSetActiveTabId,
  onSetLastAgentTabId,
  onSetOpenDiffs,
}: {
  client: TaskWorkbenchClient;
  task: Task;
  activeTabId: string | null;
  lastAgentTabId: string | null;
  openDiffs: string[];
  onSyncRouteSession: (taskId: string, sessionId: string | null, replace?: boolean) => void;
  onSetActiveTabId: (tabId: string | null) => void;
  onSetLastAgentTabId: (tabId: string | null) => void;
  onSetOpenDiffs: (paths: string[]) => void;
}) {
  const [defaultModel, setDefaultModel] = useState<ModelId>("claude-sonnet-4");
  const [editingField, setEditingField] = useState<"title" | "branch" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingSessionTabId, setEditingSessionTabId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState("");
  const [pendingHistoryTarget, setPendingHistoryTarget] = useState<{ messageId: string; tabId: string } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const activeDiff = activeTabId && isDiffTab(activeTabId) ? diffPath(activeTabId) : null;
  const activeAgentTab = activeDiff ? null : (task.tabs.find((candidate) => candidate.id === activeTabId) ?? task.tabs[0] ?? null);
  const promptTab = task.tabs.find((candidate) => candidate.id === lastAgentTabId) ?? task.tabs[0] ?? null;
  const isTerminal = task.status === "archived";
  const historyEvents = useMemo(() => buildHistoryEvents(task.tabs), [task.tabs]);
  const activeMessages = useMemo(() => buildDisplayMessages(activeAgentTab), [activeAgentTab]);
  const draft = promptTab?.draft.text ?? "";
  const attachments = promptTab?.draft.attachments ?? [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages.length]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeTabId, task.id]);

  useEffect(() => {
    setEditingSessionTabId(null);
    setEditingSessionName("");
  }, [task.id]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = `${PROMPT_TEXTAREA_MIN_HEIGHT}px`;
    const nextHeight = Math.min(textarea.scrollHeight, PROMPT_TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${Math.max(PROMPT_TEXTAREA_MIN_HEIGHT, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > PROMPT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [draft, activeTabId, task.id]);

  useEffect(() => {
    if (!pendingHistoryTarget || activeTabId !== pendingHistoryTarget.tabId) {
      return;
    }

    const targetNode = messageRefs.current.get(pendingHistoryTarget.messageId);
    if (!targetNode) {
      return;
    }

    targetNode.scrollIntoView({ behavior: "smooth", block: "center" });
    setPendingHistoryTarget(null);
  }, [activeMessages.length, activeTabId, pendingHistoryTarget]);

  useEffect(() => {
    if (!copiedMessageId) {
      return;
    }

    const timer = setTimeout(() => {
      setCopiedMessageId(null);
    }, 1_200);

    return () => clearTimeout(timer);
  }, [copiedMessageId]);

  useEffect(() => {
    if (!activeAgentTab || activeAgentTab.status !== "running" || activeAgentTab.thinkingSinceMs === null) {
      return;
    }

    setTimerNowMs(Date.now());
    const timer = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [activeAgentTab?.id, activeAgentTab?.status, activeAgentTab?.thinkingSinceMs]);

  useEffect(() => {
    if (!activeAgentTab?.unread) {
      return;
    }

    void client.setSessionUnread({
      taskId: task.id,
      tabId: activeAgentTab.id,
      unread: false,
    });
  }, [activeAgentTab?.id, activeAgentTab?.unread, client, task.id]);

  const startEditingField = useCallback((field: "title" | "branch", value: string) => {
    setEditingField(field);
    setEditValue(value);
  }, []);

  const cancelEditingField = useCallback(() => {
    setEditingField(null);
  }, []);

  const commitEditingField = useCallback(
    (field: "title" | "branch") => {
      const value = editValue.trim();
      if (!value) {
        setEditingField(null);
        return;
      }

      if (field === "title") {
        void client.renameTask({ taskId: task.id, value });
      } else {
        void client.renameBranch({ taskId: task.id, value });
      }
      setEditingField(null);
    },
    [client, editValue, task.id],
  );

  const updateDraft = useCallback(
    (nextText: string, nextAttachments: LineAttachment[]) => {
      if (!promptTab) {
        return;
      }

      void client.updateDraft({
        taskId: task.id,
        tabId: promptTab.id,
        text: nextText,
        attachments: nextAttachments,
      });
    },
    [client, task.id, promptTab],
  );

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    if (!text || !promptTab) {
      return;
    }

    onSetActiveTabId(promptTab.id);
    onSetLastAgentTabId(promptTab.id);
    void client.sendMessage({
      taskId: task.id,
      tabId: promptTab.id,
      text,
      attachments,
    });
  }, [attachments, client, draft, task.id, onSetActiveTabId, onSetLastAgentTabId, promptTab]);

  const stopAgent = useCallback(() => {
    if (!promptTab) {
      return;
    }

    void client.stopAgent({
      taskId: task.id,
      tabId: promptTab.id,
    });
  }, [client, task.id, promptTab]);

  const switchTab = useCallback(
    (tabId: string) => {
      onSetActiveTabId(tabId);

      if (!isDiffTab(tabId)) {
        onSetLastAgentTabId(tabId);
        const tab = task.tabs.find((candidate) => candidate.id === tabId);
        if (tab?.unread) {
          void client.setSessionUnread({
            taskId: task.id,
            tabId,
            unread: false,
          });
        }
        onSyncRouteSession(task.id, tabId);
      }
    },
    [client, task.id, task.tabs, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession],
  );

  const setTabUnread = useCallback(
    (tabId: string, unread: boolean) => {
      void client.setSessionUnread({ taskId: task.id, tabId, unread });
    },
    [client, task.id],
  );

  const startRenamingTab = useCallback(
    (tabId: string) => {
      const targetTab = task.tabs.find((candidate) => candidate.id === tabId);
      if (!targetTab) {
        throw new Error(`Unable to rename missing session tab ${tabId}`);
      }

      setEditingSessionTabId(tabId);
      setEditingSessionName(targetTab.sessionName);
    },
    [task.tabs],
  );

  const cancelTabRename = useCallback(() => {
    setEditingSessionTabId(null);
    setEditingSessionName("");
  }, []);

  const commitTabRename = useCallback(() => {
    if (!editingSessionTabId) {
      return;
    }

    const trimmedName = editingSessionName.trim();
    if (!trimmedName) {
      cancelTabRename();
      return;
    }

    void client.renameSession({
      taskId: task.id,
      tabId: editingSessionTabId,
      title: trimmedName,
    });
    cancelTabRename();
  }, [cancelTabRename, client, editingSessionName, editingSessionTabId, task.id]);

  const closeTab = useCallback(
    (tabId: string) => {
      const remainingTabs = task.tabs.filter((candidate) => candidate.id !== tabId);
      const nextTabId = remainingTabs[0]?.id ?? null;

      if (activeTabId === tabId) {
        onSetActiveTabId(nextTabId);
      }
      if (lastAgentTabId === tabId) {
        onSetLastAgentTabId(nextTabId);
      }

      onSyncRouteSession(task.id, nextTabId);
      void client.closeTab({ taskId: task.id, tabId });
    },
    [activeTabId, client, task.id, task.tabs, lastAgentTabId, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession],
  );

  const closeDiffTab = useCallback(
    (path: string) => {
      const nextOpenDiffs = openDiffs.filter((candidate) => candidate !== path);
      onSetOpenDiffs(nextOpenDiffs);
      if (activeTabId === diffTabId(path)) {
        onSetActiveTabId(nextOpenDiffs.length > 0 ? diffTabId(nextOpenDiffs[nextOpenDiffs.length - 1]!) : (lastAgentTabId ?? firstAgentTabId(task)));
      }
    },
    [activeTabId, task, lastAgentTabId, onSetActiveTabId, onSetOpenDiffs, openDiffs],
  );

  const addTab = useCallback(() => {
    void (async () => {
      const { tabId } = await client.addTab({ taskId: task.id });
      onSetLastAgentTabId(tabId);
      onSetActiveTabId(tabId);
      onSyncRouteSession(task.id, tabId);
    })();
  }, [client, task.id, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession]);

  const changeModel = useCallback(
    (model: ModelId) => {
      if (!promptTab) {
        throw new Error(`Unable to change model for task ${task.id} without an active prompt tab`);
      }

      void client.changeModel({
        taskId: task.id,
        tabId: promptTab.id,
        model,
      });
    },
    [client, task.id, promptTab],
  );

  const addAttachment = useCallback(
    (filePath: string, lineNumber: number, lineContent: string) => {
      if (!promptTab) {
        return;
      }

      const nextAttachment = { id: `${filePath}:${lineNumber}`, filePath, lineNumber, lineContent };
      if (attachments.some((attachment) => attachment.filePath === filePath && attachment.lineNumber === lineNumber)) {
        return;
      }

      updateDraft(draft, [...attachments, nextAttachment]);
    },
    [attachments, draft, promptTab, updateDraft],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      updateDraft(
        draft,
        attachments.filter((attachment) => attachment.id !== id),
      );
    },
    [attachments, draft, updateDraft],
  );

  const jumpToHistoryEvent = useCallback(
    (event: HistoryEvent) => {
      setPendingHistoryTarget({ messageId: event.messageId, tabId: event.tabId });

      if (activeTabId !== event.tabId) {
        switchTab(event.tabId);
        return;
      }

      const targetNode = messageRefs.current.get(event.messageId);
      if (targetNode) {
        targetNode.scrollIntoView({ behavior: "smooth", block: "center" });
        setPendingHistoryTarget(null);
      }
    },
    [activeTabId, switchTab],
  );

  const copyMessage = useCallback(async (message: Message) => {
    try {
      if (!window.navigator.clipboard) {
        throw new Error("Clipboard API unavailable in mock layout");
      }

      await window.navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.id);
    } catch (error) {
      console.error("Failed to copy transcript message", error);
    }
  }, []);

  const thinkingTimerLabel =
    activeAgentTab?.status === "running" && activeAgentTab.thinkingSinceMs !== null
      ? formatThinkingDuration(timerNowMs - activeAgentTab.thinkingSinceMs)
      : null;

  return (
    <SPanel>
      <TranscriptHeader
        task={task}
        activeTab={activeAgentTab}
        editingField={editingField}
        editValue={editValue}
        onEditValueChange={setEditValue}
        onStartEditingField={startEditingField}
        onCommitEditingField={commitEditingField}
        onCancelEditingField={cancelEditingField}
        onSetActiveTabUnread={(unread) => {
          if (activeAgentTab) {
            setTabUnread(activeAgentTab.id, unread);
          }
        }}
      />
      <TabStrip
        task={task}
        activeTabId={activeTabId}
        openDiffs={openDiffs}
        editingSessionTabId={editingSessionTabId}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={setEditingSessionName}
        onSwitchTab={switchTab}
        onStartRenamingTab={startRenamingTab}
        onCommitSessionRename={commitTabRename}
        onCancelSessionRename={cancelTabRename}
        onSetTabUnread={setTabUnread}
        onCloseTab={closeTab}
        onCloseDiffTab={closeDiffTab}
        onAddTab={addTab}
      />
      {activeDiff ? (
        <DiffContent
          filePath={activeDiff}
          file={task.fileChanges.find((file) => file.path === activeDiff)}
          diff={task.diffs[activeDiff]}
          onAddAttachment={addAttachment}
        />
      ) : task.tabs.length === 0 ? (
        <ScrollBody>
          <div
            style={{
              minHeight: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px",
            }}
          >
            <div
              style={{
                maxWidth: "420px",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Create the first session</h2>
              <p style={{ margin: 0, opacity: 0.75 }}>Sessions are where you chat with the agent. Start one now to send the first prompt on this task.</p>
              <button
                type="button"
                onClick={addTab}
                style={{
                  alignSelf: "center",
                  border: 0,
                  borderRadius: "999px",
                  padding: "10px 18px",
                  background: "#ff4f00",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                New session
              </button>
            </div>
          </div>
        </ScrollBody>
      ) : (
        <ScrollBody>
          <MessageList
            tab={activeAgentTab}
            scrollRef={scrollRef}
            messageRefs={messageRefs}
            historyEvents={historyEvents}
            onSelectHistoryEvent={jumpToHistoryEvent}
            copiedMessageId={copiedMessageId}
            onCopyMessage={(message) => {
              void copyMessage(message);
            }}
            thinkingTimerLabel={thinkingTimerLabel}
          />
        </ScrollBody>
      )}
      {!isTerminal && promptTab ? (
        <PromptComposer
          draft={draft}
          textareaRef={textareaRef}
          placeholder={!promptTab.created ? "Describe your task..." : "Send a message..."}
          attachments={attachments}
          defaultModel={defaultModel}
          model={promptTab.model}
          isRunning={promptTab.status === "running"}
          onDraftChange={(value) => updateDraft(value, attachments)}
          onSend={sendMessage}
          onStop={stopAgent}
          onRemoveAttachment={removeAttachment}
          onChangeModel={changeModel}
          onSetDefaultModel={setDefaultModel}
        />
      ) : null}
    </SPanel>
  );
});

interface MockLayoutProps {
  client: TaskWorkbenchClient;
  workspaceId: string;
  selectedTaskId?: string | null;
  selectedSessionId?: string | null;
  sidebarTitle?: string;
  sidebarSubtitle?: string;
  organizationGithub?: FoundryGithubState;
  onRetryGithubSync?: () => void;
  onReconnectGithub?: () => void;
  sidebarActions?: Array<{
    label: string;
    onClick: () => void;
  }>;
}

function WorkspaceStatusBanner({ github, onRetry, onReconnect }: { github?: FoundryGithubState; onRetry?: () => void; onReconnect?: () => void }) {
  const [dismissed, setDismissed] = useState(false);

  const banner = useMemo(() => {
    if (!github) {
      return null;
    }

    if (github.installationStatus === "install_required") {
      return {
        key: "install_required",
        tone: "warning",
        dismissible: false,
        title: "Install GitHub App to sync repositories",
        detail: github.lastSyncLabel,
        actionLabel: "Install GitHub App",
        onAction: onReconnect,
      };
    }

    if (github.installationStatus === "reconnect_required") {
      return {
        key: "reconnect_required",
        tone: "warning",
        dismissible: false,
        title: "GitHub App disconnected",
        detail: github.lastSyncLabel,
        actionLabel: "Reconnect GitHub",
        onAction: onReconnect,
      };
    }

    if (github.syncStatus === "pending" || github.syncStatus === "syncing") {
      return {
        key: `sync:${github.syncStatus}:${github.lastSyncLabel}`,
        tone: "info",
        dismissible: true,
        title: "Syncing repositories...",
        detail: github.lastSyncLabel,
        actionLabel: null,
        onAction: undefined,
      };
    }

    if (github.syncStatus === "error") {
      return {
        key: `error:${github.lastSyncLabel}`,
        tone: "danger",
        dismissible: true,
        title: "Repository sync failed",
        detail: github.lastSyncLabel,
        actionLabel: "Retry sync",
        onAction: onRetry,
      };
    }

    return null;
  }, [github, onReconnect, onRetry]);

  useEffect(() => {
    setDismissed(false);
  }, [banner?.key]);

  if (!banner || (banner.dismissible && dismissed)) {
    return null;
  }

  const background =
    banner.tone === "danger"
      ? "linear-gradient(135deg, rgba(127, 29, 29, 0.95), rgba(69, 10, 10, 0.98))"
      : banner.tone === "warning"
        ? "linear-gradient(135deg, rgba(120, 53, 15, 0.96), rgba(67, 20, 7, 0.98))"
        : "linear-gradient(135deg, rgba(17, 24, 39, 0.96), rgba(15, 23, 42, 0.98))";
  const borderColor =
    banner.tone === "danger" ? "rgba(248, 113, 113, 0.35)" : banner.tone === "warning" ? "rgba(251, 191, 36, 0.35)" : "rgba(96, 165, 250, 0.28)";

  return (
    <div
      style={{
        padding: "14px 18px",
        borderBottom: `1px solid ${borderColor}`,
        background,
        color: "#f8fafc",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "14px", fontWeight: 700 }}>{banner.title}</div>
        <div style={{ fontSize: "12px", color: "rgba(226, 232, 240, 0.8)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {banner.detail}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
        {banner.actionLabel && banner.onAction ? (
          <button
            type="button"
            onClick={banner.onAction}
            style={{
              border: "1px solid rgba(255, 255, 255, 0.16)",
              borderRadius: "999px",
              padding: "8px 12px",
              background: "rgba(255, 255, 255, 0.08)",
              color: "#ffffff",
              fontSize: "12px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {banner.actionLabel}
          </button>
        ) : null}
        {banner.dismissible ? (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            style={{
              border: 0,
              background: "transparent",
              color: "rgba(226, 232, 240, 0.8)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function MockLayout({
  client,
  workspaceId,
  selectedTaskId,
  selectedSessionId,
  sidebarTitle,
  sidebarSubtitle,
  organizationGithub,
  onRetryGithubSync,
  onReconnectGithub,
  sidebarActions,
}: MockLayoutProps) {
  const navigate = useNavigate();
  const viewModel = useSyncExternalStore(client.subscribe.bind(client), client.getSnapshot.bind(client), client.getSnapshot.bind(client));
  const tasks = viewModel.tasks ?? [];
  const repos = viewModel.repos ?? [];
  const repoSections = viewModel.repoSections ?? [];
  const [activeTabIdByTask, setActiveTabIdByTask] = useState<Record<string, string | null>>({});
  const [lastAgentTabIdByTask, setLastAgentTabIdByTask] = useState<Record<string, string | null>>({});
  const [openDiffsByTask, setOpenDiffsByTask] = useState<Record<string, string[]>>({});

  const activeTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null, [tasks, selectedTaskId]);

  useEffect(() => {
    if (activeTask) {
      return;
    }

    const fallbackTaskId = tasks[0]?.id;
    if (!fallbackTaskId) {
      return;
    }

    const fallbackTask = tasks.find((task) => task.id === fallbackTaskId) ?? null;

    void navigate({
      to: "/workspaces/$workspaceId/tasks/$taskId",
      params: {
        workspaceId,
        taskId: fallbackTaskId,
      },
      search: { sessionId: fallbackTask?.tabs[0]?.id ?? undefined },
      replace: true,
    });
  }, [activeTask, tasks, navigate, workspaceId]);

  const openDiffs = activeTask ? sanitizeOpenDiffs(activeTask, openDiffsByTask[activeTask.id]) : [];
  const lastAgentTabId = activeTask ? sanitizeLastAgentTabId(activeTask, lastAgentTabIdByTask[activeTask.id]) : null;
  const activeTabId = activeTask ? sanitizeActiveTabId(activeTask, activeTabIdByTask[activeTask.id], openDiffs, lastAgentTabId) : null;

  const syncRouteSession = useCallback(
    (taskId: string, sessionId: string | null, replace = false) => {
      void navigate({
        to: "/workspaces/$workspaceId/tasks/$taskId",
        params: {
          workspaceId,
          taskId,
        },
        search: { sessionId: sessionId ?? undefined },
        ...(replace ? { replace: true } : {}),
      });
    },
    [navigate, workspaceId],
  );

  useEffect(() => {
    if (!activeTask) {
      return;
    }

    const resolvedRouteSessionId = sanitizeLastAgentTabId(activeTask, selectedSessionId);
    if (!resolvedRouteSessionId) {
      return;
    }

    if (selectedSessionId !== resolvedRouteSessionId) {
      syncRouteSession(activeTask.id, resolvedRouteSessionId, true);
      return;
    }

    if (lastAgentTabIdByTask[activeTask.id] === resolvedRouteSessionId) {
      return;
    }

    setLastAgentTabIdByTask((current) => ({
      ...current,
      [activeTask.id]: resolvedRouteSessionId,
    }));
    setActiveTabIdByTask((current) => {
      const currentActive = current[activeTask.id];
      if (currentActive && isDiffTab(currentActive)) {
        return current;
      }

      return {
        ...current,
        [activeTask.id]: resolvedRouteSessionId,
      };
    });
  }, [activeTask, lastAgentTabIdByTask, selectedSessionId, syncRouteSession]);

  const createTask = useCallback(() => {
    void (async () => {
      const repoId = activeTask?.repoId ?? viewModel.repos[0]?.id ?? "";
      if (!repoId) {
        throw new Error("Cannot create a task without an available repo");
      }

      const { taskId, tabId } = await client.createTask({
        repoId,
        task: "",
        model: "gpt-4o",
      });
      await navigate({
        to: "/workspaces/$workspaceId/tasks/$taskId",
        params: {
          workspaceId,
          taskId,
        },
        search: { sessionId: tabId ?? undefined },
      });
    })();
  }, [activeTask?.repoId, client, navigate, viewModel.repos, workspaceId]);

  const openDiffTab = useCallback(
    (path: string) => {
      if (!activeTask) {
        throw new Error("Cannot open a diff tab without an active task");
      }
      setOpenDiffsByTask((current) => {
        const existing = sanitizeOpenDiffs(activeTask, current[activeTask.id]);
        if (existing.includes(path)) {
          return current;
        }

        return {
          ...current,
          [activeTask.id]: [...existing, path],
        };
      });
      setActiveTabIdByTask((current) => ({
        ...current,
        [activeTask.id]: diffTabId(path),
      }));
    },
    [activeTask],
  );

  const selectTask = useCallback(
    (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id) ?? null;
      void navigate({
        to: "/workspaces/$workspaceId/tasks/$taskId",
        params: {
          workspaceId,
          taskId: id,
        },
        search: { sessionId: task?.tabs[0]?.id ?? undefined },
      });
    },
    [tasks, navigate, workspaceId],
  );

  const markTaskUnread = useCallback(
    (id: string) => {
      void client.markTaskUnread({ taskId: id });
    },
    [client],
  );

  const renameTask = useCallback(
    (id: string) => {
      const currentTask = tasks.find((task) => task.id === id);
      if (!currentTask) {
        throw new Error(`Unable to rename missing task ${id}`);
      }

      const nextTitle = window.prompt("Rename task", currentTask.title);
      if (nextTitle === null) {
        return;
      }

      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle) {
        return;
      }

      void client.renameTask({ taskId: id, value: trimmedTitle });
    },
    [client, tasks],
  );

  const renameBranch = useCallback(
    (id: string) => {
      const currentTask = tasks.find((task) => task.id === id);
      if (!currentTask) {
        throw new Error(`Unable to rename missing task ${id}`);
      }

      const nextBranch = window.prompt("Rename branch", currentTask.branch ?? "");
      if (nextBranch === null) {
        return;
      }

      const trimmedBranch = nextBranch.trim();
      if (!trimmedBranch) {
        return;
      }

      void client.renameBranch({ taskId: id, value: trimmedBranch });
    },
    [client, tasks],
  );

  const archiveTask = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot archive without an active task");
    }
    void client.archiveTask({ taskId: activeTask.id });
  }, [activeTask, client]);

  const publishPr = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot publish PR without an active task");
    }
    void client.publishPr({ taskId: activeTask.id });
  }, [activeTask, client]);

  const pushTask = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot push without an active task");
    }
    void client.pushTask({ taskId: activeTask.id });
  }, [activeTask, client]);

  const revertFile = useCallback(
    (path: string) => {
      if (!activeTask) {
        throw new Error("Cannot revert a file without an active task");
      }
      setOpenDiffsByTask((current) => ({
        ...current,
        [activeTask.id]: sanitizeOpenDiffs(activeTask, current[activeTask.id]).filter((candidate) => candidate !== path),
      }));
      setActiveTabIdByTask((current) => ({
        ...current,
        [activeTask.id]:
          current[activeTask.id] === diffTabId(path)
            ? sanitizeLastAgentTabId(activeTask, lastAgentTabIdByTask[activeTask.id])
            : (current[activeTask.id] ?? null),
      }));

      void client.revertFile({
        taskId: activeTask.id,
        path,
      });
    },
    [activeTask, client, lastAgentTabIdByTask],
  );

  // Show full-page skeleton while the client snapshot is still empty (initial load)
  const isInitialLoad = tasks.length === 0 && repos.length === 0 && viewModel.repos.length === 0;
  if (isInitialLoad) {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <WorkspaceStatusBanner github={organizationGithub} onRetry={onRetryGithubSync} onReconnect={onReconnectGithub} />
        <Shell>
          <SPanel>
            <PanelHeaderBar>
              <div style={{ flex: 1 }} />
            </PanelHeaderBar>
            <ScrollBody>
              <SidebarSkeleton />
            </ScrollBody>
          </SPanel>
          <SPanel>
            <PanelHeaderBar>
              <div style={{ flex: 1 }} />
            </PanelHeaderBar>
            <TranscriptSkeleton />
          </SPanel>
          <SPanel>
            <PanelHeaderBar>
              <div style={{ flex: 1 }} />
            </PanelHeaderBar>
            <RightSidebarSkeleton />
          </SPanel>
        </Shell>
      </div>
    );
  }

  if (!activeTask) {
    return (
      <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
        <WorkspaceStatusBanner github={organizationGithub} onRetry={onRetryGithubSync} onReconnect={onReconnectGithub} />
        <Shell>
          <Sidebar
            workspaceId={workspaceId}
            repoCount={viewModel.repos.length}
            repos={repoSections}
            activeId=""
            title={sidebarTitle}
            subtitle={sidebarSubtitle}
            actions={sidebarActions}
            onSelect={selectTask}
            onCreate={createTask}
            onMarkUnread={markTaskUnread}
            onRenameTask={renameTask}
            onRenameBranch={renameBranch}
          />
          <SPanel>
            <ScrollBody>
              <div
                style={{
                  minHeight: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "32px",
                }}
              >
                <div
                  style={{
                    maxWidth: "420px",
                    textAlign: "center",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Create your first task</h2>
                  <p style={{ margin: 0, opacity: 0.75 }}>
                    {viewModel.repos.length > 0
                      ? "Start from the sidebar to create a task on the first available repo."
                      : "No repos are available in this workspace yet."}
                  </p>
                  <button
                    type="button"
                    onClick={createTask}
                    disabled={viewModel.repos.length === 0}
                    style={{
                      alignSelf: "center",
                      border: 0,
                      borderRadius: "999px",
                      padding: "10px 18px",
                      background: viewModel.repos.length > 0 ? "#ff4f00" : "#444",
                      color: "#fff",
                      cursor: viewModel.repos.length > 0 ? "pointer" : "not-allowed",
                      fontWeight: 600,
                    }}
                  >
                    New task
                  </button>
                </div>
              </div>
            </ScrollBody>
          </SPanel>
          <SPanel />
        </Shell>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      <WorkspaceStatusBanner github={organizationGithub} onRetry={onRetryGithubSync} onReconnect={onReconnectGithub} />
      <Shell>
        <Sidebar
          workspaceId={workspaceId}
          repoCount={viewModel.repos.length}
          repos={repoSections}
          activeId={activeTask.id}
          title={sidebarTitle}
          subtitle={sidebarSubtitle}
          actions={sidebarActions}
          onSelect={selectTask}
          onCreate={createTask}
          onMarkUnread={markTaskUnread}
          onRenameTask={renameTask}
          onRenameBranch={renameBranch}
        />
        <TranscriptPanel
          client={client}
          task={activeTask}
          activeTabId={activeTabId}
          lastAgentTabId={lastAgentTabId}
          openDiffs={openDiffs}
          onSyncRouteSession={syncRouteSession}
          onSetActiveTabId={(tabId) => {
            setActiveTabIdByTask((current) => ({ ...current, [activeTask.id]: tabId }));
          }}
          onSetLastAgentTabId={(tabId) => {
            setLastAgentTabIdByTask((current) => ({ ...current, [activeTask.id]: tabId }));
          }}
          onSetOpenDiffs={(paths) => {
            setOpenDiffsByTask((current) => ({ ...current, [activeTask.id]: paths }));
          }}
        />
        <RightSidebar
          task={activeTask}
          activeTabId={activeTabId}
          onOpenDiff={openDiffTab}
          onArchive={archiveTask}
          onPush={pushTask}
          onRevertFile={revertFile}
          onPublishPr={publishPr}
        />
      </Shell>
    </div>
  );
}
