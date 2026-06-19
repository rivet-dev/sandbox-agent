use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};

use crate::browser_errors::BrowserProblem;

/// WebSocket stream type returned by `tokio_tungstenite::connect_async`.
type CdpWsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Chrome DevTools Protocol client.
///
/// Maintains a persistent WebSocket connection to Chromium's debugging port
/// for sending commands and receiving events.
pub struct CdpClient {
    ws_sender: Arc<Mutex<futures::stream::SplitSink<CdpWsStream, Message>>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Value>>>>>,
    reader_task: JoinHandle<()>,
}

impl CdpClient {
    /// CDP debugging port on localhost.
    const CDP_PORT: u16 = 9222;

    /// Default timeout for CDP commands.
    const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

    /// Connect to Chromium's CDP endpoint.
    ///
    /// Discovers the first open page via `http://127.0.0.1:9222/json/list`
    /// and connects to its page-level WebSocket debugger URL. This enables
    /// Page, Runtime, DOM, and other page-level CDP domains. Browser-level
    /// commands like Target.* also work through page connections.
    pub async fn connect() -> Result<Self, BrowserProblem> {
        // Connect to the first page endpoint so that Page/Runtime/DOM commands work.
        // The browser-level endpoint (/devtools/browser/{id}) only supports
        // browser-level domains like Target and Browser.
        let list_url = format!("http://127.0.0.1:{}/json/list", Self::CDP_PORT);

        let resp = reqwest::get(&list_url).await.map_err(|e| {
            BrowserProblem::cdp_error(format!("failed to reach CDP endpoint at {list_url}: {e}"))
        })?;

        let pages: Vec<Value> = resp
            .json()
            .await
            .map_err(|e| BrowserProblem::cdp_error(format!("invalid JSON from {list_url}: {e}")))?;

        let ws_url = pages
            .iter()
            .find(|p| p.get("type").and_then(|v| v.as_str()) == Some("page"))
            .and_then(|p| p.get("webSocketDebuggerUrl").and_then(|v| v.as_str()))
            .ok_or_else(|| {
                BrowserProblem::cdp_error(
                    "no page target with webSocketDebuggerUrl found in /json/list",
                )
            })?
            .to_string();

        debug!(ws_url = %ws_url, "connecting to CDP page endpoint");

        let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| {
                BrowserProblem::cdp_error(format!("WebSocket connection to {ws_url} failed: {e}"))
            })?;

        let (ws_sink, ws_read) = ws_stream.split();

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let reader_pending = pending.clone();
        let reader_subscribers = subscribers.clone();
        let reader_task = tokio::spawn(Self::reader_loop(
            ws_read,
            reader_pending,
            reader_subscribers,
        ));

        Ok(Self {
            ws_sender: Arc::new(Mutex::new(ws_sink)),
            next_id: AtomicU64::new(1),
            pending,
            subscribers,
            reader_task,
        })
    }

    /// Send a CDP command and wait for the matching response.
    ///
    /// Returns the `result` field from the CDP response, or a `BrowserProblem`
    /// if the command fails or times out.
    pub async fn send(&self, method: &str, params: Option<Value>) -> Result<Value, BrowserProblem> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let msg = json!({
            "id": id,
            "method": method,
            "params": params.unwrap_or_else(|| Value::Object(Default::default())),
        });

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let text = serde_json::to_string(&msg).map_err(|e| {
            BrowserProblem::cdp_error(format!("failed to serialize CDP command: {e}"))
        })?;

        if let Err(e) = self
            .ws_sender
            .lock()
            .await
            .send(Message::Text(text.into()))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(BrowserProblem::cdp_error(format!(
                "failed to send CDP command '{method}': {e}"
            )));
        }

        let result = tokio::time::timeout(Self::COMMAND_TIMEOUT, rx)
            .await
            .map_err(|_| {
                BrowserProblem::timeout(format!(
                    "CDP command '{method}' timed out after {}s",
                    Self::COMMAND_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|_| BrowserProblem::cdp_error("CDP response channel closed unexpectedly"))?;

        result.map_err(BrowserProblem::cdp_error)
    }

    /// Subscribe to a CDP event by method name.
    ///
    /// Returns a receiver that delivers event params each time the specified
    /// event fires. The subscription remains active until the receiver is dropped.
    pub async fn subscribe(&self, event: &str) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers
            .lock()
            .await
            .entry(event.to_string())
            .or_default()
            .push(tx);
        rx
    }

    /// Check whether the CDP WebSocket connection is still alive.
    ///
    /// Returns `true` if the background reader task is still running, which
    /// means the WebSocket connection has not been closed or errored.
    pub fn is_alive(&self) -> bool {
        !self.reader_task.is_finished()
    }

    /// Close the CDP connection and stop the reader task.
    pub async fn close(&self) {
        self.reader_task.abort();
        let _ = self.ws_sender.lock().await.close().await;
    }

    /// Background loop that reads WebSocket messages and dispatches them.
    ///
    /// Messages with an `id` field are routed to the matching pending request.
    /// Messages with a `method` field (no `id`) are broadcast to event subscribers.
    async fn reader_loop(
        mut ws_stream: futures::stream::SplitStream<CdpWsStream>,
        pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
        subscribers: Arc<Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Value>>>>>,
    ) {
        while let Some(msg) = ws_stream.next().await {
            let text = match msg {
                Ok(Message::Text(t)) => t,
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(e) => {
                    warn!(error = %e, "CDP WebSocket read error");
                    break;
                }
            };

            let parsed: Value = match serde_json::from_str(&text.to_string()) {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = %e, "CDP received invalid JSON");
                    continue;
                }
            };

            if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) {
                // Response to a pending command
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let result = if let Some(error) = parsed.get("error") {
                        let msg = error
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown CDP error");
                        Err(msg.to_string())
                    } else {
                        Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                }
            } else if let Some(method) = parsed.get("method").and_then(|v| v.as_str()) {
                // Event notification
                let params = parsed.get("params").cloned().unwrap_or(Value::Null);
                let mut subs = subscribers.lock().await;
                if let Some(listeners) = subs.get_mut(method) {
                    listeners.retain(|tx| tx.send(params.clone()).is_ok());
                }
            }
        }

        // Connection closed: fail all pending requests
        for (_, tx) in pending.lock().await.drain() {
            let _ = tx.send(Err("CDP WebSocket connection closed".to_string()));
        }
    }
}

impl Drop for CdpClient {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}
