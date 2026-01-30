import { useEffect, useRef, useState, useCallback } from "react";
import { init, Terminal as GhosttyTerminal, FitAddon } from "ghostty-web";

export interface TerminalProps {
  /** WebSocket URL for terminal connection */
  wsUrl: string;
  /** Whether the terminal is currently active/focused */
  active?: boolean;
  /** Callback when the terminal is closed */
  onClose?: () => void;
  /** Callback when the terminal connection status changes */
  onConnectionChange?: (connected: boolean) => void;
  /** Initial number of columns */
  cols?: number;
  /** Initial number of rows */
  rows?: number;
}

interface TerminalMessage {
  type: "data" | "input" | "resize" | "exit" | "error";
  data?: string;
  cols?: number;
  rows?: number;
  code?: number | null;
  message?: string;
}

// Module-level initialization state
let ghosttyInitialized = false;
let ghosttyInitPromise: Promise<void> | null = null;

async function ensureGhosttyInitialized(): Promise<void> {
  if (ghosttyInitialized) return;
  if (ghosttyInitPromise) return ghosttyInitPromise;
  
  ghosttyInitPromise = init().then(() => {
    ghosttyInitialized = true;
  });
  
  return ghosttyInitPromise;
}

const Terminal = ({
  wsUrl,
  active = true,
  onClose,
  onConnectionChange,
  cols = 80,
  rows = 24,
}: TerminalProps) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<GhosttyTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Send resize message
  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: TerminalMessage = { type: "resize", cols, rows };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Initialize ghostty-web and terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    let disposed = false;
    let term: GhosttyTerminal | null = null;
    let fitAddon: FitAddon | null = null;

    const initTerminal = async () => {
      // Initialize WASM module
      await ensureGhosttyInitialized();
      
      if (disposed || !terminalRef.current) return;

      term = new GhosttyTerminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: "#1a1a1a",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          cursorAccent: "#1a1a1a",
          selectionBackground: "#264f78",
          black: "#000000",
          red: "#cd3131",
          green: "#0dbc79",
          yellow: "#e5e510",
          blue: "#2472c8",
          magenta: "#bc3fbc",
          cyan: "#11a8cd",
          white: "#e5e5e5",
          brightBlack: "#666666",
          brightRed: "#f14c4c",
          brightGreen: "#23d18b",
          brightYellow: "#f5f543",
          brightBlue: "#3b8eea",
          brightMagenta: "#d670d6",
          brightCyan: "#29b8db",
          brightWhite: "#e5e5e5",
        },
        cols,
        rows,
        scrollback: 5000,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);

      // Fit terminal to container
      setTimeout(() => fitAddon?.fit(), 0);

      // Enable auto-resize when container changes
      fitAddon.observeResize();

      // Handle terminal resize events from ghostty-web
      term.onResize((size: { cols: number; rows: number }) => {
        sendResize(size.cols, size.rows);
      });

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      setInitialized(true);
    };

    initTerminal().catch((err) => {
      console.error("Failed to initialize ghostty-web:", err);
      setError("Failed to initialize terminal");
    });

    // Handle window resize (backup for browsers that don't trigger ResizeObserver)
    const handleResize = () => {
      fitAddonRef.current?.fit();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleResize);
      term?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [cols, rows, sendResize]);

  // Connect WebSocket after terminal is initialized
  useEffect(() => {
    if (!wsUrl || !initialized || !termRef.current) return;

    setError(null);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      onConnectionChange?.(true);
      termRef.current?.writeln("\x1b[32m● Connected to terminal\x1b[0m\r\n");
      
      // Send initial resize
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        sendResize(cols, rows);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg: TerminalMessage = JSON.parse(event.data);
        
        switch (msg.type) {
          case "data":
            if (msg.data) {
              termRef.current?.write(msg.data);
            }
            break;
          case "exit":
            termRef.current?.writeln(`\r\n\x1b[33m● Process exited with code ${msg.code ?? "unknown"}\x1b[0m`);
            onClose?.();
            break;
          case "error":
            setError(msg.message || "Unknown error");
            termRef.current?.writeln(`\r\n\x1b[31m● Error: ${msg.message}\x1b[0m`);
            break;
        }
      } catch (e) {
        // Handle binary data
        if (event.data instanceof Blob) {
          event.data.text().then((text: string) => {
            termRef.current?.write(text);
          });
        }
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection error");
      setConnected(false);
      onConnectionChange?.(false);
    };

    ws.onclose = () => {
      setConnected(false);
      onConnectionChange?.(false);
      termRef.current?.writeln("\r\n\x1b[31m● Disconnected from terminal\x1b[0m");
    };

    // Handle terminal input
    const onData = termRef.current.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: TerminalMessage = { type: "input", data };
        ws.send(JSON.stringify(msg));
      }
    });

    return () => {
      onData.dispose();
      ws.close();
      wsRef.current = null;
    };
  }, [wsUrl, initialized, onClose, onConnectionChange, sendResize]);

  // Focus terminal when active
  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
    }
  }, [active, initialized]);

  return (
    <div className="terminal-container" style={{ height: "100%", position: "relative" }}>
      {error && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "var(--color-error)",
            color: "white",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 12,
            zIndex: 10,
          }}
        >
          {error}
        </div>
      )}
      <div
        ref={terminalRef}
        style={{
          height: "100%",
          width: "100%",
          background: "#1a1a1a",
          borderRadius: 4,
          overflow: "hidden",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 4,
          right: 8,
          fontSize: 10,
          color: connected ? "var(--color-success)" : "var(--color-muted)",
        }}
      >
        {connected ? "● Connected" : "○ Disconnected"}
      </div>
    </div>
  );
};

export default Terminal;
