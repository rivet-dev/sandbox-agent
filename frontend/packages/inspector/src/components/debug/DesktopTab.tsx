import { Loader2, Monitor, Play, RefreshCw, Square, Camera } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SandboxAgentError } from "sandbox-agent";
import type {
  DesktopStatusResponse,
  SandboxAgent,
} from "sandbox-agent";

const MIN_SPIN_MS = 350;

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof SandboxAgentError && error.problem?.detail) return error.problem.detail;
  if (error instanceof Error) return error.message;
  return fallback;
};

const formatStartedAt = (value: string | null | undefined): string => {
  if (!value) {
    return "Not started";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const createScreenshotUrl = async (bytes: Uint8Array): Promise<string> => {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const blob = new Blob([payload.buffer], { type: "image/png" });

  if (typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(blob);
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read screenshot blob."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read screenshot blob."));
      }
    };
    reader.readAsDataURL(blob);
  });
};

const DesktopTab = ({
  getClient,
}: {
  getClient: () => SandboxAgent;
}) => {
  const [status, setStatus] = useState<DesktopStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [width, setWidth] = useState("1440");
  const [height, setHeight] = useState("900");
  const [dpi, setDpi] = useState("96");

  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  const revokeScreenshotUrl = useCallback(() => {
    setScreenshotUrl((current) => {
      if (current?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);

  const loadStatus = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    if (mode === "initial") {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const next = await getClient().getDesktopStatus();
      setStatus(next);
      return next;
    } catch (loadError) {
      setError(extractErrorMessage(loadError, "Unable to load desktop status."));
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [getClient]);

  const refreshScreenshot = useCallback(async () => {
    setScreenshotLoading(true);
    setScreenshotError(null);
    try {
      const bytes = await getClient().takeDesktopScreenshot();
      revokeScreenshotUrl();
      setScreenshotUrl(await createScreenshotUrl(bytes));
    } catch (captureError) {
      revokeScreenshotUrl();
      setScreenshotError(extractErrorMessage(captureError, "Unable to capture desktop screenshot."));
    } finally {
      setScreenshotLoading(false);
    }
  }, [getClient, revokeScreenshotUrl]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (status?.state === "active") {
      void refreshScreenshot();
    } else {
      revokeScreenshotUrl();
    }
  }, [refreshScreenshot, revokeScreenshotUrl, status?.state]);

  useEffect(() => {
    return () => {
      revokeScreenshotUrl();
    };
  }, [revokeScreenshotUrl]);

  const handleStart = async () => {
    const parsedWidth = Number.parseInt(width, 10);
    const parsedHeight = Number.parseInt(height, 10);
    const parsedDpi = Number.parseInt(dpi, 10);
    setActing("start");
    setError(null);
    const startedAt = Date.now();
    try {
      const next = await getClient().startDesktop({
        width: Number.isFinite(parsedWidth) ? parsedWidth : undefined,
        height: Number.isFinite(parsedHeight) ? parsedHeight : undefined,
        dpi: Number.isFinite(parsedDpi) ? parsedDpi : undefined,
      });
      setStatus(next);
      if (next.state === "active") {
        await refreshScreenshot();
      }
    } catch (startError) {
      setError(extractErrorMessage(startError, "Unable to start desktop runtime."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };

  const handleStop = async () => {
    setActing("stop");
    setError(null);
    const startedAt = Date.now();
    try {
      const next = await getClient().stopDesktop();
      setStatus(next);
      revokeScreenshotUrl();
    } catch (stopError) {
      setError(extractErrorMessage(stopError, "Unable to stop desktop runtime."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };

  const canRefreshScreenshot = status?.state === "active";
  const resolutionLabel = useMemo(() => {
    const resolution = status?.resolution;
    if (!resolution) return "Unknown";
    const dpiLabel = resolution.dpi ? ` @ ${resolution.dpi} DPI` : "";
    return `${resolution.width} x ${resolution.height}${dpiLabel}`;
  }, [status?.resolution]);

  return (
    <div className="desktop-panel">
      <div className="inline-row" style={{ marginBottom: 16 }}>
        <button
          className="button secondary small"
          onClick={() => void loadStatus("refresh")}
          disabled={loading || refreshing}
        >
          <RefreshCw className={`button-icon ${loading || refreshing ? "spinner-icon" : ""}`} />
          Refresh Status
        </button>
        <button
          className="button secondary small"
          onClick={() => void refreshScreenshot()}
          disabled={!canRefreshScreenshot || screenshotLoading}
        >
          {screenshotLoading ? (
            <Loader2 className="button-icon spinner-icon" />
          ) : (
            <Camera className="button-icon" />
          )}
          Refresh Screenshot
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {screenshotError && <div className="banner error">{screenshotError}</div>}

      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Monitor size={14} style={{ marginRight: 6 }} />
            Desktop Runtime
          </span>
          <span className={`pill ${
            status?.state === "active"
              ? "success"
              : status?.state === "install_required"
                ? "warning"
                : status?.state === "failed"
                  ? "danger"
                  : ""
          }`}>
            {status?.state ?? "unknown"}
          </span>
        </div>

        <div className="desktop-state-grid">
          <div>
            <div className="card-meta">Display</div>
            <div className="mono">{status?.display ?? "Not assigned"}</div>
          </div>
          <div>
            <div className="card-meta">Resolution</div>
            <div className="mono">{resolutionLabel}</div>
          </div>
          <div>
            <div className="card-meta">Started</div>
            <div>{formatStartedAt(status?.startedAt)}</div>
          </div>
        </div>

        <div className="desktop-start-controls">
          <div className="desktop-input-group">
            <label className="label">Width</label>
            <input
              className="setup-input mono"
              value={width}
              onChange={(event) => setWidth(event.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="desktop-input-group">
            <label className="label">Height</label>
            <input
              className="setup-input mono"
              value={height}
              onChange={(event) => setHeight(event.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="desktop-input-group">
            <label className="label">DPI</label>
            <input
              className="setup-input mono"
              value={dpi}
              onChange={(event) => setDpi(event.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>

        <div className="card-actions">
          <button
            className="button success small"
            onClick={() => void handleStart()}
            disabled={acting === "start"}
          >
            {acting === "start" ? (
              <Loader2 className="button-icon spinner-icon" />
            ) : (
              <Play className="button-icon" />
            )}
            Start Desktop
          </button>
          <button
            className="button danger small"
            onClick={() => void handleStop()}
            disabled={acting === "stop"}
          >
            {acting === "stop" ? (
              <Loader2 className="button-icon spinner-icon" />
            ) : (
              <Square className="button-icon" />
            )}
            Stop Desktop
          </button>
        </div>
      </div>

      {status?.missingDependencies && status.missingDependencies.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Missing Dependencies</span>
          </div>
          <div className="desktop-chip-list">
            {status.missingDependencies.map((dependency) => (
              <span key={dependency} className="pill warning">{dependency}</span>
            ))}
          </div>
          {status.installCommand && (
            <>
              <div className="card-meta" style={{ marginTop: 12 }}>Install command</div>
              <div className="mono desktop-command">{status.installCommand}</div>
            </>
          )}
        </div>
      )}

      {(status?.lastError || status?.runtimeLogPath || (status?.processes?.length ?? 0) > 0) && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Diagnostics</span>
          </div>
          {status?.lastError && (
            <div className="desktop-diagnostic-block">
              <div className="card-meta">Last error</div>
              <div className="mono">{status.lastError.code}</div>
              <div>{status.lastError.message}</div>
            </div>
          )}
          {status?.runtimeLogPath && (
            <div className="desktop-diagnostic-block">
              <div className="card-meta">Runtime log</div>
              <div className="mono">{status.runtimeLogPath}</div>
            </div>
          )}
          {status?.processes && status.processes.length > 0 && (
            <div className="desktop-diagnostic-block">
              <div className="card-meta">Processes</div>
              <div className="desktop-process-list">
                {status.processes.map((process) => (
                  <div key={`${process.name}-${process.pid ?? "none"}`} className="desktop-process-item">
                    <div>
                      <strong>{process.name}</strong>
                      <span className={`pill ${process.running ? "success" : "danger"}`} style={{ marginLeft: 8 }}>
                        {process.running ? "running" : "stopped"}
                      </span>
                    </div>
                    <div className="mono">
                      {process.pid ? `pid ${process.pid}` : "no pid"}
                    </div>
                    {process.logPath && <div className="mono">{process.logPath}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Latest Screenshot</span>
          {status?.state === "active" ? (
            <span className="card-meta">Manual refresh only</span>
          ) : null}
        </div>

        {loading ? <div className="card-meta">Loading...</div> : null}
        {!loading && !screenshotUrl && (
          <div className="desktop-screenshot-empty">
            {status?.state === "active"
              ? "No screenshot loaded yet."
              : "Start the desktop runtime to capture a screenshot."}
          </div>
        )}
        {screenshotUrl && (
          <div className="desktop-screenshot-frame">
            <img src={screenshotUrl} alt="Desktop screenshot" className="desktop-screenshot-image" />
          </div>
        )}
      </div>
    </div>
  );
};

export default DesktopTab;
