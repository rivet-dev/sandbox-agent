use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use base64::Engine;
use futures::{stream, StreamExt};
use reqwest::Client;
use sandbox_agent_error::{AgentError, ErrorType, ProblemDetails, SandboxError};
use sandbox_agent_universal_agent_schema::{
    codex as codex_schema, convert_amp, convert_claude, convert_codex, convert_opencode,
    AgentUnparsedData, ContentPart, ErrorData, EventConversion, EventSource, FileAction,
    ItemDeltaData, ItemEventData, ItemKind, ItemRole, ItemStatus, PermissionEventData,
    PermissionStatus, QuestionEventData, QuestionStatus, ReasoningVisibility, SessionEndReason,
    SessionEndedData, SessionStartedData, StderrOutput, TerminatedBy, UniversalEvent,
    UniversalEventData, UniversalEventType, UniversalItem,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::time::sleep;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::trace::TraceLayer;
use tracing::Span;
use utoipa::{Modify, OpenApi, ToSchema};

use crate::agent_server_logs::AgentServerLogs;
use crate::opencode_compat::{build_opencode_router, OpenCodeAppState};
use crate::telemetry;
use crate::ui;
use sandbox_agent_agent_management::agents::{
    AgentError as ManagerError, AgentId, AgentManager, InstallOptions, SpawnOptions, StreamingSpawn,
};
use sandbox_agent_agent_management::credentials::{
    extract_all_credentials, AuthType, CredentialExtractionOptions, ExtractedCredentials,
    ProviderCredentials,
};

const MOCK_EVENT_DELAY_MS: u64 = 200;
static USER_MESSAGE_COUNTER: AtomicU64 = AtomicU64::new(1);
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models?beta=true";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug)]
pub struct AppState {
    auth: AuthConfig,
    agent_manager: Arc<AgentManager>,
    session_manager: Arc<SessionManager>,
}

impl AppState {
    pub fn new(auth: AuthConfig, agent_manager: AgentManager) -> Self {
        let agent_manager = Arc::new(agent_manager);
        let session_manager = Arc::new(SessionManager::new(agent_manager.clone()));
        session_manager
            .server_manager
            .set_owner(Arc::downgrade(&session_manager));
        Self {
            auth,
            agent_manager,
            session_manager,
        }
    }

    pub(crate) fn session_manager(&self) -> Arc<SessionManager> {
        self.session_manager.clone()
    }
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub token: Option<String>,
}

impl AuthConfig {
    pub fn disabled() -> Self {
        Self { token: None }
    }

    pub fn with_token(token: String) -> Self {
        Self { token: Some(token) }
    }
}

pub fn build_router(state: AppState) -> Router {
    build_router_with_state(Arc::new(state)).0
}

pub fn build_router_with_state(shared: Arc<AppState>) -> (Router, Arc<AppState>) {
    let mut v1_router = Router::new()
        .route("/health", get(get_health))
        .route("/agents", get(list_agents))
        .route("/agents/:agent/install", post(install_agent))
        .route("/agents/:agent/modes", get(get_agent_modes))
        .route("/agents/:agent/models", get(get_agent_models))
        .route("/sessions", get(list_sessions))
        .route("/sessions/:session_id", post(create_session))
        .route("/sessions/:session_id/messages", post(post_message))
        .route(
            "/sessions/:session_id/messages/stream",
            post(post_message_stream),
        )
        .route("/sessions/:session_id/terminate", post(terminate_session))
        .route("/sessions/:session_id/events", get(get_events))
        .route("/sessions/:session_id/events/sse", get(get_events_sse))
        .route(
            "/sessions/:session_id/questions/:question_id/reply",
            post(reply_question),
        )
        .route(
            "/sessions/:session_id/questions/:question_id/reject",
            post(reject_question),
        )
        .route(
            "/sessions/:session_id/permissions/:permission_id/reply",
            post(reply_permission),
        )
        .with_state(shared.clone());

    if shared.auth.token.is_some() {
        v1_router = v1_router.layer(axum::middleware::from_fn_with_state(
            shared.clone(),
            require_token,
        ));
    }

    let opencode_state = OpenCodeAppState::new(shared.clone());
    let mut opencode_router = build_opencode_router(opencode_state.clone());
    let mut opencode_root_router = build_opencode_router(opencode_state);
    if shared.auth.token.is_some() {
        opencode_router = opencode_router.layer(axum::middleware::from_fn_with_state(
            shared.clone(),
            require_token,
        ));
        opencode_root_router = opencode_root_router.layer(axum::middleware::from_fn_with_state(
            shared.clone(),
            require_token,
        ));
    }

    let mut router = Router::new()
        .route("/", get(get_root))
        .nest("/v1", v1_router)
        .nest("/opencode", opencode_router)
        .merge(opencode_root_router)
        .fallback(not_found);

    if ui::is_enabled() {
        router = router.merge(ui::router());
    }

    let http_logging = match std::env::var("SANDBOX_AGENT_LOG_HTTP") {
        Ok(value) if value == "0" || value.eq_ignore_ascii_case("false") => false,
        _ => true,
    };
    if http_logging {
        let include_headers = std::env::var("SANDBOX_AGENT_LOG_HTTP_HEADERS").is_ok();
        let trace_layer = TraceLayer::new_for_http()
            .make_span_with(move |req: &Request<_>| {
                if include_headers {
                    let mut headers = Vec::new();
                    for (name, value) in req.headers().iter() {
                        let name_str = name.as_str();
                        let display_value = if name_str.eq_ignore_ascii_case("authorization") {
                            "<redacted>".to_string()
                        } else {
                            value.to_str().unwrap_or("<binary>").to_string()
                        };
                        headers.push((name_str.to_string(), display_value));
                    }
                    tracing::info_span!(
                        "http.request",
                        method = %req.method(),
                        uri = %req.uri(),
                        headers = ?headers
                    )
                } else {
                    tracing::info_span!(
                        "http.request",
                        method = %req.method(),
                        uri = %req.uri()
                    )
                }
            })
            .on_request(|_req: &Request<_>, span: &Span| {
                tracing::info!(parent: span, "request");
            })
            .on_response(|res: &Response<_>, latency: Duration, span: &Span| {
                tracing::info!(
                    parent: span,
                    status = %res.status(),
                    latency_ms = latency.as_millis()
                );
            });
        router = router.layer(trace_layer);
    }

    (router, shared)
}

pub async fn shutdown_servers(state: &Arc<AppState>) {
    state.session_manager.server_manager.shutdown().await;
}

#[derive(OpenApi)]
#[openapi(
    paths(
        get_health,
        install_agent,
        get_agent_modes,
        get_agent_models,
        list_agents,
        list_sessions,
        create_session,
        post_message,
        post_message_stream,
        terminate_session,
        get_events,
        get_events_sse,
        reply_question,
        reject_question,
        reply_permission
    ),
    components(
        schemas(
            AgentInstallRequest,
            AgentModeInfo,
            AgentModesResponse,
            AgentModelInfo,
            AgentModelsResponse,
            AgentCapabilities,
            AgentInfo,
            AgentListResponse,
            ServerStatus,
            ServerStatusInfo,
            SessionInfo,
            SessionListResponse,
            HealthResponse,
            CreateSessionRequest,
            CreateSessionResponse,
            MessageRequest,
            EventsQuery,
            TurnStreamQuery,
            EventsResponse,
            UniversalEvent,
            UniversalEventData,
            UniversalEventType,
            EventSource,
            SessionStartedData,
            SessionEndedData,
            SessionEndReason,
            TerminatedBy,
            StderrOutput,
            ItemEventData,
            ItemDeltaData,
            UniversalItem,
            ItemKind,
            ItemRole,
            ItemStatus,
            ContentPart,
            FileAction,
            ReasoningVisibility,
            ErrorData,
            AgentUnparsedData,
            PermissionEventData,
            PermissionStatus,
            QuestionEventData,
            QuestionStatus,
            QuestionReplyRequest,
            PermissionReplyRequest,
            PermissionReply,
            ProblemDetails,
            ErrorType,
            AgentError
        )
    ),
    tags(
        (name = "meta", description = "Service metadata"),
        (name = "agents", description = "Agent management"),
        (name = "sessions", description = "Session management")
    ),
    modifiers(&ServerAddon)
)]
pub struct ApiDoc;

struct ServerAddon;

impl Modify for ServerAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        openapi.servers = Some(vec![utoipa::openapi::Server::new("http://localhost:2468")]);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let problem: ProblemDetails = match &self {
            ApiError::Sandbox(err) => err.to_problem_details(),
        };
        let status =
            StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(problem)).into_response()
    }
}

#[derive(Debug)]
struct SessionState {
    session_id: String,
    agent: AgentId,
    agent_mode: String,
    permission_mode: String,
    model: Option<String>,
    variant: Option<String>,
    native_session_id: Option<String>,
    ended: bool,
    ended_exit_code: Option<i32>,
    ended_message: Option<String>,
    ended_reason: Option<SessionEndReason>,
    terminated_by: Option<TerminatedBy>,
    next_event_sequence: u64,
    next_item_id: u64,
    events: Vec<UniversalEvent>,
    pending_questions: HashMap<String, PendingQuestion>,
    pending_permissions: HashMap<String, PendingPermission>,
    item_started: HashSet<String>,
    item_delta_seen: HashSet<String>,
    item_map: HashMap<String, String>,
    mock_sequence: u64,
    broadcaster: broadcast::Sender<UniversalEvent>,
    opencode_stream_started: bool,
    codex_sender: Option<mpsc::UnboundedSender<String>>,
    claude_sender: Option<mpsc::UnboundedSender<String>>,
    session_started_emitted: bool,
    last_claude_message_id: Option<String>,
    claude_message_counter: u64,
    pending_assistant_native_ids: VecDeque<String>,
    pending_assistant_counter: u64,
}

#[derive(Debug, Clone)]
struct PendingPermission {
    action: String,
    metadata: Option<Value>,
}

#[derive(Debug, Clone)]
struct PendingQuestion {
    prompt: String,
    options: Vec<String>,
}

impl SessionState {
    fn new(
        session_id: String,
        agent: AgentId,
        request: &CreateSessionRequest,
    ) -> Result<Self, SandboxError> {
        let (agent_mode, permission_mode) = normalize_modes(
            agent,
            request.agent_mode.as_deref(),
            request.permission_mode.as_deref(),
        )?;
        let (broadcaster, _rx) = broadcast::channel(256);

        Ok(Self {
            session_id,
            agent,
            agent_mode,
            permission_mode,
            model: request.model.clone(),
            variant: request.variant.clone(),
            native_session_id: None,
            ended: false,
            ended_exit_code: None,
            ended_message: None,
            ended_reason: None,
            terminated_by: None,
            next_event_sequence: 0,
            next_item_id: 0,
            events: Vec::new(),
            pending_questions: HashMap::new(),
            pending_permissions: HashMap::new(),
            item_started: HashSet::new(),
            item_delta_seen: HashSet::new(),
            item_map: HashMap::new(),
            mock_sequence: 0,
            broadcaster,
            opencode_stream_started: false,
            codex_sender: None,
            claude_sender: None,
            session_started_emitted: false,
            last_claude_message_id: None,
            claude_message_counter: 0,
            pending_assistant_native_ids: VecDeque::new(),
            pending_assistant_counter: 0,
        })
    }

    fn next_pending_assistant_native_id(&mut self) -> String {
        self.pending_assistant_counter += 1;
        format!(
            "{}_pending_assistant_{}",
            self.session_id, self.pending_assistant_counter
        )
    }

