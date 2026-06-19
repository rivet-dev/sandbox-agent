"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserNavigateRequest,
  BrowserPageInfo,
  BrowserStatusResponse,
  DesktopStreamErrorStatus,
  DesktopStreamReadyStatus,
  SandboxAgent,
} from "sandbox-agent";
import { DesktopViewer } from "./DesktopViewer.tsx";
import type { DesktopViewerProps } from "./DesktopViewer.tsx";

export type BrowserViewerClient = Pick<
  SandboxAgent,
  "connectDesktopStream" | "browserNavigate" | "browserBack" | "browserForward" | "browserReload" | "getBrowserStatus"
>;

export interface BrowserViewerProps {
  client: BrowserViewerClient;
  className?: string;
  style?: CSSProperties;
  height?: number | string;
  showNavigationBar?: boolean;
  showStatusBar?: boolean;
  onNavigate?: (page: BrowserPageInfo) => void;
  onConnect?: (status: DesktopStreamReadyStatus) => void;
  onDisconnect?: () => void;
  onError?: (error: DesktopStreamErrorStatus | Error) => void;
}

const navBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 8px",
  borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
  background: "rgba(255, 255, 255, 0.78)",
};

const navButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  border: "1px solid rgba(15, 23, 42, 0.12)",
  borderRadius: 6,
  background: "rgba(255, 255, 255, 0.9)",
  color: "#334155",
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
  flexShrink: 0,
};

const navButtonDisabledStyle: CSSProperties = {
  ...navButtonStyle,
  opacity: 0.4,
  cursor: "default",
};

const urlInputStyle: CSSProperties = {
  flex: 1,
  height: 28,
  padding: "0 8px",
  border: "1px solid rgba(15, 23, 42, 0.12)",
  borderRadius: 6,
  background: "rgba(248, 250, 252, 0.9)",
  color: "#0f172a",
  fontSize: 12,
  lineHeight: "28px",
  outline: "none",
  minWidth: 0,
};

const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  border: "1px solid rgba(15, 23, 42, 0.14)",
  borderRadius: 14,
  background: "linear-gradient(180deg, rgba(248, 250, 252, 0.96) 0%, rgba(226, 232, 240, 0.92) 100%)",
  boxShadow: "0 20px 40px rgba(15, 23, 42, 0.08)",
};

export const BrowserViewer = ({
  client,
  className,
  style,
  height = 480,
  showNavigationBar = true,
  showStatusBar = true,
  onNavigate,
  onConnect,
  onDisconnect,
  onError,
}: BrowserViewerProps) => {
  const [urlInput, setUrlInput] = useState("");
  const [isNavigating, setIsNavigating] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // Sync URL from browser status on connect
  const handleConnect = useCallback(
    (status: DesktopStreamReadyStatus) => {
      client
        .getBrowserStatus()
        .then((browserStatus: BrowserStatusResponse) => {
          if (browserStatus.url) {
            setUrlInput(browserStatus.url);
          }
        })
        .catch(() => undefined);
      onConnect?.(status);
    },
    [client, onConnect],
  );

  const navigate = useCallback(
    async (request: BrowserNavigateRequest) => {
      setIsNavigating(true);
      try {
        const page = await client.browserNavigate(request);
        setUrlInput(page.url ?? "");
        onNavigate?.(page);
      } catch {
        // navigation error handled by caller or silently ignored
      } finally {
        setIsNavigating(false);
      }
    },
    [client, onNavigate],
  );

  const handleBack = useCallback(async () => {
    setIsNavigating(true);
    try {
      const page = await client.browserBack();
      setUrlInput(page.url ?? "");
      onNavigate?.(page);
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  }, [client, onNavigate]);

  const handleForward = useCallback(async () => {
    setIsNavigating(true);
    try {
      const page = await client.browserForward();
      setUrlInput(page.url ?? "");
      onNavigate?.(page);
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  }, [client, onNavigate]);

  const handleReload = useCallback(async () => {
    setIsNavigating(true);
    try {
      const page = await client.browserReload();
      setUrlInput(page.url ?? "");
      onNavigate?.(page);
    } catch {
      // ignore
    } finally {
      setIsNavigating(false);
    }
  }, [client, onNavigate]);

  const handleUrlKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && urlInput.trim()) {
        event.preventDefault();
        let url = urlInput.trim();
        if (!/^https?:\/\//i.test(url)) {
          url = `https://${url}`;
        }
        void navigate({ url });
      }
    },
    [urlInput, navigate],
  );

  // Inner DesktopViewer props: no shell styling (we provide our own), no status bar
  // duplication (BrowserViewer wraps it)
  const desktopViewerProps: DesktopViewerProps = {
    client,
    height,
    showStatusBar,
    onConnect: handleConnect,
    onDisconnect,
    onError,
    style: {
      border: "none",
      borderRadius: 0,
      background: "transparent",
      boxShadow: "none",
    },
  };

  return (
    <div className={className} style={{ ...shellStyle, ...style }}>
      {showNavigationBar ? (
        <div style={navBarStyle}>
          <button
            type="button"
            style={isNavigating ? navButtonDisabledStyle : navButtonStyle}
            disabled={isNavigating}
            onClick={handleBack}
            aria-label="Back"
            title="Back"
          >
            &#x2190;
          </button>
          <button
            type="button"
            style={isNavigating ? navButtonDisabledStyle : navButtonStyle}
            disabled={isNavigating}
            onClick={handleForward}
            aria-label="Forward"
            title="Forward"
          >
            &#x2192;
          </button>
          <button
            type="button"
            style={isNavigating ? navButtonDisabledStyle : navButtonStyle}
            disabled={isNavigating}
            onClick={handleReload}
            aria-label="Reload"
            title="Reload"
          >
            &#x21BB;
          </button>
          <input
            ref={urlInputRef}
            type="text"
            style={urlInputStyle}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            placeholder="Enter URL..."
            aria-label="URL"
          />
        </div>
      ) : null}
      <DesktopViewer {...desktopViewerProps} />
    </div>
  );
};
