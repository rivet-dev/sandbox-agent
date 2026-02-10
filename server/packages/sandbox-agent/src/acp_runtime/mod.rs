use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::pin::Pin;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::response::sse::Event;
use futures::{stream, Stream, StreamExt};
use sandbox_agent_agent_management::agents::{
    AgentId, AgentManager, AgentProcessLaunchSpec, InstallOptions,
};
use sandbox_agent_error::SandboxError;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex, RwLock};
use tokio_stream::wrappers::BroadcastStream;

mod backend;
mod ext_meta;
mod ext_methods;
mod helpers;
mod mock;
use self::ext_meta::*;
use self::ext_methods::*;
use self::helpers::*;
use self::mock::{handle_mock_payload, new_mock_backend, MockBackend};

pub const ACP_CLIENT_HEADER: &str = "x-acp-connection-id";

const RING_BUFFER_SIZE: usize = 2048;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_CLOSE_GRACE_MS: u64 = 2_000;
const SESSION_LIST_PAGE_SIZE: usize = 200;
const STDERR_HEAD_LINES: usize = 20;
const STDERR_TAIL_LINES: usize = 50;

#[derive(Debug, Clone)]
pub struct SessionRuntimeInfo {
    pub session_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub ended: bool,
    pub event_count: u64,
    pub model_hint: Option<String>,
    pub mode_hint: Option<String>,
    pub title: Option<String>,
    pub cwd: String,
    pub sandbox_meta: Map<String, Value>,
    pub agent: AgentId,
    pub ended_data: Option<SessionEndedData>,
}