    fn enqueue_pending_assistant_start(&mut self) -> EventConversion {
        let native_item_id = self.next_pending_assistant_native_id();
        self.pending_assistant_native_ids
            .push_back(native_item_id.clone());
        EventConversion::new(
            UniversalEventType::ItemStarted,
            UniversalEventData::Item(ItemEventData {
                item: UniversalItem {
                    item_id: String::new(),
                    native_item_id: Some(native_item_id),
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::Assistant),
                    content: Vec::new(),
                    status: ItemStatus::InProgress,
                },
            }),
        )
        .synthetic()
    }

    fn record_conversions(&mut self, conversions: Vec<EventConversion>) -> Vec<UniversalEvent> {
        let mut events = Vec::new();
        for conversion in conversions {
            for normalized in self.normalize_conversion(conversion) {
                if let Some(event) = self.push_event(normalized) {
                    events.push(event);
                }
            }
        }
        events
    }

    fn set_codex_sender(&mut self, sender: Option<mpsc::UnboundedSender<String>>) {
        self.codex_sender = sender;
    }

    // Note: This is unused now that Codex uses the shared server model,
    // but keeping it for potential future use with other agents.
    #[allow(dead_code)]
    fn codex_sender(&self) -> Option<mpsc::UnboundedSender<String>> {
        self.codex_sender.clone()
    }

    fn set_claude_sender(&mut self, sender: Option<mpsc::UnboundedSender<String>>) {
        self.claude_sender = sender;
    }

    #[allow(dead_code)]
    fn claude_sender(&self) -> Option<mpsc::UnboundedSender<String>> {
        self.claude_sender.clone()
    }

    fn normalize_conversion(&mut self, mut conversion: EventConversion) -> Vec<EventConversion> {
        if self.native_session_id.is_none() && conversion.native_session_id.is_some() {
            self.native_session_id = conversion.native_session_id.clone();
        }
        if conversion.native_session_id.is_none() {
            conversion.native_session_id = self.native_session_id.clone();
        }

        let mut conversions = Vec::new();
        if !agent_supports_item_started(self.agent) {
            if conversion.event_type == UniversalEventType::ItemStarted {
                if let UniversalEventData::Item(ref data) = conversion.data {
                    let is_assistant_message = data.item.kind == ItemKind::Message
                        && matches!(data.item.role, Some(ItemRole::Assistant));
                    if is_assistant_message {
                        let keep = data
                            .item
                            .native_item_id
                            .as_ref()
                            .map(|id| self.pending_assistant_native_ids.contains(id))
                            .unwrap_or(false);
                        if !keep {
                            return conversions;
                        }
                    }
                }
            }
            match conversion.event_type {
                UniversalEventType::ItemCompleted => {
                    if let UniversalEventData::Item(ref mut data) = conversion.data {
                        let is_assistant_message = data.item.kind == ItemKind::Message
                            && matches!(data.item.role, Some(ItemRole::Assistant));
                        if is_assistant_message {
                            if let Some(pending) = self.pending_assistant_native_ids.pop_front() {
                                data.item.native_item_id = Some(pending);
                                data.item.item_id.clear();
                            }
                        }
                    }
                }
                UniversalEventType::ItemDelta => {
                    if let UniversalEventData::ItemDelta(ref mut data) = conversion.data {
                        let is_user = data
                            .native_item_id
                            .as_ref()
                            .is_some_and(|id| id.starts_with("user_"));
                        if !is_user {
                            if let Some(pending) = self.pending_assistant_native_ids.front() {
                                data.native_item_id = Some(pending.clone());
                                data.item_id.clear();
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        match conversion.event_type {
            UniversalEventType::ItemStarted | UniversalEventType::ItemCompleted => {
                if let UniversalEventData::Item(ref mut data) = conversion.data {
                    self.ensure_item_id(&mut data.item);
                    self.ensure_parent_id(&mut data.item);
                    if conversion.event_type == UniversalEventType::ItemCompleted
                        && !self.item_started.contains(&data.item.item_id)
                    {
                        let mut started_item = data.item.clone();
                        started_item.status = ItemStatus::InProgress;
                        conversions.push(
                            EventConversion::new(
                                UniversalEventType::ItemStarted,
                                UniversalEventData::Item(ItemEventData { item: started_item }),
                            )
                            .synthetic()
                            .with_native_session(conversion.native_session_id.clone()),
                        );
                    }
                    if conversion.event_type == UniversalEventType::ItemCompleted
                        && data.item.kind == ItemKind::Message
                        && !self.item_delta_seen.contains(&data.item.item_id)
                    {
                        if let Some(delta) = text_delta_from_parts(&data.item.content) {
                            conversions.push(
                                EventConversion::new(
                                    UniversalEventType::ItemDelta,
                                    UniversalEventData::ItemDelta(ItemDeltaData {
                                        item_id: data.item.item_id.clone(),
                                        native_item_id: data.item.native_item_id.clone(),
                                        delta,
                                    }),
                                )
                                .synthetic()
                                .with_native_session(conversion.native_session_id.clone()),
                            );
                        }
                    }
                }
            }
            UniversalEventType::ItemDelta => {
                if let UniversalEventData::ItemDelta(ref mut data) = conversion.data {
                    if data.item_id.is_empty() {
                        data.item_id = match data.native_item_id.as_ref() {
                            Some(native) => self.item_id_for_native(native),
                            None => self.next_item_id(),
                        };
                    }
                }
            }
            _ => {}
        }

        conversions.push(conversion);
        conversions
    }

    fn push_event(&mut self, conversion: EventConversion) -> Option<UniversalEvent> {
        if conversion.event_type == UniversalEventType::SessionStarted {
            if self.session_started_emitted {
                return None;
            }
            self.session_started_emitted = true;
        }
        if conversion.event_type == UniversalEventType::SessionEnded
            && agent_supports_resume(self.agent)
            && !conversion.synthetic
        {
            return None;
        }
        if conversion.event_type == UniversalEventType::ItemStarted {
            if let UniversalEventData::Item(ref data) = conversion.data {
                if self.item_started.contains(&data.item.item_id) {
                    return None;
                }
            }
        }

        self.next_event_sequence += 1;
        let sequence = self.next_event_sequence;
        let event = UniversalEvent {
            event_id: format!("evt_{sequence}"),
            sequence,
            time: now_rfc3339(),
            session_id: self.session_id.clone(),
            native_session_id: conversion.native_session_id.clone(),
            synthetic: conversion.synthetic,
            source: conversion.source,
            event_type: conversion.event_type,
            data: conversion.data,
            raw: conversion.raw,
        };

        self.update_pending(&event);
        self.update_item_tracking(&event);
        self.events.push(event.clone());
        let _ = self.broadcaster.send(event.clone());
        if self.native_session_id.is_none() {
            self.native_session_id = event.native_session_id.clone();
        }
        Some(event)
    }

    fn update_pending(&mut self, event: &UniversalEvent) {
        match event.event_type {
            UniversalEventType::QuestionRequested => {
                if let UniversalEventData::Question(data) = &event.data {
                    self.pending_questions.insert(
                        data.question_id.clone(),
                        PendingQuestion {
                            prompt: data.prompt.clone(),
                            options: data.options.clone(),
                        },
                    );
                }
            }
            UniversalEventType::QuestionResolved => {
                if let UniversalEventData::Question(data) = &event.data {
                    self.pending_questions.remove(&data.question_id);
                }
            }
            UniversalEventType::PermissionRequested => {
                if let UniversalEventData::Permission(data) = &event.data {
                    self.pending_permissions.insert(
                        data.permission_id.clone(),
                        PendingPermission {
                            action: data.action.clone(),
                            metadata: data.metadata.clone(),
                        },
                    );
                }
            }
            UniversalEventType::PermissionResolved => {
                if let UniversalEventData::Permission(data) = &event.data {
                    self.pending_permissions.remove(&data.permission_id);
                }
            }
            _ => {}
        }
    }

    fn update_item_tracking(&mut self, event: &UniversalEvent) {
        match event.event_type {
            UniversalEventType::ItemStarted | UniversalEventType::ItemCompleted => {
                if let UniversalEventData::Item(data) = &event.data {
                    self.item_started.insert(data.item.item_id.clone());
                    if let Some(native) = data.item.native_item_id.as_ref() {
                        self.item_map
                            .insert(native.clone(), data.item.item_id.clone());
                    }
                }
            }
            UniversalEventType::ItemDelta => {
                if let UniversalEventData::ItemDelta(data) = &event.data {
                    self.item_delta_seen.insert(data.item_id.clone());
                    if let Some(native) = data.native_item_id.as_ref() {
                        self.item_map.insert(native.clone(), data.item_id.clone());
                    }
                }
            }
            _ => {}
        }
    }

    fn take_question(&mut self, question_id: &str) -> Option<PendingQuestion> {
        self.pending_questions.remove(question_id)
    }

    fn take_permission(&mut self, permission_id: &str) -> Option<PendingPermission> {
        self.pending_permissions.remove(permission_id)
    }

    fn mark_ended(
        &mut self,
        exit_code: Option<i32>,
        message: String,
        reason: SessionEndReason,
        terminated_by: TerminatedBy,
    ) {
        self.ended = true;
        self.ended_exit_code = exit_code;
        self.ended_message = Some(message);
        self.ended_reason = Some(reason);
        self.terminated_by = Some(terminated_by);
    }

    fn ended_error(&self) -> Option<SandboxError> {
        self.ended_error_for_messages(false)
    }

    /// Returns an error if the session cannot accept new messages.
    /// `for_new_message` should be true when checking before sending a new message -
    /// this allows agents that support resumption (Claude, Amp, OpenCode) to continue
    /// after their process exits successfully.
    fn ended_error_for_messages(&self, for_new_message: bool) -> Option<SandboxError> {
        if !self.ended {
            return None;
        }
        if matches!(self.terminated_by, Some(TerminatedBy::Daemon)) {
            return Some(SandboxError::InvalidRequest {
                message: "session terminated".to_string(),
            });
        }
        // For agents that support resumption (Claude, Amp, OpenCode), allow new messages
        // after the process exits with success (Completed reason). The new message will
        // spawn a fresh process with --resume/--continue to continue the conversation.
        if for_new_message
            && matches!(self.ended_reason, Some(SessionEndReason::Completed))
            && agent_supports_resume(self.agent)
        {
            return None;
        }
        Some(SandboxError::AgentProcessExited {
            agent: self.agent.as_str().to_string(),
            exit_code: self.ended_exit_code,
            stderr: self.ended_message.clone(),
        })
    }

    fn ensure_item_id(&mut self, item: &mut UniversalItem) {
        if item.item_id.is_empty() {
            if let Some(native) = item.native_item_id.as_ref() {
                item.item_id = self.item_id_for_native(native);
            } else {
                item.item_id = self.next_item_id();
            }
        }
    }

    fn ensure_parent_id(&mut self, item: &mut UniversalItem) {
        let Some(parent_id) = item.parent_id.clone() else {
            return;
        };
        if parent_id.starts_with("itm_") {
            return;
        }
        let mapped = self.item_id_for_native(&parent_id);
        item.parent_id = Some(mapped);
    }

    fn item_id_for_native(&mut self, native: &str) -> String {
        if let Some(item_id) = self.item_map.get(native) {
            return item_id.clone();
        }
        let item_id = self.next_item_id();
        self.item_map.insert(native.to_string(), item_id.clone());
        item_id
    }

    fn next_item_id(&mut self) -> String {
        self.next_item_id += 1;
        format!("itm_{}", self.next_item_id)
    }
}

#[derive(Debug)]
enum ManagedServerKind {
    Http { base_url: String },
    Stdio { server: Arc<CodexServer> },
}

#[derive(Debug)]
struct ManagedServer {
    kind: ManagedServerKind,
    child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
    status: ServerStatus,
    start_time: Option<Instant>,
    restart_count: u64,
    last_error: Option<String>,
    shutdown_requested: bool,
    instance_id: u64,
}

#[derive(Debug)]
struct AgentServerManager {
    agent_manager: Arc<AgentManager>,
    servers: Mutex<HashMap<AgentId, ManagedServer>>,
    sessions: Mutex<HashMap<AgentId, HashSet<String>>>,
    native_sessions: Mutex<HashMap<AgentId, HashMap<String, String>>>,
    http_client: Client,
    log_base_dir: PathBuf,
    auto_restart: bool,
    owner: std::sync::Mutex<Option<Weak<SessionManager>>>,
    #[cfg(feature = "test-utils")]
    restart_notifier: Mutex<Option<mpsc::UnboundedSender<AgentId>>>,
}

#[derive(Debug)]
pub(crate) struct SessionManager {
    agent_manager: Arc<AgentManager>,
    sessions: Mutex<Vec<SessionState>>,
    server_manager: Arc<AgentServerManager>,
    http_client: Client,
}

/// Shared Codex app-server process that handles multiple sessions via JSON-RPC.
/// Similar to OpenCode's server model - a single long-running process that multiplexes
/// multiple thread (session) conversations.
struct CodexServer {
    /// Sender for writing to the process stdin
    stdin_sender: mpsc::UnboundedSender<String>,
    /// Pending JSON-RPC requests awaiting responses, keyed by request ID
    pending_requests: std::sync::Mutex<HashMap<i64, oneshot::Sender<Value>>>,
    /// Next request ID for JSON-RPC
    next_id: AtomicI64,
    /// Whether initialize/initialized handshake has completed
    initialized: std::sync::Mutex<bool>,
    /// Mapping from thread_id to session_id for routing notifications
    thread_sessions: std::sync::Mutex<HashMap<String, String>>,
}

impl std::fmt::Debug for CodexServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexServer")
            .field("next_id", &self.next_id.load(Ordering::SeqCst))
            .finish()
    }
}

impl CodexServer {
    fn new(stdin_sender: mpsc::UnboundedSender<String>) -> Self {
        Self {
            stdin_sender,
            pending_requests: std::sync::Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            initialized: std::sync::Mutex::new(false),
            thread_sessions: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn next_request_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn send_request(&self, id: i64, request: &impl Serialize) -> Option<oneshot::Receiver<Value>> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.insert(id, tx);
        }
        let line = serde_json::to_string(request).ok()?;
        self.stdin_sender.send(line).ok()?;
        Some(rx)
    }

    fn send_notification(&self, notification: &impl Serialize) -> bool {
        let Ok(line) = serde_json::to_string(notification) else {
            return false;
        };
        self.stdin_sender.send(line).is_ok()
    }

    fn complete_request(&self, id: i64, result: Value) {
        let tx = {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.remove(&id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(result);
        }
    }

    fn register_thread(&self, thread_id: String, session_id: String) {
        let mut sessions = self.thread_sessions.lock().unwrap();
        sessions.insert(thread_id, session_id);
    }

    fn session_for_thread(&self, thread_id: &str) -> Option<String> {
        let sessions = self.thread_sessions.lock().unwrap();
        sessions.get(thread_id).cloned()
    }

    fn is_initialized(&self) -> bool {
        *self.initialized.lock().unwrap()
    }

    fn set_initialized(&self) {
        *self.initialized.lock().unwrap() = true;
    }

    fn clear_pending(&self) {
        let mut pending = self.pending_requests.lock().unwrap();
        pending.clear();
    }

    fn clear_threads(&self) {
        let mut sessions = self.thread_sessions.lock().unwrap();
        sessions.clear();
    }
}

pub(crate) struct SessionSubscription {
    pub(crate) initial_events: Vec<UniversalEvent>,
    pub(crate) receiver: broadcast::Receiver<UniversalEvent>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingPermissionInfo {
    pub session_id: String,
    pub permission_id: String,
    pub action: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingQuestionInfo {
    pub session_id: String,
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
}

impl ManagedServer {
    fn base_url(&self) -> Option<String> {
        match &self.kind {
            ManagedServerKind::Http { base_url } => Some(base_url.clone()),
            ManagedServerKind::Stdio { .. } => None,
        }
    }

    fn status_info(&self) -> ServerStatusInfo {
        let uptime_ms = self
            .start_time
            .map(|started| started.elapsed().as_millis() as u64);
        ServerStatusInfo {
            status: self.status.clone(),
            base_url: self.base_url(),
            uptime_ms,
            restart_count: self.restart_count,
            last_error: self.last_error.clone(),
        }
    }
}

impl AgentServerManager {
    fn new(
        agent_manager: Arc<AgentManager>,
        http_client: Client,
        log_base_dir: PathBuf,
        auto_restart: bool,
    ) -> Self {
        Self {
            agent_manager,
            servers: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            native_sessions: Mutex::new(HashMap::new()),
            http_client,
            log_base_dir,
            auto_restart,
            owner: std::sync::Mutex::new(None),
            #[cfg(feature = "test-utils")]
            restart_notifier: Mutex::new(None),
        }
    }

    fn set_owner(&self, owner: Weak<SessionManager>) {
        *self.owner.lock().expect("owner lock") = Some(owner);
    }

    #[cfg(feature = "test-utils")]
    async fn set_owner_async(&self, owner: Weak<SessionManager>) {
        *self.owner.lock().expect("owner lock") = Some(owner);
    }

    #[cfg(feature = "test-utils")]
    async fn set_restart_notifier(&self, tx: mpsc::UnboundedSender<AgentId>) {
        *self.restart_notifier.lock().await = Some(tx);
    }

    async fn register_session(
        &self,
        agent: AgentId,
        session_id: &str,
        native_session_id: Option<&str>,
    ) {
        let mut sessions = self.sessions.lock().await;
        sessions
            .entry(agent)
            .or_insert_with(HashSet::new)
            .insert(session_id.to_string());
        drop(sessions);
        if let Some(native_session_id) = native_session_id {
            let mut natives = self.native_sessions.lock().await;
            natives
                .entry(agent)
                .or_insert_with(HashMap::new)
                .insert(native_session_id.to_string(), session_id.to_string());
        }
    }

    async fn unregister_session(
        &self,
        agent: AgentId,
        session_id: &str,
        native_session_id: Option<&str>,
    ) {
        let mut clear_agent = false;
        let mut sessions_map = self.sessions.lock().await;
        if let Some(session_set) = sessions_map.get_mut(&agent) {
            session_set.remove(session_id);
            if session_set.is_empty() {
                sessions_map.remove(&agent);
                clear_agent = true;
            }
        }
        drop(sessions_map);
        if let Some(native_session_id) = native_session_id {
            let mut natives = self.native_sessions.lock().await;
            if let Some(natives) = natives.get_mut(&agent) {
                natives.remove(native_session_id);
            }
        }
        if clear_agent {
            let mut natives = self.native_sessions.lock().await;
            natives.remove(&agent);
        }
    }

    async fn clear_mappings(&self, agent: AgentId) {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(&agent);
        drop(sessions);
        let mut natives = self.native_sessions.lock().await;
        natives.remove(&agent);
    }

    async fn status_snapshot(&self) -> HashMap<AgentId, ServerStatusInfo> {
        let servers = self.servers.lock().await;
        servers
            .iter()
            .map(|(agent, server)| (*agent, server.status_info()))
            .collect()
    }

    async fn ensure_http_server(self: &Arc<Self>, agent: AgentId) -> Result<String, SandboxError> {
        {
            let servers = self.servers.lock().await;
            if let Some(server) = servers.get(&agent) {
                if matches!(server.status, ServerStatus::Running) {
                    if let Some(base_url) = server.base_url() {
                        return Ok(base_url);
                    }
                }
            }
        }

        let (base_url, child) = self.spawn_http_server(agent).await?;
        let restart_count = {
            let servers = self.servers.lock().await;
            servers
                .get(&agent)
                .map(|server| server.restart_count + 1)
                .unwrap_or(0)
        };

        {
            let mut servers = self.servers.lock().await;
            if let Some(existing) = servers.get(&agent) {
                if matches!(existing.status, ServerStatus::Running) {
                    if let Ok(mut guard) = child.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                    if let Some(base_url) = existing.base_url() {
                        return Ok(base_url);
                    }
                }
            }

            servers.insert(
                agent,
                ManagedServer {
                    kind: ManagedServerKind::Http {
                        base_url: base_url.clone(),
                    },
                    child: child.clone(),
                    status: ServerStatus::Running,
                    start_time: Some(Instant::now()),
                    restart_count,
                    last_error: None,
                    shutdown_requested: false,
                    instance_id: restart_count,
                },
            );
        }

        if let Err(err) = self.wait_for_http_server(&base_url).await {
            if let Ok(mut guard) = child.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
            self.update_server_error(agent, err.to_string()).await;
            return Err(err);
        }

        self.spawn_monitor_task(agent, restart_count, child);

        Ok(base_url)
    }

    async fn ensure_stdio_server(
        self: &Arc<Self>,
        agent: AgentId,
    ) -> Result<(Arc<CodexServer>, Option<mpsc::UnboundedReceiver<String>>), SandboxError> {
        {
            let servers = self.servers.lock().await;
            if let Some(server) = servers.get(&agent) {
                if matches!(server.status, ServerStatus::Running) {
                    if let ManagedServerKind::Stdio { server } = &server.kind {
                        return Ok((server.clone(), None));
                    }
                }
            }
        }

        let (server, stdout_rx, child) = self.spawn_stdio_server(agent).await?;
        let restart_count = {
            let servers = self.servers.lock().await;
            servers
                .get(&agent)
                .map(|server| server.restart_count + 1)
                .unwrap_or(0)
        };

        {
            let mut servers = self.servers.lock().await;
            if let Some(existing) = servers.get(&agent) {
                if matches!(existing.status, ServerStatus::Running) {
                    if let Ok(mut guard) = child.lock() {
                        if let Some(child) = guard.as_mut() {
                            let _ = child.kill();
                        }
                    }
                    if let ManagedServerKind::Stdio { server } = &existing.kind {
                        return Ok((server.clone(), None));
                    }
                }
            }
            servers.insert(
                agent,
                ManagedServer {
                    kind: ManagedServerKind::Stdio {
                        server: server.clone(),
                    },
                    child: child.clone(),
                    status: ServerStatus::Running,
                    start_time: Some(Instant::now()),
                    restart_count,
                    last_error: None,
                    shutdown_requested: false,
                    instance_id: restart_count,
                },
            );
        }

        self.spawn_monitor_task(agent, restart_count, child);

        Ok((server, Some(stdout_rx)))
    }

    async fn shutdown(&self) {
        let mut servers = self.servers.lock().await;
        for server in servers.values_mut() {
            server.shutdown_requested = true;
            server.status = ServerStatus::Stopped;
            server.start_time = None;
            if let Ok(mut guard) = server.child.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
            if let ManagedServerKind::Stdio { server } = &server.kind {
                server.clear_pending();
                server.clear_threads();
            }
        }
    }

    async fn wait_for_http_server(&self, base_url: &str) -> Result<(), SandboxError> {
        let endpoints = ["health", "healthz", "app/agents", "agents"];
        for _ in 0..20 {
            for endpoint in endpoints {
                let url = format!("{base_url}/{endpoint}");
                if let Ok(response) = self.http_client.get(&url).send().await {
                    if response.status().is_success() {
                        return Ok(());
                    }
                }
            }
            sleep(Duration::from_millis(150)).await;
        }
        Err(SandboxError::StreamError {
            message: "server health check failed".to_string(),
        })
    }

    async fn spawn_http_server(
        self: &Arc<Self>,
        agent: AgentId,
    ) -> Result<(String, Arc<std::sync::Mutex<Option<std::process::Child>>>), SandboxError> {
        let manager = self.agent_manager.clone();
        let log_dir = self.log_base_dir.clone();
        let (base_url, child) = tokio::task::spawn_blocking(
            move || -> Result<(String, std::process::Child), SandboxError> {
                let path = manager
                    .resolve_binary(agent)
                    .map_err(|err| map_spawn_error(agent, err))?;
                let port = find_available_port()?;
                let mut command = std::process::Command::new(path);
                let stderr = AgentServerLogs::new(log_dir, agent.as_str()).open()?;
                command
                    .arg("serve")
                    .arg("--port")
                    .arg(port.to_string())
                    .stdout(Stdio::null())
                    .stderr(stderr);
                let child = command.spawn().map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;
                Ok((format!("http://127.0.0.1:{port}"), child))
            },
        )
        .await
        .map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })??;

        Ok((base_url, Arc::new(std::sync::Mutex::new(Some(child)))))
    }

    async fn spawn_stdio_server(
        self: &Arc<Self>,
        agent: AgentId,
    ) -> Result<
        (
            Arc<CodexServer>,
            mpsc::UnboundedReceiver<String>,
            Arc<std::sync::Mutex<Option<std::process::Child>>>,
        ),
        SandboxError,
    > {
        let manager = self.agent_manager.clone();
        let log_dir = self.log_base_dir.clone();
        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
        let (stdout_tx, stdout_rx) = mpsc::unbounded_channel::<String>();

        let child =
            tokio::task::spawn_blocking(move || -> Result<std::process::Child, SandboxError> {
                let path = manager
                    .resolve_binary(agent)
                    .map_err(|err| map_spawn_error(agent, err))?;
                let mut command = std::process::Command::new(path);
                let stderr = AgentServerLogs::new(log_dir, agent.as_str()).open()?;
                command
                    .arg("app-server")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(stderr);

                let mut child = command.spawn().map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;

                let stdin = child
                    .stdin
                    .take()
                    .ok_or_else(|| SandboxError::StreamError {
                        message: "codex stdin unavailable".to_string(),
                    })?;
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| SandboxError::StreamError {
                        message: "codex stdout unavailable".to_string(),
                    })?;

                let stdin_rx_mut = std::sync::Mutex::new(stdin_rx);
                std::thread::spawn(move || {
                    let mut stdin = stdin;
                    let mut rx = stdin_rx_mut.lock().unwrap();
                    while let Some(line) = rx.blocking_recv() {
                        if writeln!(stdin, "{line}").is_err() {
                            break;
                        }
                        if stdin.flush().is_err() {
                            break;
                        }
                    }
                });

                std::thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        if stdout_tx.send(line).is_err() {
                            break;
                        }
                    }
                });

                Ok(child)
            })
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })??;

        let server = Arc::new(CodexServer::new(stdin_tx));

        Ok((
            server,
            stdout_rx,
            Arc::new(std::sync::Mutex::new(Some(child))),
        ))
    }

    fn spawn_monitor_task(
        self: &Arc<Self>,
        agent: AgentId,
        instance_id: u64,
        child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
    ) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let status = {
                    let mut guard = match child.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    match guard.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(status) => status,
                            Err(_) => None,
                        },
                        None => return,
                    }
                };

                if let Some(status) = status {
                    manager
                        .handle_process_exit(agent, instance_id, status)
                        .await;
                    break;
                }

                sleep(Duration::from_millis(500)).await;
            }
        });
    }

    async fn handle_process_exit(
        self: &Arc<Self>,
        agent: AgentId,
        instance_id: u64,
        status: std::process::ExitStatus,
    ) {
        let exit_code = status.code();
        let message = format!("agent server exited with status {:?}", status);
        let mut codex_server = None;
        let mut shutdown_requested = false;
        {
            let mut servers = self.servers.lock().await;
            if let Some(server) = servers.get_mut(&agent) {
                if server.instance_id != instance_id {
                    return;
                }
                shutdown_requested = server.shutdown_requested;
                server.status = if shutdown_requested {
                    ServerStatus::Stopped
                } else {
                    ServerStatus::Error
                };
                server.start_time = None;
                if !shutdown_requested {
                    server.last_error = Some(message.clone());
                }
                if let Ok(mut guard) = server.child.lock() {
                    *guard = None;
                }
                if let ManagedServerKind::Stdio { server } = &server.kind {
                    codex_server = Some(server.clone());
                }
            }
        }

        if let Some(server) = codex_server {
            server.clear_pending();
            server.clear_threads();
        }

        if shutdown_requested {
            self.clear_mappings(agent).await;
            return;
        }

        self.notify_sessions_of_error(agent, &message, exit_code)
            .await;

        if self.auto_restart {
            #[cfg(feature = "test-utils")]
            {
                if let Some(tx) = self.restart_notifier.lock().await.as_ref() {
                    let _ = tx.send(agent);
                }
            }
            let manager = Arc::clone(self);
            tokio::spawn(async move {
                let _ = manager.ensure_server_for_restart(agent).await;
            });
        }
    }

    async fn ensure_server_for_restart(
        self: Arc<Self>,
        agent: AgentId,
    ) -> Result<(), SandboxError> {
        sleep(Duration::from_millis(500)).await;
        match agent {
            AgentId::Opencode => {
                let _ = self.ensure_http_server(agent).await?;
            }
            AgentId::Codex => {
                let (server, receiver) = self.ensure_stdio_server(agent).await?;
                if let Some(stdout_rx) = receiver {
                    let owner = self.owner.lock().expect("owner lock").clone();
                    if let Some(owner) = owner.as_ref().and_then(|weak| weak.upgrade()) {
                        let owner_clone = owner.clone();
                        let server_clone = server.clone();
                        tokio::spawn(async move {
                            owner_clone
                                .handle_codex_server_output(server_clone, stdout_rx)
                                .await;
                        });
                        let _ = owner.codex_server_initialize(&server).await;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn notify_sessions_of_error(
        &self,
        agent: AgentId,
        message: &str,
        exit_code: Option<i32>,
    ) {
        let session_ids = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&agent)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect::<Vec<_>>()
        };

        let owner = { self.owner.lock().expect("owner lock").clone() };
        if let Some(owner) = owner.and_then(|weak| weak.upgrade()) {
            let logs = owner.read_agent_stderr(agent);
            for session_id in session_ids {
                owner
                    .record_error(
                        &session_id,
                        message.to_string(),
                        Some("server_exit".to_string()),
                        None,
                    )
                    .await;
                owner
                    .mark_session_ended(
                        &session_id,
                        exit_code,
                        message,
                        SessionEndReason::Error,
                        TerminatedBy::Daemon,
                        logs.clone(),
                    )
                    .await;
            }
        }

        self.clear_mappings(agent).await;
    }

    async fn update_server_error(&self, agent: AgentId, message: String) {
        let mut servers = self.servers.lock().await;
        if let Some(server) = servers.get_mut(&agent) {
            server.status = ServerStatus::Error;
            server.start_time = None;
            server.last_error = Some(message);
        }
    }
}

impl SessionManager {
    fn new(agent_manager: Arc<AgentManager>) -> Self {
        let log_base_dir = default_log_dir();
        let server_manager = Arc::new(AgentServerManager::new(
            agent_manager.clone(),
            Client::new(),
            log_base_dir,
            true,
        ));
        Self {
            agent_manager,
            sessions: Mutex::new(Vec::new()),
            server_manager,
            http_client: Client::new(),
        }
    }

    fn session_ref<'a>(sessions: &'a [SessionState], session_id: &str) -> Option<&'a SessionState> {
        sessions
            .iter()
            .find(|session| session.session_id == session_id)
    }

    fn session_mut<'a>(
        sessions: &'a mut [SessionState],
        session_id: &str,
    ) -> Option<&'a mut SessionState> {
        sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
    }

    /// Read agent stderr for error diagnostics
    fn read_agent_stderr(&self, agent: AgentId) -> Option<StderrOutput> {
        let logs = AgentServerLogs::new(self.server_manager.log_base_dir.clone(), agent.as_str());
        logs.read_stderr()
    }

    pub(crate) async fn create_session(
        self: &Arc<Self>,
        session_id: String,
        request: CreateSessionRequest,
    ) -> Result<CreateSessionResponse, SandboxError> {
        let agent_id = parse_agent_id(&request.agent)?;
        {
            let sessions = self.sessions.lock().await;
            if sessions
                .iter()
                .any(|session| session.session_id == session_id)
            {
                return Err(SandboxError::SessionAlreadyExists { session_id });
            }
        }

        if agent_id != AgentId::Mock {
            let manager = self.agent_manager.clone();
            let agent_version = request.agent_version.clone();
            let agent_name = request.agent.clone();
            let install_result = tokio::task::spawn_blocking(move || {
                manager.install(
                    agent_id,
                    InstallOptions {
                        reinstall: false,
                        version: agent_version,
                    },
                )
            })
            .await
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent_name,
                stderr: Some(err.to_string()),
            })?;
            install_result.map_err(|err| map_install_error(agent_id, err))?;
        }

        let mut session = SessionState::new(session_id.clone(), agent_id, &request)?;
        if agent_id == AgentId::Opencode {
            let opencode_session_id = self.create_opencode_session().await?;
            session.native_session_id = Some(opencode_session_id);
        }
        if agent_id == AgentId::Codex {
            // Create a thread in the shared Codex app-server
            let snapshot = SessionSnapshot {
                session_id: session_id.clone(),
                agent: agent_id,
                agent_mode: session.agent_mode.clone(),
                permission_mode: session.permission_mode.clone(),
                model: session.model.clone(),
                variant: session.variant.clone(),
                native_session_id: None,
            };
            let thread_id = self.create_codex_thread(&session_id, &snapshot).await?;
            session.native_session_id = Some(thread_id);
        }
        if agent_id == AgentId::Mock {
            session.native_session_id = Some(format!("mock-{session_id}"));
        }

        let telemetry_agent = request.agent.clone();
        let telemetry_model = request.model.clone();
        let telemetry_variant = request.variant.clone();
        let metadata = json!({
            "agent": request.agent,
            "agentMode": session.agent_mode,
            "permissionMode": session.permission_mode,
            "model": request.model,
            "variant": request.variant,
        });
        let started = EventConversion::new(
            UniversalEventType::SessionStarted,
            UniversalEventData::SessionStarted(SessionStartedData {
                metadata: Some(metadata),
            }),
        )
        .synthetic()
        .with_native_session(session.native_session_id.clone());
        session.record_conversions(vec![started]);
        if agent_id == AgentId::Mock {
            // Emit native session.started like real agents do
            let native_started = EventConversion::new(
                UniversalEventType::SessionStarted,
                UniversalEventData::SessionStarted(SessionStartedData {
                    metadata: Some(json!({ "mock": true })),
                }),
            )
            .with_native_session(session.native_session_id.clone());
            session.record_conversions(vec![native_started]);
        }

        let native_session_id = session.native_session_id.clone();
        let telemetry_agent_mode = session.agent_mode.clone();
        let telemetry_permission_mode = session.permission_mode.clone();
        let mut sessions = self.sessions.lock().await;
        sessions.push(session);
        drop(sessions);
        if agent_id == AgentId::Opencode || agent_id == AgentId::Codex {
            self.server_manager
                .register_session(agent_id, &session_id, native_session_id.as_deref())
                .await;
        }

        if agent_id == AgentId::Opencode {
            self.ensure_opencode_stream(session_id).await?;
        }

        telemetry::log_session_created(telemetry::SessionConfig {
            agent: telemetry_agent,
            agent_mode: Some(telemetry_agent_mode),
            permission_mode: Some(telemetry_permission_mode),
            model: telemetry_model,
            variant: telemetry_variant,
        });

        Ok(CreateSessionResponse {
            healthy: true,
            error: None,
            native_session_id,
        })
    }

    async fn agent_modes(&self, agent: AgentId) -> Result<Vec<AgentModeInfo>, SandboxError> {
        if agent != AgentId::Opencode {
            return Ok(agent_modes_for(agent));
        }

        match self.fetch_opencode_modes().await {
            Ok(mut modes) => {
                ensure_custom_mode(&mut modes);
                if modes.is_empty() {
                    Ok(agent_modes_for(agent))
                } else {
                    Ok(modes)
                }
            }
            Err(_) => Ok(agent_modes_for(agent)),
        }
    }

    pub(crate) async fn agent_models(
        self: &Arc<Self>,
        agent: AgentId,
    ) -> Result<AgentModelsResponse, SandboxError> {
        match agent {
            AgentId::Claude => self.fetch_claude_models().await,
            AgentId::Codex => self.fetch_codex_models().await,
            AgentId::Opencode => match self.fetch_opencode_models().await {
                Ok(models) => Ok(models),
                Err(_) => Ok(AgentModelsResponse {
                    models: Vec::new(),
                    default_model: None,
                }),
            },
            AgentId::Amp => Ok(amp_models_response()),
            AgentId::Mock => Ok(mock_models_response()),
        }
    }

    pub(crate) async fn send_message(
        self: &Arc<Self>,
        session_id: String,
        message: String,
    ) -> Result<(), SandboxError> {
        // Use allow_ended=true and do explicit check to allow resumable agents
        let session_snapshot = self.session_snapshot_for_message(&session_id).await?;
        if session_snapshot.agent == AgentId::Mock {
            self.send_mock_message(session_id, message).await?;
            return Ok(());
        }
        if matches!(session_snapshot.agent, AgentId::Claude | AgentId::Amp) {
            let _ = self
                .record_conversions(&session_id, user_message_conversions(&message))
                .await;
        }
        if session_snapshot.agent == AgentId::Opencode {
            self.ensure_opencode_stream(session_id.clone()).await?;
            self.send_opencode_prompt(&session_snapshot, &message)
                .await?;
            if !agent_supports_item_started(session_snapshot.agent) {
                let _ = self
                    .emit_synthetic_assistant_start(&session_snapshot.session_id)
                    .await;
            }
            return Ok(());
        }
        if session_snapshot.agent == AgentId::Codex {
            // Use the shared Codex app-server
            self.send_codex_turn(&session_snapshot, &message).await?;
            if !agent_supports_item_started(session_snapshot.agent) {
                let _ = self
                    .emit_synthetic_assistant_start(&session_snapshot.session_id)
                    .await;
            }
            return Ok(());
        }

        // Reopen the session if it was ended (for resumable agents)
        self.reopen_session_if_ended(&session_id).await;

        let manager = self.agent_manager.clone();
        let prompt = message;
        let initial_input = if session_snapshot.agent == AgentId::Claude {
            Some(claude_user_message_line(&session_snapshot, &prompt))
        } else {
            None
        };
        let credentials = tokio::task::spawn_blocking(move || {
            let options = CredentialExtractionOptions::new();
            extract_all_credentials(&options)
        })
        .await
        .map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;

        let spawn_options = build_spawn_options(&session_snapshot, prompt.clone(), credentials);
        let agent_id = session_snapshot.agent;
        let spawn_result =
            tokio::task::spawn_blocking(move || manager.spawn_streaming(agent_id, spawn_options))
                .await
                .map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;

        let spawn_result = spawn_result.map_err(|err| map_spawn_error(agent_id, err))?;
        if !agent_supports_item_started(session_snapshot.agent) {
            let _ = self
                .emit_synthetic_assistant_start(&session_snapshot.session_id)
                .await;
        }

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            manager
                .consume_spawn(session_id, agent_id, spawn_result, initial_input)
                .await;
        });

        Ok(())
    }

    async fn emit_synthetic_assistant_start(&self, session_id: &str) -> Result<(), SandboxError> {
        let conversion = {
            let mut sessions = self.sessions.lock().await;
            let session = Self::session_mut(&mut sessions, session_id).ok_or_else(|| {
                SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                }
            })?;
            session.enqueue_pending_assistant_start()
        };
        let _ = self
            .record_conversions(session_id, vec![conversion])
            .await?;
        Ok(())
    }

    /// Reopens a session that was ended by an agent process completing.
    /// This allows resumable agents (Claude, Amp, OpenCode) to continue conversations.
    async fn reopen_session_if_ended(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = Self::session_mut(&mut sessions, session_id) {
            if session.ended && agent_supports_resume(session.agent) {
                session.ended = false;
                session.ended_exit_code = None;
                session.ended_message = None;
                session.ended_reason = None;
                session.terminated_by = None;
            }
        }
    }

    async fn terminate_session(&self, session_id: String) -> Result<(), SandboxError> {
        let mut sessions = self.sessions.lock().await;
        let session = Self::session_mut(&mut sessions, &session_id).ok_or_else(|| {
            SandboxError::SessionNotFound {
                session_id: session_id.clone(),
            }
        })?;
        if session.ended {
            return Ok(());
        }
        session.mark_ended(
            None,
            "terminated by daemon".to_string(),
            SessionEndReason::Terminated,
            TerminatedBy::Daemon,
        );
        let ended = EventConversion::new(
            UniversalEventType::SessionEnded,
            UniversalEventData::SessionEnded(SessionEndedData {
                reason: SessionEndReason::Terminated,
                terminated_by: TerminatedBy::Daemon,
                message: None,
                exit_code: None,
                stderr: None,
            }),
        )
        .synthetic()
        .with_native_session(session.native_session_id.clone());
        session.record_conversions(vec![ended]);
        let agent = session.agent;
        let native_session_id = session.native_session_id.clone();
        drop(sessions);
        if agent == AgentId::Opencode || agent == AgentId::Codex {
            self.server_manager
                .unregister_session(agent, &session_id, native_session_id.as_deref())
                .await;
        }
        Ok(())
    }

    async fn events(
        &self,
        session_id: &str,
        offset: u64,
        limit: Option<u64>,
        include_raw: bool,
    ) -> Result<EventsResponse, SandboxError> {
        let sessions = self.sessions.lock().await;
        let session = Self::session_ref(&sessions, session_id).ok_or_else(|| {
            SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            }
        })?;

        let mut events: Vec<UniversalEvent> = session
            .events
            .iter()
            .filter(|event| event.sequence > offset)
            .cloned()
            .map(|mut event| {
                if !include_raw {
                    event.raw = None;
                }
                event
            })
            .collect();

        let has_more = if let Some(limit) = limit {
            let limit = limit as usize;
            if events.len() > limit {
                events.truncate(limit);
                true
            } else {
                false
            }
        } else {
            false
        };

        Ok(EventsResponse { events, has_more })
    }

    async fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().await;
        sessions
            .iter()
            .rev()
            .map(|state| SessionInfo {
                session_id: state.session_id.clone(),
                agent: state.agent.as_str().to_string(),
                agent_mode: state.agent_mode.clone(),
                permission_mode: state.permission_mode.clone(),
                model: state.model.clone(),
                variant: state.variant.clone(),
                native_session_id: state.native_session_id.clone(),
                ended: state.ended,
                event_count: state.events.len() as u64,
            })
            .collect()
    }

    pub(crate) async fn subscribe(
        &self,
        session_id: &str,
        offset: u64,
    ) -> Result<SessionSubscription, SandboxError> {
        let sessions = self.sessions.lock().await;
        let session = Self::session_ref(&sessions, session_id).ok_or_else(|| {
            SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            }
        })?;
        let initial_events = session
            .events
            .iter()
            .filter(|event| event.sequence > offset)
            .cloned()
            .collect::<Vec<_>>();
        let receiver = session.broadcaster.subscribe();
        Ok(SessionSubscription {
            initial_events,
            receiver,
        })
    }

    pub(crate) async fn list_pending_permissions(&self) -> Vec<PendingPermissionInfo> {
        let sessions = self.sessions.lock().await;
        let mut items = Vec::new();
        for session in sessions.iter() {
            for (permission_id, pending) in session.pending_permissions.iter() {
                items.push(PendingPermissionInfo {
                    session_id: session.session_id.clone(),
                    permission_id: permission_id.clone(),
                    action: pending.action.clone(),
                    metadata: pending.metadata.clone(),
                });
            }
        }
        items
    }

    pub(crate) async fn list_pending_questions(&self) -> Vec<PendingQuestionInfo> {
        let sessions = self.sessions.lock().await;
        let mut items = Vec::new();
        for session in sessions.iter() {
            for (question_id, pending) in session.pending_questions.iter() {
                items.push(PendingQuestionInfo {
                    session_id: session.session_id.clone(),
                    question_id: question_id.clone(),
                    prompt: pending.prompt.clone(),
                    options: pending.options.clone(),
                });
            }
        }
        items
    }

    async fn subscribe_for_turn(
        &self,
        session_id: &str,
    ) -> Result<(SessionSnapshot, SessionSubscription), SandboxError> {
        let sessions = self.sessions.lock().await;
        let session = Self::session_ref(&sessions, session_id).ok_or_else(|| {
            SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            }
        })?;
        if let Some(err) = session.ended_error() {
            return Err(err);
        }
        let offset = session.next_event_sequence;
        let initial_events = session
            .events
            .iter()
            .filter(|event| event.sequence > offset)
            .cloned()
            .collect::<Vec<_>>();
        let receiver = session.broadcaster.subscribe();
        let subscription = SessionSubscription {
            initial_events,
            receiver,
        };
        Ok((SessionSnapshot::from(session), subscription))
    }

    pub(crate) async fn reply_question(
        &self,
        session_id: &str,
        question_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), SandboxError> {
        let (agent, native_session_id, pending_question, claude_sender) = {
            let mut sessions = self.sessions.lock().await;
            let session = Self::session_mut(&mut sessions, session_id).ok_or_else(|| {
                SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                }
            })?;
            let pending = session.take_question(question_id);
            if pending.is_none() {
                return Err(SandboxError::InvalidRequest {
                    message: format!("unknown question id: {question_id}"),
                });
            }
            if let Some(err) = session.ended_error() {
                return Err(err);
            }
            (
                session.agent,
                session.native_session_id.clone(),
                pending,
                session.claude_sender(),
            )
        };

        let response = answers.first().and_then(|inner| inner.first()).cloned();

        if agent == AgentId::Opencode {
            let agent_session_id =
                native_session_id
                    .clone()
                    .ok_or_else(|| SandboxError::InvalidRequest {
                        message: "missing OpenCode session id".to_string(),
                    })?;
            self.opencode_question_reply(&agent_session_id, question_id, answers)
                .await?;
        } else if agent == AgentId::Claude {
            let sender = claude_sender.ok_or_else(|| SandboxError::InvalidRequest {
                message: "Claude session is not active".to_string(),
            })?;
            let session_id = native_session_id
                .clone()
                .unwrap_or_else(|| session_id.to_string());
            let response_text = response.clone().unwrap_or_default();
            let line = claude_tool_result_line(&session_id, question_id, &response_text, false);
            sender
                .send(line)
                .map_err(|_| SandboxError::InvalidRequest {
                    message: "Claude session is not active".to_string(),
                })?;
        } else {
            // TODO: Forward question replies to subprocess agents.
        }

        if let Some(pending) = pending_question {
            let resolved = EventConversion::new(
                UniversalEventType::QuestionResolved,
                UniversalEventData::Question(QuestionEventData {
                    question_id: question_id.to_string(),
                    prompt: pending.prompt,
                    options: pending.options,
                    response,
                    status: QuestionStatus::Answered,
                }),
            )
            .synthetic()
            .with_native_session(native_session_id);
            let _ = self.record_conversions(session_id, vec![resolved]).await;
        }

        Ok(())
    }

    pub(crate) async fn reject_question(
        &self,
        session_id: &str,
        question_id: &str,
    ) -> Result<(), SandboxError> {
        let (agent, native_session_id, pending_question, claude_sender) = {
            let mut sessions = self.sessions.lock().await;
            let session = Self::session_mut(&mut sessions, session_id).ok_or_else(|| {
                SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                }
            })?;
            let pending = session.take_question(question_id);
            if pending.is_none() {
                return Err(SandboxError::InvalidRequest {
                    message: format!("unknown question id: {question_id}"),
                });
            }
            if let Some(err) = session.ended_error() {
                return Err(err);
            }
            (
                session.agent,
                session.native_session_id.clone(),
                pending,
                session.claude_sender(),
            )
        };

        if agent == AgentId::Opencode {
            let agent_session_id =
                native_session_id
                    .clone()
                    .ok_or_else(|| SandboxError::InvalidRequest {
                        message: "missing OpenCode session id".to_string(),
                    })?;
            self.opencode_question_reject(&agent_session_id, question_id)
                .await?;
        } else if agent == AgentId::Claude {
            let sender = claude_sender.ok_or_else(|| SandboxError::InvalidRequest {
                message: "Claude session is not active".to_string(),
            })?;
            let session_id = native_session_id
                .clone()
                .unwrap_or_else(|| session_id.to_string());
            let line = claude_tool_result_line(
                &session_id,
                question_id,
                "User rejected the question.",
                true,
            );
            sender
                .send(line)
                .map_err(|_| SandboxError::InvalidRequest {
                    message: "Claude session is not active".to_string(),
                })?;
        } else {
            // TODO: Forward question rejections to subprocess agents.
        }

        if let Some(pending) = pending_question {
            let resolved = EventConversion::new(
                UniversalEventType::QuestionResolved,
                UniversalEventData::Question(QuestionEventData {
                    question_id: question_id.to_string(),
                    prompt: pending.prompt,
                    options: pending.options,
                    response: None,
                    status: QuestionStatus::Rejected,
                }),
            )
            .synthetic()
            .with_native_session(native_session_id);
            let _ = self.record_conversions(session_id, vec![resolved]).await;
        }

        Ok(())
    }

    pub(crate) async fn reply_permission(
        self: &Arc<Self>,
        session_id: &str,
        permission_id: &str,
        reply: PermissionReply,
    ) -> Result<(), SandboxError> {
        let reply_for_status = reply.clone();
        let (agent, native_session_id, pending_permission, claude_sender) = {
            let mut sessions = self.sessions.lock().await;
            let session = Self::session_mut(&mut sessions, session_id).ok_or_else(|| {
                SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                }
            })?;
            let pending = session.take_permission(permission_id);
            if pending.is_none() {
                return Err(SandboxError::InvalidRequest {
                    message: format!("unknown permission id: {permission_id}"),
                });
            }
            if let Some(err) = session.ended_error() {
                return Err(err);
            }
            (
                session.agent,
                session.native_session_id.clone(),
                pending,
                session.claude_sender(),
            )
        };

        if agent == AgentId::Codex {
            // Use the shared Codex server to send the permission reply
            let server = self.ensure_codex_server().await?;
            let pending =
                pending_permission
                    .clone()
                    .ok_or_else(|| SandboxError::InvalidRequest {
                        message: "missing codex permission metadata".to_string(),
                    })?;
            let metadata = pending.metadata.clone().unwrap_or(Value::Null);
            let request_id = codex_request_id_from_metadata(&metadata)
                .or_else(|| codex_request_id_from_string(permission_id))
                .ok_or_else(|| SandboxError::InvalidRequest {
                    message: "invalid codex permission request id".to_string(),
                })?;
            let request_kind = metadata
                .get("codexRequestKind")
                .and_then(Value::as_str)
                .unwrap_or("");
            let response_value = match request_kind {
                "commandExecution" => {
                    let decision = codex_command_decision_for_reply(reply.clone());
                    let response =
                        codex_schema::CommandExecutionRequestApprovalResponse { decision };
                    serde_json::to_value(response).map_err(|err| SandboxError::InvalidRequest {
                        message: err.to_string(),
                    })?
                }
                "fileChange" => {
                    let decision = codex_file_change_decision_for_reply(reply.clone());
                    let response = codex_schema::FileChangeRequestApprovalResponse { decision };
                    serde_json::to_value(response).map_err(|err| SandboxError::InvalidRequest {
                        message: err.to_string(),
                    })?
                }
                _ => {
                    return Err(SandboxError::InvalidRequest {
                        message: "unsupported codex permission request".to_string(),
                    });
                }
            };
            let response = codex_schema::JsonrpcResponse {
                id: request_id,
                result: response_value,
            };
            let line =
                serde_json::to_string(&response).map_err(|err| SandboxError::InvalidRequest {
                    message: err.to_string(),
                })?;
            server
                .stdin_sender
                .send(line)
                .map_err(|_| SandboxError::InvalidRequest {
                    message: "codex server not active".to_string(),
                })?;
        } else if agent == AgentId::Opencode {
            let agent_session_id =
                native_session_id
                    .clone()
                    .ok_or_else(|| SandboxError::InvalidRequest {
                        message: "missing OpenCode session id".to_string(),
                    })?;
            self.opencode_permission_reply(&agent_session_id, permission_id, reply.clone())
                .await?;
        } else if agent == AgentId::Claude {
            let sender = claude_sender.ok_or_else(|| SandboxError::InvalidRequest {
                message: "Claude session is not active".to_string(),
            })?;
            let metadata = pending_permission
                .as_ref()
                .and_then(|pending| pending.metadata.as_ref())
                .and_then(Value::as_object);
            let updated_input = metadata
                .and_then(|map| map.get("input"))
                .cloned()
                .unwrap_or(Value::Null);

            let mut response_map = serde_json::Map::new();
            match reply {
                PermissionReply::Reject => {
                    response_map.insert(
                        "message".to_string(),
                        Value::String("Permission denied.".to_string()),
                    );
                }
                PermissionReply::Once | PermissionReply::Always => {
                    if !updated_input.is_null() {
                        response_map.insert("updatedInput".to_string(), updated_input);
                    }
                }
            }
            let response_value = Value::Object(response_map);

            let behavior = match reply {
                PermissionReply::Reject => "deny",
                PermissionReply::Once | PermissionReply::Always => "allow",
            };

            let line = claude_control_response_line(permission_id, behavior, response_value);
            sender
                .send(line)
                .map_err(|_| SandboxError::InvalidRequest {
                    message: "Claude session is not active".to_string(),
                })?;
        } else {
            // TODO: Forward permission replies to subprocess agents.
        }

        if let Some(pending) = pending_permission {
            let status = match reply_for_status {
                PermissionReply::Reject => PermissionStatus::Denied,
                PermissionReply::Once | PermissionReply::Always => PermissionStatus::Approved,
            };
            let resolved = EventConversion::new(
                UniversalEventType::PermissionResolved,
                UniversalEventData::Permission(PermissionEventData {
                    permission_id: permission_id.to_string(),
                    action: pending.action,
                    status,
                    metadata: pending.metadata,
                }),
            )
            .synthetic()
            .with_native_session(native_session_id);
            let _ = self.record_conversions(session_id, vec![resolved]).await;
        }

        Ok(())
    }

    /// Gets a session snapshot for sending a new message.
    /// Uses the `for_new_message` check which allows agents that support resumption
    /// (Claude, Amp, OpenCode) to continue after their process exits successfully.
    async fn session_snapshot_for_message(
        &self,
        session_id: &str,
    ) -> Result<SessionSnapshot, SandboxError> {
        let sessions = self.sessions.lock().await;
        let session = Self::session_ref(&sessions, session_id).ok_or_else(|| {
            SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            }
        })?;
        if let Some(err) = session.ended_error_for_messages(true) {
            return Err(err);
        }
        Ok(SessionSnapshot::from(session))
    }

    async fn send_mock_message(
        self: &Arc<Self>,
        session_id: String,
        message: String,
    ) -> Result<(), SandboxError> {
        let prefix = {
            let mut sessions = self.sessions.lock().await;
            let session = Self::session_mut(&mut sessions, &session_id).ok_or_else(|| {
                SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                }
            })?;
            if let Some(err) = session.ended_error() {
                return Err(err);
            }
            session.mock_sequence = session.mock_sequence.saturating_add(1);
            format!("mock_{}", session.mock_sequence)
        };

        let mut conversions = Vec::new();
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            conversions.extend(mock_user_message(&prefix, trimmed));
        }
        conversions.extend(mock_command_conversions(&prefix, trimmed));

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            manager.emit_mock_events(session_id, conversions).await;
        });

        Ok(())
    }

    async fn emit_mock_events(
        self: Arc<Self>,
        session_id: String,
        conversions: Vec<EventConversion>,
    ) {
        for conversion in conversions {
            if self
                .record_conversions(&session_id, vec![conversion])
                .await
                .is_err()
            {
                return;
            }
            sleep(Duration::from_millis(MOCK_EVENT_DELAY_MS)).await;
        }
    }

    async fn consume_spawn(
        self: Arc<Self>,
        session_id: String,
        agent: AgentId,
        spawn: StreamingSpawn,
        initial_input: Option<String>,
    ) {
        let StreamingSpawn {
            mut child,
            stdin,
            stdout,
            stderr,
            codex_options,
        } = spawn;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let mut codex_state = codex_options
            .filter(|_| agent == AgentId::Codex)
            .map(CodexAppServerState::new);
        let mut codex_sender: Option<mpsc::UnboundedSender<String>> = None;
        let mut terminate_early = false;

        if let Some(stdout) = stdout {
            let tx_stdout = tx.clone();
            tokio::task::spawn_blocking(move || {
                read_lines(stdout, tx_stdout);
            });
        }
        if let Some(stderr) = stderr {
            let tx_stderr = tx.clone();
            tokio::task::spawn_blocking(move || {
                read_lines(stderr, tx_stderr);
            });
        }
        drop(tx);

        if agent == AgentId::Codex {
            if let Some(stdin) = stdin {
                let (writer_tx, writer_rx) = mpsc::unbounded_channel::<String>();
                codex_sender = Some(writer_tx.clone());
                {
                    let mut sessions = self.sessions.lock().await;
                    if let Some(session) = Self::session_mut(&mut sessions, &session_id) {
                        session.set_codex_sender(Some(writer_tx));
                    }
                }
                tokio::task::spawn_blocking(move || {
                    write_lines(stdin, writer_rx);
                });
            }
            if let (Some(state), Some(sender)) = (codex_state.as_mut(), codex_sender.as_ref()) {
                state.start(sender);
            }
        } else if agent == AgentId::Claude {
            if let Some(stdin) = stdin {
                let (writer_tx, writer_rx) = mpsc::unbounded_channel::<String>();
                {
                    let mut sessions = self.sessions.lock().await;
                    if let Some(session) = Self::session_mut(&mut sessions, &session_id) {
                        session.set_claude_sender(Some(writer_tx.clone()));
                    }
                }
                if let Some(initial) = initial_input {
                    let _ = writer_tx.send(initial);
                }
                tokio::task::spawn_blocking(move || {
                    write_lines(stdin, writer_rx);
                });
            }
        }

        while let Some(line) = rx.recv().await {
            if agent == AgentId::Codex {
                if let Some(state) = codex_state.as_mut() {
                    let outcome = state.handle_line(&line);
                    if !outcome.conversions.is_empty() {
                        let _ = self
                            .record_conversions(&session_id, outcome.conversions)
                            .await;
                    }
                    if outcome.should_terminate {
                        terminate_early = true;
                        break;
                    }
                }
            } else if agent == AgentId::Claude {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value.get("type").and_then(Value::as_str) == Some("result") {
                        let mut sessions = self.sessions.lock().await;
                        if let Some(session) = Self::session_mut(&mut sessions, &session_id) {
                            session.set_claude_sender(None);
                        }
                    }
                }
                let conversions = self.parse_claude_line(&line, &session_id).await;
                if !conversions.is_empty() {
                    let _ = self.record_conversions(&session_id, conversions).await;
                }
            } else {
                let conversions = parse_agent_line(agent, &line, &session_id);
                if !conversions.is_empty() {
                    let _ = self.record_conversions(&session_id, conversions).await;
                }
            }
        }

        if agent == AgentId::Codex {
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = Self::session_mut(&mut sessions, &session_id) {
                session.set_codex_sender(None);
            }
        } else if agent == AgentId::Claude {
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = Self::session_mut(&mut sessions, &session_id) {
                session.set_claude_sender(None);
            }
        }

        if terminate_early {
            let _ = child.kill();
        }
        let status = tokio::task::spawn_blocking(move || child.wait()).await;
        match status {
            Ok(Ok(status)) if status.success() => {
                if !agent_supports_resume(agent) {
                    let message = format!("agent exited with status {:?}", status);
                    self.mark_session_ended(
                        &session_id,
                        status.code(),
                        &message,
                        SessionEndReason::Completed,
                        TerminatedBy::Agent,
                        None,
                    )
                    .await;
                }
            }
            Ok(Ok(status)) => {
                let message = format!("agent exited with status {:?}", status);
                if !terminate_early {
                    self.record_error(
                        &session_id,
                        message.clone(),
                        Some("process_exit".to_string()),
                        None,
                    )
                    .await;
                }
                let logs = self.read_agent_stderr(agent);
                self.mark_session_ended(
                    &session_id,
                    status.code(),
                    &message,
                    SessionEndReason::Error,
                    TerminatedBy::Agent,
                    logs,
                )
                .await;
            }
            Ok(Err(err)) => {
                let message = format!("failed to wait for agent: {err}");
                if !terminate_early {
                    self.record_error(
                        &session_id,
                        message.clone(),
                        Some("process_wait_failed".to_string()),
                        None,
                    )
                    .await;
                }
                let logs = self.read_agent_stderr(agent);
                self.mark_session_ended(
                    &session_id,
                    None,
                    &message,
                    SessionEndReason::Error,
                    TerminatedBy::Daemon,
                    logs,
                )
                .await;
            }
            Err(err) => {
                let message = format!("failed to join agent task: {err}");
                if !terminate_early {
                    self.record_error(
                        &session_id,
                        message.clone(),
                        Some("process_wait_failed".to_string()),
                        None,
                    )
                    .await;
                }
                let logs = self.read_agent_stderr(agent);
                self.mark_session_ended(
                    &session_id,
                    None,
                    &message,
                    SessionEndReason::Error,
                    TerminatedBy::Daemon,
                    logs,
                )
                .await;
            }
        }
    }

    async fn record_conversions(
        &self,
        session_id: &str,
        conversions: Vec<EventConversion>,
    ) -> Result<Vec<UniversalEvent>, SandboxError> {
        let mut sessions = self.sessions.lock().await;
        let session = Self::session_mut(&mut sessions, session_id).ok_or_else(|| {
            SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            }
        })?;
        Ok(session.record_conversions(conversions))
    }

    async fn parse_claude_line(&self, line: &str, session_id: &str) -> Vec<EventConversion> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        let mut value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                return vec![agent_unparsed(
                    "claude",
                    &err.to_string(),
                    Value::String(trimmed.to_string()),
                )];
            }
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let native_session_id = value
            .get("session_id")
            .and_then(Value::as_str)
            .or_else(|| value.get("sessionId").and_then(Value::as_str))
            .map(|id| id.to_string());
        if event_type == "assistant" || event_type == "result" || native_session_id.is_some() {
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = Self::session_mut(&mut sessions, session_id) {
                if let Some(native_session_id) = native_session_id.as_ref() {
                    if session.native_session_id.is_none() {
                        session.native_session_id = Some(native_session_id.clone());
                    }
                }
                if event_type == "assistant" {
                    let id = value
                        .get("message")
                        .and_then(|message| message.get("id"))
                        .and_then(Value::as_str)
                        .map(|id| id.to_string())
                        .unwrap_or_else(|| {
                            session.claude_message_counter += 1;
                            let generated = format!(
                                "{}_message_{}",
                                session.session_id, session.claude_message_counter
                            );
                            if let Some(message) =
                                value.get_mut("message").and_then(Value::as_object_mut)
                            {
                                message.insert("id".to_string(), Value::String(generated.clone()));
                            } else if let Some(map) = value.as_object_mut() {
                                map.insert(
                                    "message".to_string(),
                                    serde_json::json!({
                                        "id": generated
                                    }),
                                );
                            }
                            generated
                        });
                    session.last_claude_message_id = Some(id);
                } else if event_type == "result" {
                    let has_message_id =
                        value.get("message_id").is_some() || value.get("messageId").is_some();
                    if !has_message_id {
                        let id = session.last_claude_message_id.take().unwrap_or_else(|| {
                            session.claude_message_counter += 1;
                            format!(
                                "{}_message_{}",
                                session.session_id, session.claude_message_counter
                            )
                        });
                        if let Some(map) = value.as_object_mut() {
                            map.insert("message_id".to_string(), Value::String(id));
                        }
                    } else {
                        session.last_claude_message_id = None;
                    }
                }
            }
        }

        convert_claude::event_to_universal_with_session(&value, session_id.to_string())
            .unwrap_or_else(|err| vec![agent_unparsed("claude", &err, value)])
    }

    async fn record_error(
        &self,
        session_id: &str,
        message: String,
        kind: Option<String>,
        details: Option<Value>,
    ) {
        let error = ErrorData {
            message,
            code: kind,
            details,
        };
        let conversion =
            EventConversion::new(UniversalEventType::Error, UniversalEventData::Error(error))
                .synthetic();
        let _ = self.record_conversions(session_id, vec![conversion]).await;
    }

    async fn mark_session_ended(
        &self,
        session_id: &str,
        exit_code: Option<i32>,
        message: &str,
        reason: SessionEndReason,
        terminated_by: TerminatedBy,
        stderr: Option<StderrOutput>,
    ) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = Self::session_mut(&mut sessions, session_id) {
            if session.ended {
                return;
            }
            session.mark_ended(
                exit_code,
                message.to_string(),
                reason.clone(),
                terminated_by.clone(),
            );
            let (error_message, error_exit_code, error_stderr) =
                if reason == SessionEndReason::Error {
                    (Some(message.to_string()), exit_code, stderr)
                } else {
                    (None, None, None)
                };
            let ended = EventConversion::new(
                UniversalEventType::SessionEnded,
                UniversalEventData::SessionEnded(SessionEndedData {
                    reason,
                    terminated_by,
                    message: error_message,
                    exit_code: error_exit_code,
                    stderr: error_stderr,
                }),
            )
            .synthetic()
            .with_native_session(session.native_session_id.clone());
            session.record_conversions(vec![ended]);
        }
    }

    async fn ensure_opencode_stream(
        self: &Arc<Self>,
        session_id: String,
    ) -> Result<(), SandboxError> {
        let native_session_id =
            {
                let mut sessions = self.sessions.lock().await;
                let session = Self::session_mut(&mut sessions, &session_id).ok_or_else(|| {
                    SandboxError::SessionNotFound {
                        session_id: session_id.clone(),
                    }
                })?;
                if session.opencode_stream_started {
                    return Ok(());
                }
                let native_session_id = session.native_session_id.clone().ok_or_else(|| {
                    SandboxError::InvalidRequest {
                        message: "missing OpenCode session id".to_string(),
                    }
                })?;
                session.opencode_stream_started = true;
                native_session_id
            };

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            manager
                .stream_opencode_events(session_id, native_session_id)
                .await;
        });

        Ok(())
    }

    async fn stream_opencode_events(
        self: Arc<Self>,
        session_id: String,
        native_session_id: String,
    ) {
        let base_url = match self.ensure_opencode_server().await {
            Ok(base_url) => base_url,
            Err(err) => {
                self.record_error(
                    &session_id,
                    format!("failed to start OpenCode server: {err}"),
                    Some("opencode_server".to_string()),
                    None,
                )
                .await;
                let logs = self.read_agent_stderr(AgentId::Opencode);
                self.mark_session_ended(
                    &session_id,
                    None,
                    "opencode server unavailable",
                    SessionEndReason::Error,
                    TerminatedBy::Daemon,
                    logs,
                )
                .await;
                return;
            }
        };

        let url = format!("{base_url}/event/subscribe");
        let response = match self.http_client.get(url).send().await {
            Ok(response) => response,
            Err(err) => {
                self.record_error(
                    &session_id,
                    format!("OpenCode SSE connection failed: {err}"),
                    Some("opencode_stream".to_string()),
                    None,
                )
                .await;
                let logs = self.read_agent_stderr(AgentId::Opencode);
                self.mark_session_ended(
                    &session_id,
                    None,
                    "opencode sse connection failed",
                    SessionEndReason::Error,
                    TerminatedBy::Daemon,
                    logs,
                )
                .await;
                return;
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            self.record_error(
                &session_id,
                format!("OpenCode SSE error {status}: {body}"),
                Some("opencode_stream".to_string()),
                None,
            )
            .await;
            let logs = self.read_agent_stderr(AgentId::Opencode);
            self.mark_session_ended(
                &session_id,
                None,
                "opencode sse error",
                SessionEndReason::Error,
                TerminatedBy::Daemon,
                logs,
            )
            .await;
            return;
        }

        let mut accumulator = SseAccumulator::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(err) => {
                    self.record_error(
                        &session_id,
                        format!("OpenCode SSE stream error: {err}"),
                        Some("opencode_stream".to_string()),
                        None,
                    )
                    .await;
                    let logs = self.read_agent_stderr(AgentId::Opencode);
                    self.mark_session_ended(
                        &session_id,
                        None,
                        "opencode sse stream error",
                        SessionEndReason::Error,
                        TerminatedBy::Daemon,
                        logs,
                    )
                    .await;
                    return;
                }
            };
            let text = String::from_utf8_lossy(&chunk);
            for event_payload in accumulator.push(&text) {
                let value: Value = match serde_json::from_str(&event_payload) {
                    Ok(value) => value,
                    Err(err) => {
                        let conversion = agent_unparsed(
                            "opencode",
                            &err.to_string(),
                            Value::String(event_payload.clone()),
                        );
                        let _ = self.record_conversions(&session_id, vec![conversion]).await;
                        continue;
                    }
                };
                if !opencode_event_matches_session(&value, &native_session_id) {
                    continue;
                }
                let conversions = match serde_json::from_value(value.clone()) {
                    Ok(event) => match convert_opencode::event_to_universal(&event) {
                        Ok(conversions) => conversions,
                        Err(err) => vec![agent_unparsed("opencode", &err, value.clone())],
                    },
                    Err(err) => vec![agent_unparsed("opencode", &err.to_string(), value.clone())],
                };
                let _ = self.record_conversions(&session_id, conversions).await;
            }
        }
    }

    async fn ensure_opencode_server(&self) -> Result<String, SandboxError> {
        self.server_manager
            .ensure_http_server(AgentId::Opencode)
            .await
    }

    /// Ensures a shared Codex app-server process is running.
    /// Spawns the process if not already running, sets up stdin/stdout tasks,
    /// and performs the initialize handshake if needed.
    async fn ensure_codex_server(self: &Arc<Self>) -> Result<Arc<CodexServer>, SandboxError> {
        let (server, receiver) = self
            .server_manager
            .ensure_stdio_server(AgentId::Codex)
            .await?;

        if let Some(stdout_rx) = receiver {
            let server_for_task = server.clone();
            let self_for_task = Arc::clone(self);
            tokio::spawn(async move {
                self_for_task
                    .handle_codex_server_output(server_for_task, stdout_rx)
                    .await;
            });
        }

        self.codex_server_initialize(&server).await?;

        Ok(server)
    }

    /// Handles output from the Codex app-server, routing responses and notifications.
    async fn handle_codex_server_output(
        self: Arc<Self>,
        server: Arc<CodexServer>,
        mut stdout_rx: mpsc::UnboundedReceiver<String>,
    ) {
        while let Some(line) = stdout_rx.recv().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let value: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let message: codex_schema::JsonrpcMessage = match serde_json::from_value(value.clone())
            {
                Ok(m) => m,
                Err(_) => continue,
            };

            match message {
                codex_schema::JsonrpcMessage::Response(response) => {
                    // Route response to waiting request
                    if let Some(id) = codex_request_id_to_i64(&response.id) {
                        server.complete_request(id, response.result.clone());
                    }
                }
                codex_schema::JsonrpcMessage::Notification(_) => {
                    // Route notification to correct session by thread_id
                    if let Ok(notification) =
                        serde_json::from_value::<codex_schema::ServerNotification>(value.clone())
                    {
                        if let Some(thread_id) =
                            codex_thread_id_from_server_notification(&notification)
                        {
                            if let Some(session_id) = server.session_for_thread(&thread_id) {
                                let conversions =
                                    match convert_codex::notification_to_universal(&notification) {
                                        Ok(c) => c,
                                        Err(err) => {
                                            vec![agent_unparsed("codex", &err, value.clone())]
                                        }
                                    };
                                let _ = self.record_conversions(&session_id, conversions).await;
                            }
                        }
                    }
                }
                codex_schema::JsonrpcMessage::Request(_) => {
                    // Handle server requests (permission requests)
                    if let Ok(request) =
                        serde_json::from_value::<codex_schema::ServerRequest>(value.clone())
                    {
                        if let Some(thread_id) = codex_thread_id_from_server_request(&request) {
                            if let Some(session_id) = server.session_for_thread(&thread_id) {
                                match codex_request_to_universal(&request) {
                                    Ok(mut conversions) => {
                                        for conversion in &mut conversions {
                                            conversion.raw = Some(value.clone());
                                        }
                                        let _ =
                                            self.record_conversions(&session_id, conversions).await;
                                    }
                                    Err(err) => {
                                        let _ = self
                                            .record_conversions(
                                                &session_id,
                                                vec![agent_unparsed("codex", &err, value.clone())],
                                            )
                                            .await;
                                    }
                                }
                            }
                        }
                    }
                }
                codex_schema::JsonrpcMessage::Error(error) => {
                    // Log error but don't have a session to route to
                    eprintln!("Codex server error: {:?}", error);
                }
            }
        }
    }

    /// Performs the initialize/initialized handshake with the Codex server.
    async fn codex_server_initialize(&self, server: &CodexServer) -> Result<(), SandboxError> {
        if server.is_initialized() {
            return Ok(());
        }

        let id = server.next_request_id();
        let request = codex_schema::ClientRequest::Initialize {
            id: codex_schema::RequestId::from(id),
            params: codex_schema::InitializeParams {
                client_info: codex_schema::ClientInfo {
                    name: "sandbox-agent".to_string(),
                    title: Some("sandbox-agent".to_string()),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                },
            },
        };

        let rx = server
            .send_request(id, &request)
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to send initialize request".to_string(),
            })?;

        // Wait for initialize response with timeout
        let result = tokio::time::timeout(Duration::from_secs(30), rx).await;
        match result {
            Ok(Ok(_)) => {
                // Send initialized notification
                let notification = codex_schema::JsonrpcNotification {
                    method: "initialized".to_string(),
                    params: None,
                };
                server.send_notification(&notification);
                server.set_initialized();
                Ok(())
            }
            Ok(Err(_)) => Err(SandboxError::StreamError {
                message: "initialize request cancelled".to_string(),
            }),
            Err(_) => Err(SandboxError::StreamError {
                message: "initialize request timed out".to_string(),
            }),
        }
    }

    /// Creates a new Codex thread/session via the shared app-server.
    async fn create_codex_thread(
        self: &Arc<Self>,
        session_id: &str,
        session: &SessionSnapshot,
    ) -> Result<String, SandboxError> {
        let server = self.ensure_codex_server().await?;

        let id = server.next_request_id();
        let mut params = codex_schema::ThreadStartParams::default();
        params.approval_policy = codex_approval_policy(Some(&session.permission_mode));
        params.sandbox = codex_sandbox_mode(Some(&session.permission_mode));
        params.model = session.model.clone();

        let request = codex_schema::ClientRequest::ThreadStart {
            id: codex_schema::RequestId::from(id),
            params,
        };

        let rx = server
            .send_request(id, &request)
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to send thread/start request".to_string(),
            })?;

        // Wait for thread/start response
        let result = tokio::time::timeout(Duration::from_secs(30), rx).await;
        match result {
            Ok(Ok(response)) => {
                // Extract thread_id from response
                let thread_id = response
                    .get("thread")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .or_else(|| response.get("threadId").and_then(Value::as_str))
                    .ok_or_else(|| SandboxError::StreamError {
                        message: "thread/start response missing thread id".to_string(),
                    })?
                    .to_string();

                // Register thread -> session mapping
                server.register_thread(thread_id.clone(), session_id.to_string());

                Ok(thread_id)
            }
            Ok(Err(_)) => Err(SandboxError::StreamError {
                message: "thread/start request cancelled".to_string(),
            }),
            Err(_) => Err(SandboxError::StreamError {
                message: "thread/start request timed out".to_string(),
            }),
        }
    }

    /// Sends a turn/start request to an existing Codex thread.
    async fn send_codex_turn(
        self: &Arc<Self>,
        session: &SessionSnapshot,
        prompt: &str,
    ) -> Result<(), SandboxError> {
        let server = self.ensure_codex_server().await?;

        let thread_id =
            session
                .native_session_id
                .as_ref()
                .ok_or_else(|| SandboxError::InvalidRequest {
                    message: "missing Codex thread id".to_string(),
                })?;

        let id = server.next_request_id();
        let prompt_text = codex_prompt_for_mode(prompt, Some(&session.agent_mode));
        let params = codex_schema::TurnStartParams {
            approval_policy: codex_approval_policy(Some(&session.permission_mode)),
            collaboration_mode: None,
            cwd: None,
            effort: codex_effort_from_variant(session.variant.as_deref()),
            input: vec![codex_schema::UserInput::Text {
                text: prompt_text,
                text_elements: Vec::new(),
            }],
            model: session.model.clone(),
            output_schema: None,
            sandbox_policy: codex_sandbox_policy(Some(&session.permission_mode)),
            summary: None,
            thread_id: thread_id.clone(),
        };

        let request = codex_schema::ClientRequest::TurnStart {
            id: codex_schema::RequestId::from(id),
            params,
        };

        // Send but don't wait for response - notifications will stream back
        server
            .send_request(id, &request)
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to send turn/start request".to_string(),
            })?;

        Ok(())
    }

    async fn fetch_opencode_modes(&self) -> Result<Vec<AgentModeInfo>, SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let endpoints = [
            format!("{base_url}/app/agents"),
            format!("{base_url}/agents"),
        ];
        for url in endpoints {
            let response = self.http_client.get(&url).send().await;
            let response = match response {
                Ok(response) => response,
                Err(_) => continue,
            };
            if !response.status().is_success() {
                continue;
            }
            let value: Value = response
                .json()
                .await
                .map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;
            let modes = parse_opencode_modes(&value);
            if !modes.is_empty() {
                return Ok(modes);
            }
        }
        Err(SandboxError::StreamError {
            message: "OpenCode agent modes unavailable".to_string(),
        })
    }

    async fn fetch_claude_models(&self) -> Result<AgentModelsResponse, SandboxError> {
        let credentials = self.extract_credentials().await?;
        let Some(cred) = credentials.anthropic else {
            return Ok(AgentModelsResponse {
                models: Vec::new(),
                default_model: None,
            });
        };

        let headers = build_anthropic_headers(&cred)?;
        let response = self
            .http_client
            .get(ANTHROPIC_MODELS_URL)
            .headers(headers)
            .send()
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(SandboxError::StreamError {
                message: format!("Anthropic models request failed {status}: {body}"),
            });
        }

        let value: Value = response
            .json()
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut models = Vec::new();
        let mut default_model: Option<String> = None;
        let mut default_created: Option<String> = None;
        for item in data {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = item
                .get("display_name")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let created = item
                .get("created_at")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            if let Some(created) = created.as_ref() {
                let should_update = match default_created.as_deref() {
                    Some(current) => created.as_str() > current,
                    None => true,
                };
                if should_update {
                    default_created = Some(created.clone());
                    default_model = Some(id.to_string());
                }
            }
            models.push(AgentModelInfo {
                id: id.to_string(),
                name,
                variants: None,
                default_variant: None,
            });
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));
        if default_model.is_none() {
            default_model = models.first().map(|model| model.id.clone());
        }

        Ok(AgentModelsResponse {
            models,
            default_model,
        })
    }

    async fn fetch_codex_models(self: &Arc<Self>) -> Result<AgentModelsResponse, SandboxError> {
        let server = self.ensure_codex_server().await?;
        let mut models: Vec<AgentModelInfo> = Vec::new();
        let mut default_model: Option<String> = None;
        let mut seen = HashSet::new();
        let mut cursor: Option<String> = None;

        loop {
            let id = server.next_request_id();
            let request = json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "model/list",
                "params": {
                    "cursor": cursor,
                    "limit": null
                }
            });
            let rx = server
                .send_request(id, &request)
                .ok_or_else(|| SandboxError::StreamError {
                    message: "failed to send model/list request".to_string(),
                })?;

            let result = tokio::time::timeout(Duration::from_secs(30), rx).await;
            let value = match result {
                Ok(Ok(value)) => value,
                Ok(Err(_)) => {
                    return Err(SandboxError::StreamError {
                        message: "model/list request cancelled".to_string(),
                    })
                }
                Err(_) => {
                    return Err(SandboxError::StreamError {
                        message: "model/list request timed out".to_string(),
                    })
                }
            };

            let data = value
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            for item in data {
                let model_id = item
                    .get("model")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("id").and_then(Value::as_str));
                let Some(model_id) = model_id else {
                    continue;
                };
                if !seen.insert(model_id.to_string()) {
                    continue;
                }

                let name = item
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string());
                let default_variant = item
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string());
                let mut variants: Vec<String> = item
                    .get("supportedReasoningEfforts")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| {
                                value
                                    .get("reasoningEffort")
                                    .and_then(Value::as_str)
                                    .or_else(|| value.as_str())
                                    .map(|entry| entry.to_string())
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if variants.is_empty() {
                    variants = codex_variants();
                }
                variants.sort();
                variants.dedup();

                if default_model.is_none()
                    && item
                        .get("isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    default_model = Some(model_id.to_string());
                }

                models.push(AgentModelInfo {
                    id: model_id.to_string(),
                    name,
                    variants: Some(variants),
                    default_variant,
                });
            }

            let next_cursor = value
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            if next_cursor.is_none() {
                break;
            }
            cursor = next_cursor;
        }

        models.sort_by(|a, b| a.id.cmp(&b.id));
        if default_model.is_none() {
            default_model = models.first().map(|model| model.id.clone());
        }

        Ok(AgentModelsResponse {
            models,
            default_model,
        })
    }

    async fn fetch_opencode_models(&self) -> Result<AgentModelsResponse, SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let endpoints = [
            format!("{base_url}/config/providers"),
            format!("{base_url}/provider"),
        ];
        for url in endpoints {
            let response = self.http_client.get(&url).send().await;
            let response = match response {
                Ok(response) => response,
                Err(_) => continue,
            };
            if !response.status().is_success() {
                continue;
            }
            let value: Value = response
                .json()
                .await
                .map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;
            if let Some(models) = parse_opencode_models(&value) {
                return Ok(models);
            }
        }
        Err(SandboxError::StreamError {
            message: "OpenCode models unavailable".to_string(),
        })
    }

    async fn extract_credentials(&self) -> Result<ExtractedCredentials, SandboxError> {
        tokio::task::spawn_blocking(move || {
            let options = CredentialExtractionOptions::new();
            extract_all_credentials(&options)
        })
        .await
        .map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })
    }

    async fn create_opencode_session(&self) -> Result<String, SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let url = format!("{base_url}/session");
        for _ in 0..10 {
            let response = self.http_client.post(&url).json(&json!({})).send().await;
            let response = match response {
                Ok(response) => response,
                Err(_) => {
                    sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            if !response.status().is_success() {
                sleep(Duration::from_millis(200)).await;
                continue;
            }
            let value: Value = response
                .json()
                .await
                .map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                return Ok(id.to_string());
            }
            if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
                return Ok(id.to_string());
            }
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                return Ok(id.to_string());
            }
            return Err(SandboxError::StreamError {
                message: format!("OpenCode session response missing id: {value}"),
            });
        }
        Err(SandboxError::StreamError {
            message: "OpenCode session create failed after retries".to_string(),
        })
    }

    async fn send_opencode_prompt(
        &self,
        session: &SessionSnapshot,
        prompt: &str,
    ) -> Result<(), SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let session_id =
            session
                .native_session_id
                .as_ref()
                .ok_or_else(|| SandboxError::InvalidRequest {
                    message: "missing OpenCode session id".to_string(),
                })?;
        let url = format!("{base_url}/session/{session_id}/prompt");
        let mut body = json!({
            "agent": session.agent_mode.clone(),
            "parts": [{ "type": "text", "text": prompt }]
        });
        if let Some(model) = session.model.as_deref() {
            if let Some((provider, model_id)) = model.split_once('/') {
                body["model"] = json!({
                    "providerID": provider,
                    "modelID": model_id
                });
            } else {
                body["model"] = json!({ "modelID": model });
            }
        }
        if let Some(variant) = session.variant.as_deref() {
            body["variant"] = json!(variant);
        }

        let response = self
            .http_client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(SandboxError::StreamError {
                message: format!("OpenCode prompt failed {status}: {body}"),
            });
        }

        Ok(())
    }

    async fn opencode_question_reply(
        &self,
        _session_id: &str,
        request_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let url = format!("{base_url}/question/reply");
        let response = self
            .http_client
            .post(url)
            .json(&json!({
                "requestID": request_id,
                "answers": answers
            }))
            .send()
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(SandboxError::StreamError {
                message: format!("OpenCode question reply failed {status}: {body}"),
            });
        }
        Ok(())
    }

    async fn opencode_question_reject(
        &self,
        _session_id: &str,
        request_id: &str,
    ) -> Result<(), SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let url = format!("{base_url}/question/reject");
        let response = self
            .http_client
            .post(url)
            .json(&json!({ "requestID": request_id }))
            .send()
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(SandboxError::StreamError {
                message: format!("OpenCode question reject failed {status}: {body}"),
            });
        }
        Ok(())
    }

    async fn opencode_permission_reply(
        &self,
        _session_id: &str,
        request_id: &str,
        reply: PermissionReply,
    ) -> Result<(), SandboxError> {
        let base_url = self.ensure_opencode_server().await?;
        let url = format!("{base_url}/permission/reply");
        let response = self
            .http_client
            .post(url)
            .json(&json!({
                "requestID": request_id,
                "reply": reply
            }))
            .send()
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(SandboxError::StreamError {
                message: format!("OpenCode permission reply failed {status}: {body}"),
            });
        }
        Ok(())
    }
}

