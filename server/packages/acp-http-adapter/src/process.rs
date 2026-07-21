use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::response::sse::Event;
use futures::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio_stream::wrappers::BroadcastStream;

use crate::registry::LaunchSpec;

const RING_BUFFER_SIZE: usize = 1024;
const STDERR_TAIL_SIZE: usize = 16;
// These requests can outlive ordinary HTTP response-header timeouts. Their JSON-RPC
// response is correlated by id and delivered through the existing SSE stream.
const ASYNC_RESPONSE_METHODS: &[&str] = &["session/prompt"];

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("failed to spawn subprocess: {0}")]
    Spawn(std::io::Error),
    #[error("failed to capture subprocess stdin")]
    MissingStdin,
    #[error("failed to capture subprocess stdout")]
    MissingStdout,
    #[error("failed to capture subprocess stderr")]
    MissingStderr,
    #[error("invalid json-rpc envelope")]
    InvalidEnvelope,
    #[error("failed to serialize json-rpc message: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to write subprocess stdin: {0}")]
    Write(std::io::Error),
    #[error("agent process exited before responding")]
    Exited {
        exit_code: Option<i32>,
        stderr: Option<String>,
    },
    #[error("timeout waiting for response")]
    Timeout,
}

#[derive(Debug)]
pub enum PostOutcome {
    Response(Value),
    Accepted,
}

#[derive(Debug, Clone)]
struct StreamMessage {
    sequence: u64,
    payload: Value,
}

