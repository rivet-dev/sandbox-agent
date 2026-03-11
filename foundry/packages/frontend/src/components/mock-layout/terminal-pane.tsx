import type { SandboxProcessRecord } from "@sandbox-agent/foundry-client";
import { ProcessTerminal } from "@sandbox-agent/react";
import { useQuery } from "@tanstack/react-query";
import { useStyletron } from "baseui";
import { ChevronDown, Loader2, RefreshCw, Skull, SquareTerminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SandboxAgent } from "sandbox-agent";
import { backendClient } from "../../lib/backend";

interface TerminalPaneProps {
  workspaceId: string;
  taskId: string | null;
}

interface ProcessTab {
  id: string;
  processId: string;
  title: string;
}

const PROCESSES_TAB_ID = "processes";
const MIN_TERMINAL_HEIGHT = 220;

function decodeBase64Utf8(value: string): string {
  try {
    const bytes = Uint8Array.from(window.atob(value), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

function parseArgs(value: string): string[] {
  return value
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatCommandSummary(process: Pick<SandboxProcessRecord, "command" | "args">): string {
  return [process.command, ...process.args].join(" ").trim();
}

function canOpenTerminal(process: SandboxProcessRecord | null | undefined): boolean {
  return Boolean(process && process.status === "running" && process.interactive && process.tty);
}

function defaultShellRequest(cwd?: string | null) {
  return {
    command: "/bin/bash",
    args: ["-lc", 'if [ -n "$SHELL" ] && [ -x "$SHELL" ]; then exec "$SHELL" -l; fi; if [ -x /bin/zsh ]; then exec /bin/zsh -l; fi; exec /bin/bash -l'],
    cwd: cwd ?? undefined,
    interactive: true,
    tty: true,
  };
}

function formatProcessTabTitle(process: Pick<SandboxProcessRecord, "command" | "id">, fallbackIndex: number): string {
  const label = process.command.split("/").pop()?.trim();
  return label && label.length > 0 ? label : `Terminal ${fallbackIndex}`;
}

export function TerminalPane({ workspaceId, taskId }: TerminalPaneProps) {
  const [css] = useStyletron();
  const [activeTabId, setActiveTabId] = useState<string>(PROCESSES_TAB_ID);
  const [processTabs, setProcessTabs] = useState<ProcessTab[]>([]);
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwdOverride, setCwdOverride] = useState("");
  const [interactive, setInteractive] = useState(true);
  const [tty, setTty] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingProcess, setCreatingProcess] = useState(false);
  const [actingProcessId, setActingProcessId] = useState<string | null>(null);
  const [logsText, setLogsText] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [terminalClient, setTerminalClient] = useState<SandboxAgent | null>(null);

  const taskQuery = useQuery({
    queryKey: ["mock-layout", "task", workspaceId, taskId],
    enabled: Boolean(taskId),
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.activeSandboxId ? false : 2_000),
    queryFn: async () => {
      if (!taskId) {
        throw new Error("Cannot load terminal state without a task.");
      }
      return await backendClient.getTask(workspaceId, taskId);
    },
  });

  const activeSandbox = useMemo(() => {
    const task = taskQuery.data;
    if (!task?.activeSandboxId) {
      return null;
    }

    return task.sandboxes.find((sandbox) => sandbox.sandboxId === task.activeSandboxId) ?? null;
  }, [taskQuery.data]);

  const connectionQuery = useQuery({
    queryKey: ["mock-layout", "sandbox-agent-connection", workspaceId, activeSandbox?.providerId ?? "", activeSandbox?.sandboxId ?? ""],
    enabled: Boolean(activeSandbox?.sandboxId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!activeSandbox) {
        throw new Error("Cannot load a sandbox connection without an active sandbox.");
      }

      return await backendClient.getSandboxAgentConnection(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId);
    },
  });

  const processesQuery = useQuery({
    queryKey: ["mock-layout", "sandbox-processes", workspaceId, activeSandbox?.providerId ?? "", activeSandbox?.sandboxId ?? ""],
    enabled: Boolean(activeSandbox?.sandboxId),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: activeSandbox?.sandboxId ? 3_000 : false,
    queryFn: async () => {
      if (!activeSandbox) {
        throw new Error("Cannot load processes without an active sandbox.");
      }

      return await backendClient.listSandboxProcesses(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId);
    },
  });

  useEffect(() => {
    if (!activeSandbox?.sandboxId) {
      return;
    }

    return backendClient.subscribeSandboxProcesses(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId, () => {
      void processesQuery.refetch();
    });
  }, [activeSandbox?.providerId, activeSandbox?.sandboxId, processesQuery, workspaceId]);

  useEffect(() => {
    if (!connectionQuery.data) {
      setTerminalClient((current) => {
        if (current) {
          void current.dispose();
        }
        return null;
      });
      return;
    }

    if (connectionQuery.data.endpoint.startsWith("mock://")) {
      setTerminalClient((current) => {
        if (current) {
          void current.dispose();
        }
        return null;
      });
      return;
    }

    let cancelled = false;
    void SandboxAgent.connect({
      baseUrl: connectionQuery.data.endpoint,
      token: connectionQuery.data.token,
      waitForHealth: false,
    })
      .then((client) => {
        if (cancelled) {
          void client.dispose();
          return;
        }

        setTerminalClient((current) => {
          if (current) {
            void current.dispose();
          }
          return client;
        });
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalClient((current) => {
            if (current) {
              void current.dispose();
            }
            return null;
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connectionQuery.data]);

  useEffect(() => {
    return () => {
      if (terminalClient) {
        void terminalClient.dispose();
      }
    };
  }, [terminalClient]);

  useEffect(() => {
    setActiveTabId(PROCESSES_TAB_ID);
    setProcessTabs([]);
    setSelectedProcessId(null);
    setLogsText("");
    setLogsError(null);
  }, [taskId]);

  const processes = processesQuery.data?.processes ?? [];
  const selectedProcess = useMemo(() => processes.find((process) => process.id === selectedProcessId) ?? null, [processes, selectedProcessId]);

  useEffect(() => {
    if (!processes.length) {
      setSelectedProcessId(null);
      return;
    }

    setSelectedProcessId((current) => {
      if (current && processes.some((process) => process.id === current)) {
        return current;
      }
      return processes[0]?.id ?? null;
    });
  }, [processes]);

  const refreshLogs = useCallback(async () => {
    if (!activeSandbox?.sandboxId || !selectedProcess) {
      setLogsText("");
      setLogsError(null);
      return;
    }

    setLogsLoading(true);
    setLogsError(null);
    try {
      const response = await backendClient.getSandboxProcessLogs(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId, selectedProcess.id, {
        stream: selectedProcess.tty ? "pty" : "combined",
        tail: 200,
      });
      setLogsText(response.entries.map((entry: ProcessLogResponseEntry) => decodeBase64Utf8(entry.data)).join(""));
    } catch (error) {
      setLogsText("");
      setLogsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLogsLoading(false);
    }
  }, [activeSandbox, selectedProcess, workspaceId]);

  useEffect(() => {
    void refreshLogs();
  }, [refreshLogs]);

  const openTerminalTab = useCallback((process: SandboxProcessRecord) => {
    setProcessTabs((current) => {
      const existing = current.find((tab) => tab.processId === process.id);
      if (existing) {
        setActiveTabId(existing.id);
        return current;
      }

      const nextTab: ProcessTab = {
        id: `terminal:${process.id}`,
        processId: process.id,
        title: formatProcessTabTitle(process, current.length + 1),
      };
      setActiveTabId(nextTab.id);
      return [...current, nextTab];
    });
  }, []);

  const closeTerminalTab = useCallback((tabId: string) => {
    setProcessTabs((current) => current.filter((tab) => tab.id !== tabId));
    setActiveTabId((current) => (current === tabId ? PROCESSES_TAB_ID : current));
  }, []);

  const spawnTerminal = useCallback(async () => {
    if (!activeSandbox?.sandboxId) {
      return;
    }

    setCreatingProcess(true);
    setCreateError(null);
    try {
      const created = await backendClient.createSandboxProcess({
        workspaceId,
        providerId: activeSandbox.providerId,
        sandboxId: activeSandbox.sandboxId,
        request: defaultShellRequest(activeSandbox.cwd),
      });
      await processesQuery.refetch();
      openTerminalTab(created);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingProcess(false);
    }
  }, [activeSandbox, openTerminalTab, processesQuery, workspaceId]);

  const createCustomProcess = useCallback(async () => {
    if (!activeSandbox?.sandboxId) {
      return;
    }

    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setCreateError("Command is required.");
      return;
    }

    setCreatingProcess(true);
    setCreateError(null);
    try {
      const created = await backendClient.createSandboxProcess({
        workspaceId,
        providerId: activeSandbox.providerId,
        sandboxId: activeSandbox.sandboxId,
        request: {
          command: trimmedCommand,
          args: parseArgs(argsText),
          cwd: cwdOverride.trim() || activeSandbox.cwd || undefined,
          interactive,
          tty,
        },
      });
      await processesQuery.refetch();
      setSelectedProcessId(created.id);
      setCommand("");
      setArgsText("");
      setCwdOverride("");
      setInteractive(true);
      setTty(true);
      if (created.interactive && created.tty) {
        openTerminalTab(created);
      } else {
        setActiveTabId(PROCESSES_TAB_ID);
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingProcess(false);
    }
  }, [activeSandbox, argsText, command, cwdOverride, interactive, openTerminalTab, processesQuery, tty, workspaceId]);

  const handleProcessAction = useCallback(
    async (processId: string, action: "stop" | "kill" | "delete") => {
      if (!activeSandbox?.sandboxId) {
        return;
      }

      setActingProcessId(`${action}:${processId}`);
      try {
        if (action === "stop") {
          await backendClient.stopSandboxProcess(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId, processId, { waitMs: 2_000 });
        } else if (action === "kill") {
          await backendClient.killSandboxProcess(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId, processId, { waitMs: 2_000 });
        } else {
          await backendClient.deleteSandboxProcess(workspaceId, activeSandbox.providerId, activeSandbox.sandboxId, processId);
          setProcessTabs((current) => current.filter((tab) => tab.processId !== processId));
          setActiveTabId((current) => (current.startsWith("terminal:") && current === `terminal:${processId}` ? PROCESSES_TAB_ID : current));
        }
        await processesQuery.refetch();
      } catch (error) {
        setCreateError(error instanceof Error ? error.message : String(error));
      } finally {
        setActingProcessId(null);
      }
    },
    [activeSandbox, processesQuery, workspaceId],
  );

  const processTabsById = useMemo(() => new Map(processTabs.map((tab) => [tab.id, tab])), [processTabs]);
  const activeProcessTab = activeTabId === PROCESSES_TAB_ID ? null : (processTabsById.get(activeTabId) ?? null);
  const activeTerminalProcess = useMemo(
    () => (activeProcessTab ? (processes.find((process) => process.id === activeProcessTab.processId) ?? null) : null),
    [activeProcessTab, processes],
  );

  const emptyBodyClassName = css({
    flex: 1,
    minHeight: `${MIN_TERMINAL_HEIGHT}px`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "#080506",
  });

  const emptyCopyClassName = css({
    maxWidth: "340px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    color: "rgba(255, 255, 255, 0.72)",
    fontSize: "12px",
    lineHeight: 1.6,
    textAlign: "center",
  });

  const smallButtonClassName = css({
    appearance: "none",
    WebkitAppearance: "none",
    background: "none",
    margin: "0",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    borderRadius: "8px",
    border: "1px solid rgba(255, 255, 255, 0.1)",
    color: "#f4f4f5",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 600,
    ":hover": {
      backgroundColor: "rgba(255, 255, 255, 0.06)",
    },
    ":disabled": {
      opacity: 0.45,
      cursor: "not-allowed",
    },
  });

  const renderProcessesView = () => {
    if (!activeSandbox?.sandboxId) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Processes will appear when the sandbox is ready.</strong>
            <span>The active task does not have a sandbox runtime yet.</span>
          </div>
        </div>
      );
    }

    return (
      <div
        className={css({
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
          backgroundColor: "#080506",
        })}
      >
        <div
          className={css({
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            padding: "14px 14px 12px",
            borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          })}
        >
          <div
            className={css({
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
            })}
          >
            <div
              className={css({
                display: "flex",
                flexDirection: "column",
                gap: "2px",
              })}
            >
              <strong className={css({ fontSize: "12px", color: "#f5f5f5" })}>Processes</strong>
              <span className={css({ fontSize: "11px", color: "rgba(255, 255, 255, 0.56)" })}>
                Process lifecycle goes through the actor. Terminal transport goes straight to the sandbox.
              </span>
            </div>
            <div className={css({ display: "flex", alignItems: "center", gap: "8px" })}>
              <button type="button" className={smallButtonClassName} onClick={() => void processesQuery.refetch()} disabled={processesQuery.isFetching}>
                {processesQuery.isFetching ? <Loader2 size={12} className={css({ animation: "hf-spin 0.8s linear infinite" })} /> : <RefreshCw size={12} />}
                Refresh
              </button>
              <button type="button" className={smallButtonClassName} onClick={() => void spawnTerminal()} disabled={creatingProcess}>
                {creatingProcess ? <Loader2 size={12} className={css({ animation: "hf-spin 0.8s linear infinite" })} /> : <SquareTerminal size={12} />}
                New Terminal
              </button>
            </div>
          </div>

          <div
            className={css({
              display: "grid",
              gap: "8px",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            })}
          >
            <input
              className={css({
                width: "100%",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                borderRadius: "8px",
                backgroundColor: "#0d0a0b",
                color: "#f4f4f5",
                fontSize: "12px",
                padding: "9px 10px",
              })}
              value={command}
              onChange={(event) => {
                setCommand(event.target.value);
                setCreateError(null);
              }}
              placeholder="Command"
            />
            <input
              className={css({
                width: "100%",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                borderRadius: "8px",
                backgroundColor: "#0d0a0b",
                color: "#f4f4f5",
                fontSize: "12px",
                padding: "9px 10px",
              })}
              value={cwdOverride}
              onChange={(event) => {
                setCwdOverride(event.target.value);
                setCreateError(null);
              }}
              placeholder={activeSandbox.cwd ?? "Working directory"}
            />
            <textarea
              className={css({
                width: "100%",
                minHeight: "56px",
                resize: "none",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                borderRadius: "8px",
                backgroundColor: "#0d0a0b",
                color: "#f4f4f5",
                fontSize: "12px",
                padding: "9px 10px",
                gridColumn: "1 / -1",
              })}
              value={argsText}
              onChange={(event) => {
                setArgsText(event.target.value);
                setCreateError(null);
              }}
              placeholder="Arguments, one per line"
            />
          </div>

          <div className={css({ display: "flex", alignItems: "center", gap: "14px", fontSize: "11px", color: "rgba(255, 255, 255, 0.68)" })}>
            <label className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
              <input
                type="checkbox"
                checked={interactive}
                onChange={(event) => {
                  setInteractive(event.target.checked);
                  if (!event.target.checked) {
                    setTty(false);
                  }
                }}
              />
              interactive
            </label>
            <label className={css({ display: "flex", alignItems: "center", gap: "6px" })}>
              <input
                type="checkbox"
                checked={tty}
                onChange={(event) => {
                  setTty(event.target.checked);
                  if (event.target.checked) {
                    setInteractive(true);
                  }
                }}
              />
              tty
            </label>
            <button type="button" className={smallButtonClassName} onClick={() => void createCustomProcess()} disabled={creatingProcess}>
              Create Process
            </button>
          </div>

          {createError ? <div className={css({ fontSize: "11px", color: "#fda4af" })}>{createError}</div> : null}
        </div>

        <div
          className={css({
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(220px, 0.95fr) minmax(0, 1.05fr)",
          })}
        >
          <div
            className={css({
              minHeight: 0,
              overflowY: "auto",
              borderRight: "1px solid rgba(255, 255, 255, 0.08)",
            })}
          >
            {processes.length === 0 ? (
              <div className={css({ padding: "16px", fontSize: "12px", color: "rgba(255,255,255,0.56)" })}>No processes yet.</div>
            ) : (
              processes.map((process) => {
                const isSelected = selectedProcessId === process.id;
                const isStopping = actingProcessId === `stop:${process.id}`;
                const isKilling = actingProcessId === `kill:${process.id}`;
                const isDeleting = actingProcessId === `delete:${process.id}`;

                return (
                  <div
                    key={process.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedProcessId(process.id);
                      setActiveTabId(PROCESSES_TAB_ID);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedProcessId(process.id);
                        setActiveTabId(PROCESSES_TAB_ID);
                      }
                    }}
                    className={css({
                      width: "100%",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      padding: "12px 14px",
                      cursor: "pointer",
                      backgroundColor: isSelected ? "rgba(255, 255, 255, 0.06)" : "transparent",
                      borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
                      outline: "none",
                      ":focus-visible": {
                        boxShadow: "inset 0 0 0 1px rgba(249, 115, 22, 0.85)",
                      },
                    })}
                  >
                    <div className={css({ display: "flex", alignItems: "center", gap: "8px" })}>
                      <span
                        className={css({
                          width: "8px",
                          height: "8px",
                          borderRadius: "999px",
                          backgroundColor: process.status === "running" ? "#4ade80" : "#71717a",
                          flexShrink: 0,
                        })}
                      />
                      <span className={css({ fontSize: "12px", color: "#f4f4f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                        {formatCommandSummary(process)}
                      </span>
                    </div>
                    <div
                      className={css({
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        fontSize: "10px",
                        color: "rgba(255,255,255,0.5)",
                      })}
                    >
                      <span>{process.pid ? `PID ${process.pid}` : "PID ?"}</span>
                      <span>{process.id.slice(0, 8)}</span>
                    </div>
                    <div className={css({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" })}>
                      {canOpenTerminal(process) ? (
                        <button
                          type="button"
                          className={smallButtonClassName}
                          onClick={(event) => {
                            event.stopPropagation();
                            openTerminalTab(process);
                          }}
                        >
                          <SquareTerminal size={11} />
                          Open
                        </button>
                      ) : null}
                      {process.status === "running" ? (
                        <>
                          <button
                            type="button"
                            className={smallButtonClassName}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleProcessAction(process.id, "stop");
                            }}
                            disabled={Boolean(actingProcessId)}
                          >
                            {isStopping ? <Loader2 size={11} className={css({ animation: "hf-spin 0.8s linear infinite" })} /> : null}
                            Stop
                          </button>
                          <button
                            type="button"
                            className={smallButtonClassName}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleProcessAction(process.id, "kill");
                            }}
                            disabled={Boolean(actingProcessId)}
                          >
                            {isKilling ? <Loader2 size={11} className={css({ animation: "hf-spin 0.8s linear infinite" })} /> : <Skull size={11} />}
                            Kill
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={smallButtonClassName}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleProcessAction(process.id, "delete");
                          }}
                          disabled={Boolean(actingProcessId)}
                        >
                          {isDeleting ? <Loader2 size={11} className={css({ animation: "hf-spin 0.8s linear infinite" })} /> : <Trash2 size={11} />}
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className={css({ minHeight: 0, display: "flex", flexDirection: "column" })}>
            {selectedProcess ? (
              <>
                <div
                  className={css({
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    padding: "14px",
                    borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                  })}
                >
                  <div className={css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" })}>
                    <strong className={css({ fontSize: "12px", color: "#f4f4f5" })}>{formatCommandSummary(selectedProcess)}</strong>
                    <span className={css({ fontSize: "10px", color: "rgba(255,255,255,0.56)" })}>{selectedProcess.status}</span>
                  </div>
                  <div className={css({ display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "10px", color: "rgba(255,255,255,0.5)" })}>
                    <span>{selectedProcess.pid ? `PID ${selectedProcess.pid}` : "PID ?"}</span>
                    <span>{selectedProcess.id}</span>
                    {selectedProcess.exitCode != null ? <span>exit={selectedProcess.exitCode}</span> : null}
                  </div>
                </div>
                <div className={css({ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" })}>
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 14px",
                      borderBottom: "1px solid rgba(255,255,255,0.08)",
                    })}
                  >
                    <span className={css({ fontSize: "11px", color: "rgba(255,255,255,0.68)" })}>Logs</span>
                    <button type="button" className={smallButtonClassName} onClick={() => void refreshLogs()} disabled={logsLoading}>
                      {logsLoading ? <Loader2 size={11} className={css({ animation: "hf-spin 0.8s linear infinite" })} /> : <RefreshCw size={11} />}
                      Refresh
                    </button>
                  </div>
                  {logsError ? <div className={css({ padding: "14px", fontSize: "11px", color: "#fda4af" })}>{logsError}</div> : null}
                  <pre
                    className={css({
                      flex: 1,
                      minHeight: 0,
                      margin: 0,
                      padding: "14px",
                      overflow: "auto",
                      fontSize: "11px",
                      lineHeight: 1.6,
                      color: "#d4d4d8",
                      fontFamily: '"IBM Plex Mono", monospace',
                    })}
                  >
                    {logsText || (logsLoading ? "Loading..." : "(no output)")}
                  </pre>
                </div>
              </>
            ) : (
              <div className={emptyBodyClassName}>
                <div className={emptyCopyClassName}>
                  <strong>Select a process to inspect its details.</strong>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderTerminalView = () => {
    if (!activeProcessTab) {
      return renderProcessesView();
    }

    if (!activeTerminalProcess) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Process not found.</strong>
            <span>This terminal tab points at a process that no longer exists.</span>
          </div>
        </div>
      );
    }

    if (!terminalClient) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Interactive terminal transport is unavailable.</strong>
            <span>This tab was created through the standard process API flow. Mock mode does not open a live terminal transport.</span>
          </div>
        </div>
      );
    }

    return (
      <div className={css({ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: "#080506" })}>
        <div
          className={css({
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            fontSize: "11px",
            color: "rgba(255,255,255,0.56)",
          })}
        >
          <span>{formatCommandSummary(activeTerminalProcess)}</span>
          <span>{activeTerminalProcess.id.slice(0, 8)}</span>
        </div>
        <ProcessTerminal
          key={activeTerminalProcess.id}
          client={terminalClient}
          processId={activeTerminalProcess.id}
          height="100%"
          showStatusBar={false}
          style={{
            flex: 1,
            minHeight: 0,
            border: "none",
            borderRadius: 0,
            background: "#080506",
          }}
          terminalStyle={{
            minHeight: 0,
            height: "100%",
            padding: "18px 16px 14px",
          }}
          onExit={() => {
            void processesQuery.refetch();
          }}
        />
      </div>
    );
  };

  const renderBody = () => {
    if (!taskId) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Select a task to inspect its processes.</strong>
          </div>
        </div>
      );
    }

    if (taskQuery.isLoading) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Loading sandbox state...</strong>
          </div>
        </div>
      );
    }

    if (taskQuery.error) {
      return (
        <div className={emptyBodyClassName}>
          <div className={emptyCopyClassName}>
            <strong>Could not load task state.</strong>
            <span>{taskQuery.error.message}</span>
          </div>
        </div>
      );
    }

    return activeTabId === PROCESSES_TAB_ID ? renderProcessesView() : renderTerminalView();
  };

  return (
    <section
      className={css({
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#080506",
        overflow: "hidden",
      })}
    >
      <div
        className={css({
          display: "flex",
          alignItems: "center",
          gap: "8px",
          minHeight: "38px",
          padding: "0 10px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          backgroundColor: "#090607",
          color: "rgba(255, 255, 255, 0.72)",
          fontSize: "12px",
          fontWeight: 600,
        })}
      >
        <button
          type="button"
          aria-label="Terminal controls"
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            padding: "0",
            margin: "0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "20px",
            height: "20px",
            color: "rgba(255, 255, 255, 0.56)",
          })}
        >
          <ChevronDown size={14} />
        </button>

        <button
          type="button"
          onClick={() => setActiveTabId(PROCESSES_TAB_ID)}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            margin: "0",
            position: "relative",
            display: "flex",
            alignItems: "center",
            height: "100%",
            padding: "0 10px",
            color: activeTabId === PROCESSES_TAB_ID ? "#f5f5f5" : "rgba(255, 255, 255, 0.65)",
            cursor: "pointer",
            ":after":
              activeTabId === PROCESSES_TAB_ID
                ? {
                    content: '""',
                    position: "absolute",
                    left: "10px",
                    right: "10px",
                    bottom: 0,
                    height: "2px",
                    borderRadius: "999px",
                    backgroundColor: "#f5f5f5",
                  }
                : undefined,
          })}
        >
          Processes
        </button>

        {processTabs.map((tab) => (
          <div
            key={tab.id}
            className={css({
              position: "relative",
              display: "flex",
              alignItems: "center",
              height: "100%",
            })}
          >
            <button
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              className={css({
                appearance: "none",
                WebkitAppearance: "none",
                background: "none",
                border: "none",
                margin: "0",
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                height: "100%",
                padding: "0 10px",
                color: activeTabId === tab.id ? "#f5f5f5" : "rgba(255, 255, 255, 0.65)",
                cursor: "pointer",
                ":after":
                  activeTabId === tab.id
                    ? {
                        content: '""',
                        position: "absolute",
                        left: "10px",
                        right: "10px",
                        bottom: 0,
                        height: "2px",
                        borderRadius: "999px",
                        backgroundColor: "#f5f5f5",
                      }
                    : undefined,
              })}
            >
              {tab.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => closeTerminalTab(tab.id)}
              className={css({
                appearance: "none",
                WebkitAppearance: "none",
                background: "none",
                border: "none",
                padding: "0",
                margin: "0",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "18px",
                height: "18px",
                marginRight: "4px",
                color: "rgba(255, 255, 255, 0.42)",
                cursor: "pointer",
              })}
            >
              <X size={12} />
            </button>
          </div>
        ))}

        <button
          type="button"
          aria-label="New terminal tab"
          onClick={() => void spawnTerminal()}
          disabled={!activeSandbox?.sandboxId || creatingProcess}
          className={css({
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            border: "none",
            padding: "0",
            margin: "0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "28px",
            height: "100%",
            marginLeft: "2px",
            color: "rgba(255, 255, 255, 0.72)",
            fontSize: "18px",
            lineHeight: 1,
            cursor: "pointer",
            opacity: !activeSandbox?.sandboxId || creatingProcess ? 0.4 : 1,
          })}
        >
          +
        </button>
      </div>
      {renderBody()}
    </section>
  );
}

type ProcessLogResponseEntry = Awaited<ReturnType<typeof backendClient.getSandboxProcessLogs>>["entries"][number];
