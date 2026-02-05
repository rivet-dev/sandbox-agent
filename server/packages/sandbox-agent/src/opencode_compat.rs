//! OpenCode-compatible API handlers mounted under `/opencode`.
//!
//! These endpoints implement the full OpenCode OpenAPI surface. Most routes are
//! stubbed responses with deterministic helpers for snapshot testing. A minimal
//! in-memory state tracks sessions/messages to keep behavior coherent.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::fs;
use std::path::Path as FsPath;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive};
use axum::response::{IntoResponse, Sse};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use futures::{stream, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::{broadcast, Mutex};
use tokio::time::interval;
use tokio_stream::wrappers::ReceiverStream;
use utoipa::{IntoParams, OpenApi, ToSchema};

use crate::pty::{PtyCreateOptions, PtyEvent, PtyIo, PtyRecord, PtySizeSpec, PtyUpdateOptions};
use crate::router::{
    AppState, CreateSessionRequest, FileActionSnapshot, McpRegistryError, McpServerConfig,
    PermissionReply, ToolCallSnapshot, ToolCallStatus,
};
use sandbox_agent_error::SandboxError;
use sandbox_agent_agent_management::agents::AgentId;
use sandbox_agent_universal_agent_schema::{
    ContentPart, ItemDeltaData, ItemEventData, ItemKind, ItemRole, UniversalEvent, UniversalEventData,
    UniversalEventType, UniversalItem, PermissionEventData, PermissionStatus, QuestionEventData,
    QuestionStatus, FileAction, ItemStatus,
};

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);
static MESSAGE_COUNTER: AtomicU64 = AtomicU64::new(1);
static PART_COUNTER: AtomicU64 = AtomicU64::new(1);
static PTY_COUNTER: AtomicU64 = AtomicU64::new(1);
static PROJECT_COUNTER: AtomicU64 = AtomicU64::new(1);
const OPENCODE_PROVIDER_ID: &str = "sandbox-agent";
const OPENCODE_PROVIDER_NAME: &str = "Sandbox Agent";
const OPENCODE_DEFAULT_MODEL_ID: &str = "mock";
const OPENCODE_DEFAULT_AGENT_MODE: &str = "build";
const FIND_MAX_RESULTS: usize = 200;
const FIND_IGNORE_DIRS: &[&str] = &[
    ".git",
    ".idea",
    ".sandbox-agent",
    ".venv",
    ".vscode",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
];

#[derive(Clone, Debug)]
struct OpenCodeCompatConfig {
    fixed_time_ms: Option<i64>,
    fixed_directory: Option<String>,
    fixed_worktree: Option<String>,
    fixed_home: Option<String>,
    fixed_state: Option<String>,
    fixed_config: Option<String>,
    fixed_branch: Option<String>,
}

impl OpenCodeCompatConfig {
    fn from_env() -> Self {
        Self {
            fixed_time_ms: std::env::var("OPENCODE_COMPAT_FIXED_TIME_MS")
                .ok()
                .and_then(|value| value.parse::<i64>().ok()),
            fixed_directory: std::env::var("OPENCODE_COMPAT_DIRECTORY").ok(),
            fixed_worktree: std::env::var("OPENCODE_COMPAT_WORKTREE").ok(),
            fixed_home: std::env::var("OPENCODE_COMPAT_HOME").ok(),
            fixed_state: std::env::var("OPENCODE_COMPAT_STATE").ok(),
            fixed_config: std::env::var("OPENCODE_COMPAT_CONFIG").ok(),
            fixed_branch: std::env::var("OPENCODE_COMPAT_BRANCH").ok(),
        }
    }

