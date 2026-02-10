import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { McpServerEntry } from "../App";
import type { AgentInfo, AgentModelInfo, AgentModeInfo, SkillSource } from "../types/legacyApi";

export type SessionConfig = {
  model: string;
  agentMode: string;
  permissionMode: string;
  variant: string;
};

const agentLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp"
};

const validateServerJson = (json: string): string | null => {
  const trimmed = json.trim();
  if (!trimmed) return "Config is required";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Must be a JSON object";
    }
    if (!parsed.type) return 'Missing "type" field';
    if (parsed.type !== "local" && parsed.type !== "remote") {
      return 'Type must be "local" or "remote"';
    }
    if (parsed.type === "local" && !parsed.command) return 'Local server requires "command"';
    if (parsed.type === "remote" && !parsed.url) return 'Remote server requires "url"';
    return null;
  } catch {
    return "Invalid JSON";
  }
};

const getServerType = (configJson: string): string | null => {
  try {
    const parsed = JSON.parse(configJson);
    return parsed?.type ?? null;
  } catch {
    return null;
  }
};

const getServerSummary = (configJson: string): string => {
  try {
    const parsed = JSON.parse(configJson);
    if (parsed?.type === "local") {
      const cmd = Array.isArray(parsed.command) ? parsed.command.join(" ") : parsed.command;
      return cmd ?? "local";
    }
    if (parsed?.type === "remote") {
      return parsed.url ?? "remote";
    }
    return parsed?.type ?? "";
  } catch {
    return "";
  }
};

const skillSourceSummary = (source: SkillSource): string => {
  let summary = source.source;
  if (source.skills && source.skills.length > 0) {
    summary += ` [${source.skills.join(", ")}]`;
  }
  return summary;
};

