import { MessageSquare, PauseCircle, PlayCircle, Plus, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentModeInfo, PermissionEventData, QuestionEventData } from "sandbox-agent";
import ApprovalsTab from "../debug/ApprovalsTab";
import ChatInput from "./ChatInput";
import ChatMessages from "./ChatMessages";
import ChatSetup from "./ChatSetup";
import type { TimelineEntry } from "./types";

const ChatPanel = ({
  sessionId,
  polling,
  turnStreaming,
  transcriptEntries,
  sessionError,
  message,
  onMessageChange,
  onSendMessage,
  onKeyDown,
  onCreateSession,
  availableAgents,
  agentsLoading,
  agentsError,
  messagesEndRef,
  agentLabel,
  agentMode,
  permissionMode,
  model,
  variant,
  streamMode,
  activeModes,
  currentAgentVersion,
  hasSession,
  modesLoading,
  modesError,
  onAgentModeChange,
  onPermissionModeChange,
  onModelChange,
  onVariantChange,
  onStreamModeChange,
  onToggleStream,
  eventError,
  questionRequests,
  permissionRequests,
  questionSelections,
  onSelectQuestionOption,
  onAnswerQuestion,
  onRejectQuestion,
  onReplyPermission
}: {
  sessionId: string;
  polling: boolean;
  turnStreaming: boolean;
  transcriptEntries: TimelineEntry[];
  sessionError: string | null;
  message: string;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCreateSession: (agentId: string) => void;
  availableAgents: string[];
  agentsLoading: boolean;
  agentsError: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  agentLabel: string;
  agentMode: string;
  permissionMode: string;
  model: string;
  variant: string;
  streamMode: "poll" | "sse" | "turn";
  activeModes: AgentModeInfo[];
  currentAgentVersion?: string | null;
  hasSession: boolean;
  modesLoading: boolean;
  modesError: string | null;
  onAgentModeChange: (value: string) => void;
  onPermissionModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onVariantChange: (value: string) => void;
  onStreamModeChange: (value: "poll" | "sse" | "turn") => void;
  onToggleStream: () => void;
  eventError: string | null;
  questionRequests: QuestionEventData[];
  permissionRequests: PermissionEventData[];
  questionSelections: Record<string, string[][]>;
  onSelectQuestionOption: (requestId: string, optionLabel: string) => void;
  onAnswerQuestion: (request: QuestionEventData) => void;
  onRejectQuestion: (requestId: string) => void;
  onReplyPermission: (requestId: string, reply: "once" | "always" | "reject") => void;
}) => {
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAgentMenu) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setShowAgentMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAgentMenu]);

  const agentLabels: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    amp: "Amp",
    mock: "Mock"
  };

  const hasApprovals = questionRequests.length > 0 || permissionRequests.length > 0;
  const isTurnMode = streamMode === "turn";
  const isStreaming = isTurnMode ? turnStreaming : polling;
  const turnLabel = turnStreaming ? "Streaming" : "On Send";

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <MessageSquare className="button-icon" />
          <span className="panel-title">{sessionId ? "Session" : "No Session"}</span>
          {sessionId && <span className="session-id-display">{sessionId}</span>}
          {sessionId && (
            <span className="session-agent-display">
              {agentLabel}
              {currentAgentVersion && <span className="session-agent-version">v{currentAgentVersion}</span>}
            </span>
          )}
        </div>
        <div className="panel-header-right">
          <div className="setup-stream">
            <select
              className="setup-select-small"
              value={streamMode}
              onChange={(e) => onStreamModeChange(e.target.value as "poll" | "sse" | "turn")}
              title="Stream Mode"
              disabled={!sessionId}
            >
              <option value="poll">Poll</option>
              <option value="sse">SSE</option>
              <option value="turn">Turn</option>
            </select>
            <button
              className={`setup-stream-btn ${isStreaming ? "active" : ""}`}
              onClick={onToggleStream}
              title={isTurnMode ? "Turn streaming starts on send" : polling ? "Stop streaming" : "Start streaming"}
              disabled={!sessionId || isTurnMode}
            >
              {isTurnMode ? (
                <>
                  <PlayCircle size={14} />
                  <span>{turnLabel}</span>
                </>
              ) : polling ? (
                <>
                  <PauseCircle size={14} />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <PlayCircle size={14} />
                  <span>Resume</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="messages-container">
        {!sessionId ? (
          <div className="empty-state">
            <MessageSquare className="empty-state-icon" />
            <div className="empty-state-title">No Session Selected</div>
            <p className="empty-state-text">Create a new session to start chatting with an agent.</p>
            <div className="empty-state-menu-wrapper" ref={menuRef}>
              <button
                className="button primary"
                onClick={() => setShowAgentMenu((value) => !value)}
              >
                <Plus className="button-icon" />
                Create Session
              </button>
              {showAgentMenu && (
                <div className="empty-state-menu">
                  {agentsLoading && <div className="sidebar-add-status">Loading agents...</div>}
                  {agentsError && <div className="sidebar-add-status error">{agentsError}</div>}
                  {!agentsLoading && !agentsError && availableAgents.length === 0 && (
                    <div className="sidebar-add-status">No agents available.</div>
                  )}
                  {!agentsLoading && !agentsError &&
                    availableAgents.map((id) => (
                      <button
                        key={id}
                        className="sidebar-add-option"
                        onClick={() => {
                          onCreateSession(id);
                          setShowAgentMenu(false);
                        }}
                      >
                        {agentLabels[id] ?? id}
                      </button>
                    ))}
                </div>
              )}
            </div>
          </div>
        ) : transcriptEntries.length === 0 && !sessionError ? (
          <div className="empty-state">
            <Terminal className="empty-state-icon" />
            <div className="empty-state-title">Ready to Chat</div>
            <p className="empty-state-text">Send a message to start a conversation with the agent.</p>
          </div>
        ) : (
          <ChatMessages
            entries={transcriptEntries}
            sessionError={sessionError}
            eventError={eventError}
            messagesEndRef={messagesEndRef}
          />
        )}
      </div>

      {hasApprovals && (
        <div className="approvals-inline">
          <div className="approvals-inline-header">Approvals</div>
          <ApprovalsTab
            questionRequests={questionRequests}
            permissionRequests={permissionRequests}
            questionSelections={questionSelections}
            onSelectQuestionOption={onSelectQuestionOption}
            onAnswerQuestion={onAnswerQuestion}
            onRejectQuestion={onRejectQuestion}
            onReplyPermission={onReplyPermission}
          />
        </div>
      )}

      <ChatInput
        message={message}
        onMessageChange={onMessageChange}
        onSendMessage={onSendMessage}
        onKeyDown={onKeyDown}
        placeholder={sessionId ? "Send a message..." : "Select or create a session first"}
        disabled={!sessionId || turnStreaming}
      />

      <ChatSetup
        agentMode={agentMode}
        permissionMode={permissionMode}
        model={model}
        variant={variant}
        activeModes={activeModes}
        modesLoading={modesLoading}
        modesError={modesError}
        onAgentModeChange={onAgentModeChange}
        onPermissionModeChange={onPermissionModeChange}
        onModelChange={onModelChange}
        onVariantChange={onVariantChange}
        hasSession={hasSession}
      />
    </div>
  );
};

export default ChatPanel;