    fn now_ms(&self) -> i64 {
        if let Some(value) = self.fixed_time_ms {
            return value;
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn home_dir(&self) -> String {
        self.fixed_home
            .clone()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string())
    }

    fn state_dir(&self) -> String {
        self.fixed_state
            .clone()
            .unwrap_or_else(|| format!("{}/.local/state/opencode", self.home_dir()))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct OpenCodeSessionRecord {
    id: String,
    slug: String,
    project_id: String,
    directory: String,
    parent_id: Option<String>,
    title: String,
    version: String,
    created_at: i64,
    updated_at: i64,
    share_url: Option<String>,
    #[serde(default)]
    status: OpenCodeSessionStatus,
}

impl OpenCodeSessionRecord {
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("id".to_string(), json!(self.id));
        map.insert("slug".to_string(), json!(self.slug));
        map.insert("projectID".to_string(), json!(self.project_id));
        map.insert("directory".to_string(), json!(self.directory));
        map.insert("title".to_string(), json!(self.title));
        map.insert("version".to_string(), json!(self.version));
        map.insert(
            "time".to_string(),
            json!({
                "created": self.created_at,
                "updated": self.updated_at,
            }),
        );
        if let Some(parent_id) = &self.parent_id {
            map.insert("parentID".to_string(), json!(parent_id));
        }
        if let Some(url) = &self.share_url {
            map.insert("share".to_string(), json!({"url": url}));
        }
        map.insert(
            "status".to_string(),
            json!({"type": self.status.status, "updated": self.status.updated_at}),
        );
        Value::Object(map)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct OpenCodeSessionStatus {
    status: String,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct OpenCodePersistedState {
    #[serde(default)]
    default_project_id: String,
    #[serde(default)]
    next_session_id: u64,
    #[serde(default)]
    sessions: HashMap<String, OpenCodeSessionRecord>,
}

impl OpenCodePersistedState {
    fn empty(default_project_id: String) -> Self {
        Self {
            default_project_id,
            next_session_id: 1,
            sessions: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct OpenCodeMessageRecord {
    info: Value,
    parts: Vec<Value>,
}


#[derive(Clone, Debug)]
struct OpenCodePermissionRecord {
    id: String,
    session_id: String,
    permission: String,
    patterns: Vec<String>,
    metadata: Value,
    always: Vec<String>,
    tool: Option<Value>,
}

impl OpenCodePermissionRecord {
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("id".to_string(), json!(self.id));
        map.insert("sessionID".to_string(), json!(self.session_id));
        map.insert("permission".to_string(), json!(self.permission));
        map.insert("patterns".to_string(), json!(self.patterns));
        map.insert("metadata".to_string(), self.metadata.clone());
        map.insert("always".to_string(), json!(self.always));
        if let Some(tool) = &self.tool {
            map.insert("tool".to_string(), tool.clone());
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug)]
struct OpenCodeQuestionRecord {
    id: String,
    session_id: String,
    questions: Vec<Value>,
    tool: Option<Value>,
}

impl OpenCodeQuestionRecord {
    fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("id".to_string(), json!(self.id));
        map.insert("sessionID".to_string(), json!(self.session_id));
        map.insert("questions".to_string(), json!(self.questions));
        if let Some(tool) = &self.tool {
            map.insert("tool".to_string(), tool.clone());
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug)]
struct OpenCodeEventRecord {
    sequence: u64,
    payload: Value,
}

#[derive(Default, Clone)]
struct OpenCodeSessionRuntime {
    last_user_message_id: Option<String>,
    last_agent: Option<String>,
    last_model_provider: Option<String>,
    last_model_id: Option<String>,
    session_agent_id: Option<String>,
    session_provider_id: Option<String>,
    session_model_id: Option<String>,
    message_id_for_item: HashMap<String, String>,
    text_by_message: HashMap<String, String>,
    part_id_by_message: HashMap<String, String>,
    tool_part_by_call: HashMap<String, String>,
    tool_message_by_call: HashMap<String, String>,
}

pub struct OpenCodeState {
    config: OpenCodeCompatConfig,
    default_project_id: String,
    session_store_path: PathBuf,
    sessions: Mutex<HashMap<String, OpenCodeSessionRecord>>,
    messages: Mutex<HashMap<String, Vec<OpenCodeMessageRecord>>>,
    permissions: Mutex<HashMap<String, OpenCodePermissionRecord>>,
    questions: Mutex<HashMap<String, OpenCodeQuestionRecord>>,
    session_runtime: Mutex<HashMap<String, OpenCodeSessionRuntime>>,
    session_streams: Mutex<HashMap<String, bool>>,
    event_log: StdMutex<Vec<OpenCodeEventRecord>>,
    event_sequence: AtomicU64,
    event_broadcaster: broadcast::Sender<OpenCodeEventRecord>,
}

impl OpenCodeState {
    pub fn new() -> Self {
        let (event_broadcaster, _) = broadcast::channel(256);
        let config = OpenCodeCompatConfig::from_env();
        let state_dir = config.state_dir();
        let session_store_path = PathBuf::from(state_dir).join("sessions.json");
        let mut persisted = load_persisted_state(&session_store_path).unwrap_or_else(|| {
            let project_id = format!("proj_{}", PROJECT_COUNTER.fetch_add(1, Ordering::Relaxed));
            OpenCodePersistedState::empty(project_id)
        });
        if persisted.default_project_id.is_empty() {
            persisted.default_project_id =
                format!("proj_{}", PROJECT_COUNTER.fetch_add(1, Ordering::Relaxed));
        }
        for session in persisted.sessions.values_mut() {
            if session.status.status.is_empty() {
                session.status.status = "idle".to_string();
                session.status.updated_at = session.updated_at;
            }
        }
        let derived_next = next_session_id_from(&persisted.sessions);
        if persisted.next_session_id < derived_next {
            persisted.next_session_id = derived_next;
        }
        SESSION_COUNTER.store(persisted.next_session_id, Ordering::Relaxed);
        Self {
            config,
            default_project_id: persisted.default_project_id,
            session_store_path,
            sessions: Mutex::new(persisted.sessions),
            messages: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            questions: Mutex::new(HashMap::new()),
            session_runtime: Mutex::new(HashMap::new()),
            session_streams: Mutex::new(HashMap::new()),
            event_log: StdMutex::new(Vec::new()),
            event_sequence: AtomicU64::new(0),
            event_broadcaster,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<OpenCodeEventRecord> {
        self.event_broadcaster.subscribe()
    }

    pub fn emit_event(&self, event: Value) {
        let sequence = self.event_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let record = OpenCodeEventRecord {
            sequence,
            payload: event,
        };
        if let Ok(mut events) = self.event_log.lock() {
            events.push(record.clone());
        }
        let _ = self.event_broadcaster.send(record);
    }

    pub fn events_since(&self, offset: u64) -> Vec<OpenCodeEventRecord> {
        let Ok(events) = self.event_log.lock() else {
            return Vec::new();
        };
        events
            .iter()
            .filter(|record| record.sequence > offset)
            .cloned()
            .collect()
    }

    fn now_ms(&self) -> i64 {
        self.config.now_ms()
    }

    fn directory_for(&self, headers: &HeaderMap, query: Option<&String>) -> String {
        if let Some(value) = query {
            return value.clone();
        }
        if let Some(value) = self
            .config
            .fixed_directory
            .as_ref()
            .cloned()
            .or_else(|| {
                headers
                    .get("x-opencode-directory")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_string())
            })
        {
            return value;
        }
        std::env::current_dir()
            .ok()
            .and_then(|p| p.to_str().map(|v| v.to_string()))
            .unwrap_or_else(|| ".".to_string())
    }

    fn worktree_for(&self, directory: &str) -> String {
        self.config
            .fixed_worktree
            .clone()
            .unwrap_or_else(|| directory.to_string())
    }

    fn home_dir(&self) -> String {
        self.config.home_dir()
    }

    fn state_dir(&self) -> String {
        self.config.state_dir()
    }

    async fn persist_sessions(&self) {
        let sessions = self.sessions.lock().await;
        let persisted = OpenCodePersistedState {
            default_project_id: self.default_project_id.clone(),
            next_session_id: SESSION_COUNTER.load(Ordering::Relaxed),
            sessions: sessions.clone(),
        };
        drop(sessions);
        let path = self.session_store_path.clone();
        let payload = match serde_json::to_vec_pretty(&persisted) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(
                    target = "sandbox_agent::opencode",
                    ?err,
                    "failed to serialize session store"
                );
                return;
            }
        };
        let result = tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, payload)
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::warn!(
                    target = "sandbox_agent::opencode",
                    ?err,
                    "failed to persist session store"
                );
            }
            Err(err) => {
                tracing::warn!(
                    target = "sandbox_agent::opencode",
                    ?err,
                    "failed to persist session store"
                );
            }
        }
    }

    async fn mutate_session(
        &self,
        session_id: &str,
        update: impl FnOnce(&mut OpenCodeSessionRecord),
    ) -> Option<OpenCodeSessionRecord> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions.get_mut(session_id)?;
        update(session);
        Some(session.clone())
    }

    async fn update_session_status(
        &self,
        session_id: &str,
        status: &str,
    ) -> Option<OpenCodeSessionRecord> {
        let now = self.now_ms();
        let updated = self
            .mutate_session(session_id, |session| {
                session.status.status = status.to_string();
                session.status.updated_at = now;
                session.updated_at = now;
            })
            .await;
        if updated.is_some() {
            self.persist_sessions().await;
        }
        updated
    }

    async fn ensure_session(&self, session_id: &str, directory: String) -> Value {
        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(session_id) {
            return existing.to_value();
        }

        let now = self.now_ms();
        let record = OpenCodeSessionRecord {
            id: session_id.to_string(),
            slug: format!("session-{}", session_id),
            project_id: self.default_project_id.clone(),
            directory,
            parent_id: None,
            title: format!("Session {}", session_id),
            version: "0".to_string(),
            created_at: now,
            updated_at: now,
            share_url: None,
            status: OpenCodeSessionStatus {
                status: "idle".to_string(),
                updated_at: now,
            },
        };
        let value = record.to_value();
        sessions.insert(session_id.to_string(), record);
        drop(sessions);

        self.emit_event(session_event("session.created", &value));
        self.persist_sessions().await;
        value
    }

    fn config_dir(&self) -> String {
        self.config
            .fixed_config
            .clone()
            .unwrap_or_else(|| format!("{}/.config/opencode", self.home_dir()))
    }

    fn branch_name(&self) -> String {
        self.config
            .fixed_branch
            .clone()
            .unwrap_or_else(|| "main".to_string())
    }

    async fn update_runtime(
        &self,
        session_id: &str,
        update: impl FnOnce(&mut OpenCodeSessionRuntime),
    ) -> OpenCodeSessionRuntime {
        let mut runtimes = self.session_runtime.lock().await;
        let entry = runtimes
            .entry(session_id.to_string())
            .or_insert_with(OpenCodeSessionRuntime::default);
        update(entry);
        entry.clone()
    }
}

/// Combined app state with OpenCode state.
pub struct OpenCodeAppState {
    pub inner: Arc<AppState>,
    pub opencode: Arc<OpenCodeState>,
}

impl OpenCodeAppState {
    pub fn new(inner: Arc<AppState>) -> Arc<Self> {
        let state = Arc::new(Self {
            inner,
            opencode: Arc::new(OpenCodeState::new()),
        });
        spawn_pty_event_forwarder(state.clone());
        state
    }
}

async fn ensure_backing_session(
    state: &Arc<OpenCodeAppState>,
    session_id: &str,
    agent: &str,
) -> Result<(), SandboxError> {
    let request = CreateSessionRequest {
        agent: agent.to_string(),
        agent_mode: None,
        permission_mode: None,
        model: None,
        variant: None,
        agent_version: None,
    };
    match state
        .inner
        .session_manager()
        .create_session(session_id.to_string(), request)
        .await
    {
        Ok(_) => Ok(()),
        Err(SandboxError::SessionAlreadyExists { .. }) => Ok(()),
        Err(err) => Err(err),
    }
}

async fn ensure_session_stream(state: Arc<OpenCodeAppState>, session_id: String) {
    let should_spawn = {
        let mut streams = state.opencode.session_streams.lock().await;
        if streams.contains_key(&session_id) {
            false
        } else {
            streams.insert(session_id.clone(), true);
            true
        }
    };
    if !should_spawn {
        return;
    }

    tokio::spawn(async move {
        let subscription = match state
            .inner
            .session_manager()
            .subscribe(&session_id, 0)
            .await
        {
            Ok(subscription) => subscription,
            Err(_) => {
                let mut streams = state.opencode.session_streams.lock().await;
                streams.remove(&session_id);
                return;
            }
        };

        for event in subscription.initial_events {
            apply_universal_event(state.clone(), event).await;
        }
        let mut receiver = subscription.receiver;
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    apply_universal_event(state.clone(), event).await;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
        let mut streams = state.opencode.session_streams.lock().await;
        streams.remove(&session_id);
    });
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenCodeCreateSessionRequest {
    title: Option<String>,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    #[schema(value_type = String)]
    permission: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenCodeUpdateSessionRequest {
    title: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct DirectoryQuery {
    directory: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct EventStreamQuery {
    directory: Option<String>,
    offset: Option<u64>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct ToolQuery {
    directory: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenCodeMcpRegisterRequest {
    name: String,
    config: McpServerConfig,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct OpenCodeMcpAuthCallbackRequest {
    code: String,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FindTextQuery {
    directory: Option<String>,
    pattern: Option<String>,
    #[serde(rename = "caseSensitive")]
    case_sensitive: Option<bool>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FindFilesQuery {
    directory: Option<String>,
    query: Option<String>,
    dirs: Option<bool>,
    #[serde(rename = "type")]
    entry_type: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FindSymbolsQuery {
    directory: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, IntoParams)]
struct FileContentQuery {
    directory: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionMessageRequest {
    #[schema(value_type = Vec<String>)]
    parts: Option<Vec<Value>>,
    #[serde(rename = "messageID")]
    message_id: Option<String>,
    agent: Option<String>,
    #[schema(value_type = String)]
    model: Option<Value>,
    system: Option<String>,
    variant: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionCommandRequest {
    command: Option<String>,
    arguments: Option<String>,
    #[serde(rename = "messageID")]
    message_id: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    #[schema(value_type = Vec<String>)]
    parts: Option<Vec<Value>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionShellRequest {
    command: Option<String>,
    agent: Option<String>,
    #[schema(value_type = String)]
    model: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionSummarizeRequest {
    #[serde(rename = "providerID")]
    provider_id: Option<String>,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    auto: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
struct PermissionReplyRequest {
    response: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PermissionGlobalReplyRequest {
    reply: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct QuestionReplyBody {
    answers: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PtyCreateRequest {
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    title: Option<String>,
    env: Option<HashMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PtySizeRequest {
    rows: u16,
    cols: u16,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PtyUpdateRequest {
    title: Option<String>,
    size: Option<PtySizeRequest>,
}

fn next_id(prefix: &str, counter: &AtomicU64) -> String {
    let id = counter.fetch_add(1, Ordering::Relaxed);
    format!("{}{}", prefix, id)
}

fn next_session_id_from(sessions: &HashMap<String, OpenCodeSessionRecord>) -> u64 {
    let mut max_id = 0;
    for session_id in sessions.keys() {
        if let Some(raw) = session_id.strip_prefix("ses_") {
            if let Ok(value) = raw.parse::<u64>() {
                if value > max_id {
                    max_id = value;
                }
            }
        }
    }
    if max_id == 0 {
        1
    } else {
        max_id + 1
    }
}

fn bump_version(version: &str) -> String {
    let parsed = version.parse::<u64>().unwrap_or(0);
    (parsed + 1).to_string()
}

fn load_persisted_state(path: &FsPath) -> Option<OpenCodePersistedState> {
    let contents = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<OpenCodePersistedState>(&contents) {
        Ok(state) => Some(state),
        Err(err) => {
            tracing::warn!(
                target = "sandbox_agent::opencode",
                ?err,
                "failed to parse session store"
            );
            None
        }
    }
}

fn available_agent_ids() -> Vec<AgentId> {
    vec![
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Opencode,
        AgentId::Amp,
        AgentId::Mock,
    ]
}

fn default_agent_id() -> AgentId {
    AgentId::Mock
}

fn default_agent_mode() -> &'static str {
    OPENCODE_DEFAULT_AGENT_MODE
}

fn resolve_agent_from_model(provider_id: &str, model_id: &str) -> Option<AgentId> {
    if provider_id == OPENCODE_PROVIDER_ID {
        AgentId::parse(model_id)
    } else {
        None
    }
}

fn normalize_agent_mode(agent: Option<String>) -> String {
    agent.filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_agent_mode().to_string())
}

async fn resolve_session_agent(
    state: &OpenCodeAppState,
    session_id: &str,
    requested_provider: Option<&str>,
    requested_model: Option<&str>,
) -> (String, String, String) {
    let mut provider_id = requested_provider
        .filter(|value| !value.is_empty())
        .unwrap_or(OPENCODE_PROVIDER_ID)
        .to_string();
    let mut model_id = requested_model
        .filter(|value| !value.is_empty())
        .unwrap_or(OPENCODE_DEFAULT_MODEL_ID)
        .to_string();
    let mut resolved_agent = resolve_agent_from_model(&provider_id, &model_id);
    if resolved_agent.is_none() {
        provider_id = OPENCODE_PROVIDER_ID.to_string();
        model_id = OPENCODE_DEFAULT_MODEL_ID.to_string();
        resolved_agent = Some(default_agent_id());
    }

    let mut resolved_agent_id: Option<String> = None;
    let mut resolved_provider: Option<String> = None;
    let mut resolved_model: Option<String> = None;

    state
        .opencode
        .update_runtime(session_id, |runtime| {
            if runtime.session_agent_id.is_none() {
                let agent = resolved_agent.unwrap_or_else(default_agent_id);
                runtime.session_agent_id = Some(agent.as_str().to_string());
                runtime.session_provider_id = Some(provider_id.clone());
                runtime.session_model_id = Some(model_id.clone());
            }
            resolved_agent_id = runtime.session_agent_id.clone();
            resolved_provider = runtime.session_provider_id.clone();
            resolved_model = runtime.session_model_id.clone();
        })
        .await;

    (
        resolved_agent_id.unwrap_or_else(|| default_agent_id().as_str().to_string()),
        resolved_provider.unwrap_or(provider_id),
        resolved_model.unwrap_or(model_id),
    )
}

fn agent_display_name(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Claude => "Claude",
        AgentId::Codex => "Codex",
        AgentId::Opencode => "OpenCode",
        AgentId::Amp => "Amp",
        AgentId::Mock => "Mock",
    }
}

fn model_config_entry(agent: AgentId) -> Value {
    json!({
        "id": agent.as_str(),
        "providerID": OPENCODE_PROVIDER_ID,
        "api": {
            "id": "sandbox-agent",
            "url": "http://localhost",
            "npm": "@sandbox-agent/sdk"
        },
        "name": agent_display_name(agent),
        "family": "sandbox-agent",
        "capabilities": {
            "temperature": true,
            "reasoning": true,
            "attachment": false,
            "toolcall": true,
            "input": {
                "text": true,
                "audio": false,
                "image": false,
                "video": false,
                "pdf": false
            },
            "output": {
                "text": true,
                "audio": false,
                "image": false,
                "video": false,
                "pdf": false
            },
            "interleaved": false
        },
        "cost": {
            "input": 0,
            "output": 0,
            "cache": {"read": 0, "write": 0}
        },
        "limit": {
            "context": 128000,
            "output": 4096
        },
        "status": "active",
        "options": {},
        "headers": {},
        "release_date": "2024-01-01",
        "variants": {}
    })
}

fn model_summary_entry(agent: AgentId) -> Value {
    json!({
        "id": agent.as_str(),
        "name": agent_display_name(agent),
        "release_date": "2024-01-01",
        "attachment": false,
        "reasoning": true,
        "temperature": true,
        "tool_call": true,
        "options": {},
        "limit": {
            "context": 128000,
            "output": 4096
        }
    })
}

fn bad_request(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "data": {},
            "errors": [{"message": message}],
            "success": false,
        })),
    )
}

fn not_found(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "name": "NotFoundError",
            "data": {"message": message},
        })),
    )
}

fn internal_error(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "data": {},
            "errors": [{"message": message}],
            "success": false,
        })),
    )
}

fn sandbox_error_response(err: SandboxError) -> (StatusCode, Json<Value>) {
    match err {
        SandboxError::SessionNotFound { .. } => not_found("Session not found"),
        SandboxError::InvalidRequest { message } => bad_request(&message),
        other => internal_error(&other.to_string()),
    }
}

fn mcp_error_response(err: McpRegistryError) -> (StatusCode, Json<Value>) {
    match err {
        McpRegistryError::NotFound => not_found("MCP server not found"),
        McpRegistryError::Invalid(message) => bad_request(&message),
        McpRegistryError::Transport(message) => internal_error(&message),
    }
}

fn parse_permission_reply_value(value: Option<&str>) -> Result<PermissionReply, String> {
    let value = value.unwrap_or("once").to_ascii_lowercase();
    match value.as_str() {
        "once" | "allow" | "approve" => Ok(PermissionReply::Once),
        "always" => Ok(PermissionReply::Always),
        "reject" | "deny" => Ok(PermissionReply::Reject),
        other => PermissionReply::from_str(other),
    }
}

fn bool_ok(value: bool) -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!(value)))
}

fn pty_to_value(pty: &PtyRecord) -> Value {
    json!({
        "id": pty.id,
        "title": pty.title,
        "command": pty.command,
        "args": pty.args,
        "cwd": pty.cwd,
        "status": pty.status.as_str(),
        "pid": pty.pid,
    })
}

fn spawn_pty_event_forwarder(state: Arc<OpenCodeAppState>) {
    let mut receiver = state
        .inner
        .session_manager()
        .pty_manager()
        .subscribe();
    tokio::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(PtyEvent::Exited { id, exit_code }) => {
                    state.opencode.emit_event(json!({
                        "type": "pty.exited",
                        "properties": {"id": id, "exitCode": exit_code}
                    }));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn build_user_message(
    session_id: &str,
    message_id: &str,
    created_at: i64,
    agent: &str,
    provider_id: &str,
    model_id: &str,
) -> Value {
    json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "user",
        "time": {"created": created_at},
        "agent": agent,
        "model": {"providerID": provider_id, "modelID": model_id},
    })
}

fn build_assistant_message(
    session_id: &str,
    message_id: &str,
    parent_id: &str,
    created_at: i64,
    directory: &str,
    worktree: &str,
    agent: &str,
    provider_id: &str,
    model_id: &str,
) -> Value {
    json!({
        "id": message_id,
        "sessionID": session_id,
        "role": "assistant",
        "time": {"created": created_at},
        "parentID": parent_id,
        "modelID": model_id,
        "providerID": provider_id,
        "mode": "default",
        "agent": agent,
        "path": {"cwd": directory, "root": worktree},
        "cost": 0,
        "finish": "stop",
        "tokens": {
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache": {"read": 0, "write": 0}
        }
    })
}

fn build_text_part(session_id: &str, message_id: &str, text: &str) -> Value {
    json!({
        "id": next_id("part_", &PART_COUNTER),
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": text,
    })
}

fn part_id_from_input(input: &Value) -> String {
    input
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .unwrap_or_else(|| next_id("part_", &PART_COUNTER))
}

fn build_file_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(part_id_from_input(input)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("file"));
    map.insert(
        "mime".to_string(),
        input
            .get("mime")
            .cloned()
            .unwrap_or_else(|| json!("application/octet-stream")),
    );
    map.insert(
        "url".to_string(),
        input.get("url").cloned().unwrap_or_else(|| json!("")),
    );
    if let Some(filename) = input.get("filename") {
        map.insert("filename".to_string(), filename.clone());
    }
    if let Some(source) = input.get("source") {
        map.insert("source".to_string(), source.clone());
    }
    Value::Object(map)
}

fn build_agent_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(part_id_from_input(input)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("agent"));
    map.insert(
        "name".to_string(),
        input.get("name").cloned().unwrap_or_else(|| json!("")),
    );
    if let Some(source) = input.get("source") {
        map.insert("source".to_string(), source.clone());
    }
    Value::Object(map)
}

fn build_subtask_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(part_id_from_input(input)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("subtask"));
    map.insert(
        "prompt".to_string(),
        input.get("prompt").cloned().unwrap_or_else(|| json!("")),
    );
    map.insert(
        "description".to_string(),
        input
            .get("description")
            .cloned()
            .unwrap_or_else(|| json!("")),
    );
    map.insert(
        "agent".to_string(),
        input.get("agent").cloned().unwrap_or_else(|| json!("")),
    );
    if let Some(model) = input.get("model") {
        map.insert("model".to_string(), model.clone());
    }
    if let Some(command) = input.get("command") {
        map.insert("command".to_string(), command.clone());
    }
    Value::Object(map)
}

fn normalize_part(session_id: &str, message_id: &str, input: &Value) -> Value {
    match input.get("type").and_then(|v| v.as_str()) {
        Some("file") => build_file_part(session_id, message_id, input),
        Some("agent") => build_agent_part(session_id, message_id, input),
        Some("subtask") => build_subtask_part(session_id, message_id, input),
        _ => build_text_part(
            session_id,
            message_id,
            input
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim(),
        ),
    }
}

fn message_id_for_sequence(sequence: u64) -> String {
    format!("msg_{:020}", sequence)
}

fn unique_assistant_message_id(
    runtime: &OpenCodeSessionRuntime,
    parent_id: Option<&String>,
    sequence: u64,
) -> String {
    let base = match parent_id {
        Some(parent) => format!("{parent}_assistant"),
        None => message_id_for_sequence(sequence),
    };
    if runtime.message_id_for_item.values().any(|id| id == &base) {
        format!("{base}_{:020}", sequence)
    } else {
        base
    }
}


fn extract_text_from_content(parts: &[ContentPart]) -> Option<String> {
    let mut text = String::new();
    for part in parts {
        match part {
            ContentPart::Text { text: chunk } => {
                text.push_str(chunk);
            }
            ContentPart::Json { json } => {
                if let Ok(chunk) = serde_json::to_string(json) {
                    text.push_str(&chunk);
                }
            }
            ContentPart::Status { label, detail } => {
                text.push_str(label);
                if let Some(detail) = detail {
                    if !detail.is_empty() {
                        text.push_str(": ");
                        text.push_str(detail);
                    }
                }
            }
            _ => {}
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn build_text_part_with_id(session_id: &str, message_id: &str, part_id: &str, text: &str) -> Value {
    json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": text,
    })
}

fn build_reasoning_part(
    session_id: &str,
    message_id: &str,
    part_id: &str,
    text: &str,
    now: i64,
) -> Value {
    json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "reasoning",
        "text": text,
        "metadata": {},
        "time": {"start": now, "end": now},
    })
}

