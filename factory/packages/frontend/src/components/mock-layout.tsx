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
  type Handoff,
  type HistoryEvent,
  type LineAttachment,
  type Message,
  type ModelId,
} from "./mock-layout/view-model";
import { backendClient } from "../lib/backend";
import { handoffWorkbenchClient } from "../lib/workbench";

const STAR_SANDBOX_AGENT_REPO_STORAGE_KEY = "hf.onboarding.starSandboxAgentRepo";

function firstAgentTabId(handoff: Handoff): string | null {
  return handoff.tabs[0]?.id ?? null;
}

function sanitizeOpenDiffs(handoff: Handoff, paths: string[] | undefined): string[] {
  if (!paths) {
    return [];
  }

  return paths.filter((path) => handoff.diffs[path] != null);
}

function sanitizeLastAgentTabId(handoff: Handoff, tabId: string | null | undefined): string | null {
  if (tabId && handoff.tabs.some((tab) => tab.id === tabId)) {
    return tabId;
  }

  return firstAgentTabId(handoff);
}

function sanitizeActiveTabId(handoff: Handoff, tabId: string | null | undefined, openDiffs: string[], lastAgentTabId: string | null): string | null {
  if (tabId) {
    if (handoff.tabs.some((tab) => tab.id === tabId)) {
      return tabId;
    }
    if (isDiffTab(tabId) && openDiffs.includes(diffPath(tabId))) {
      return tabId;
    }
  }

  return openDiffs.length > 0 ? diffTabId(openDiffs[openDiffs.length - 1]!) : lastAgentTabId;
}