#[derive(Debug, Clone)]
pub struct RuntimeModelInfo {
    pub model_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeModelSnapshot {
    pub available_models: Vec<RuntimeModelInfo>,
    pub current_model_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimeModeInfo {
    pub mode_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeModeSnapshot {
    pub available_modes: Vec<RuntimeModeInfo>,
    pub current_mode_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimeServerStatus {
    pub agent: AgentId,
    pub running: bool,
    pub restart_count: u64,
    pub uptime_ms: Option<i64>,
    pub last_error: Option<String>,
    pub base_url: Option<String>,
    pub current_model_id: Option<String>,
    pub current_mode_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionEndedData {
    pub reason: SessionEndReason,
    pub terminated_by: TerminatedBy,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
    pub stderr: Option<StderrOutput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEndReason {
    Completed,
    Error,
    Terminated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminatedBy {
    Agent,
    Daemon,
}

#[derive(Debug, Clone)]
pub struct StderrOutput {
    pub head: Option<String>,
    pub tail: Option<String>,
    pub truncated: bool,
    pub total_lines: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostKind {
    Response,
    Notification,
}

#[derive(Debug)]
pub struct PostOutcome {
    pub client_id: String,
    pub kind: PostKind,
    pub response: Option<Value>,
}

#[derive(Debug)]
pub struct AcpRuntime {
    inner: Arc<AcpRuntimeInner>,
}

#[derive(Debug)]
struct AcpRuntimeInner {
    agent_manager: Arc<AgentManager>,
    require_preinstall: bool,
    request_timeout: Duration,
    close_grace: Duration,
    next_client_id: AtomicU64,
    next_backend_request_id: AtomicU64,
    next_agent_request_id: AtomicU64,
    clients: RwLock<HashMap<String, Arc<AcpClient>>>,
    backends: Mutex<HashMap<AgentId, Arc<SharedAgentBackend>>>,
    install_locks: Mutex<HashMap<AgentId, Arc<Mutex<()>>>>,
    session_registry: RwLock<HashMap<String, MetaSession>>,
    model_registry: RwLock<HashMap<AgentId, AgentModelSnapshot>>,
    mode_registry: RwLock<HashMap<AgentId, AgentModeSnapshot>>,
    server_registry: RwLock<HashMap<AgentId, AgentServerState>>,
    session_subscribers: Mutex<HashMap<String, HashSet<String>>>,
    session_prompt_owner: Mutex<HashMap<String, String>>,
    agent_request_routes: Mutex<HashMap<String, AgentRequestRoute>>,
    pending_runtime_responses: Mutex<HashMap<String, PendingRuntimeResponse>>,
}

#[derive(Debug)]
struct AcpClient {
    id: String,
    default_agent: AgentId,
    seq: AtomicU64,
    closed: AtomicBool,
    sse_stream_active: Arc<AtomicBool>,
    sender: broadcast::Sender<StreamMessage>,
    ring: Mutex<VecDeque<StreamMessage>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

#[derive(Debug, Clone)]
struct StreamMessage {
    sequence: u64,
    payload: Value,
}

#[derive(Debug)]
struct SharedAgentBackend {
    agent: AgentId,
    sender: BackendSender,
    pending_client_responses: Mutex<HashMap<String, PendingClientResponse>>,
}

#[derive(Debug)]
enum BackendSender {
    Process(ProcessBackend),
    Mock(MockBackend),
}

#[derive(Debug, Clone)]
struct ProcessBackend {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    stderr_capture: Arc<Mutex<StderrCapture>>,
    terminate_requested: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
struct PendingClientResponse {
    client_id: String,
    original_id: Value,
    original_key: String,
    method: String,
    session_id: Option<String>,
    cwd: Option<String>,
    sandbox_meta: Option<Map<String, Value>>,
    is_prompt: bool,
}

#[derive(Debug, Clone)]
struct AgentRequestRoute {
    agent: AgentId,
    target_client_id: String,
    agent_request_id: Value,
}

#[derive(Debug, Clone)]
struct MetaSession {
    session_id: String,
    agent: AgentId,
    cwd: String,
    created_at: i64,
    updated_at_ms: i64,
    title: Option<String>,
    updated_at_hint: Option<String>,
    ended: bool,
    event_count: u64,
    model_hint: Option<String>,
    mode_hint: Option<String>,
    sandbox_meta: Map<String, Value>,
    ended_data: Option<SessionEndedData>,
}

#[derive(Debug, Clone)]
struct AgentModelInfo {
    model_id: String,
    name: Option<String>,
    description: Option<String>,
    default_variant: Option<String>,
    variants: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct AgentModelSnapshot {
    available_models: Vec<AgentModelInfo>,
    current_model_id: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentModeInfo {
    mode_id: String,
    name: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct AgentModeSnapshot {
    available_modes: Vec<AgentModeInfo>,
    current_mode_id: Option<String>,
}

#[derive(Debug)]
struct PendingRuntimeResponse {
    agent: AgentId,
    sender: oneshot::Sender<Value>,
}

struct ActiveSseStream {
    inner: Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>,
    active_flag: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Default)]
struct AgentServerState {
    running: bool,
    restart_count: u64,
    started_at: Option<i64>,
    last_error: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Default)]
struct StderrCapture {
    total_lines: usize,
    full_if_small: Vec<String>,
    head: Vec<String>,
    tail: VecDeque<String>,
}

impl AcpRuntime {
    pub fn new(agent_manager: Arc<AgentManager>) -> Self {
        let require_preinstall = std::env::var("SANDBOX_AGENT_REQUIRE_PREINSTALL")
            .ok()
            .is_some_and(|value| {
                let trimmed = value.trim();
                trimmed == "1"
                    || trimmed.eq_ignore_ascii_case("true")
                    || trimmed.eq_ignore_ascii_case("yes")
            });

        let request_timeout = duration_from_env_ms(
            "SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS",
            Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS),
        );
        let close_grace = duration_from_env_ms(
            "SANDBOX_AGENT_ACP_CLOSE_GRACE_MS",
            Duration::from_millis(DEFAULT_CLOSE_GRACE_MS),
        );

        Self {
            inner: Arc::new(AcpRuntimeInner {
                agent_manager,
                require_preinstall,
                request_timeout,
                close_grace,
                next_client_id: AtomicU64::new(1),
                next_backend_request_id: AtomicU64::new(1),
                next_agent_request_id: AtomicU64::new(1),
                clients: RwLock::new(HashMap::new()),
                backends: Mutex::new(HashMap::new()),
                install_locks: Mutex::new(HashMap::new()),
                session_registry: RwLock::new(HashMap::new()),
                model_registry: RwLock::new(HashMap::new()),
                mode_registry: RwLock::new(HashMap::new()),
                server_registry: RwLock::new(HashMap::new()),
                session_subscribers: Mutex::new(HashMap::new()),
                session_prompt_owner: Mutex::new(HashMap::new()),
                agent_request_routes: Mutex::new(HashMap::new()),
                pending_runtime_responses: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn agent_manager(&self) -> Arc<AgentManager> {
        self.inner.agent_manager.clone()
    }

    pub async fn list_sessions(&self) -> Vec<SessionRuntimeInfo> {
        let mut sessions = self
            .inner
            .session_registry
            .read()
            .await
            .values()
            .cloned()
            .map(SessionRuntimeInfo::from)
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        sessions
    }

    pub async fn get_session(&self, session_id: &str) -> Option<SessionRuntimeInfo> {
        self.inner
            .session_registry
            .read()
            .await
            .get(session_id)
            .cloned()
            .map(SessionRuntimeInfo::from)
    }

    pub async fn get_models(&self, agent: AgentId) -> Option<RuntimeModelSnapshot> {
        self.inner
            .get_models_for_agent(agent)
            .await
            .map(RuntimeModelSnapshot::from)
    }

    pub async fn get_modes(&self, agent: AgentId) -> Option<RuntimeModeSnapshot> {
        self.inner
            .get_modes_for_agent(agent)
            .await
            .map(RuntimeModeSnapshot::from)
    }

    pub async fn list_server_statuses(&self) -> Vec<RuntimeServerStatus> {
        self.inner.list_server_statuses().await
    }

    pub async fn get_server_status(&self, agent: AgentId) -> Option<RuntimeServerStatus> {
        self.inner.get_server_status(agent).await
    }

    pub async fn post(
        &self,
        _principal: &str,
        client_id: Option<&str>,
        payload: Value,
    ) -> Result<PostOutcome, SandboxError> {
        validate_jsonrpc_envelope(&payload)?;

        let connection = match client_id {
            Some(client_id) => self.get_client(client_id).await?,
            None => {
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .ok_or_else(|| SandboxError::InvalidRequest {
                        message: "first ACP request must include method".to_string(),
                    })?;
                if method != "initialize" {
                    return Err(SandboxError::InvalidRequest {
                        message: "first ACP request without client id must be initialize"
                            .to_string(),
                    });
                }
                let agent = required_sandbox_agent_meta(&payload, "initialize")?;
                self.create_client(agent).await?
            }
        };

        if connection.closed.load(Ordering::SeqCst) {
            return Err(SandboxError::StreamError {
                message: "ACP client is closed".to_string(),
            });
        }

        let method = payload
            .get("method")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let has_id = payload.get("id").is_some();

        if let Some(method) = method {
            if has_id {
                let response = self
                    .handle_request(connection.clone(), method, payload)
                    .await?;
                return Ok(PostOutcome {
                    client_id: connection.id.clone(),
                    kind: PostKind::Response,
                    response: Some(response),
                });
            }

            self.handle_notification(connection.clone(), method, payload)
                .await?;
            return Ok(PostOutcome {
                client_id: connection.id.clone(),
                kind: PostKind::Notification,
                response: None,
            });
        }

        self.handle_client_response(connection.clone(), payload)
            .await?;
        Ok(PostOutcome {
            client_id: connection.id.clone(),
            kind: PostKind::Notification,
            response: None,
        })
    }

    pub async fn sse(
        &self,
        _principal: &str,
        client_id: &str,
        last_event_id: Option<u64>,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>, SandboxError> {
        let connection = self.get_client(client_id).await?;
        if !connection.try_claim_sse_stream() {
            return Err(SandboxError::Conflict {
                message: "ACP client already has an active SSE stream".to_string(),
            });
        }

        let (replay, receiver) = connection.subscribe(last_event_id).await;

        let replay_stream = stream::iter(
            replay
                .into_iter()
                .map(|message| Ok::<Event, Infallible>(to_sse_event(message))),
        );

        let live_stream = BroadcastStream::new(receiver).filter_map(|result| async move {
            match result {
                Ok(message) => Some(Ok::<Event, Infallible>(to_sse_event(message))),
                Err(_) => None,
            }
        });

        let inner = Box::pin(replay_stream.chain(live_stream));
        Ok(Box::pin(ActiveSseStream {
            inner,
            active_flag: connection.sse_active_flag(),
        }))
    }

    pub async fn close(&self, _principal: &str, client_id: &str) -> Result<(), SandboxError> {
        let maybe_connection = {
            let mut clients = self.inner.clients.write().await;
            clients.remove(client_id)
        };

        let Some(connection) = maybe_connection else {
            return Ok(());
        };

        connection.close().await;
        self.inner.remove_client_references(&connection.id).await;
        Ok(())
    }

    pub async fn close_all(&self) {
        let clients = {
            let mut map = self.inner.clients.write().await;
            map.drain()
                .map(|(_, connection)| connection)
                .collect::<Vec<_>>()
        };

        for connection in clients {
            connection.close().await;
        }

        self.inner.remove_all_client_references().await;

        let backends = {
            let mut map = self.inner.backends.lock().await;
            map.drain().map(|(_, backend)| backend).collect::<Vec<_>>()
        };

        for backend in backends {
            backend.shutdown(self.inner.close_grace).await;
        }
    }

    async fn handle_request(
        &self,
        connection: Arc<AcpClient>,
        method: String,
        payload: Value,
    ) -> Result<Value, SandboxError> {
        if method == "session/list" {
            return self.session_list_response(&payload).await;
        }

        if let Some(extension_result) = self
            .handle_extension_request(&connection, &method, &payload)
            .await
        {
            return extension_result;
        }

        self.forward_client_request(connection, method, payload)
            .await
    }

    async fn handle_notification(
        &self,
        connection: Arc<AcpClient>,
        method: String,
        payload: Value,
    ) -> Result<(), SandboxError> {
        if let Some(extension_result) = self
            .handle_extension_notification(&connection, &method, &payload)
            .await
        {
            extension_result?;
            return Ok(());
        }

        self.forward_client_notification(connection, method, payload)
            .await
    }

    async fn handle_client_response(
        &self,
        connection: Arc<AcpClient>,
        payload: Value,
    ) -> Result<(), SandboxError> {
        let Some(id_value) = payload.get("id") else {
            return Err(SandboxError::InvalidRequest {
                message: "JSON-RPC response must include id".to_string(),
            });
        };

        let key = message_id_key(id_value);
        let route = self.inner.agent_request_routes.lock().await.remove(&key);

        if let Some(route) = route {
            if route.target_client_id != connection.id {
                return Err(SandboxError::PermissionDenied {
                    message: Some(
                        "ACP agent request response posted by non-target client".to_string(),
                    ),
                });
            }

            let mut rewritten = payload;
            set_payload_id(&mut rewritten, route.agent_request_id);
            let backend = self.get_or_create_backend(route.agent).await?;
            backend.send(self.inner.clone(), rewritten).await?;
            return Ok(());
        }

        Err(SandboxError::InvalidRequest {
            message: "JSON-RPC response id does not match any pending ACP agent request"
                .to_string(),
        })
    }

    async fn forward_client_request(
        &self,
        connection: Arc<AcpClient>,
        method: String,
        payload: Value,
    ) -> Result<Value, SandboxError> {
        let id_value = payload
            .get("id")
            .cloned()
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: "request is missing id".to_string(),
            })?;
        let id_key = message_id_key(&id_value);

        let session_id = extract_session_id_from_payload(&payload);
        let cwd = extract_cwd_from_payload(&payload);
        let sandbox_meta = if method == "session/new" {
            extract_sandbox_session_meta(&payload)
        } else {
            None
        };
        let agent = self
            .resolve_agent_for_method(&method, &payload, session_id.as_deref())
            .await?;

        if let Some(session_id) = &session_id {
            self.inner
                .attach_client_to_session(&connection.id, session_id)
                .await;
            if method == "session/set_model" {
                if let Some(model_id) = extract_model_id_from_payload(&payload) {
                    self.inner
                        .set_session_model_hint(session_id, model_id)
                        .await;
                }
            }
            if method == "session/set_mode" {
                if let Some(mode_id) = extract_mode_id_from_payload(&payload) {
                    self.inner.set_session_mode_hint(session_id, mode_id).await;
                }
            }
            if method == "session/prompt" {
                self.inner
                    .session_prompt_owner
                    .lock()
                    .await
                    .insert(session_id.clone(), connection.id.clone());
            }
        }

        let backend = self.get_or_create_backend(agent).await?;
        let rewritten_id = format!(
            "srv_req_{}",
            self.inner
                .next_backend_request_id
                .fetch_add(1, Ordering::SeqCst)
        );

        let pending = PendingClientResponse {
            client_id: connection.id.clone(),
            original_id: id_value.clone(),
            original_key: id_key.clone(),
            method: method.clone(),
            session_id: session_id.clone(),
            cwd,
            sandbox_meta,
            is_prompt: method == "session/prompt",
        };

        backend
            .pending_client_responses
            .lock()
            .await
            .insert(rewritten_id.clone(), pending);

        let (tx, rx) = oneshot::channel();
        connection.pending.lock().await.insert(id_key.clone(), tx);

        let mut rewritten = payload;
        set_payload_id(&mut rewritten, Value::String(rewritten_id.clone()));

        if let Err(err) = backend.send(self.inner.clone(), rewritten).await {
            connection.pending.lock().await.remove(&id_key);
            backend
                .pending_client_responses
                .lock()
                .await
                .remove(&rewritten_id);
            return Err(err);
        }

        tokio::time::timeout(self.inner.request_timeout, rx)
            .await
            .map_err(|_| SandboxError::Timeout {
                message: Some("timed out waiting for ACP agent process response".to_string()),
            })
            .and_then(|result| {
                result.map_err(|_| SandboxError::StreamError {
                    message: "ACP agent process response channel closed".to_string(),
                })
            })
    }

    async fn forward_client_notification(
        &self,
        connection: Arc<AcpClient>,
        method: String,
        payload: Value,
    ) -> Result<(), SandboxError> {
        let session_id = extract_session_id_from_payload(&payload);
        if method == "session/set_model" {
            if let Some(session_id) = session_id.as_deref() {
                if let Some(model_id) = extract_model_id_from_payload(&payload) {
                    self.inner
                        .set_session_model_hint(session_id, model_id)
                        .await;
                }
            }
        }
        if method == "session/set_mode" {
            if let Some(session_id) = session_id.as_deref() {
                if let Some(mode_id) = extract_mode_id_from_payload(&payload) {
                    self.inner.set_session_mode_hint(session_id, mode_id).await;
                }
            }
        }
        let agent = self
            .resolve_agent_for_method(&method, &payload, session_id.as_deref())
            .await?;

        if let Some(session_id) = &session_id {
            self.inner
                .attach_client_to_session(&connection.id, session_id)
                .await;
            if method == "session/cancel" {
                self.inner
                    .session_prompt_owner
                    .lock()
                    .await
                    .remove(session_id);
            }
        }

        let backend = self.get_or_create_backend(agent).await?;
        backend.send(self.inner.clone(), payload).await
    }

    async fn resolve_agent_for_method(
        &self,
        method: &str,
        payload: &Value,
        session_id: Option<&str>,
    ) -> Result<AgentId, SandboxError> {
        if method == "initialize" || method == "session/new" {
            return required_sandbox_agent_meta(payload, method);
        }

        if let Some(session_id) = session_id {
            if let Some(agent) = self.inner.session_agent(session_id).await {
                return Ok(agent);
            }
        }

        if let Some(agent) = explicit_agent_param(payload)? {
            return Ok(agent);
        }

        if let Some(session_id) = session_id {
            return Err(SandboxError::InvalidRequest {
                message: format!(
                    "{method} requires params.agent when sessionId '{session_id}' is unknown"
                ),
            });
        }

        Err(SandboxError::InvalidRequest {
            message: format!("{method} requires params.agent when params.sessionId is absent"),
        })
    }

    async fn session_list_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = payload
            .get("id")
            .cloned()
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: "session/list request is missing id".to_string(),
            })?;

        let params = payload
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let cwd_filter = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let cursor = params
            .get("cursor")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);

        let mut sessions = self
            .inner
            .session_registry
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();

        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));

        if let Some(cwd_filter) = cwd_filter {
            sessions.retain(|session| session.cwd == cwd_filter);
        }

        let start = cursor.min(sessions.len());
        let end = (start + SESSION_LIST_PAGE_SIZE).min(sessions.len());
        let page = &sessions[start..end];

        let list = page
            .iter()
            .map(|session| {
                let mut obj = Map::new();
                obj.insert(
                    "sessionId".to_string(),
                    Value::String(session.session_id.clone()),
                );
                obj.insert("cwd".to_string(), Value::String(session.cwd.clone()));
                if let Some(title) = &session.title {
                    obj.insert("title".to_string(), Value::String(title.clone()));
                }
                if let Some(updated_at) = &session.updated_at_hint {
                    obj.insert("updatedAt".to_string(), Value::String(updated_at.clone()));
                }
                let mut sandbox_meta = session.sandbox_meta.clone();
                sandbox_meta.insert(
                    "agent".to_string(),
                    Value::String(session.agent.as_str().to_string()),
                );
                sandbox_meta.insert("createdAt".to_string(), Value::from(session.created_at));
                sandbox_meta.insert("updatedAt".to_string(), Value::from(session.updated_at_ms));
                sandbox_meta.insert("ended".to_string(), Value::Bool(session.ended));
                sandbox_meta.insert("eventCount".to_string(), Value::from(session.event_count));
                if let Some(model_hint) = &session.model_hint {
                    sandbox_meta.insert("model".to_string(), Value::String(model_hint.clone()));
                }
                obj.insert(
                    "_meta".to_string(),
                    Value::Object(Map::from_iter([(
                        SANDBOX_META_KEY.to_string(),
                        Value::Object(sandbox_meta),
                    )])),
                );
                Value::Object(obj)
            })
            .collect::<Vec<_>>();

        let next_cursor = if end < sessions.len() {
            Some(end.to_string())
        } else {
            None
        };

        Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "sessions": list,
                "nextCursor": next_cursor,
            }
        }))
    }

    async fn get_client(&self, client_id: &str) -> Result<Arc<AcpClient>, SandboxError> {
        self.inner
            .clients
            .read()
            .await
            .get(client_id)
            .cloned()
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: client_id.to_string(),
            })
    }

    async fn create_client(&self, agent: AgentId) -> Result<Arc<AcpClient>, SandboxError> {
        // Ensure bootstrap agent backend exists so initialize has a process to talk to.
        self.get_or_create_backend(agent).await?;

        let id = format!(
            "acp_conn_{}",
            self.inner.next_client_id.fetch_add(1, Ordering::SeqCst)
        );

        let connection = AcpClient::new(id.clone(), agent);
        self.inner
            .clients
            .write()
            .await
            .insert(id, connection.clone());
        Ok(connection)
    }

    async fn get_or_create_backend(
        &self,
        agent: AgentId,
    ) -> Result<Arc<SharedAgentBackend>, SandboxError> {
        if let Some(existing) = self.inner.backends.lock().await.get(&agent).cloned() {
            if existing.is_alive().await {
                return Ok(existing);
            }
            self.inner.remove_backend_if_same(agent, &existing).await;
        }

        self.ensure_installed(agent).await?;

        let (created, base_url) = if agent == AgentId::Mock {
            (SharedAgentBackend::new_mock(agent), None::<String>)
        } else {
            let manager = self.inner.agent_manager.clone();
            let launch = tokio::task::spawn_blocking(move || manager.resolve_agent_process(agent))
                .await
                .map_err(|err| SandboxError::StreamError {
                    message: format!("failed to resolve ACP agent process launch spec: {err}"),
                })?
                .map_err(to_stream_error)?;

            let base_url = infer_base_url_from_launch(&launch);
            (
                SharedAgentBackend::new_process(agent, launch, self.inner.clone()).await?,
                base_url,
            )
        };

        let mut backends = self.inner.backends.lock().await;
        if let Some(existing) = backends.get(&agent).cloned() {
            return Ok(existing);
        }

        backends.insert(agent, created.clone());
        drop(backends);
        self.inner.mark_backend_started(agent, base_url).await;
        Ok(created)
    }

    async fn ensure_installed(&self, agent: AgentId) -> Result<(), SandboxError> {
        if self.inner.require_preinstall {
            if !self.inner.agent_manager.is_installed(agent) {
                return Err(SandboxError::AgentNotInstalled {
                    agent: agent.as_str().to_string(),
                });
            }
            return Ok(());
        }

        if self.inner.agent_manager.is_installed(agent) {
            return Ok(());
        }

        let lock = {
            let mut locks = self.inner.install_locks.lock().await;
            locks
                .entry(agent)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let _guard = lock.lock().await;

        if self.inner.agent_manager.is_installed(agent) {
            return Ok(());
        }

        let manager = self.inner.agent_manager.clone();
        tokio::task::spawn_blocking(move || manager.install(agent, InstallOptions::default()))
            .await
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent.as_str().to_string(),
                stderr: Some(format!("installer task failed: {err}")),
            })?
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent.as_str().to_string(),
                stderr: Some(err.to_string()),
            })?;

        Ok(())
    }
}

