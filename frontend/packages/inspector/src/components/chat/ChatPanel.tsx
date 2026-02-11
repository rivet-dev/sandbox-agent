import { CheckSquare, MessageSquare, Plus, Square, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentInfo } from "sandbox-agent";

type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };
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
  sessionEnded,
  onEndSession,
  modesByAgent,
  modelsByAgent,
  defaultModelByAgent,
}: {
  sessionId: string;
  transcriptEntries: TimelineEntry[];
  sessionError: string | null;
  message: string;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCreateSession: (agentId: string, config: SessionConfig) => void;
  onSelectAgent: (agentId: string) => Promise<void>;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  agentLabel: string;
  currentAgentVersion?: string | null;
  sessionEnded: boolean;
  onEndSession: () => void;
  modesByAgent: Record<string, AgentModeInfo[]>;
  modelsByAgent: Record<string, AgentModelInfo[]>;
  defaultModelByAgent: Record<string, string>;
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
            sessionEnded ? (
              <span className="button ghost small" style={{ opacity: 0.5, cursor: "default" }} title="Session ended">
                <CheckSquare size={12} />
                Ended
              </span>
            ) : (
              <button
                type="button"
                className="button ghost small"
                onClick={onEndSession}
                title="End session"
              >
                <Square size={12} />
                End
              </button>
            )
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
                onCreateSession={onCreateSession}
                onSelectAgent={onSelectAgent}
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
            messagesEndRef={messagesEndRef}
          />
        )}
      </div>

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
          {currentAgentVersion && (
            <div className="session-config-field">
              <span className="session-config-label">Version</span>
              <span className="session-config-value">{currentAgentVersion}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatPanel;
