import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, Skull, Trash2, RefreshCw, ChevronDown, ChevronRight, Terminal as TerminalIcon, Monitor, FileText } from "lucide-react";
import { Terminal } from "../terminal";

export interface TerminalSize {
  cols: number;
  rows: number;
}

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
  /** Whether this process has a PTY allocated (terminal mode) */
  tty?: boolean;
  /** Whether stdin is kept open for interactive input */
  interactive?: boolean;
  /** Current terminal size (if tty is true) */
  terminalSize?: TerminalSize | null;
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

const TtyBadge = ({ tty, interactive }: { tty?: boolean; interactive?: boolean }) => {
  if (!tty) return null;
  
  return (
    <span
      style={{
        background: "var(--color-info)",
        color: "white",
        padding: "2px 6px",
        borderRadius: "4px",
        fontSize: "10px",
        fontWeight: 500,
        display: "inline-flex",
        alignItems: "center",
        gap: 4
      }}
      title={`TTY${interactive ? " + Interactive" : ""}`}
    >
      <Monitor style={{ width: 10, height: 10 }} />
      PTY
    </span>
  );
};

type ViewMode = "logs" | "terminal";

const ProcessesTab = ({ baseUrl, token }: ProcessesTabProps) => {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logsLoading, setLogsLoading] = useState<Record<string, boolean>>({});
  const [stripTimestamps, setStripTimestamps] = useState(false);
  const [logStream, setLogStream] = useState<"combined" | "stdout" | "stderr">("combined");
  const [viewMode, setViewMode] = useState<Record<string, ViewMode>>({});
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

  const toggleExpand = useCallback((id: string, process: ProcessInfo) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      // Default to terminal view for TTY processes, logs for regular processes
      const defaultMode = process.tty && process.status === "running" ? "terminal" : "logs";
      setViewMode(prev => ({ ...prev, [id]: prev[id] || defaultMode }));
      if (!process.tty || viewMode[id] === "logs") {
        fetchLogs(id);
      }
    }
  }, [expandedId, fetchLogs, viewMode]);

  const getWsUrl = useCallback((id: string) => {
    // Convert HTTP URL to WebSocket URL
    const wsProtocol = baseUrl.startsWith("https") ? "wss" : "ws";
    const wsBaseUrl = baseUrl.replace(/^https?:/, wsProtocol + ":");
    return `${wsBaseUrl}/v1/process/${id}/terminal`;
  }, [baseUrl]);

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
    if (expandedId && viewMode[expandedId] === "logs") {
      fetchLogs(expandedId);
    }
  }, [stripTimestamps, logStream, expandedId, viewMode, fetchLogs]);

  const runningCount = processes.filter(p => p.status === "running").length;
  const ttyCount = processes.filter(p => p.tty).length;

  return (
    <div className="processes-tab">
      <div className="processes-header" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <TerminalIcon style={{ width: 16, height: 16 }} />
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
        {ttyCount > 0 && (
          <span style={{
            background: "var(--color-info)",
            color: "white",
            padding: "2px 6px",
            borderRadius: "10px",
            fontSize: "11px"
          }}>
            {ttyCount} PTY
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
          <TerminalIcon style={{ width: 32, height: 32, marginBottom: 8, opacity: 0.5 }} />
          <p>No processes found</p>
          <p style={{ fontSize: 12 }}>Start a process using the API</p>
          <p style={{ fontSize: 11, marginTop: 8 }}>
            Use <code style={{ background: "var(--bg-code)", padding: "2px 4px", borderRadius: 3 }}>tty: true</code> for interactive terminal sessions
          </p>
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
              onClick={() => toggleExpand(process.id, process)}
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
                  <TtyBadge tty={process.tty} interactive={process.interactive} />
                </div>
                <div style={{ fontSize: 11, color: "var(--color-muted)", marginTop: 2 }}>
                  ID: {process.id} • Started: {formatTimestamp(process.startedAt)} • Duration: {formatDuration(process.startedAt, process.stoppedAt)}
                  {process.terminalSize && ` • ${process.terminalSize.cols}x${process.terminalSize.rows}`}
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
              <div className="process-detail" style={{ borderTop: "1px solid var(--border-color)" }}>
                {/* View mode tabs for TTY processes */}
                {process.tty && (
                  <div style={{
                    display: "flex",
                    borderBottom: "1px solid var(--border-color)",
                    background: "var(--bg-tertiary)",
                  }}>
                    <button
                      onClick={() => {
                        setViewMode(prev => ({ ...prev, [process.id]: "terminal" }));
                      }}
                      style={{
                        padding: "8px 16px",
                        border: "none",
                        background: viewMode[process.id] === "terminal" ? "var(--bg-secondary)" : "transparent",
                        borderBottom: viewMode[process.id] === "terminal" ? "2px solid var(--color-primary)" : "2px solid transparent",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        color: viewMode[process.id] === "terminal" ? "var(--color-primary)" : "var(--color-muted)",
                      }}
                    >
                      <Monitor style={{ width: 14, height: 14 }} />
                      Terminal
                    </button>
                    <button
                      onClick={() => {
                        setViewMode(prev => ({ ...prev, [process.id]: "logs" }));
                        fetchLogs(process.id);
                      }}
                      style={{
                        padding: "8px 16px",
                        border: "none",
                        background: viewMode[process.id] === "logs" ? "var(--bg-secondary)" : "transparent",
                        borderBottom: viewMode[process.id] === "logs" ? "2px solid var(--color-primary)" : "2px solid transparent",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        color: viewMode[process.id] === "logs" ? "var(--color-primary)" : "var(--color-muted)",
                      }}
                    >
                      <FileText style={{ width: 14, height: 14 }} />
                      Logs
                    </button>
                  </div>
                )}

                {/* Terminal view */}
                {process.tty && viewMode[process.id] === "terminal" && process.status === "running" && (
                  <div style={{ height: 400 }}>
                    <Terminal
                      wsUrl={getWsUrl(process.id)}
                      active={expandedId === process.id}
                      cols={process.terminalSize?.cols || 80}
                      rows={process.terminalSize?.rows || 24}
                    />
                  </div>
                )}

                {/* Terminal placeholder when process is not running */}
                {process.tty && viewMode[process.id] === "terminal" && process.status !== "running" && (
                  <div style={{
                    height: 200,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#1a1a1a",
                    color: "var(--color-muted)",
                    flexDirection: "column",
                    gap: 8,
                  }}>
                    <Monitor style={{ width: 32, height: 32, opacity: 0.5 }} />
                    <span>Process is not running</span>
                    <span style={{ fontSize: 11 }}>Terminal connection unavailable</span>
                  </div>
                )}

                {/* Logs view */}
                {(!process.tty || viewMode[process.id] === "logs") && (
                  <div className="process-logs">
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