#[derive(Debug)]
pub struct AdapterRuntime {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    sender: broadcast::Sender<StreamMessage>,
    ring: Arc<Mutex<VecDeque<StreamMessage>>>,
    sequence: Arc<AtomicU64>,
    request_timeout: Duration,
    shutting_down: AtomicBool,
    spawned_at: Instant,
    first_stdout: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl AdapterRuntime {
    pub async fn start(
        launch: LaunchSpec,
        request_timeout: Duration,
    ) -> Result<Self, AdapterError> {
        let spawn_start = Instant::now();

        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (key, value) in &launch.env {
            command.env(key, value);
        }

        tracing::info!(
            program = ?launch.program,
            args = ?launch.args,
            "spawning agent process"
        );

        let mut child = command.spawn().map_err(|err| {
            tracing::error!(
                program = ?launch.program,
                error = %err,
                "failed to spawn agent process"
            );
            AdapterError::Spawn(err)
        })?;

        let pid = child.id().unwrap_or(0);
        let spawn_elapsed = spawn_start.elapsed();
        tracing::info!(
            pid = pid,
            elapsed_ms = spawn_elapsed.as_millis() as u64,
            "agent process spawned"
        );

        let stdin = child.stdin.take().ok_or(AdapterError::MissingStdin)?;
        let stdout = child.stdout.take().ok_or(AdapterError::MissingStdout)?;
        let stderr = child.stderr.take().ok_or(AdapterError::MissingStderr)?;

        let (sender, _rx) = broadcast::channel(512);
        let runtime = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sender,
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE))),
            sequence: Arc::new(AtomicU64::new(0)),
            request_timeout,
            shutting_down: AtomicBool::new(false),
            spawned_at: spawn_start,
            first_stdout: Arc::new(AtomicBool::new(false)),
            stderr_tail: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_SIZE))),
        };

        runtime.spawn_stdout_loop(stdout);
        runtime.spawn_stderr_loop(stderr);
        runtime.spawn_exit_watcher();

        Ok(runtime)
    }

    pub async fn post(&self, payload: Value) -> Result<PostOutcome, AdapterError> {
        if !payload.is_object() {
            return Err(AdapterError::InvalidEnvelope);
        }

        let method: String = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>")
            .to_string();
        let has_method = payload.get("method").is_some();
        let id = payload.get("id");

        if has_method && id.is_some() {
            let id_value = id.expect("checked");
            let key = id_key(id_value);
            let (tx, rx) = oneshot::channel();

            let pending_count = self.pending.lock().await.len();
            tracing::info!(
                method = %method,
                id = %key,
                pending_count = pending_count,
                "post: request → agent (awaiting response)"
            );

            self.pending.lock().await.insert(key.clone(), tx);

            let write_start = Instant::now();
            if let Err(err) = self.send_to_subprocess(&payload).await {
                tracing::error!(
                    method = %method,
                    id = %key,
                    error = %err,
                    "post: failed to write to agent stdin"
                );
                self.pending.lock().await.remove(&key);
                return Err(err);
            }
            let write_ms = write_start.elapsed().as_millis() as u64;
            tracing::debug!(
                method = %method,
                id = %key,
                write_ms = write_ms,
                "post: stdin write complete, waiting for response"
            );

            if ASYNC_RESPONSE_METHODS.contains(&method.as_str()) {
                self.spawn_async_response_waiter(method, key, id_value.clone(), rx, write_ms);
                return Ok(PostOutcome::Accepted);
            }

            let wait_start = Instant::now();
            match tokio::time::timeout(self.request_timeout, rx).await {
                Ok(Ok(response)) => {
                    let wait_ms = wait_start.elapsed().as_millis() as u64;
                    tracing::info!(
                        method = %method,
                        id = %key,
                        response_ms = wait_ms,
                        total_ms = write_ms + wait_ms,
                        "post: got response from agent"
                    );
                    Ok(PostOutcome::Response(response))
                }
                Ok(Err(_)) => {
                    let wait_ms = wait_start.elapsed().as_millis() as u64;
                    tracing::error!(
                        method = %method,
                        id = %key,
                        wait_ms = wait_ms,
                        "post: response channel dropped (agent process may have exited)"
                    );
                    self.pending.lock().await.remove(&key);
                    if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
                        tracing::error!(
                            method = %method,
                            id = %key,
                            exit_code = ?exit_code,
                            stderr = ?stderr,
                            "post: agent process exited before response channel completed"
                        );
                        return Err(AdapterError::Exited { exit_code, stderr });
                    }
                    Err(AdapterError::Timeout)
                }
                Err(_) => {
                    let pending_keys: Vec<String> =
                        self.pending.lock().await.keys().cloned().collect();
                    tracing::error!(
                        method = %method,
                        id = %key,
                        timeout_ms = self.request_timeout.as_millis() as u64,
                        age_ms = self.spawned_at.elapsed().as_millis() as u64,
                        pending_keys = ?pending_keys,
                        first_stdout_seen = self.first_stdout.load(Ordering::Relaxed),
                        "post: TIMEOUT waiting for agent response"
                    );
                    self.pending.lock().await.remove(&key);
                    if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
                        tracing::error!(
                            method = %method,
                            id = %key,
                            exit_code = ?exit_code,
                            stderr = ?stderr,
                            "post: agent process exited before timeout completed"
                        );
                        return Err(AdapterError::Exited { exit_code, stderr });
                    }
                    Err(AdapterError::Timeout)
                }
            }
        } else {
            tracing::debug!(
                method = %method,
                "post: notification → agent (fire-and-forget)"
            );
            self.send_to_subprocess(&payload).await?;
            Ok(PostOutcome::Accepted)
        }
    }

    fn spawn_async_response_waiter(
        &self,
        method: String,
        key: String,
        id: Value,
        rx: oneshot::Receiver<Value>,
        write_ms: u64,
    ) {
        let pending = self.pending.clone();
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
        let request_timeout = self.request_timeout;

        tracing::info!(
            method = %method,
            id = %key,
            write_ms = write_ms,
            "post: request accepted; response will be delivered over SSE"
        );

        tokio::spawn(async move {
            match tokio::time::timeout(request_timeout, rx).await {
                Ok(Ok(_)) => {
                    tracing::info!(
                        method = %method,
                        id = %key,
                        "post: asynchronous response delivered over SSE"
                    );
                }
                Ok(Err(_)) => {
                    tracing::error!(
                        method = %method,
                        id = %key,
                        "post: response channel dropped before asynchronous response"
                    );
                }
                Err(_) => {
                    let removed = pending.lock().await.remove(&key).is_some();
                    tracing::error!(
                        method = %method,
                        id = %key,
                        timeout_ms = request_timeout.as_millis() as u64,
                        "post: TIMEOUT waiting for asynchronous agent response"
                    );
                    if removed {
                        broadcast_payload(
                            &sender,
                            &ring,
                            &sequence,
                            json_rpc_error(id, "timed out waiting for agent response"),
                        )
                        .await;
                    }
                }
            }
        });
    }

    async fn subscribe(
        &self,
        last_event_id: Option<u64>,
    ) -> (Vec<(u64, Value)>, u64, broadcast::Receiver<StreamMessage>) {
        // Subscribe before taking the replay snapshot so a concurrently published
        // message is guaranteed to appear in at least one source. The watermark
        // below removes messages that appear in both.
        let receiver = self.sender.subscribe();
        let (replay, replay_watermark) = {
            let ring = self.ring.lock().await;
            let replay_watermark = ring.back().map(|message| message.sequence).unwrap_or(0);
            let replay = ring
                .iter()
                .filter(|message| {
                    last_event_id.is_none_or(|last_event_id| message.sequence > last_event_id)
                })
                .map(|message| (message.sequence, message.payload.clone()))
                .collect::<Vec<_>>();
            (replay, replay_watermark)
        };
        (replay, replay_watermark, receiver)
    }

    pub async fn sse_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
        self.payload_stream(last_event_id)
            .await
            .map(|(sequence, payload)| {
                Ok(Event::default()
                    .event("message")
                    .id(sequence.to_string())
                    .data(payload.to_string()))
            })
    }

    /// Stream of sequenced raw JSON-RPC payloads.
    pub async fn payload_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = (u64, Value)> + Send + 'static {
        let (replay, replay_watermark, rx) = self.subscribe(last_event_id).await;
        let replay_stream = stream::iter(replay);

        let live_stream = BroadcastStream::new(rx).filter_map(move |item| async move {
            match item {
                Ok(message) if message.sequence > replay_watermark => {
                    Some((message.sequence, message.payload))
                }
                Ok(_) => None,
                Err(_) => None,
            }
        });

        replay_stream.chain(live_stream)
    }

    /// Stream of raw JSON-RPC `Value` payloads (without SSE framing).
    /// Useful for consumers that need to inspect the payload contents
    /// rather than forward them as SSE events.
    pub async fn value_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = Value> + Send + 'static {
        self.payload_stream(last_event_id)
            .await
            .map(|(_sequence, payload)| payload)
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }

        tracing::info!(
            age_ms = self.spawned_at.elapsed().as_millis() as u64,
            "shutting down agent process"
        );

        let pending_ids = {
            let mut pending = self.pending.lock().await;
            pending.drain().map(|(id, _)| id).collect::<Vec<_>>()
        };
        for id in pending_ids {
            if let Ok(id) = serde_json::from_str(&id) {
                broadcast_payload(
                    &self.sender,
                    &self.ring,
                    &self.sequence,
                    json_rpc_error(id, "agent process stopped before responding"),
                )
                .await;
            }
        }

        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            Err(_) => {
                let _ = child.kill().await;
            }
        }
    }

    fn spawn_stdout_loop(&self, stdout: tokio::process::ChildStdout) {
        let pending = self.pending.clone();
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
        let spawned_at = self.spawned_at;
        let first_stdout = self.first_stdout.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut line_count: u64 = 0;

            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                line_count += 1;

                if !first_stdout.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        first_stdout_ms = spawned_at.elapsed().as_millis() as u64,
                        line_bytes = trimmed.len(),
                        "agent process: first stdout line received"
                    );
                }

                let payload = match serde_json::from_str::<Value>(trimmed) {
                    Ok(payload) => payload,
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            line_number = line_count,
                            raw = %if trimmed.len() > 200 {
                                format!("{}...", &trimmed[..200])
                            } else {
                                trimmed.to_string()
                            },
                            "agent stdout: invalid JSON"
                        );
                        json!({
                            "jsonrpc": "2.0",
                            "method": "_adapter/invalid_stdout",
                            "params": {
                                "error": err.to_string(),
                                "raw": trimmed,
                            }
                        })
                    }
                };

                let is_response = payload.get("id").is_some() && payload.get("method").is_none();
                if is_response {
                    let key = id_key(payload.get("id").expect("checked"));
                    let has_error = payload.get("error").is_some();
                    if let Some(tx) = pending.lock().await.remove(&key) {
                        tracing::debug!(
                            id = %key,
                            has_error = has_error,
                            age_ms = spawned_at.elapsed().as_millis() as u64,
                            "agent stdout: response matched to pending request"
                        );
                        let _ = tx.send(payload.clone());
                        // Also broadcast the response so SSE/notification subscribers
                        // see it in order after preceding notifications. This lets the
                        // SSE translation task detect turn completion after all
                        // session/update events have been processed.
                        broadcast_payload(&sender, &ring, &sequence, payload).await;
                        continue;
                    } else {
                        tracing::warn!(
                            id = %key,
                            has_error = has_error,
                            "agent stdout: response has no matching pending request (orphan)"
                        );
                        continue;
                    }
                }

                let method = payload
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<none>");
                tracing::debug!(
                    method = method,
                    line_number = line_count,
                    "agent stdout: notification/event → SSE broadcast"
                );

                broadcast_payload(&sender, &ring, &sequence, payload).await;
            }

            tracing::info!(
                total_lines = line_count,
                age_ms = spawned_at.elapsed().as_millis() as u64,
                "agent stdout: stream ended"
            );
        });
    }

    fn spawn_stderr_loop(&self, stderr: tokio::process::ChildStderr) {
        let spawned_at = self.spawned_at;
        let stderr_tail = self.stderr_tail.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut line_count: u64 = 0;

            while let Ok(Some(line)) = lines.next_line().await {
                line_count += 1;
                {
                    let mut tail = stderr_tail.lock().await;
                    tail.push_back(line.clone());
                    while tail.len() > STDERR_TAIL_SIZE {
                        tail.pop_front();
                    }
                }
                tracing::info!(
                    line_number = line_count,
                    age_ms = spawned_at.elapsed().as_millis() as u64,
                    "agent stderr: {}",
                    line
                );
            }

            tracing::debug!(
                total_lines = line_count,
                age_ms = spawned_at.elapsed().as_millis() as u64,
                "agent stderr: stream ended"
            );
        });
    }

    fn spawn_exit_watcher(&self) {
        let child = self.child.clone();
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
        let spawned_at = self.spawned_at;
        let pending = self.pending.clone();

        tokio::spawn(async move {
            let status = loop {
                let status = {
                    let mut guard = child.lock().await;
                    guard.try_wait()
                };
                match status {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
                    Err(_) => break None,
                }
            };

            let age_ms = spawned_at.elapsed().as_millis() as u64;
            let pending_ids = {
                let mut pending = pending.lock().await;
                pending.drain().map(|(id, _)| id).collect::<Vec<_>>()
            };
            let pending_count = pending_ids.len();

            for id in pending_ids {
                if let Ok(id) = serde_json::from_str(&id) {
                    broadcast_payload(
                        &sender,
                        &ring,
                        &sequence,
                        json_rpc_error(id, "agent process stopped before responding"),
                    )
                    .await;
                }
            }

            if let Some(status) = status {
                tracing::warn!(
                    success = status.success(),
                    code = status.code(),
                    age_ms = age_ms,
                    pending_requests = pending_count,
                    "agent process exited"
                );

                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "_adapter/agent_exited",
                    "params": {
                        "success": status.success(),
                        "code": status.code(),
                    }
                });

                broadcast_payload(&sender, &ring, &sequence, payload).await;
            } else {
                tracing::error!(
                    age_ms = age_ms,
                    pending_requests = pending_count,
                    "agent process: failed to get exit status"
                );
            }
        });
    }

    async fn send_to_subprocess(&self, payload: &Value) -> Result<(), AdapterError> {
        let method = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>");
        let id = payload.get("id").map(|v| v.to_string()).unwrap_or_default();

        tracing::debug!(
            method = method,
            id = %id,
            bytes = serde_json::to_vec(payload).map(|b| b.len()).unwrap_or(0),
            "stdin: writing message to agent"
        );

        let mut stdin = self.stdin.lock().await;
        let bytes = serde_json::to_vec(payload).map_err(AdapterError::Serialize)?;
        stdin.write_all(&bytes).await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: write_all failed");
            AdapterError::Write(err)
        })?;
        stdin.write_all(b"\n").await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: newline write failed");
            AdapterError::Write(err)
        })?;
        stdin.flush().await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: flush failed");
            AdapterError::Write(err)
        })?;

        tracing::debug!(method = method, id = %id, "stdin: write+flush complete");
        Ok(())
    }

    async fn try_process_exit_info(&self) -> Option<(Option<i32>, Option<String>)> {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(status)) => {
                let exit_code = status.code();
                drop(child);
                let stderr = self.stderr_tail_summary().await;
                Some((exit_code, stderr))
            }
            Ok(None) => None,
            Err(_) => None,
        }
    }

    pub async fn stderr_tail_summary(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().await;
        if tail.is_empty() {
            return None;
        }
        Some(tail.iter().cloned().collect::<Vec<_>>().join("\n"))
    }
}

