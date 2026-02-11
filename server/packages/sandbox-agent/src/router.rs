use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Cursor;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::sse::KeepAlive;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use sandbox_agent_agent_management::agents::{
    AgentId, AgentManager, InstallOptions, InstallResult, InstallSource, InstalledArtifactKind,
};
use sandbox_agent_agent_management::credentials::{
    extract_all_credentials, CredentialExtractionOptions,
};
use sandbox_agent_error::{ErrorType, ProblemDetails, SandboxError};
use sandbox_agent_opencode_adapter::{build_opencode_router, OpenCodeAdapterConfig};
use sandbox_agent_opencode_server_manager::{OpenCodeServerManager, OpenCodeServerManagerConfig};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tar::Archive;
use tower_http::trace::TraceLayer;
use tracing::Span;
use utoipa::{Modify, OpenApi, ToSchema};

use crate::acp_proxy_runtime::{AcpProxyRuntime, ProxyPostOutcome};
use crate::ui;

mod support;
mod types;
use self::support::*;
pub use self::types::*;

const APPLICATION_JSON: &str = "application/json";
const TEXT_EVENT_STREAM: &str = "text/event-stream";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BrandingMode {
    #[default]
    SandboxAgent,
    Gigacode,
}

impl BrandingMode {
    pub fn product_name(&self) -> &'static str {
        match self {
            BrandingMode::SandboxAgent => "Sandbox Agent",
            BrandingMode::Gigacode => "Gigacode",
        }
    }

    pub fn docs_url(&self) -> &'static str {
        match self {
            BrandingMode::SandboxAgent => "https://sandboxagent.dev",
            BrandingMode::Gigacode => "https://gigacode.dev",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CachedAgentVersion {
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug)]
pub struct AppState {
    auth: AuthConfig,
    agent_manager: Arc<AgentManager>,
    acp_proxy: Arc<AcpProxyRuntime>,
    opencode_server_manager: Arc<OpenCodeServerManager>,
    pub(crate) branding: BrandingMode,
    version_cache: Mutex<HashMap<AgentId, CachedAgentVersion>>,
}

impl AppState {
    pub fn new(auth: AuthConfig, agent_manager: AgentManager) -> Self {
        Self::with_branding(auth, agent_manager, BrandingMode::SandboxAgent)
    }

    pub fn with_branding(
        auth: AuthConfig,
        agent_manager: AgentManager,
        branding: BrandingMode,
    ) -> Self {
        let agent_manager = Arc::new(agent_manager);
        let acp_proxy = Arc::new(AcpProxyRuntime::new(agent_manager.clone()));
        let opencode_server_manager = Arc::new(OpenCodeServerManager::new(
            agent_manager.clone(),
            OpenCodeServerManagerConfig {
                log_dir: default_opencode_server_log_dir(),
                auto_restart: true,
            },
        ));
        Self {
            auth,
            agent_manager,
            acp_proxy,
            opencode_server_manager,
            branding,
            version_cache: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn acp_proxy(&self) -> Arc<AcpProxyRuntime> {
        self.acp_proxy.clone()
    }

    pub(crate) fn agent_manager(&self) -> Arc<AgentManager> {
        self.agent_manager.clone()
    }

    pub(crate) fn opencode_server_manager(&self) -> Arc<OpenCodeServerManager> {
        self.opencode_server_manager.clone()
    }

    pub(crate) fn purge_version_cache(&self, agent: AgentId) {
        self.version_cache.lock().unwrap().remove(&agent);
    }
}

fn default_opencode_server_log_dir() -> PathBuf {
    let mut base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    base.push("sandbox-agent");
    base.push("agent-logs");
    base
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
        .route("/health", get(get_v1_health))
        .route("/agents", get(get_v1_agents))
        .route("/agents/:agent", get(get_v1_agent))
        .route("/agents/:agent/install", post(post_v1_agent_install))
        .route("/fs/entries", get(get_v1_fs_entries))
        .route("/fs/file", get(get_v1_fs_file).put(put_v1_fs_file))
        .route("/fs/entry", delete(delete_v1_fs_entry))
        .route("/fs/mkdir", post(post_v1_fs_mkdir))
        .route("/fs/move", post(post_v1_fs_move))
        .route("/fs/stat", get(get_v1_fs_stat))
        .route("/fs/upload-batch", post(post_v1_fs_upload_batch))
        .route(
            "/config/mcp",
            get(get_v1_config_mcp)
                .put(put_v1_config_mcp)
                .delete(delete_v1_config_mcp),
        )
        .route(
            "/config/skills",
            get(get_v1_config_skills)
                .put(put_v1_config_skills)
                .delete(delete_v1_config_skills),
        )
        .route("/acp", get(get_v1_acp_servers))
        .route(
            "/acp/:server_id",
            post(post_v1_acp).get(get_v1_acp).delete(delete_v1_acp),
        )
        .with_state(shared.clone());

    if shared.auth.token.is_some() {
        v1_router = v1_router.layer(axum::middleware::from_fn_with_state(
            shared.clone(),
            require_token,
        ));
    }

    let opencode_router = build_opencode_router(OpenCodeAdapterConfig {
        auth_token: shared.auth.token.clone(),
        sqlite_path: std::env::var("OPENCODE_COMPAT_DB_PATH").ok(),
        native_proxy_base_url: std::env::var("OPENCODE_COMPAT_PROXY_URL").ok(),
        native_proxy_manager: Some(shared.opencode_server_manager()),
        acp_dispatch: Some(shared.acp_proxy() as Arc<dyn sandbox_agent_opencode_adapter::AcpDispatch>),
        provider_payload: Some(build_provider_payload_for_opencode(&shared)),
        ..OpenCodeAdapterConfig::default()
    })
    .unwrap_or_else(|err| {
        tracing::error!(error = %err, "failed to initialize opencode adapter router; using fallback");
        Router::new().fallback(opencode_unavailable)
    });

    let mut router = Router::new()
        .route("/", get(get_root))
        .nest("/v1", v1_router)
        .nest("/opencode", opencode_router)
        .fallback(not_found);

    router = router.merge(ui::router());

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

async fn opencode_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "errors": [{"message": "/opencode is unavailable: adapter initialization failed"}]
        })),
    )
        .into_response()
}

