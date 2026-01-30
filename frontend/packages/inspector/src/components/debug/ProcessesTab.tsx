import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, Skull, Trash2, RefreshCw, ChevronDown, ChevronRight, Terminal } from "lucide-react";

export interface ProcessInfo {
  id: string;
  command: string;
  args: string[];
  status: "starting" | "running" | "stopped" | "killed";
  exitCode?: number | null;
  logPaths: {
    stdout: string;
    stderr: string;
    combined: string;
  };
  startedAt: number;
  stoppedAt?: number | null;
  cwd?: string | null;
}

export interface ProcessListResponse {
  processes: ProcessInfo[];
}

export interface LogsResponse {
  content: string;
  lines: number;
}

interface ProcessesTabProps {
  baseUrl: string;
  token?: string;
}

const formatTimestamp = (ts: number) => {
  return new Date(ts * 1000).toLocaleString();
};

const formatDuration = (startedAt: number, stoppedAt?: number | null) => {
  const end = stoppedAt ?? Math.floor(Date.now() / 1000);
  const duration = end - startedAt;
  if (duration < 60) return `${duration}s`;
  if (duration < 3600) return `${Math.floor(duration / 60)}m ${duration % 60}s`;
  return `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
};

const StatusBadge = ({ status, exitCode }: { status: string; exitCode?: number | null }) => {
  const colors: Record<string, string> = {
    starting: "var(--color-warning)",
    running: "var(--color-success)",
    stopped: exitCode === 0 ? "var(--color-muted)" : "var(--color-error)",
    killed: "var(--color-error)"
  };
  
  return (
    <span
      className="status-badge"
      style={{
        background: colors[status] ?? "var(--color-muted)",
        color: "white",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 500
      }}
    >
      {status}
      {status === "stopped" && exitCode !== undefined && exitCode !== null && ` (${exitCode})`}
    </span>
  );
};

const ProcessesTab = ({ baseUrl, token }: ProcessesTabProps) => {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logsLoading, setLogsLoading] = useState<Record<string, boolean>>({});
  const [stripTimestamps, setStripTimestamps] = useState(false);
  const [logStream, setLogStream] = useState<"combined" | "stdout" | "stderr">("combined");
  const refreshTimerRef = useRef<number | null>(null);

  const fetchWithAuth = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {})
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return fetch(url, { ...options, headers });
  }, [token]);

  const fetchProcesses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth(`${baseUrl}/v1/process`);
      if (!response.ok) {
        throw new Error(`Failed to fetch processes: ${response.status}`);
      }
      const data: ProcessListResponse = await response.json();
      setProcesses(data.processes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch processes");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, fetchWithAuth]);

  const fetchLogs = useCallback(async (id: string) => {
    setLogsLoading(prev => ({ ...prev, [id]: true }));
    try {
      const params = new URLSearchParams({
        stream: logStream,
        tail: "100"
      });
      if (stripTimestamps) {
        params.set("strip_timestamps", "true");
      }
      const response = await fetchWithAuth(`${baseUrl}/v1/process/${id}/logs?${params}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch logs: ${response.status}`);
      }
      const data: LogsResponse = await response.json();
      setLogs(prev => ({ ...prev, [id]: data.content }));
    } catch (err) {
      setLogs(prev => ({ ...prev, [id]: `Error: ${err instanceof Error ? err.message : "Failed to fetch logs"}` }));
    } finally {
      setLogsLoading(prev => ({ ...prev, [id]: false }));
    }
  }, [baseUrl, fetchWithAuth, logStream, stripTimestamps]);

  const stopProcess = useCallback(async (id: string) => {
    try {
      const response = await fetchWithAuth(`${baseUrl}/v1/process/${id}/stop`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Failed to stop process: ${response.status}`);
      }
      await fetchProcesses();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop process");
    }
  }, [baseUrl, fetchWithAuth, fetchProcesses]);

  const killProcess = useCallback(async (id: string) => {
    try {
      const response = await fetchWithAuth(`${baseUrl}/v1/process/${id}/kill`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Failed to kill process: ${response.status}`);
      }
      await fetchProcesses();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to kill process");
    }
  }, [baseUrl, fetchWithAuth, fetchProcesses]);

  const deleteProcess = useCallback(async (id: string) => {
    try {
      const response = await fetchWithAuth(`${baseUrl}/v1/process/${id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Failed to delete process: ${response.status}`);
      }
      if (expandedId === id) {
        setExpandedId(null);
      }
      await fetchProcesses();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete process");
    }
  }, [baseUrl, fetchWithAuth, fetchProcesses, expandedId]);

  const toggleExpand = useCallback((id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      fetchLogs(id);
    }
  }, [expandedId, fetchLogs]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchProcesses();
    
    // Auto-refresh every 5 seconds
    refreshTimerRef.current = window.setInterval(fetchProcesses, 5000);
    
    return () => {
      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current);
      }
    };
  }, [fetchProcesses]);

  // Refresh logs when options change
  useEffect(() => {
    if (expandedId) {
      fetchLogs(expandedId);
    }
  }, [stripTimestamps, logStream]);

  const runningCount = processes.filter(p => p.status === "running").length;

  return (
    <div className="processes-tab">
      <div className="processes-header" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Terminal style={{ width: 16, height: 16 }} />
        <span style={{ fontWeight: 600 }}>Processes</span>
        {runningCount > 0 && (
          <span className="running-badge" style={{
            background: "var(--color-success)",
            color: "white",
            padding: "2px 6px",
            borderRadius: "10px",
            fontSize: "11px"
          }}>
            {runningCount} running
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="button ghost small"
          onClick={() => fetchProcesses()}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw style={{ width: 14, height: 14 }} className={loading ? "spinning" : ""} />
        </button>
      </div>

      {error && (
        <div className="error-message" style={{ color: "var(--color-error)", marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {processes.length === 0 && !loading && (
        <div className="empty-state" style={{ textAlign: "center", padding: "24px 16px", color: "var(--color-muted)" }}>
          <Terminal style={{ width: 32, height: 32, marginBottom: 8, opacity: 0.5 }} />
          <p>No processes found</p>
          <p style={{ fontSize: 12 }}>Start a process using the API</p>
        </div>
      )}

      <div className="processes-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {processes.map(process => (
          <div
            key={process.id}
            className="process-item"
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              overflow: "hidden"
            }}
          >
            <div
              className="process-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: expandedId === process.id ? "var(--bg-secondary)" : "transparent",
                cursor: "pointer"
              }}
              onClick={() => toggleExpand(process.id)}
            >
              {expandedId === process.id ? (
                <ChevronDown style={{ width: 14, height: 14, flexShrink: 0 }} />
              ) : (
                <ChevronRight style={{ width: 14, height: 14, flexShrink: 0 }} />
              )}
              
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ fontSize: 12, fontWeight: 500 }}>
                    {process.command} {process.args.join(" ")}
                  </code>
                </div>
                <div style={{ fontSize: 11, color: "var(--color-muted)", marginTop: 2 }}>
                  ID: {process.id} • Started: {formatTimestamp(process.startedAt)} • Duration: {formatDuration(process.startedAt, process.stoppedAt)}
                </div>
              </div>

              <StatusBadge status={process.status} exitCode={process.exitCode} />

              <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
                {(process.status === "running" || process.status === "starting") && (
                  <>
                    <button
                      className="button ghost small"
                      onClick={() => stopProcess(process.id)}
                      title="Stop (SIGTERM)"
                    >
                      <Square style={{ width: 12, height: 12 }} />
                    </button>
                    <button
                      className="button ghost small"
                      onClick={() => killProcess(process.id)}
                      title="Kill (SIGKILL)"
                    >
                      <Skull style={{ width: 12, height: 12 }} />
                    </button>
                  </>
                )}
                {(process.status === "stopped" || process.status === "killed") && (
                  <button
                    className="button ghost small"
                    onClick={() => deleteProcess(process.id)}
                    title="Delete process and logs"
                  >
                    <Trash2 style={{ width: 12, height: 12 }} />
                  </button>
                )}
              </div>
            </div>

            {expandedId === process.id && (
              <div className="process-logs" style={{ borderTop: "1px solid var(--border-color)" }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 12px",
                  background: "var(--bg-tertiary)",
                  fontSize: 12
                }}>
                  <select
                    value={logStream}
                    onChange={e => setLogStream(e.target.value as typeof logStream)}
                    style={{ fontSize: 11, padding: "2px 4px" }}
                  >
                    <option value="combined">Combined</option>
                    <option value="stdout">stdout</option>
                    <option value="stderr">stderr</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={stripTimestamps}
                      onChange={e => setStripTimestamps(e.target.checked)}
                    />
                    Strip timestamps
                  </label>
                  <button
                    className="button ghost small"
                    onClick={() => fetchLogs(process.id)}
                    disabled={logsLoading[process.id]}
                  >
                    <RefreshCw style={{ width: 12, height: 12 }} className={logsLoading[process.id] ? "spinning" : ""} />
                    Refresh
                  </button>
                </div>
                <pre style={{
                  margin: 0,
                  padding: 12,
                  fontSize: 11,
                  lineHeight: 1.5,
                  maxHeight: 300,
                  overflow: "auto",
                  background: "var(--bg-code)",
                  color: "var(--color-code)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all"
                }}>
                  {logsLoading[process.id] ? "Loading..." : (logs[process.id] || "(no logs)")}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spinning {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </div>
  );
};

export default ProcessesTab;
