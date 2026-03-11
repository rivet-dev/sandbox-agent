import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStyletron } from "baseui";

import { DiffContent } from "./mock-layout/diff-content";
import { MessageList } from "./mock-layout/message-list";
import { PromptComposer } from "./mock-layout/prompt-composer";
import { RightSidebar } from "./mock-layout/right-sidebar";
import { Sidebar } from "./mock-layout/sidebar";
import { TabStrip } from "./mock-layout/tab-strip";
import { TerminalPane } from "./mock-layout/terminal-pane";
import { TranscriptHeader } from "./mock-layout/transcript-header";
import { PROMPT_TEXTAREA_MAX_HEIGHT, PROMPT_TEXTAREA_MIN_HEIGHT, SPanel, ScrollBody, Shell } from "./mock-layout/ui";
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
import { activeMockOrganization, useMockAppSnapshot } from "../lib/mock-app";
import { taskWorkbenchClient } from "../lib/workbench";

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
  task,
  activeTabId,
  lastAgentTabId,
  openDiffs,
  onSyncRouteSession,
  onSetActiveTabId,
  onSetLastAgentTabId,
  onSetOpenDiffs,
}: {
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

    void taskWorkbenchClient.setSessionUnread({
      taskId: task.id,
      tabId: activeAgentTab.id,
      unread: false,
    });
  }, [activeAgentTab?.id, activeAgentTab?.unread, task.id]);

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
        void taskWorkbenchClient.renameTask({ taskId: task.id, value });
      } else {
        void taskWorkbenchClient.renameBranch({ taskId: task.id, value });
      }
      setEditingField(null);
    },
    [editValue, task.id],
  );

  const updateDraft = useCallback(
    (nextText: string, nextAttachments: LineAttachment[]) => {
      if (!promptTab) {
        return;
      }

      void taskWorkbenchClient.updateDraft({
        taskId: task.id,
        tabId: promptTab.id,
        text: nextText,
        attachments: nextAttachments,
      });
    },
    [task.id, promptTab],
  );

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    if (!text || !promptTab) {
      return;
    }

    onSetActiveTabId(promptTab.id);
    onSetLastAgentTabId(promptTab.id);
    void taskWorkbenchClient.sendMessage({
      taskId: task.id,
      tabId: promptTab.id,
      text,
      attachments,
    });
  }, [attachments, draft, task.id, onSetActiveTabId, onSetLastAgentTabId, promptTab]);

  const stopAgent = useCallback(() => {
    if (!promptTab) {
      return;
    }

    void taskWorkbenchClient.stopAgent({
      taskId: task.id,
      tabId: promptTab.id,
    });
  }, [task.id, promptTab]);

  const switchTab = useCallback(
    (tabId: string) => {
      onSetActiveTabId(tabId);

      if (!isDiffTab(tabId)) {
        onSetLastAgentTabId(tabId);
        const tab = task.tabs.find((candidate) => candidate.id === tabId);
        if (tab?.unread) {
          void taskWorkbenchClient.setSessionUnread({
            taskId: task.id,
            tabId,
            unread: false,
          });
        }
        onSyncRouteSession(task.id, tabId);
      }
    },
    [task.id, task.tabs, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession],
  );

  const setTabUnread = useCallback(
    (tabId: string, unread: boolean) => {
      void taskWorkbenchClient.setSessionUnread({ taskId: task.id, tabId, unread });
    },
    [task.id],
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

    void taskWorkbenchClient.renameSession({
      taskId: task.id,
      tabId: editingSessionTabId,
      title: trimmedName,
    });
    cancelTabRename();
  }, [cancelTabRename, editingSessionName, editingSessionTabId, task.id]);

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
      void taskWorkbenchClient.closeTab({ taskId: task.id, tabId });
    },
    [activeTabId, task.id, task.tabs, lastAgentTabId, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession],
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
      const { tabId } = await taskWorkbenchClient.addTab({ taskId: task.id });
      onSetLastAgentTabId(tabId);
      onSetActiveTabId(tabId);
      onSyncRouteSession(task.id, tabId);
    })();
  }, [task.id, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession]);

  const changeModel = useCallback(
    (model: ModelId) => {
      if (!promptTab) {
        throw new Error(`Unable to change model for task ${task.id} without an active prompt tab`);
      }

      void taskWorkbenchClient.changeModel({
        taskId: task.id,
        tabId: promptTab.id,
        model,
      });
    },
    [task.id, promptTab],
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
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#09090b",
          overflow: "hidden",
          borderTopLeftRadius: "12px",
          borderLeft: "1px solid rgba(255, 255, 255, 0.10)",
          borderTop: "1px solid rgba(255, 255, 255, 0.10)",
        }}
      >
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
                    background: "rgba(255, 255, 255, 0.12)",
                    color: "#e4e4e7",
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
      </div>
    </SPanel>
  );
});