pub async fn shutdown_servers(state: &Arc<AppState>) {
    state.acp_proxy().shutdown_all().await;
    state.opencode_server_manager().shutdown().await;
}

#[derive(OpenApi)]
#[openapi(
    paths(
        get_v1_health,
        get_v1_agents,
        get_v1_agent,
        post_v1_agent_install,
        get_v1_fs_entries,
        get_v1_fs_file,
        put_v1_fs_file,
        delete_v1_fs_entry,
        post_v1_fs_mkdir,
        post_v1_fs_move,
        get_v1_fs_stat,
        post_v1_fs_upload_batch,
        get_v1_config_mcp,
        put_v1_config_mcp,
        delete_v1_config_mcp,
        get_v1_config_skills,
        put_v1_config_skills,
        delete_v1_config_skills,
        get_v1_acp_servers,
        post_v1_acp,
        get_v1_acp,
        delete_v1_acp
    ),
    components(
        schemas(
            HealthResponse,
            ServerStatus,
            ServerStatusInfo,
            AgentCapabilities,
            AgentInfo,
            AgentListResponse,
            AgentInstallRequest,
            AgentInstallArtifact,
            AgentInstallResponse,
            FsPathQuery,
            FsEntriesQuery,
            FsDeleteQuery,
            FsUploadBatchQuery,
            FsEntryType,
            FsEntry,
            FsStat,
            FsWriteResponse,
            FsMoveRequest,
            FsMoveResponse,
            FsActionResponse,
            FsUploadBatchResponse,
            AcpPostQuery,
            AcpServerInfo,
            AcpServerListResponse,
            McpConfigQuery,
            SkillsConfigQuery,
            McpServerConfig,
            SkillsConfig,
            SkillSource,
            ProblemDetails,
            ErrorType,
            AcpEnvelope
        )
    ),
    tags(
        (name = "v1", description = "ACP proxy v1 API")
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
        let problem = match &self {
            ApiError::Sandbox(error) => problem_from_sandbox_error(error),
        };
        let status =
            StatusCode::from_u16(problem.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (
            status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            Json(problem),
        )
            .into_response()
    }
}

async fn get_root() -> Json<Value> {
    Json(json!({
        "name": "Sandbox Agent",
        "docs": "https://sandboxagent.dev"
    }))
}