async fn broadcast_payload(
    sender: &broadcast::Sender<StreamMessage>,
    ring: &Mutex<VecDeque<StreamMessage>>,
    sequence: &AtomicU64,
    payload: Value,
) {
    // Keep sequence allocation, replay insertion, and live publication ordered.
    // Otherwise concurrent timeout, exit, and stdout tasks can publish a newer
    // sequence before an older one and break Last-Event-ID replay.
    let mut guard = ring.lock().await;
    let sequence = sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let message = StreamMessage { sequence, payload };
    guard.push_back(message.clone());
    while guard.len() > RING_BUFFER_SIZE {
        guard.pop_front();
    }
    let _ = sender.send(message);
}

fn json_rpc_error(id: Value, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32603,
            "message": message,
        }
    })
}

fn id_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;

    #[tokio::test]
    async fn asynchronous_request_response_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                LaunchSpec {
                    program: PathBuf::from("sh"),
                    args: vec![
                        "-c".to_string(),
                        concat!(
                            "IFS= read -r line; ",
                            "printf '%s\\n' ",
                            "'{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}'"
                        )
                        .to_string(),
                    ],
                    env: HashMap::new(),
                },
                Duration::from_secs(1),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post(json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "session/prompt",
                "params": {}
            }))
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["ok"], true);
    }

    #[tokio::test]
    async fn asynchronous_request_timeout_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                LaunchSpec {
                    program: PathBuf::from("sh"),
                    args: vec![
                        "-c".to_string(),
                        concat!(
                            "IFS= read -r line; sleep 0.1; ",
                            "printf '%s\\n' ",
                            "'{\"jsonrpc\":\"2.0\",\"id\":42,\"result\":{\"late\":true}}'"
                        )
                        .to_string(),
                    ],
                    env: HashMap::new(),
                },
                Duration::from_millis(25),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post(json!({
                "jsonrpc": "2.0",
                "id": 42,
                "method": "session/prompt",
                "params": {}
            }))
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
        assert_eq!(response["id"], 42);
        assert_eq!(response["error"]["code"], -32603);
        assert_eq!(
            response["error"]["message"],
            "timed out waiting for agent response"
        );

        let mut saw_late_response = false;
        for _ in 0..2 {
            let Ok(Some(event)) =
                tokio::time::timeout(Duration::from_millis(250), stream.next()).await
            else {
                break;
            };
            if event["id"] == 42 && event.get("result").is_some() {
                saw_late_response = true;
            }
        }
        assert!(!saw_late_response);
    }

    #[tokio::test]
    async fn asynchronous_request_process_exit_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                LaunchSpec {
                    program: PathBuf::from("sh"),
                    args: vec!["-c".to_string(), "IFS= read -r line; exit 1".to_string()],
                    env: HashMap::new(),
                },
                Duration::from_secs(1),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post(json!({
                "jsonrpc": "2.0",
                "id": 99,
                "method": "session/prompt",
                "params": {}
            }))
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
        assert_eq!(response["id"], 99);
        assert_eq!(response["error"]["code"], -32603);
        assert_eq!(
            response["error"]["message"],
            "agent process stopped before responding"
        );
    }

    #[tokio::test]
    async fn asynchronous_request_shutdown_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                LaunchSpec {
                    program: PathBuf::from("sh"),
                    args: vec!["-c".to_string(), "IFS= read -r line; sleep 10".to_string()],
                    env: HashMap::new(),
                },
                Duration::from_secs(30),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post(json!({
                "jsonrpc": "2.0",
                "id": 100,
                "method": "session/prompt",
                "params": {}
            }))
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        tokio::time::timeout(Duration::from_secs(1), runtime.shutdown())
            .await
            .expect("shutdown completes");
        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
        assert_eq!(response["id"], 100);
        assert_eq!(
            response["error"]["message"],
            "agent process stopped before responding"
        );
    }
}
