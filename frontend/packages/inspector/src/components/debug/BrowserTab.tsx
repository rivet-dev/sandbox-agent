import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Circle,
  Code,
  Database,
  Download,
  Globe,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SandboxAgentError } from "sandbox-agent";
import type {
  BrowserConsoleMessage,
  BrowserContextInfo,
  BrowserNetworkRequest,
  BrowserStatusResponse,
  BrowserTabInfo,
  DesktopRecordingInfo,
  SandboxAgent,
} from "sandbox-agent";
import { DesktopViewer } from "@sandbox-agent/react";
import type { BrowserViewerClient } from "@sandbox-agent/react";

const MIN_SPIN_MS = 350;

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof SandboxAgentError && error.problem?.detail) return error.problem.detail;
  if (error instanceof Error) return error.message;
  return fallback;
};

const formatStartedAt = (value: string | null | undefined): string => {
  if (!value) return "Not started";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const createScreenshotUrl = async (bytes: Uint8Array, mimeType = "image/png"): Promise<string> => {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const blob = new Blob([payload.buffer], { type: mimeType });
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

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};

const formatDuration = (start: string, end?: string | null): string => {
  if (!end) return "in progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const CONSOLE_LEVELS = ["all", "log", "warn", "error", "info"] as const;

const consoleLevelColor = (level: string): string => {
  switch (level) {
    case "error":
      return "var(--danger, #ef4444)";
    case "warning":
      return "var(--warning, #f59e0b)";
    case "info":
      return "var(--info, #3b82f6)";
    default:
      return "var(--muted)";
  }
};

const BrowserTab = ({ getClient }: { getClient: () => SandboxAgent }) => {
  // Status
  const [status, setStatus] = useState<BrowserStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Config inputs
  const [width, setWidth] = useState("1280");
  const [height, setHeight] = useState("720");
  const [startUrl, setStartUrl] = useState("");
  const [contextId, setContextId] = useState("");
  const [contexts, setContexts] = useState<BrowserContextInfo[]>([]);

  // Screenshot
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotFormat, setScreenshotFormat] = useState<"png" | "jpeg" | "webp">("png");
  const [screenshotQuality, setScreenshotQuality] = useState("85");
  const [screenshotFullPage, setScreenshotFullPage] = useState(false);
  const [screenshotSelector, setScreenshotSelector] = useState("");

  // Tabs
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [tabsError, setTabsError] = useState<string | null>(null);
  const [newTabUrl, setNewTabUrl] = useState("");
  const [tabActing, setTabActing] = useState<string | null>(null);

  // Console
  const [consoleMessages, setConsoleMessages] = useState<BrowserConsoleMessage[]>([]);
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [consoleLevel, setConsoleLevel] = useState<string>("all");
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Network
  const [networkRequests, setNetworkRequests] = useState<BrowserNetworkRequest[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [networkUrlPattern, setNetworkUrlPattern] = useState("");

  // Content Tools
  const [contentOutput, setContentOutput] = useState("");
  const [contentLoading, setContentLoading] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  // Recording
  const [recordings, setRecordings] = useState<DesktopRecordingInfo[]>([]);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingActing, setRecordingActing] = useState<"start" | "stop" | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingFps, setRecordingFps] = useState("30");
  const [deletingRecordingId, setDeletingRecordingId] = useState<string | null>(null);
  const [downloadingRecordingId, setDownloadingRecordingId] = useState<string | null>(null);

  // Context management
  const [contextName, setContextName] = useState("");
  const [contextActing, setContextActing] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

  // Live view
  const [liveViewActive, setLiveViewActive] = useState(false);
  const [liveViewError, setLiveViewError] = useState<string | null>(null);
  const [navUrl, setNavUrl] = useState("");
  const [isNavigating, setIsNavigating] = useState(false);

  const isActive = status?.state === "active";

  const resolutionLabel = useMemo(() => {
    const resolution = status?.resolution;
    if (!resolution) return "Unknown";
    return `${resolution.width} x ${resolution.height}`;
  }, [status?.resolution]);

  const viewerClient = useMemo<BrowserViewerClient>(() => {
    const c = getClient();
    return {
      connectDesktopStream: (opts?: Parameters<SandboxAgent["connectDesktopStream"]>[0]) => c.connectDesktopStream(opts),
      browserNavigate: (req) => c.browserNavigate(req),
      browserBack: () => c.browserBack(),
      browserForward: () => c.browserForward(),
      browserReload: (req?) => c.browserReload(req),
      getBrowserStatus: () => c.getBrowserStatus(),
    };
  }, [getClient]);

  const loadStatus = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const next = await getClient().getBrowserStatus();
        setStatus(next);
        if (next.url) setNavUrl(next.url);
        return next;
      } catch (loadError) {
        setError(extractErrorMessage(loadError, "Unable to load browser status."));
        return null;
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [getClient],
  );

  const loadContexts = useCallback(async () => {
    try {
      const result = await getClient().getBrowserContexts();
      setContexts(result.contexts);
    } catch {
      // non-critical
    }
  }, [getClient]);

  // Screenshot
  const revokeScreenshotUrl = useCallback(() => {
    setScreenshotUrl((current) => {
      if (current?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(current);
      }
      return null;
    });
  }, []);

  const refreshScreenshot = useCallback(async () => {
    setScreenshotLoading(true);
    setScreenshotError(null);
    try {
      const quality = Number.parseInt(screenshotQuality, 10);
      const request: Parameters<SandboxAgent["takeBrowserScreenshot"]>[0] = {
        format: screenshotFormat !== "png" ? screenshotFormat : undefined,
        quality: screenshotFormat !== "png" && Number.isFinite(quality) ? quality : undefined,
        fullPage: screenshotFullPage || undefined,
        selector: screenshotSelector.trim() || undefined,
      };
      const bytes = await getClient().takeBrowserScreenshot(request);
      revokeScreenshotUrl();
      const mimeType = screenshotFormat === "jpeg" ? "image/jpeg" : screenshotFormat === "webp" ? "image/webp" : "image/png";
      setScreenshotUrl(await createScreenshotUrl(bytes, mimeType));
    } catch (captureError) {
      revokeScreenshotUrl();
      setScreenshotError(extractErrorMessage(captureError, "Unable to capture browser screenshot."));
    } finally {
      setScreenshotLoading(false);
    }
  }, [getClient, revokeScreenshotUrl, screenshotFormat, screenshotQuality, screenshotFullPage, screenshotSelector]);

  // Tabs
  const loadTabs = useCallback(async () => {
    setTabsLoading(true);
    setTabsError(null);
    try {
      const result = await getClient().getBrowserTabs();
      setTabs(result.tabs);
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to load tabs."));
    } finally {
      setTabsLoading(false);
    }
  }, [getClient]);

  const handleCreateTab = async () => {
    setTabActing("new");
    setTabsError(null);
    try {
      await getClient().createBrowserTab(newTabUrl.trim() ? { url: newTabUrl.trim() } : {});
      setNewTabUrl("");
      await loadTabs();
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to create tab."));
    } finally {
      setTabActing(null);
    }
  };

  const handleActivateTab = async (tabId: string) => {
    setTabActing(tabId);
    setTabsError(null);
    try {
      await getClient().activateBrowserTab(tabId);
      await loadTabs();
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to activate tab."));
    } finally {
      setTabActing(null);
    }
  };

  const handleCloseTab = async (tabId: string) => {
    setTabActing(tabId);
    setTabsError(null);
    try {
      await getClient().closeBrowserTab(tabId);
      await loadTabs();
    } catch (err) {
      setTabsError(extractErrorMessage(err, "Unable to close tab."));
    } finally {
      setTabActing(null);
    }
  };

  // Console
  const loadConsole = useCallback(async () => {
    setConsoleLoading(true);
    setConsoleError(null);
    try {
      const query = consoleLevel !== "all" ? { level: consoleLevel } : {};
      const result = await getClient().getBrowserConsole(query);
      setConsoleMessages(result.messages);
    } catch (err) {
      setConsoleError(extractErrorMessage(err, "Unable to load console messages."));
    } finally {
      setConsoleLoading(false);
    }
  }, [getClient, consoleLevel]);

  // Network
  const loadNetwork = useCallback(async () => {
    setNetworkLoading(true);
    setNetworkError(null);
    try {
      const query = networkUrlPattern.trim() ? { urlPattern: networkUrlPattern.trim() } : {};
      const result = await getClient().getBrowserNetwork(query);
      setNetworkRequests(result.requests);
    } catch (err) {
      setNetworkError(extractErrorMessage(err, "Unable to load network requests."));
    } finally {
      setNetworkLoading(false);
    }
  }, [getClient, networkUrlPattern]);

  // Recording
  const activeRecording = useMemo(() => recordings.find((r) => r.status === "recording"), [recordings]);

  const loadRecordings = useCallback(async () => {
    setRecordingLoading(true);
    setRecordingError(null);
    try {
      const result = await getClient().listDesktopRecordings();
      setRecordings(result.recordings);
    } catch (loadError) {
      setRecordingError(extractErrorMessage(loadError, "Unable to load recordings."));
    } finally {
      setRecordingLoading(false);
    }
  }, [getClient]);

  const handleStartRecording = async () => {
    const fps = Number.parseInt(recordingFps, 10);
    setRecordingActing("start");
    setRecordingError(null);
    try {
      await getClient().startDesktopRecording({
        fps: Number.isFinite(fps) ? fps : undefined,
      });
      await loadRecordings();
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to start recording."));
    } finally {
      setRecordingActing(null);
    }
  };

  const handleStopRecording = async () => {
    setRecordingActing("stop");
    setRecordingError(null);
    try {
      await getClient().stopDesktopRecording();
      await loadRecordings();
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to stop recording."));
    } finally {
      setRecordingActing(null);
    }
  };

  const handleDeleteRecording = async (id: string) => {
    setDeletingRecordingId(id);
    try {
      await getClient().deleteDesktopRecording(id);
      setRecordings((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to delete recording."));
    } finally {
      setDeletingRecordingId(null);
    }
  };

  const handleDownloadRecording = async (id: string, fileName: string) => {
    setDownloadingRecordingId(id);
    try {
      const bytes = await getClient().downloadDesktopRecording(id);
      const payload = new Uint8Array(bytes.byteLength);
      payload.set(bytes);
      const blob = new Blob([payload.buffer], { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setRecordingError(extractErrorMessage(err, "Unable to download recording."));
    } finally {
      setDownloadingRecordingId(null);
    }
  };

  // Context management
  const handleCreateContext = async () => {
    if (!contextName.trim()) return;
    setContextActing("create");
    setContextError(null);
    try {
      await getClient().createBrowserContext({ name: contextName.trim() });
      setContextName("");
      await loadContexts();
    } catch (err) {
      setContextError(extractErrorMessage(err, "Unable to create context."));
    } finally {
      setContextActing(null);
    }
  };

  const handleDeleteContext = async (id: string) => {
    setContextActing(id);
    setContextError(null);
    try {
      await getClient().deleteBrowserContext(id);
      if (contextId === id) setContextId("");
      await loadContexts();
    } catch (err) {
      setContextError(extractErrorMessage(err, "Unable to delete context."));
    } finally {
      setContextActing(null);
    }
  };

  // Content tools
  const handleGetContent = async (type: "html" | "markdown" | "links" | "snapshot") => {
    setContentLoading(type);
    setContentError(null);
    try {
      let output = "";
      switch (type) {
        case "html": {
          const result = await getClient().getBrowserContent();
          output = result.html;
          break;
        }
        case "markdown": {
          const result = await getClient().getBrowserMarkdown();
          output = result.markdown;
          break;
        }
        case "links": {
          const result = await getClient().getBrowserLinks();
          output = result.links.map((l) => `${l.text} -> ${l.href}`).join("\n");
          break;
        }
        case "snapshot": {
          const result = await getClient().getBrowserSnapshot();
          output = result.snapshot;
          break;
        }
      }
      setContentOutput(output);
    } catch (err) {
      setContentError(extractErrorMessage(err, `Unable to get ${type}.`));
    } finally {
      setContentLoading(null);
    }
  };

  // Initial load
  useEffect(() => {
    void loadStatus();
    void loadContexts();
  }, [loadStatus, loadContexts]);

  // Auto-refresh status every 5s when active
  useEffect(() => {
    if (status?.state !== "active") return;
    const interval = setInterval(() => void loadStatus("refresh"), 5000);
    return () => clearInterval(interval);
  }, [status?.state, loadStatus]);

  // Load tabs, console, network, and recordings when browser becomes active
  useEffect(() => {
    if (status?.state === "active") {
      void loadTabs();
      void loadConsole();
      void loadNetwork();
      void loadRecordings();
    }
  }, [status?.state, loadTabs, loadConsole, loadNetwork, loadRecordings]);

  // Auto-refresh console every 3s when active
  useEffect(() => {
    if (status?.state !== "active") return;
    const interval = setInterval(() => void loadConsole(), 3000);
    return () => clearInterval(interval);
  }, [status?.state, loadConsole]);

  // Auto-refresh network every 3s when active
  useEffect(() => {
    if (status?.state !== "active") return;
    const interval = setInterval(() => void loadNetwork(), 3000);
    return () => clearInterval(interval);
  }, [status?.state, loadNetwork]);

  // Poll recording list while a recording is active
  useEffect(() => {
    if (!activeRecording) return;
    const interval = setInterval(() => void loadRecordings(), 3000);
    return () => clearInterval(interval);
  }, [activeRecording, loadRecordings]);

  // Cleanup screenshot URL on unmount
  useEffect(() => {
    return () => revokeScreenshotUrl();
  }, [revokeScreenshotUrl]);

  // Reset live view when browser becomes inactive
  useEffect(() => {
    if (status?.state !== "active") {
      setLiveViewActive(false);
    }
  }, [status?.state]);

  const handleStart = async () => {
    const parsedWidth = Number.parseInt(width, 10);
    const parsedHeight = Number.parseInt(height, 10);
    setActing("start");
    setError(null);
    const startedAt = Date.now();
    try {
      const request: Parameters<SandboxAgent["startBrowser"]>[0] = {
        width: Number.isFinite(parsedWidth) ? parsedWidth : undefined,
        height: Number.isFinite(parsedHeight) ? parsedHeight : undefined,
        url: startUrl.trim() || undefined,
        contextId: contextId || undefined,
      };
      const next = await getClient().startBrowser(request);
      setStatus(next);
      if (next.url) setNavUrl(next.url);
    } catch (startError) {
      setError(extractErrorMessage(startError, "Unable to start browser."));
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
      const next = await getClient().stopBrowser();
      setStatus(next);
      setLiveViewActive(false);
    } catch (stopError) {
      setError(extractErrorMessage(stopError, "Unable to stop browser."));
      await loadStatus("refresh");
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_SPIN_MS) {
        await new Promise((resolve) => window.setTimeout(resolve, MIN_SPIN_MS - elapsedMs));
      }
      setActing(null);
    }
  };

  const handleNavigate = async (url: string) => {
    if (!url.trim()) return;
    setIsNavigating(true);
    try {
      let normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      const page = await getClient().browserNavigate({ url: normalizedUrl });
      setNavUrl(page.url ?? "");
    } catch {
      // navigation error silently ignored
    } finally {
      setIsNavigating(false);
    }
  };

  const handleBack = async () => {
    setIsNavigating(true);
    try {
      const page = await getClient().browserBack();
      setNavUrl(page.url ?? "");
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  };

  const handleForward = async () => {
    setIsNavigating(true);
    try {
      const page = await getClient().browserForward();
      setNavUrl(page.url ?? "");
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  };

  const handleReload = async () => {
    setIsNavigating(true);
    try {
      const page = await getClient().browserReload();
      setNavUrl(page.url ?? "");
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  };

  return (
    <div className="desktop-panel">
      <div className="inline-row" style={{ marginBottom: 16 }}>
        <button className="button secondary small" onClick={() => void loadStatus("refresh")} disabled={loading || refreshing}>
          <RefreshCw className={`button-icon ${loading || refreshing ? "spinner-icon" : ""}`} />
          Refresh Status
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {/* ========== Runtime Control Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Globe size={14} style={{ marginRight: 6 }} />
            Browser Runtime
          </span>
          <span
            className={`pill ${
              status?.state === "active" ? "success" : status?.state === "install_required" ? "warning" : status?.state === "failed" ? "danger" : ""
            }`}
          >
            {status?.state ?? "unknown"}
          </span>
        </div>

        <div className="desktop-state-grid">
          <div>
            <div className="card-meta">URL</div>
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
              {status?.url ?? "None"}
            </div>
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
            <input className="setup-input mono" value={width} onChange={(e) => setWidth(e.target.value)} inputMode="numeric" />
          </div>
          <div className="desktop-input-group">
            <label className="label">Height</label>
            <input className="setup-input mono" value={height} onChange={(e) => setHeight(e.target.value)} inputMode="numeric" />
          </div>
          <div className="desktop-input-group">
            <label className="label">URL</label>
            <input className="setup-input mono" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="https://example.com" />
          </div>
          <div className="desktop-input-group">
            <label className="label">Context</label>
            <select className="setup-input mono" value={contextId} onChange={(e) => setContextId(e.target.value)}>
              <option value="">Default (ephemeral)</option>
              {contexts.map((ctx) => (
                <option key={ctx.id} value={ctx.id}>
                  {ctx.name} ({ctx.id.slice(0, 8)})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="card-actions">
          {isActive ? (
            <button className="button danger small" onClick={() => void handleStop()} disabled={acting === "stop"}>
              {acting === "stop" ? <Loader2 className="button-icon spinner-icon" /> : <Square className="button-icon" />}
              Stop Browser
            </button>
          ) : (
            <button className="button success small" onClick={() => void handleStart()} disabled={acting === "start"}>
              {acting === "start" ? <Loader2 className="button-icon spinner-icon" /> : <Play className="button-icon" />}
              Start Browser
            </button>
          )}
        </div>
      </div>

      {/* ========== Missing Dependencies ========== */}
      {status?.missingDependencies && status.missingDependencies.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Missing Dependencies</span>
          </div>
          <div className="desktop-chip-list">
            {status.missingDependencies.map((dep) => (
              <span key={dep} className="pill warning">
                {dep}
              </span>
            ))}
          </div>
          {status.installCommand && (
            <>
              <div className="card-meta" style={{ marginTop: 12 }}>
                Install command
              </div>
              <div className="mono desktop-command">{status.installCommand}</div>
            </>
          )}
        </div>
      )}

      {/* ========== Live View Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Globe size={14} style={{ marginRight: 6 }} />
            Live View
          </span>
          {isActive && (
            <button
              className={`button small ${liveViewActive ? "danger" : "success"}`}
              onClick={(e) => {
                e.stopPropagation();
                if (liveViewActive) {
                  setLiveViewActive(false);
                  void getClient()
                    .stopDesktopStream()
                    .catch(() => undefined);
                } else {
                  void getClient()
                    .startDesktopStream()
                    .then(() => {
                      setLiveViewActive(true);
                    })
                    .catch(() => undefined);
                }
              }}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {liveViewActive ? (
                <>
                  <Square size={12} style={{ marginRight: 4 }} />
                  Stop Stream
                </>
              ) : (
                <>
                  <Play size={12} style={{ marginRight: 4 }} />
                  Start Stream
                </>
              )}
            </button>
          )}
        </div>

        {liveViewError && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {liveViewError}
          </div>
        )}

        {!isActive && <div className="desktop-screenshot-empty">Start the browser runtime to enable live view.</div>}

        {isActive && liveViewActive && (
          <>
            {/* Navigation Bar */}
            <div className="inline-row" style={{ marginBottom: 8, gap: 4 }}>
              <button
                className="button ghost small"
                onClick={() => void handleBack()}
                disabled={isNavigating}
                style={{ padding: "4px 8px", fontSize: 11, minWidth: 28 }}
                title="Back"
              >
                <ArrowLeft size={12} />
              </button>
              <button
                className="button ghost small"
                onClick={() => void handleForward()}
                disabled={isNavigating}
                style={{ padding: "4px 8px", fontSize: 11, minWidth: 28 }}
                title="Forward"
              >
                <ArrowRight size={12} />
              </button>
              <button
                className="button ghost small"
                onClick={() => void handleReload()}
                disabled={isNavigating}
                style={{ padding: "4px 8px", fontSize: 11, minWidth: 28 }}
                title="Reload"
              >
                <RefreshCw size={12} className={isNavigating ? "spinner-icon" : ""} />
              </button>
              <input
                className="setup-input mono"
                value={navUrl}
                onChange={(e) => setNavUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleNavigate(navUrl);
                  }
                }}
                placeholder="Enter URL..."
                style={{ flex: 1, fontSize: 11 }}
              />
            </div>

            <DesktopViewer
              client={viewerClient}
              height={360}
              showStatusBar={false}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "linear-gradient(180deg, rgba(15, 23, 42, 0.92) 0%, rgba(17, 24, 39, 0.98) 100%)",
                boxShadow: "none",
              }}
            />

            {status?.url && (
              <div className="mono" style={{ marginTop: 4, fontSize: 10, color: "var(--muted)", wordBreak: "break-all" }}>
                {status.url}
              </div>
            )}
          </>
        )}

        {isActive && !liveViewActive && <div className="desktop-screenshot-empty">Click "Start Stream" for live browser view.</div>}
      </div>

      {/* ========== Screenshot Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Camera size={14} style={{ marginRight: 6 }} />
              Screenshot
            </span>
            <button
              className="button secondary small"
              onClick={() => void refreshScreenshot()}
              disabled={screenshotLoading}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {screenshotLoading ? <Loader2 size={12} className="spinner-icon" /> : <Camera size={12} style={{ marginRight: 4 }} />}
              Capture
            </button>
          </div>

          <div className="desktop-screenshot-controls">
            <div className="desktop-input-group">
              <label className="label">Format</label>
              <select className="setup-input mono" value={screenshotFormat} onChange={(e) => setScreenshotFormat(e.target.value as "png" | "jpeg" | "webp")}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </div>
            {screenshotFormat !== "png" && (
              <div className="desktop-input-group">
                <label className="label">Quality</label>
                <input
                  className="setup-input mono"
                  value={screenshotQuality}
                  onChange={(e) => setScreenshotQuality(e.target.value)}
                  inputMode="numeric"
                  style={{ maxWidth: 60 }}
                />
              </div>
            )}
            <label className="desktop-checkbox-label">
              <input type="checkbox" checked={screenshotFullPage} onChange={(e) => setScreenshotFullPage(e.target.checked)} />
              Full page
            </label>
            <div className="desktop-input-group">
              <label className="label">Selector</label>
              <input
                className="setup-input mono"
                value={screenshotSelector}
                onChange={(e) => setScreenshotSelector(e.target.value)}
                placeholder="e.g. #main"
                style={{ maxWidth: 140 }}
              />
            </div>
          </div>

          {screenshotError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {screenshotError}
            </div>
          )}

          {screenshotUrl ? (
            <div className="desktop-screenshot-frame">
              <img src={screenshotUrl} alt="Browser screenshot" className="desktop-screenshot-image" />
            </div>
          ) : (
            <div className="desktop-screenshot-empty">Click "Capture" to take a browser screenshot.</div>
          )}
        </div>
      )}

      {/* ========== Tabs Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Layers size={14} style={{ marginRight: 6 }} />
              Tabs
            </span>
            <button className="button secondary small" onClick={() => void loadTabs()} disabled={tabsLoading} style={{ padding: "4px 8px", fontSize: 11 }}>
              {tabsLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
            </button>
          </div>

          {tabsError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {tabsError}
            </div>
          )}

          {tabs.length > 0 ? (
            <div className="desktop-process-list">
              {tabs.map((tab) => (
                <div key={tab.id} className={`desktop-window-item ${tab.active ? "desktop-window-focused" : ""}`}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong style={{ fontSize: 12 }}>{tab.title || "(untitled)"}</strong>
                      {tab.active && (
                        <span className="pill success" style={{ marginLeft: 8 }}>
                          active
                        </span>
                      )}
                      <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, wordBreak: "break-all" }}>
                        {tab.url}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                      {!tab.active && (
                        <button
                          className="button ghost small"
                          title="Activate"
                          onClick={() => void handleActivateTab(tab.id)}
                          disabled={tabActing === tab.id}
                          style={{ padding: "4px 8px", fontSize: 11 }}
                        >
                          {tabActing === tab.id ? <Loader2 size={12} className="spinner-icon" /> : <Play size={12} />}
                        </button>
                      )}
                      <button
                        className="button ghost small"
                        title="Close"
                        onClick={() => void handleCloseTab(tab.id)}
                        disabled={tabActing === tab.id}
                        style={{ padding: "4px 8px", fontSize: 11 }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="desktop-screenshot-empty">No tabs open.</div>
          )}

          <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
            <input
              className="setup-input mono"
              value={newTabUrl}
              onChange={(e) => setNewTabUrl(e.target.value)}
              placeholder="https://example.com"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateTab();
              }}
              style={{ flex: 1, fontSize: 11 }}
            />
            <button
              className="button secondary small"
              onClick={() => void handleCreateTab()}
              disabled={tabActing === "new"}
              style={{ padding: "4px 10px", fontSize: 11 }}
            >
              {tabActing === "new" ? <Loader2 size={12} className="spinner-icon" /> : <Plus size={12} style={{ marginRight: 4 }} />}
              New Tab
            </button>
          </div>
        </div>
      )}

      {/* ========== Console Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Terminal size={14} style={{ marginRight: 6 }} />
              Console
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                className="button secondary small"
                onClick={() => void loadConsole()}
                disabled={consoleLoading}
                style={{ padding: "4px 8px", fontSize: 11 }}
              >
                {consoleLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
              </button>
            </div>
          </div>

          {/* Level filter pills */}
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
            {CONSOLE_LEVELS.map((level) => (
              <button
                key={level}
                className={`button small ${consoleLevel === level ? "secondary" : "ghost"}`}
                onClick={() => setConsoleLevel(level)}
                style={{ padding: "2px 10px", fontSize: 11, textTransform: "capitalize" }}
              >
                {level}
              </button>
            ))}
          </div>

          {consoleError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {consoleError}
            </div>
          )}

          {consoleMessages.length > 0 ? (
            <div
              style={{
                maxHeight: 240,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 6,
                background: "var(--background, #0f172a)",
              }}
            >
              {consoleMessages.map((msg, idx) => (
                <div
                  key={`${msg.timestamp}-${idx}`}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "3px 4px",
                    fontSize: 11,
                    fontFamily: "monospace",
                    borderBottom: idx < consoleMessages.length - 1 ? "1px solid var(--border)" : undefined,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: consoleLevelColor(msg.level),
                      flexShrink: 0,
                      marginTop: 5,
                    }}
                  />
                  <span style={{ color: consoleLevelColor(msg.level), minWidth: 36, flexShrink: 0 }}>{msg.level}</span>
                  <span style={{ flex: 1, wordBreak: "break-all", color: "var(--foreground, #e2e8f0)" }}>{msg.text}</span>
                  <span style={{ color: "var(--muted)", flexShrink: 0, fontSize: 10 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          ) : (
            <div className="desktop-screenshot-empty">No console messages.</div>
          )}
        </div>
      )}

      {/* ========== Network Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Video size={14} style={{ marginRight: 6 }} />
              Network
            </span>
            <button
              className="button secondary small"
              onClick={() => void loadNetwork()}
              disabled={networkLoading}
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              {networkLoading ? <Loader2 size={12} className="spinner-icon" /> : <RefreshCw size={12} />}
            </button>
          </div>

          <div style={{ marginBottom: 8 }}>
            <input
              className="setup-input mono"
              value={networkUrlPattern}
              onChange={(e) => setNetworkUrlPattern(e.target.value)}
              placeholder="Filter by URL pattern..."
              style={{ width: "100%", fontSize: 11 }}
            />
          </div>

          {networkError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {networkError}
            </div>
          )}

          {networkRequests.length > 0 ? (
            <div
              style={{
                maxHeight: 280,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--background, #0f172a)",
              }}
            >
              {networkRequests.map((req, idx) => (
                <div
                  key={`${req.timestamp}-${idx}`}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "4px 8px",
                    fontSize: 11,
                    fontFamily: "monospace",
                    borderBottom: idx < networkRequests.length - 1 ? "1px solid var(--border)" : undefined,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      minWidth: 36,
                      fontWeight: 600,
                      color: "var(--info, #3b82f6)",
                      flexShrink: 0,
                    }}
                  >
                    {req.method}
                  </span>
                  <span
                    style={{
                      minWidth: 28,
                      flexShrink: 0,
                      color:
                        req.status && req.status >= 400
                          ? "var(--danger, #ef4444)"
                          : req.status && req.status >= 300
                            ? "var(--warning, #f59e0b)"
                            : "var(--success, #22c55e)",
                    }}
                  >
                    {req.status ?? "..."}
                  </span>
                  <span style={{ flex: 1, wordBreak: "break-all", color: "var(--foreground, #e2e8f0)" }}>{req.url}</span>
                  <span style={{ color: "var(--muted)", flexShrink: 0, fontSize: 10 }}>{req.responseSize != null ? formatBytes(req.responseSize) : ""}</span>
                  <span style={{ color: "var(--muted)", flexShrink: 0, fontSize: 10, minWidth: 40, textAlign: "right" }}>
                    {req.duration != null ? `${req.duration}ms` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="desktop-screenshot-empty">No network requests captured.</div>
          )}
        </div>
      )}

      {/* ========== Content Tools Section ========== */}
      {isActive && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <Code size={14} style={{ marginRight: 6 }} />
              Content Tools
            </span>
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {(["html", "markdown", "links", "snapshot"] as const).map((type) => (
              <button
                key={type}
                className="button secondary small"
                onClick={() => void handleGetContent(type)}
                disabled={contentLoading !== null}
                style={{ padding: "4px 10px", fontSize: 11, textTransform: "capitalize" }}
              >
                {contentLoading === type ? <Loader2 size={12} className="spinner-icon" style={{ marginRight: 4 }} /> : null}
                Get {type === "html" ? "HTML" : type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>

          {contentError && (
            <div className="banner error" style={{ marginBottom: 8 }}>
              {contentError}
            </div>
          )}

          {contentOutput ? (
            <textarea
              className="mono"
              readOnly
              value={contentOutput}
              style={{
                width: "100%",
                minHeight: 160,
                maxHeight: 320,
                resize: "vertical",
                fontSize: 11,
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--background, #0f172a)",
                color: "var(--foreground, #e2e8f0)",
              }}
            />
          ) : (
            <div className="desktop-screenshot-empty">Click a button above to extract page content.</div>
          )}
        </div>
      )}

      {/* ========== Recording Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Circle size={14} style={{ marginRight: 6, fill: activeRecording ? "#ff3b30" : "none" }} />
            Recording
          </span>
          {activeRecording && <span className="pill danger">Recording</span>}
        </div>
        {recordingError && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {recordingError}
          </div>
        )}
        {!isActive && <div className="desktop-screenshot-empty">Start the browser runtime to enable recording.</div>}
        {isActive && (
          <>
            <div className="desktop-start-controls" style={{ gridTemplateColumns: "1fr" }}>
              <div className="desktop-input-group">
                <label className="label">FPS</label>
                <input
                  className="setup-input mono"
                  value={recordingFps}
                  onChange={(e) => setRecordingFps(e.target.value)}
                  inputMode="numeric"
                  style={{ maxWidth: 80 }}
                  disabled={!!activeRecording}
                />
              </div>
            </div>
            <div className="card-actions">
              {!activeRecording ? (
                <button className="button danger small" onClick={() => void handleStartRecording()} disabled={recordingActing === "start"}>
                  {recordingActing === "start" ? (
                    <Loader2 className="button-icon spinner-icon" />
                  ) : (
                    <Circle size={14} className="button-icon" style={{ fill: "#ff3b30" }} />
                  )}
                  Start Recording
                </button>
              ) : (
                <button className="button secondary small" onClick={() => void handleStopRecording()} disabled={recordingActing === "stop"}>
                  {recordingActing === "stop" ? <Loader2 className="button-icon spinner-icon" /> : <Square className="button-icon" />}
                  Stop Recording
                </button>
              )}
              <button className="button secondary small" onClick={() => void loadRecordings()} disabled={recordingLoading}>
                <RefreshCw className={`button-icon ${recordingLoading ? "spinner-icon" : ""}`} />
                Refresh
              </button>
            </div>
            {recordings.length > 0 && (
              <div className="desktop-process-list" style={{ marginTop: 12 }}>
                {recordings.map((rec) => (
                  <div key={rec.id} className="desktop-process-item">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div>
                        <strong className="mono" style={{ fontSize: 12 }}>
                          {rec.fileName}
                        </strong>
                        <span
                          className={`pill ${rec.status === "recording" ? "danger" : rec.status === "completed" ? "success" : "warning"}`}
                          style={{ marginLeft: 8 }}
                        >
                          {rec.status}
                        </span>
                      </div>
                      {rec.status === "completed" && (
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="button ghost small"
                            title="Download"
                            onClick={() => void handleDownloadRecording(rec.id, rec.fileName)}
                            disabled={downloadingRecordingId === rec.id}
                            style={{ padding: "4px 6px" }}
                          >
                            {downloadingRecordingId === rec.id ? <Loader2 size={14} className="spinner-icon" /> : <Download size={14} />}
                          </button>
                          <button
                            className="button ghost small"
                            title="Delete"
                            onClick={() => void handleDeleteRecording(rec.id)}
                            disabled={deletingRecordingId === rec.id}
                            style={{ padding: "4px 6px", color: "var(--danger)" }}
                          >
                            {deletingRecordingId === rec.id ? <Loader2 size={14} className="spinner-icon" /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                      {formatBytes(rec.bytes)}
                      {" \u00b7 "}
                      {formatDuration(rec.startedAt, rec.endedAt)}
                      {" \u00b7 "}
                      {formatStartedAt(rec.startedAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {recordings.length === 0 && !recordingLoading && (
              <div className="desktop-screenshot-empty" style={{ marginTop: 8 }}>
                No recordings yet. Click "Start Recording" to begin.
              </div>
            )}
          </>
        )}
      </div>

      {/* ========== Contexts Section ========== */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">
            <Database size={14} style={{ marginRight: 6 }} />
            Browser Contexts
          </span>
          <button className="button secondary small" onClick={() => void loadContexts()} style={{ padding: "4px 8px", fontSize: 11 }}>
            <RefreshCw size={12} />
          </button>
        </div>

        {contextError && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {contextError}
          </div>
        )}

        {contexts.length > 0 ? (
          <div className="desktop-process-list">
            {contexts.map((ctx) => (
              <div key={ctx.id} className={`desktop-process-item ${contextId === ctx.id ? "desktop-window-focused" : ""}`}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ fontSize: 12 }}>{ctx.name}</strong>
                    {contextId === ctx.id && (
                      <span className="pill success" style={{ marginLeft: 8 }}>
                        selected
                      </span>
                    )}
                    <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      {ctx.id.slice(0, 12)} {ctx.sizeBytes != null ? ` \u00b7 ${formatBytes(ctx.sizeBytes)}` : ""} {" \u00b7 "}{" "}
                      {new Date(ctx.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                    {contextId !== ctx.id && (
                      <button
                        className="button ghost small"
                        title="Use this context"
                        onClick={() => setContextId(ctx.id)}
                        style={{ padding: "4px 8px", fontSize: 11 }}
                      >
                        Use
                      </button>
                    )}
                    <button
                      className="button ghost small"
                      title="Delete"
                      onClick={() => void handleDeleteContext(ctx.id)}
                      disabled={contextActing === ctx.id}
                      style={{ padding: "4px 6px", color: "var(--danger)" }}
                    >
                      {contextActing === ctx.id ? <Loader2 size={14} className="spinner-icon" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="desktop-screenshot-empty">No browser contexts. Using ephemeral profile.</div>
        )}

        <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <input
            className="setup-input mono"
            value={contextName}
            onChange={(e) => setContextName(e.target.value)}
            placeholder="Context name..."
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateContext();
            }}
            style={{ flex: 1, fontSize: 11 }}
          />
          <button
            className="button secondary small"
            onClick={() => void handleCreateContext()}
            disabled={contextActing === "create" || !contextName.trim()}
            style={{ padding: "4px 10px", fontSize: 11 }}
          >
            {contextActing === "create" ? <Loader2 size={12} className="spinner-icon" /> : <Plus size={12} style={{ marginRight: 4 }} />}
            Create
          </button>
        </div>
      </div>

      {/* ========== Diagnostics Section ========== */}
      {(status?.lastError || (status?.processes?.length ?? 0) > 0) && (
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
                    <div className="mono">{process.pid ? `pid ${process.pid}` : "no pid"}</div>
                    {process.logPath && <div className="mono">{process.logPath}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BrowserTab;