#[utoipa::path(
    get,
    path = "/v1/health",
    tag = "v1",
    responses(
        (status = 200, description = "Service health response", body = HealthResponse)
    )
)]
async fn get_v1_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[utoipa::path(
    get,
    path = "/v1/agents",
    tag = "v1",
    params(
        ("config" = Option<bool>, Query, description = "When true, include version/path/configOptions (slower)"),
        ("no_cache" = Option<bool>, Query, description = "When true, bypass version cache")
    ),
    responses(
        (status = 200, description = "List of v1 agents", body = AgentListResponse),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_agents(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AgentsQuery>,
) -> Result<Json<AgentListResponse>, ApiError> {
    let credentials = tokio::task::spawn_blocking(move || {
        extract_all_credentials(&CredentialExtractionOptions::new())
    })
    .await
    .map_err(|err| SandboxError::StreamError {
        message: format!("failed to resolve credentials: {err}"),
    })?;

    let has_anthropic = credentials.anthropic.is_some();
    let has_openai = credentials.openai.is_some();

    let instances = state.acp_proxy().list_instances().await;
    let mut active_by_agent = HashMap::<AgentId, Vec<i64>>::new();
    for instance in instances {
        active_by_agent
            .entry(instance.agent)
            .or_default()
            .push(instance.created_at_ms);
    }

    let load_config = query.config.unwrap_or(false);
    let no_cache = query.no_cache.unwrap_or(false);

    let mut agents = Vec::new();
    for agent_id in AgentId::all().iter().copied() {
        let capabilities = agent_capabilities_for(agent_id);
        let installed = state.agent_manager().is_installed(agent_id);
        let credentials_available = credentials_available_for(agent_id, has_anthropic, has_openai);

        let server_status = active_by_agent.get(&agent_id).map(|created_times| {
            let uptime_ms = created_times
                .iter()
                .min()
                .map(|created| now_ms().saturating_sub(*created) as u64);
            ServerStatusInfo {
                status: if created_times.is_empty() {
                    ServerStatus::Stopped
                } else {
                    ServerStatus::Running
                },
                uptime_ms,
            }
        });

        agents.push(AgentInfo {
            id: agent_id.as_str().to_string(),
            installed,
            credentials_available,
            version: None,
            path: None,
            capabilities,
            server_status,
            config_options: None,
            config_error: None,
        });
    }

    if load_config {
        // Resolve versions/paths (slow — subprocess calls) with caching.
        // Collect agents that need a fresh lookup.
        let need_lookup: Vec<(usize, AgentId)> = agents
            .iter()
            .enumerate()
            .filter_map(|(idx, agent)| {
                let agent_id = AgentId::parse(&agent.id)?;
                if !no_cache {
                    if state.version_cache.lock().unwrap().contains_key(&agent_id) {
                        return None;
                    }
                }
                Some((idx, agent_id))
            })
            .collect();

        if !need_lookup.is_empty() {
            let mgr = state.agent_manager();
            let ids: Vec<AgentId> = need_lookup.iter().map(|(_, id)| *id).collect();
            let results = tokio::task::spawn_blocking(move || {
                ids.iter()
                    .map(|agent_id| {
                        let version = mgr.version(*agent_id).ok().flatten();
                        let path = mgr
                            .resolve_binary(*agent_id)
                            .ok()
                            .map(|p| p.to_string_lossy().to_string());
                        (*agent_id, CachedAgentVersion { version, path })
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .unwrap_or_default();

            let mut cache = state.version_cache.lock().unwrap();
            for (agent_id, entry) in results {
                cache.insert(agent_id, entry);
            }
        }

        // Apply cached version/path + hardcoded config options
        let cache = state.version_cache.lock().unwrap();
        for agent in &mut agents {
            let Some(agent_id) = AgentId::parse(&agent.id) else {
                continue;
            };
            if let Some(cached) = cache.get(&agent_id) {
                agent.version = cached.version.clone();
                agent.path = cached.path.clone();
            }
            let fallback = fallback_config_options(agent_id);
            if !fallback.is_empty() {
                agent.config_options = Some(fallback);
            }
        }
    }

    Ok(Json(AgentListResponse { agents }))
}

#[utoipa::path(
    get,
    path = "/v1/agents/{agent}",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id"),
        ("config" = Option<bool>, Query, description = "When true, include version/path/configOptions (slower)"),
        ("no_cache" = Option<bool>, Query, description = "When true, bypass version cache")
    ),
    responses(
        (status = 200, description = "Agent info", body = AgentInfo),
        (status = 400, description = "Unknown agent", body = ProblemDetails),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_agent(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Query(query): Query<AgentsQuery>,
) -> Result<Json<AgentInfo>, ApiError> {
    let agent_id = AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.clone(),
    })?;

    let credentials = tokio::task::spawn_blocking(move || {
        extract_all_credentials(&CredentialExtractionOptions::new())
    })
    .await
    .map_err(|err| SandboxError::StreamError {
        message: format!("failed to resolve credentials: {err}"),
    })?;

    let has_anthropic = credentials.anthropic.is_some();
    let has_openai = credentials.openai.is_some();

    let instances = state.acp_proxy().list_instances().await;
    let created_times: Vec<i64> = instances
        .iter()
        .filter(|i| i.agent == agent_id)
        .map(|i| i.created_at_ms)
        .collect();

    let capabilities = agent_capabilities_for(agent_id);
    let installed = state.agent_manager().is_installed(agent_id);
    let credentials_available = credentials_available_for(agent_id, has_anthropic, has_openai);

    let server_status = if created_times.is_empty() {
        None
    } else {
        let uptime_ms = created_times
            .iter()
            .min()
            .map(|created| now_ms().saturating_sub(*created) as u64);
        Some(ServerStatusInfo {
            status: ServerStatus::Running,
            uptime_ms,
        })
    };

    let mut info = AgentInfo {
        id: agent_id.as_str().to_string(),
        installed,
        credentials_available,
        version: None,
        path: None,
        capabilities,
        server_status,
        config_options: None,
        config_error: None,
    };

    if query.config.unwrap_or(false) {
        let no_cache = query.no_cache.unwrap_or(false);

        // Version/path (cached, slow — subprocess calls)
        let cached = if !no_cache {
            state.version_cache.lock().unwrap().get(&agent_id).cloned()
        } else {
            None
        };
        if let Some(cached) = cached {
            info.version = cached.version;
            info.path = cached.path;
        } else {
            let mgr = state.agent_manager();
            let aid = agent_id;
            let result = tokio::task::spawn_blocking(move || {
                let version = mgr.version(aid).ok().flatten();
                let path = mgr
                    .resolve_binary(aid)
                    .ok()
                    .map(|p| p.to_string_lossy().to_string());
                CachedAgentVersion { version, path }
            })
            .await
            .unwrap_or(CachedAgentVersion {
                version: None,
                path: None,
            });
            info.version = result.version.clone();
            info.path = result.path.clone();
            state.version_cache.lock().unwrap().insert(agent_id, result);
        }

        // Hardcoded config options
        let fallback = fallback_config_options(agent_id);
        if !fallback.is_empty() {
            info.config_options = Some(fallback);
        }
    }

    Ok(Json(info))
}

// TODO: Re-enable ACP config probing once agent processes reliably return
// configOptions from session/new. Currently all agents return empty configOptions,
// so we use hardcoded fallbacks in fallback_config_options() instead.
//
// const CONFIG_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
//
// async fn probe_agent_config(
//     proxy: &Arc<AcpProxyRuntime>,
//     agent_id: &str,
// ) -> Result<Vec<Value>, String> {
//     let probe_id = PROBE_COUNTER.fetch_add(1, Ordering::Relaxed);
//     let server_id = format!("_config_probe_{}_{}", agent_id, probe_id);
//
//     let agent = AgentId::parse(agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
//
//     let result = tokio::time::timeout(CONFIG_PROBE_TIMEOUT, async {
//         let init_payload = json!({
//             "jsonrpc": "2.0",
//             "id": 1,
//             "method": "initialize",
//             "params": {
//                 "protocolVersion": 1,
//                 "clientCapabilities": {},
//                 "clientInfo": { "name": "sandbox-agent", "version": "1.0.0" }
//             }
//         });
//         proxy
//             .post(&server_id, Some(agent), init_payload)
//             .await
//             .map_err(|e| format!("initialize failed: {e}"))?;
//
//         let session_payload = json!({
//             "jsonrpc": "2.0",
//             "id": 2,
//             "method": "session/new",
//             "params": {
//                 "cwd": "/",
//                 "_meta": { "sandboxagent.dev": { "agent": agent_id } }
//             }
//         });
//         let outcome = proxy
//             .post(&server_id, None, session_payload)
//             .await
//             .map_err(|e| format!("session/new failed: {e}"))?;
//
//         let config_options = match outcome {
//             ProxyPostOutcome::Response(value) => value
//                 .pointer("/result/configOptions")
//                 .cloned()
//                 .and_then(|v| serde_json::from_value::<Vec<Value>>(v).ok())
//                 .unwrap_or_default(),
//             ProxyPostOutcome::Accepted => Vec::new(),
//         };
//
//         Ok::<Vec<Value>, String>(config_options)
//     })
//     .await;
//
//     let _ = tokio::time::timeout(Duration::from_secs(5), proxy.delete(&server_id)).await;
//
//     match result {
//         Ok(inner) => inner,
//         Err(_) => Err("config probe timed out".to_string()),
//     }
// }

#[utoipa::path(
    post,
    path = "/v1/agents/{agent}/install",
    tag = "v1",
    params(
        ("agent" = String, Path, description = "Agent id")
    ),
    request_body = AgentInstallRequest,
    responses(
        (status = 200, description = "Agent install result", body = AgentInstallResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 500, description = "Install failed", body = ProblemDetails)
    )
)]
async fn post_v1_agent_install(
    State(state): State<Arc<AppState>>,
    Path(agent): Path<String>,
    Json(request): Json<AgentInstallRequest>,
) -> Result<Json<AgentInstallResponse>, ApiError> {
    let agent_id = AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.clone(),
    })?;

    let manager = state.agent_manager();
    let reinstall = request.reinstall.unwrap_or(false);
    let install_result = tokio::task::spawn_blocking(move || {
        manager.install(
            agent_id,
            InstallOptions {
                reinstall,
                version: request.agent_version,
                agent_process_version: request.agent_process_version,
            },
        )
    })
    .await
    .map_err(|err| SandboxError::InstallFailed {
        agent,
        stderr: Some(format!("installer task failed: {err}")),
    })?
    .map_err(|err| SandboxError::InstallFailed {
        agent: agent_id.as_str().to_string(),
        stderr: Some(err.to_string()),
    })?;

    // Purge version cache so next ?config=true picks up the new version
    state.purge_version_cache(agent_id);

    Ok(Json(map_install_result(install_result)))
}

#[utoipa::path(
    get,
    path = "/v1/fs/entries",
    tag = "v1",
    params(
        ("path" = Option<String>, Query, description = "Directory path")
    ),
    responses(
        (status = 200, description = "Directory entries", body = Vec<FsEntry>)
    )
)]
async fn get_v1_fs_entries(
    Query(query): Query<FsEntriesQuery>,
) -> Result<Json<Vec<FsEntry>>, ApiError> {
    let path = query.path.unwrap_or_else(|| ".".to_string());
    let target = resolve_fs_path(&path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if !metadata.is_dir() {
        return Err(SandboxError::InvalidRequest {
            message: format!("path is not a directory: {}", target.display()),
        }
        .into());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target).map_err(|err| map_fs_error(&target, err))? {
        let entry = entry.map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let entry_type = if metadata.is_dir() {
            FsEntryType::Directory
        } else {
            FsEntryType::File
        };
        let modified = metadata
            .modified()
            .ok()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
        entries.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            entry_type,
            size: metadata.len(),
            modified,
        });
    }
    Ok(Json(entries))
}

