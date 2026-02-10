import { MessageSquare, Plus, Square, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { McpServerEntry } from "../../App";
import type {
  AgentInfo,
  AgentModelInfo,
  AgentModeInfo,
  PermissionEventData,
  QuestionEventData,
  SkillSource
} from "../../types/legacyApi";
import ApprovalsTab from "../debug/ApprovalsTab";
import SessionCreateMenu, { type SessionConfig } from "../SessionCreateMenu";
import ChatInput from "./ChatInput";
import ChatMessages from "./ChatMessages";
import type { TimelineEntry } from "./types";

const ChatPanel = ({
  sessionId,
  transcriptEntries,
  sessionError,
  message,
  onMessageChange,
  onSendMessage,
  onKeyDown,
  onCreateSession,
  onSelectAgent,
  agents,
  agentsLoading,
  agentsError,
  messagesEndRef,
  agentLabel,
  currentAgentVersion,
  sessionModel,
  sessionVariant,
  sessionPermissionMode,
  sessionMcpServerCount,
  sessionSkillSourceCount,
  onEndSession,
  eventError,
  questionRequests,
  permissionRequests,
  questionSelections,
  onSelectQuestionOption,
  onAnswerQuestion,
  onRejectQuestion,
  onReplyPermission,
  modesByAgent,
  modelsByAgent,
  defaultModelByAgent,
  modesLoadingByAgent,
  modelsLoadingByAgent,
  modesErrorByAgent,
  modelsErrorByAgent,
  mcpServers,
  onMcpServersChange,
  mcpConfigError,
  skillSources,
  onSkillSourcesChange
}: {
  sessionId: string;
  transcriptEntries: TimelineEntry[];
  sessionError: string | null;
  message: string;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCreateSession: (agentId: string, config: SessionConfig) => void;
  onSelectAgent: (agentId: string) => void;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  agentLabel: string;
  currentAgentVersion?: string | null;
  sessionModel?: string | null;
  sessionVariant?: string | null;
  sessionPermissionMode?: string | null;
  sessionMcpServerCount: number;
  sessionSkillSourceCount: number;
  onEndSession: () => void;
  eventError: string | null;
  questionRequests: QuestionEventData[];
  permissionRequests: PermissionEventData[];
  questionSelections: Record<string, string[][]>;
  onSelectQuestionOption: (requestId: string, optionLabel: string) => void;
  onAnswerQuestion: (request: QuestionEventData) => void;
  onRejectQuestion: (requestId: string) => void;
  onReplyPermission: (requestId: string, reply: "once" | "always" | "reject") => void;
  modesByAgent: Record<string, AgentModeInfo[]>;
  modelsByAgent: Record<string, AgentModelInfo[]>;
  defaultModelByAgent: Record<string, string>;
  modesLoadingByAgent: Record<string, boolean>;
  modelsLoadingByAgent: Record<string, boolean>;
  modesErrorByAgent: Record<string, string | null>;
  modelsErrorByAgent: Record<string, string | null>;
  mcpServers: McpServerEntry[];
  onMcpServersChange: (servers: McpServerEntry[]) => void;
  mcpConfigError: string | null;
  skillSources: SkillSource[];
  onSkillSourcesChange: (sources: SkillSource[]) => void;
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

  const hasApprovals = questionRequests.length > 0 || permissionRequests.length > 0;

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <MessageSquare className="button-icon" />
          <span className="panel-title">{sessionId ? "Session" : "No Session"}</span>
          {sessionId && <span className="session-id-display">{sessionId}</span>}
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
              <SessionCreateMenu
                agents={agents}
                agentsLoading={agentsLoading}
                agentsError={agentsError}
                modesByAgent={modesByAgent}
                modelsByAgent={modelsByAgent}
                defaultModelByAgent={defaultModelByAgent}
                modesLoadingByAgent={modesLoadingByAgent}
                modelsLoadingByAgent={modelsLoadingByAgent}
                modesErrorByAgent={modesErrorByAgent}
                modelsErrorByAgent={modelsErrorByAgent}
                mcpServers={mcpServers}
                onMcpServersChange={onMcpServersChange}
                mcpConfigError={mcpConfigError}
                skillSources={skillSources}
                onSkillSourcesChange={onSkillSourcesChange}
                onSelectAgent={onSelectAgent}
                onCreateSession={onCreateSession}
                open={showAgentMenu}
                onClose={() => setShowAgentMenu(false)}
              />
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
        disabled={!sessionId}
      />

      {sessionId && (
        <div className="session-config-bar">
          <div className="session-config-field">
            <span className="session-config-label">Agent</span>
            <span className="session-config-value">{agentLabel}</span>
          </div>
          <div className="session-config-field">
            <span className="session-config-label">Model</span>
            <span className="session-config-value">{sessionModel || "-"}</span>
          </div>
          <div className="session-config-field">
            <span className="session-config-label">Variant</span>
            <span className="session-config-value">{sessionVariant || "-"}</span>
          </div>
          <div className="session-config-field">
            <span className="session-config-label">Permission</span>
            <span className="session-config-value">{sessionPermissionMode || "-"}</span>
          </div>
          <div className="session-config-field">
            <span className="session-config-label">MCP Servers</span>
            <span className="session-config-value">{sessionMcpServerCount}</span>
          </div>
          <div className="session-config-field">
            <span className="session-config-label">Skills</span>
            <span className="session-config-value">{sessionSkillSourceCount}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatPanel;
