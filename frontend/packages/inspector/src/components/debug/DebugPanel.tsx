import { Cloud, PlayCircle, Terminal, Cpu } from "lucide-react";
import type { AgentInfo, AgentModeInfo, UniversalEvent } from "sandbox-agent";
import AgentsTab from "./AgentsTab";
import EventsTab from "./EventsTab";
import ProcessesTab from "./ProcessesTab";
import RequestLogTab from "./RequestLogTab";
import type { RequestLog } from "../../types/requestLog";

export type DebugTab = "log" | "events" | "agents" | "processes";

const DebugPanel = ({
  debugTab,
  onDebugTabChange,
  events,
  offset,
  onResetEvents,
  eventsError,
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
  baseUrl,
  token
}: {
  debugTab: DebugTab;
  onDebugTabChange: (tab: DebugTab) => void;
  events: UniversalEvent[];
  offset: number;
  onResetEvents: () => void;
  eventsError: string | null;
  requestLog: RequestLog[];
  copiedLogId: number | null;
  onClearRequestLog: () => void;
  onCopyRequestLog: (entry: RequestLog) => void;
  agents: AgentInfo[];
  defaultAgents: string[];
  modesByAgent: Record<string, AgentModeInfo[]>;
  onRefreshAgents: () => void;
  onInstallAgent: (agentId: string, reinstall: boolean) => void;
  agentsLoading: boolean;
  agentsError: string | null;
  baseUrl: string;
  token?: string;
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
        <button className={`debug-tab ${debugTab === "processes" ? "active" : ""}`} onClick={() => onDebugTabChange("processes")}>
          <Cpu className="button-icon" style={{ marginRight: 4, width: 12, height: 12 }} />
          Processes
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
            offset={offset}
            onClear={onResetEvents}
            error={eventsError}
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

        {debugTab === "processes" && (
          <ProcessesTab
            baseUrl={baseUrl}
            token={token}
          />
        )}
      </div>
    </div>
  );
};

export default DebugPanel;
