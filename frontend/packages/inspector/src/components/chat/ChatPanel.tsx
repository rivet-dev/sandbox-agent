import { MessageSquare, PauseCircle, PlayCircle, Plus, Square, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentInfo, AgentModelInfo, AgentModeInfo, PermissionEventData, QuestionEventData } from "sandbox-agent";
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
  agents,
  agentsLoading,
  agentsError,
  messagesEndRef,
  agentId,
  agentLabel,
  agentMode,
  permissionMode,
  model,
  variant,
  modelOptions,
  defaultModel,
  modelsLoading,
  modelsError,
  variantOptions,
  defaultVariant,
  supportsVariants,
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
  onEndSession,
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
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  agentId: string;
  agentLabel: string;
  agentMode: string;
  permissionMode: string;
  model: string;
  variant: string;
  modelOptions: AgentModelInfo[];
  defaultModel: string;
  modelsLoading: boolean;
  modelsError: string | null;
  variantOptions: string[];
  defaultVariant: string;
  supportsVariants: boolean;
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
  onEndSession: () => void;
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
          {sessionId && (
            <button
              type="button"
              className="button ghost small"
              onClick={onEndSession}
              title="End session"
            >
              <Square size={12} />
              End
            </button>
          )}
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
                  {!agentsLoading && !agentsError && agents.length === 0 && (
                    <div className="sidebar-add-status">No agents available.</div>
                  )}
                  {!agentsLoading && !agentsError &&
                    agents.map((agent) => (
                      <button
                        key={agent.id}
                        className="sidebar-add-option"
                        onClick={() => {
                          onCreateSession(agent.id);
                          setShowAgentMenu(false);
                        }}
                      >
                        <div className="agent-option-left">
                          <span className="agent-option-name">{agentLabels[agent.id] ?? agent.id}</span>
                          {agent.version && <span className="agent-badge version">v{agent.version}</span>}
                        </div>
                        {agent.installed && <span className="agent-badge installed">Installed</span>}
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
            {agentId === "mock" && (
              <div className="mock-agent-hint">
                The mock agent simulates agent responses for testing the inspector UI without requiring API credentials. Send <code>help</code> for available commands.
              </div>
            )}
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
        modelOptions={modelOptions}
        defaultModel={defaultModel}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        variantOptions={variantOptions}
        defaultVariant={defaultVariant}
        supportsVariants={supportsVariants}
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
