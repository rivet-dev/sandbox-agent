import { Download, RefreshCw } from "lucide-react";
import type { AgentInfo, AgentModeInfo } from "sandbox-agent";
import CapabilityBadges from "../agents/CapabilityBadges";
import { emptyCapabilities } from "../../types/agents";

const AgentsTab = ({
  agents,
  defaultAgents,
  modesByAgent,
  onRefresh,
  onInstall,
  loading,
  error
}: {
  agents: AgentInfo[];
  defaultAgents: string[];
  modesByAgent: Record<string, AgentModeInfo[]>;
  onRefresh: () => void;
  onInstall: (agentId: string, reinstall: boolean) => void;
  loading: boolean;
  error: string | null;
}) => {
  return (
    <>
      <div className="inline-row" style={{ marginBottom: 16 }}>
        <button className="button secondary small" onClick={onRefresh} disabled={loading}>
          <RefreshCw className="button-icon" /> Refresh
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && <div className="card-meta">Loading agents...</div>}
      {!loading && agents.length === 0 && (
        <div className="card-meta">No agents reported. Click refresh to check.</div>
      )}

      {(agents.length
        ? agents
        : defaultAgents.map((id) => ({
            id,
            installed: false,
            version: undefined,
            path: undefined,
            capabilities: emptyCapabilities
          }))).map((agent) => (
        <div key={agent.id} className="card">
          <div className="card-header">
            <span className="card-title">{agent.id}</span>
            <span className={`pill ${agent.installed ? "success" : "danger"}`}>
              {agent.installed ? "Installed" : "Missing"}
            </span>
          </div>
          <div className="card-meta">
            {agent.version ? `v${agent.version}` : "Version unknown"}
            {agent.path && <span className="mono muted" style={{ marginLeft: 8 }}>{agent.path}</span>}
          </div>
          <div style={{ marginTop: 8 }}>
            <CapabilityBadges capabilities={agent.capabilities ?? emptyCapabilities} />
          </div>
          {modesByAgent[agent.id] && modesByAgent[agent.id].length > 0 && (
            <div className="card-meta" style={{ marginTop: 8 }}>
              Modes: {modesByAgent[agent.id].map((mode) => mode.id).join(", ")}
            </div>
          )}
          <div className="card-actions">
            <button className="button secondary small" onClick={() => onInstall(agent.id, false)}>
              <Download className="button-icon" /> Install
            </button>
            <button className="button ghost small" onClick={() => onInstall(agent.id, true)}>
              Reinstall
            </button>
          </div>
        </div>
      ))}
    </>
  );
};

export default AgentsTab;
