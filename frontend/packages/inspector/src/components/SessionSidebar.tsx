import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentInfo, SessionInfo } from "sandbox-agent";

const SessionSidebar = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onRefresh,
  onCreateSession,
  agents,
  agentsLoading,
  agentsError,
  sessionsLoading,
  sessionsError
}: {
  sessions: SessionInfo[];
  selectedSessionId: string;
  onSelectSession: (session: SessionInfo) => void;
  onRefresh: () => void;
  onCreateSession: (agentId: string) => void;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const agentLabels: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    amp: "Amp",
    pi: "Pi",
    mock: "Mock"
  };

  return (
    <div className="session-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <div className="sidebar-header-actions">
          <button className="sidebar-icon-btn" onClick={onRefresh} title="Refresh sessions">
            <RefreshCw size={14} />
          </button>
          <div className="sidebar-add-menu-wrapper" ref={menuRef}>
            <button
              className="sidebar-add-btn"
              onClick={() => setShowMenu((value) => !value)}
              title="New session"
            >
              <Plus size={14} />
            </button>
            {showMenu && (
              <div className="sidebar-add-menu">
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
                        setShowMenu(false);
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
      </div>

      <div className="session-list">
        {sessionsLoading ? (
          <div className="sidebar-empty">Loading sessions...</div>
        ) : sessionsError ? (
          <div className="sidebar-empty error">{sessionsError}</div>
        ) : sessions.length === 0 ? (
          <div className="sidebar-empty">No sessions yet.</div>
        ) : (
          sessions.map((session) => (
            <button
              key={session.sessionId}
              className={`session-item ${session.sessionId === selectedSessionId ? "active" : ""}`}
              onClick={() => onSelectSession(session)}
            >
              <div className="session-item-id">{session.sessionId}</div>
              <div className="session-item-meta">
                <span className="session-item-agent">{agentLabels[session.agent] ?? session.agent}</span>
                <span className="session-item-events">{session.eventCount} events</span>
                {session.ended && <span className="session-item-ended">ended</span>}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

export default SessionSidebar;
