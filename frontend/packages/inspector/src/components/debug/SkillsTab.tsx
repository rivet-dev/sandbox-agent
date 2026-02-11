import { FolderOpen, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SandboxAgent } from "sandbox-agent";
import { formatJson } from "../../utils/format";

type SkillEntry = {
  name: string;
  config: { sources: Array<{ source: string; type: string; ref?: string | null; subpath?: string | null; skills?: string[] | null }> };
};

const SkillsTab = ({
  getClient,
}: {
  getClient: () => SandboxAgent;
}) => {
  const [directory, setDirectory] = useState("/");
  const [entries, setEntries] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editSource, setEditSource] = useState("");
  const [editType, setEditType] = useState("github");
  const [editRef, setEditRef] = useState("");
  const [editSubpath, setEditSubpath] = useState("");
  const [editSkills, setEditSkills] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const configPath = `${dir === "/" ? "" : dir}/.sandbox-agent/config/skills.json`;
      const bytes = await getClient().readFsFile({ path: configPath });
      const text = new TextDecoder().decode(bytes);
      if (!text.trim()) {
        setEntries([]);
        return;
      }
      const map = JSON.parse(text) as Record<string, SkillEntry["config"]>;
      setEntries(
        Object.entries(map).map(([name, config]) => ({ name, config })),
      );
    } catch {
      // File doesn't exist yet or is empty — that's fine
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [getClient]);

  useEffect(() => {
    loadAll(directory);
  }, [directory, loadAll]);

  const startAdd = () => {
    setEditing(true);
    setEditName("");
    setEditSource("rivet-dev/skills");
    setEditType("github");
    setEditRef("");
    setEditSubpath("");
    setEditSkills("sandbox-agent");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditName("");
    setEditSource("");
    setEditType("github");
    setEditRef("");
    setEditSubpath("");
    setEditSkills("");
    setEditError(null);
  };

  const save = async () => {
    const name = editName.trim();
    if (!name) {
      setEditError("Name is required");
      return;
    }
    const source = editSource.trim();
    if (!source) {
      setEditError("Source is required");
      return;
    }

    const skillEntry: SkillEntry["config"]["sources"][0] = {
      source,
      type: editType,
    };
    if (editRef.trim()) skillEntry.ref = editRef.trim();
    if (editSubpath.trim()) skillEntry.subpath = editSubpath.trim();
    const skillsList = editSkills.trim()
      ? editSkills.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    if (skillsList && skillsList.length > 0) skillEntry.skills = skillsList;

    const config = { sources: [skillEntry] };

    setSaving(true);
    setEditError(null);
    try {
      await getClient().setSkillsConfig(
        { directory, skillName: name },
        config,
      );
      cancelEdit();
      await loadAll(directory);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    try {
      await getClient().deleteSkillsConfig({ directory, skillName: name });
      await loadAll(directory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  return (
    <>
      <div className="inline-row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <span className="card-meta">Skills Configuration</span>
        <div className="inline-row">
          {!editing && (
            <button className="button secondary small" onClick={startAdd}>
              <Plus className="button-icon" style={{ width: 12, height: 12 }} />
              Add
            </button>
          )}
        </div>
      </div>

      <div className="inline-row" style={{ marginBottom: 12, gap: 6 }}>
        <FolderOpen size={14} className="muted" style={{ flexShrink: 0 }} />
        <input
          className="setup-input mono"
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          placeholder="/"
          style={{ flex: 1, fontSize: 11 }}
        />
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && <div className="card-meta">Loading...</div>}

      {editing && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-header">
            <span className="card-title">Add Skill Source</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <input
              className="setup-input"
              value={editName}
              onChange={(e) => { setEditName(e.target.value); setEditError(null); }}
              placeholder="skill-name"
              style={{ marginBottom: 6, width: "100%", boxSizing: "border-box" }}
            />
            <div className="inline-row" style={{ marginBottom: 6, gap: 4 }}>
              <select
                className="setup-select"
                value={editType}
                onChange={(e) => setEditType(e.target.value)}
                style={{ width: 90 }}
              >
                <option value="github">github</option>
                <option value="local">local</option>
                <option value="git">git</option>
              </select>
              <input
                className="setup-input mono"
                value={editSource}
                onChange={(e) => { setEditSource(e.target.value); setEditError(null); }}
                placeholder={editType === "github" ? "owner/repo" : editType === "local" ? "/path/to/skill" : "https://..."}
                style={{ flex: 1 }}
              />
            </div>
            <input
              className="setup-input"
              value={editSkills}
              onChange={(e) => setEditSkills(e.target.value)}
              placeholder="Skills filter (comma-separated, optional)"
              style={{ marginBottom: 6, width: "100%", boxSizing: "border-box" }}
            />
            {editType !== "local" && (
              <div className="inline-row" style={{ gap: 4 }}>
                <input
                  className="setup-input mono"
                  value={editRef}
                  onChange={(e) => setEditRef(e.target.value)}
                  placeholder="Branch/tag (optional)"
                  style={{ flex: 1 }}
                />
                <input
                  className="setup-input mono"
                  value={editSubpath}
                  onChange={(e) => setEditSubpath(e.target.value)}
                  placeholder="Subpath (optional)"
                  style={{ flex: 1 }}
                />
              </div>
            )}
            {editError && <div className="banner error" style={{ marginTop: 4 }}>{editError}</div>}
          </div>
          <div className="card-actions">
            <button className="button primary small" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="button-icon spinner-icon" /> : null}
              Save
            </button>
            <button className="button ghost small" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {entries.length === 0 && !editing && !loading && (
        <div className="card-meta">
          No skills configured in this directory.
        </div>
      )}

      {entries.map((entry) => (
        <div key={entry.name} className="card" style={{ marginBottom: 8 }}>
          <div className="card-header">
            <span className="card-title">{entry.name}</span>
            <div className="card-header-pills">
              <span className="pill accent">
                {entry.config.sources.length} source{entry.config.sources.length !== 1 ? "s" : ""}
              </span>
              <button
                className="button ghost small"
                onClick={() => remove(entry.name)}
                title="Remove"
                style={{ padding: "2px 4px" }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <pre className="code-block" style={{ marginTop: 4, fontSize: 10 }}>
            {formatJson(entry.config)}
          </pre>
        </div>
      ))}
    </>
  );
};

export default SkillsTab;
