import type { AgentModelInfo, AgentModeInfo } from "sandbox-agent";

const ChatSetup = ({
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
  modelOptions: AgentModelInfo[];
  defaultModel: string;
  modelsLoading: boolean;
  modelsError: string | null;
  variantOptions: string[];
  defaultVariant: string;
  supportsVariants: boolean;
  activeModes: AgentModeInfo[];
  hasSession: boolean;
  modesLoading: boolean;
  modesError: string | null;
  onAgentModeChange: (value: string) => void;
  onPermissionModeChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onVariantChange: (value: string) => void;
}) => {
  const showModelSelect = modelsLoading || Boolean(modelsError) || modelOptions.length > 0;
  const hasModelOptions = modelOptions.length > 0;
  const showVariantSelect =
    supportsVariants && (modelsLoading || Boolean(modelsError) || variantOptions.length > 0);
  const hasVariantOptions = variantOptions.length > 0;
  const modelCustom =
    model && hasModelOptions && !modelOptions.some((entry) => entry.id === model);
  const variantCustom =
    variant && hasVariantOptions && !variantOptions.includes(variant);

  return (
    <div className="setup-row">
      <div className="setup-field">
        <span className="setup-label">Mode</span>
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
      </div>

      <div className="setup-field">
        <span className="setup-label">Permission</span>
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
      </div>

      <div className="setup-field">
        <span className="setup-label">Model</span>
        {showModelSelect ? (
          <select
            className="setup-select"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            title="Model"
            disabled={!hasSession || modelsLoading || Boolean(modelsError)}
          >
            {modelsLoading ? (
              <option value="">Loading models...</option>
            ) : modelsError ? (
              <option value="">{modelsError}</option>
            ) : (
              <>
                <option value="">
                  {defaultModel ? `Default (${defaultModel})` : "Default"}
                </option>
                {modelCustom && <option value={model}>{model} (custom)</option>}
                {modelOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name ?? entry.id}
                  </option>
                ))}
              </>
            )}
          </select>
        ) : (
          <input
            className="setup-input"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="Model"
            title="Model"
            disabled={!hasSession}
          />
        )}
      </div>

      <div className="setup-field">
        <span className="setup-label">Variant</span>
        {showVariantSelect ? (
          <select
            className="setup-select"
            value={variant}
            onChange={(e) => onVariantChange(e.target.value)}
            title="Variant"
            disabled={!hasSession || !supportsVariants || modelsLoading || Boolean(modelsError)}
          >
            {modelsLoading ? (
              <option value="">Loading variants...</option>
            ) : modelsError ? (
              <option value="">{modelsError}</option>
            ) : (
              <>
                <option value="">
                  {defaultVariant ? `Default (${defaultVariant})` : "Default"}
                </option>
                {variantCustom && <option value={variant}>{variant} (custom)</option>}
                {variantOptions.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </>
            )}
          </select>
        ) : (
          <input
            className="setup-input"
            value={variant}
            onChange={(e) => onVariantChange(e.target.value)}
            placeholder={supportsVariants ? "Variant" : "Variants unsupported"}
            title="Variant"
            disabled={!hasSession || !supportsVariants}
          />
        )}
      </div>
    </div>
  );
};

export default ChatSetup;