impl AcpRuntimeInner {
    async fn handle_backend_message(self: &Arc<Self>, agent: AgentId, message: Value) {
        let is_response = message.get("id").is_some()
            && message.get("method").is_none()
            && (message.get("result").is_some() || message.get("error").is_some());

        if is_response {
            self.handle_backend_response(agent, message).await;
            return;
        }

        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);

        if message.get("id").is_some() && method.is_some() {
            self.handle_backend_request(agent, message).await;
            return;
        }

        self.handle_backend_notification(agent, message).await;
    }

    async fn handle_backend_response(self: &Arc<Self>, agent: AgentId, mut message: Value) {
        let Some(id_value) = message.get("id").cloned() else {
            return;
        };

        let key = match id_value.as_str() {
            Some(value) => value.to_string(),
            None => return,
        };

        if let Some(pending) = self.pending_runtime_responses.lock().await.remove(&key) {
            let _ = pending.sender.send(message);
            return;
        }

        let backend = {
            let backends = self.backends.lock().await;
            backends.get(&agent).cloned()
        };

        let Some(backend) = backend else {
            return;
        };

        let pending = backend.pending_client_responses.lock().await.remove(&key);
        let Some(pending) = pending else {
            return;
        };

        if pending.method == "initialize" {
            inject_extension_capabilities(&mut message);
        }

        set_payload_id(&mut message, pending.original_id.clone());

        if pending.is_prompt {
            if let Some(session_id) = &pending.session_id {
                let mut owners = self.session_prompt_owner.lock().await;
                if owners.get(session_id) == Some(&pending.client_id) {
                    owners.remove(session_id);
                }
            }
        }

        self.record_session_from_response(agent, &pending, &message)
            .await;

        let connection = self.clients.read().await.get(&pending.client_id).cloned();
        let Some(connection) = connection else {
            return;
        };

        let sender = connection
            .pending
            .lock()
            .await
            .remove(&pending.original_key);
        if let Some(sender) = sender {
            let _ = sender.send(message);
        } else {
            connection.push_stream(message).await;
        }
    }

    async fn handle_backend_request(self: &Arc<Self>, agent: AgentId, mut message: Value) {
        let original_id = match message.get("id") {
            Some(id) => id.clone(),
            None => return,
        };

        let session_id = extract_session_id_from_payload(&message);
        let target_client_id = self
            .pick_target_client_for_session(agent, session_id.as_deref())
            .await;

        let Some(target_client_id) = target_client_id else {
            if let Some(backend) = self.backends.lock().await.get(&agent).cloned() {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": original_id,
                    "error": {
                        "code": -32001,
                        "message": "no attached ACP client for session request"
                    }
                });
                let _ = backend.send(self.clone(), response).await;
            }
            return;
        };

        if let Some(session_id) = &session_id {
            self.attach_client_to_session(&target_client_id, session_id)
                .await;
        }

        let rewritten_id = format!(
            "agent_req_{}",
            self.next_agent_request_id.fetch_add(1, Ordering::SeqCst)
        );
        let rewritten_key = message_id_key(&Value::String(rewritten_id.clone()));

        self.agent_request_routes.lock().await.insert(
            rewritten_key,
            AgentRequestRoute {
                agent,
                target_client_id: target_client_id.clone(),
                agent_request_id: original_id,
            },
        );

        set_payload_id(&mut message, Value::String(rewritten_id));

        if let Some(connection) = self.clients.read().await.get(&target_client_id).cloned() {
            connection.push_stream(message).await;
        }
    }

    async fn handle_backend_notification(self: &Arc<Self>, agent: AgentId, message: Value) {
        let session_id = extract_session_id_from_payload(&message);

        if let Some(session_id) = &session_id {
            self.record_session_from_notification(agent, session_id, &message)
                .await;
        }

        let targets = if let Some(session_id) = session_id {
            self.session_subscribers
                .lock()
                .await
                .get(&session_id)
                .cloned()
                .unwrap_or_default()
        } else {
            self.clients
                .read()
                .await
                .values()
                .filter(|client| client.default_agent == agent)
                .map(|client| client.id.clone())
                .collect::<HashSet<_>>()
        };

        if targets.is_empty() {
            return;
        }

        for client_id in targets {
            if let Some(connection) = self.clients.read().await.get(&client_id).cloned() {
                connection.push_stream(message.clone()).await;
            }
        }
    }

    async fn pick_target_client_for_session(
        &self,
        agent: AgentId,
        session_id: Option<&str>,
    ) -> Option<String> {
        if let Some(session_id) = session_id {
            if let Some(owner) = self
                .session_prompt_owner
                .lock()
                .await
                .get(session_id)
                .cloned()
            {
                if self.clients.read().await.contains_key(&owner) {
                    return Some(owner);
                }
            }

            let subscribers = self
                .session_subscribers
                .lock()
                .await
                .get(session_id)
                .cloned()
                .unwrap_or_default();
            let mut sorted = subscribers.into_iter().collect::<Vec<_>>();
            sorted.sort();
            for candidate in sorted {
                if self.clients.read().await.contains_key(&candidate) {
                    return Some(candidate);
                }
            }
        }

        let mut fallbacks = self
            .clients
            .read()
            .await
            .values()
            .filter(|client| client.default_agent == agent)
            .map(|client| client.id.clone())
            .collect::<Vec<_>>();
        fallbacks.sort();
        fallbacks.into_iter().next()
    }

    async fn record_session_from_response(
        &self,
        agent: AgentId,
        pending: &PendingClientResponse,
        response: &Value,
    ) {
        let method = pending.method.as_str();
        let session_id =
            extract_session_id_from_response(response).or_else(|| pending.session_id.clone());
        if let Some(session_id) = session_id {
            if matches!(
                method,
                "session/new" | "session/load" | "session/resume" | "session/fork"
            ) {
                let cwd = pending.cwd.clone().unwrap_or_else(|| "/".to_string());
                self.upsert_session(agent, &session_id, cwd, pending.sandbox_meta.clone())
                    .await;
                self.attach_client_to_session(&pending.client_id, &session_id)
                    .await;
            }
            self.touch_session(&session_id).await;
        }
        if let Some(models) = extract_models_from_response(response) {
            self.set_models_for_agent(agent, models).await;
        }
        if let Some(modes) = extract_modes_from_response(response) {
            self.set_modes_for_agent(agent, modes).await;
        }
    }

    async fn record_session_from_notification(
        &self,
        agent: AgentId,
        session_id: &str,
        message: &Value,
    ) {
        let mut title = None;
        let mut updated_at = None;
        let mut mode_hint = None;
        if message.get("method").and_then(Value::as_str) == Some("session/update") {
            if let Some(update) = message.get("params").and_then(|p| p.get("update")) {
                match update.get("sessionUpdate").and_then(Value::as_str) {
                    Some("session_info_update") => {
                        title = update
                            .get("title")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned);
                        updated_at = update
                            .get("updatedAt")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned);
                    }
                    Some("current_mode_update") => {
                        mode_hint = update
                            .get("currentModeId")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned);
                    }
                    _ => {}
                }
            }
        }

        let now = now_ms();
        let mut registry = self.session_registry.write().await;
        let entry = registry
            .entry(session_id.to_string())
            .or_insert_with(|| MetaSession {
                session_id: session_id.to_string(),
                agent,
                cwd: "/".to_string(),
                created_at: now,
                updated_at_ms: now,
                title: None,
                updated_at_hint: None,
                ended: false,
                event_count: 0,
                model_hint: None,
                mode_hint: None,
                sandbox_meta: Map::new(),
                ended_data: None,
            });
        entry.agent = agent;
        entry.updated_at_ms = now;
        entry.event_count = entry.event_count.saturating_add(1);
        if let Some(title) = title {
            entry.title = Some(title.clone());
            entry
                .sandbox_meta
                .insert("title".to_string(), Value::String(title));
        }
        if let Some(updated_at) = updated_at {
            entry.updated_at_hint = Some(updated_at);
        }
        if let Some(mode_hint) = mode_hint {
            entry.mode_hint = Some(mode_hint.clone());
            entry
                .sandbox_meta
                .insert("mode".to_string(), Value::String(mode_hint));
        }
        let current_mode = entry.mode_hint.clone();
        drop(registry);
        if current_mode.is_some() {
            let mut mode_registry = self.mode_registry.write().await;
            mode_registry.entry(agent).or_default().current_mode_id = current_mode;
        }
    }

    async fn upsert_session(
        &self,
        agent: AgentId,
        session_id: &str,
        cwd: String,
        sandbox_meta: Option<Map<String, Value>>,
    ) {
        let now = now_ms();
        let mut registry = self.session_registry.write().await;
        let entry = registry
            .entry(session_id.to_string())
            .or_insert_with(|| MetaSession {
                session_id: session_id.to_string(),
                agent,
                cwd: cwd.clone(),
                created_at: now,
                updated_at_ms: now,
                title: None,
                updated_at_hint: None,
                ended: false,
                event_count: 0,
                model_hint: None,
                mode_hint: None,
                sandbox_meta: Map::new(),
                ended_data: None,
            });
        entry.agent = agent;
        entry.updated_at_ms = now;
        entry.ended = false;
        entry.ended_data = None;
        if !cwd.is_empty() {
            entry.cwd = cwd;
        }
        if let Some(mut sandbox_meta) = sandbox_meta {
            if let Some(Value::String(title)) = sandbox_meta.get("title") {
                entry.title = Some(title.clone());
            }
            entry.sandbox_meta.append(&mut sandbox_meta);
        }
    }

    async fn session_agent(&self, session_id: &str) -> Option<AgentId> {
        self.session_registry
            .read()
            .await
            .get(session_id)
            .map(|entry| entry.agent)
    }

    async fn session_snapshot(&self, session_id: &str) -> Option<MetaSession> {
        self.session_registry.read().await.get(session_id).cloned()
    }

    async fn merge_session_metadata(
        &self,
        session_id: &str,
        metadata: Map<String, Value>,
    ) -> Result<(), SandboxError> {
        let mut registry = self.session_registry.write().await;
        let entry = registry
            .get_mut(session_id)
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            })?;
        entry.updated_at_ms = now_ms();

        for (key, value) in metadata {
            if key == "title" {
                if let Some(title) = value.as_str() {
                    entry.title = Some(title.to_string());
                }
            }
            if key == "model" {
                entry.model_hint = value.as_str().map(ToOwned::to_owned);
            }
            if key == "mode" {
                entry.mode_hint = value.as_str().map(ToOwned::to_owned);
            }
            entry.sandbox_meta.insert(key, value);
        }
        Ok(())
    }

    async fn set_session_model_hint(&self, session_id: &str, model_id: String) {
        let mut agent = None;
        let mut registry = self.session_registry.write().await;
        if let Some(entry) = registry.get_mut(session_id) {
            entry.model_hint = Some(model_id.clone());
            entry.updated_at_ms = now_ms();
            agent = Some(entry.agent);
            entry
                .sandbox_meta
                .insert("model".to_string(), Value::String(model_id));
        }
        drop(registry);
        if let Some(agent) = agent {
            let current_model_id = self
                .session_registry
                .read()
                .await
                .get(session_id)
                .and_then(|session| session.model_hint.clone());
            let mut model_registry = self.model_registry.write().await;
            let entry = model_registry.entry(agent).or_default();
            entry.current_model_id = current_model_id;
        }
    }

    async fn session_model_hint(&self, session_id: &str) -> Option<String> {
        self.session_registry
            .read()
            .await
            .get(session_id)
            .and_then(|entry| entry.model_hint.clone())
    }

    async fn set_session_mode_hint(&self, session_id: &str, mode_id: String) {
        let mut agent = None;
        let mut registry = self.session_registry.write().await;
        if let Some(entry) = registry.get_mut(session_id) {
            entry.mode_hint = Some(mode_id.clone());
            entry.updated_at_ms = now_ms();
            agent = Some(entry.agent);
            entry
                .sandbox_meta
                .insert("mode".to_string(), Value::String(mode_id));
        }
        drop(registry);
        if let Some(agent) = agent {
            let current_mode_id = self
                .session_registry
                .read()
                .await
                .get(session_id)
                .and_then(|session| session.mode_hint.clone());
            let mut mode_registry = self.mode_registry.write().await;
            let entry = mode_registry.entry(agent).or_default();
            entry.current_mode_id = current_mode_id;
        }
    }

    async fn set_models_for_agent(&self, agent: AgentId, snapshot: AgentModelSnapshot) {
        self.model_registry.write().await.insert(agent, snapshot);
    }

    async fn get_models_for_agent(&self, agent: AgentId) -> Option<AgentModelSnapshot> {
        self.model_registry.read().await.get(&agent).cloned()
    }

    async fn set_modes_for_agent(&self, agent: AgentId, snapshot: AgentModeSnapshot) {
        self.mode_registry.write().await.insert(agent, snapshot);
    }

    async fn get_modes_for_agent(&self, agent: AgentId) -> Option<AgentModeSnapshot> {
        self.mode_registry.read().await.get(&agent).cloned()
    }

    async fn touch_session(&self, session_id: &str) {
        if let Some(entry) = self.session_registry.write().await.get_mut(session_id) {
            entry.event_count = entry.event_count.saturating_add(1);
            entry.updated_at_ms = now_ms();
        }
    }

    async fn mark_session_ended(&self, session_id: &str, ended_data: SessionEndedData) -> bool {
        let mut registry = self.session_registry.write().await;
        let Some(entry) = registry.get_mut(session_id) else {
            return false;
        };
        if entry.ended {
            return false;
        }
        entry.ended = true;
        entry.ended_data = Some(ended_data);
        entry.updated_at_ms = now_ms();
        entry.event_count = entry.event_count.saturating_add(1);
        true
    }

    async fn emit_session_ended(&self, session_id: &str, ended_data: SessionEndedData) {
        self.session_prompt_owner.lock().await.remove(session_id);
        let targets = self
            .session_subscribers
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        if targets.is_empty() {
            return;
        }
        let payload = json!({
            "jsonrpc": "2.0",
            "method": SESSION_ENDED_METHOD,
            "params": {
                "session_id": session_id,
                "data": ended_data_to_value(&ended_data),
            }
        });
        for client_id in targets {
            if let Some(connection) = self.clients.read().await.get(&client_id).cloned() {
                connection.push_stream(payload.clone()).await;
            }
        }
    }

    async fn active_session_ids_for_agent(&self, agent: AgentId) -> Vec<String> {
        self.session_registry
            .read()
            .await
            .values()
            .filter(|session| session.agent == agent && !session.ended)
            .map(|session| session.session_id.clone())
            .collect()
    }

    async fn remove_backend_if_same(&self, agent: AgentId, backend: &Arc<SharedAgentBackend>) {
        let mut backends = self.backends.lock().await;
        let should_remove = backends
            .get(&agent)
            .map(|current| Arc::ptr_eq(current, backend))
            .unwrap_or(false);
        if should_remove {
            backends.remove(&agent);
        }
    }

    async fn mark_backend_started(&self, agent: AgentId, base_url: Option<String>) {
        let now = now_ms();
        let mut registry = self.server_registry.write().await;
        let entry = registry.entry(agent).or_default();
        if entry.started_at.is_some() {
            entry.restart_count = entry.restart_count.saturating_add(1);
        }
        entry.running = true;
        entry.started_at = Some(now);
        entry.last_error = None;
        if base_url.is_some() {
            entry.base_url = base_url;
        }
    }

    async fn mark_backend_stopped(&self, agent: AgentId, last_error: Option<String>) {
        let mut registry = self.server_registry.write().await;
        let entry = registry.entry(agent).or_default();
        entry.running = false;
        if let Some(error) = last_error {
            entry.last_error = Some(error);
        }
    }

    async fn list_server_statuses(&self) -> Vec<RuntimeServerStatus> {
        let now = now_ms();
        let server_registry = self.server_registry.read().await.clone();
        let model_registry = self.model_registry.read().await.clone();
        let mode_registry = self.mode_registry.read().await.clone();

        let mut statuses = server_registry
            .into_iter()
            .map(|(agent, status)| {
                let current_model_id = model_registry
                    .get(&agent)
                    .and_then(|snapshot| snapshot.current_model_id.clone());
                let current_mode_id = mode_registry
                    .get(&agent)
                    .and_then(|snapshot| snapshot.current_mode_id.clone());
                RuntimeServerStatus {
                    agent,
                    running: status.running,
                    restart_count: status.restart_count,
                    uptime_ms: if status.running {
                        status.started_at.map(|started| now.saturating_sub(started))
                    } else {
                        None
                    },
                    last_error: status.last_error.clone(),
                    base_url: status.base_url.clone(),
                    current_model_id,
                    current_mode_id,
                }
            })
            .collect::<Vec<_>>();
        statuses.sort_by(|left, right| left.agent.as_str().cmp(right.agent.as_str()));
        statuses
    }

    async fn get_server_status(&self, agent: AgentId) -> Option<RuntimeServerStatus> {
        let now = now_ms();
        let status = self.server_registry.read().await.get(&agent).cloned()?;
        let current_model_id = self
            .model_registry
            .read()
            .await
            .get(&agent)
            .and_then(|snapshot| snapshot.current_model_id.clone());
        let current_mode_id = self
            .mode_registry
            .read()
            .await
            .get(&agent)
            .and_then(|snapshot| snapshot.current_mode_id.clone());
        Some(RuntimeServerStatus {
            agent,
            running: status.running,
            restart_count: status.restart_count,
            uptime_ms: if status.running {
                status.started_at.map(|started| now.saturating_sub(started))
            } else {
                None
            },
            last_error: status.last_error,
            base_url: status.base_url,
            current_model_id,
            current_mode_id,
        })
    }

    async fn handle_backend_process_exit(
        self: &Arc<Self>,
        agent: AgentId,
        status: Option<ExitStatus>,
        terminated_by: TerminatedBy,
        stderr: Option<StderrOutput>,
    ) {
        let last_error = if terminated_by == TerminatedBy::Daemon {
            None
        } else {
            status.as_ref().and_then(|value| {
                if value.success() {
                    None
                } else {
                    Some(format!("ACP agent process exited with status {value}"))
                }
            })
        };
        self.mark_backend_stopped(agent, last_error).await;
        let mut pending_runtime = self.pending_runtime_responses.lock().await;
        let pending_keys = pending_runtime
            .iter()
            .filter_map(|(id, pending)| (pending.agent == agent).then_some(id.clone()))
            .collect::<Vec<_>>();
        for pending_id in pending_keys {
            if let Some(pending) = pending_runtime.remove(&pending_id) {
                let _ = pending.sender.send(json!({
                    "jsonrpc": "2.0",
                    "id": pending_id,
                    "error": {
                        "code": -32000,
                        "message": "ACP agent backend exited",
                    }
                }));
            }
        }
        drop(pending_runtime);

        let sessions = self.active_session_ids_for_agent(agent).await;
        for session_id in sessions {
            let ended_data =
                ended_data_from_process_exit(status.clone(), terminated_by, stderr.clone());
            if self
                .mark_session_ended(&session_id, ended_data.clone())
                .await
            {
                self.emit_session_ended(&session_id, ended_data).await;
            }
        }
    }

    async fn attach_client_to_session(&self, client_id: &str, session_id: &str) {
        self.session_subscribers
            .lock()
            .await
            .entry(session_id.to_string())
            .or_default()
            .insert(client_id.to_string());
    }

    async fn detach_client_from_session(&self, client_id: &str, session_id: &str) {
        let mut subs = self.session_subscribers.lock().await;
        if let Some(set) = subs.get_mut(session_id) {
            set.remove(client_id);
            if set.is_empty() {
                subs.remove(session_id);
            }
        }

        let mut owners = self.session_prompt_owner.lock().await;
        if owners.get(session_id) == Some(&client_id.to_string()) {
            owners.remove(session_id);
        }
    }

    async fn remove_client_references(&self, client_id: &str) {
        let mut subs = self.session_subscribers.lock().await;
        let keys = subs.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            if let Some(set) = subs.get_mut(&key) {
                set.remove(client_id);
                if set.is_empty() {
                    subs.remove(&key);
                }
            }
        }

        let mut owners = self.session_prompt_owner.lock().await;
        owners.retain(|_, owner| owner != client_id);

        let mut routes = self.agent_request_routes.lock().await;
        routes.retain(|_, route| route.target_client_id != client_id);
    }

    async fn remove_all_client_references(&self) {
        self.session_subscribers.lock().await.clear();
        self.session_prompt_owner.lock().await.clear();
        self.agent_request_routes.lock().await.clear();
        self.pending_runtime_responses.lock().await.clear();
    }
}

impl Stream for ActiveSseStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

impl Drop for ActiveSseStream {
    fn drop(&mut self) {
        self.active_flag.store(false, Ordering::SeqCst);
    }
}
