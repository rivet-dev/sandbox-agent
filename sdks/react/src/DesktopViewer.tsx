"use client";

import type { CSSProperties, MouseEvent, WheelEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { DesktopMouseButton, DesktopStreamErrorStatus, DesktopStreamReadyStatus, SandboxAgent } from "sandbox-agent";

type ConnectionState = "connecting" | "ready" | "closed" | "error";

export type DesktopViewerClient = Pick<SandboxAgent, "connectDesktopStream">;

export interface DesktopViewerClassNames {
  root?: string;
  statusBar?: string;
  statusText?: string;
  statusResolution?: string;
  viewport?: string;
  video?: string;
}

export interface DesktopViewerProps {
  client: DesktopViewerClient;
  className?: string;
  classNames?: Partial<DesktopViewerClassNames>;
  style?: CSSProperties;
  imageStyle?: CSSProperties;
  height?: number | string;
  showStatusBar?: boolean;
  onConnect?: (status: DesktopStreamReadyStatus) => void;
  onDisconnect?: () => void;
  onError?: (error: DesktopStreamErrorStatus | Error) => void;
}

const layoutStyles = {
  shell: { display: "flex", flexDirection: "column", overflow: "hidden" } as CSSProperties,
  statusBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } as CSSProperties,
  viewport: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" } as CSSProperties,
  video: { display: "block", width: "100%", height: "100%", objectFit: "contain", userSelect: "none" } as CSSProperties,
};

export const DesktopViewer = ({
  client,
  className,
  classNames,
  style,
  imageStyle,
  height = 480,
  showStatusBar = true,
  onConnect,
  onDisconnect,
  onError,
}: DesktopViewerProps) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<ReturnType<DesktopViewerClient["connectDesktopStream"]> | null>(null);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [statusMessage, setStatusMessage] = useState("Starting desktop stream...");
  const [hasVideo, setHasVideo] = useState(false);
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);

  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;

    setConnectionState("connecting");
    setStatusMessage("Connecting to desktop stream...");
    setResolution(null);
    setHasVideo(false);

    const session = client.connectDesktopStream();
    sessionRef.current = session;

    session.onReady((status) => {
      if (cancelled) return;
      setConnectionState("ready");
      setStatusMessage("Desktop stream connected.");
      setResolution({ width: status.width, height: status.height });
      onConnectRef.current?.(status);
    });
    session.onTrack((stream) => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
        setHasVideo(true);
      }
    });
    session.onError((error) => {
      if (cancelled) return;
      setConnectionState("error");
      setStatusMessage(error instanceof Error ? error.message : error.message);
      onErrorRef.current?.(error);
    });
    session.onDisconnect(() => {
      if (cancelled) return;
      setConnectionState((current) => (current === "error" ? current : "closed"));
      setStatusMessage((current) => (current === "Desktop stream connected." ? "Desktop stream disconnected." : current));
      onDisconnectRef.current?.();
    });

    return () => {
      cancelled = true;
      session.close();
      sessionRef.current = null;
      const video = videoRef.current;
      if (video) {
        video.srcObject = null;
      }
      setHasVideo(false);
    };
  }, [client]);

  const scalePoint = (clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video || !resolution) {
      return null;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    // The video uses objectFit: "contain", so we need to compute the actual
    // rendered content area within the <video> element to map coordinates
    // accurately (ignoring letterbox bars).
    const videoAspect = resolution.width / resolution.height;
    const elemAspect = rect.width / rect.height;
    let renderW: number;
    let renderH: number;
    if (elemAspect > videoAspect) {
      // Pillarboxed (black bars on left/right)
      renderH = rect.height;
      renderW = rect.height * videoAspect;
    } else {
      // Letterboxed (black bars on top/bottom)
      renderW = rect.width;
      renderH = rect.width / videoAspect;
    }
    const offsetX = (rect.width - renderW) / 2;
    const offsetY = (rect.height - renderH) / 2;
    const relX = clientX - rect.left - offsetX;
    const relY = clientY - rect.top - offsetY;
    const x = Math.max(0, Math.min(resolution.width, (relX / renderW) * resolution.width));
    const y = Math.max(0, Math.min(resolution.height, (relY / renderH) * resolution.height));
    return {
      x: Math.round(x),
      y: Math.round(y),
    };
  };

  const buttonFromMouseEvent = (event: MouseEvent<HTMLDivElement>): DesktopMouseButton => {
    switch (event.button) {
      case 1:
        return "middle";
      case 2:
        return "right";
      default:
        return "left";
    }
  };

  const withSession = (callback: (session: NonNullable<ReturnType<DesktopViewerClient["connectDesktopStream"]>>) => void) => {
    const session = sessionRef.current;
    if (session) {
      callback(session);
    }
  };

  return (
    <div className={classNames?.root ?? className} data-slot="root" data-state={connectionState} style={{ ...layoutStyles.shell, ...style }}>
      {showStatusBar ? (
        <div className={classNames?.statusBar} data-slot="status-bar" style={layoutStyles.statusBar}>
          <span className={classNames?.statusText} data-slot="status-text" data-state={connectionState}>
            {statusMessage}
          </span>
          <span className={classNames?.statusResolution} data-slot="status-resolution">
            {resolution ? `${resolution.width}×${resolution.height}` : "Awaiting stream"}
          </span>
        </div>
      ) : null}
      <div
        ref={wrapperRef}
        className={classNames?.viewport}
        data-slot="viewport"
        role="button"
        tabIndex={0}
        style={{ ...layoutStyles.viewport, height }}
        onMouseMove={(event) => {
          const point = scalePoint(event.clientX, event.clientY);
          if (!point) {
            return;
          }
          withSession((session) => session.moveMouse(point.x, point.y));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          // preventDefault on mousedown suppresses the default focus behavior,
          // so we must explicitly focus the wrapper to receive keyboard events.
          wrapperRef.current?.focus();
          const point = scalePoint(event.clientX, event.clientY);
          withSession((session) => session.mouseDown(buttonFromMouseEvent(event), point?.x, point?.y));
        }}
        onMouseUp={(event) => {
          const point = scalePoint(event.clientX, event.clientY);
          withSession((session) => session.mouseUp(buttonFromMouseEvent(event), point?.x, point?.y));
        }}
        onWheel={(event: WheelEvent<HTMLDivElement>) => {
          event.preventDefault();
          const point = scalePoint(event.clientX, event.clientY);
          if (!point) {
            return;
          }
          withSession((session) => session.scroll(point.x, point.y, Math.round(event.deltaX), Math.round(event.deltaY)));
        }}
        onKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          withSession((session) => session.keyDown(event.key));
        }}
        onKeyUp={(event) => {
          event.preventDefault();
          event.stopPropagation();
          withSession((session) => session.keyUp(event.key));
        }}
      >
        <video
          ref={videoRef}
          className={classNames?.video}
          data-slot="video"
          autoPlay
          playsInline
          muted
          tabIndex={-1}
          draggable={false}
          style={{ ...layoutStyles.video, ...imageStyle, display: hasVideo ? "block" : "none", pointerEvents: "none" }}
        />
      </div>
    </div>
  );
};