async fn require_token(
    State(state): State<Arc<AppState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, ApiError> {
    let path = req.uri().path();
    if path == "/v1/health" || path == "/health" {
        return Ok(next.run(req).await);
    }

    let expected = match &state.auth.token {
        Some(token) => token.as_str(),
        None => return Ok(next.run(req).await),
    };

    let provided = extract_token(req.headers());
    if provided.as_deref() == Some(expected) {
        Ok(next.run(req).await)
    } else {
        Err(SandboxError::TokenInvalid {
            message: Some("missing or invalid token".to_string()),
        }
        .into())
    }
}

fn extract_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(value) = value.to_str() {
            let value = value.trim();
            if let Some((scheme, rest)) = value.split_once(' ') {
                let scheme_lower = scheme.to_ascii_lowercase();
                let rest = rest.trim();
                match scheme_lower.as_str() {
                    "bearer" | "token" => {
                        return Some(rest.to_string());
                    }
                    "basic" => {
                        let engines = [
                            base64::engine::general_purpose::STANDARD,
                            base64::engine::general_purpose::STANDARD_NO_PAD,
                            base64::engine::general_purpose::URL_SAFE,
                            base64::engine::general_purpose::URL_SAFE_NO_PAD,
                        ];
                        for engine in engines {
                            if let Ok(decoded) = engine.decode(rest) {
                                if let Ok(decoded_str) = String::from_utf8(decoded) {
                                    if let Some((_, password)) = decoded_str.split_once(':') {
                                        return Some(password.to_string());
                                    }
                                    if !decoded_str.is_empty() {
                                        return Some(decoded_str);
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    None
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reinstall: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentModeInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentModesResponse {
    pub modes: Vec<AgentModeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelsResponse {
    pub models: Vec<AgentModelInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    // TODO: add agent-agnostic tests that cover every capability flag here.
    pub plan_mode: bool,
    pub permissions: bool,
    pub questions: bool,
    pub tool_calls: bool,
    pub tool_results: bool,
    pub text_messages: bool,
    pub images: bool,
    pub file_attachments: bool,
    pub session_lifecycle: bool,
    pub error_events: bool,
    pub reasoning: bool,
    pub status: bool,
    pub command_execution: bool,
    pub file_changes: bool,
    pub mcp_tools: bool,
    pub streaming_deltas: bool,
    pub item_started: bool,
    pub variants: bool,
    /// Whether this agent uses a shared long-running server process (vs per-turn subprocess)
    pub shared_process: bool,
}

/// Status of a shared server process for an agent
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    /// Server is running and accepting requests
    Running,
    /// Server is not currently running
    Stopped,
    /// Server is running but unhealthy
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusInfo {
    pub status: ServerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<u64>,
    pub restart_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub capabilities: AgentCapabilities,
    /// Status of the shared server process (only present for agents with shared_process=true)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_status: Option<ServerStatusInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentListResponse {
    pub agents: Vec<AgentInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub agent: String,
    pub agent_mode: String,
    pub permission_mode: String,
    pub model: Option<String>,
    pub variant: Option<String>,
    pub native_session_id: Option<String>,
    pub ended: bool,
    pub event_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct SessionListResponse {
    pub sessions: Vec<SessionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub healthy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRequest {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "include_raw"
    )]
    pub include_raw: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStreamQuery {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "include_raw"
    )]
    pub include_raw: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventsResponse {
    pub events: Vec<UniversalEvent>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionReplyRequest {
    pub answers: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionReplyRequest {
    pub reply: PermissionReply,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PermissionReply {
    Once,
    Always,
    Reject,
}

impl std::str::FromStr for PermissionReply {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "once" => Ok(Self::Once),
            "always" => Ok(Self::Always),
            "reject" => Ok(Self::Reject),
            _ => Err(format!("invalid permission reply: {value}")),
        }
    }
}

#[utoipa::path(
    post,
    path = "/v1/agents/{agent}/install",
    request_body = AgentInstallRequest,
    responses(
        (status = 204, description = "Agent installed"),
        (status = 400, body = ProblemDetails),
        (status = 404, body = ProblemDetails),
        (status = 500, body = ProblemDetails)
    ),
    params(("agent" = String, Path, description = "Agent id")),
    tag = "agents"
)]
async fn install_agent(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Json(request): Json<AgentInstallRequest>,
) -> Result<StatusCode, ApiError> {
    let agent_id = parse_agent_id(&agent)?;
    let reinstall = request.reinstall.unwrap_or(false);
    let manager = state.agent_manager.clone();

    let result = tokio::task::spawn_blocking(move || {
        manager.install(
            agent_id,
            InstallOptions {
                reinstall,
                version: None,
            },
        )
    })
    .await
    .map_err(|err| SandboxError::InstallFailed {
        agent: agent.clone(),
        stderr: Some(err.to_string()),
    })?;

    result.map_err(|err| map_install_error(agent_id, err))?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/agents/{agent}/modes",
    responses(
        (status = 200, body = AgentModesResponse),
        (status = 400, body = ProblemDetails)
    ),
    params(("agent" = String, Path, description = "Agent id")),
    tag = "agents"
)]
async fn get_agent_modes(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
) -> Result<Json<AgentModesResponse>, ApiError> {
    let agent_id = parse_agent_id(&agent)?;
    let modes = state.session_manager.agent_modes(agent_id).await?;
    Ok(Json(AgentModesResponse { modes }))
}

#[utoipa::path(
    get,
    path = "/v1/agents/{agent}/models",
    responses(
        (status = 200, body = AgentModelsResponse),
        (status = 400, body = ProblemDetails)
    ),
    params(("agent" = String, Path, description = "Agent id")),
    tag = "agents"
)]
async fn get_agent_models(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
) -> Result<Json<AgentModelsResponse>, ApiError> {
    let agent_id = parse_agent_id(&agent)?;
    let models = state.session_manager.agent_models(agent_id).await?;
    Ok(Json(models))
}

const SERVER_INFO: &str = "\
This is a Sandbox Agent server. Available endpoints:\n\
  - GET  /           - Server info\n\
  - GET  /v1/health  - Health check\n\
  - GET  /ui/        - Inspector UI\n\n\
See https://sandboxagent.dev for API documentation.";

async fn get_root() -> &'static str {
    SERVER_INFO
}

async fn not_found() -> (StatusCode, String) {
    (
        StatusCode::NOT_FOUND,
        format!("404 Not Found\n\n{SERVER_INFO}"),
    )
}

#[utoipa::path(
    get,
    path = "/v1/health",
    responses((status = 200, body = HealthResponse)),
    tag = "meta"
)]
async fn get_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[utoipa::path(
    get,
    path = "/v1/agents",
    responses((status = 200, body = AgentListResponse)),
    tag = "agents"
)]
async fn list_agents(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AgentListResponse>, ApiError> {
    let manager = state.agent_manager.clone();
    let server_statuses = state.session_manager.server_manager.status_snapshot().await;

    let agents =
        tokio::task::spawn_blocking(move || {
            all_agents()
                .into_iter()
                .map(|agent_id| {
                    let installed = manager.is_installed(agent_id);
                    let version = manager.version(agent_id).ok().flatten();
                    let path = manager.resolve_binary(agent_id).ok();
                    let capabilities = agent_capabilities_for(agent_id);

                    // Add server_status for agents with shared processes
                    let server_status =
                        if capabilities.shared_process {
                            Some(server_statuses.get(&agent_id).cloned().unwrap_or(
                                ServerStatusInfo {
                                    status: ServerStatus::Stopped,
                                    base_url: None,
                                    uptime_ms: None,
                                    restart_count: 0,
                                    last_error: None,
                                },
                            ))
                        } else {
                            None
                        };

                    AgentInfo {
                        id: agent_id.as_str().to_string(),
                        installed,
                        version,
                        path: path.map(|path| path.to_string_lossy().to_string()),
                        capabilities,
                        server_status,
                    }
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;

    Ok(Json(AgentListResponse { agents }))
}

#[utoipa::path(
    get,
    path = "/v1/sessions",
    responses((status = 200, body = SessionListResponse)),
    tag = "sessions"
)]
async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionListResponse>, ApiError> {
    let sessions = state.session_manager.list_sessions().await;
    Ok(Json(SessionListResponse { sessions }))
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}",
    request_body = CreateSessionRequest,
    responses(
        (status = 200, body = CreateSessionResponse),
        (status = 400, body = ProblemDetails),
        (status = 409, body = ProblemDetails)
    ),
    params(("session_id" = String, Path, description = "Client session id")),
    tag = "sessions"
)]
async fn create_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, ApiError> {
    let response = state
        .session_manager
        .create_session(session_id, request)
        .await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}/messages",
    request_body = MessageRequest,
    responses(
        (status = 204, description = "Message accepted"),
        (status = 404, body = ProblemDetails)
    ),
    params(("session_id" = String, Path, description = "Session id")),
    tag = "sessions"
)]
async fn post_message(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(request): Json<MessageRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .session_manager
        .send_message(session_id, request.message)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}/messages/stream",
    request_body = MessageRequest,
    params(
        ("session_id" = String, Path, description = "Session id"),
        ("include_raw" = Option<bool>, Query, description = "Include raw provider payloads")
    ),
    responses(
        (status = 200, description = "SSE event stream"),
        (status = 404, body = ProblemDetails)
    ),
    tag = "sessions"
)]
async fn post_message_stream(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<TurnStreamQuery>,
    Json(request): Json<MessageRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let include_raw = query.include_raw.unwrap_or(false);
    let (snapshot, subscription) = state
        .session_manager
        .subscribe_for_turn(&session_id)
        .await?;
    state
        .session_manager
        .send_message(session_id, request.message)
        .await?;
    let stream = stream_turn_events(subscription, snapshot.agent, include_raw);
    Ok(Sse::new(stream))
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}/terminate",
    params(("session_id" = String, Path, description = "Session id")),
    responses(
        (status = 204, description = "Session terminated"),
        (status = 404, body = ProblemDetails)
    ),
    tag = "sessions"
)]
async fn terminate_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.session_manager.terminate_session(session_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/sessions/{session_id}/events",
    params(
        ("session_id" = String, Path, description = "Session id"),
        ("offset" = Option<u64>, Query, description = "Last seen event sequence (exclusive)"),
        ("limit" = Option<u64>, Query, description = "Max events to return"),
        ("include_raw" = Option<bool>, Query, description = "Include raw provider payloads")
    ),
    responses(
        (status = 200, body = EventsResponse),
        (status = 404, body = ProblemDetails)
    ),
    tag = "sessions"
)]
async fn get_events(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<EventsResponse>, ApiError> {
    let offset = query.offset.unwrap_or(0);
    let response = state
        .session_manager
        .events(
            &session_id,
            offset,
            query.limit,
            query.include_raw.unwrap_or(false),
        )
        .await?;
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v1/sessions/{session_id}/events/sse",
    params(
        ("session_id" = String, Path, description = "Session id"),
        ("offset" = Option<u64>, Query, description = "Last seen event sequence (exclusive)"),
        ("include_raw" = Option<bool>, Query, description = "Include raw provider payloads")
    ),
    responses((status = 200, description = "SSE event stream")),
    tag = "sessions"
)]
async fn get_events_sse(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let offset = query.offset.unwrap_or(0);
    let include_raw = query.include_raw.unwrap_or(false);
    let subscription = state.session_manager.subscribe(&session_id, offset).await?;
    let initial_events = subscription.initial_events;
    let receiver = subscription.receiver;

    let initial_stream = stream::iter(initial_events.into_iter().map(move |mut event| {
        if !include_raw {
            event.raw = None;
        }
        Ok::<Event, Infallible>(to_sse_event(event))
    }));

    let live_stream = BroadcastStream::new(receiver).filter_map(move |result| {
        let include_raw = include_raw;
        async move {
            match result {
                Ok(mut event) => {
                    if !include_raw {
                        event.raw = None;
                    }
                    Some(Ok::<Event, Infallible>(to_sse_event(event)))
                }
                Err(_) => None,
            }
        }
    });

    let stream = initial_stream.chain(live_stream);
    Ok(Sse::new(stream))
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}/questions/{question_id}/reply",
    request_body = QuestionReplyRequest,
    responses(
        (status = 204, description = "Question answered"),
        (status = 404, body = ProblemDetails)
    ),
    params(
        ("session_id" = String, Path, description = "Session id"),
        ("question_id" = String, Path, description = "Question id")
    ),
    tag = "sessions"
)]
async fn reply_question(
    State(state): State<Arc<AppState>>,
    Path((session_id, question_id)): Path<(String, String)>,
    Json(request): Json<QuestionReplyRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .session_manager
        .reply_question(&session_id, &question_id, request.answers)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}/questions/{question_id}/reject",
    responses(
        (status = 204, description = "Question rejected"),
        (status = 404, body = ProblemDetails)
    ),
    params(
        ("session_id" = String, Path, description = "Session id"),
        ("question_id" = String, Path, description = "Question id")
    ),
    tag = "sessions"
)]
async fn reject_question(
    State(state): State<Arc<AppState>>,
    Path((session_id, question_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state
        .session_manager
        .reject_question(&session_id, &question_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/v1/sessions/{session_id}/permissions/{permission_id}/reply",
    request_body = PermissionReplyRequest,
    responses(
        (status = 204, description = "Permission reply accepted"),
        (status = 404, body = ProblemDetails)
    ),
    params(
        ("session_id" = String, Path, description = "Session id"),
        ("permission_id" = String, Path, description = "Permission id")
    ),
    tag = "sessions"
)]
async fn reply_permission(
    State(state): State<Arc<AppState>>,
    Path((session_id, permission_id)): Path<(String, String)>,
    Json(request): Json<PermissionReplyRequest>,
) -> Result<StatusCode, ApiError> {
    state
        .session_manager
        .reply_permission(&session_id, &permission_id, request.reply)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn all_agents() -> [AgentId; 5] {
    [
        AgentId::Claude,
        AgentId::Codex,
        AgentId::Opencode,
        AgentId::Amp,
        AgentId::Mock,
    ]
}

/// Returns true if the agent supports resuming a session after its process exits.
/// These agents can use --resume/--continue to continue a conversation.
fn agent_supports_resume(agent: AgentId) -> bool {
    matches!(
        agent,
        AgentId::Claude | AgentId::Amp | AgentId::Opencode | AgentId::Codex
    )
}

fn agent_supports_item_started(agent: AgentId) -> bool {
    agent_capabilities_for(agent).item_started
}

fn agent_capabilities_for(agent: AgentId) -> AgentCapabilities {
    match agent {
        // Claude CLI supports tool calls/results and permission prompts via the SDK control protocol,
        // but we still emit synthetic item.started events.
        AgentId::Claude => AgentCapabilities {
            plan_mode: false,
            permissions: true,
            questions: true,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: false,
            file_attachments: false,
            session_lifecycle: false,
            error_events: false,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: false,
            streaming_deltas: true,
            item_started: false,
            variants: false,
            shared_process: false, // per-turn subprocess with --resume
        },
        AgentId::Codex => AgentCapabilities {
            plan_mode: true,
            permissions: true,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: true,
            status: true,
            command_execution: true,
            file_changes: true,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            variants: true,
            shared_process: true, // shared app-server via JSON-RPC
        },
        AgentId::Opencode => AgentCapabilities {
            plan_mode: false,
            permissions: false,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: false,
            status: true,
            command_execution: false,
            file_changes: false,
            mcp_tools: false,
            streaming_deltas: true,
            item_started: true,
            variants: true,
            shared_process: true, // shared HTTP server
        },
        AgentId::Amp => AgentCapabilities {
            plan_mode: false,
            permissions: false,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: false,
            file_attachments: false,
            session_lifecycle: false,
            error_events: true,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: false,
            streaming_deltas: false,
            item_started: false,
            variants: true,
            shared_process: false, // per-turn subprocess with --continue
        },
        AgentId::Mock => AgentCapabilities {
            plan_mode: true,
            permissions: true,
            questions: true,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: true,
            status: true,
            command_execution: true,
            file_changes: true,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            variants: false,
            shared_process: false, // in-memory mock (no subprocess)
        },
    }
}

fn parse_agent_id(agent: &str) -> Result<AgentId, SandboxError> {
    AgentId::parse(agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.to_string(),
    })
}

fn agent_modes_for(agent: AgentId) -> Vec<AgentModeInfo> {
    match agent {
        AgentId::Opencode => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Planning mode".to_string(),
            },
            AgentModeInfo {
                id: "custom".to_string(),
                name: "Custom".to_string(),
                description: "Any user-defined OpenCode agent name".to_string(),
            },
        ],
        AgentId::Codex => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Planning mode via prompt prefix".to_string(),
            },
        ],
        AgentId::Claude => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Plan mode (prompt-only)".to_string(),
            },
        ],
        AgentId::Amp => vec![AgentModeInfo {
            id: "build".to_string(),
            name: "Build".to_string(),
            description: "Default build mode".to_string(),
        }],
        AgentId::Mock => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Mock agent for UI testing".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Plan-only mock mode".to_string(),
            },
        ],
    }
}

