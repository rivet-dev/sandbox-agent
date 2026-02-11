import { Cloud, PlayCircle, Server, Terminal, Wrench } from "lucide-react";
import type { AgentInfo, SandboxAgent, SessionEvent } from "sandbox-agent";

type AgentModeInfo = { id: string; name: string; description: string };
import AgentsTab from "./AgentsTab";
import EventsTab from "./EventsTab";
import McpTab from "./McpTab";
import SkillsTab from "./SkillsTab";
import RequestLogTab from "./RequestLogTab";
import type { RequestLog } from "../../types/requestLog";

export type DebugTab = "log" | "events" | "agents" | "mcp" | "skills";

const DebugPanel = ({
  debugTab,
  onDebugTabChange,
  events,
  onResetEvents,
  requestLog,
  copiedLogId,
  onClearRequestLog,
  onCopyRequestLog,
  agents,
  defaultAgents,
  modesByAgent,
  onRefreshAgents,
  onInstallAgent,
  agentsLoading,
  agentsError,
  getClient,
}: {
  debugTab: DebugTab;
  onDebugTabChange: (tab: DebugTab) => void;
  events: SessionEvent[];
  onResetEvents: () => void;
  requestLog: RequestLog[];
  copiedLogId: number | null;
  onClearRequestLog: () => void;
  onCopyRequestLog: (entry: RequestLog) => void;
  agents: AgentInfo[];
  defaultAgents: string[];
  modesByAgent: Record<string, AgentModeInfo[]>;
  onRefreshAgents: () => void;
  onInstallAgent: (agentId: string, reinstall: boolean) => Promise<void>;
  agentsLoading: boolean;
  agentsError: string | null;
  getClient: () => SandboxAgent;
}) => {
  return (
    <div className="debug-panel">
      <div className="debug-tabs">
        <button className={`debug-tab ${debugTab === "events" ? "active" : ""}`} onClick={() => onDebugTabChange("events")}>
          <PlayCircle className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
          Events
          {events.length > 0 && <span className="debug-tab-badge">{events.length}</span>}
        </button>
        <button className={`debug-tab ${debugTab === "log" ? "active" : ""}`} onClick={() => onDebugTabChange("log")}>
          <Terminal className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
          Request Log
        </button>
        <button className={`debug-tab ${debugTab === "agents" ? "active" : ""}`} onClick={() => onDebugTabChange("agents")}>
          <Cloud className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
          Agents
        </button>
        <button className={`debug-tab ${debugTab === "mcp" ? "active" : ""}`} onClick={() => onDebugTabChange("mcp")}>
          <Server className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
          MCP
        </button>
        <button className={`debug-tab ${debugTab === "skills" ? "active" : ""}`} onClick={() => onDebugTabChange("skills")}>
          <Wrench className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
          Skills
        </button>
      </div>

      <div className="debug-content">
        {debugTab === "log" && (
          <RequestLogTab
            requestLog={requestLog}
            copiedLogId={copiedLogId}
            onClear={onClearRequestLog}
            onCopy={onCopyRequestLog}
          />
        )}

        {debugTab === "events" && (
          <EventsTab
            events={events}
            onClear={onResetEvents}
          />
        )}

        {debugTab === "agents" && (
          <AgentsTab
            agents={agents}
            defaultAgents={defaultAgents}
            modesByAgent={modesByAgent}
            onRefresh={onRefreshAgents}
            onInstall={onInstallAgent}
            loading={agentsLoading}
            error={agentsError}
          />
        )}

        {debugTab === "mcp" && (
          <McpTab getClient={getClient} />
        )}

        {debugTab === "skills" && (
          <SkillsTab getClient={getClient} />
        )}
      </div>
    </div>
  );
};

export default DebugPanel;