const LEFT_SIDEBAR_DEFAULT_WIDTH = 340;
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 380;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 600;
const RESIZE_HANDLE_WIDTH = 1;
const LEFT_WIDTH_STORAGE_KEY = "foundry:left-sidebar-width";
const RIGHT_WIDTH_STORAGE_KEY = "foundry:right-sidebar-width";

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH) : fallback;
}

const PanelResizeHandle = memo(function PanelResizeHandle({ onResizeStart, onResize }: { onResizeStart: () => void; onResize: (deltaX: number) => void }) {
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      onResizeStart();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        onResize(moveEvent.clientX - startX);
      };

      const stopResize = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize, { once: true });
    },
    [onResize, onResizeStart],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={handlePointerDown}
      style={{
        width: `${RESIZE_HANDLE_WIDTH}px`,
        flexShrink: 0,
        cursor: "col-resize",
        backgroundColor: "transparent",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "-3px",
          right: "-3px",
        }}
      />
    </div>
  );
});

const RIGHT_RAIL_MIN_SECTION_HEIGHT = 180;
const RIGHT_RAIL_SPLITTER_HEIGHT = 10;
const DEFAULT_TERMINAL_HEIGHT = 320;
const TERMINAL_HEIGHT_STORAGE_KEY = "foundry:terminal-height";

const RightRail = memo(function RightRail({
  workspaceId,
  task,
  activeTabId,
  onOpenDiff,
  onArchive,
  onRevertFile,
  onPublishPr,
}: {
  workspaceId: string;
  task: Task;
  activeTabId: string | null;
  onOpenDiff: (path: string) => void;
  onArchive: () => void;
  onRevertFile: (path: string) => void;
  onPublishPr: () => void;
}) {
  const [css] = useStyletron();
  const railRef = useRef<HTMLDivElement>(null);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_TERMINAL_HEIGHT;
    }

    const stored = window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : DEFAULT_TERMINAL_HEIGHT;
  });

  const clampTerminalHeight = useCallback((nextHeight: number) => {
    const railHeight = railRef.current?.getBoundingClientRect().height ?? 0;
    const maxHeight = Math.max(RIGHT_RAIL_MIN_SECTION_HEIGHT, railHeight - RIGHT_RAIL_MIN_SECTION_HEIGHT - RIGHT_RAIL_SPLITTER_HEIGHT);

    return Math.min(Math.max(nextHeight, RIGHT_RAIL_MIN_SECTION_HEIGHT), maxHeight);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(terminalHeight));
  }, [terminalHeight]);

  useEffect(() => {
    const handleResize = () => {
      setTerminalHeight((current) => clampTerminalHeight(current));
    };

    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [clampTerminalHeight]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const startY = event.clientY;
      const startHeight = terminalHeight;
      document.body.style.cursor = "ns-resize";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaY = moveEvent.clientY - startY;
        setTerminalHeight(clampTerminalHeight(startHeight - deltaY));
      };

      const stopResize = () => {
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize, { once: true });
    },
    [clampTerminalHeight, terminalHeight],
  );

  return (
    <div
      ref={railRef}
      className={css({
        minHeight: 0,
        flex: 1,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#090607",
      })}
    >
      <div
        className={css({
          minHeight: `${RIGHT_RAIL_MIN_SECTION_HEIGHT}px`,
          flex: 1,
          minWidth: 0,
        })}
      >
        <RightSidebar
          task={task}
          activeTabId={activeTabId}
          onOpenDiff={onOpenDiff}
          onArchive={onArchive}
          onRevertFile={onRevertFile}
          onPublishPr={onPublishPr}
        />
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        onPointerDown={startResize}
        className={css({
          height: `${RIGHT_RAIL_SPLITTER_HEIGHT}px`,
          flexShrink: 0,
          cursor: "ns-resize",
          position: "relative",
          backgroundColor: "#050505",
          ":before": {
            content: '""',
            position: "absolute",
            left: "50%",
            top: "50%",
            width: "42px",
            height: "4px",
            borderRadius: "999px",
            transform: "translate(-50%, -50%)",
            backgroundColor: "rgba(255, 255, 255, 0.14)",
          },
        })}
      />
      <div
        className={css({
          height: `${terminalHeight}px`,
          minHeight: `${RIGHT_RAIL_MIN_SECTION_HEIGHT}px`,
          backgroundColor: "#080506",
          overflow: "hidden",
        })}
      >
        <TerminalPane workspaceId={workspaceId} taskId={task.id} />
      </div>
    </div>
  );
});