fn amp_models_response() -> AgentModelsResponse {
    // NOTE: Amp models are hardcoded based on ampcode.com manual:
    // - smart
    // - rush
    // - deep
    // - free
    let models = ["smart", "rush", "deep", "free"]
        .into_iter()
        .map(|id| AgentModelInfo {
            id: id.to_string(),
            name: None,
            variants: Some(amp_variants()),
            default_variant: Some("medium".to_string()),
        })
        .collect();
    AgentModelsResponse {
        models,
        default_model: Some("smart".to_string()),
    }
}

fn mock_models_response() -> AgentModelsResponse {
    AgentModelsResponse {
        models: vec![AgentModelInfo {
            id: "mock".to_string(),
            name: Some("Mock".to_string()),
            variants: None,
            default_variant: None,
        }],
        default_model: Some("mock".to_string()),
    }
}

fn amp_variants() -> Vec<String> {
    vec!["medium", "high", "xhigh"]
        .into_iter()
        .map(|value| value.to_string())
        .collect()
}

fn codex_variants() -> Vec<String> {
    vec!["none", "minimal", "low", "medium", "high", "xhigh"]
        .into_iter()
        .map(|value| value.to_string())
        .collect()
}

fn parse_opencode_models(value: &Value) -> Option<AgentModelsResponse> {
    let providers = value
        .get("providers")
        .and_then(Value::as_array)
        .or_else(|| value.get("all").and_then(Value::as_array))?;
    let default_map = value
        .get("default")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut models = Vec::new();
    let mut provider_order = Vec::new();
    for provider in providers {
        let provider_id = provider.get("id").and_then(Value::as_str)?;
        provider_order.push(provider_id.to_string());
        let Some(model_map) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (key, model) in model_map {
            let model_id = model
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(key.as_str());
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let mut variants = model
                .get("variants")
                .and_then(Value::as_object)
                .map(|map| map.keys().cloned().collect::<Vec<_>>());
            if let Some(variants) = variants.as_mut() {
                variants.sort();
            }
            models.push(AgentModelInfo {
                id: format!("{provider_id}/{model_id}"),
                name,
                variants,
                default_variant: None,
            });
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));

    let mut default_model = None;
    for provider_id in provider_order {
        if let Some(model_id) = default_map
            .get(&provider_id)
            .and_then(Value::as_str)
        {
            default_model = Some(format!("{provider_id}/{model_id}"));
            break;
        }
    }
    if default_model.is_none() {
        default_model = models.first().map(|model| model.id.clone());
    }

    Some(AgentModelsResponse {
        models,
        default_model,
    })
}