fn build_tool_part(
    session_id: &str,
    message_id: &str,
    part_id: &str,
    call_id: &str,
    tool: &str,
    state: Value,
) -> Value {
    json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "tool",
        "callID": call_id,
        "tool": tool,
        "state": state,
        "metadata": {},
    })
}

fn file_source_from_diff(path: &str, diff: &str) -> Value {
    json!({
        "type": "file",
        "path": path,
        "text": {
            "value": diff,
            "start": 0,
            "end": diff.len() as i64,
        }
    })
}

fn build_file_part_from_path(
    session_id: &str,
    message_id: &str,
    path: &str,
    mime: &str,
    diff: Option<&str>,
) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".to_string(), json!(next_id("part_", &PART_COUNTER)));
    map.insert("sessionID".to_string(), json!(session_id));
    map.insert("messageID".to_string(), json!(message_id));
    map.insert("type".to_string(), json!("file"));
    map.insert("mime".to_string(), json!(mime));
    map.insert("url".to_string(), json!(format!("file://{}", path)));
    map.insert("filename".to_string(), json!(path));
    if let Some(diff) = diff {
        map.insert("source".to_string(), file_source_from_diff(path, diff));
    }
    Value::Object(map)
}

fn session_event(event_type: &str, session: &Value) -> Value {
    json!({
        "type": event_type,
        "properties": {"info": session}
    })
}

fn message_event(event_type: &str, message: &Value) -> Value {
    let session_id = message
        .get("sessionID")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let mut props = serde_json::Map::new();
    props.insert("info".to_string(), message.clone());
    if let Some(session_id) = session_id {
        props.insert("sessionID".to_string(), json!(session_id));
    }
    Value::Object({
        let mut map = serde_json::Map::new();
        map.insert("type".to_string(), json!(event_type));
        map.insert("properties".to_string(), Value::Object(props));
        map
    })
}

fn part_event_with_delta(event_type: &str, part: &Value, delta: Option<&str>) -> Value {
    let mut props = serde_json::Map::new();
    props.insert("part".to_string(), part.clone());
    if let Some(session_id) = part.get("sessionID").and_then(|v| v.as_str()) {
        props.insert("sessionID".to_string(), json!(session_id));
    }
    if let Some(message_id) = part.get("messageID").and_then(|v| v.as_str()) {
        props.insert("messageID".to_string(), json!(message_id));
    }
    if let Some(delta) = delta {
        props.insert("delta".to_string(), json!(delta));
    }
    Value::Object({
        let mut map = serde_json::Map::new();
        map.insert("type".to_string(), json!(event_type));
        map.insert("properties".to_string(), Value::Object(props));
        map
    })
}

fn part_event(event_type: &str, part: &Value) -> Value {
    part_event_with_delta(event_type, part, None)
}

fn emit_file_edited(state: &OpenCodeState, path: &str) {
    state.emit_event(json!({
        "type": "file.edited",
        "properties": {"file": path}
    }));
}

fn permission_event(event_type: &str, permission: &Value) -> Value {
    json!({
        "type": event_type,
        "properties": permission
    })
}

fn question_event(event_type: &str, question: &Value) -> Value {
    json!({
        "type": event_type,
        "properties": question
    })
}

fn message_id_from_info(info: &Value) -> Option<String> {
    info.get("id").and_then(|v| v.as_str()).map(|v| v.to_string())
}

async fn upsert_message_info(
    state: &OpenCodeState,
    session_id: &str,
    info: Value,
) -> Vec<Value> {
    let mut messages = state.messages.lock().await;
    let entry = messages.entry(session_id.to_string()).or_default();
    let message_id = message_id_from_info(&info);
    if let Some(message_id) = message_id.clone() {
        if let Some(existing) = entry
            .iter_mut()
            .find(|record| message_id_from_info(&record.info).as_deref() == Some(message_id.as_str()))
        {
            existing.info = info.clone();
        } else {
            entry.push(OpenCodeMessageRecord {
                info: info.clone(),
                parts: Vec::new(),
            });
        }
        entry.sort_by(|a, b| {
            let a_id = message_id_from_info(&a.info).unwrap_or_default();
            let b_id = message_id_from_info(&b.info).unwrap_or_default();
            a_id.cmp(&b_id)
        });
    }
    entry.iter().map(|record| record.info.clone()).collect()
}

async fn upsert_message_part(
    state: &OpenCodeState,
    session_id: &str,
    message_id: &str,
    part: Value,
) {
    let mut messages = state.messages.lock().await;
    let entry = messages.entry(session_id.to_string()).or_default();
    let record = if let Some(record) = entry
        .iter_mut()
        .find(|record| message_id_from_info(&record.info).as_deref() == Some(message_id))
    {
        record
    } else {
        entry.push(OpenCodeMessageRecord {
            info: json!({"id": message_id, "sessionID": session_id, "role": "assistant", "time": {"created": 0}}),
            parts: Vec::new(),
        });
        entry.last_mut().expect("record just inserted")
    };

    let part_id = part.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(existing) = record
        .parts
        .iter_mut()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(part_id))
    {
        *existing = part;
    } else {
        record.parts.push(part);
    }
    record.parts.sort_by(|a, b| {
        let a_id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
        a_id.cmp(b_id)
    });
}

async fn session_directory(state: &OpenCodeState, session_id: &str) -> String {
    let sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get(session_id) {
        return session.directory.clone();
    }
    std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(|v| v.to_string()))
        .unwrap_or_else(|| ".".to_string())
}

#[derive(Default)]
struct ToolContentInfo {
    call_id: Option<String>,
    tool_name: Option<String>,
    arguments: Option<String>,
    output: Option<String>,
    file_refs: Vec<(String, FileAction, Option<String>, Option<String>)>,
}

fn extract_tool_content(parts: &[ContentPart]) -> ToolContentInfo {
    let mut info = ToolContentInfo::default();
    for part in parts {
        match part {
            ContentPart::ToolCall {
                name,
                arguments,
                call_id,
            } => {
                info.call_id = Some(call_id.clone());
                info.tool_name = Some(name.clone());
                info.arguments = Some(arguments.clone());
            }
            ContentPart::ToolResult { call_id, output } => {
                info.call_id = Some(call_id.clone());
                info.output = Some(output.clone());
            }
            ContentPart::FileRef {
                path,
                action,
                diff,
                target_path,
            } => {
                info.file_refs.push((
                    path.clone(),
                    action.clone(),
                    diff.clone(),
                    target_path.clone(),
                ));
            }
            _ => {}
        }
    }
    info
}

fn tool_input_from_arguments(arguments: Option<&str>) -> Value {
    let Some(arguments) = arguments else {
        return json!({});
    };
    if let Ok(value) = serde_json::from_str::<Value>(arguments) {
        if value.is_object() {
            return value;
        }
    }
    json!({ "arguments": arguments })
}

async fn tool_call_snapshot(
    state: &OpenCodeAppState,
    session_id: &str,
    call_id: &str,
) -> Option<ToolCallSnapshot> {
    state
        .inner
        .session_manager()
        .tool_call_snapshot(session_id, call_id)
        .await
}

async fn file_actions_for_event(
    state: &OpenCodeAppState,
    session_id: &str,
    sequence: u64,
) -> Vec<FileActionSnapshot> {
    state
        .inner
        .session_manager()
        .file_actions_for_event(session_id, sequence)
        .await
}

fn tool_state_from_snapshot(
    snapshot: Option<&ToolCallSnapshot>,
    fallback_name: &str,
    fallback_arguments: Option<&str>,
    fallback_output: Option<&str>,
    attachments: Vec<Value>,
    now: i64,
) -> (String, Value) {
    let tool_name = snapshot
        .and_then(|state| state.name.clone())
        .unwrap_or_else(|| fallback_name.to_string());
    let arguments = snapshot
        .and_then(|state| state.arguments.clone())
        .or_else(|| fallback_arguments.map(|value| value.to_string()));
    let raw_args = arguments.clone().unwrap_or_default();
    let input_value = tool_input_from_arguments(arguments.as_deref());
    let output = snapshot
        .and_then(|state| state.output.clone())
        .or_else(|| fallback_output.map(|value| value.to_string()));
    let status = snapshot.map(|state| &state.status);

    let state_value = match status {
        Some(ToolCallStatus::Result) => json!({
            "status": "completed",
            "input": input_value,
            "output": output.unwrap_or_default(),
            "title": "Tool result",
            "metadata": {},
            "time": {"start": now, "end": now},
            "attachments": attachments,
        }),
        Some(ToolCallStatus::Failed) => json!({
            "status": "error",
            "input": input_value,
            "error": output.unwrap_or_else(|| "Tool failed".to_string()),
            "metadata": {},
            "time": {"start": now, "end": now},
        }),
        Some(ToolCallStatus::Completed)
        | Some(ToolCallStatus::Running)
        | Some(ToolCallStatus::Delta) => json!({
            "status": "running",
            "input": input_value,
            "time": {"start": now},
        }),
        Some(ToolCallStatus::Started) | None => json!({
            "status": "pending",
            "input": input_value,
            "raw": raw_args,
        }),
    };

    (tool_name, state_value)
}

fn file_action_applied(
    file_actions: &[FileActionSnapshot],
    path: &str,
    action: &FileAction,
    target_path: Option<&str>,
    diff: Option<&str>,
) -> bool {
    file_actions.iter().any(|record| {
        let diff_matches = match diff {
            Some(value) => record.diff.as_deref() == Some(value),
            None => true,
        };
        record.action == *action
            && record.path == path
            && record.target_path.as_deref() == target_path
            && diff_matches
            && record.applied
    })
}

fn patterns_from_metadata(metadata: &Option<Value>) -> Vec<String> {
    let mut patterns = Vec::new();
    let Some(metadata) = metadata else {
        return patterns;
    };
    if let Some(path) = metadata.get("path").and_then(|v| v.as_str()) {
        patterns.push(path.to_string());
    }
    if let Some(paths) = metadata.get("paths").and_then(|v| v.as_array()) {
        for value in paths {
            if let Some(path) = value.as_str() {
                patterns.push(path.to_string());
            }
        }
    }
    if let Some(patterns_value) = metadata.get("patterns").and_then(|v| v.as_array()) {
        for value in patterns_value {
            if let Some(pattern) = value.as_str() {
                patterns.push(pattern.to_string());
            }
        }
    }
    patterns
}

async fn apply_universal_event(state: Arc<OpenCodeAppState>, event: UniversalEvent) {
    match event.event_type {
        UniversalEventType::ItemStarted | UniversalEventType::ItemCompleted => {
            if let UniversalEventData::Item(ItemEventData { item }) = &event.data {
                apply_item_event(state, event.clone(), item.clone()).await;
            }
        }
        UniversalEventType::ItemDelta => {
            if let UniversalEventData::ItemDelta(ItemDeltaData {
                item_id,
                native_item_id,
                delta,
            }) = &event.data
            {
                apply_item_delta(
                    state,
                    event.clone(),
                    item_id.clone(),
                    native_item_id.clone(),
                    delta.clone(),
                )
                .await;
            }
        }
        UniversalEventType::SessionEnded => {
            let session_id = event.session_id.clone();
            state.opencode.emit_event(json!({
                "type": "session.status",
                "properties": {"sessionID": session_id, "status": {"type": "idle"}}
            }));
            state.opencode.emit_event(json!({
                "type": "session.idle",
                "properties": {"sessionID": event.session_id}
            }));
            let _ = state
                .opencode
                .update_session_status(&event.session_id, "idle")
                .await;
        }
        UniversalEventType::PermissionRequested | UniversalEventType::PermissionResolved => {
            if let UniversalEventData::Permission(permission) = &event.data {
                apply_permission_event(state, event.clone(), permission.clone()).await;
            }
        }
        UniversalEventType::QuestionRequested | UniversalEventType::QuestionResolved => {
            if let UniversalEventData::Question(question) = &event.data {
                apply_question_event(state, event.clone(), question.clone()).await;
            }
        }
        UniversalEventType::Error => {
            if let UniversalEventData::Error(error) = &event.data {
                state.opencode.emit_event(json!({
                    "type": "session.status",
                    "properties": {
                        "sessionID": event.session_id,
                        "status": {"type": "error"}
                    }
                }));
                state.opencode.emit_event(json!({
                    "type": "session.error",
                    "properties": {
                        "sessionID": event.session_id,
                        "error": {
                            "data": {"message": error.message},
                            "code": error.code,
                            "details": error.details,
                        }
                    }
                }));
                let _ = state
                    .opencode
                    .update_session_status(&event.session_id, "error")
                    .await;
            }
        }
        _ => {}
    }
}

async fn apply_permission_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    permission: PermissionEventData,
) {
    let session_id = event.session_id.clone();
    match permission.status {
        PermissionStatus::Requested => {
            let record = OpenCodePermissionRecord {
                id: permission.permission_id.clone(),
                session_id: session_id.clone(),
                permission: permission.action.clone(),
                patterns: patterns_from_metadata(&permission.metadata),
                metadata: permission.metadata.clone().unwrap_or_else(|| json!({})),
                always: Vec::new(),
                tool: None,
            };
            let value = record.to_value();
            let mut permissions = state.opencode.permissions.lock().await;
            permissions.insert(record.id.clone(), record);
            drop(permissions);
            state.opencode.emit_event(permission_event("permission.asked", &value));
        }
        PermissionStatus::Approved | PermissionStatus::Denied => {
            let reply = match permission.status {
                PermissionStatus::Approved => "once",
                PermissionStatus::Denied => "reject",
                PermissionStatus::Requested => "once",
            };
            let event_value = json!({
                "sessionID": session_id,
                "requestID": permission.permission_id,
                "reply": reply,
            });
            let mut permissions = state.opencode.permissions.lock().await;
            permissions.remove(&permission.permission_id);
            drop(permissions);
            state
                .opencode
                .emit_event(permission_event("permission.replied", &event_value));
        }
    }
}

async fn apply_question_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    question: QuestionEventData,
) {
    let session_id = event.session_id.clone();
    match question.status {
        QuestionStatus::Requested => {
            let options: Vec<Value> = question
                .options
                .iter()
                .map(|option| {
                    json!({
                        "label": option,
                        "description": ""
                    })
                })
                .collect();
            let question_info = json!({
                "header": "Question",
                "question": question.prompt,
                "options": options,
            });
            let record = OpenCodeQuestionRecord {
                id: question.question_id.clone(),
                session_id: session_id.clone(),
                questions: vec![question_info],
                tool: None,
            };
            let value = record.to_value();
            let mut questions = state.opencode.questions.lock().await;
            questions.insert(record.id.clone(), record);
            drop(questions);
            state.opencode.emit_event(question_event("question.asked", &value));
        }
        QuestionStatus::Answered => {
            let answers = question
                .response
                .clone()
                .map(|answer| vec![vec![answer]])
                .unwrap_or_else(|| Vec::<Vec<String>>::new());
            let event_value = json!({
                "sessionID": session_id,
                "requestID": question.question_id,
                "answers": answers,
            });
            let mut questions = state.opencode.questions.lock().await;
            questions.remove(&question.question_id);
            drop(questions);
            state
                .opencode
                .emit_event(question_event("question.replied", &event_value));
        }
        QuestionStatus::Rejected => {
            let event_value = json!({
                "sessionID": session_id,
                "requestID": question.question_id,
            });
            let mut questions = state.opencode.questions.lock().await;
            questions.remove(&question.question_id);
            drop(questions);
            state
                .opencode
                .emit_event(question_event("question.rejected", &event_value));
        }
    }
}