#[utoipa::path(
    get,
    path = "/v1/fs/file",
    tag = "v1",
    params(
        ("path" = String, Query, description = "File path")
    ),
    responses(
        (status = 200, description = "File content")
    )
)]
async fn get_v1_fs_file(Query(query): Query<FsPathQuery>) -> Result<Response, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if !metadata.is_file() {
        return Err(SandboxError::InvalidRequest {
            message: format!("path is not a file: {}", target.display()),
        }
        .into());
    }
    let bytes = fs::read(&target).map_err(|err| map_fs_error(&target, err))?;
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Bytes::from(bytes),
    )
        .into_response())
}

#[utoipa::path(
    put,
    path = "/v1/fs/file",
    tag = "v1",
    params(
        ("path" = String, Query, description = "File path")
    ),
    request_body(content = String, description = "Raw file bytes"),
    responses(
        (status = 200, description = "Write result", body = FsWriteResponse)
    )
)]
async fn put_v1_fs_file(
    Query(query): Query<FsPathQuery>,
    body: Bytes,
) -> Result<Json<FsWriteResponse>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
    }
    fs::write(&target, &body).map_err(|err| map_fs_error(&target, err))?;
    Ok(Json(FsWriteResponse {
        path: target.to_string_lossy().to_string(),
        bytes_written: body.len() as u64,
    }))
}