fn normalize_agent_mode(agent: AgentId, agent_mode: Option<&str>) -> Result<String, SandboxError> {
    let mode = agent_mode.unwrap_or("build");
    match agent {
        AgentId::Opencode => Ok(mode.to_string()),
        AgentId::Codex => match mode {
            "build" | "plan" => Ok(mode.to_string()),
            value => Err(SandboxError::ModeNotSupported {
                agent: agent.as_str().to_string(),
                mode: value.to_string(),
            }
            .into()),
        },
        AgentId::Claude => match mode {
            "build" | "plan" => Ok(mode.to_string()),
            value => Err(SandboxError::ModeNotSupported {
                agent: agent.as_str().to_string(),
                mode: value.to_string(),
            }
            .into()),
        },
        AgentId::Amp => match mode {
            "build" => Ok("build".to_string()),
            value => Err(SandboxError::ModeNotSupported {
                agent: agent.as_str().to_string(),
                mode: value.to_string(),
            }
            .into()),
        },
        AgentId::Mock => match mode {
            "build" | "plan" => Ok(mode.to_string()),
            value => Err(SandboxError::ModeNotSupported {
                agent: agent.as_str().to_string(),
                mode: value.to_string(),
            }
            .into()),
        },
    }
}

/// Check if the current process is running as root (uid 0)
fn is_running_as_root() -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::getuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn normalize_permission_mode(
    agent: AgentId,
    permission_mode: Option<&str>,
) -> Result<String, SandboxError> {
    let mode = match permission_mode.unwrap_or("default") {
        "default" | "plan" | "bypass" | "acceptEdits" => permission_mode.unwrap_or("default"),
        value => {
            return Err(SandboxError::InvalidRequest {
                message: format!("invalid permission mode: {value}"),
            }
            .into())
        }
    };
    if agent == AgentId::Claude {
        // Claude refuses --dangerously-skip-permissions when running as root,
        // which is common in container environments (Docker, Daytona, E2B).
        // Return an error if user explicitly requests bypass while running as root.
        if mode == "bypass" && is_running_as_root() {
            return Err(SandboxError::InvalidRequest {
                message: "permission mode 'bypass' is not supported when running as root (Claude refuses --dangerously-skip-permissions with root privileges)".to_string(),
            }
            .into());
        }
        // Pass through bypass/acceptEdits/plan if explicitly requested, otherwise use default
        if mode == "bypass" || mode == "acceptEdits" || mode == "plan" {
            return Ok(mode.to_string());
        }
        return Ok("default".to_string());
    }
    let supported = match agent {
        AgentId::Claude => false,
        AgentId::Codex => matches!(mode, "default" | "plan" | "bypass"),
        AgentId::Amp => matches!(mode, "default" | "bypass"),
        AgentId::Opencode => matches!(mode, "default"),
        AgentId::Mock => matches!(mode, "default" | "plan" | "bypass"),
    };
    if !supported {
        return Err(SandboxError::ModeNotSupported {
            agent: agent.as_str().to_string(),
            mode: mode.to_string(),
        }
        .into());
    }
    Ok(mode.to_string())
}