async fn apply_item_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    item: UniversalItem,
) {
    if matches!(item.kind, ItemKind::ToolCall | ItemKind::ToolResult) {
        apply_tool_item_event(state, event, item).await;
        return;
    }
    if item.kind != ItemKind::Message {
        return;
    }
    if matches!(item.role, Some(ItemRole::User)) {
        return;
    }
    let session_id = event.session_id.clone();
    let item_id_key = if item.item_id.is_empty() {
        None
    } else {
        Some(item.item_id.clone())
    };
    let native_id_key = item.native_item_id.clone();
    let mut message_id: Option<String> = None;
    let mut parent_id: Option<String> = None;
    let runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            parent_id = item
                .parent_id
                .as_ref()
                .and_then(|parent| runtime.message_id_for_item.get(parent).cloned())
                .or_else(|| runtime.last_user_message_id.clone());
            if let Some(existing) = item_id_key
                .clone()
                .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                .or_else(|| {
                    native_id_key
                        .clone()
                        .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                })
            {
                message_id = Some(existing);
            } else {
                let new_id =
                    unique_assistant_message_id(runtime, parent_id.as_ref(), event.sequence);
                message_id = Some(new_id);
            }
            if let Some(id) = message_id.clone() {
                if let Some(item_key) = item_id_key.clone() {
                    runtime
                        .message_id_for_item
                        .insert(item_key, id.clone());
                }
                if let Some(native_key) = native_id_key.clone() {
                    runtime
                        .message_id_for_item
                        .insert(native_key, id.clone());
                }
            }
        })
        .await;
    let message_id = message_id
        .unwrap_or_else(|| unique_assistant_message_id(&runtime, parent_id.as_ref(), event.sequence));
    let parent_id = parent_id.or_else(|| runtime.last_user_message_id.clone());
    let agent = runtime
        .last_agent
        .clone()
        .unwrap_or_else(|| default_agent_mode().to_string());
    let provider_id = runtime
        .last_model_provider
        .clone()
        .unwrap_or_else(|| OPENCODE_PROVIDER_ID.to_string());
    let model_id = runtime
        .last_model_id
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string());
    let directory = session_directory(&state.opencode, &session_id).await;
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();

    let mut info = build_assistant_message(
        &session_id,
        &message_id,
        parent_id.as_deref().unwrap_or(""),
        now,
        &directory,
        &worktree,
        &agent,
        &provider_id,
        &model_id,
    );
    if event.event_type == UniversalEventType::ItemCompleted {
        if let Some(obj) = info.as_object_mut() {
            if let Some(time) = obj.get_mut("time").and_then(|v| v.as_object_mut()) {
                time.insert("completed".to_string(), json!(now));
            }
        }
    }
    upsert_message_info(&state.opencode, &session_id, info.clone()).await;
    state
        .opencode
        .emit_event(message_event("message.updated", &info));
    if event.event_type == UniversalEventType::ItemCompleted {
        state.opencode.emit_event(json!({
            "type": "session.status",
            "properties": {"sessionID": session_id, "status": {"type": "idle"}}
        }));
        state.opencode.emit_event(json!({
            "type": "session.idle",
            "properties": {"sessionID": session_id}
        }));
        let _ = state
            .opencode
            .update_session_status(&session_id, "idle")
            .await;
    }

    let mut runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            if runtime.last_user_message_id.is_none() {
                runtime.last_user_message_id = parent_id.clone();
            }
        })
        .await;

    if let Some(text) = extract_text_from_content(&item.content) {
        let part_id = runtime
            .part_id_by_message
            .entry(message_id.clone())
            .or_insert_with(|| format!("{}_text", message_id))
            .clone();
        runtime.text_by_message.insert(message_id.clone(), text.clone());
        let part = build_text_part_with_id(&session_id, &message_id, &part_id, &text);
        upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
        state
            .opencode
            .emit_event(part_event("message.part.updated", &part));
        let _ = state
            .opencode
            .update_runtime(&session_id, |runtime| {
                runtime
                    .text_by_message
                    .insert(message_id.clone(), text.clone());
                runtime
                    .part_id_by_message
                    .insert(message_id.clone(), part_id.clone());
            })
            .await;
    }

    let file_actions = file_actions_for_event(&state, &session_id, event.sequence).await;

    for part in item.content.iter() {
        match part {
            ContentPart::Reasoning { text, .. } => {
                let part_id = next_id("part_", &PART_COUNTER);
                let reasoning_part =
                    build_reasoning_part(&session_id, &message_id, &part_id, text, now);
                upsert_message_part(&state.opencode, &session_id, &message_id, reasoning_part.clone())
                    .await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &reasoning_part));
            }
            ContentPart::ToolCall {
                name,
                arguments,
                call_id,
            } => {
                let part_id = runtime
                    .tool_part_by_call
                    .entry(call_id.clone())
                    .or_insert_with(|| next_id("part_", &PART_COUNTER))
                    .clone();
                let snapshot = tool_call_snapshot(&state, &session_id, call_id).await;
                let (tool_name, state_value) = tool_state_from_snapshot(
                    snapshot.as_ref(),
                    name,
                    Some(arguments),
                    None,
                    Vec::new(),
                    now,
                );
                let tool_part = build_tool_part(
                    &session_id,
                    &message_id,
                    &part_id,
                    call_id,
                    &tool_name,
                    state_value,
                );
                upsert_message_part(&state.opencode, &session_id, &message_id, tool_part.clone())
                    .await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &tool_part));
                let _ = state
                    .opencode
                    .update_runtime(&session_id, |runtime| {
                        runtime
                            .tool_part_by_call
                            .insert(call_id.clone(), part_id.clone());
                        runtime
                            .tool_message_by_call
                            .insert(call_id.clone(), message_id.clone());
                    })
                    .await;
            }
            ContentPart::ToolResult { call_id, output } => {
                let part_id = runtime
                    .tool_part_by_call
                    .entry(call_id.clone())
                    .or_insert_with(|| next_id("part_", &PART_COUNTER))
                    .clone();
                let snapshot = tool_call_snapshot(&state, &session_id, call_id).await;
                let (tool_name, state_value) = tool_state_from_snapshot(
                    snapshot.as_ref(),
                    "tool",
                    None,
                    Some(output),
                    Vec::new(),
                    now,
                );
                let tool_part = build_tool_part(
                    &session_id,
                    &message_id,
                    &part_id,
                    call_id,
                    &tool_name,
                    state_value,
                );
                upsert_message_part(&state.opencode, &session_id, &message_id, tool_part.clone())
                    .await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &tool_part));
                let _ = state
                    .opencode
                    .update_runtime(&session_id, |runtime| {
                        runtime
                            .tool_part_by_call
                            .insert(call_id.clone(), part_id.clone());
                        runtime
                            .tool_message_by_call
                            .insert(call_id.clone(), message_id.clone());
                    })
                    .await;
            }
            ContentPart::FileRef {
                path,
                action,
                diff,
                target_path,
            } => {
                let mime = match action {
                    FileAction::Patch => "text/x-diff",
                    _ => "text/plain",
                };
                let display_path = target_path.as_deref().unwrap_or(path);
                let part = build_file_part_from_path(
                    &session_id,
                    &message_id,
                    display_path,
                    mime,
                    diff.as_deref(),
                );
                upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &part));
                if matches!(
                    action,
                    FileAction::Write | FileAction::Patch | FileAction::Rename | FileAction::Delete
                ) && file_action_applied(
                    &file_actions,
                    path,
                    action,
                    target_path.as_deref(),
                    diff.as_deref(),
                ) {
                    emit_file_edited(&state.opencode, display_path);
                }
            }
            ContentPart::Image { path, mime } => {
                let mime = mime.as_deref().unwrap_or("image/png");
                let part = build_file_part_from_path(&session_id, &message_id, path, mime, None);
                upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
                state
                    .opencode
                    .emit_event(part_event("message.part.updated", &part));
            }
            _ => {}
        }
    }

    if event.event_type == UniversalEventType::ItemCompleted {
        state.opencode.emit_event(json!({
            "type": "session.status",
            "properties": {
                "sessionID": session_id,
                "status": {"type": "idle"}
            }
        }));
        state.opencode.emit_event(json!({
            "type": "session.idle",
            "properties": { "sessionID": session_id }
        }));
    }
}

async fn apply_tool_item_event(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    item: UniversalItem,
) {
    let session_id = event.session_id.clone();
    let tool_info = extract_tool_content(&item.content);
    let call_id = match tool_info.call_id.clone() {
        Some(call_id) => call_id,
        None => return,
    };

    let item_id_key = if item.item_id.is_empty() {
        None
    } else {
        Some(item.item_id.clone())
    };
    let native_id_key = item.native_item_id.clone();
    let mut message_id: Option<String> = None;
    let mut parent_id: Option<String> = None;
    let runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            parent_id = item
                .parent_id
                .as_ref()
                .and_then(|parent| runtime.message_id_for_item.get(parent).cloned())
                .or_else(|| runtime.last_user_message_id.clone());
            if let Some(existing) = item_id_key
                .clone()
                .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                .or_else(|| {
                    native_id_key
                        .clone()
                        .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                })
                .or_else(|| runtime.tool_message_by_call.get(&call_id).cloned())
            {
                message_id = Some(existing);
            } else {
                let new_id =
                    unique_assistant_message_id(runtime, parent_id.as_ref(), event.sequence);
                message_id = Some(new_id);
            }
            if let Some(id) = message_id.clone() {
                if let Some(item_key) = item_id_key.clone() {
                    runtime
                        .message_id_for_item
                        .insert(item_key, id.clone());
                }
                if let Some(native_key) = native_id_key.clone() {
                    runtime
                        .message_id_for_item
                        .insert(native_key, id.clone());
                }
                runtime
                    .tool_message_by_call
                    .insert(call_id.clone(), id.clone());
            }
        })
        .await;

    let message_id = message_id
        .unwrap_or_else(|| unique_assistant_message_id(&runtime, parent_id.as_ref(), event.sequence));
    let parent_id = parent_id.or_else(|| runtime.last_user_message_id.clone());
    let agent = runtime
        .last_agent
        .clone()
        .unwrap_or_else(|| default_agent_mode().to_string());
    let provider_id = runtime
        .last_model_provider
        .clone()
        .unwrap_or_else(|| OPENCODE_PROVIDER_ID.to_string());
    let model_id = runtime
        .last_model_id
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string());
    let directory = session_directory(&state.opencode, &session_id).await;
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();

    let mut info = build_assistant_message(
        &session_id,
        &message_id,
        parent_id.as_deref().unwrap_or(""),
        now,
        &directory,
        &worktree,
        &agent,
        &provider_id,
        &model_id,
    );
    if event.event_type == UniversalEventType::ItemCompleted {
        if let Some(obj) = info.as_object_mut() {
            if let Some(time) = obj.get_mut("time").and_then(|v| v.as_object_mut()) {
                time.insert("completed".to_string(), json!(now));
            }
        }
    }
    upsert_message_info(&state.opencode, &session_id, info.clone()).await;
    state
        .opencode
        .emit_event(message_event("message.updated", &info));

    let file_actions = file_actions_for_event(&state, &session_id, event.sequence).await;
    let mut attachments = Vec::new();
    if item.kind == ItemKind::ToolResult && event.event_type == UniversalEventType::ItemCompleted {
        for (path, action, diff, target_path) in tool_info.file_refs.iter() {
            let mime = match action {
                FileAction::Patch => "text/x-diff",
                _ => "text/plain",
            };
            let display_path = target_path.as_deref().unwrap_or(path);
            let part = build_file_part_from_path(
                &session_id,
                &message_id,
                display_path,
                mime,
                diff.as_deref(),
            );
            upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
            state
                .opencode
                .emit_event(part_event("message.part.updated", &part));
            attachments.push(part.clone());
            if matches!(
                action,
                FileAction::Write | FileAction::Patch | FileAction::Rename | FileAction::Delete
            ) && file_action_applied(
                &file_actions,
                path,
                action,
                target_path.as_deref(),
                diff.as_deref(),
            ) {
                emit_file_edited(&state.opencode, display_path);
            }
        }
    }

    let part_id = runtime
        .tool_part_by_call
        .get(&call_id)
        .cloned()
        .unwrap_or_else(|| next_id("part_", &PART_COUNTER));
    let snapshot = tool_call_snapshot(&state, &session_id, &call_id).await;
    let output_fallback = tool_info
        .output
        .clone()
        .or_else(|| extract_text_from_content(&item.content));
    let (tool_name, state_value) = tool_state_from_snapshot(
        snapshot.as_ref(),
        tool_info
            .tool_name
            .as_deref()
            .unwrap_or("tool"),
        tool_info.arguments.as_deref(),
        output_fallback.as_deref(),
        attachments,
        now,
    );

    let tool_part = build_tool_part(
        &session_id,
        &message_id,
        &part_id,
        &call_id,
        &tool_name,
        state_value,
    );
    upsert_message_part(&state.opencode, &session_id, &message_id, tool_part.clone()).await;
    state
        .opencode
        .emit_event(part_event("message.part.updated", &tool_part));

    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            runtime
                .tool_part_by_call
                .insert(call_id.clone(), part_id.clone());
            runtime
                .tool_message_by_call
                .insert(call_id.clone(), message_id.clone());
        })
        .await;
}

async fn apply_item_delta(
    state: Arc<OpenCodeAppState>,
    event: UniversalEvent,
    item_id: String,
    native_item_id: Option<String>,
    delta: String,
) {
    let session_id = event.session_id.clone();
    let item_id_key = if item_id.is_empty() { None } else { Some(item_id) };
    let native_id_key = native_item_id;
    let is_user_delta = item_id_key
        .as_ref()
        .map(|value| value.starts_with("user_"))
        .unwrap_or(false)
        || native_id_key
            .as_ref()
            .map(|value| value.starts_with("user_"))
            .unwrap_or(false);
    if is_user_delta {
        return;
    }
    let mut message_id: Option<String> = None;
    let mut parent_id: Option<String> = None;
    let runtime = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            parent_id = runtime.last_user_message_id.clone();
            if let Some(existing) = item_id_key
                .clone()
                .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                .or_else(|| {
                    native_id_key
                        .clone()
                        .and_then(|key| runtime.message_id_for_item.get(&key).cloned())
                })
            {
                message_id = Some(existing);
            } else {
                let new_id =
                    unique_assistant_message_id(runtime, parent_id.as_ref(), event.sequence);
                message_id = Some(new_id);
            }
            if let Some(id) = message_id.clone() {
                if let Some(item_key) = item_id_key.clone() {
                    runtime
                        .message_id_for_item
                        .insert(item_key, id.clone());
                }
                if let Some(native_key) = native_id_key.clone() {
                    runtime
                        .message_id_for_item
                        .insert(native_key, id.clone());
                }
            }
        })
        .await;
    let message_id = message_id
        .unwrap_or_else(|| unique_assistant_message_id(&runtime, parent_id.as_ref(), event.sequence));
    let parent_id = parent_id.or_else(|| runtime.last_user_message_id.clone());
    let directory = session_directory(&state.opencode, &session_id).await;
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let agent = runtime
        .last_agent
        .clone()
        .unwrap_or_else(|| default_agent_mode().to_string());
    let provider_id = runtime
        .last_model_provider
        .clone()
        .unwrap_or_else(|| OPENCODE_PROVIDER_ID.to_string());
    let model_id = runtime
        .last_model_id
        .clone()
        .unwrap_or_else(|| OPENCODE_DEFAULT_MODEL_ID.to_string());
    let info = build_assistant_message(
        &session_id,
        &message_id,
        parent_id.as_deref().unwrap_or(""),
        now,
        &directory,
        &worktree,
        &agent,
        &provider_id,
        &model_id,
    );
    upsert_message_info(&state.opencode, &session_id, info.clone()).await;
    state
        .opencode
        .emit_event(message_event("message.updated", &info));
    let mut text = runtime
        .text_by_message
        .get(&message_id)
        .cloned()
        .unwrap_or_default();
    text.push_str(&delta);
    let part_id = runtime
        .part_id_by_message
        .get(&message_id)
        .cloned()
        .unwrap_or_else(|| format!("{}_text", message_id));
    let part = build_text_part_with_id(&session_id, &message_id, &part_id, &text);
    upsert_message_part(&state.opencode, &session_id, &message_id, part.clone()).await;
    state
        .opencode
        .emit_event(part_event("message.part.updated", &part));
    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            runtime.text_by_message.insert(message_id.clone(), text);
            runtime
                .part_id_by_message
                .insert(message_id.clone(), part_id.clone());
        })
        .await;
}