#[utoipa::path(
    delete,
    path = "/v1/fs/entry",
    tag = "v1",
    params(
        ("path" = String, Query, description = "File or directory path"),
        ("recursive" = Option<bool>, Query, description = "Delete directory recursively")
    ),
    responses(
        (status = 200, description = "Delete result", body = FsActionResponse)
    )
)]
async fn delete_v1_fs_entry(
    Query(query): Query<FsDeleteQuery>,
) -> Result<Json<FsActionResponse>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    if metadata.is_dir() {
        if query.recursive.unwrap_or(false) {
            fs::remove_dir_all(&target).map_err(|err| map_fs_error(&target, err))?;
        } else {
            fs::remove_dir(&target).map_err(|err| map_fs_error(&target, err))?;
        }
    } else {
        fs::remove_file(&target).map_err(|err| map_fs_error(&target, err))?;
    }
    Ok(Json(FsActionResponse {
        path: target.to_string_lossy().to_string(),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/fs/mkdir",
    tag = "v1",
    params(
        ("path" = String, Query, description = "Directory path")
    ),
    responses(
        (status = 200, description = "Directory created", body = FsActionResponse)
    )
)]
async fn post_v1_fs_mkdir(
    Query(query): Query<FsPathQuery>,
) -> Result<Json<FsActionResponse>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    fs::create_dir_all(&target).map_err(|err| map_fs_error(&target, err))?;
    Ok(Json(FsActionResponse {
        path: target.to_string_lossy().to_string(),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/fs/move",
    tag = "v1",
    request_body = FsMoveRequest,
    responses(
        (status = 200, description = "Move result", body = FsMoveResponse)
    )
)]
async fn post_v1_fs_move(
    Json(request): Json<FsMoveRequest>,
) -> Result<Json<FsMoveResponse>, ApiError> {
    let from = resolve_fs_path(&request.from)?;
    let to = resolve_fs_path(&request.to)?;

    if to.exists() {
        if request.overwrite.unwrap_or(false) {
            let metadata = fs::metadata(&to).map_err(|err| map_fs_error(&to, err))?;
            if metadata.is_dir() {
                fs::remove_dir_all(&to).map_err(|err| map_fs_error(&to, err))?;
            } else {
                fs::remove_file(&to).map_err(|err| map_fs_error(&to, err))?;
            }
        } else {
            return Err(SandboxError::InvalidRequest {
                message: format!("destination already exists: {}", to.display()),
            }
            .into());
        }
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
    }
    fs::rename(&from, &to).map_err(|err| map_fs_error(&from, err))?;
    Ok(Json(FsMoveResponse {
        from: from.to_string_lossy().to_string(),
        to: to.to_string_lossy().to_string(),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/fs/stat",
    tag = "v1",
    params(
        ("path" = String, Query, description = "Path to stat")
    ),
    responses(
        (status = 200, description = "Path metadata", body = FsStat)
    )
)]
async fn get_v1_fs_stat(Query(query): Query<FsPathQuery>) -> Result<Json<FsStat>, ApiError> {
    let target = resolve_fs_path(&query.path)?;
    let metadata = fs::metadata(&target).map_err(|err| map_fs_error(&target, err))?;
    let entry_type = if metadata.is_dir() {
        FsEntryType::Directory
    } else {
        FsEntryType::File
    };
    let modified = metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
    Ok(Json(FsStat {
        path: target.to_string_lossy().to_string(),
        entry_type,
        size: metadata.len(),
        modified,
    }))
}

#[utoipa::path(
    post,
    path = "/v1/fs/upload-batch",
    tag = "v1",
    params(
        ("path" = Option<String>, Query, description = "Destination path")
    ),
    request_body(content = String, description = "tar archive body"),
    responses(
        (status = 200, description = "Upload/extract result", body = FsUploadBatchResponse)
    )
)]
async fn post_v1_fs_upload_batch(
    headers: HeaderMap,
    Query(query): Query<FsUploadBatchQuery>,
    body: Bytes,
) -> Result<Json<FsUploadBatchResponse>, ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.starts_with("application/x-tar") {
        return Err(SandboxError::InvalidRequest {
            message: "content-type must be application/x-tar".to_string(),
        }
        .into());
    }

    let path = query.path.unwrap_or_else(|| ".".to_string());
    let base = resolve_fs_path(&path)?;
    fs::create_dir_all(&base).map_err(|err| map_fs_error(&base, err))?;

    let mut archive = Archive::new(Cursor::new(body));
    let mut extracted = Vec::new();
    let mut truncated = false;

    for entry in archive.entries().map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })? {
        let mut entry = entry.map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let entry_path = entry.path().map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
        let clean_path = sanitize_relative_path(&entry_path)?;
        if clean_path.as_os_str().is_empty() {
            continue;
        }
        let dest = base.join(&clean_path);
        if !dest.starts_with(&base) {
            return Err(SandboxError::InvalidRequest {
                message: format!("tar entry escapes destination: {}", entry_path.display()),
            }
            .into());
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|err| map_fs_error(parent, err))?;
        }
        entry
            .unpack(&dest)
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
        if extracted.len() < 1024 {
            extracted.push(dest.to_string_lossy().to_string());
        } else {
            truncated = true;
        }
    }

    Ok(Json(FsUploadBatchResponse {
        paths: extracted,
        truncated,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    responses(
        (status = 200, description = "MCP entry", body = McpServerConfig),
        (status = 404, description = "Entry not found", body = ProblemDetails)
    )
)]
async fn get_v1_config_mcp(
    Query(query): Query<McpConfigQuery>,
) -> Result<Json<McpServerConfig>, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.mcp_name, "mcpName")?;

    let path = config_file_path(&query.directory, "mcp.json")?;
    let entries: BTreeMap<String, McpServerConfig> = read_named_config_map(&path)?;
    let value =
        entries
            .get(&query.mcp_name)
            .cloned()
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: format!("mcp:{}", query.mcp_name),
            })?;
    Ok(Json(value))
}