fn normalize_modes(
    agent: AgentId,
    agent_mode: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<(String, String), SandboxError> {
    let agent_mode = normalize_agent_mode(agent, agent_mode)?;
    let permission_mode = normalize_permission_mode(agent, permission_mode)?;
    Ok((agent_mode, permission_mode))
}

fn map_install_error(agent: AgentId, err: ManagerError) -> SandboxError {
    match err {
        ManagerError::UnsupportedAgent { agent } => SandboxError::UnsupportedAgent { agent },
        ManagerError::BinaryNotFound { .. } => SandboxError::AgentNotInstalled {
            agent: agent.as_str().to_string(),
        },
        ManagerError::ResumeUnsupported { agent } => SandboxError::InvalidRequest {
            message: format!("resume unsupported for {agent}"),
        },
        ManagerError::UnsupportedPlatform { .. }
        | ManagerError::DownloadFailed { .. }
        | ManagerError::Http(_)
        | ManagerError::UrlParse(_)
        | ManagerError::Io(_)
        | ManagerError::ExtractFailed(_) => SandboxError::InstallFailed {
            agent: agent.as_str().to_string(),
            stderr: Some(err.to_string()),
        },
    }
}

fn map_spawn_error(agent: AgentId, err: ManagerError) -> SandboxError {
    match err {
        ManagerError::BinaryNotFound { .. } => SandboxError::AgentNotInstalled {
            agent: agent.as_str().to_string(),
        },
        ManagerError::ResumeUnsupported { agent } => SandboxError::InvalidRequest {
            message: format!("resume unsupported for {agent}"),
        },
        _ => SandboxError::AgentProcessExited {
            agent: agent.as_str().to_string(),
            exit_code: None,
            stderr: Some(err.to_string()),
        },
    }
}

fn build_spawn_options(
    session: &SessionSnapshot,
    prompt: String,
    credentials: ExtractedCredentials,
) -> SpawnOptions {
    let mut options = SpawnOptions::new(prompt);
    options.model = session.model.clone();
    options.variant = session.variant.clone();
    options.agent_mode = Some(session.agent_mode.clone());
    options.permission_mode = Some(session.permission_mode.clone());
    options.session_id = session.native_session_id.clone().or_else(|| {
        if session.agent == AgentId::Opencode {
            Some(session.session_id.clone())
        } else {
            None
        }
    });
    if let Some(anthropic) = credentials.anthropic {
        options
            .env
            .entry("ANTHROPIC_API_KEY".to_string())
            .or_insert(anthropic.api_key.clone());
        options
            .env
            .entry("CLAUDE_API_KEY".to_string())
            .or_insert(anthropic.api_key);
    }
    if let Some(openai) = credentials.openai {
        options
            .env
            .entry("OPENAI_API_KEY".to_string())
            .or_insert(openai.api_key.clone());
        options
            .env
            .entry("CODEX_API_KEY".to_string())
            .or_insert(openai.api_key);
    }
    options
}

fn claude_input_session_id(session: &SessionSnapshot) -> String {
    session
        .native_session_id
        .clone()
        .unwrap_or_else(|| session.session_id.clone())
}

fn claude_user_message_line(session: &SessionSnapshot, message: &str) -> String {
    let session_id = claude_input_session_id(session);
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message,
        },
        "parent_tool_use_id": null,
        "session_id": session_id,
    })
    .to_string()
}

fn claude_tool_result_line(
    session_id: &str,
    tool_use_id: &str,
    content: &str,
    is_error: bool,
) -> String {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            }],
        },
        "parent_tool_use_id": null,
        "session_id": session_id,
    })
    .to_string()
}

fn claude_control_response_line(request_id: &str, behavior: &str, response: Value) -> String {
    let mut response_obj = serde_json::Map::new();
    response_obj.insert("behavior".to_string(), Value::String(behavior.to_string()));
    if let Some(message) = response.get("message") {
        response_obj.insert("message".to_string(), message.clone());
    }
    if let Some(updated_input) = response.get("updatedInput") {
        response_obj.insert("updatedInput".to_string(), updated_input.clone());
    }
    if let Some(updated_permissions) = response.get("updatedPermissions") {
        response_obj.insert(
            "updatedPermissions".to_string(),
            updated_permissions.clone(),
        );
    }
    if let Some(interrupt) = response.get("interrupt") {
        response_obj.insert("interrupt".to_string(), interrupt.clone());
    }

    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": Value::Object(response_obj),
        }
    })
    .to_string()
}