/// Build OpenCode-compatible router.
pub fn build_opencode_router(state: Arc<OpenCodeAppState>) -> Router {
    Router::new()
        // Core metadata
        .route("/agent", get(oc_agent_list))
        .route("/command", get(oc_command_list))
        .route("/config", get(oc_config_get).patch(oc_config_patch))
        .route("/config/providers", get(oc_config_providers))
        .route("/event", get(oc_event_subscribe))
        .route("/global/event", get(oc_global_event))
        .route("/global/health", get(oc_global_health))
        .route("/global/config", get(oc_global_config_get).patch(oc_global_config_patch))
        .route("/global/dispose", post(oc_global_dispose))
        .route("/instance/dispose", post(oc_instance_dispose))
        .route("/log", post(oc_log))
        .route("/lsp", get(oc_lsp_status))
        .route("/formatter", get(oc_formatter_status))
        .route("/path", get(oc_path))
        .route("/vcs", get(oc_vcs))
        .route("/project", get(oc_project_list))
        .route("/project/current", get(oc_project_current))
        .route("/project/:projectID", patch(oc_project_update))
        // Sessions
        .route("/session", post(oc_session_create).get(oc_session_list))
        .route("/session/status", get(oc_session_status))
        .route(
            "/session/:sessionID",
            get(oc_session_get)
                .patch(oc_session_update)
                .delete(oc_session_delete),
        )
        .route("/session/:sessionID/abort", post(oc_session_abort))
        .route("/session/:sessionID/children", get(oc_session_children))
        .route("/session/:sessionID/init", post(oc_session_init))
        .route("/session/:sessionID/fork", post(oc_session_fork))
        .route("/session/:sessionID/diff", get(oc_session_diff))
        .route("/session/:sessionID/summarize", post(oc_session_summarize))
        .route(
            "/session/:sessionID/message",
            post(oc_session_message_create).get(oc_session_messages),
        )
        .route(
            "/session/:sessionID/message/:messageID",
            get(oc_session_message_get),
        )
        .route(
            "/session/:sessionID/message/:messageID/part/:partID",
            patch(oc_message_part_update).delete(oc_message_part_delete),
        )
        .route("/session/:sessionID/prompt_async", post(oc_session_prompt_async))
        .route("/session/:sessionID/command", post(oc_session_command))
        .route("/session/:sessionID/shell", post(oc_session_shell))
        .route("/session/:sessionID/revert", post(oc_session_revert))
        .route("/session/:sessionID/unrevert", post(oc_session_unrevert))
        .route(
            "/session/:sessionID/permissions/:permissionID",
            post(oc_session_permission_reply),
        )
        .route("/session/:sessionID/share", post(oc_session_share).delete(oc_session_unshare))
        .route("/session/:sessionID/todo", get(oc_session_todo))
        // Permissions + questions (global)
        .route("/permission", get(oc_permission_list))
        .route("/permission/:requestID/reply", post(oc_permission_reply))
        .route("/question", get(oc_question_list))
        .route("/question/:requestID/reply", post(oc_question_reply))
        .route("/question/:requestID/reject", post(oc_question_reject))
        // Providers
        .route("/provider", get(oc_provider_list))
        .route("/provider/auth", get(oc_provider_auth))
        .route(
            "/provider/:providerID/oauth/authorize",
            post(oc_provider_oauth_authorize),
        )
        .route(
            "/provider/:providerID/oauth/callback",
            post(oc_provider_oauth_callback),
        )
        // Auth
        .route("/auth/:providerID", put(oc_auth_set).delete(oc_auth_remove))
        // PTY
        .route("/pty", get(oc_pty_list).post(oc_pty_create))
        .route(
            "/pty/:ptyID",
            get(oc_pty_get).put(oc_pty_update).delete(oc_pty_delete),
        )
        .route("/pty/:ptyID/connect", get(oc_pty_connect))
        // Files
        .route("/file", get(oc_file_list))
        .route("/file/content", get(oc_file_content))
        .route("/file/status", get(oc_file_status))
        // Find
        .route("/find", get(oc_find_text))
        .route("/find/file", get(oc_find_files))
        .route("/find/symbol", get(oc_find_symbols))
        // MCP
        .route("/mcp", get(oc_mcp_list).post(oc_mcp_register))
        .route("/mcp/:name/auth", post(oc_mcp_auth).delete(oc_mcp_auth_remove))
        .route("/mcp/:name/auth/callback", post(oc_mcp_auth_callback))
        .route("/mcp/:name/auth/authenticate", post(oc_mcp_authenticate))
        .route("/mcp/:name/connect", post(oc_mcp_connect))
        .route("/mcp/:name/disconnect", post(oc_mcp_disconnect))
        // Experimental
        .route("/experimental/tool/ids", get(oc_tool_ids))
        .route("/experimental/tool", get(oc_tool_list))
        .route("/experimental/resource", get(oc_resource_list))
        .route(
            "/experimental/worktree",
            get(oc_worktree_list).post(oc_worktree_create).delete(oc_worktree_delete),
        )
        .route("/experimental/worktree/reset", post(oc_worktree_reset))
        // Skills
        .route("/skill", get(oc_skill_list))
        // TUI
        .route("/tui/control/next", get(oc_tui_next))
        .route("/tui/control/response", post(oc_tui_response))
        .route("/tui/append-prompt", post(oc_tui_append_prompt))
        .route("/tui/open-help", post(oc_tui_open_help))
        .route("/tui/open-sessions", post(oc_tui_open_sessions))
        .route("/tui/open-themes", post(oc_tui_open_themes))
        .route("/tui/open-models", post(oc_tui_open_models))
        .route("/tui/submit-prompt", post(oc_tui_submit_prompt))
        .route("/tui/clear-prompt", post(oc_tui_clear_prompt))
        .route("/tui/execute-command", post(oc_tui_execute_command))
        .route("/tui/show-toast", post(oc_tui_show_toast))
        .route("/tui/publish", post(oc_tui_publish))
        .route("/tui/select-session", post(oc_tui_select_session))
        .with_state(state)
}

// ===================================================================================
// Handler implementations
// ===================================================================================

#[utoipa::path(
    get,
    path = "/agent",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_agent_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let agent = json!({
        "name": OPENCODE_PROVIDER_NAME,
        "description": "Sandbox Agent compatibility layer",
        "mode": "all",
        "native": false,
        "hidden": false,
        "permission": [],
        "options": {},
    });
    (StatusCode::OK, Json(json!([agent])))
}

#[utoipa::path(
    get,
    path = "/command",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_command_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/config",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_config_get() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({})))
}

#[utoipa::path(
    patch,
    path = "/config",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_config_patch(Json(body): Json<Value>) -> impl IntoResponse {
    (StatusCode::OK, Json(body))
}

#[utoipa::path(
    get,
    path = "/config/providers",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_config_providers() -> impl IntoResponse {
    let mut models = serde_json::Map::new();
    for agent in available_agent_ids() {
        models.insert(agent.as_str().to_string(), model_config_entry(agent));
    }
    let providers = json!({
        "providers": [
            {
                "id": OPENCODE_PROVIDER_ID,
                "name": OPENCODE_PROVIDER_NAME,
                "source": "custom",
                "env": [],
                "key": "",
                "options": {},
                "models": Value::Object(models),
            }
        ],
        "default": {
            OPENCODE_PROVIDER_ID: OPENCODE_DEFAULT_MODEL_ID
        }
    });
    (StatusCode::OK, Json(providers))
}

#[utoipa::path(
    get,
    path = "/event",
    responses((status = 200, description = "SSE event stream")),
    tag = "opencode"
)]
async fn oc_event_subscribe(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<EventStreamQuery>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.opencode.subscribe();
    let offset = query
        .offset
        .or_else(|| {
            headers
                .get("last-event-id")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
        })
        .unwrap_or(0);
    let mut pending_events: VecDeque<OpenCodeEventRecord> =
        state.opencode.events_since(offset).into();
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let branch = state.opencode.branch_name();
    state.opencode.emit_event(json!({
        "type": "server.connected",
        "properties": {}
    }));
    state.opencode.emit_event(json!({
        "type": "worktree.ready",
        "properties": {
            "name": directory,
            "branch": branch,
        }
    }));

    let heartbeat_payload = json!({
        "type": "server.heartbeat",
        "properties": {}
    });
    let opencode = state.opencode.clone();
    let stream = stream::unfold(
        (
            receiver,
            pending_events,
            offset,
            interval(std::time::Duration::from_secs(30)),
        ),
        move |(mut rx, mut pending, mut last_sequence, mut ticker)| {
            let heartbeat = heartbeat_payload.clone();
            let opencode = opencode.clone();
            async move {
                loop {
                    if let Some(record) = pending.pop_front() {
                        last_sequence = record.sequence;
                        let sse_event = Event::default()
                            .id(record.sequence.to_string())
                            .json_data(&record.payload)
                            .unwrap_or_else(|_| Event::default().data("{}"));
                        return Some((Ok(sse_event), (rx, pending, last_sequence, ticker)));
                    }
                    tokio::select! {
                        _ = ticker.tick() => {
                            let sse_event = Event::default()
                                .json_data(&heartbeat)
                                .unwrap_or_else(|_| Event::default().data("{}"));
                            return Some((Ok(sse_event), (rx, pending, last_sequence, ticker)));
                        }
                        event = rx.recv() => {
                            match event {
                                Ok(record) => {
                                    if record.sequence <= last_sequence {
                                        continue;
                                    }
                                    last_sequence = record.sequence;
                                    let sse_event = Event::default()
                                        .id(record.sequence.to_string())
                                        .json_data(&record.payload)
                                        .unwrap_or_else(|_| Event::default().data("{}"));
                                    return Some((Ok(sse_event), (rx, pending, last_sequence, ticker)));
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    pending = opencode.events_since(last_sequence).into();
                                    continue;
                                }
                                Err(broadcast::error::RecvError::Closed) => return None,
                            }
                        }
                    }
                }
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
}

#[utoipa::path(
    get,
    path = "/global/event",
    responses((status = 200, description = "SSE event stream")),
    tag = "opencode"
)]
async fn oc_global_event(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<EventStreamQuery>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.opencode.subscribe();
    let offset = query
        .offset
        .or_else(|| {
            headers
                .get("last-event-id")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
        })
        .unwrap_or(0);
    let mut pending_events: VecDeque<OpenCodeEventRecord> =
        state.opencode.events_since(offset).into();
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let branch = state.opencode.branch_name();
    state.opencode.emit_event(json!({
        "type": "server.connected",
        "properties": {}
    }));
    state.opencode.emit_event(json!({
        "type": "worktree.ready",
        "properties": {
            "name": directory.clone(),
            "branch": branch,
        }
    }));

    let heartbeat_payload = json!({
        "payload": {
            "type": "server.heartbeat",
            "properties": {}
        }
    });
    let opencode = state.opencode.clone();
    let stream = stream::unfold(
        (
            receiver,
            pending_events,
            offset,
            interval(std::time::Duration::from_secs(30)),
        ),
        move |(mut rx, mut pending, mut last_sequence, mut ticker)| {
            let directory = directory.clone();
            let heartbeat = heartbeat_payload.clone();
            let opencode = opencode.clone();
            async move {
                loop {
                    if let Some(record) = pending.pop_front() {
                        last_sequence = record.sequence;
                        let payload = json!({"directory": directory, "payload": record.payload});
                        let sse_event = Event::default()
                            .id(record.sequence.to_string())
                            .json_data(&payload)
                            .unwrap_or_else(|_| Event::default().data("{}"));
                        return Some((Ok(sse_event), (rx, pending, last_sequence, ticker)));
                    }
                    tokio::select! {
                        _ = ticker.tick() => {
                            let sse_event = Event::default()
                                .json_data(&heartbeat)
                                .unwrap_or_else(|_| Event::default().data("{}"));
                            return Some((Ok(sse_event), (rx, pending, last_sequence, ticker)));
                        }
                        event = rx.recv() => {
                            match event {
                                Ok(record) => {
                                    if record.sequence <= last_sequence {
                                        continue;
                                    }
                                    last_sequence = record.sequence;
                                    let payload = json!({"directory": directory, "payload": record.payload});
                                    let sse_event = Event::default()
                                        .id(record.sequence.to_string())
                                        .json_data(&payload)
                                        .unwrap_or_else(|_| Event::default().data("{}"));
                                    return Some((Ok(sse_event), (rx, pending, last_sequence, ticker)));
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    pending = opencode.events_since(last_sequence).into();
                                    continue;
                                }
                                Err(broadcast::error::RecvError::Closed) => return None,
                            }
                        }
                    }
                }
            }
        },
    );

    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
}

#[utoipa::path(
    get,
    path = "/global/health",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_health() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "healthy": true,
            "version": env!("CARGO_PKG_VERSION"),
        })),
    )
}

#[utoipa::path(
    get,
    path = "/global/config",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_config_get() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({})))
}

#[utoipa::path(
    patch,
    path = "/global/config",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_config_patch(Json(body): Json<Value>) -> impl IntoResponse {
    (StatusCode::OK, Json(body))
}

#[utoipa::path(
    post,
    path = "/global/dispose",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_global_dispose() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/instance/dispose",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_instance_dispose() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/log",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_log() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/lsp",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_lsp_status(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let status = state.inner.session_manager().lsp_status(&directory);
    (StatusCode::OK, Json(status))
}

#[utoipa::path(
    get,
    path = "/formatter",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_formatter_status(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let status = state.inner.session_manager().formatter_status(&directory);
    (StatusCode::OK, Json(status))
}

#[utoipa::path(
    get,
    path = "/path",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_path(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    (
        StatusCode::OK,
        Json(json!({
            "home": state.opencode.home_dir(),
            "state": state.opencode.state_dir(),
            "config": state.opencode.config_dir(),
            "worktree": worktree,
            "directory": directory,
        })),
    )
}

#[utoipa::path(
    get,
    path = "/vcs",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_vcs(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "branch": state.opencode.branch_name(),
        })),
    )
}