#[utoipa::path(
    put,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    request_body = McpServerConfig,
    responses(
        (status = 204, description = "Stored")
    )
)]
async fn put_v1_config_mcp(
    Query(query): Query<McpConfigQuery>,
    Json(body): Json<McpServerConfig>,
) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.mcp_name, "mcpName")?;

    let path = config_file_path(&query.directory, "mcp.json")?;
    let mut entries: BTreeMap<String, McpServerConfig> = read_named_config_map(&path)?;
    entries.insert(query.mcp_name, body);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/v1/config/mcp",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("mcpName" = String, Query, description = "MCP entry name")
    ),
    responses(
        (status = 204, description = "Deleted")
    )
)]
async fn delete_v1_config_mcp(Query(query): Query<McpConfigQuery>) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.mcp_name, "mcpName")?;

    let path = config_file_path(&query.directory, "mcp.json")?;
    let mut entries: BTreeMap<String, McpServerConfig> = read_named_config_map(&path)?;
    entries.remove(&query.mcp_name);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/config/skills",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("skillName" = String, Query, description = "Skill entry name")
    ),
    responses(
        (status = 200, description = "Skills entry", body = SkillsConfig),
        (status = 404, description = "Entry not found", body = ProblemDetails)
    )
)]
async fn get_v1_config_skills(
    Query(query): Query<SkillsConfigQuery>,
) -> Result<Json<SkillsConfig>, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.skill_name, "skillName")?;

    let path = config_file_path(&query.directory, "skills.json")?;
    let entries: BTreeMap<String, SkillsConfig> = read_named_config_map(&path)?;
    let value =
        entries
            .get(&query.skill_name)
            .cloned()
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: format!("skills:{}", query.skill_name),
            })?;
    Ok(Json(value))
}

