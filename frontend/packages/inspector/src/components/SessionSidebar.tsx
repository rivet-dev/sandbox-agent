import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentInfo } from "sandbox-agent";

type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };
import SessionCreateMenu, { type SessionConfig } from "./SessionCreateMenu";

type SessionListItem = {
  sessionId: string;
  agent: string;
  ended: boolean;
};

const agentLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "Pi",
  cursor: "Cursor"
};
const persistenceDocsUrl = "https://sandboxagent.dev/docs/session-persistence";

const SessionSidebar = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onRefresh,
  onCreateSession,
  onSelectAgent,
  agents,
  agentsLoading,
  agentsError,
  sessionsLoading,
  sessionsError,
  modesByAgent,
  modelsByAgent,
  defaultModelByAgent,
}: {
  sessions: SessionListItem[];
  selectedSessionId: string;
  onSelectSession: (session: SessionListItem) => void;
  onRefresh: () => void;
  onCreateSession: (agentId: string, config: SessionConfig) => void;
  onSelectAgent: (agentId: string) => Promise<void>;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
  sessionsLoading: boolean;
  sessionsError: string | null;
  modesByAgent: Record<string, AgentModeInfo[]>;
  modelsByAgent: Record<string, AgentModelInfo[]>;
  defaultModelByAgent: Record<string, string>;
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
            <SessionCreateMenu
              agents={agents}
              agentsLoading={agentsLoading}
              agentsError={agentsError}
              modesByAgent={modesByAgent}
              modelsByAgent={modelsByAgent}
              defaultModelByAgent={defaultModelByAgent}
              onCreateSession={onCreateSession}
              onSelectAgent={onSelectAgent}
              open={showMenu}
              onClose={() => setShowMenu(false)}
            />
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
                {session.ended && <span className="session-item-ended">ended</span>}
              </div>
            </button>
          ))
        )}
      </div>
      <div className="session-persistence-note">
        Sessions are persisted in your browser using IndexedDB.{" "}
        <a href={persistenceDocsUrl} target="_blank" rel="noreferrer">
          Configure persistence
        </a>
        .
      </div>
    </div>
  );
};

export default SessionSidebar;