fn read_lines<R: std::io::Read>(reader: R, sender: mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(&['\r', '\n'][..]).to_string();
                if sender.send(trimmed).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn write_lines(mut stdin: std::process::ChildStdin, mut receiver: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = receiver.blocking_recv() {
        if writeln!(stdin, "{line}").is_err() {
            break;
        }
        if stdin.flush().is_err() {
            break;
        }
    }
}

#[derive(Default)]
struct CodexLineOutcome {
    conversions: Vec<EventConversion>,
    should_terminate: bool,
}

struct CodexAppServerState {
    init_id: Option<String>,
    thread_start_id: Option<String>,
    init_done: bool,
    thread_start_sent: bool,
    turn_start_sent: bool,
    thread_id: Option<String>,
    next_id: i64,
    prompt: String,
    model: Option<String>,
    effort: Option<codex_schema::ReasoningEffort>,
    cwd: Option<String>,
    approval_policy: Option<codex_schema::AskForApproval>,
    sandbox_mode: Option<codex_schema::SandboxMode>,
    sandbox_policy: Option<codex_schema::SandboxPolicy>,
    sender: Option<mpsc::UnboundedSender<String>>,
}

impl CodexAppServerState {
    fn new(options: SpawnOptions) -> Self {
        let prompt = codex_prompt_for_mode(&options.prompt, options.agent_mode.as_deref());
        let cwd = options
            .working_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        Self {
            init_id: None,
            thread_start_id: None,
            init_done: false,
            thread_start_sent: false,
            turn_start_sent: false,
            thread_id: None,
            next_id: 1,
            prompt,
            model: options.model.clone(),
            effort: codex_effort_from_variant(options.variant.as_deref()),
            cwd,
            approval_policy: codex_approval_policy(options.permission_mode.as_deref()),
            sandbox_mode: codex_sandbox_mode(options.permission_mode.as_deref()),
            sandbox_policy: codex_sandbox_policy(options.permission_mode.as_deref()),
            sender: None,
        }
    }

    fn start(&mut self, sender: &mpsc::UnboundedSender<String>) {
        self.sender = Some(sender.clone());
        let request_id = self.next_request_id();
        self.init_id = Some(request_id.to_string());
        let request = codex_schema::ClientRequest::Initialize {
            id: request_id,
            params: codex_schema::InitializeParams {
                client_info: codex_schema::ClientInfo {
                    name: "sandbox-agent".to_string(),
                    title: Some("sandbox-agent".to_string()),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                },
            },
        };
        self.send_json(&request);
    }

    fn handle_line(&mut self, line: &str) -> CodexLineOutcome {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return CodexLineOutcome::default();
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                return CodexLineOutcome {
                    conversions: vec![agent_unparsed(
                        "codex",
                        &err.to_string(),
                        Value::String(trimmed.to_string()),
                    )],
                    should_terminate: false,
                };
            }
        };
        let message: codex_schema::JsonrpcMessage = match serde_json::from_value(value.clone()) {
            Ok(message) => message,
            Err(err) => {
                return CodexLineOutcome {
                    conversions: vec![agent_unparsed("codex", &err.to_string(), value)],
                    should_terminate: false,
                };
            }
        };

        match message {
            codex_schema::JsonrpcMessage::Response(response) => {
                self.handle_response(&response);
                CodexLineOutcome::default()
            }
            codex_schema::JsonrpcMessage::Notification(_) => {
                if let Ok(notification) =
                    serde_json::from_value::<codex_schema::ServerNotification>(value.clone())
                {
                    self.maybe_capture_thread_id(&notification);
                    let should_terminate = matches!(
                        notification,
                        codex_schema::ServerNotification::TurnCompleted(_)
                            | codex_schema::ServerNotification::Error(_)
                    );
                    if codex_should_emit_notification(&notification) {
                        match convert_codex::notification_to_universal(&notification) {
                            Ok(conversions) => CodexLineOutcome {
                                conversions,
                                should_terminate,
                            },
                            Err(err) => CodexLineOutcome {
                                conversions: vec![agent_unparsed("codex", &err, value)],
                                should_terminate,
                            },
                        }
                    } else {
                        CodexLineOutcome {
                            conversions: Vec::new(),
                            should_terminate,
                        }
                    }
                } else {
                    CodexLineOutcome {
                        conversions: vec![agent_unparsed("codex", "invalid notification", value)],
                        should_terminate: false,
                    }
                }
            }
            codex_schema::JsonrpcMessage::Request(_) => {
                if let Ok(request) =
                    serde_json::from_value::<codex_schema::ServerRequest>(value.clone())
                {
                    match codex_request_to_universal(&request) {
                        Ok(mut conversions) => {
                            for conversion in &mut conversions {
                                conversion.raw = Some(value.clone());
                            }
                            CodexLineOutcome {
                                conversions,
                                should_terminate: false,
                            }
                        }
                        Err(err) => CodexLineOutcome {
                            conversions: vec![agent_unparsed("codex", &err, value)],
                            should_terminate: false,
                        },
                    }
                } else {
                    CodexLineOutcome {
                        conversions: vec![agent_unparsed("codex", "invalid request", value)],
                        should_terminate: false,
                    }
                }
            }
            codex_schema::JsonrpcMessage::Error(error) => CodexLineOutcome {
                conversions: vec![codex_rpc_error_to_universal(&error)],
                should_terminate: true,
            },
        }
    }

    fn handle_response(&mut self, response: &codex_schema::JsonrpcResponse) {
        let response_id = response.id.to_string();
        if !self.init_done {
            if self.init_id.as_ref().is_some_and(|id| id == &response_id) {
                self.init_done = true;
                self.send_initialized();
                self.send_thread_start();
            }
            return;
        }
        if self.thread_id.is_none()
            && self
                .thread_start_id
                .as_ref()
                .is_some_and(|id| id == &response_id)
        {
            self.send_turn_start();
        }
    }

    fn maybe_capture_thread_id(&mut self, notification: &codex_schema::ServerNotification) {
        if self.thread_id.is_some() {
            return;
        }
        let thread_id = match notification {
            codex_schema::ServerNotification::ThreadStarted(params) => {
                Some(params.thread.id.clone())
            }
            codex_schema::ServerNotification::TurnStarted(params) => Some(params.thread_id.clone()),
            codex_schema::ServerNotification::TurnCompleted(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemStarted(params) => Some(params.thread_id.clone()),
            codex_schema::ServerNotification::ItemCompleted(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemAgentMessageDelta(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemReasoningTextDelta(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemReasoningSummaryTextDelta(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemCommandExecutionOutputDelta(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemFileChangeOutputDelta(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemMcpToolCallProgress(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ThreadTokenUsageUpdated(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::TurnDiffUpdated(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::TurnPlanUpdated(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemCommandExecutionTerminalInteraction(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ItemReasoningSummaryPartAdded(params) => {
                Some(params.thread_id.clone())
            }
            codex_schema::ServerNotification::ThreadCompacted(params) => {
                Some(params.thread_id.clone())
            }
            _ => None,
        };
        if let Some(thread_id) = thread_id {
            self.thread_id = Some(thread_id);
            self.send_turn_start();
        }
    }

    fn send_initialized(&self) {
        let notification = codex_schema::JsonrpcNotification {
            method: "initialized".to_string(),
            params: None,
        };
        self.send_json(&notification);
    }

    fn send_thread_start(&mut self) {
        if self.thread_start_sent {
            return;
        }
        let request_id = self.next_request_id();
        self.thread_start_id = Some(request_id.to_string());
        let mut params = codex_schema::ThreadStartParams::default();
        params.approval_policy = self.approval_policy;
        params.sandbox = self.sandbox_mode;
        params.model = self.model.clone();
        params.cwd = self.cwd.clone();
        let request = codex_schema::ClientRequest::ThreadStart {
            id: request_id,
            params,
        };
        self.thread_start_sent = true;
        self.send_json(&request);
    }

    fn send_turn_start(&mut self) {
        if self.turn_start_sent {
            return;
        }
        let thread_id = match self.thread_id.clone() {
            Some(thread_id) => thread_id,
            None => return,
        };
        let request_id = self.next_request_id();
        let params = codex_schema::TurnStartParams {
            approval_policy: self.approval_policy,
            collaboration_mode: None,
            cwd: self.cwd.clone(),
            effort: self.effort.clone(),
            input: vec![codex_schema::UserInput::Text {
                text: self.prompt.clone(),
                text_elements: Vec::new(),
            }],
            model: self.model.clone(),
            output_schema: None,
            sandbox_policy: self.sandbox_policy.clone(),
            summary: None,
            thread_id,
        };
        let request = codex_schema::ClientRequest::TurnStart {
            id: request_id,
            params,
        };
        self.turn_start_sent = true;
        self.send_json(&request);
    }

    fn next_request_id(&mut self) -> codex_schema::RequestId {
        let id = self.next_id;
        self.next_id += 1;
        codex_schema::RequestId::from(id)
    }

    fn send_json<T: Serialize>(&self, payload: &T) {
        let Some(sender) = self.sender.as_ref() else {
            return;
        };
        let Ok(line) = serde_json::to_string(payload) else {
            return;
        };
        let _ = sender.send(line);
    }
}

fn codex_prompt_for_mode(prompt: &str, mode: Option<&str>) -> String {
    match mode {
        Some("plan") => format!("Make a plan before acting.\n\n{prompt}"),
        _ => prompt.to_string(),
    }
}

fn codex_effort_from_variant(variant: Option<&str>) -> Option<codex_schema::ReasoningEffort> {
    let variant = variant?.trim();
    if variant.is_empty() {
        return None;
    }
    let normalized = variant.to_lowercase();
    serde_json::from_value(Value::String(normalized)).ok()
}

fn codex_approval_policy(mode: Option<&str>) -> Option<codex_schema::AskForApproval> {
    match mode {
        Some("plan") => Some(codex_schema::AskForApproval::Untrusted),
        Some("bypass") => Some(codex_schema::AskForApproval::Never),
        _ => None,
    }
}

fn codex_sandbox_mode(mode: Option<&str>) -> Option<codex_schema::SandboxMode> {
    match mode {
        Some("plan") => Some(codex_schema::SandboxMode::ReadOnly),
        Some("bypass") => Some(codex_schema::SandboxMode::DangerFullAccess),
        _ => None,
    }
}

fn codex_sandbox_policy(mode: Option<&str>) -> Option<codex_schema::SandboxPolicy> {
    match mode {
        Some("plan") => Some(codex_schema::SandboxPolicy::ReadOnly),
        Some("bypass") => Some(codex_schema::SandboxPolicy::DangerFullAccess),
        _ => None,
    }
}

fn codex_should_emit_notification(notification: &codex_schema::ServerNotification) -> bool {
    let _ = notification;
    true
}

/// Extracts thread_id from a Codex server notification.
fn codex_thread_id_from_server_notification(
    notification: &codex_schema::ServerNotification,
) -> Option<String> {
    match notification {
        codex_schema::ServerNotification::ThreadStarted(params) => Some(params.thread.id.clone()),
        codex_schema::ServerNotification::TurnStarted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::TurnCompleted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemStarted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemCompleted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemAgentMessageDelta(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ItemReasoningTextDelta(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ItemReasoningSummaryTextDelta(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ItemCommandExecutionOutputDelta(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ItemFileChangeOutputDelta(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ItemMcpToolCallProgress(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ThreadTokenUsageUpdated(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::TurnDiffUpdated(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::TurnPlanUpdated(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemCommandExecutionTerminalInteraction(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ItemReasoningSummaryPartAdded(params) => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerNotification::ThreadCompacted(params) => Some(params.thread_id.clone()),
        _ => None,
    }
}

/// Extracts thread_id from a Codex server request.
fn codex_thread_id_from_server_request(request: &codex_schema::ServerRequest) -> Option<String> {
    match request {
        codex_schema::ServerRequest::ItemCommandExecutionRequestApproval { params, .. } => {
            Some(params.thread_id.clone())
        }
        codex_schema::ServerRequest::ItemFileChangeRequestApproval { params, .. } => {
            Some(params.thread_id.clone())
        }
        _ => None,
    }
}

fn codex_request_to_universal(
    request: &codex_schema::ServerRequest,
) -> Result<Vec<EventConversion>, String> {
    match request {
        codex_schema::ServerRequest::ItemCommandExecutionRequestApproval { id, params } => {
            let mut metadata = serde_json::Map::new();
            metadata.insert(
                "codexRequestKind".to_string(),
                Value::String("commandExecution".to_string()),
            );
            metadata.insert(
                "codexRequestId".to_string(),
                serde_json::to_value(id).unwrap_or(Value::Null),
            );
            metadata.insert(
                "threadId".to_string(),
                Value::String(params.thread_id.clone()),
            );
            metadata.insert("turnId".to_string(), Value::String(params.turn_id.clone()));
            metadata.insert("itemId".to_string(), Value::String(params.item_id.clone()));
            if let Some(command) = params.command.as_ref() {
                metadata.insert("command".to_string(), Value::String(command.clone()));
            }
            if let Some(reason) = params.reason.as_ref() {
                metadata.insert("reason".to_string(), Value::String(reason.clone()));
            }
            let permission = PermissionEventData {
                permission_id: id.to_string(),
                action: "commandExecution".to_string(),
                status: PermissionStatus::Requested,
                metadata: Some(Value::Object(metadata)),
            };
            Ok(vec![EventConversion::new(
                UniversalEventType::PermissionRequested,
                UniversalEventData::Permission(permission),
            )
            .with_native_session(Some(params.thread_id.clone()))])
        }
        codex_schema::ServerRequest::ItemFileChangeRequestApproval { id, params } => {
            let mut metadata = serde_json::Map::new();
            metadata.insert(
                "codexRequestKind".to_string(),
                Value::String("fileChange".to_string()),
            );
            metadata.insert(
                "codexRequestId".to_string(),
                serde_json::to_value(id).unwrap_or(Value::Null),
            );
            metadata.insert(
                "threadId".to_string(),
                Value::String(params.thread_id.clone()),
            );
            metadata.insert("turnId".to_string(), Value::String(params.turn_id.clone()));
            metadata.insert("itemId".to_string(), Value::String(params.item_id.clone()));
            if let Some(reason) = params.reason.as_ref() {
                metadata.insert("reason".to_string(), Value::String(reason.clone()));
            }
            if let Some(grant_root) = params.grant_root.as_ref() {
                metadata.insert("grantRoot".to_string(), Value::String(grant_root.clone()));
            }
            let permission = PermissionEventData {
                permission_id: id.to_string(),
                action: "fileChange".to_string(),
                status: PermissionStatus::Requested,
                metadata: Some(Value::Object(metadata)),
            };
            Ok(vec![EventConversion::new(
                UniversalEventType::PermissionRequested,
                UniversalEventData::Permission(permission),
            )
            .with_native_session(Some(params.thread_id.clone()))])
        }
        _ => Err("unsupported codex request".to_string()),
    }
}

fn codex_rpc_error_to_universal(error: &codex_schema::JsonrpcError) -> EventConversion {
    let data = ErrorData {
        message: error.error.message.clone(),
        code: Some("jsonrpc.error".to_string()),
        details: serde_json::to_value(error).ok(),
    };
    EventConversion::new(UniversalEventType::Error, UniversalEventData::Error(data))
}

fn codex_request_id_from_metadata(metadata: &Value) -> Option<codex_schema::RequestId> {
    let metadata = metadata.as_object()?;
    let value = metadata.get("codexRequestId")?;
    codex_request_id_from_value(value)
}

fn codex_request_id_from_string(value: &str) -> Option<codex_schema::RequestId> {
    if let Ok(number) = value.parse::<i64>() {
        return Some(codex_schema::RequestId::from(number));
    }
    Some(codex_schema::RequestId::Variant0(value.to_string()))
}

fn codex_request_id_from_value(value: &Value) -> Option<codex_schema::RequestId> {
    match value {
        Value::String(value) => Some(codex_schema::RequestId::Variant0(value.clone())),
        Value::Number(value) => value.as_i64().map(codex_schema::RequestId::from),
        _ => None,
    }
}

/// Extracts i64 from a RequestId (for matching request/response pairs).
fn codex_request_id_to_i64(id: &codex_schema::RequestId) -> Option<i64> {
    match id {
        codex_schema::RequestId::Variant1(n) => Some(*n),
        codex_schema::RequestId::Variant0(s) => s.parse().ok(),
    }
}

fn codex_command_decision_for_reply(
    reply: PermissionReply,
) -> codex_schema::CommandExecutionApprovalDecision {
    match reply {
        PermissionReply::Once => codex_schema::CommandExecutionApprovalDecision::Accept,
        PermissionReply::Always => codex_schema::CommandExecutionApprovalDecision::AcceptForSession,
        PermissionReply::Reject => codex_schema::CommandExecutionApprovalDecision::Decline,
    }
}

fn codex_file_change_decision_for_reply(
    reply: PermissionReply,
) -> codex_schema::FileChangeApprovalDecision {
    match reply {
        PermissionReply::Once => codex_schema::FileChangeApprovalDecision::Accept,
        PermissionReply::Always => codex_schema::FileChangeApprovalDecision::AcceptForSession,
        PermissionReply::Reject => codex_schema::FileChangeApprovalDecision::Decline,
    }
}

fn parse_agent_line(agent: AgentId, line: &str, session_id: &str) -> Vec<EventConversion> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(err) => {
            return vec![agent_unparsed(
                agent.as_str(),
                &err.to_string(),
                Value::String(trimmed.to_string()),
            )];
        }
    };
    match agent {
        AgentId::Claude => {
            convert_claude::event_to_universal_with_session(&value, session_id.to_string())
                .unwrap_or_else(|err| vec![agent_unparsed("claude", &err, value)])
        }
        AgentId::Codex => match serde_json::from_value(value.clone()) {
            Ok(notification) => convert_codex::notification_to_universal(&notification)
                .unwrap_or_else(|err| vec![agent_unparsed("codex", &err, value)]),
            Err(err) => vec![agent_unparsed("codex", &err.to_string(), value)],
        },
        AgentId::Opencode => match serde_json::from_value(value.clone()) {
            Ok(event) => convert_opencode::event_to_universal(&event)
                .unwrap_or_else(|err| vec![agent_unparsed("opencode", &err, value)]),
            Err(err) => vec![agent_unparsed("opencode", &err.to_string(), value)],
        },
        AgentId::Amp => match serde_json::from_value(value.clone()) {
            Ok(event) => convert_amp::event_to_universal(&event)
                .unwrap_or_else(|err| vec![agent_unparsed("amp", &err, value)]),
            Err(err) => vec![agent_unparsed("amp", &err.to_string(), value)],
        },
        AgentId::Mock => vec![agent_unparsed(
            "mock",
            "mock agent does not parse streaming output",
            value,
        )],
    }
}

fn opencode_event_matches_session(value: &Value, session_id: &str) -> bool {
    match extract_opencode_session_id(value) {
        Some(id) => id == session_id,
        None => false,
    }
}

fn extract_opencode_session_id(value: &Value) -> Option<String> {
    if let Some(id) = value.get("session_id").and_then(Value::as_str) {
        return Some(id.to_string());
    }
    if let Some(id) = value.get("sessionID").and_then(Value::as_str) {
        return Some(id.to_string());
    }
    if let Some(id) = value.get("sessionId").and_then(Value::as_str) {
        return Some(id.to_string());
    }
    if let Some(id) = extract_nested_string(value, &["properties", "sessionID"]) {
        return Some(id);
    }
    if let Some(id) = extract_nested_string(value, &["properties", "part", "sessionID"]) {
        return Some(id);
    }
    if let Some(id) = extract_nested_string(value, &["session", "id"]) {
        return Some(id);
    }
    if let Some(id) = extract_nested_string(value, &["properties", "session", "id"]) {
        return Some(id);
    }
    None
}

fn extract_nested_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        if let Ok(index) = key.parse::<usize>() {
            current = current.get(index)?;
        } else {
            current = current.get(*key)?;
        }
    }
    current.as_str().map(|s| s.to_string())
}

#[cfg(feature = "test-utils")]
pub mod test_utils {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    pub struct TestHarness {
        session_manager: Arc<SessionManager>,
        _temp_dir: TempDir,
    }

    impl TestHarness {
        pub async fn new() -> Self {
            let temp_dir = TempDir::new().expect("temp dir");
            let agent_manager =
                Arc::new(AgentManager::new(temp_dir.path()).expect("agent manager"));
            let session_manager = Arc::new(SessionManager::new(agent_manager));
            session_manager
                .server_manager
                .set_owner_async(Arc::downgrade(&session_manager))
                .await;
            Self {
                session_manager,
                _temp_dir: temp_dir,
            }
        }

        pub async fn register_session(
            &self,
            agent: AgentId,
            session_id: &str,
            native_session_id: Option<&str>,
        ) {
            self.session_manager
                .server_manager
                .register_session(agent, session_id, native_session_id)
                .await;
        }

        pub async fn unregister_session(
            &self,
            agent: AgentId,
            session_id: &str,
            native_session_id: Option<&str>,
        ) {
            self.session_manager
                .server_manager
                .unregister_session(agent, session_id, native_session_id)
                .await;
        }

        pub async fn has_session_mapping(&self, agent: AgentId, session_id: &str) -> bool {
            let sessions = self.session_manager.server_manager.sessions.lock().await;
            sessions
                .get(&agent)
                .map(|set| set.contains(session_id))
                .unwrap_or(false)
        }

        pub async fn native_mapping(
            &self,
            agent: AgentId,
            native_session_id: &str,
        ) -> Option<String> {
            let natives = self
                .session_manager
                .server_manager
                .native_sessions
                .lock()
                .await;
            natives
                .get(&agent)
                .and_then(|map| map.get(native_session_id))
                .cloned()
        }

        pub async fn insert_session(
            &self,
            session_id: &str,
            agent: AgentId,
            native_session_id: Option<&str>,
        ) {
            let request = CreateSessionRequest {
                agent: agent.as_str().to_string(),
                agent_mode: None,
                permission_mode: None,
                model: None,
                variant: None,
                agent_version: None,
            };
            let mut session =
                SessionState::new(session_id.to_string(), agent, &request).expect("session");
            session.native_session_id = native_session_id.map(|id| id.to_string());
            self.session_manager.sessions.lock().await.push(session);
        }

        pub async fn insert_stdio_server(
            &self,
            agent: AgentId,
            child: Option<std::process::Child>,
            instance_id: u64,
        ) -> Arc<std::sync::Mutex<Option<std::process::Child>>> {
            let (stdin_tx, _stdin_rx) = mpsc::unbounded_channel::<String>();
            let server = Arc::new(CodexServer::new(stdin_tx));
            let child = Arc::new(std::sync::Mutex::new(child));
            self.session_manager
                .server_manager
                .servers
                .lock()
                .await
                .insert(
                    agent,
                    ManagedServer {
                        kind: ManagedServerKind::Stdio { server },
                        child: child.clone(),
                        status: ServerStatus::Running,
                        start_time: Some(Instant::now()),
                        restart_count: 0,
                        last_error: None,
                        shutdown_requested: false,
                        instance_id,
                    },
                );
            child
        }

        pub async fn insert_http_server(&self, agent: AgentId, instance_id: u64) {
            self.session_manager
                .server_manager
                .servers
                .lock()
                .await
                .insert(
                    agent,
                    ManagedServer {
                        kind: ManagedServerKind::Http {
                            base_url: "http://127.0.0.1:1".to_string(),
                        },
                        child: Arc::new(std::sync::Mutex::new(None)),
                        status: ServerStatus::Running,
                        start_time: Some(Instant::now()),
                        restart_count: 0,
                        last_error: None,
                        shutdown_requested: false,
                        instance_id,
                    },
                );
        }

        pub async fn handle_process_exit(
            &self,
            agent: AgentId,
            instance_id: u64,
            status: std::process::ExitStatus,
        ) {
            self.session_manager
                .server_manager
                .handle_process_exit(agent, instance_id, status)
                .await;
        }

        pub async fn shutdown(&self) {
            self.session_manager.server_manager.shutdown().await;
        }

        pub async fn server_status(&self, agent: AgentId) -> Option<ServerStatus> {
            let servers = self.session_manager.server_manager.servers.lock().await;
            servers.get(&agent).map(|server| server.status.clone())
        }

        pub async fn server_last_error(&self, agent: AgentId) -> Option<String> {
            let servers = self.session_manager.server_manager.servers.lock().await;
            servers
                .get(&agent)
                .and_then(|server| server.last_error.clone())
        }

        pub async fn session_ended(&self, session_id: &str) -> bool {
            let sessions = self.session_manager.sessions.lock().await;
            sessions
                .iter()
                .find(|session| session.session_id == session_id)
                .map(|session| session.ended)
                .unwrap_or(false)
        }

        pub async fn session_end_reason(&self, session_id: &str) -> Option<SessionEndReason> {
            let sessions = self.session_manager.sessions.lock().await;
            sessions
                .iter()
                .find(|session| session.session_id == session_id)
                .and_then(|session| session.ended_reason.clone())
        }

        pub async fn set_restart_notifier(&self, tx: mpsc::UnboundedSender<AgentId>) {
            self.session_manager
                .server_manager
                .set_restart_notifier(tx)
                .await;
        }
    }

    pub fn spawn_sleep_process() -> std::process::Child {
        #[cfg(windows)]
        {
            Command::new("cmd")
                .args(["/C", "ping", "127.0.0.1", "-n", "60"])
                .spawn()
                .expect("spawn sleep")
        }
        #[cfg(not(windows))]
        {
            Command::new("sh")
                .args(["-c", "sleep 60"])
                .spawn()
                .expect("spawn sleep")
        }
    }

    #[cfg(unix)]
    pub fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    pub fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code as u32)
    }
}

fn default_log_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("logs").join("servers"))
        .unwrap_or_else(|| {
            PathBuf::from(".")
                .join(".sandbox-agent")
                .join("logs")
                .join("servers")
        })
}

fn find_available_port() -> Result<u16, SandboxError> {
    for port in 4200..=4300 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(SandboxError::StreamError {
        message: "no available OpenCode port".to_string(),
    })
}

struct SseAccumulator {
    buffer: String,
    data_lines: Vec<String>,
}

impl SseAccumulator {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            data_lines: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.find('\n') {
            let mut line = self.buffer[..pos].to_string();
            self.buffer.drain(..=pos);
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                if !self.data_lines.is_empty() {
                    events.push(self.data_lines.join("\n"));
                    self.data_lines.clear();
                }
                continue;
            }
            if let Some(data) = line.strip_prefix("data:") {
                self.data_lines.push(data.trim_start().to_string());
            }
        }
        events
    }
}

fn parse_opencode_modes(value: &Value) -> Vec<AgentModeInfo> {
    let mut modes = Vec::new();
    let mut seen = HashSet::new();

    let items = value
        .as_array()
        .or_else(|| value.get("agents").and_then(Value::as_array))
        .or_else(|| value.get("data").and_then(Value::as_array));

    let Some(items) = items else { return modes };

    for item in items {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| item.get("slug").and_then(Value::as_str))
            .or_else(|| item.get("name").and_then(Value::as_str));
        let Some(id) = id else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        modes.push(AgentModeInfo {
            id: id.to_string(),
            name,
            description,
        });
    }

    modes
}

fn ensure_custom_mode(modes: &mut Vec<AgentModeInfo>) {
    if modes.iter().any(|mode| mode.id == "custom") {
        return;
    }
    modes.push(AgentModeInfo {
        id: "custom".to_string(),
        name: "Custom".to_string(),
        description: "Any user-defined OpenCode agent name".to_string(),
    });
}

fn text_delta_from_parts(parts: &[ContentPart]) -> Option<String> {
    let mut delta = String::new();
    for part in parts {
        if let ContentPart::Text { text } = part {
            if !delta.is_empty() {
                delta.push_str("\n");
            }
            delta.push_str(text);
        }
    }
    if delta.is_empty() {
        None
    } else {
        Some(delta)
    }
}

const MOCK_OK_PROMPT: &str = "Reply with exactly the single word OK.";
const MOCK_FIRST_PROMPT: &str = "Reply with exactly the word FIRST.";
const MOCK_SECOND_PROMPT: &str = "Reply with exactly the word SECOND.";
const MOCK_PERMISSION_PROMPT: &str = "List files in the current directory using available tools.";
const MOCK_TOOL_PROMPT: &str =
    "Use the bash tool to run `ls` in the current directory. Do not answer without using the tool.";
const MOCK_QUESTION_PROMPT: &str =
    "Use the AskUserQuestion tool to ask exactly one yes/no question, then wait for a reply. Do not answer yourself.";
const MOCK_QUESTION_PROMPT_ALT: &str =
    "Call the AskUserQuestion tool with exactly one yes/no question and wait for a reply. Do not answer yourself.";
const MOCK_REASONING_PROMPT: &str = "Answer briefly and include your reasoning.";
const MOCK_STATUS_PROMPT: &str = "Provide a short status update.";

fn mock_command_conversions(prefix: &str, input: &str) -> Vec<EventConversion> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    if trimmed.eq_ignore_ascii_case(MOCK_OK_PROMPT) {
        return mock_assistant_message(format!("{prefix}_ok"), "OK".to_string());
    }
    if trimmed.eq_ignore_ascii_case(MOCK_FIRST_PROMPT) {
        return mock_assistant_message(format!("{prefix}_first"), "FIRST".to_string());
    }
    if trimmed.eq_ignore_ascii_case(MOCK_SECOND_PROMPT) {
        return mock_assistant_message(format!("{prefix}_second"), "SECOND".to_string());
    }
    if trimmed.eq_ignore_ascii_case(MOCK_REASONING_PROMPT) {
        return mock_assistant_rich(prefix);
    }
    if trimmed.eq_ignore_ascii_case(MOCK_STATUS_PROMPT) {
        return mock_status_sequence(prefix);
    }
    if trimmed.eq_ignore_ascii_case(MOCK_PERMISSION_PROMPT) {
        return mock_permission_request(prefix);
    }
    if trimmed.eq_ignore_ascii_case(MOCK_TOOL_PROMPT) {
        let mut events = Vec::new();
        events.extend(mock_permission_request(prefix));
        events.extend(mock_tool_sequence(prefix));
        return events;
    }
    if trimmed.eq_ignore_ascii_case(MOCK_QUESTION_PROMPT)
        || trimmed.eq_ignore_ascii_case(MOCK_QUESTION_PROMPT_ALT)
    {
        return mock_question_request(prefix);
    }

    let mut parts = trimmed.split_whitespace();
    let command = parts.next().unwrap_or("").to_lowercase();
    let rest = parts.collect::<Vec<_>>().join(" ");

    let mut marker_index = 0_u32;
    match command.as_str() {
        "help" => mock_help_message(prefix),
        "demo" => {
            let mut events = Vec::new();
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: system message (system role).",
            ));
            events.extend(mock_system_message(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: assistant message with deltas, reasoning, and JSON content parts.",
            ));
            events.extend(mock_assistant_rich(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: status item updates.",
            ));
            events.extend(mock_status_sequence(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: markdown rendering + streaming markdown deltas.",
            ));
            events.extend(mock_markdown_sequence(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: tool call item.",
            ));
            events.extend(mock_tool_sequence(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: image output content part.",
            ));
            events.extend(mock_image_sequence(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: unknown item kind.",
            ));
            events.extend(mock_unknown_sequence(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: permission requests (pending).",
            ));
            events.extend(mock_permission_requests(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: question requests (pending).",
            ));
            events.extend(mock_question_requests(prefix));
            events.extend(mock_marker(
                prefix,
                &mut marker_index,
                "Next: error and agent.unparsed events.",
            ));
            events.extend(mock_error_sequence(prefix));
            events
        }
        "markdown" => mock_markdown_sequence(prefix),
        "tool" | "tools" | "tooling" => mock_tool_sequence(prefix),
        "status" => mock_status_sequence(prefix),
        "image" => mock_image_sequence(prefix),
        "unknown" => mock_unknown_sequence(prefix),
        "permission" | "permissions" => mock_permission_requests(prefix),
        "question" | "questions" => mock_question_requests(prefix),
        "error" => mock_error_sequence(prefix),
        "unparsed" => mock_unparsed_sequence(prefix),
        "end" | "ended" | "session.end" => mock_session_end_sequence(prefix),
        "echo" | "say" => {
            if rest.is_empty() {
                mock_assistant_message(
                    format!("{prefix}_echo"),
                    "Tell me what to say after `echo`.".to_string(),
                )
            } else {
                mock_assistant_message(format!("{prefix}_echo"), rest)
            }
        }
        _ => mock_assistant_message(format!("{prefix}_reply"), trimmed.to_string()),
    }
}

fn mock_help_message(prefix: &str) -> Vec<EventConversion> {
    let message = [
        "Mock agent commands:",
        "- demo: run a full UI coverage sequence with markers.",
        "- markdown: streaming markdown fixture.",
        "- tool: tool call + tool result with file refs.",
        "- status: status item updates.",
        "- image: message with image content part.",
        "- unknown: item.kind=unknown example.",
        "- permission: permission requests (pending).",
        "- question: question requests (pending).",
        "- error: error + agent.unparsed events.",
        "- unparsed: emit agent.unparsed only.",
        "- end: emit session.ended.",
        "",
        "Any other text will be echoed as an assistant message.",
    ]
    .join("\n");
    mock_assistant_message(format!("{prefix}_help"), message)
}

fn mock_user_message(prefix: &str, text: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_user");
    let content = vec![ContentPart::Text {
        text: text.to_string(),
    }];
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::Message,
                ItemRole::User,
                ItemStatus::InProgress,
                content.clone(),
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::Message,
                ItemRole::User,
                ItemStatus::Completed,
                content,
            ),
        ),
    ]
}

fn user_message_conversions(text: &str) -> Vec<EventConversion> {
    let id = USER_MESSAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let native_item_id = format!("user_{id}");
    let content = vec![ContentPart::Text {
        text: text.to_string(),
    }];
    vec![
        EventConversion::new(
            UniversalEventType::ItemStarted,
            UniversalEventData::Item(ItemEventData {
                item: UniversalItem {
                    item_id: String::new(),
                    native_item_id: Some(native_item_id.clone()),
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::User),
                    content: content.clone(),
                    status: ItemStatus::InProgress,
                },
            }),
        )
        .synthetic(),
        EventConversion::new(
            UniversalEventType::ItemCompleted,
            UniversalEventData::Item(ItemEventData {
                item: UniversalItem {
                    item_id: String::new(),
                    native_item_id: Some(native_item_id),
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::User),
                    content,
                    status: ItemStatus::Completed,
                },
            }),
        )
        .synthetic(),
    ]
}

fn mock_assistant_message(native_item_id: String, text: String) -> Vec<EventConversion> {
    let content = vec![ContentPart::Text { text }];
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::Message,
                ItemRole::Assistant,
                ItemStatus::InProgress,
                content.clone(),
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::Message,
                ItemRole::Assistant,
                ItemStatus::Completed,
                content,
            ),
        ),
    ]
}