const TranscriptPanel = memo(function TranscriptPanel({
  handoff,
  activeTabId,
  lastAgentTabId,
  openDiffs,
  onSyncRouteSession,
  onSetActiveTabId,
  onSetLastAgentTabId,
  onSetOpenDiffs,
}: {
  handoff: Handoff;
  activeTabId: string | null;
  lastAgentTabId: string | null;
  openDiffs: string[];
  onSyncRouteSession: (handoffId: string, sessionId: string | null, replace?: boolean) => void;
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
  const activeAgentTab = activeDiff ? null : (handoff.tabs.find((candidate) => candidate.id === activeTabId) ?? handoff.tabs[0] ?? null);
  const promptTab = handoff.tabs.find((candidate) => candidate.id === lastAgentTabId) ?? handoff.tabs[0] ?? null;
  const isTerminal = handoff.status === "archived";
  const historyEvents = useMemo(() => buildHistoryEvents(handoff.tabs), [handoff.tabs]);
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
  }, [activeTabId, handoff.id]);

  useEffect(() => {
    setEditingSessionTabId(null);
    setEditingSessionName("");
  }, [handoff.id]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = `${PROMPT_TEXTAREA_MIN_HEIGHT}px`;
    const nextHeight = Math.min(textarea.scrollHeight, PROMPT_TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${Math.max(PROMPT_TEXTAREA_MIN_HEIGHT, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > PROMPT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [draft, activeTabId, handoff.id]);

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

    void handoffWorkbenchClient.setSessionUnread({
      handoffId: handoff.id,
      tabId: activeAgentTab.id,
      unread: false,
    });
  }, [activeAgentTab?.id, activeAgentTab?.unread, handoff.id]);

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
        void handoffWorkbenchClient.renameHandoff({ handoffId: handoff.id, value });
      } else {
        void handoffWorkbenchClient.renameBranch({ handoffId: handoff.id, value });
      }
      setEditingField(null);
    },
    [editValue, handoff.id],
  );

  const updateDraft = useCallback(
    (nextText: string, nextAttachments: LineAttachment[]) => {
      if (!promptTab) {
        return;
      }

      void handoffWorkbenchClient.updateDraft({
        handoffId: handoff.id,
        tabId: promptTab.id,
        text: nextText,
        attachments: nextAttachments,
      });
    },
    [handoff.id, promptTab],
  );

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    if (!text || !promptTab) {
      return;
    }

    onSetActiveTabId(promptTab.id);
    onSetLastAgentTabId(promptTab.id);
    void handoffWorkbenchClient.sendMessage({
      handoffId: handoff.id,
      tabId: promptTab.id,
      text,
      attachments,
    });
  }, [attachments, draft, handoff.id, onSetActiveTabId, onSetLastAgentTabId, promptTab]);

  const stopAgent = useCallback(() => {
    if (!promptTab) {
      return;
    }

    void handoffWorkbenchClient.stopAgent({
      handoffId: handoff.id,
      tabId: promptTab.id,
    });
  }, [handoff.id, promptTab]);

  const switchTab = useCallback(
    (tabId: string) => {
      onSetActiveTabId(tabId);

      if (!isDiffTab(tabId)) {
        onSetLastAgentTabId(tabId);
        const tab = handoff.tabs.find((candidate) => candidate.id === tabId);
        if (tab?.unread) {
          void handoffWorkbenchClient.setSessionUnread({
            handoffId: handoff.id,
            tabId,
            unread: false,
          });
        }
        onSyncRouteSession(handoff.id, tabId);
      }
    },
    [handoff.id, handoff.tabs, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession],
  );

  const setTabUnread = useCallback(
    (tabId: string, unread: boolean) => {
      void handoffWorkbenchClient.setSessionUnread({ handoffId: handoff.id, tabId, unread });
    },
    [handoff.id],
  );

  const startRenamingTab = useCallback(
    (tabId: string) => {
      const targetTab = handoff.tabs.find((candidate) => candidate.id === tabId);
      if (!targetTab) {
        throw new Error(`Unable to rename missing session tab ${tabId}`);
      }

      setEditingSessionTabId(tabId);
      setEditingSessionName(targetTab.sessionName);
    },
    [handoff.tabs],
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

    void handoffWorkbenchClient.renameSession({
      handoffId: handoff.id,
      tabId: editingSessionTabId,
      title: trimmedName,
    });
    cancelTabRename();
  }, [cancelTabRename, editingSessionName, editingSessionTabId, handoff.id]);

  const closeTab = useCallback(
    (tabId: string) => {
      const remainingTabs = handoff.tabs.filter((candidate) => candidate.id !== tabId);
      const nextTabId = remainingTabs[0]?.id ?? null;

      if (activeTabId === tabId) {
        onSetActiveTabId(nextTabId);
      }
      if (lastAgentTabId === tabId) {
        onSetLastAgentTabId(nextTabId);
      }

      onSyncRouteSession(handoff.id, nextTabId);
      void handoffWorkbenchClient.closeTab({ handoffId: handoff.id, tabId });
    },
    [activeTabId, handoff.id, handoff.tabs, lastAgentTabId, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession],
  );

  const closeDiffTab = useCallback(
    (path: string) => {
      const nextOpenDiffs = openDiffs.filter((candidate) => candidate !== path);
      onSetOpenDiffs(nextOpenDiffs);
      if (activeTabId === diffTabId(path)) {
        onSetActiveTabId(nextOpenDiffs.length > 0 ? diffTabId(nextOpenDiffs[nextOpenDiffs.length - 1]!) : (lastAgentTabId ?? firstAgentTabId(handoff)));
      }
    },
    [activeTabId, handoff, lastAgentTabId, onSetActiveTabId, onSetOpenDiffs, openDiffs],
  );

  const addTab = useCallback(() => {
    void (async () => {
      const { tabId } = await handoffWorkbenchClient.addTab({ handoffId: handoff.id });
      onSetLastAgentTabId(tabId);
      onSetActiveTabId(tabId);
      onSyncRouteSession(handoff.id, tabId);
    })();
  }, [handoff.id, onSetActiveTabId, onSetLastAgentTabId, onSyncRouteSession]);

  const changeModel = useCallback(
    (model: ModelId) => {
      if (!promptTab) {
        throw new Error(`Unable to change model for task ${handoff.id} without an active prompt tab`);
      }

      void handoffWorkbenchClient.changeModel({
        handoffId: handoff.id,
        tabId: promptTab.id,
        model,
      });
    },
    [handoff.id, promptTab],
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
        handoff={handoff}
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
          handoff={handoff}
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
            file={handoff.fileChanges.find((file) => file.path === activeDiff)}
            diff={handoff.diffs[activeDiff]}
            onAddAttachment={addAttachment}
          />
        ) : handoff.tabs.length === 0 ? (
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
const LEFT_WIDTH_STORAGE_KEY = "openhandoff:foundry-left-sidebar-width";
const RIGHT_WIDTH_STORAGE_KEY = "openhandoff:foundry-right-sidebar-width";

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
const TERMINAL_HEIGHT_STORAGE_KEY = "openhandoff:foundry-terminal-height";

const RightRail = memo(function RightRail({
  workspaceId,
  handoff,
  activeTabId,
  onOpenDiff,
  onArchive,
  onRevertFile,
  onPublishPr,
}: {
  workspaceId: string;
  handoff: Handoff;
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
          handoff={handoff}
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
        <TerminalPane workspaceId={workspaceId} handoffId={handoff.id} />
      </div>
    </div>
  );
});

interface MockLayoutProps {
  workspaceId: string;
  selectedHandoffId?: string | null;
  selectedSessionId?: string | null;
}

export function MockLayout({ workspaceId, selectedHandoffId, selectedSessionId }: MockLayoutProps) {
  const navigate = useNavigate();
  const viewModel = useSyncExternalStore(
    handoffWorkbenchClient.subscribe.bind(handoffWorkbenchClient),
    handoffWorkbenchClient.getSnapshot.bind(handoffWorkbenchClient),
    handoffWorkbenchClient.getSnapshot.bind(handoffWorkbenchClient),
  );
  const handoffs = viewModel.handoffs ?? [];
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
  const [activeTabIdByHandoff, setActiveTabIdByHandoff] = useState<Record<string, string | null>>({});
  const [lastAgentTabIdByHandoff, setLastAgentTabIdByHandoff] = useState<Record<string, string | null>>({});
  const [openDiffsByHandoff, setOpenDiffsByHandoff] = useState<Record<string, string[]>>({});
  const [starRepoPromptOpen, setStarRepoPromptOpen] = useState(false);
  const [starRepoPending, setStarRepoPending] = useState(false);
  const [starRepoError, setStarRepoError] = useState<string | null>(null);
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

  const activeHandoff = useMemo(() => handoffs.find((handoff) => handoff.id === selectedHandoffId) ?? handoffs[0] ?? null, [handoffs, selectedHandoffId]);

  useEffect(() => {
    try {
      const status = globalThis.localStorage?.getItem(STAR_SANDBOX_AGENT_REPO_STORAGE_KEY);
      if (status !== "completed" && status !== "dismissed") {
        setStarRepoPromptOpen(true);
      }
    } catch {
      setStarRepoPromptOpen(true);
    }
  }, []);

  useEffect(() => {
    if (activeHandoff) {
      return;
    }

    const fallbackHandoffId = handoffs[0]?.id;
    if (!fallbackHandoffId) {
      return;
    }

    const fallbackHandoff = handoffs.find((handoff) => handoff.id === fallbackHandoffId) ?? null;

    void navigate({
      to: "/workspaces/$workspaceId/handoffs/$handoffId",
      params: {
        workspaceId,
        handoffId: fallbackHandoffId,
      },
      search: { sessionId: fallbackHandoff?.tabs[0]?.id ?? undefined },
      replace: true,
    });
  }, [activeHandoff, handoffs, navigate, workspaceId]);

  const openDiffs = activeHandoff ? sanitizeOpenDiffs(activeHandoff, openDiffsByHandoff[activeHandoff.id]) : [];
  const lastAgentTabId = activeHandoff ? sanitizeLastAgentTabId(activeHandoff, lastAgentTabIdByHandoff[activeHandoff.id]) : null;
  const activeTabId = activeHandoff ? sanitizeActiveTabId(activeHandoff, activeTabIdByHandoff[activeHandoff.id], openDiffs, lastAgentTabId) : null;

  const syncRouteSession = useCallback(
    (handoffId: string, sessionId: string | null, replace = false) => {
      void navigate({
        to: "/workspaces/$workspaceId/handoffs/$handoffId",
        params: {
          workspaceId,
          handoffId,
        },
        search: { sessionId: sessionId ?? undefined },
        ...(replace ? { replace: true } : {}),
      });
    },
    [navigate, workspaceId],
  );

  useEffect(() => {
    if (!activeHandoff) {
      return;
    }

    const resolvedRouteSessionId = sanitizeLastAgentTabId(activeHandoff, selectedSessionId);
    if (!resolvedRouteSessionId) {
      return;
    }

    if (selectedSessionId !== resolvedRouteSessionId) {
      syncRouteSession(activeHandoff.id, resolvedRouteSessionId, true);
      return;
    }

    if (lastAgentTabIdByHandoff[activeHandoff.id] === resolvedRouteSessionId) {
      return;
    }

    setLastAgentTabIdByHandoff((current) => ({
      ...current,
      [activeHandoff.id]: resolvedRouteSessionId,
    }));
    setActiveTabIdByHandoff((current) => {
      const currentActive = current[activeHandoff.id];
      if (currentActive && isDiffTab(currentActive)) {
        return current;
      }

      return {
        ...current,
        [activeHandoff.id]: resolvedRouteSessionId,
      };
    });
  }, [activeHandoff, lastAgentTabIdByHandoff, selectedSessionId, syncRouteSession]);

  const createHandoff = useCallback(() => {
    void (async () => {
      const repoId = activeHandoff?.repoId ?? viewModel.repos[0]?.id ?? "";
      if (!repoId) {
        throw new Error("Cannot create a task without an available repo");
      }

      const task = window.prompt("Describe the task", "Investigate and implement the requested change");
      if (!task) {
        return;
      }

      const title = window.prompt("Optional task title", "")?.trim() || undefined;
      const branch = window.prompt("Optional branch name", "")?.trim() || undefined;
      const { handoffId, tabId } = await handoffWorkbenchClient.createHandoff({
        repoId,
        task,
        model: "gpt-4o",
        ...(title ? { title } : {}),
        ...(branch ? { branch } : {}),
      });
      await navigate({
        to: "/workspaces/$workspaceId/handoffs/$handoffId",
        params: {
          workspaceId,
          handoffId,
        },
        search: { sessionId: tabId ?? undefined },
      });
    })();
  }, [activeHandoff?.repoId, navigate, viewModel.repos, workspaceId]);

  const openDiffTab = useCallback(
    (path: string) => {
      if (!activeHandoff) {
        throw new Error("Cannot open a diff tab without an active task");
      }
      setOpenDiffsByHandoff((current) => {
        const existing = sanitizeOpenDiffs(activeHandoff, current[activeHandoff.id]);
        if (existing.includes(path)) {
          return current;
        }

        return {
          ...current,
          [activeHandoff.id]: [...existing, path],
        };
      });
      setActiveTabIdByHandoff((current) => ({
        ...current,
        [activeHandoff.id]: diffTabId(path),
      }));
    },
    [activeHandoff],
  );

  const selectHandoff = useCallback(
    (id: string) => {
      const handoff = handoffs.find((candidate) => candidate.id === id) ?? null;
      void navigate({
        to: "/workspaces/$workspaceId/handoffs/$handoffId",
        params: {
          workspaceId,
          handoffId: id,
        },
        search: { sessionId: handoff?.tabs[0]?.id ?? undefined },
      });
    },
    [handoffs, navigate, workspaceId],
  );

  const markHandoffUnread = useCallback((id: string) => {
    void handoffWorkbenchClient.markHandoffUnread({ handoffId: id });
  }, []);

  const renameHandoff = useCallback(
    (id: string) => {
      const currentHandoff = handoffs.find((handoff) => handoff.id === id);
      if (!currentHandoff) {
        throw new Error(`Unable to rename missing task ${id}`);
      }

      const nextTitle = window.prompt("Rename task", currentHandoff.title);
      if (nextTitle === null) {
        return;
      }

      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle) {
        return;
      }

      void handoffWorkbenchClient.renameHandoff({ handoffId: id, value: trimmedTitle });
    },
    [handoffs],
  );

  const renameBranch = useCallback(
    (id: string) => {
      const currentHandoff = handoffs.find((handoff) => handoff.id === id);
      if (!currentHandoff) {
        throw new Error(`Unable to rename missing task ${id}`);
      }

      const nextBranch = window.prompt("Rename branch", currentHandoff.branch ?? "");
      if (nextBranch === null) {
        return;
      }

      const trimmedBranch = nextBranch.trim();
      if (!trimmedBranch) {
        return;
      }

      void handoffWorkbenchClient.renameBranch({ handoffId: id, value: trimmedBranch });
    },
    [handoffs],
  );

  const archiveHandoff = useCallback(() => {
    if (!activeHandoff) {
      throw new Error("Cannot archive without an active task");
    }
    void handoffWorkbenchClient.archiveHandoff({ handoffId: activeHandoff.id });
  }, [activeHandoff]);

  const publishPr = useCallback(() => {
    if (!activeHandoff) {
      throw new Error("Cannot publish PR without an active task");
    }
    void handoffWorkbenchClient.publishPr({ handoffId: activeHandoff.id });
  }, [activeHandoff]);

  const revertFile = useCallback(
    (path: string) => {
      if (!activeHandoff) {
        throw new Error("Cannot revert a file without an active task");
      }
      setOpenDiffsByHandoff((current) => ({
        ...current,
        [activeHandoff.id]: sanitizeOpenDiffs(activeHandoff, current[activeHandoff.id]).filter((candidate) => candidate !== path),
      }));
      setActiveTabIdByHandoff((current) => ({
        ...current,
        [activeHandoff.id]:
          current[activeHandoff.id] === diffTabId(path)
            ? sanitizeLastAgentTabId(activeHandoff, lastAgentTabIdByHandoff[activeHandoff.id])
            : (current[activeHandoff.id] ?? null),
      }));

      void handoffWorkbenchClient.revertFile({
        handoffId: activeHandoff.id,
        path,
      });
    },
    [activeHandoff, lastAgentTabIdByHandoff],
  );

  const dismissStarRepoPrompt = useCallback(() => {
    setStarRepoError(null);
    try {
      globalThis.localStorage?.setItem(STAR_SANDBOX_AGENT_REPO_STORAGE_KEY, "dismissed");
    } catch {
      // ignore storage failures
    }
    setStarRepoPromptOpen(false);
  }, []);

  const starSandboxAgentRepo = useCallback(() => {
    setStarRepoPending(true);
    setStarRepoError(null);
    void backendClient
      .starSandboxAgentRepo(workspaceId)
      .then(() => {
        try {
          globalThis.localStorage?.setItem(STAR_SANDBOX_AGENT_REPO_STORAGE_KEY, "completed");
        } catch {
          // ignore storage failures
        }
        setStarRepoPromptOpen(false);
      })
      .catch((error) => {
        setStarRepoError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setStarRepoPending(false);
      });
  }, [workspaceId]);

  const starRepoPrompt = starRepoPromptOpen ? (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "rgba(0, 0, 0, 0.68)",
      }}
      data-testid="onboarding-star-repo-modal"
    >
      <div
        style={{
          width: "min(440px, 100%)",
          border: "1px solid rgba(255, 255, 255, 0.10)",
          borderRadius: "12px",
          background: "rgba(24, 24, 27, 0.98)",
          backdropFilter: "blur(16px)",
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04)",
          padding: "28px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ fontSize: "11px", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600, color: "rgba(255, 255, 255, 0.4)" }}>
            Welcome to Foundry
          </div>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 500, lineHeight: 1.3 }}>Support Sandbox Agent</h2>
          <p style={{ margin: 0, color: "rgba(255, 255, 255, 0.55)", fontSize: "13px", lineHeight: 1.6 }}>
            Star the repo to help us grow and stay up to date with new releases.
          </p>
        </div>

        {starRepoError ? (
          <div
            style={{
              borderRadius: "8px",
              border: "1px solid rgba(255, 110, 110, 0.24)",
              background: "rgba(255, 110, 110, 0.06)",
              padding: "10px 12px",
              color: "#ff9b9b",
              fontSize: "12px",
            }}
            data-testid="onboarding-star-repo-error"
          >
            {starRepoError}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            type="button"
            onClick={dismissStarRepoPrompt}
            style={{
              border: "1px solid rgba(255, 255, 255, 0.10)",
              borderRadius: "6px",
              padding: "8px 14px",
              background: "rgba(255, 255, 255, 0.05)",
              color: "rgba(255, 255, 255, 0.7)",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 500,
              transition: "all 160ms ease",
            }}
          >
            Maybe later
          </button>
          <button
            type="button"
            onClick={starSandboxAgentRepo}
            disabled={starRepoPending}
            style={{
              border: 0,
              borderRadius: "6px",
              padding: "8px 14px",
              background: starRepoPending ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.12)",
              color: "#e4e4e7",
              cursor: starRepoPending ? "progress" : "pointer",
              fontSize: "12px",
              fontWeight: 600,
              transition: "all 160ms ease",
            }}
            data-testid="onboarding-star-repo-submit"
          >
            {starRepoPending ? "Starring..." : "Star the repo"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (!activeHandoff) {
    return (
      <>
        <Shell>
          <div style={{ width: `${leftWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Sidebar
              projects={projects}
              activeId=""
              onSelect={selectHandoff}
              onCreate={createHandoff}
              onMarkUnread={markHandoffUnread}
              onRenameHandoff={renameHandoff}
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
                    onClick={createHandoff}
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
        {starRepoPrompt}
      </>
    );
  }

  return (
    <>
      <Shell>
        <div style={{ width: `${leftWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Sidebar
            projects={projects}
            activeId={activeHandoff.id}
            onSelect={selectHandoff}
            onCreate={createHandoff}
            onMarkUnread={markHandoffUnread}
            onRenameHandoff={renameHandoff}
            onRenameBranch={renameBranch}
            onReorderProjects={reorderProjects}
          />
        </div>
        <PanelResizeHandle onResizeStart={onLeftResizeStart} onResize={onLeftResize} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <TranscriptPanel
            handoff={activeHandoff}
            activeTabId={activeTabId}
            lastAgentTabId={lastAgentTabId}
            openDiffs={openDiffs}
            onSyncRouteSession={syncRouteSession}
            onSetActiveTabId={(tabId) => {
              setActiveTabIdByHandoff((current) => ({ ...current, [activeHandoff.id]: tabId }));
            }}
            onSetLastAgentTabId={(tabId) => {
              setLastAgentTabIdByHandoff((current) => ({ ...current, [activeHandoff.id]: tabId }));
            }}
            onSetOpenDiffs={(paths) => {
              setOpenDiffsByHandoff((current) => ({ ...current, [activeHandoff.id]: paths }));
            }}
          />
        </div>
        <PanelResizeHandle onResizeStart={onRightResizeStart} onResize={onRightResize} />
        <div style={{ width: `${rightWidth}px`, flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <RightRail
            workspaceId={workspaceId}
            handoff={activeHandoff}
            activeTabId={activeTabId}
            onOpenDiff={openDiffTab}
            onArchive={archiveHandoff}
            onRevertFile={revertFile}
            onPublishPr={publishPr}
          />
        </div>
      </Shell>
      {starRepoPrompt}
    </>
  );
}
