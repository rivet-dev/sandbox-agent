import { AlertTriangle, Zap } from "lucide-react";
import { isHttpsToHttpConnection, isLocalNetworkTarget } from "../lib/permissions";

const ConnectScreen = ({
  endpoint,
  token,
  connectError,
  connecting,
  onEndpointChange,
  onTokenChange,
  onConnect,
  reportUrl
}: {
  endpoint: string;
  token: string;
  connectError: string | null;
  connecting: boolean;
  onEndpointChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onConnect: () => void;
  reportUrl?: string;
}) => {
  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo">SA</div>
          <span className="header-title">Sandbox Agent</span>
        </div>
        {reportUrl && (
          <div className="header-right">
            <a className="button ghost small" href={reportUrl} target="_blank" rel="noreferrer">
              Report Bug
            </a>
          </div>
        )}
      </header>

      <main className="landing">
        <div className="landing-container">
          <div className="landing-hero">
            <div className="landing-logo">SA</div>
            <h1 className="landing-title">Sandbox Agent</h1>
            <p className="landing-subtitle">
              Universal API for running Claude Code, Codex, OpenCode, and Amp inside sandboxes.
            </p>
          </div>

          <div className="connect-card">
            <div className="connect-card-title">Connect to Server</div>

            {connectError && <div className="banner error">{connectError}</div>}

            {isHttpsToHttpConnection(window.location.href, endpoint) &&
              isLocalNetworkTarget(endpoint) && (
                <div className="banner warning">
                  <AlertTriangle size={16} />
                  <span>
                    Connecting from HTTPS to a local HTTP server requires{" "}
                    <strong>local network access</strong> permission. Your browser may prompt you to
                    allow this connection.
                  </span>
                </div>
              )}

            <label className="field">
              <span className="label">Endpoint</span>
              <input
                className="input"
                type="text"
                placeholder="http://localhost:2468"
                value={endpoint}
                onChange={(event) => onEndpointChange(event.target.value)}
              />
            </label>

            <label className="field">
              <span className="label">Token (optional)</span>
              <input
                className="input"
                type="password"
                placeholder="Bearer token"
                value={token}
                onChange={(event) => onTokenChange(event.target.value)}
              />
            </label>

            <button className="button primary" onClick={onConnect} disabled={connecting}>
              {connecting ? (
                <>
                  <span className="spinner" />
                  Connecting...
                </>
              ) : (
                <>
                  <Zap className="button-icon" />
                  Connect
                </>
              )}
            </button>

            <p className="hint">
              Start the server with CORS enabled for browser access:
              <br />
              <code>sandbox-agent server --cors-allow-origin {window.location.origin}</code>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ConnectScreen;