fn mock_system_message(prefix: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_system");
    let content = vec![ContentPart::Text {
        text: "System ready for mock events.".to_string(),
    }];
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::System,
                ItemRole::System,
                ItemStatus::InProgress,
                content.clone(),
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::System,
                ItemRole::System,
                ItemStatus::Completed,
                content,
            ),
        ),
    ]
}

fn mock_assistant_rich(prefix: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_assistant_rich");
    let parts = vec![
        ContentPart::Text {
            text: "Mock assistant response with rich content.".to_string(),
        },
        ContentPart::Reasoning {
            text: "Public reasoning for display.".to_string(),
            visibility: ReasoningVisibility::Public,
        },
        ContentPart::Reasoning {
            text: "Private reasoning hidden by default.".to_string(),
            visibility: ReasoningVisibility::Private,
        },
        ContentPart::Json {
            json: json!({
                "stage": "analysis",
                "ok": true
            }),
        },
    ];
    let mut events = vec![mock_item_event(
        UniversalEventType::ItemStarted,
        mock_item(
            native_item_id.clone(),
            ItemKind::Message,
            ItemRole::Assistant,
            ItemStatus::InProgress,
            parts.clone(),
        ),
    )];
    events.push(mock_delta(native_item_id.clone(), "Mock assistant "));
    events.push(mock_delta(native_item_id.clone(), "streaming delta."));
    events.push(mock_item_event(
        UniversalEventType::ItemCompleted,
        mock_item(
            native_item_id,
            ItemKind::Message,
            ItemRole::Assistant,
            ItemStatus::Completed,
            parts,
        ),
    ));
    events
}

fn mock_status_sequence(prefix: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_status");
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::Status,
                ItemRole::Assistant,
                ItemStatus::InProgress,
                vec![ContentPart::Status {
                    label: "Indexing".to_string(),
                    detail: Some("2 files".to_string()),
                }],
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::Status,
                ItemRole::Assistant,
                ItemStatus::Completed,
                vec![ContentPart::Status {
                    label: "Indexing".to_string(),
                    detail: Some("Done".to_string()),
                }],
            ),
        ),
    ]
}

fn mock_markdown_sequence(prefix: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_markdown");
    let markdown_text = [
        "# Markdown Demo",
        "",
        "**Bold**, *italic*, ***bold-italic***, and ~~strikethrough~~.",
        "",
        "Inline code: `const x = 1`.",
        "",
        "## Lists",
        "- Item one",
        "  - Nested item",
        "- Item two",
        "",
        "1. First",
        "2. Second",
        "",
        "> Blockquote with **bold** text.",
        "",
        "## Code",
        "```ts",
        "const answer: number = 42;",
        "console.log(answer);",
        "```",
        "",
        "## Table",
        "| Column A | Column B |",
        "|:---------|---------:|",
        "| Left     | Right    |",
        "| Alpha    | Beta     |",
        "",
        "## Link",
        "[Example](https://example.com)",
        "",
        "---",
        "",
        "End of markdown demo.",
    ]
    .join("\n");
    let markdown_parts = vec![ContentPart::Text {
        text: markdown_text.clone(),
    }];

    let mut events = Vec::new();
    events.push(mock_item_event(
        UniversalEventType::ItemStarted,
        mock_item(
            native_item_id.clone(),
            ItemKind::Message,
            ItemRole::Assistant,
            ItemStatus::InProgress,
            vec![ContentPart::Text {
                text: "Markdown demo (streaming follows)...".to_string(),
            }],
        ),
    ));
    let markdown_deltas = [
        "# Markdown Demo\n\n**Bo",
        "ld**, *ita",
        "lic*, ***bold-",
        "italic***, and ~~stri",
        "kethrough~~.\n\nInline code: `const x = 1`.\n\n## Lists\n- Item one\n  - Nested item\n- Item two\n\n1.",
        " First\n2. Second\n\n> Blockquote with **bold** text.\n\n## Code\n```t",
        "s\nconst answer: number = 42;\nconsole.log(answer);\n```\n\n## Table\n| Column A | Column B |\n|:---------|---------:|\n| Left",
        "     | Right    |\n| Alpha    | Beta     |\n\n## Link\n[Example](https://example.com)\n\n---\n\nEnd of markdown demo.",
    ];
    for chunk in markdown_deltas {
        events.push(mock_delta(native_item_id.clone(), chunk));
    }
    events.push(mock_item_event(
        UniversalEventType::ItemCompleted,
        mock_item(
            native_item_id,
            ItemKind::Message,
            ItemRole::Assistant,
            ItemStatus::Completed,
            markdown_parts,
        ),
    ));
    events
}

fn mock_tool_sequence(prefix: &str) -> Vec<EventConversion> {
    let tool_call_native = format!("{prefix}_tool_call");
    let tool_result_native = format!("{prefix}_tool_result");
    let call_id = format!("{prefix}_call");
    let tool_call_part = ContentPart::ToolCall {
        name: "mock.search".to_string(),
        arguments: "{\"query\":\"example\"}".to_string(),
        call_id: call_id.clone(),
    };
    let mut events = Vec::new();
    events.push(mock_item_event(
        UniversalEventType::ItemStarted,
        mock_item(
            tool_call_native.clone(),
            ItemKind::ToolCall,
            ItemRole::Assistant,
            ItemStatus::InProgress,
            vec![tool_call_part.clone()],
        ),
    ));
    events.push(mock_item_event(
        UniversalEventType::ItemCompleted,
        mock_item(
            tool_call_native,
            ItemKind::ToolCall,
            ItemRole::Assistant,
            ItemStatus::Completed,
            vec![tool_call_part],
        ),
    ));

    let tool_result_parts = vec![
        ContentPart::ToolResult {
            call_id: call_id.clone(),
            output: "mock search results".to_string(),
        },
        ContentPart::FileRef {
            path: format!("{prefix}/readme.md"),
            action: FileAction::Read,
            diff: None,
        },
        ContentPart::FileRef {
            path: format!("{prefix}/output.txt"),
            action: FileAction::Write,
            diff: Some("+mock output\n".to_string()),
        },
        ContentPart::FileRef {
            path: format!("{prefix}/patch.txt"),
            action: FileAction::Patch,
            diff: Some("@@ -1,1 +1,1 @@\n-old\n+new\n".to_string()),
        },
    ];
    events.push(mock_item_event(
        UniversalEventType::ItemStarted,
        mock_item(
            tool_result_native.clone(),
            ItemKind::ToolResult,
            ItemRole::Tool,
            ItemStatus::InProgress,
            tool_result_parts.clone(),
        ),
    ));
    events.push(mock_item_event(
        UniversalEventType::ItemCompleted,
        mock_item(
            tool_result_native,
            ItemKind::ToolResult,
            ItemRole::Tool,
            ItemStatus::Failed,
            tool_result_parts,
        ),
    ));

    events
}

fn mock_image_sequence(prefix: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_image");
    let image_parts = vec![
        ContentPart::Text {
            text: "Here is a mock image output.".to_string(),
        },
        ContentPart::Image {
            path: format!("{prefix}/image.png"),
            mime: Some("image/png".to_string()),
        },
    ];
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::Message,
                ItemRole::Assistant,
                ItemStatus::InProgress,
                image_parts.clone(),
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::Message,
                ItemRole::Assistant,
                ItemStatus::Completed,
                image_parts,
            ),
        ),
    ]
}

fn mock_unknown_sequence(prefix: &str) -> Vec<EventConversion> {
    let native_item_id = format!("{prefix}_unknown");
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::Unknown,
                ItemRole::Assistant,
                ItemStatus::InProgress,
                vec![ContentPart::Text {
                    text: "Unknown item kind example.".to_string(),
                }],
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::Unknown,
                ItemRole::Assistant,
                ItemStatus::Completed,
                vec![ContentPart::Text {
                    text: "Unknown item kind example.".to_string(),
                }],
            ),
        ),
    ]
}

fn mock_permission_request(prefix: &str) -> Vec<EventConversion> {
    let permission_id = format!("{prefix}_permission");
    let metadata = json!({
        "codexRequestKind": "commandExecution",
        "command": "ls"
    });
    vec![EventConversion::new(
        UniversalEventType::PermissionRequested,
        UniversalEventData::Permission(PermissionEventData {
            permission_id,
            action: "command_execution".to_string(),
            status: PermissionStatus::Requested,
            metadata: Some(metadata),
        }),
    )]
}

fn mock_question_request(prefix: &str) -> Vec<EventConversion> {
    let question_id = format!("{prefix}_question");
    vec![EventConversion::new(
        UniversalEventType::QuestionRequested,
        UniversalEventData::Question(QuestionEventData {
            question_id,
            prompt: "Proceed?".to_string(),
            options: vec!["Yes".to_string(), "No".to_string()],
            response: None,
            status: QuestionStatus::Requested,
        }),
    )]
}

fn mock_permission_requests(prefix: &str) -> Vec<EventConversion> {
    let permission_id = format!("{prefix}_permission");
    let permission_deny_id = format!("{prefix}_permission_denied");
    let permission_metadata = json!({
        "codexRequestKind": "commandExecution",
        "command": "echo mock"
    });
    let permission_metadata_deny = json!({
        "codexRequestKind": "fileChange",
        "path": format!("{prefix}/deny.txt")
    });
    vec![
        EventConversion::new(
            UniversalEventType::PermissionRequested,
            UniversalEventData::Permission(PermissionEventData {
                permission_id: permission_id,
                action: "command_execution".to_string(),
                status: PermissionStatus::Requested,
                metadata: Some(permission_metadata),
            }),
        ),
        EventConversion::new(
            UniversalEventType::PermissionRequested,
            UniversalEventData::Permission(PermissionEventData {
                permission_id: permission_deny_id,
                action: "file_change".to_string(),
                status: PermissionStatus::Requested,
                metadata: Some(permission_metadata_deny),
            }),
        ),
    ]
}

fn mock_question_requests(prefix: &str) -> Vec<EventConversion> {
    let question_id = format!("{prefix}_question");
    let question_reject_id = format!("{prefix}_question_reject");
    vec![
        EventConversion::new(
            UniversalEventType::QuestionRequested,
            UniversalEventData::Question(QuestionEventData {
                question_id,
                prompt: "Choose a color".to_string(),
                options: vec!["Red".to_string(), "Blue".to_string()],
                response: None,
                status: QuestionStatus::Requested,
            }),
        ),
        EventConversion::new(
            UniversalEventType::QuestionRequested,
            UniversalEventData::Question(QuestionEventData {
                question_id: question_reject_id,
                prompt: "Allow mock experiment?".to_string(),
                options: vec!["Yes".to_string(), "No".to_string()],
                response: None,
                status: QuestionStatus::Requested,
            }),
        ),
    ]
}

fn mock_error_sequence(_prefix: &str) -> Vec<EventConversion> {
    vec![
        EventConversion::new(
            UniversalEventType::Error,
            UniversalEventData::Error(ErrorData {
                message: "Mock error event.".to_string(),
                code: Some("mock_error".to_string()),
                details: Some(json!({ "mock": true })),
            }),
        )
        .synthetic(),
        agent_unparsed(
            "mock.stream",
            "unsupported payload",
            json!({ "raw": "mock" }),
        ),
    ]
}

fn mock_unparsed_sequence(_prefix: &str) -> Vec<EventConversion> {
    vec![agent_unparsed(
        "mock.stream",
        "unsupported payload",
        json!({ "raw": "mock" }),
    )]
}

fn mock_session_end_sequence(_prefix: &str) -> Vec<EventConversion> {
    vec![EventConversion::new(
        UniversalEventType::SessionEnded,
        UniversalEventData::SessionEnded(SessionEndedData {
            reason: SessionEndReason::Completed,
            terminated_by: TerminatedBy::Agent,
            message: None,
            exit_code: None,
            stderr: None,
        }),
    )
    .synthetic()]
}

fn mock_item(
    native_item_id: String,
    kind: ItemKind,
    role: ItemRole,
    status: ItemStatus,
    content: Vec<ContentPart>,
) -> UniversalItem {
    UniversalItem {
        item_id: String::new(),
        native_item_id: Some(native_item_id),
        parent_id: None,
        kind,
        role: Some(role),
        content,
        status,
    }
}

fn mock_item_event(event_type: UniversalEventType, item: UniversalItem) -> EventConversion {
    EventConversion::new(event_type, UniversalEventData::Item(ItemEventData { item }))
}

fn mock_marker(prefix: &str, marker_index: &mut u32, message: &str) -> Vec<EventConversion> {
    *marker_index = marker_index.saturating_add(1);
    let native_item_id = format!("{prefix}_marker_{marker_index}");
    let content = vec![ContentPart::Text {
        text: message.to_string(),
    }];
    vec![
        mock_item_event(
            UniversalEventType::ItemStarted,
            mock_item(
                native_item_id.clone(),
                ItemKind::Message,
                ItemRole::Assistant,
                ItemStatus::InProgress,
                content.clone(),
            ),
        ),
        mock_item_event(
            UniversalEventType::ItemCompleted,
            mock_item(
                native_item_id,
                ItemKind::Message,
                ItemRole::Assistant,
                ItemStatus::Completed,
                content,
            ),
        ),
    ]
}

fn mock_delta(native_item_id: String, delta: &str) -> EventConversion {
    EventConversion::new(
        UniversalEventType::ItemDelta,
        UniversalEventData::ItemDelta(ItemDeltaData {
            item_id: String::new(),
            native_item_id: Some(native_item_id),
            delta: delta.to_string(),
        }),
    )
}

fn agent_unparsed(location: &str, error: &str, raw: Value) -> EventConversion {
    EventConversion::new(
        UniversalEventType::AgentUnparsed,
        UniversalEventData::AgentUnparsed(AgentUnparsedData {
            error: error.to_string(),
            location: location.to_string(),
            raw_hash: None,
        }),
    )
    .synthetic()
    .with_raw(Some(raw))
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

struct TurnStreamState {
    initial_events: VecDeque<UniversalEvent>,
    receiver: broadcast::Receiver<UniversalEvent>,
    include_raw: bool,
    done: bool,
    agent: AgentId,
}

fn stream_turn_events(
    subscription: SessionSubscription,
    agent: AgentId,
    include_raw: bool,
) -> impl futures::Stream<Item = Result<Event, Infallible>> {
    let state = TurnStreamState {
        initial_events: VecDeque::from(subscription.initial_events),
        receiver: subscription.receiver,
        include_raw,
        done: false,
        agent,
    };
    stream::unfold(state, |mut state| async move {
        if state.done {
            return None;
        }

        let mut event = if let Some(event) = state.initial_events.pop_front() {
            event
        } else {
            loop {
                match state.receiver.recv().await {
                    Ok(event) => break event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        };

        if !state.include_raw {
            event.raw = None;
        }

        if is_turn_terminal(&event, state.agent) {
            state.done = true;
        }

        Some((Ok::<Event, Infallible>(to_sse_event(event)), state))
    })
}

fn is_turn_terminal(event: &UniversalEvent, agent: AgentId) -> bool {
    match event.event_type {
        UniversalEventType::SessionEnded
        | UniversalEventType::Error
        | UniversalEventType::AgentUnparsed
        | UniversalEventType::PermissionRequested
        | UniversalEventType::QuestionRequested => true,
        UniversalEventType::ItemCompleted => {
            let UniversalEventData::Item(ItemEventData { item }) = &event.data else {
                return false;
            };
            if let Some(label) = status_label(item) {
                if label == "turn.completed" || label == "session.idle" {
                    return true;
                }
            }
            if matches!(item.role, Some(ItemRole::Assistant)) && item.kind == ItemKind::Message {
                return agent != AgentId::Codex;
            }
            false
        }
        _ => false,
    }
}

fn status_label(item: &UniversalItem) -> Option<&str> {
    if item.kind != ItemKind::Status {
        return None;
    }
    item.content.iter().find_map(|part| {
        if let ContentPart::Status { label, .. } = part {
            Some(label.as_str())
        } else {
            None
        }
    })
}

fn to_sse_event(event: UniversalEvent) -> Event {
    Event::default()
        .json_data(&event)
        .unwrap_or_else(|_| Event::default().data("{}"))
}

#[derive(Clone, Debug)]
struct SessionSnapshot {
    session_id: String,
    agent: AgentId,
    agent_mode: String,
    permission_mode: String,
    model: Option<String>,
    variant: Option<String>,
    native_session_id: Option<String>,
}

impl From<&SessionState> for SessionSnapshot {
    fn from(session: &SessionState) -> Self {
        Self {
            session_id: session.session_id.clone(),
            agent: session.agent,
            agent_mode: session.agent_mode.clone(),
            permission_mode: session.permission_mode.clone(),
            model: session.model.clone(),
            variant: session.variant.clone(),
            native_session_id: session.native_session_id.clone(),
        }
    }
}

pub fn add_token_header(headers: &mut HeaderMap, token: &str) {
    let value = format!("Bearer {token}");
    if let Ok(header) = HeaderValue::from_str(&value) {
        headers.insert(axum::http::header::AUTHORIZATION, header);
    }
}

fn build_anthropic_headers(
    credentials: &ProviderCredentials,
) -> Result<reqwest::header::HeaderMap, SandboxError> {
    let mut headers = reqwest::header::HeaderMap::new();
    match credentials.auth_type {
        AuthType::ApiKey => {
            let value =
                reqwest::header::HeaderValue::from_str(&credentials.api_key).map_err(|_| {
                SandboxError::StreamError {
                    message: "invalid anthropic api key header".to_string(),
                }
            })?;
            headers.insert("x-api-key", value);
        }
        AuthType::Oauth => {
            let value = format!("Bearer {}", credentials.api_key);
            let header =
                reqwest::header::HeaderValue::from_str(&value).map_err(|_| {
                    SandboxError::StreamError {
                        message: "invalid anthropic oauth header".to_string(),
                    }
                })?;
            headers.insert(reqwest::header::AUTHORIZATION, header);
        }
    }
    headers.insert(
        "anthropic-version",
        reqwest::header::HeaderValue::from_static(ANTHROPIC_VERSION),
    );
    Ok(headers)
}