#[utoipa::path(
    put,
    path = "/v1/config/skills",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("skillName" = String, Query, description = "Skill entry name")
    ),
    request_body = SkillsConfig,
    responses(
        (status = 204, description = "Stored")
    )
)]
async fn put_v1_config_skills(
    Query(query): Query<SkillsConfigQuery>,
    Json(body): Json<SkillsConfig>,
) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.skill_name, "skillName")?;

    let path = config_file_path(&query.directory, "skills.json")?;
    let mut entries: BTreeMap<String, SkillsConfig> = read_named_config_map(&path)?;
    entries.insert(query.skill_name, body);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/v1/config/skills",
    tag = "v1",
    params(
        ("directory" = String, Query, description = "Target directory"),
        ("skillName" = String, Query, description = "Skill entry name")
    ),
    responses(
        (status = 204, description = "Deleted")
    )
)]
async fn delete_v1_config_skills(
    Query(query): Query<SkillsConfigQuery>,
) -> Result<StatusCode, ApiError> {
    validate_named_query(&query.directory, "directory")?;
    validate_named_query(&query.skill_name, "skillName")?;

    let path = config_file_path(&query.directory, "skills.json")?;
    let mut entries: BTreeMap<String, SkillsConfig> = read_named_config_map(&path)?;
    entries.remove(&query.skill_name);
    write_named_config_map(&path, &entries)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/acp",
    tag = "v1",
    responses(
        (status = 200, description = "Active ACP server instances", body = AcpServerListResponse)
    )
)]
async fn get_v1_acp_servers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AcpServerListResponse>, ApiError> {
    let servers = state
        .acp_proxy()
        .list_instances()
        .await
        .into_iter()
        .map(|instance| AcpServerInfo {
            server_id: instance.server_id,
            agent: instance.agent.as_str().to_string(),
            created_at_ms: instance.created_at_ms,
        })
        .collect::<Vec<_>>();

    Ok(Json(AcpServerListResponse { servers }))
}