#[utoipa::path(
    get,
    path = "/project",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_project_list(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let project = json!({
        "id": state.opencode.default_project_id.clone(),
        "worktree": worktree,
        "vcs": "git",
        "name": "sandbox-agent",
        "time": {"created": now, "updated": now},
        "sandboxes": [],
    });
    (StatusCode::OK, Json(json!([project])))
}

#[utoipa::path(
    get,
    path = "/project/current",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_project_current(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    (
        StatusCode::OK,
        Json(json!({
        "id": state.opencode.default_project_id.clone(),
        "worktree": worktree,
        "vcs": "git",
        "name": "sandbox-agent",
        "time": {"created": now, "updated": now},
        "sandboxes": [],
    })),
    )
}

#[utoipa::path(
    patch,
    path = "/project/{projectID}",
    params(("projectID" = String, Path, description = "Project ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_project_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(_project_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    oc_project_current(State(state), headers).await
}

#[utoipa::path(
    post,
    path = "/session",
    request_body = OpenCodeCreateSessionRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_create(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    body: Option<Json<OpenCodeCreateSessionRequest>>,
) -> impl IntoResponse {
    let body = body.map(|j| j.0).unwrap_or(OpenCodeCreateSessionRequest {
        title: None,
        parent_id: None,
        permission: None,
    });
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let now = state.opencode.now_ms();
    let id = next_id("ses_", &SESSION_COUNTER);
    let slug = format!("session-{}", id);
    let title = body.title.unwrap_or_else(|| format!("Session {}", id));
    let record = OpenCodeSessionRecord {
        id: id.clone(),
        slug,
        project_id: state.opencode.default_project_id.clone(),
        directory,
        parent_id: body.parent_id,
        title,
        version: "0".to_string(),
        created_at: now,
        updated_at: now,
        share_url: None,
        status: OpenCodeSessionStatus {
            status: "idle".to_string(),
            updated_at: now,
        },
    };

    let session_value = record.to_value();

    let mut sessions = state.opencode.sessions.lock().await;
    sessions.insert(id.clone(), record);
    drop(sessions);

    state
        .opencode
        .emit_event(session_event("session.created", &session_value));
    state.opencode.persist_sessions().await;

    (StatusCode::OK, Json(session_value))
}

#[utoipa::path(
    get,
    path = "/session",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let sessions = state.opencode.sessions.lock().await;
    let mut values: Vec<OpenCodeSessionRecord> = sessions.values().cloned().collect();
    drop(sessions);
    values.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let response: Vec<Value> = values.into_iter().map(|s| s.to_value()).collect();
    (StatusCode::OK, Json(json!(response)))
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_get(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    _headers: HeaderMap,
    _query: Query<DirectoryQuery>,
) -> impl IntoResponse {
    let sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.get(&session_id) {
        return (StatusCode::OK, Json(session.to_value())).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    patch,
    path = "/session/{sessionID}",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = OpenCodeUpdateSessionRequest,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    Json(body): Json<OpenCodeUpdateSessionRequest>,
) -> impl IntoResponse {
    let now = state.opencode.now_ms();
    let updated = state
        .opencode
        .mutate_session(&session_id, |session| {
            if let Some(title) = body.title {
                session.title = title;
                session.updated_at = now;
            }
        })
        .await;
    if let Some(session) = updated {
        let value = session.to_value();
        state
            .opencode
            .emit_event(session_event("session.updated", &value));
        state.opencode.persist_sessions().await;
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    delete,
    path = "/session/{sessionID}",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_delete(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let mut sessions = state.opencode.sessions.lock().await;
    if let Some(session) = sessions.remove(&session_id) {
        drop(sessions);
        let mut messages = state.opencode.messages.lock().await;
        messages.remove(&session_id);
        drop(messages);
        let mut runtimes = state.opencode.session_runtime.lock().await;
        runtimes.remove(&session_id);
        drop(runtimes);
        let mut streams = state.opencode.session_streams.lock().await;
        streams.remove(&session_id);
        drop(streams);
        state
            .opencode
            .emit_event(session_event("session.deleted", &session.to_value()));
        state.opencode.persist_sessions().await;
        return bool_ok(true).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    get,
    path = "/session/status",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_status(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let sessions = state.opencode.sessions.lock().await;
    let mut status_map = serde_json::Map::new();
    for (id, session) in sessions.iter() {
        status_map.insert(
            id.clone(),
            json!({
                "type": session.status.status,
                "updated": session.status.updated_at,
            }),
        );
    }
    (StatusCode::OK, Json(Value::Object(status_map)))
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/abort",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_abort(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let updated = state
        .opencode
        .update_session_status(&session_id, "idle")
        .await;
    if updated.is_none() {
        return not_found("Session not found").into_response();
    }
    state.opencode.emit_event(json!({
        "type": "session.status",
        "properties": {"sessionID": session_id, "status": {"type": "idle"}}
    }));
    state.opencode.emit_event(json!({
        "type": "session.idle",
        "properties": {"sessionID": session_id}
    }));
    bool_ok(true).into_response()
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/children",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_children(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let sessions = state.opencode.sessions.lock().await;
    if !sessions.contains_key(&session_id) {
        return not_found("Session not found").into_response();
    }
    let mut children: Vec<OpenCodeSessionRecord> = sessions
        .values()
        .filter(|session| session.parent_id.as_deref() == Some(&session_id))
        .cloned()
        .collect();
    drop(sessions);
    children.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let response: Vec<Value> = children.into_iter().map(|s| s.to_value()).collect();
    (StatusCode::OK, Json(json!(response))).into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/init",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_init(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let _ = state.opencode.ensure_session(&session_id, directory).await;
    let _ = state
        .opencode
        .update_session_status(&session_id, "idle")
        .await;
    bool_ok(true).into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/fork",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_fork(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let now = state.opencode.now_ms();
    let parent = {
        let sessions = state.opencode.sessions.lock().await;
        sessions.get(&session_id).cloned()
    };
    let Some(parent) = parent else {
        return not_found("Session not found").into_response();
    };
    let (directory, project_id, title, version) = (
        parent.directory,
        parent.project_id,
        format!("Fork of {}", parent.title),
        parent.version,
    );
    let id = next_id("ses_", &SESSION_COUNTER);
    let slug = format!("session-{}", id);
    let record = OpenCodeSessionRecord {
        id: id.clone(),
        slug,
        project_id,
        directory,
        parent_id: Some(session_id),
        title,
        version,
        created_at: now,
        updated_at: now,
        share_url: None,
        status: OpenCodeSessionStatus {
            status: "idle".to_string(),
            updated_at: now,
        },
    };

    let value = record.to_value();
    let mut sessions = state.opencode.sessions.lock().await;
    sessions.insert(id.clone(), record);
    drop(sessions);

    state
        .opencode
        .emit_event(session_event("session.created", &value));
    state.opencode.persist_sessions().await;

    (StatusCode::OK, Json(value))
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/diff",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_diff(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let sessions = state.opencode.sessions.lock().await;
    if !sessions.contains_key(&session_id) {
        return not_found("Session not found").into_response();
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/summarize",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionSummarizeRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_summarize(
    Json(body): Json<SessionSummarizeRequest>,
) -> impl IntoResponse {
    if body.provider_id.is_none() || body.model_id.is_none() {
        return bad_request("providerID and modelID are required");
    }
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/message",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_messages(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let messages = state.opencode.messages.lock().await;
    let entries = messages.get(&session_id).cloned().unwrap_or_default();
    let values: Vec<Value> = entries
        .into_iter()
        .map(|record| json!({"info": record.info, "parts": record.parts}))
        .collect();
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/message",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionMessageRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_message_create(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionMessageRequest>,
) -> impl IntoResponse {
    if std::env::var("OPENCODE_COMPAT_LOG_BODY").is_ok() {
        tracing::info!(target = "sandbox_agent::opencode", ?body, "opencode prompt body");
    }
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let _ = state
        .opencode
        .ensure_session(&session_id, directory.clone())
        .await;
    let worktree = state.opencode.worktree_for(&directory);
    let agent_mode = normalize_agent_mode(body.agent.clone());
    let requested_provider = body
        .model
        .as_ref()
        .and_then(|v| v.get("providerID"))
        .and_then(|v| v.as_str());
    let requested_model = body
        .model
        .as_ref()
        .and_then(|v| v.get("modelID"))
        .and_then(|v| v.as_str());
    let (session_agent, provider_id, model_id) =
        resolve_session_agent(&state, &session_id, requested_provider, requested_model).await;

    let parts_input = body.parts.unwrap_or_default();
    if parts_input.is_empty() {
        return bad_request("parts are required").into_response();
    }

    let now = state.opencode.now_ms();
    let user_message_id = body
        .message_id
        .clone()
        .unwrap_or_else(|| next_id("msg_", &MESSAGE_COUNTER));

    state.opencode.emit_event(json!({
        "type": "session.status",
        "properties": {
            "sessionID": session_id,
            "status": {"type": "busy"}
        }
    }));
    let _ = state
        .opencode
        .update_session_status(&session_id, "busy")
        .await;

    let mut user_message = build_user_message(
        &session_id,
        &user_message_id,
        now,
        &agent_mode,
        &provider_id,
        &model_id,
    );
    if let Some(obj) = user_message.as_object_mut() {
        if let Some(time) = obj.get_mut("time").and_then(|v| v.as_object_mut()) {
            time.insert("completed".to_string(), json!(now));
        }
    }

    let parts: Vec<Value> = parts_input
        .iter()
        .map(|part| normalize_part(&session_id, &user_message_id, part))
        .collect();

    upsert_message_info(&state.opencode, &session_id, user_message.clone()).await;
    for part in &parts {
        upsert_message_part(&state.opencode, &session_id, &user_message_id, part.clone()).await;
    }

    state
        .opencode
        .emit_event(message_event("message.updated", &user_message));
    for part in &parts {
        state
            .opencode
            .emit_event(part_event("message.part.updated", part));
    }

    let _ = state
        .opencode
        .update_runtime(&session_id, |runtime| {
            runtime.last_user_message_id = Some(user_message_id.clone());
            runtime.last_agent = Some(agent_mode.clone());
            runtime.last_model_provider = Some(provider_id.clone());
            runtime.last_model_id = Some(model_id.clone());
        })
        .await;

    if let Err(err) = ensure_backing_session(&state, &session_id, &session_agent).await {
        tracing::warn!(
            target = "sandbox_agent::opencode",
            ?err,
            "failed to ensure backing session"
        );
    } else {
        ensure_session_stream(state.clone(), session_id.clone()).await;
    }

    let prompt_text = parts_input
        .iter()
        .find_map(|part| part.get("text").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    if !prompt_text.is_empty() {
        if let Err(err) = state
            .inner
            .session_manager()
            .send_message(session_id.clone(), prompt_text)
            .await
        {
            tracing::warn!(
                target = "sandbox_agent::opencode",
                ?err,
                "failed to send message to backing agent"
            );
        }
    }

    let assistant_message = build_assistant_message(
        &session_id,
        &format!("{user_message_id}_pending"),
        &user_message_id,
        now,
        &directory,
        &worktree,
        &agent_mode,
        &provider_id,
        &model_id,
    );

    (
        StatusCode::OK,
        Json(json!({
            "info": assistant_message,
            "parts": [],
        })),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/message/{messageID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("messageID" = String, Path, description = "Message ID")
    ),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_session_message_get(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, message_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let messages = state.opencode.messages.lock().await;
    if let Some(entries) = messages.get(&session_id) {
        if let Some(record) = entries.iter().find(|record| {
            record
                .info
                .get("id")
                .and_then(|v| v.as_str())
                .map(|id| id == message_id)
                .unwrap_or(false)
        }) {
            return (
                StatusCode::OK,
                Json(json!({
                    "info": record.info.clone(),
                    "parts": record.parts.clone()
                })),
            )
                .into_response();
        }
    }
    not_found("Message not found").into_response()
}

#[utoipa::path(
    patch,
    path = "/session/{sessionID}/message/{messageID}/part/{partID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("messageID" = String, Path, description = "Message ID"),
        ("partID" = String, Path, description = "Part ID")
    ),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_message_part_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, message_id, part_id)): Path<(String, String, String)>,
    Json(mut part_value): Json<Value>,
) -> impl IntoResponse {
    if let Some(obj) = part_value.as_object_mut() {
        obj.insert("id".to_string(), json!(part_id));
        obj.insert("sessionID".to_string(), json!(session_id));
        obj.insert("messageID".to_string(), json!(message_id));
    }

    state
        .opencode
        .emit_event(part_event("message.part.updated", &part_value));

    (StatusCode::OK, Json(part_value))
}

#[utoipa::path(
    delete,
    path = "/session/{sessionID}/message/{messageID}/part/{partID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("messageID" = String, Path, description = "Message ID"),
        ("partID" = String, Path, description = "Part ID")
    ),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_message_part_delete(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, message_id, part_id)): Path<(String, String, String)>,
) -> impl IntoResponse {
    let part_value = json!({
        "id": part_id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "text",
        "text": "",
    });
    state
        .opencode
        .emit_event(part_event("message.part.removed", &part_value));
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/prompt_async",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionMessageRequest,
    responses((status = 204)),
    tag = "opencode"
)]
async fn oc_session_prompt_async(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionMessageRequest>,
) -> impl IntoResponse {
    let _ = oc_session_message_create(
        State(state),
        Path(session_id),
        headers,
        Query(query),
        Json(body),
    )
    .await;
    StatusCode::NO_CONTENT
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/command",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionCommandRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_command(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionCommandRequest>,
) -> impl IntoResponse {
    if body.command.is_none() || body.arguments.is_none() {
        return bad_request("command and arguments are required").into_response();
    }
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let assistant_message_id = next_id("msg_", &MESSAGE_COUNTER);
    let agent = normalize_agent_mode(body.agent.clone());
    let assistant_message = build_assistant_message(
        &session_id,
        &assistant_message_id,
        "msg_parent",
        now,
        &directory,
        &worktree,
        &agent,
        OPENCODE_PROVIDER_ID,
        OPENCODE_DEFAULT_MODEL_ID,
    );

    (
        StatusCode::OK,
        Json(json!({
            "info": assistant_message,
            "parts": [],
        })),
    )
        .into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/shell",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = SessionShellRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_shell(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<SessionShellRequest>,
) -> impl IntoResponse {
    if body.command.is_none() || body.agent.is_none() {
        return bad_request("agent and command are required").into_response();
    }
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let worktree = state.opencode.worktree_for(&directory);
    let now = state.opencode.now_ms();
    let assistant_message_id = next_id("msg_", &MESSAGE_COUNTER);
    let assistant_message = build_assistant_message(
        &session_id,
        &assistant_message_id,
        "msg_parent",
        now,
        &directory,
        &worktree,
        &normalize_agent_mode(body.agent.clone()),
        body.model
            .as_ref()
            .and_then(|v| v.get("providerID"))
            .and_then(|v| v.as_str())
            .unwrap_or(OPENCODE_PROVIDER_ID),
        body.model
            .as_ref()
            .and_then(|v| v.get("modelID"))
            .and_then(|v| v.as_str())
            .unwrap_or(OPENCODE_DEFAULT_MODEL_ID),
    );
    (StatusCode::OK, Json(assistant_message)).into_response()
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/revert",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_revert(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let now = state.opencode.now_ms();
    let updated = state
        .opencode
        .mutate_session(&session_id, |session| {
            session.version = bump_version(&session.version);
            session.updated_at = now;
        })
        .await;
    if let Some(session) = updated {
        let value = session.to_value();
        state
            .opencode
            .emit_event(session_event("session.updated", &value));
        state.opencode.persist_sessions().await;
        return (StatusCode::OK, Json(value)).into_response();
    }
    oc_session_get(State(state), Path(session_id), headers, Query(query)).await
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/unrevert",
    params(("sessionID" = String, Path, description = "Session ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_unrevert(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
) -> impl IntoResponse {
    let now = state.opencode.now_ms();
    let updated = state
        .opencode
        .mutate_session(&session_id, |session| {
            session.version = bump_version(&session.version);
            session.updated_at = now;
        })
        .await;
    if let Some(session) = updated {
        let value = session.to_value();
        state
            .opencode
            .emit_event(session_event("session.updated", &value));
        state.opencode.persist_sessions().await;
        return (StatusCode::OK, Json(value)).into_response();
    }
    oc_session_get(State(state), Path(session_id), headers, Query(query)).await
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/permissions/{permissionID}",
    params(
        ("sessionID" = String, Path, description = "Session ID"),
        ("permissionID" = String, Path, description = "Permission ID")
    ),
    request_body = PermissionReplyRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_permission_reply(
    State(state): State<Arc<OpenCodeAppState>>,
    Path((session_id, permission_id)): Path<(String, String)>,
    Json(body): Json<PermissionReplyRequest>,
) -> impl IntoResponse {
    let reply = match parse_permission_reply_value(body.response.as_deref()) {
        Ok(reply) => reply,
        Err(message) => return bad_request(&message).into_response(),
    };
    match state
        .inner
        .session_manager()
        .reply_permission(&session_id, &permission_id, reply)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/session/{sessionID}/share",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_share(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let now = state.opencode.now_ms();
    let updated = state
        .opencode
        .mutate_session(&session_id, |session| {
            session.share_url = Some(format!("https://share.local/{}", session_id));
            session.updated_at = now;
        })
        .await;
    if let Some(session) = updated {
        let value = session.to_value();
        state
            .opencode
            .emit_event(session_event("session.updated", &value));
        state.opencode.persist_sessions().await;
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    delete,
    path = "/session/{sessionID}/share",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_unshare(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let now = state.opencode.now_ms();
    let updated = state
        .opencode
        .mutate_session(&session_id, |session| {
            session.share_url = None;
            session.updated_at = now;
        })
        .await;
    if let Some(session) = updated {
        let value = session.to_value();
        state
            .opencode
            .emit_event(session_event("session.updated", &value));
        state.opencode.persist_sessions().await;
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("Session not found").into_response()
}

#[utoipa::path(
    get,
    path = "/session/{sessionID}/todo",
    params(("sessionID" = String, Path, description = "Session ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_session_todo(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    let sessions = state.opencode.sessions.lock().await;
    if !sessions.contains_key(&session_id) {
        return not_found("Session not found").into_response();
    }
    (StatusCode::OK, Json(json!([]))).into_response()
}

#[utoipa::path(
    get,
    path = "/permission",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_permission_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let pending = state.inner.session_manager().list_pending_permissions().await;
    let mut values = Vec::new();
    for item in pending {
        let record = OpenCodePermissionRecord {
            id: item.permission_id,
            session_id: item.session_id,
            permission: item.action,
            patterns: patterns_from_metadata(&item.metadata),
            metadata: item.metadata.unwrap_or_else(|| json!({})),
            always: Vec::new(),
            tool: None,
        };
        values.push(record.to_value());
    }
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
        a_id.cmp(b_id)
    });
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/permission/{requestID}/reply",
    params(("requestID" = String, Path, description = "Permission request ID")),
    request_body = PermissionGlobalReplyRequest,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_permission_reply(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(request_id): Path<String>,
    Json(body): Json<PermissionGlobalReplyRequest>,
) -> impl IntoResponse {
    let reply = match parse_permission_reply_value(body.reply.as_deref()) {
        Ok(reply) => reply,
        Err(message) => return bad_request(&message).into_response(),
    };
    let session_id = state
        .inner
        .session_manager()
        .list_pending_permissions()
        .await
        .into_iter()
        .find(|item| item.permission_id == request_id)
        .map(|item| item.session_id);
    let Some(session_id) = session_id else {
        return not_found("Permission request not found").into_response();
    };
    match state
        .inner
        .session_manager()
        .reply_permission(&session_id, &request_id, reply)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/question",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_question_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let pending = state.inner.session_manager().list_pending_questions().await;
    let mut values = Vec::new();
    for item in pending {
        let options: Vec<Value> = item
            .options
            .iter()
            .map(|option| json!({"label": option, "description": ""}))
            .collect();
        let record = OpenCodeQuestionRecord {
            id: item.question_id,
            session_id: item.session_id,
            questions: vec![json!({
                "header": "Question",
                "question": item.prompt,
                "options": options,
            })],
            tool: None,
        };
        values.push(record.to_value());
    }
    values.sort_by(|a, b| {
        let a_id = a.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
        a_id.cmp(b_id)
    });
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/question/{requestID}/reply",
    params(("requestID" = String, Path, description = "Question request ID")),
    request_body = QuestionReplyBody,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_question_reply(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(request_id): Path<String>,
    Json(body): Json<QuestionReplyBody>,
) -> impl IntoResponse {
    let session_id = state
        .inner
        .session_manager()
        .list_pending_questions()
        .await
        .into_iter()
        .find(|item| item.question_id == request_id)
        .map(|item| item.session_id);
    let Some(session_id) = session_id else {
        return not_found("Question request not found").into_response();
    };
    let answers = body.answers.unwrap_or_default();
    match state
        .inner
        .session_manager()
        .reply_question(&session_id, &request_id, answers)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/question/{requestID}/reject",
    params(("requestID" = String, Path, description = "Question request ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_question_reject(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(request_id): Path<String>,
) -> impl IntoResponse {
    let session_id = state
        .inner
        .session_manager()
        .list_pending_questions()
        .await
        .into_iter()
        .find(|item| item.question_id == request_id)
        .map(|item| item.session_id);
    let Some(session_id) = session_id else {
        return not_found("Question request not found").into_response();
    };
    match state
        .inner
        .session_manager()
        .reject_question(&session_id, &request_id)
        .await
    {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/provider",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_list() -> impl IntoResponse {
    let mut models = serde_json::Map::new();
    for agent in available_agent_ids() {
        models.insert(agent.as_str().to_string(), model_summary_entry(agent));
    }
    let providers = json!({
        "all": [
            {
                "id": OPENCODE_PROVIDER_ID,
                "name": OPENCODE_PROVIDER_NAME,
                "env": [],
                "models": Value::Object(models),
            }
        ],
        "default": {
            OPENCODE_PROVIDER_ID: OPENCODE_DEFAULT_MODEL_ID
        },
        "connected": [OPENCODE_PROVIDER_ID]
    });
    (StatusCode::OK, Json(providers))
}

#[utoipa::path(
    get,
    path = "/provider/auth",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_auth() -> impl IntoResponse {
    let auth = json!({
        OPENCODE_PROVIDER_ID: []
    });
    (StatusCode::OK, Json(auth))
}


#[utoipa::path(
    post,
    path = "/provider/{providerID}/oauth/authorize",
    params(("providerID" = String, Path, description = "Provider ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_oauth_authorize(Path(provider_id): Path<String>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({
            "url": format!("https://auth.local/{}/authorize", provider_id),
            "method": "auto",
            "instructions": "stub",
        })),
    )
}

#[utoipa::path(
    post,
    path = "/provider/{providerID}/oauth/callback",
    params(("providerID" = String, Path, description = "Provider ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_provider_oauth_callback(Path(_provider_id): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    put,
    path = "/auth/{providerID}",
    params(("providerID" = String, Path, description = "Provider ID")),
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_auth_set(Path(_provider_id): Path<String>, Json(_body): Json<Value>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    delete,
    path = "/auth/{providerID}",
    params(("providerID" = String, Path, description = "Provider ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_auth_remove(Path(_provider_id): Path<String>) -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/pty",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_pty_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let ptys = state.inner.session_manager().pty_manager().list().await;
    let values: Vec<Value> = ptys.iter().map(pty_to_value).collect();
    (StatusCode::OK, Json(json!(values)))
}

#[utoipa::path(
    post,
    path = "/pty",
    request_body = PtyCreateRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_pty_create(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    Json(body): Json<PtyCreateRequest>,
) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    let id = next_id("pty_", &PTY_COUNTER);
    let owner_session_id = headers
        .get("x-opencode-session")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let options = PtyCreateOptions {
        id: id.clone(),
        title: body.title.unwrap_or_else(|| "PTY".to_string()),
        command: body.command.unwrap_or_else(|| "bash".to_string()),
        args: body.args.unwrap_or_default(),
        cwd: body.cwd.unwrap_or_else(|| directory),
        env: body.env.unwrap_or_default(),
        owner_session_id,
    };
    let record = match state
        .inner
        .session_manager()
        .pty_manager()
        .create(options)
        .await
    {
        Ok(record) => record,
        Err(err) => return internal_error(&err.to_string()).into_response(),
    };
    let value = pty_to_value(&record);

    state
        .opencode
        .emit_event(json!({"type": "pty.created", "properties": {"info": value}}));

    (StatusCode::OK, Json(value))
}

#[utoipa::path(
    get,
    path = "/pty/{ptyID}",
    params(("ptyID" = String, Path, description = "Pty ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_pty_get(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
) -> impl IntoResponse {
    if let Some(pty) = state
        .inner
        .session_manager()
        .pty_manager()
        .get(&pty_id)
        .await
    {
        return (StatusCode::OK, Json(pty_to_value(&pty))).into_response();
    }
    not_found("PTY not found").into_response()
}

#[utoipa::path(
    put,
    path = "/pty/{ptyID}",
    params(("ptyID" = String, Path, description = "Pty ID")),
    request_body = PtyUpdateRequest,
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_pty_update(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
    Json(body): Json<PtyUpdateRequest>,
) -> impl IntoResponse {
    let options = PtyUpdateOptions {
        title: body.title,
        size: body.size.map(|size| PtySizeSpec {
            rows: size.rows,
            cols: size.cols,
        }),
    };
    let updated = match state
        .inner
        .session_manager()
        .pty_manager()
        .update(&pty_id, options)
        .await
    {
        Ok(updated) => updated,
        Err(err) => return internal_error(&err.to_string()).into_response(),
    };
    if let Some(pty) = updated {
        let value = pty_to_value(&pty);
        state
            .opencode
            .emit_event(json!({"type": "pty.updated", "properties": {"info": value}}));
        return (StatusCode::OK, Json(value)).into_response();
    }
    not_found("PTY not found").into_response()
}

#[utoipa::path(
    delete,
    path = "/pty/{ptyID}",
    params(("ptyID" = String, Path, description = "Pty ID")),
    responses((status = 200), (status = 404)),
    tag = "opencode"
)]
async fn oc_pty_delete(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
) -> impl IntoResponse {
    if state
        .inner
        .session_manager()
        .pty_manager()
        .remove(&pty_id)
        .await
        .is_some()
    {
        state
            .opencode
            .emit_event(json!({"type": "pty.deleted", "properties": {"id": pty_id}}));
        return bool_ok(true).into_response();
    }
    not_found("PTY not found").into_response()
}

#[utoipa::path(
    get,
    path = "/pty/{ptyID}/connect",
    params(("ptyID" = String, Path, description = "Pty ID")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_pty_connect(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(pty_id): Path<String>,
    ws: Option<WebSocketUpgrade>,
) -> impl IntoResponse {
    let io = match state
        .inner
        .session_manager()
        .pty_manager()
        .connect(&pty_id)
        .await
    {
        Some(io) => io,
        None => return not_found("PTY not found").into_response(),
    };

    if let Some(ws) = ws {
        return ws.on_upgrade(move |socket| handle_pty_socket(socket, io)).into_response();
    }

    let stream = ReceiverStream::new(io.output).map(|chunk| {
        let text = String::from_utf8_lossy(&chunk).to_string();
        Ok::<Event, Infallible>(Event::default().data(text))
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

async fn handle_pty_socket(socket: WebSocket, io: PtyIo) {
    let (mut sender, mut receiver) = socket.split();
    let mut output_rx = io.output;
    let input_tx = io.input;

    let output_task = tokio::spawn(async move {
        while let Some(chunk) = output_rx.recv().await {
            let text = String::from_utf8_lossy(&chunk).to_string();
            if sender.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let input_task = tokio::spawn(async move {
        while let Some(message) = receiver.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    if input_tx.send(text.into_bytes()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Binary(bytes)) => {
                    if input_tx.send(bytes).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                Err(_) => break,
            }
        }
    });

    let _ = tokio::join!(output_task, input_task);
}

#[utoipa::path(
    get,
    path = "/file",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_file_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/file/content",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_file_content(Query(query): Query<FileContentQuery>) -> impl IntoResponse {
    if query.path.is_none() {
        return bad_request("path is required").into_response();
    }
    (
        StatusCode::OK,
        Json(json!({
            "type": "text",
            "content": "",
        })),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/file/status",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_file_status() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([]))).into_response()
}

fn parse_find_limit(limit: Option<usize>) -> Result<usize, (StatusCode, Json<Value>)> {
    let limit = limit.unwrap_or(FIND_MAX_RESULTS);
    if limit == 0 || limit > FIND_MAX_RESULTS {
        return Err(bad_request("limit must be between 1 and 200"));
    }
    Ok(limit)
}

fn resolve_find_root(
    state: &OpenCodeAppState,
    headers: &HeaderMap,
    directory: Option<&String>,
) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    let directory = state.opencode.directory_for(headers, directory);
    let root = PathBuf::from(directory);
    let root = root
        .canonicalize()
        .map_err(|_| bad_request("directory not found"))?;
    if !root.is_dir() {
        return Err(bad_request("directory not found"));
    }
    Ok(root)
}

fn normalize_path(path: &FsPath) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn opencode_symbol_kind(kind: &str) -> u32 {
    match kind {
        "class" => 5,
        "interface" | "trait" => 11,
        "struct" => 23,
        "enum" => 10,
        "function" => 12,
        _ => 12,
    }
}

fn has_wildcards(query: &str) -> bool {
    query.contains('*') || query.contains('?')
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let mut pattern_index = 0;
    let mut text_index = 0;
    let mut star_index: Option<usize> = None;
    let mut match_index = 0;

    while text_index < text.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == text[text_index])
        {
            pattern_index += 1;
            text_index += 1;
            continue;
        }

        if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            match_index = text_index;
            pattern_index += 1;
            continue;
        }

        if let Some(star) = star_index {
            pattern_index = star + 1;
            match_index += 1;
            text_index = match_index;
            continue;
        }

        return false;
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }

    pattern_index == pattern.len()
}

fn matches_find_query(candidate: &str, query: &str, use_wildcards: bool) -> bool {
    if use_wildcards {
        return wildcard_match(query, candidate);
    }
    candidate.contains(query)
}

fn parse_find_entry_type(
    entry_type: Option<&str>,
    dirs: Option<bool>,
) -> Result<(bool, bool), (StatusCode, Json<Value>)> {
    match entry_type {
        Some("file") => Ok((true, false)),
        Some("directory") => Ok((false, true)),
        Some(_) => Err(bad_request("type must be file or directory")),
        None => Ok((true, dirs.unwrap_or(false))),
    }
}

fn find_files_in_root(
    root: &FsPath,
    query: &str,
    include_files: bool,
    include_dirs: bool,
    limit: usize,
) -> Vec<String> {
    let mut results = Vec::new();
    let mut queue = VecDeque::new();
    let query_lower = query.to_ascii_lowercase();
    let use_wildcards = has_wildcards(&query_lower);

    queue.push_back(root.to_path_buf());

    while let Some(dir) = queue.pop_front() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            let file_name_lower = file_name.to_ascii_lowercase();

            if path.is_dir() {
                if FIND_IGNORE_DIRS.iter().any(|name| *name == file_name) {
                    continue;
                }
                queue.push_back(path.clone());
            }

            let is_file = path.is_file();
            let is_dir = path.is_dir();
            if (is_file && !include_files) || (is_dir && !include_dirs) {
                continue;
            }

            let relative = path.strip_prefix(root).unwrap_or(&path);
            let relative_text = normalize_path(relative);
            if relative_text.is_empty() {
                continue;
            }
            let relative_lower = relative_text.to_ascii_lowercase();

            if matches_find_query(&relative_lower, &query_lower, use_wildcards)
                || matches_find_query(&file_name_lower, &query_lower, use_wildcards)
            {
                results.push(relative_text);
                if results.len() >= limit {
                    return results;
                }
            }
        }
    }

    results
}

async fn rg_matches(
    root: &FsPath,
    pattern: &str,
    limit: usize,
    case_sensitive: Option<bool>,
) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let mut command = Command::new("rg");
    command
        .arg("--json")
        .arg("--line-number")
        .arg("--byte-offset")
        .arg("--with-filename")
        .arg("--max-count")
        .arg(limit.to_string());
    if case_sensitive == Some(false) {
        command.arg("--ignore-case");
    }
    command.arg(pattern);
    command.current_dir(root);

    let output = command
        .output()
        .await
        .map_err(|_| internal_error("ripgrep failed"))?;
    if !output.status.success() {
        if output.status.code() != Some(1) {
            return Err(internal_error("ripgrep failed"));
        }
    }

    let mut results = Vec::new();
    for line in output.stdout.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_slice(line)
            .map_err(|_| internal_error("invalid ripgrep output"))?;
        if value.get("type").and_then(|v| v.as_str()) != Some("match") {
            continue;
        }
        if let Some(data) = value.get("data") {
            results.push(data.clone());
            if results.len() >= limit {
                break;
            }
        }
    }

    Ok(results)
}

fn symbol_from_match(root: &FsPath, data: &Value) -> Option<Value> {
    let path_text = data
        .get("path")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())?;
    let line_number = data.get("line_number").and_then(|v| v.as_u64())?;
    let submatch = data
        .get("submatches")
        .and_then(|v| v.as_array())
        .and_then(|v| v.first())?;
    let match_text = submatch
        .get("match")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())?;
    let start = submatch.get("start").and_then(|v| v.as_u64())?;
    let end = submatch.get("end").and_then(|v| v.as_u64())?;

    let path = FsPath::new(path_text);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let uri = format!("file://{}", normalize_path(&absolute));
    let line = line_number.saturating_sub(1);

    Some(json!({
        "name": match_text,
        "kind": 12,
        "location": {
            "uri": uri,
            "range": {
                "start": {"line": line, "character": start},
                "end": {"line": line, "character": end}
            }
        }
    }))
}

async fn rg_symbols(
    root: &FsPath,
    query: &str,
    limit: usize,
) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let matches = rg_matches(root, query, limit, None).await?;
    let mut symbols = Vec::new();
    for data in matches {
        if let Some(symbol) = symbol_from_match(root, &data) {
            symbols.push(symbol);
            if symbols.len() >= limit {
                break;
            }
        }
    }
    Ok(symbols)
}

#[utoipa::path(
    get,
    path = "/find",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_find_text(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<FindTextQuery>,
) -> impl IntoResponse {
    let pattern = match query.pattern.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => value,
        None => return bad_request("pattern is required").into_response(),
    };
    let limit = match query.limit {
        Some(value) if value == 0 || value > 200 => {
            return bad_request("limit must be between 1 and 200").into_response();
        }
        Some(value) => Some(value),
        None => None,
    };
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    match state
        .inner
        .session_manager()
        .find_text(&directory, pattern, query.case_sensitive, limit)
        .await
    {
        Ok(results) => (StatusCode::OK, Json(results)).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/find/file",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_find_files(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<FindFilesQuery>,
) -> impl IntoResponse {
    let query_value = match query.query.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => value,
        None => return bad_request("query is required").into_response(),
    };
    let kind = match query.entry_type.as_deref() {
        Some("file") => FindFileKind::File,
        Some("directory") => FindFileKind::Directory,
        Some(_) => return bad_request("type must be file or directory").into_response(),
        None => {
            if query.dirs.unwrap_or(false) {
                FindFileKind::Any
            } else {
                FindFileKind::File
            }
        }
    };
    let limit = query.limit.unwrap_or(200).min(200).max(1);
    let options = FindFileOptions {
        kind,
        case_sensitive: false,
        limit: Some(limit),
    };
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    match state
        .inner
        .session_manager()
        .find_files(&directory, query_value, options)
        .await
    {
        Ok(results) => (StatusCode::OK, Json(results)).into_response(),
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/find/symbol",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_find_symbols(
    State(state): State<Arc<OpenCodeAppState>>,
    headers: HeaderMap,
    Query(query): Query<FindSymbolsQuery>,
) -> impl IntoResponse {
    let query_value = match query.query.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => value,
        None => return bad_request("query is required").into_response(),
    };
    let limit = match query.limit {
        Some(value) if value == 0 || value > 200 => {
            return bad_request("limit must be between 1 and 200").into_response();
        }
        Some(value) => Some(value),
        None => None,
    };
    let directory = state.opencode.directory_for(&headers, query.directory.as_ref());
    match state
        .inner
        .session_manager()
        .find_symbols(&directory, query_value, limit)
        .await
    {
        Ok(results) => {
            let root = PathBuf::from(&directory);
            let symbols: Vec<Value> = results
                .into_iter()
                .map(|symbol| {
                    let path = PathBuf::from(&symbol.path);
                    let absolute = if path.is_absolute() { path } else { root.join(&symbol.path) };
                    let uri = format!("file://{}", normalize_path(&absolute));
                    json!({
                        "name": symbol.name,
                        "kind": opencode_symbol_kind(&symbol.kind),
                        "location": {
                            "uri": uri,
                            "range": {
                                "start": {"line": symbol.line.saturating_sub(1), "character": symbol.column.saturating_sub(1)},
                                "end": {"line": symbol.line.saturating_sub(1), "character": symbol.column.saturating_sub(1)}
                            }
                        }
                    })
                })
                .collect();
            (StatusCode::OK, Json(symbols)).into_response()
        }
        Err(err) => sandbox_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/mcp",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_list(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let statuses = state.inner.session_manager().mcp_statuses().await;
    let mut map = serde_json::Map::new();
    for (name, status) in statuses {
        map.insert(name, status.to_value());
    }
    (StatusCode::OK, Json(Value::Object(map)))
}

#[utoipa::path(
    post,
    path = "/mcp",
    request_body = OpenCodeMcpRegisterRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_register(
    State(state): State<Arc<OpenCodeAppState>>,
    Json(body): Json<OpenCodeMcpRegisterRequest>,
) -> impl IntoResponse {
    match state
        .inner
        .session_manager()
        .mcp_register(body.name, body.config)
        .await
    {
        Ok(statuses) => {
            let mut map = serde_json::Map::new();
            for (name, status) in statuses {
                map.insert(name, status.to_value());
            }
            (StatusCode::OK, Json(Value::Object(map))).into_response()
        }
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/auth",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_auth(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(name): Path<String>,
    _body: Option<Json<Value>>,
) -> impl IntoResponse {
    match state.inner.session_manager().mcp_auth_start(&name).await {
        Ok(url) => (
            StatusCode::OK,
            Json(json!({"authorizationUrl": url})),
        )
            .into_response(),
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    delete,
    path = "/mcp/{name}/auth",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_auth_remove(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.inner.session_manager().mcp_auth_remove(&name).await {
        Ok(_) => (StatusCode::OK, Json(json!({"success": true}))).into_response(),
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/auth/callback",
    params(("name" = String, Path, description = "MCP server name")),
    request_body = OpenCodeMcpAuthCallbackRequest,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_auth_callback(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(name): Path<String>,
    Json(body): Json<OpenCodeMcpAuthCallbackRequest>,
) -> impl IntoResponse {
    match state
        .inner
        .session_manager()
        .mcp_auth_callback(&name, body.code)
        .await
    {
        Ok(status) => (StatusCode::OK, Json(status.to_value())).into_response(),
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/auth/authenticate",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_authenticate(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(name): Path<String>,
    _body: Option<Json<Value>>,
) -> impl IntoResponse {
    match state.inner.session_manager().mcp_auth_authenticate(&name).await {
        Ok(status) => (StatusCode::OK, Json(status.to_value())).into_response(),
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/connect",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_connect(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.inner.session_manager().mcp_connect(&name).await {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/mcp/{name}/disconnect",
    params(("name" = String, Path, description = "MCP server name")),
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_mcp_disconnect(
    State(state): State<Arc<OpenCodeAppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.inner.session_manager().mcp_disconnect(&name).await {
        Ok(_) => bool_ok(true).into_response(),
        Err(err) => mcp_error_response(err).into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/experimental/tool/ids",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tool_ids(State(state): State<Arc<OpenCodeAppState>>) -> impl IntoResponse {
    let tool_ids = state.inner.session_manager().mcp_tool_ids().await;
    (StatusCode::OK, Json(json!(tool_ids)))
}

#[utoipa::path(
    get,
    path = "/experimental/tool",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tool_list(
    State(state): State<Arc<OpenCodeAppState>>,
    Query(query): Query<ToolQuery>,
) -> impl IntoResponse {
    if query.provider.is_none() || query.model.is_none() {
        return bad_request("provider and model are required").into_response();
    }
    let tools = state.inner.session_manager().mcp_tools().await;
    let values: Vec<Value> = tools.into_iter().map(|tool| tool.to_tool_list_item()).collect();
    (StatusCode::OK, Json(json!(values))).into_response()
}

#[utoipa::path(
    get,
    path = "/experimental/resource",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_resource_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({})))
}

#[utoipa::path(
    get,
    path = "/experimental/worktree",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_list(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    (StatusCode::OK, Json(json!([worktree])))
}

#[utoipa::path(
    post,
    path = "/experimental/worktree",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_create(State(state): State<Arc<OpenCodeAppState>>, headers: HeaderMap) -> impl IntoResponse {
    let directory = state.opencode.directory_for(&headers, None);
    let worktree = state.opencode.worktree_for(&directory);
    (
        StatusCode::OK,
        Json(json!({
            "name": "worktree",
            "branch": state.opencode.branch_name(),
            "directory": worktree,
        })),
    )
}

#[utoipa::path(
    delete,
    path = "/experimental/worktree",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_delete() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/experimental/worktree/reset",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_worktree_reset() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    get,
    path = "/skill",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_skill_list() -> impl IntoResponse {
    (StatusCode::OK, Json(json!([])))
}

#[utoipa::path(
    get,
    path = "/tui/control/next",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_next() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({"path": "", "body": {}})))
}

#[utoipa::path(
    post,
    path = "/tui/control/response",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_response() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/append-prompt",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_append_prompt() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/open-help",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_help() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/open-sessions",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_sessions() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/open-themes",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_themes() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/open-models",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_open_models() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/submit-prompt",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_submit_prompt() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/clear-prompt",
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_clear_prompt() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/execute-command",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_execute_command() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/show-toast",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_show_toast() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/publish",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_publish() -> impl IntoResponse {
    bool_ok(true)
}

#[utoipa::path(
    post,
    path = "/tui/select-session",
    request_body = String,
    responses((status = 200)),
    tag = "opencode"
)]
async fn oc_tui_select_session() -> impl IntoResponse {
    bool_ok(true)
}

#[derive(OpenApi)]
#[openapi(
    paths(
        oc_agent_list,
        oc_command_list,
        oc_config_get,
        oc_config_patch,
        oc_config_providers,
        oc_event_subscribe,
        oc_global_event,
        oc_global_health,
        oc_global_config_get,
        oc_global_config_patch,
        oc_global_dispose,
        oc_instance_dispose,
        oc_log,
        oc_lsp_status,
        oc_formatter_status,
        oc_path,
        oc_vcs,
        oc_project_list,
        oc_project_current,
        oc_project_update,
        oc_session_create,
        oc_session_list,
        oc_session_get,
        oc_session_update,
        oc_session_delete,
        oc_session_status,
        oc_session_abort,
        oc_session_children,
        oc_session_init,
        oc_session_fork,
        oc_session_diff,
        oc_session_summarize,
        oc_session_messages,
        oc_session_message_create,
        oc_session_message_get,
        oc_message_part_update,
        oc_message_part_delete,
        oc_session_prompt_async,
        oc_session_command,
        oc_session_shell,
        oc_session_revert,
        oc_session_unrevert,
        oc_session_permission_reply,
        oc_session_share,
        oc_session_unshare,
        oc_session_todo,
        oc_permission_list,
        oc_permission_reply,
        oc_question_list,
        oc_question_reply,
        oc_question_reject,
        oc_provider_list,
        oc_provider_auth,
        oc_provider_oauth_authorize,
        oc_provider_oauth_callback,
        oc_auth_set,
        oc_auth_remove,
        oc_pty_list,
        oc_pty_create,
        oc_pty_get,
        oc_pty_update,
        oc_pty_delete,
        oc_pty_connect,
        oc_file_list,
        oc_file_content,
        oc_file_status,
        oc_find_text,
        oc_find_files,
        oc_find_symbols,
        oc_mcp_list,
        oc_mcp_register,
        oc_mcp_auth,
        oc_mcp_auth_remove,
        oc_mcp_auth_callback,
        oc_mcp_authenticate,
        oc_mcp_connect,
        oc_mcp_disconnect,
        oc_tool_ids,
        oc_tool_list,
        oc_resource_list,
        oc_worktree_list,
        oc_worktree_create,
        oc_worktree_delete,
        oc_worktree_reset,
        oc_skill_list,
        oc_tui_next,
        oc_tui_response,
        oc_tui_append_prompt,
        oc_tui_open_help,
        oc_tui_open_sessions,
        oc_tui_open_themes,
        oc_tui_open_models,
        oc_tui_submit_prompt,
        oc_tui_clear_prompt,
        oc_tui_execute_command,
        oc_tui_show_toast,
        oc_tui_publish,
        oc_tui_select_session
    ),
    components(schemas(
        OpenCodeCreateSessionRequest,
        OpenCodeUpdateSessionRequest,
        SessionMessageRequest,
        SessionCommandRequest,
        SessionShellRequest,
        SessionSummarizeRequest,
        PermissionReplyRequest,
        PermissionGlobalReplyRequest,
        QuestionReplyBody,
        PtyCreateRequest,
        PtySizeRequest,
        PtyUpdateRequest
    )),
    tags((name = "opencode", description = "OpenCode compatibility API"))
)]
pub struct OpenCodeApiDoc;
