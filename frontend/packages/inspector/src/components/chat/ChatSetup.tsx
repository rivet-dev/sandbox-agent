import type { AgentModeInfo } from "sandbox-agent";

const ChatSetup = ({
  agentMode,
  permissionMode,
  model,
  variant,
  activeModes,
  hasSession,
  modesLoading,
  modesError,
  onAgentModeChange,
  onPermissionModeChange,
  onModelChange,
  onVariantChange
}: {
  agentMode: string;
  permissionMode: string;
  model: string;
  variant: string;
  activeModes: AgentModeInfo[];
  hasSession: boolean;
  modesLoading: boolean;
  modesError: string | null;
  onAgentModeChange: (value: string) => void;
  onPermissionModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onVariantChange: (value: string) => void;
}) => {
  return (
    <div className="setup-row">
      <select
        className="setup-select"
        value={agentMode}
        onChange={(e) => onAgentModeChange(e.target.value)}
        title="Mode"
        disabled={!hasSession || modesLoading || Boolean(modesError)}
      >
        {modesLoading ? (
          <option value="">Loading modes...</option>
        ) : modesError ? (
          <option value="">{modesError}</option>
        ) : activeModes.length > 0 ? (
          activeModes.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.name || mode.id}
            </option>
          ))
        ) : (
          <option value="">Mode</option>
        )}
      </select>

      <select
        className="setup-select"
        value={permissionMode}
        onChange={(e) => onPermissionModeChange(e.target.value)}
        title="Permission Mode"
        disabled={!hasSession}
      >
        <option value="default">Default</option>
        <option value="plan">Plan</option>
        <option value="bypass">Bypass</option>
      </select>

      <input
        className="setup-input"
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
        placeholder="Model"
        title="Model"
        disabled={!hasSession}
      />

      <input
        className="setup-input"
        value={variant}
        onChange={(e) => onVariantChange(e.target.value)}
        placeholder="Variant"
        title="Variant"
        disabled={!hasSession}
      />
    </div>
  );
};

export default ChatSetup;