const SessionCreateMenu = ({
  agents,
  agentsLoading,
  agentsError,
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
  onSkillSourcesChange,
  onSelectAgent,
  onCreateSession,
  open,
  onClose
}: {
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentsError: string | null;
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
  onSelectAgent: (agentId: string) => void;
  onCreateSession: (agentId: string, config: SessionConfig) => void;
  open: boolean;
  onClose: () => void;
}) => {
  const [phase, setPhase] = useState<"agent" | "config">("agent");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [agentMode, setAgentMode] = useState("");
  const [permissionMode, setPermissionMode] = useState("default");
  const [model, setModel] = useState("");
  const [variant, setVariant] = useState("");

  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  // Skill add/edit state
  const [addingSkill, setAddingSkill] = useState(false);
  const [editingSkillIndex, setEditingSkillIndex] = useState<number | null>(null);
  const [skillType, setSkillType] = useState<"github" | "local" | "git">("github");
  const [skillSource, setSkillSource] = useState("");
  const [skillFilter, setSkillFilter] = useState("");
  const [skillRef, setSkillRef] = useState("");
  const [skillSubpath, setSkillSubpath] = useState("");
  const [skillLocalError, setSkillLocalError] = useState<string | null>(null);
  const skillSourceRef = useRef<HTMLInputElement>(null);

  // MCP add/edit state
  const [addingMcp, setAddingMcp] = useState(false);
  const [editingMcpIndex, setEditingMcpIndex] = useState<number | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpJson, setMcpJson] = useState("");
  const [mcpLocalError, setMcpLocalError] = useState<string | null>(null);
  const mcpNameRef = useRef<HTMLInputElement>(null);
  const mcpJsonRef = useRef<HTMLTextAreaElement>(null);

  const cancelSkillEdit = () => {
    setAddingSkill(false);
    setEditingSkillIndex(null);
    setSkillType("github");
    setSkillSource("");
    setSkillFilter("");
    setSkillRef("");
    setSkillSubpath("");
    setSkillLocalError(null);
  };

  // Reset state when menu closes
  useEffect(() => {
    if (!open) {
      setPhase("agent");
      setSelectedAgent("");
      setAgentMode("");
      setPermissionMode("default");
      setModel("");
      setVariant("");
      setMcpExpanded(false);
      setSkillsExpanded(false);
      cancelSkillEdit();
      setAddingMcp(false);
      setEditingMcpIndex(null);
      setMcpName("");
      setMcpJson("");
      setMcpLocalError(null);
    }
  }, [open]);

  // Auto-select first mode when modes load for selected agent
  useEffect(() => {
    if (!selectedAgent) return;
    const modes = modesByAgent[selectedAgent];
    if (modes && modes.length > 0 && !agentMode) {
      setAgentMode(modes[0].id);
    }
  }, [modesByAgent, selectedAgent, agentMode]);

  // Focus skill source input when adding
  useEffect(() => {
    if ((addingSkill || editingSkillIndex !== null) && skillSourceRef.current) {
      skillSourceRef.current.focus();
    }
  }, [addingSkill, editingSkillIndex]);

  // Focus MCP name input when adding
  useEffect(() => {
    if (addingMcp && mcpNameRef.current) {
      mcpNameRef.current.focus();
    }
  }, [addingMcp]);

  // Focus MCP json textarea when editing
  useEffect(() => {
    if (editingMcpIndex !== null && mcpJsonRef.current) {
      mcpJsonRef.current.focus();
    }
  }, [editingMcpIndex]);

  if (!open) return null;

  const handleAgentClick = (agentId: string) => {
    setSelectedAgent(agentId);
    setPhase("config");
    onSelectAgent(agentId);
  };

  const handleBack = () => {
    setPhase("agent");
    setSelectedAgent("");
    setAgentMode("");
    setPermissionMode("default");
    setModel("");
    setVariant("");
  };

  const handleCreate = () => {
    if (mcpConfigError) return;
    onCreateSession(selectedAgent, { model, agentMode, permissionMode, variant });
    onClose();
  };

  // Skill source helpers
  const startAddSkill = () => {
    setAddingSkill(true);
    setEditingSkillIndex(null);
    setSkillType("github");
    setSkillSource("rivet-dev/skills");
    setSkillFilter("sandbox-agent");
    setSkillRef("");
    setSkillSubpath("");
    setSkillLocalError(null);
  };

  const startEditSkill = (index: number) => {
    const entry = skillSources[index];
    setEditingSkillIndex(index);
    setAddingSkill(false);
    setSkillType(entry.type as "github" | "local" | "git");
    setSkillSource(entry.source);
    setSkillFilter(entry.skills?.join(", ") ?? "");
    setSkillRef(entry.ref ?? "");
    setSkillSubpath(entry.subpath ?? "");
    setSkillLocalError(null);
  };

  const commitSkill = () => {
    const src = skillSource.trim();
    if (!src) {
      setSkillLocalError("Source is required");
      return;
    }
    const entry: SkillSource = {
      type: skillType,
      source: src,
    };
    const filterList = skillFilter.trim()
      ? skillFilter.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (filterList && filterList.length > 0) entry.skills = filterList;
    if (skillRef.trim()) entry.ref = skillRef.trim();
    if (skillSubpath.trim()) entry.subpath = skillSubpath.trim();

    if (editingSkillIndex !== null) {
      const updated = [...skillSources];
      updated[editingSkillIndex] = entry;
      onSkillSourcesChange(updated);
    } else {
      onSkillSourcesChange([...skillSources, entry]);
    }
    cancelSkillEdit();
  };

  const removeSkill = (index: number) => {
    onSkillSourcesChange(skillSources.filter((_, i) => i !== index));
    if (editingSkillIndex === index) {
      cancelSkillEdit();
    }
  };

  const isEditingSkill = addingSkill || editingSkillIndex !== null;

  const startAddMcp = () => {
    setAddingMcp(true);
    setEditingMcpIndex(null);
    setMcpName("everything");
    setMcpJson('{\n  "type": "local",\n  "command": "npx",\n  "args": ["@modelcontextprotocol/server-everything"]\n}');
    setMcpLocalError(null);
  };

  const startEditMcp = (index: number) => {
    const entry = mcpServers[index];
    setEditingMcpIndex(index);
    setAddingMcp(false);
    setMcpName(entry.name);
    setMcpJson(entry.configJson);
    setMcpLocalError(entry.error);
  };

  const cancelMcpEdit = () => {
    setAddingMcp(false);
    setEditingMcpIndex(null);
    setMcpName("");
    setMcpJson("");
    setMcpLocalError(null);
  };

  const commitMcp = () => {
    const name = mcpName.trim();
    if (!name) {
      setMcpLocalError("Server name is required");
      return;
    }
    const error = validateServerJson(mcpJson);
    if (error) {
      setMcpLocalError(error);
      return;
    }
    // Check for duplicate names (except when editing the same entry)
    const duplicate = mcpServers.findIndex((e) => e.name === name);
    if (duplicate !== -1 && duplicate !== editingMcpIndex) {
      setMcpLocalError(`Server "${name}" already exists`);
      return;
    }

    const entry: McpServerEntry = { name, configJson: mcpJson.trim(), error: null };

    if (editingMcpIndex !== null) {
      const updated = [...mcpServers];
      updated[editingMcpIndex] = entry;
      onMcpServersChange(updated);
    } else {
      onMcpServersChange([...mcpServers, entry]);
    }
    cancelMcpEdit();
  };

  const removeMcp = (index: number) => {
    onMcpServersChange(mcpServers.filter((_, i) => i !== index));
    if (editingMcpIndex === index) {
      cancelMcpEdit();
    }
  };

  const isEditingMcp = addingMcp || editingMcpIndex !== null;

  if (phase === "agent") {
    return (
      <div className="session-create-menu">
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
              onClick={() => handleAgentClick(agent.id)}
            >
              <div className="agent-option-left">
                <span className="agent-option-name">{agentLabels[agent.id] ?? agent.id}</span>
                {agent.version && <span className="agent-option-version">{agent.version}</span>}
              </div>
              <div className="agent-option-badges">
                {agent.installed && <span className="agent-badge installed">Installed</span>}
                <ArrowRight size={12} className="agent-option-arrow" />
              </div>
            </button>
          ))}
      </div>
    );
  }

  // Phase 2: config form
  const activeModes = modesByAgent[selectedAgent] ?? [];
  const modesLoading = modesLoadingByAgent[selectedAgent] ?? false;
  const modesError = modesErrorByAgent[selectedAgent] ?? null;
  const modelOptions = modelsByAgent[selectedAgent] ?? [];
  const modelsLoading = modelsLoadingByAgent[selectedAgent] ?? false;
  const modelsError = modelsErrorByAgent[selectedAgent] ?? null;
  const defaultModel = defaultModelByAgent[selectedAgent] ?? "";
  const selectedModelId = model || defaultModel;
  const selectedModelObj = modelOptions.find((entry) => entry.id === selectedModelId);
  const variantOptions = selectedModelObj?.variants ?? [];
  const showModelSelect = modelsLoading || Boolean(modelsError) || modelOptions.length > 0;
  const hasModelOptions = modelOptions.length > 0;
  const modelCustom =
    model && hasModelOptions && !modelOptions.some((entry) => entry.id === model);
  const supportsVariants =
    modelsLoading ||
    Boolean(modelsError) ||
    modelOptions.some((entry) => (entry.variants?.length ?? 0) > 0);
  const showVariantSelect =
    supportsVariants && (modelsLoading || Boolean(modelsError) || variantOptions.length > 0);
  const hasVariantOptions = variantOptions.length > 0;
  const variantCustom = variant && hasVariantOptions && !variantOptions.includes(variant);
  const agentLabel = agentLabels[selectedAgent] ?? selectedAgent;

  return (
    <div className="session-create-menu">
      <div className="session-create-header">
        <button className="session-create-back" onClick={handleBack} title="Back to agents">
          <ArrowLeft size={14} />
        </button>
        <span className="session-create-agent-name">{agentLabel}</span>
      </div>

      <div className="session-create-form">
        <div className="setup-field">
          <span className="setup-label">Model</span>
          {showModelSelect ? (
            <select
              className="setup-select"
              value={model}
              onChange={(e) => { setModel(e.target.value); setVariant(""); }}
              title="Model"
              disabled={modelsLoading || Boolean(modelsError)}
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
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model"
              title="Model"
            />
          )}
        </div>

        <div className="setup-field">
          <span className="setup-label">Mode</span>
          <select
            className="setup-select"
            value={agentMode}
            onChange={(e) => setAgentMode(e.target.value)}
            title="Mode"
            disabled={modesLoading || Boolean(modesError)}
          >
            {modesLoading ? (
              <option value="">Loading modes...</option>
            ) : modesError ? (
              <option value="">{modesError}</option>
            ) : activeModes.length > 0 ? (
              activeModes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
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
            onChange={(e) => setPermissionMode(e.target.value)}
            title="Permission Mode"
          >
            <option value="default">Default</option>
            <option value="plan">Plan</option>
            <option value="bypass">Bypass</option>
          </select>
        </div>

        {supportsVariants && (
          <div className="setup-field">
            <span className="setup-label">Variant</span>
            {showVariantSelect ? (
              <select
                className="setup-select"
                value={variant}
                onChange={(e) => setVariant(e.target.value)}
                title="Variant"
                disabled={modelsLoading || Boolean(modelsError)}
              >
                {modelsLoading ? (
                  <option value="">Loading variants...</option>
                ) : modelsError ? (
                  <option value="">{modelsError}</option>
                ) : (
                  <>
                    <option value="">Default</option>
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
                onChange={(e) => setVariant(e.target.value)}
                placeholder="Variant"
                title="Variant"
              />
            )}
          </div>
        )}

        {/* MCP Servers - collapsible */}
        <div className="session-create-section">
          <button
            type="button"
            className="session-create-section-toggle"
            onClick={() => setMcpExpanded(!mcpExpanded)}
          >
            <span className="setup-label">MCP</span>
            <span className="session-create-section-count">{mcpServers.length} server{mcpServers.length !== 1 ? "s" : ""}</span>
            {mcpExpanded ? <ChevronDown size={12} className="session-create-section-arrow" /> : <ChevronRight size={12} className="session-create-section-arrow" />}
          </button>
          {mcpExpanded && (
            <div className="session-create-section-body">
              {mcpServers.length > 0 && !isEditingMcp && (
                <div className="session-create-mcp-list">
                  {mcpServers.map((entry, index) => (
                    <div key={entry.name} className="session-create-mcp-item">
                      <div className="session-create-mcp-info">
                        <span className="session-create-mcp-name">{entry.name}</span>
                        {getServerType(entry.configJson) && (
                          <span className="session-create-mcp-type">{getServerType(entry.configJson)}</span>
                        )}
                        <span className="session-create-mcp-summary mono">{getServerSummary(entry.configJson)}</span>
                      </div>
                      <div className="session-create-mcp-actions">
                        <button
                          type="button"
                          className="session-create-skill-remove"
                          onClick={() => startEditMcp(index)}
                          title="Edit server"
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          type="button"
                          className="session-create-skill-remove"
                          onClick={() => removeMcp(index)}
                          title="Remove server"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {isEditingMcp ? (
                <div className="session-create-mcp-edit">
                  <input
                    ref={mcpNameRef}
                    className="session-create-mcp-name-input"
                    value={mcpName}
                    onChange={(e) => { setMcpName(e.target.value); setMcpLocalError(null); }}
                    placeholder="server-name"
                    disabled={editingMcpIndex !== null}
                  />
                  <textarea
                    ref={mcpJsonRef}
                    className="session-create-textarea mono"
                    value={mcpJson}
                    onChange={(e) => { setMcpJson(e.target.value); setMcpLocalError(null); }}
                    placeholder='{"type":"local","command":"node","args":["./server.js"]}'
                    rows={4}
                  />
                  {mcpLocalError && (
                    <div className="session-create-inline-error">{mcpLocalError}</div>
                  )}
                  <div className="session-create-mcp-edit-actions">
                    <button type="button" className="session-create-mcp-save" onClick={commitMcp}>
                      {editingMcpIndex !== null ? "Save" : "Add"}
                    </button>
                    <button type="button" className="session-create-mcp-cancel" onClick={cancelMcpEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="session-create-add-btn"
                  onClick={startAddMcp}
                >
                  <Plus size={12} />
                  Add server
                </button>
              )}
              {mcpConfigError && !isEditingMcp && (
                <div className="session-create-inline-error">{mcpConfigError}</div>
              )}
            </div>
          )}
        </div>

        {/* Skills - collapsible with source-based list */}
        <div className="session-create-section">
          <button
            type="button"
            className="session-create-section-toggle"
            onClick={() => setSkillsExpanded(!skillsExpanded)}
          >
            <span className="setup-label">Skills</span>
            <span className="session-create-section-count">{skillSources.length} source{skillSources.length !== 1 ? "s" : ""}</span>
            {skillsExpanded ? <ChevronDown size={12} className="session-create-section-arrow" /> : <ChevronRight size={12} className="session-create-section-arrow" />}
          </button>
          {skillsExpanded && (
            <div className="session-create-section-body">
              {skillSources.length > 0 && !isEditingSkill && (
                <div className="session-create-skill-list">
                  {skillSources.map((entry, index) => (
                    <div key={`${entry.type}-${entry.source}-${index}`} className="session-create-skill-item">
                      <span className="session-create-skill-type-badge">{entry.type}</span>
                      <span className="session-create-skill-path mono">{skillSourceSummary(entry)}</span>
                      <div className="session-create-mcp-actions">
                        <button
                          type="button"
                          className="session-create-skill-remove"
                          onClick={() => startEditSkill(index)}
                          title="Edit source"
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          type="button"
                          className="session-create-skill-remove"
                          onClick={() => removeSkill(index)}
                          title="Remove source"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {isEditingSkill ? (
                <div className="session-create-mcp-edit">
                  <div className="session-create-skill-type-row">
                    <select
                      className="session-create-skill-type-select"
                      value={skillType}
                      onChange={(e) => { setSkillType(e.target.value as "github" | "local" | "git"); setSkillLocalError(null); }}
                    >
                      <option value="github">github</option>
                      <option value="local">local</option>
                      <option value="git">git</option>
                    </select>
                    <input
                      ref={skillSourceRef}
                      className="session-create-skill-input mono"
                      value={skillSource}
                      onChange={(e) => { setSkillSource(e.target.value); setSkillLocalError(null); }}
                      placeholder={skillType === "github" ? "owner/repo" : skillType === "local" ? "/path/to/skill" : "https://git.example.com/repo.git"}
                    />
                  </div>
                  <input
                    className="session-create-skill-input mono"
                    value={skillFilter}
                    onChange={(e) => setSkillFilter(e.target.value)}
                    placeholder="Filter skills (comma-separated, optional)"
                  />
                  {skillType !== "local" && (
                    <div className="session-create-skill-type-row">
                      <input
                        className="session-create-skill-input mono"
                        value={skillRef}
                        onChange={(e) => setSkillRef(e.target.value)}
                        placeholder="Branch/tag (optional)"
                      />
                      <input
                        className="session-create-skill-input mono"
                        value={skillSubpath}
                        onChange={(e) => setSkillSubpath(e.target.value)}
                        placeholder="Subpath (optional)"
                      />
                    </div>
                  )}
                  {skillLocalError && (
                    <div className="session-create-inline-error">{skillLocalError}</div>
                  )}
                  <div className="session-create-mcp-edit-actions">
                    <button type="button" className="session-create-mcp-save" onClick={commitSkill}>
                      {editingSkillIndex !== null ? "Save" : "Add"}
                    </button>
                    <button type="button" className="session-create-mcp-cancel" onClick={cancelSkillEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="session-create-add-btn"
                  onClick={startAddSkill}
                >
                  <Plus size={12} />
                  Add source
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="session-create-actions">
        <button
          className="button primary"
          onClick={handleCreate}
          disabled={Boolean(mcpConfigError)}
        >
          Create Session
        </button>
      </div>
    </div>
  );
};

export default SessionCreateMenu;