#[utoipa::path(
    post,
    path = "/v1/acp/{server_id}",
    tag = "v1",
    params(
        ("server_id" = String, Path, description = "Client-defined ACP server id"),
        ("agent" = Option<String>, Query, description = "Agent id required for first POST")
    ),
    request_body = AcpEnvelope,
    responses(
        (status = 200, description = "JSON-RPC response envelope", body = AcpEnvelope),
        (status = 202, description = "JSON-RPC notification accepted"),
        (status = 406, description = "Client does not accept JSON responses", body = ProblemDetails),
        (status = 415, description = "Unsupported media type", body = ProblemDetails),
        (status = 400, description = "Invalid ACP envelope", body = ProblemDetails),
        (status = 404, description = "Unknown ACP server", body = ProblemDetails),
        (status = 409, description = "ACP server bound to different agent", body = ProblemDetails),
        (status = 504, description = "ACP agent process response timeout", body = ProblemDetails)
    )
)]
async fn post_v1_acp(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Query(query): Query<AcpPostQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if !content_type_is(&headers, APPLICATION_JSON) {
        return Err(SandboxError::UnsupportedMediaType {
            message: "content-type must be application/json".to_string(),
        }
        .into());
    }
    if !accept_allows(&headers, APPLICATION_JSON) {
        return Err(SandboxError::NotAcceptable {
            message: "accept must allow application/json".to_string(),
        }
        .into());
    }

    let payload =
        serde_json::from_slice::<Value>(&body).map_err(|err| SandboxError::InvalidRequest {
            message: format!("invalid JSON body: {err}"),
        })?;

    let bootstrap_agent = match query.agent {
        Some(agent) => {
            Some(
                AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
                    agent: agent.clone(),
                })?,
            )
        }
        None => None,
    };

    match state
        .acp_proxy()
        .post(&server_id, bootstrap_agent, payload)
        .await?
    {
        ProxyPostOutcome::Response(value) => Ok((StatusCode::OK, Json(value)).into_response()),
        ProxyPostOutcome::Accepted => Ok(StatusCode::ACCEPTED.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v1/acp/{server_id}",
    tag = "v1",
    params(
        ("server_id" = String, Path, description = "Client-defined ACP server id")
    ),
    responses(
        (status = 200, description = "SSE stream of ACP envelopes"),
        (status = 406, description = "Client does not accept SSE responses", body = ProblemDetails),
        (status = 404, description = "Unknown ACP server", body = ProblemDetails),
        (status = 400, description = "Invalid request", body = ProblemDetails)
    )
)]
async fn get_v1_acp(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    headers: HeaderMap,
) -> Result<Sse<PinBoxSseStream>, ApiError> {
    if !accept_allows(&headers, TEXT_EVENT_STREAM) {
        return Err(SandboxError::NotAcceptable {
            message: "accept must allow text/event-stream".to_string(),
        }
        .into());
    }

    let last_event_id = parse_last_event_id(&headers)?;
    let stream = state.acp_proxy().sse(&server_id, last_event_id).await?;

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    ))
}

#[utoipa::path(
    delete,
    path = "/v1/acp/{server_id}",
    tag = "v1",
    params(
        ("server_id" = String, Path, description = "Client-defined ACP server id")
    ),
    responses(
        (status = 204, description = "ACP server closed")
    )
)]
async fn delete_v1_acp(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.acp_proxy().delete(&server_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn validate_named_query(value: &str, field_name: &str) -> Result<(), SandboxError> {
    if value.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: format!("missing required '{field_name}' query parameter"),
        });
    }
    Ok(())
}

fn config_file_path(directory: &str, filename: &str) -> Result<PathBuf, SandboxError> {
    if directory.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "missing required 'directory' query parameter".to_string(),
        });
    }

    let base_dir = PathBuf::from(directory);
    let root = if base_dir.is_absolute() {
        base_dir
    } else {
        std::env::current_dir()
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?
            .join(base_dir)
    };

    Ok(root.join(".sandbox-agent").join("config").join(filename))
}

fn read_named_config_map<T>(path: &StdPath) -> Result<BTreeMap<String, T>, SandboxError>
where
    T: DeserializeOwned,
{
    if !path.exists() {
        return Ok(BTreeMap::new());
    }

    let text = fs::read_to_string(path).map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })?;

    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }

    serde_json::from_str::<BTreeMap<String, T>>(&text).map_err(|err| SandboxError::InvalidRequest {
        message: format!("invalid config file {}: {err}", path.display()),
    })
}

fn write_named_config_map<T>(
    path: &StdPath,
    values: &BTreeMap<String, T>,
) -> Result<(), SandboxError>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })?;
    }

    let body = serde_json::to_string_pretty(values).map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })?;

    fs::write(path, body).map_err(|err| SandboxError::StreamError {
        message: err.to_string(),
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