interface MockLayoutProps {
  workspaceId: string;
  selectedTaskId?: string | null;
  selectedSessionId?: string | null;
}

function MockWorkspaceOrgBar() {
  const navigate = useNavigate();
  const snapshot = useMockAppSnapshot();
  const organization = activeMockOrganization(snapshot);

  if (!organization) {
    return null;
  }

  const buttonStyle = {
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "999px",
    padding: "8px 12px",
    background: "rgba(255,255,255,0.03)",
    color: "rgba(255,255,255,0.86)",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
  } satisfies React.CSSProperties;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "12px 20px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        background: "#101010",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <strong style={{ fontSize: "14px", fontWeight: 600 }}>{organization.settings.displayName}</strong>
        <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.6)" }}>{organization.settings.primaryDomain}</span>
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void navigate({ to: "/organizations" });
          }}
        >
          Switch org
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void navigate({
              to: "/organizations/$organizationId/settings",
              params: { organizationId: organization.id },
            });
          }}
        >
          Settings
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void navigate({
              to: "/organizations/$organizationId/billing",
              params: { organizationId: organization.id },
            });
          }}
        >
          Billing
        </button>
      </div>
    </div>
  );
}

export function MockLayout({ workspaceId, selectedTaskId, selectedSessionId }: MockLayoutProps) {
  const navigate = useNavigate();
  const viewModel = useSyncExternalStore(
    taskWorkbenchClient.subscribe.bind(taskWorkbenchClient),
    taskWorkbenchClient.getSnapshot.bind(taskWorkbenchClient),
    taskWorkbenchClient.getSnapshot.bind(taskWorkbenchClient),
  );
  const tasks = viewModel.tasks ?? [];
  const rawProjects = viewModel.projects ?? [];
  const [projectOrder, setProjectOrder] = useState<string[] | null>(null);
  const projects = useMemo(() => {
    if (!projectOrder) return rawProjects;
    const byId = new Map(rawProjects.map((p) => [p.id, p]));
    const ordered = projectOrder.map((id) => byId.get(id)).filter(Boolean) as typeof rawProjects;
    for (const p of rawProjects) {
      if (!projectOrder.includes(p.id)) ordered.push(p);
    }
    return ordered;
  }, [rawProjects, projectOrder]);
  const reorderProjects = useCallback(
    (fromIndex: number, toIndex: number) => {
      const ids = projects.map((p) => p.id);
      const [moved] = ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, moved!);
      setProjectOrder(ids);
    },
    [projects],
  );
  const [activeTabIdByTask, setActiveTabIdByTask] = useState<Record<string, string | null>>({});
  const [lastAgentTabIdByTask, setLastAgentTabIdByTask] = useState<Record<string, string | null>>({});
  const [openDiffsByTask, setOpenDiffsByTask] = useState<Record<string, string[]>>({});
  const [leftWidth, setLeftWidth] = useState(() => readStoredWidth(LEFT_WIDTH_STORAGE_KEY, LEFT_SIDEBAR_DEFAULT_WIDTH));
  const [rightWidth, setRightWidth] = useState(() => readStoredWidth(RIGHT_WIDTH_STORAGE_KEY, RIGHT_SIDEBAR_DEFAULT_WIDTH));
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);

  useEffect(() => {
    leftWidthRef.current = leftWidth;
    window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    rightWidthRef.current = rightWidth;
    window.localStorage.setItem(RIGHT_WIDTH_STORAGE_KEY, String(rightWidth));
  }, [rightWidth]);

  const startLeftRef = useRef(leftWidth);
  const startRightRef = useRef(rightWidth);

  const onLeftResize = useCallback((deltaX: number) => {
    setLeftWidth(Math.min(Math.max(startLeftRef.current + deltaX, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
  }, []);

  const onLeftResizeStart = useCallback(() => {
    startLeftRef.current = leftWidthRef.current;
  }, []);

  const onRightResize = useCallback((deltaX: number) => {
    setRightWidth(Math.min(Math.max(startRightRef.current - deltaX, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
  }, []);

  const onRightResizeStart = useCallback(() => {
    startRightRef.current = rightWidthRef.current;
  }, []);

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

      const { taskId, tabId } = await taskWorkbenchClient.createTask({
        repoId,
        task: "New task",
        model: "gpt-4o",
        title: "New task",
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
  }, [activeTask?.repoId, navigate, viewModel.repos, workspaceId]);

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

  const markTaskUnread = useCallback((id: string) => {
    void taskWorkbenchClient.markTaskUnread({ taskId: id });
  }, []);

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

      void taskWorkbenchClient.renameTask({ taskId: id, value: trimmedTitle });
    },
    [tasks],
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

      void taskWorkbenchClient.renameBranch({ taskId: id, value: trimmedBranch });
    },
    [tasks],
  );

  const archiveTask = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot archive without an active task");
    }
    void taskWorkbenchClient.archiveTask({ taskId: activeTask.id });
  }, [activeTask]);

  const publishPr = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot publish PR without an active task");
    }
    void taskWorkbenchClient.publishPr({ taskId: activeTask.id });
  }, [activeTask]);

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

      void taskWorkbenchClient.revertFile({
        taskId: activeTask.id,
        path,
      });
    },
    [activeTask, lastAgentTabIdByTask],
  );
  if (!activeTask) {
    return (
      <>
        <MockWorkspaceOrgBar />
        <Shell>
          <div style={{ width: `${leftWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Sidebar
              projects={projects}
              activeId=""
              onSelect={selectTask}
              onCreate={createTask}
              onMarkUnread={markTaskUnread}
              onRenameTask={renameTask}
              onRenameBranch={renameBranch}
              onReorderProjects={reorderProjects}
            />
          </div>
          <PanelResizeHandle onResizeStart={onLeftResizeStart} onResize={onLeftResize} />
          <SPanel $style={{ backgroundColor: "#09090b", flex: 1, minWidth: 0 }}>
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
                      background: viewModel.repos.length > 0 ? "rgba(255, 255, 255, 0.12)" : "#444",
                      color: "#e4e4e7",
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
          <PanelResizeHandle onResizeStart={onRightResizeStart} onResize={onRightResize} />
          <div style={{ width: `${rightWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <SPanel />
          </div>
        </Shell>
      </>
    );
  }

  return (
    <>
      <MockWorkspaceOrgBar />
      <Shell>
        <div style={{ width: `${leftWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Sidebar
            projects={projects}
            activeId={activeTask.id}
            onSelect={selectTask}
            onCreate={createTask}
            onMarkUnread={markTaskUnread}
            onRenameTask={renameTask}
            onRenameBranch={renameBranch}
            onReorderProjects={reorderProjects}
          />
        </div>
        <PanelResizeHandle onResizeStart={onLeftResizeStart} onResize={onLeftResize} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <TranscriptPanel
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
        </div>
        <PanelResizeHandle onResizeStart={onRightResizeStart} onResize={onRightResize} />
        <div style={{ width: `${rightWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <RightRail
            workspaceId={workspaceId}
            task={activeTask}
            activeTabId={activeTabId}
            onOpenDiff={openDiffTab}
            onArchive={archiveTask}
            onRevertFile={revertFile}
            onPublishPr={publishPr}
          />
        </div>
      </Shell>
    </>
  );
}
