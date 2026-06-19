use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::fs;
use std::io::Cursor;
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::sse::KeepAlive;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures::stream;
use futures::StreamExt;
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
use tokio_stream::wrappers::BroadcastStream;
use tower_http::trace::TraceLayer;
use tracing::Span;
use utoipa::{IntoParams, Modify, OpenApi, ToSchema};

use crate::acp_proxy_runtime::{AcpProxyRuntime, ProxyPostOutcome};
use crate::browser_errors::BrowserProblem;
use crate::browser_runtime::BrowserRuntime;
use crate::browser_types::*;
use crate::desktop_errors::DesktopProblem;
use crate::desktop_runtime::DesktopRuntime;
use crate::desktop_types::*;
use crate::process_runtime::{
    decode_input_bytes, ProcessLogFilter, ProcessLogFilterStream,
    ProcessOwner as RuntimeProcessOwner, ProcessRuntime, ProcessRuntimeConfig, ProcessSnapshot,
    ProcessStartSpec, ProcessStatus, ProcessStream, RunSpec,
};
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
    process_runtime: Arc<ProcessRuntime>,
    desktop_runtime: Arc<DesktopRuntime>,
    browser_runtime: Arc<BrowserRuntime>,
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
        let process_runtime = Arc::new(ProcessRuntime::new());
        let desktop_runtime = Arc::new(DesktopRuntime::new(process_runtime.clone()));
        let browser_runtime = Arc::new(BrowserRuntime::new(
            process_runtime.clone(),
            desktop_runtime.clone(),
        ));
        desktop_runtime.set_browser_runtime(browser_runtime.clone());
        Self {
            auth,
            agent_manager,
            acp_proxy,
            opencode_server_manager,
            process_runtime,
            desktop_runtime,
            browser_runtime,
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

    pub(crate) fn process_runtime(&self) -> Arc<ProcessRuntime> {
        self.process_runtime.clone()
    }

    pub(crate) fn desktop_runtime(&self) -> Arc<DesktopRuntime> {
        self.desktop_runtime.clone()
    }

    pub(crate) fn browser_runtime(&self) -> Arc<BrowserRuntime> {
        self.browser_runtime.clone()
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
        .route("/desktop/status", get(get_v1_desktop_status))
        .route("/desktop/start", post(post_v1_desktop_start))
        .route("/desktop/stop", post(post_v1_desktop_stop))
        .route("/desktop/screenshot", get(get_v1_desktop_screenshot))
        .route(
            "/desktop/screenshot/region",
            get(get_v1_desktop_screenshot_region),
        )
        .route(
            "/desktop/mouse/position",
            get(get_v1_desktop_mouse_position),
        )
        .route("/desktop/mouse/move", post(post_v1_desktop_mouse_move))
        .route("/desktop/mouse/click", post(post_v1_desktop_mouse_click))
        .route("/desktop/mouse/down", post(post_v1_desktop_mouse_down))
        .route("/desktop/mouse/up", post(post_v1_desktop_mouse_up))
        .route("/desktop/mouse/drag", post(post_v1_desktop_mouse_drag))
        .route("/desktop/mouse/scroll", post(post_v1_desktop_mouse_scroll))
        .route(
            "/desktop/keyboard/type",
            post(post_v1_desktop_keyboard_type),
        )
        .route(
            "/desktop/keyboard/press",
            post(post_v1_desktop_keyboard_press),
        )
        .route(
            "/desktop/keyboard/down",
            post(post_v1_desktop_keyboard_down),
        )
        .route("/desktop/keyboard/up", post(post_v1_desktop_keyboard_up))
        .route("/desktop/display/info", get(get_v1_desktop_display_info))
        .route("/desktop/windows", get(get_v1_desktop_windows))
        .route(
            "/desktop/windows/focused",
            get(get_v1_desktop_windows_focused),
        )
        .route(
            "/desktop/windows/:id/focus",
            post(post_v1_desktop_window_focus),
        )
        .route(
            "/desktop/windows/:id/move",
            post(post_v1_desktop_window_move),
        )
        .route(
            "/desktop/windows/:id/resize",
            post(post_v1_desktop_window_resize),
        )
        .route(
            "/desktop/clipboard",
            get(get_v1_desktop_clipboard).post(post_v1_desktop_clipboard),
        )
        .route("/desktop/launch", post(post_v1_desktop_launch))
        .route("/desktop/open", post(post_v1_desktop_open))
        .route(
            "/desktop/recording/start",
            post(post_v1_desktop_recording_start),
        )
        .route(
            "/desktop/recording/stop",
            post(post_v1_desktop_recording_stop),
        )
        .route("/desktop/recordings", get(get_v1_desktop_recordings))
        .route(
            "/desktop/recordings/:id",
            get(get_v1_desktop_recording).delete(delete_v1_desktop_recording),
        )
        .route(
            "/desktop/recordings/:id/download",
            get(get_v1_desktop_recording_download),
        )
        .route("/desktop/stream/start", post(post_v1_desktop_stream_start))
        .route("/desktop/stream/stop", post(post_v1_desktop_stream_stop))
        .route("/desktop/stream/status", get(get_v1_desktop_stream_status))
        .route("/desktop/stream/signaling", get(get_v1_desktop_stream_ws))
        .route("/browser/status", get(get_v1_browser_status))
        .route("/browser/start", post(post_v1_browser_start))
        .route("/browser/stop", post(post_v1_browser_stop))
        .route("/browser/cdp", get(get_v1_browser_cdp_ws))
        .route("/browser/navigate", post(post_v1_browser_navigate))
        .route("/browser/back", post(post_v1_browser_back))
        .route("/browser/forward", post(post_v1_browser_forward))
        .route("/browser/reload", post(post_v1_browser_reload))
        .route("/browser/wait", post(post_v1_browser_wait))
        .route(
            "/browser/tabs",
            get(get_v1_browser_tabs).post(post_v1_browser_tabs),
        )
        .route(
            "/browser/tabs/:tab_id/activate",
            post(post_v1_browser_tab_activate),
        )
        .route("/browser/tabs/:tab_id", delete(delete_v1_browser_tab))
        .route("/browser/screenshot", get(get_v1_browser_screenshot))
        .route("/browser/pdf", get(get_v1_browser_pdf))
        .route("/browser/content", get(get_v1_browser_content))
        .route("/browser/markdown", get(get_v1_browser_markdown))
        .route("/browser/links", get(get_v1_browser_links))
        .route("/browser/snapshot", get(get_v1_browser_snapshot))
        .route("/browser/scrape", post(post_v1_browser_scrape))
        .route("/browser/execute", post(post_v1_browser_execute))
        .route("/browser/click", post(post_v1_browser_click))
        .route("/browser/type", post(post_v1_browser_type))
        .route("/browser/select", post(post_v1_browser_select))
        .route("/browser/hover", post(post_v1_browser_hover))
        .route("/browser/scroll", post(post_v1_browser_scroll))
        .route("/browser/upload", post(post_v1_browser_upload))
        .route("/browser/dialog", post(post_v1_browser_dialog))
        .route("/browser/console", get(get_v1_browser_console))
        .route("/browser/network", get(get_v1_browser_network))
        .route("/browser/crawl", post(post_v1_browser_crawl))
        .route(
            "/browser/contexts",
            get(get_v1_browser_contexts).post(post_v1_browser_contexts),
        )
        .route(
            "/browser/contexts/:context_id",
            delete(delete_v1_browser_context),
        )
        .route(
            "/browser/cookies",
            get(get_v1_browser_cookies)
                .post(post_v1_browser_cookies)
                .delete(delete_v1_browser_cookies),
        )
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
            "/processes/config",
            get(get_v1_processes_config).post(post_v1_processes_config),
        )
        .route("/processes", get(get_v1_processes).post(post_v1_processes))
        .route("/processes/run", post(post_v1_processes_run))
        .route(
            "/processes/:id",
            get(get_v1_process).delete(delete_v1_process),
        )
        .route("/processes/:id/stop", post(post_v1_process_stop))
        .route("/processes/:id/kill", post(post_v1_process_kill))
        .route("/processes/:id/logs", get(get_v1_process_logs))
        .route("/processes/:id/input", post(post_v1_process_input))
        .route(
            "/processes/:id/terminal/resize",
            post(post_v1_process_terminal_resize),
        )
        .route(
            "/processes/:id/terminal/ws",
            get(get_v1_process_terminal_ws),
        )
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
    state.desktop_runtime().shutdown().await;
}

#[derive(OpenApi)]
#[openapi(
    paths(
        get_v1_health,
        get_v1_desktop_status,
        post_v1_desktop_start,
        post_v1_desktop_stop,
        get_v1_desktop_screenshot,
        get_v1_desktop_screenshot_region,
        get_v1_desktop_mouse_position,
        post_v1_desktop_mouse_move,
        post_v1_desktop_mouse_click,
        post_v1_desktop_mouse_down,
        post_v1_desktop_mouse_up,
        post_v1_desktop_mouse_drag,
        post_v1_desktop_mouse_scroll,
        post_v1_desktop_keyboard_type,
        post_v1_desktop_keyboard_press,
        post_v1_desktop_keyboard_down,
        post_v1_desktop_keyboard_up,
        get_v1_desktop_display_info,
        get_v1_desktop_windows,
        get_v1_desktop_windows_focused,
        post_v1_desktop_window_focus,
        post_v1_desktop_window_move,
        post_v1_desktop_window_resize,
        get_v1_desktop_clipboard,
        post_v1_desktop_clipboard,
        post_v1_desktop_launch,
        post_v1_desktop_open,
        get_v1_desktop_stream_status,
        post_v1_desktop_recording_start,
        post_v1_desktop_recording_stop,
        get_v1_desktop_recordings,
        get_v1_desktop_recording,
        get_v1_desktop_recording_download,
        delete_v1_desktop_recording,
        post_v1_desktop_stream_start,
        post_v1_desktop_stream_stop,
        get_v1_desktop_stream_ws,
        get_v1_browser_status,
        post_v1_browser_start,
        post_v1_browser_stop,
        get_v1_browser_cdp_ws,
        post_v1_browser_navigate,
        post_v1_browser_back,
        post_v1_browser_forward,
        post_v1_browser_reload,
        post_v1_browser_wait,
        get_v1_browser_tabs,
        post_v1_browser_tabs,
        post_v1_browser_tab_activate,
        delete_v1_browser_tab,
        get_v1_browser_screenshot,
        get_v1_browser_pdf,
        get_v1_browser_content,
        get_v1_browser_markdown,
        get_v1_browser_links,
        get_v1_browser_snapshot,
        post_v1_browser_scrape,
        post_v1_browser_execute,
        post_v1_browser_click,
        post_v1_browser_type,
        post_v1_browser_select,
        post_v1_browser_hover,
        post_v1_browser_scroll,
        post_v1_browser_upload,
        post_v1_browser_dialog,
        get_v1_browser_console,
        get_v1_browser_network,
        get_v1_browser_contexts,
        post_v1_browser_contexts,
        delete_v1_browser_context,
        get_v1_browser_cookies,
        post_v1_browser_cookies,
        delete_v1_browser_cookies,
        post_v1_browser_crawl,
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
        get_v1_processes_config,
        post_v1_processes_config,
        post_v1_processes,
        post_v1_processes_run,
        get_v1_processes,
        get_v1_process,
        post_v1_process_stop,
        post_v1_process_kill,
        delete_v1_process,
        get_v1_process_logs,
        post_v1_process_input,
        post_v1_process_terminal_resize,
        get_v1_process_terminal_ws,
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
            DesktopState,
            DesktopResolution,
            DesktopErrorInfo,
            DesktopProcessInfo,
            DesktopStatusResponse,
            DesktopStartRequest,
            DesktopScreenshotQuery,
            DesktopScreenshotFormat,
            DesktopRegionScreenshotQuery,
            DesktopMousePositionResponse,
            DesktopMouseButton,
            DesktopMouseMoveRequest,
            DesktopMouseClickRequest,
            DesktopMouseDownRequest,
            DesktopMouseUpRequest,
            DesktopMouseDragRequest,
            DesktopMouseScrollRequest,
            DesktopKeyboardTypeRequest,
            DesktopKeyboardPressRequest,
            DesktopKeyModifiers,
            DesktopKeyboardDownRequest,
            DesktopKeyboardUpRequest,
            DesktopActionResponse,
            DesktopDisplayInfoResponse,
            DesktopWindowInfo,
            DesktopWindowListResponse,
            DesktopRecordingStartRequest,
            DesktopRecordingStatus,
            DesktopRecordingInfo,
            DesktopRecordingListResponse,
            DesktopStreamStatusResponse,
            BrowserState,
            BrowserStartRequest,
            BrowserStatusResponse,
            BrowserNavigateRequest,
            BrowserNavigateWaitUntil,
            BrowserPageInfo,
            BrowserReloadRequest,
            BrowserWaitRequest,
            BrowserWaitState,
            BrowserWaitResponse,
            BrowserTabInfo,
            BrowserTabListResponse,
            BrowserCreateTabRequest,
            BrowserActionResponse,
            BrowserScreenshotQuery,
            BrowserScreenshotFormat,
            BrowserPdfQuery,
            BrowserPdfFormat,
            BrowserContentQuery,
            BrowserContentResponse,
            BrowserMarkdownResponse,
            BrowserLinkInfo,
            BrowserLinksResponse,
            BrowserSnapshotResponse,
            BrowserScrapeRequest,
            BrowserScrapeResponse,
            BrowserExecuteRequest,
            BrowserExecuteResponse,
            BrowserClickRequest,
            BrowserMouseButton,
            BrowserTypeRequest,
            BrowserSelectRequest,
            BrowserHoverRequest,
            BrowserScrollRequest,
            BrowserUploadRequest,
            BrowserDialogRequest,
            BrowserConsoleQuery,
            BrowserConsoleMessage,
            BrowserConsoleResponse,
            BrowserNetworkQuery,
            BrowserNetworkRequest,
            BrowserNetworkResponse,
            BrowserContextInfo,
            BrowserContextListResponse,
            BrowserContextCreateRequest,
            BrowserCookie,
            BrowserCookieSameSite,
            BrowserCookiesQuery,
            BrowserCookiesResponse,
            BrowserSetCookiesRequest,
            BrowserDeleteCookiesQuery,
            BrowserCrawlRequest,
            BrowserCrawlExtract,
            BrowserCrawlPage,
            BrowserCrawlResponse,
            DesktopClipboardResponse,
            DesktopClipboardQuery,
            DesktopClipboardWriteRequest,
            DesktopLaunchRequest,
            DesktopLaunchResponse,
            DesktopOpenRequest,
            DesktopOpenResponse,
            DesktopWindowMoveRequest,
            DesktopWindowResizeRequest,
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
            ProcessConfig,
            ProcessOwner,
            ProcessCreateRequest,
            ProcessRunRequest,
            ProcessRunResponse,
            ProcessState,
            ProcessInfo,
            ProcessListResponse,
            ProcessListQuery,
            ProcessLogsStream,
            ProcessLogsQuery,
            ProcessLogEntry,
            ProcessLogsResponse,
            ProcessInputRequest,
            ProcessInputResponse,
            ProcessSignalQuery,
            ProcessTerminalResizeRequest,
            ProcessTerminalResizeResponse,
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
    #[error("problem: {0:?}")]
    Problem(ProblemDetails),
}

impl From<ProblemDetails> for ApiError {
    fn from(value: ProblemDetails) -> Self {
        Self::Problem(value)
    }
}

impl From<DesktopProblem> for ApiError {
    fn from(value: DesktopProblem) -> Self {
        Self::Problem(value.to_problem_details())
    }
}

impl From<BrowserProblem> for ApiError {
    fn from(value: BrowserProblem) -> Self {
        Self::Problem(value.to_problem_details())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let problem = match &self {
            ApiError::Sandbox(error) => problem_from_sandbox_error(error),
            ApiError::Problem(problem) => problem.clone(),
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

/// Get desktop runtime status.
///
/// Returns the current desktop runtime state, dependency status, active
/// display metadata, and supervised process information.
#[utoipa::path(
    get,
    path = "/v1/desktop/status",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop runtime status", body = DesktopStatusResponse),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().status().await))
}

/// Start the private desktop runtime.
///
/// Lazily launches the managed Xvfb/openbox stack, validates display health,
/// and returns the resulting desktop status snapshot.
#[utoipa::path(
    post,
    path = "/v1/desktop/start",
    tag = "v1",
    request_body = DesktopStartRequest,
    responses(
        (status = 200, description = "Desktop runtime status after start", body = DesktopStatusResponse),
        (status = 400, description = "Invalid desktop start request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is already transitioning", body = ProblemDetails),
        (status = 501, description = "Desktop API unsupported on this platform", body = ProblemDetails),
        (status = 503, description = "Desktop runtime could not be started", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopStartRequest>,
) -> Result<Json<DesktopStatusResponse>, ApiError> {
    let status = state.desktop_runtime().start(body).await?;
    Ok(Json(status))
}

/// Stop the private desktop runtime.
///
/// Terminates the managed openbox/Xvfb/dbus processes owned by the desktop
/// runtime and returns the resulting status snapshot.
#[utoipa::path(
    post,
    path = "/v1/desktop/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop runtime status after stop", body = DesktopStatusResponse),
        (status = 409, description = "Desktop runtime is already transitioning", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStatusResponse>, ApiError> {
    let status = state.desktop_runtime().stop().await?;
    Ok(Json(status))
}

/// Get browser runtime status.
///
/// Returns the current browser state, display information, CDP URL,
/// and managed process details.
#[utoipa::path(
    get,
    path = "/v1/browser/status",
    tag = "v1",
    responses(
        (status = 200, description = "Browser runtime status", body = BrowserStatusResponse),
        (status = 401, description = "Authentication required", body = ProblemDetails)
    )
)]
async fn get_v1_browser_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserStatusResponse>, ApiError> {
    Ok(Json(state.browser_runtime().status().await))
}

/// Start the browser runtime.
///
/// Launches Chromium with remote debugging, optionally starts Xvfb for
/// non-headless mode, and returns the resulting browser status snapshot.
#[utoipa::path(
    post,
    path = "/v1/browser/start",
    tag = "v1",
    request_body = BrowserStartRequest,
    responses(
        (status = 200, description = "Browser runtime status after start", body = BrowserStatusResponse),
        (status = 400, description = "Invalid browser start request", body = ProblemDetails),
        (status = 409, description = "Browser or desktop runtime conflict", body = ProblemDetails),
        (status = 424, description = "Browser dependencies not installed", body = ProblemDetails),
        (status = 500, description = "Browser runtime could not be started", body = ProblemDetails)
    )
)]
async fn post_v1_browser_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserStartRequest>,
) -> Result<Json<BrowserStatusResponse>, ApiError> {
    let status = state.browser_runtime().start(body).await?;
    Ok(Json(status))
}

/// Stop the browser runtime.
///
/// Terminates Chromium, the CDP client, and any associated Xvfb/Neko
/// processes, then returns the resulting status snapshot.
#[utoipa::path(
    post,
    path = "/v1/browser/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Browser runtime status after stop", body = BrowserStatusResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails)
    )
)]
async fn post_v1_browser_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserStatusResponse>, ApiError> {
    let status = state.browser_runtime().stop().await?;
    Ok(Json(status))
}

/// Open a CDP WebSocket proxy session.
///
/// Upgrades the connection to a WebSocket that relays bidirectionally to
/// Chromium's internal CDP WebSocket endpoint. External tools like Playwright
/// or Puppeteer can connect via `ws://sandbox-host:2468/v1/browser/cdp`.
#[utoipa::path(
    get,
    path = "/v1/browser/cdp",
    tag = "v1",
    responses(
        (status = 101, description = "WebSocket upgraded"),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP connection failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_cdp_ws(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    state.browser_runtime().ensure_active().await?;
    Ok(ws
        .on_upgrade(move |socket| browser_cdp_ws_session(socket, state.browser_runtime()))
        .into_response())
}

/// CDP WebSocket proxy session.
///
/// Proxies the WebSocket bidirectionally between the external client and
/// Chromium's internal CDP WebSocket endpoint. All CDP commands and events
/// are relayed transparently.
async fn browser_cdp_ws_session(mut client_ws: WebSocket, browser_runtime: Arc<BrowserRuntime>) {
    use futures::SinkExt;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    // Discover the actual CDP WebSocket URL from Chromium.
    let cdp_ws_url = match browser_runtime.cdp_ws_url().await {
        Ok(url) => url,
        Err(_) => {
            let _ = send_ws_error(&mut client_ws, "browser CDP endpoint is not available").await;
            let _ = client_ws.close().await;
            return;
        }
    };

    // Connect to Chromium's internal CDP WebSocket.
    let (cdp_ws, _) = match tokio_tungstenite::connect_async(&cdp_ws_url).await {
        Ok(conn) => conn,
        Err(err) => {
            let _ = send_ws_error(
                &mut client_ws,
                &format!("failed to connect to CDP endpoint: {err}"),
            )
            .await;
            let _ = client_ws.close().await;
            return;
        }
    };

    let (mut cdp_sink, mut cdp_stream) = cdp_ws.split();

    // Relay messages bidirectionally between client and CDP.
    loop {
        tokio::select! {
            // Client → CDP
            client_msg = client_ws.recv() => {
                match client_msg {
                    Some(Ok(Message::Text(text))) => {
                        if cdp_sink.send(TungsteniteMessage::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if cdp_sink.send(TungsteniteMessage::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = client_ws.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            // CDP → Client
            cdp_msg = cdp_stream.next() => {
                match cdp_msg {
                    Some(Ok(TungsteniteMessage::Text(text))) => {
                        if client_ws.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Binary(data))) => {
                        if client_ws.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Ping(payload))) => {
                        if cdp_sink.send(TungsteniteMessage::Pong(payload.clone())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Close(_))) | None => break,
                    Some(Ok(TungsteniteMessage::Pong(_))) => {}
                    Some(Ok(TungsteniteMessage::Frame(_))) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    let _ = cdp_sink.close().await;
    let _ = client_ws.close().await;
}

/// Navigate the browser to a URL.
///
/// Sends a CDP `Page.navigate` command and optionally waits for a lifecycle
/// event before returning the resulting page URL, title, and HTTP status.
#[utoipa::path(
    post,
    path = "/v1/browser/navigate",
    tag = "v1",
    request_body = BrowserNavigateRequest,
    responses(
        (status = 200, description = "Navigation result", body = BrowserPageInfo),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_navigate(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserNavigateRequest>,
) -> Result<Json<BrowserPageInfo>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    // Enable Page domain for lifecycle events
    cdp.send("Page.enable", None).await?;

    let nav_result = cdp
        .send(
            "Page.navigate",
            Some(serde_json::json!({ "url": body.url })),
        )
        .await?;

    // Extract HTTP status from the navigation result if available
    let status = nav_result
        .get("errorText")
        .and_then(|_| None::<u16>)
        .or_else(|| {
            // Page.navigate doesn't directly return HTTP status;
            // we rely on frameId being present as a success signal
            nav_result.get("frameId").map(|_| 200u16)
        });

    // Wait for the requested lifecycle event
    match body.wait_until {
        Some(BrowserNavigateWaitUntil::Load) | None => {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Some(BrowserNavigateWaitUntil::Domcontentloaded) => {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        Some(BrowserNavigateWaitUntil::Networkidle) => {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    // Get current page URL and title
    let (url, title) = get_page_info_via_cdp(&cdp).await?;
    Ok(Json(BrowserPageInfo { url, title, status }))
}

/// Navigate the browser back in history.
///
/// Sends a CDP `Page.navigateToHistoryEntry` command with the previous
/// history entry and returns the resulting page URL and title.
#[utoipa::path(
    post,
    path = "/v1/browser/back",
    tag = "v1",
    responses(
        (status = 200, description = "Page info after navigating back", body = BrowserPageInfo),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_back(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserPageInfo>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let history = cdp.send("Page.getNavigationHistory", None).await?;
    let current_index = history
        .get("currentIndex")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let entries = history
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if current_index > 0 {
        if let Some(entry) = entries.get((current_index - 1) as usize) {
            if let Some(entry_id) = entry.get("id").and_then(|v| v.as_i64()) {
                cdp.send(
                    "Page.navigateToHistoryEntry",
                    Some(serde_json::json!({ "entryId": entry_id })),
                )
                .await?;
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        }
    }

    let (url, title) = get_page_info_via_cdp(&cdp).await?;
    Ok(Json(BrowserPageInfo {
        url,
        title,
        status: None,
    }))
}

/// Navigate the browser forward in history.
///
/// Sends a CDP `Page.navigateToHistoryEntry` command with the next
/// history entry and returns the resulting page URL and title.
#[utoipa::path(
    post,
    path = "/v1/browser/forward",
    tag = "v1",
    responses(
        (status = 200, description = "Page info after navigating forward", body = BrowserPageInfo),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_forward(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserPageInfo>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let history = cdp.send("Page.getNavigationHistory", None).await?;
    let current_index = history
        .get("currentIndex")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let entries = history
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if (current_index + 1) < entries.len() as i64 {
        if let Some(entry) = entries.get((current_index + 1) as usize) {
            if let Some(entry_id) = entry.get("id").and_then(|v| v.as_i64()) {
                cdp.send(
                    "Page.navigateToHistoryEntry",
                    Some(serde_json::json!({ "entryId": entry_id })),
                )
                .await?;
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        }
    }

    let (url, title) = get_page_info_via_cdp(&cdp).await?;
    Ok(Json(BrowserPageInfo {
        url,
        title,
        status: None,
    }))
}

/// Reload the current browser page.
///
/// Sends a CDP `Page.reload` command with an optional cache bypass flag
/// and returns the resulting page URL and title.
#[utoipa::path(
    post,
    path = "/v1/browser/reload",
    tag = "v1",
    request_body = BrowserReloadRequest,
    responses(
        (status = 200, description = "Page info after reload", body = BrowserPageInfo),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_reload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserReloadRequest>,
) -> Result<Json<BrowserPageInfo>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let ignore_cache = body.ignore_cache.unwrap_or(false);
    cdp.send(
        "Page.reload",
        Some(serde_json::json!({ "ignoreCache": ignore_cache })),
    )
    .await?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let (url, title) = get_page_info_via_cdp(&cdp).await?;
    Ok(Json(BrowserPageInfo {
        url,
        title,
        status: None,
    }))
}

/// Wait for a selector or condition in the browser.
///
/// Polls the page DOM using `Runtime.evaluate` with a `querySelector` check
/// until the element is found or the timeout expires.
#[utoipa::path(
    post,
    path = "/v1/browser/wait",
    tag = "v1",
    request_body = BrowserWaitRequest,
    responses(
        (status = 200, description = "Wait result", body = BrowserWaitResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails),
        (status = 504, description = "Timeout waiting for condition", body = ProblemDetails)
    )
)]
async fn post_v1_browser_wait(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserWaitRequest>,
) -> Result<Json<BrowserWaitResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let timeout_ms = body.timeout.unwrap_or(5000);
    let selector = body.selector.clone().unwrap_or_else(|| "body".to_string());
    let wait_state = body.state.unwrap_or(BrowserWaitState::Attached);

    let js_expression = match wait_state {
        BrowserWaitState::Visible => {
            format!(
                r#"(() => {{
                    const el = document.querySelector({sel});
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                }})()"#,
                sel = serde_json::to_string(&selector).unwrap_or_default()
            )
        }
        BrowserWaitState::Hidden => {
            format!(
                r#"(() => {{
                    const el = document.querySelector({sel});
                    if (!el) return true;
                    const style = window.getComputedStyle(el);
                    return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
                }})()"#,
                sel = serde_json::to_string(&selector).unwrap_or_default()
            )
        }
        BrowserWaitState::Attached => {
            format!(
                "document.querySelector({sel}) !== null",
                sel = serde_json::to_string(&selector).unwrap_or_default()
            )
        }
    };

    let start = tokio::time::Instant::now();
    let timeout_dur = std::time::Duration::from_millis(timeout_ms);
    let poll_interval = std::time::Duration::from_millis(100);

    loop {
        let eval_result = cdp
            .send(
                "Runtime.evaluate",
                Some(serde_json::json!({
                    "expression": js_expression,
                    "returnByValue": true
                })),
            )
            .await?;

        let found = eval_result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if found {
            return Ok(Json(BrowserWaitResponse { found: true }));
        }

        if start.elapsed() >= timeout_dur {
            return Ok(Json(BrowserWaitResponse { found: false }));
        }

        tokio::time::sleep(poll_interval).await;
    }
}

/// List open browser tabs.
///
/// Returns all open browser tabs (pages) via CDP `Target.getTargets`,
/// filtered to type "page".
#[utoipa::path(
    get,
    path = "/v1/browser/tabs",
    tag = "v1",
    responses(
        (status = 200, description = "List of open browser tabs", body = BrowserTabListResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_tabs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserTabListResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let result = cdp.send("Target.getTargets", None).await?;
    let targets = result
        .get("targetInfos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Get the currently focused target to determine active tab
    let active_target_id = {
        let history = cdp.send("Page.getNavigationHistory", None).await.ok();
        // The page-level commands operate on the currently attached target,
        // so we use Target.getTargets and check which target is the one
        // with the current page's URL to determine the active tab.
        history.and_then(|h| {
            let idx = h.get("currentIndex").and_then(|v| v.as_i64())? as usize;
            let entries = h.get("entries").and_then(|v| v.as_array())?;
            entries
                .get(idx)
                .and_then(|e| e.get("url").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
        })
    };

    let tabs: Vec<BrowserTabInfo> = targets
        .iter()
        .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .map(|t| {
            let id = t
                .get("targetId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let url = t
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = t
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let active = active_target_id
                .as_deref()
                .map(|active_url| active_url == url)
                .unwrap_or(false);
            BrowserTabInfo {
                id,
                url,
                title,
                active,
            }
        })
        .collect();

    Ok(Json(BrowserTabListResponse { tabs }))
}

/// Create a new browser tab.
///
/// Opens a new tab via CDP `Target.createTarget` and returns the tab info.
#[utoipa::path(
    post,
    path = "/v1/browser/tabs",
    tag = "v1",
    request_body = BrowserCreateTabRequest,
    responses(
        (status = 201, description = "New tab created", body = BrowserTabInfo),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_tabs(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserCreateTabRequest>,
) -> Result<(StatusCode, Json<BrowserTabInfo>), ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let url = body.url.unwrap_or_else(|| "about:blank".to_string());
    let result = cdp
        .send(
            "Target.createTarget",
            Some(serde_json::json!({ "url": url })),
        )
        .await?;

    let target_id = result
        .get("targetId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Give the page a moment to start loading
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Get target info for the newly created tab
    let targets_result = cdp.send("Target.getTargets", None).await?;
    let targets = targets_result
        .get("targetInfos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let tab_info = targets
        .iter()
        .find(|t| t.get("targetId").and_then(|v| v.as_str()) == Some(&target_id));

    let (tab_url, tab_title) = tab_info
        .map(|t| {
            let u = t
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let ti = t
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (u, ti)
        })
        .unwrap_or_else(|| (url, String::new()));

    Ok((
        StatusCode::CREATED,
        Json(BrowserTabInfo {
            id: target_id,
            url: tab_url,
            title: tab_title,
            active: false,
        }),
    ))
}

/// Activate a browser tab.
///
/// Brings the specified tab to the foreground via CDP `Target.activateTarget`.
#[utoipa::path(
    post,
    path = "/v1/browser/tabs/{tab_id}/activate",
    tag = "v1",
    params(
        ("tab_id" = String, Path, description = "Target ID of the tab to activate")
    ),
    responses(
        (status = 200, description = "Tab activated", body = BrowserTabInfo),
        (status = 404, description = "Tab not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_tab_activate(
    State(state): State<Arc<AppState>>,
    Path(tab_id): Path<String>,
) -> Result<Json<BrowserTabInfo>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    // Verify the target exists first
    let targets_result = cdp.send("Target.getTargets", None).await?;
    let targets = targets_result
        .get("targetInfos")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let target = targets
        .iter()
        .find(|t| t.get("targetId").and_then(|v| v.as_str()) == Some(&tab_id));

    let target = match target {
        Some(t) => t.clone(),
        None => return Err(BrowserProblem::not_found(&format!("Tab {} not found", tab_id)).into()),
    };

    cdp.send(
        "Target.activateTarget",
        Some(serde_json::json!({ "targetId": tab_id })),
    )
    .await?;

    let url = target
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = target
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(Json(BrowserTabInfo {
        id: tab_id,
        url,
        title,
        active: true,
    }))
}

/// Close a browser tab.
///
/// Closes the specified tab via CDP `Target.closeTarget`.
#[utoipa::path(
    delete,
    path = "/v1/browser/tabs/{tab_id}",
    tag = "v1",
    params(
        ("tab_id" = String, Path, description = "Target ID of the tab to close")
    ),
    responses(
        (status = 200, description = "Tab closed", body = BrowserActionResponse),
        (status = 404, description = "Tab not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn delete_v1_browser_tab(
    State(state): State<Arc<AppState>>,
    Path(tab_id): Path<String>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let result = cdp
        .send(
            "Target.closeTarget",
            Some(serde_json::json!({ "targetId": tab_id })),
        )
        .await?;

    let success = result
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !success {
        return Err(BrowserProblem::not_found(&format!("Tab {} not found", tab_id)).into());
    }

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Capture a browser page screenshot.
///
/// Captures a screenshot of the current browser page via CDP
/// `Page.captureScreenshot` and returns the image bytes with the appropriate
/// Content-Type header.
#[utoipa::path(
    get,
    path = "/v1/browser/screenshot",
    tag = "v1",
    params(BrowserScreenshotQuery),
    responses(
        (status = 200, description = "Browser screenshot as image bytes"),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_screenshot(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserScreenshotQuery>,
) -> Result<Response, ApiError> {
    use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
    use base64::Engine;

    let cdp = state.browser_runtime().get_cdp().await?;

    let fmt = query.format.unwrap_or(BrowserScreenshotFormat::Png);
    let cdp_format = match fmt {
        BrowserScreenshotFormat::Png => "png",
        BrowserScreenshotFormat::Jpeg => "jpeg",
        BrowserScreenshotFormat::Webp => "webp",
    };

    let mut params = serde_json::json!({ "format": cdp_format });
    if let Some(quality) = query.quality {
        params["quality"] = serde_json::json!(quality);
    }
    if query.full_page.unwrap_or(false) {
        params["captureBeyondViewport"] = serde_json::json!(true);
    }
    if let Some(ref selector) = query.selector {
        // Resolve element bounding box for clip region
        let js = format!(
            r#"(() => {{
                const el = document.querySelector({selector});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {{ x: r.x, y: r.y, width: r.width, height: r.height }};
            }})()"#,
            selector = serde_json::to_string(selector).unwrap_or_default()
        );
        let eval_result = cdp
            .send(
                "Runtime.evaluate",
                Some(serde_json::json!({
                    "expression": js,
                    "returnByValue": true
                })),
            )
            .await?;
        if let Some(value) = eval_result.get("result").and_then(|r| r.get("value")) {
            if !value.is_null() {
                params["clip"] = serde_json::json!({
                    "x": value.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    "y": value.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    "width": value.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    "height": value.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    "scale": 1
                });
            } else {
                return Err(BrowserProblem::invalid_selector(&format!(
                    "No element matches selector: {}",
                    selector
                ))
                .into());
            }
        }
    }

    let result = cdp.send("Page.captureScreenshot", Some(params)).await?;

    let data_b64 = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = BASE64_ENGINE
        .decode(data_b64)
        .map_err(|e| BrowserProblem::cdp_error(&format!("Failed to decode screenshot: {}", e)))?;

    let content_type = match fmt {
        BrowserScreenshotFormat::Png => "image/png",
        BrowserScreenshotFormat::Jpeg => "image/jpeg",
        BrowserScreenshotFormat::Webp => "image/webp",
    };

    Ok(([(header::CONTENT_TYPE, content_type)], Bytes::from(bytes)).into_response())
}

/// Generate a PDF of the current browser page.
///
/// Generates a PDF document from the current page via CDP `Page.printToPDF`
/// and returns the PDF bytes.
#[utoipa::path(
    get,
    path = "/v1/browser/pdf",
    tag = "v1",
    params(BrowserPdfQuery),
    responses(
        (status = 200, description = "Browser page as PDF bytes"),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_pdf(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserPdfQuery>,
) -> Result<Response, ApiError> {
    use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
    use base64::Engine;

    let cdp = state.browser_runtime().get_cdp().await?;

    let (paper_width, paper_height) = match query.format.unwrap_or(BrowserPdfFormat::Letter) {
        BrowserPdfFormat::A4 => (8.27_f64, 11.69_f64),
        BrowserPdfFormat::Letter => (8.5_f64, 11.0_f64),
        BrowserPdfFormat::Legal => (8.5_f64, 14.0_f64),
    };

    let mut params = serde_json::json!({
        "paperWidth": paper_width,
        "paperHeight": paper_height,
    });
    if let Some(landscape) = query.landscape {
        params["landscape"] = serde_json::json!(landscape);
    }
    if let Some(print_background) = query.print_background {
        params["printBackground"] = serde_json::json!(print_background);
    }
    if let Some(scale) = query.scale {
        params["scale"] = serde_json::json!(scale);
    }

    let result = cdp.send("Page.printToPDF", Some(params)).await?;

    let data_b64 = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
    let bytes = BASE64_ENGINE
        .decode(data_b64)
        .map_err(|e| BrowserProblem::cdp_error(&format!("Failed to decode PDF: {}", e)))?;

    Ok((
        [(header::CONTENT_TYPE, "application/pdf")],
        Bytes::from(bytes),
    )
        .into_response())
}

/// Get the HTML content of the current browser page.
///
/// Returns the outerHTML of the page or a specific element selected by a CSS
/// selector, along with the current URL and title.
#[utoipa::path(
    get,
    path = "/v1/browser/content",
    tag = "v1",
    params(BrowserContentQuery),
    responses(
        (status = 200, description = "Page HTML content", body = BrowserContentResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_content(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserContentQuery>,
) -> Result<Json<BrowserContentResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;
    let (url, title) = get_page_info_via_cdp(&cdp).await?;

    let expression = if let Some(ref selector) = query.selector {
        let escaped = selector.replace('\\', "\\\\").replace('\'', "\\'");
        format!(
            "(function() {{ var el = document.querySelector('{}'); return el ? el.outerHTML : null; }})()",
            escaped
        )
    } else {
        "document.documentElement.outerHTML".to_string()
    };

    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;

    let html = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if query.selector.is_some() && html.is_empty() {
        return Err(BrowserProblem::not_found(&format!(
            "Element not found: {}",
            query.selector.as_deref().unwrap_or("")
        ))
        .into());
    }

    Ok(Json(BrowserContentResponse { html, url, title }))
}

/// Get the page content as Markdown.
///
/// Extracts the DOM HTML via CDP, strips navigation/footer/aside elements, and
/// converts the remaining content to Markdown using html2md.
#[utoipa::path(
    get,
    path = "/v1/browser/markdown",
    tag = "v1",
    responses(
        (status = 200, description = "Page content as Markdown", body = BrowserMarkdownResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_markdown(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserMarkdownResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;
    let (url, title) = get_page_info_via_cdp(&cdp).await?;

    // Extract body HTML with nav/footer/aside stripped out
    let expression = r#"
        (function() {
            var clone = document.body.cloneNode(true);
            var selectors = ['nav', 'footer', 'aside', 'header', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'];
            selectors.forEach(function(sel) {
                clone.querySelectorAll(sel).forEach(function(el) { el.remove(); });
            });
            return clone.innerHTML;
        })()
    "#;

    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;

    let html = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let markdown = html2md::parse_html(html);

    Ok(Json(BrowserMarkdownResponse {
        markdown,
        url,
        title,
    }))
}

/// Get all links on the current page.
///
/// Extracts all anchor elements from the page via CDP and returns their href
/// and text content.
#[utoipa::path(
    get,
    path = "/v1/browser/links",
    tag = "v1",
    responses(
        (status = 200, description = "Links on the page", body = BrowserLinksResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_links(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserLinksResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;
    let (url, _title) = get_page_info_via_cdp(&cdp).await?;

    let expression = r#"
        (function() {
            var links = [];
            document.querySelectorAll('a[href]').forEach(function(a) {
                links.push({ href: a.href, text: (a.textContent || '').trim() });
            });
            return JSON.stringify(links);
        })()
    "#;

    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;

    let json_str = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("[]");

    let links: Vec<BrowserLinkInfo> = serde_json::from_str(json_str).unwrap_or_default();

    Ok(Json(BrowserLinksResponse { links, url }))
}

/// Get an accessibility tree snapshot of the current page.
///
/// Returns a text representation of the page accessibility tree via CDP
/// `Accessibility.getFullAXTree`.
#[utoipa::path(
    get,
    path = "/v1/browser/snapshot",
    tag = "v1",
    responses(
        (status = 200, description = "Accessibility tree snapshot", body = BrowserSnapshotResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_snapshot(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserSnapshotResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;
    let (url, title) = get_page_info_via_cdp(&cdp).await?;

    let result = cdp.send("Accessibility.getFullAXTree", None).await?;

    // Format the AX tree into a readable text snapshot
    let nodes = result
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut snapshot = String::new();
    for node in &nodes {
        let role = node
            .get("role")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let name = node
            .get("name")
            .and_then(|n| n.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if role == "none" || role == "GenericContainer" || (role.is_empty() && name.is_empty()) {
            continue;
        }

        if !snapshot.is_empty() {
            snapshot.push('\n');
        }
        if name.is_empty() {
            snapshot.push_str(role);
        } else {
            snapshot.push_str(&format!("{}: {}", role, name));
        }
    }

    Ok(Json(BrowserSnapshotResponse {
        snapshot,
        url,
        title,
    }))
}

/// Scrape structured data from the current page using CSS selectors.
///
/// For each key in the `selectors` map, runs `querySelectorAll` with the CSS
/// selector value and collects `textContent` from every match. If `url` is
/// provided the browser navigates there first.
#[utoipa::path(
    post,
    path = "/v1/browser/scrape",
    tag = "v1",
    request_body = BrowserScrapeRequest,
    responses(
        (status = 200, description = "Scraped data", body = BrowserScrapeResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_scrape(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserScrapeRequest>,
) -> Result<Json<BrowserScrapeResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    // Navigate first if a URL was provided
    if let Some(ref url) = body.url {
        cdp.send("Page.enable", None).await?;
        cdp.send("Page.navigate", Some(serde_json::json!({ "url": url })))
            .await?;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // Build a JS expression that evaluates all selectors and returns a JSON object
    let selectors_json = serde_json::to_string(&body.selectors)
        .map_err(|e| BrowserProblem::cdp_error(e.to_string()))?;

    let expression = format!(
        r#"(() => {{
            const selectors = {selectors_json};
            const result = {{}};
            for (const [key, sel] of Object.entries(selectors)) {{
                const els = document.querySelectorAll(sel);
                result[key] = Array.from(els).map(el => (el.textContent || '').trim());
            }}
            return JSON.stringify(result);
        }})()"#
    );

    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;

    let json_str = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("{}");

    let data: std::collections::HashMap<String, Vec<String>> =
        serde_json::from_str(json_str).unwrap_or_default();

    let (url, title) = get_page_info_via_cdp(&cdp).await?;

    Ok(Json(BrowserScrapeResponse { data, url, title }))
}

/// Execute a JavaScript expression in the browser.
///
/// Evaluates the given expression via CDP `Runtime.evaluate` and returns the
/// result value and its type. Set `awaitPromise` to resolve async expressions.
#[utoipa::path(
    post,
    path = "/v1/browser/execute",
    tag = "v1",
    request_body = BrowserExecuteRequest,
    responses(
        (status = 200, description = "Execution result", body = BrowserExecuteResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_execute(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserExecuteRequest>,
) -> Result<Json<BrowserExecuteResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let mut params = serde_json::json!({
        "expression": body.expression,
        "returnByValue": true
    });

    if let Some(true) = body.await_promise {
        params["awaitPromise"] = serde_json::json!(true);
    }

    let result = cdp.send("Runtime.evaluate", Some(params)).await?;

    // Check for evaluation exceptions
    if let Some(exception) = result.get("exceptionDetails") {
        let msg = exception
            .get("exception")
            .and_then(|e| e.get("description"))
            .and_then(|d| d.as_str())
            .or_else(|| exception.get("text").and_then(|t| t.as_str()))
            .unwrap_or("Script execution failed");
        return Err(BrowserProblem::cdp_error(msg.to_string()).into());
    }

    let eval_result = result
        .get("result")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let type_ = eval_result
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("undefined")
        .to_string();

    let value = eval_result
        .get("value")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    Ok(Json(BrowserExecuteResponse {
        result: value,
        type_,
    }))
}

/// Click an element in the browser page.
///
/// Finds the element matching `selector`, computes its center point via
/// `DOM.getBoxModel`, and dispatches mouse events through `Input.dispatchMouseEvent`.
#[utoipa::path(
    post,
    path = "/v1/browser/click",
    tag = "v1",
    request_body = BrowserClickRequest,
    responses(
        (status = 200, description = "Click performed", body = BrowserActionResponse),
        (status = 404, description = "Element not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_click(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserClickRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    cdp.send("DOM.enable", None).await?;

    // Get document root
    let doc = cdp.send("DOM.getDocument", None).await?;
    let root_id = doc
        .get("root")
        .and_then(|r| r.get("nodeId"))
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    // Find element by selector
    let qs_result = cdp
        .send(
            "DOM.querySelector",
            Some(serde_json::json!({
                "nodeId": root_id,
                "selector": body.selector
            })),
        )
        .await?;

    let node_id = qs_result
        .get("nodeId")
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    if node_id == 0 {
        return Err(
            BrowserProblem::not_found(format!("Element not found: {}", body.selector)).into(),
        );
    }

    // Get element box model for center coordinates
    let box_model = cdp
        .send(
            "DOM.getBoxModel",
            Some(serde_json::json!({ "nodeId": node_id })),
        )
        .await?;

    let content = box_model
        .get("model")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .ok_or_else(|| BrowserProblem::cdp_error("Failed to get element box model".to_string()))?;

    // content is [x1,y1, x2,y2, x3,y3, x4,y4] – compute center
    let x = content
        .iter()
        .step_by(2)
        .filter_map(|v| v.as_f64())
        .sum::<f64>()
        / 4.0;
    let y = content
        .iter()
        .skip(1)
        .step_by(2)
        .filter_map(|v| v.as_f64())
        .sum::<f64>()
        / 4.0;

    let button = match body.button {
        Some(BrowserMouseButton::Right) => "right",
        Some(BrowserMouseButton::Middle) => "middle",
        _ => "left",
    };
    let click_count = body.click_count.unwrap_or(1);

    // Dispatch mousePressed + mouseReleased
    cdp.send(
        "Input.dispatchMouseEvent",
        Some(serde_json::json!({
            "type": "mousePressed",
            "x": x,
            "y": y,
            "button": button,
            "clickCount": click_count
        })),
    )
    .await?;

    cdp.send(
        "Input.dispatchMouseEvent",
        Some(serde_json::json!({
            "type": "mouseReleased",
            "x": x,
            "y": y,
            "button": button,
            "clickCount": click_count
        })),
    )
    .await?;

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Type text into a focused element.
///
/// Finds the element matching `selector`, focuses it via `DOM.focus`, optionally
/// clears existing content, then dispatches key events for each character.
#[utoipa::path(
    post,
    path = "/v1/browser/type",
    tag = "v1",
    request_body = BrowserTypeRequest,
    responses(
        (status = 200, description = "Text typed", body = BrowserActionResponse),
        (status = 404, description = "Element not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_type(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserTypeRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    cdp.send("DOM.enable", None).await?;

    // Get document root and find element
    let doc = cdp.send("DOM.getDocument", None).await?;
    let root_id = doc
        .get("root")
        .and_then(|r| r.get("nodeId"))
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    let qs_result = cdp
        .send(
            "DOM.querySelector",
            Some(serde_json::json!({
                "nodeId": root_id,
                "selector": body.selector
            })),
        )
        .await?;

    let node_id = qs_result
        .get("nodeId")
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    if node_id == 0 {
        return Err(
            BrowserProblem::not_found(format!("Element not found: {}", body.selector)).into(),
        );
    }

    // Focus the element
    cdp.send("DOM.focus", Some(serde_json::json!({ "nodeId": node_id })))
        .await?;

    // Clear existing content if requested
    if body.clear == Some(true) {
        cdp.send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": format!(
                    "document.querySelector('{}').value = ''",
                    body.selector.replace('\'', "\\'")
                ),
                "returnByValue": true
            })),
        )
        .await?;
    }

    // Type each character via Input.dispatchKeyEvent
    let delay_ms = body.delay.unwrap_or(0);
    for ch in body.text.chars() {
        cdp.send(
            "Input.dispatchKeyEvent",
            Some(serde_json::json!({
                "type": "keyDown",
                "text": ch.to_string()
            })),
        )
        .await?;

        cdp.send(
            "Input.dispatchKeyEvent",
            Some(serde_json::json!({
                "type": "keyUp",
                "text": ch.to_string()
            })),
        )
        .await?;

        if delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
    }

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Select an option in a `<select>` element.
///
/// Finds the element matching `selector` and sets its value via `Runtime.evaluate`,
/// then dispatches a `change` event so listeners fire.
#[utoipa::path(
    post,
    path = "/v1/browser/select",
    tag = "v1",
    request_body = BrowserSelectRequest,
    responses(
        (status = 200, description = "Option selected", body = BrowserActionResponse),
        (status = 404, description = "Element not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_select(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserSelectRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let escaped_selector = body.selector.replace('\\', "\\\\").replace('\'', "\\'");
    let escaped_value = body.value.replace('\\', "\\\\").replace('\'', "\\'");

    let expression = format!(
        r#"(() => {{
            const el = document.querySelector('{escaped_selector}');
            if (!el) return 'not_found';
            el.value = '{escaped_value}';
            el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            return 'ok';
        }})()"#
    );

    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;

    let value = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("error");

    if value == "not_found" {
        return Err(
            BrowserProblem::not_found(format!("Element not found: {}", body.selector)).into(),
        );
    }

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Hover over an element.
///
/// Finds the element matching `selector`, computes its center via `DOM.getBoxModel`,
/// and dispatches a `mouseMoved` event.
#[utoipa::path(
    post,
    path = "/v1/browser/hover",
    tag = "v1",
    request_body = BrowserHoverRequest,
    responses(
        (status = 200, description = "Hover performed", body = BrowserActionResponse),
        (status = 404, description = "Element not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_hover(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserHoverRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    cdp.send("DOM.enable", None).await?;

    let doc = cdp.send("DOM.getDocument", None).await?;
    let root_id = doc
        .get("root")
        .and_then(|r| r.get("nodeId"))
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    let qs_result = cdp
        .send(
            "DOM.querySelector",
            Some(serde_json::json!({
                "nodeId": root_id,
                "selector": body.selector
            })),
        )
        .await?;

    let node_id = qs_result
        .get("nodeId")
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    if node_id == 0 {
        return Err(
            BrowserProblem::not_found(format!("Element not found: {}", body.selector)).into(),
        );
    }

    let box_model = cdp
        .send(
            "DOM.getBoxModel",
            Some(serde_json::json!({ "nodeId": node_id })),
        )
        .await?;

    let content = box_model
        .get("model")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .ok_or_else(|| BrowserProblem::cdp_error("Failed to get element box model".to_string()))?;

    let x = content
        .iter()
        .step_by(2)
        .filter_map(|v| v.as_f64())
        .sum::<f64>()
        / 4.0;
    let y = content
        .iter()
        .skip(1)
        .step_by(2)
        .filter_map(|v| v.as_f64())
        .sum::<f64>()
        / 4.0;

    cdp.send(
        "Input.dispatchMouseEvent",
        Some(serde_json::json!({
            "type": "mouseMoved",
            "x": x,
            "y": y
        })),
    )
    .await?;

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Scroll the page or a specific element.
///
/// If a `selector` is provided, scrolls that element. Otherwise scrolls the
/// page window by the given `x` and `y` pixel offsets.
#[utoipa::path(
    post,
    path = "/v1/browser/scroll",
    tag = "v1",
    request_body = BrowserScrollRequest,
    responses(
        (status = 200, description = "Scroll performed", body = BrowserActionResponse),
        (status = 404, description = "Element not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_scroll(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserScrollRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let x = body.x.unwrap_or(0);
    let y = body.y.unwrap_or(0);

    let expression = if let Some(ref selector) = body.selector {
        let escaped = selector.replace('\\', "\\\\").replace('\'', "\\'");
        format!(
            r#"(() => {{
                const el = document.querySelector('{escaped}');
                if (!el) return 'not_found';
                el.scrollBy({x}, {y});
                return 'ok';
            }})()"#
        )
    } else {
        format!(
            r#"(() => {{
                window.scrollBy({x}, {y});
                return 'ok';
            }})()"#
        )
    };

    let result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": expression,
                "returnByValue": true
            })),
        )
        .await?;

    let value = result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("error");

    if value == "not_found" {
        return Err(BrowserProblem::not_found(format!(
            "Element not found: {}",
            body.selector.unwrap_or_default()
        ))
        .into());
    }

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Upload a file to a file input element in the browser page.
///
/// Resolves the file input element matching `selector` and sets the specified
/// file path using `DOM.setFileInputFiles`.
#[utoipa::path(
    post,
    path = "/v1/browser/upload",
    tag = "v1",
    request_body = BrowserUploadRequest,
    responses(
        (status = 200, description = "File uploaded to input", body = BrowserActionResponse),
        (status = 404, description = "Element not found", body = ProblemDetails),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_upload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserUploadRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    cdp.send("DOM.enable", None).await?;

    // Get document root
    let doc = cdp.send("DOM.getDocument", None).await?;
    let root_id = doc
        .get("root")
        .and_then(|r| r.get("nodeId"))
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    // Find file input element by selector
    let qs_result = cdp
        .send(
            "DOM.querySelector",
            Some(serde_json::json!({
                "nodeId": root_id,
                "selector": body.selector
            })),
        )
        .await?;

    let node_id = qs_result
        .get("nodeId")
        .and_then(|n| n.as_i64())
        .unwrap_or(0);

    if node_id == 0 {
        return Err(
            BrowserProblem::not_found(format!("Element not found: {}", body.selector)).into(),
        );
    }

    // Set file input files
    cdp.send(
        "DOM.setFileInputFiles",
        Some(serde_json::json!({
            "files": [body.path],
            "nodeId": node_id
        })),
    )
    .await?;

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Handle a JavaScript dialog (alert, confirm, prompt) in the browser.
///
/// Accepts or dismisses the currently open dialog using
/// `Page.handleJavaScriptDialog`, optionally providing prompt text.
#[utoipa::path(
    post,
    path = "/v1/browser/dialog",
    tag = "v1",
    request_body = BrowserDialogRequest,
    responses(
        (status = 200, description = "Dialog handled", body = BrowserActionResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_dialog(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserDialogRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let mut params = serde_json::json!({
        "accept": body.accept
    });

    if let Some(ref text) = body.text {
        params
            .as_object_mut()
            .unwrap()
            .insert("promptText".to_string(), serde_json::json!(text));
    }

    cdp.send("Page.handleJavaScriptDialog", Some(params))
        .await?;

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Get browser console messages.
///
/// Returns console messages captured from the browser, optionally filtered by
/// level (log, debug, info, warning, error) and limited in count.
#[utoipa::path(
    get,
    path = "/v1/browser/console",
    tag = "v1",
    params(BrowserConsoleQuery),
    responses(
        (status = 200, description = "Console messages retrieved", body = BrowserConsoleResponse),
        (status = 409, description = "Browser not active", body = ProblemDetails),
        (status = 500, description = "Internal error", body = ProblemDetails)
    )
)]
async fn get_v1_browser_console(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserConsoleQuery>,
) -> Result<Json<BrowserConsoleResponse>, ApiError> {
    state.browser_runtime().ensure_active().await?;
    let messages = state
        .browser_runtime()
        .console_messages(query.level.as_deref(), query.limit)
        .await;
    Ok(Json(BrowserConsoleResponse { messages }))
}

/// Get browser network requests.
///
/// Returns network requests captured from the browser, optionally filtered by
/// URL pattern and limited in count.
#[utoipa::path(
    get,
    path = "/v1/browser/network",
    tag = "v1",
    params(BrowserNetworkQuery),
    responses(
        (status = 200, description = "Network requests retrieved", body = BrowserNetworkResponse),
        (status = 409, description = "Browser not active", body = ProblemDetails),
        (status = 500, description = "Internal error", body = ProblemDetails)
    )
)]
async fn get_v1_browser_network(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserNetworkQuery>,
) -> Result<Json<BrowserNetworkResponse>, ApiError> {
    state.browser_runtime().ensure_active().await?;
    let requests = state
        .browser_runtime()
        .network_requests(query.url_pattern.as_deref(), query.limit)
        .await;
    Ok(Json(BrowserNetworkResponse { requests }))
}

/// List browser contexts (persistent profiles).
///
/// Returns all browser context directories with their name, creation date,
/// and on-disk size.
#[utoipa::path(
    get,
    path = "/v1/browser/contexts",
    tag = "v1",
    responses(
        (status = 200, description = "Browser contexts listed", body = BrowserContextListResponse),
        (status = 500, description = "Internal error", body = ProblemDetails)
    )
)]
async fn get_v1_browser_contexts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BrowserContextListResponse>, ApiError> {
    let contexts = crate::browser_context::list_contexts(state.browser_runtime().state_dir())?;
    Ok(Json(BrowserContextListResponse { contexts }))
}

/// Create a browser context (persistent profile).
///
/// Creates a new browser context directory that can be passed as contextId
/// to the browser start endpoint for persistent cookies and storage.
#[utoipa::path(
    post,
    path = "/v1/browser/contexts",
    tag = "v1",
    request_body = BrowserContextCreateRequest,
    responses(
        (status = 201, description = "Browser context created", body = BrowserContextInfo),
        (status = 500, description = "Internal error", body = ProblemDetails)
    )
)]
async fn post_v1_browser_contexts(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserContextCreateRequest>,
) -> Result<(StatusCode, Json<BrowserContextInfo>), ApiError> {
    let info = crate::browser_context::create_context(state.browser_runtime().state_dir(), body)?;
    Ok((StatusCode::CREATED, Json(info)))
}

/// Delete a browser context (persistent profile).
///
/// Removes the browser context directory and all stored data (cookies,
/// local storage, cache, etc.).
#[utoipa::path(
    delete,
    path = "/v1/browser/contexts/{context_id}",
    tag = "v1",
    params(
        ("context_id" = String, Path, description = "Browser context ID")
    ),
    responses(
        (status = 200, description = "Browser context deleted", body = BrowserActionResponse),
        (status = 404, description = "Browser context not found", body = ProblemDetails),
        (status = 500, description = "Internal error", body = ProblemDetails)
    )
)]
async fn delete_v1_browser_context(
    State(state): State<Arc<AppState>>,
    Path(context_id): Path<String>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    crate::browser_context::delete_context(state.browser_runtime().state_dir(), &context_id)?;
    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Get browser cookies.
///
/// Returns cookies from the browser, optionally filtered by URL.
/// Uses CDP Network.getCookies.
#[utoipa::path(
    get,
    path = "/v1/browser/cookies",
    tag = "v1",
    params(BrowserCookiesQuery),
    responses(
        (status = 200, description = "Cookies retrieved", body = BrowserCookiesResponse),
        (status = 409, description = "Browser not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn get_v1_browser_cookies(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserCookiesQuery>,
) -> Result<Json<BrowserCookiesResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let params = match &query.url {
        Some(url) => Some(serde_json::json!({ "urls": [url] })),
        None => None,
    };

    let result = cdp.send("Network.getCookies", params).await?;

    let cdp_cookies = result
        .get("cookies")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let cookies = cdp_cookies
        .into_iter()
        .filter_map(|c| {
            Some(BrowserCookie {
                name: c.get("name")?.as_str()?.to_string(),
                value: c.get("value")?.as_str()?.to_string(),
                domain: c
                    .get("domain")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                path: c
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                expires: c
                    .get("expires")
                    .and_then(|v| v.as_f64())
                    .filter(|&e| e > 0.0),
                http_only: c.get("httpOnly").and_then(|v| v.as_bool()),
                secure: c.get("secure").and_then(|v| v.as_bool()),
                same_site: c
                    .get("sameSite")
                    .and_then(|v| v.as_str())
                    .and_then(|s| match s {
                        "Strict" => Some(BrowserCookieSameSite::Strict),
                        "Lax" => Some(BrowserCookieSameSite::Lax),
                        "None" => Some(BrowserCookieSameSite::None),
                        _ => None,
                    }),
            })
        })
        .collect();

    Ok(Json(BrowserCookiesResponse { cookies }))
}

/// Set browser cookies.
///
/// Sets one or more cookies in the browser via CDP Network.setCookies.
#[utoipa::path(
    post,
    path = "/v1/browser/cookies",
    tag = "v1",
    request_body = BrowserSetCookiesRequest,
    responses(
        (status = 200, description = "Cookies set", body = BrowserActionResponse),
        (status = 409, description = "Browser not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_cookies(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserSetCookiesRequest>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    let cdp_cookies: Vec<serde_json::Value> = body
        .cookies
        .iter()
        .map(|c| {
            let mut cookie = serde_json::json!({
                "name": c.name,
                "value": c.value,
            });
            let obj = cookie.as_object_mut().unwrap();
            if let Some(ref domain) = c.domain {
                obj.insert("domain".into(), serde_json::json!(domain));
            }
            if let Some(ref path) = c.path {
                obj.insert("path".into(), serde_json::json!(path));
            }
            if let Some(expires) = c.expires {
                obj.insert("expires".into(), serde_json::json!(expires));
            }
            if let Some(http_only) = c.http_only {
                obj.insert("httpOnly".into(), serde_json::json!(http_only));
            }
            if let Some(secure) = c.secure {
                obj.insert("secure".into(), serde_json::json!(secure));
            }
            if let Some(same_site) = &c.same_site {
                let ss = match same_site {
                    BrowserCookieSameSite::Strict => "Strict",
                    BrowserCookieSameSite::Lax => "Lax",
                    BrowserCookieSameSite::None => "None",
                };
                obj.insert("sameSite".into(), serde_json::json!(ss));
            }
            cookie
        })
        .collect();

    cdp.send(
        "Network.setCookies",
        Some(serde_json::json!({ "cookies": cdp_cookies })),
    )
    .await?;

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Delete browser cookies.
///
/// Deletes cookies matching the given name and/or domain. If no filters are
/// provided, clears all browser cookies.
#[utoipa::path(
    delete,
    path = "/v1/browser/cookies",
    tag = "v1",
    params(BrowserDeleteCookiesQuery),
    responses(
        (status = 200, description = "Cookies deleted", body = BrowserActionResponse),
        (status = 409, description = "Browser not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn delete_v1_browser_cookies(
    State(state): State<Arc<AppState>>,
    Query(query): Query<BrowserDeleteCookiesQuery>,
) -> Result<Json<BrowserActionResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;

    if query.name.is_none() && query.domain.is_none() {
        // Clear all cookies
        cdp.send("Network.clearBrowserCookies", None).await?;
    } else {
        // Get current cookies, filter matching ones, delete each
        let result = cdp.send("Network.getCookies", None).await?;
        let cdp_cookies = result
            .get("cookies")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        for cookie in &cdp_cookies {
            let cookie_name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let cookie_domain = cookie.get("domain").and_then(|v| v.as_str()).unwrap_or("");

            let name_matches = query.name.as_deref().map_or(true, |n| n == cookie_name);
            let domain_matches = query
                .domain
                .as_deref()
                .map_or(true, |d| cookie_domain.contains(d));

            if name_matches && domain_matches {
                let mut params = serde_json::json!({ "name": cookie_name });
                let obj = params.as_object_mut().unwrap();
                if !cookie_domain.is_empty() {
                    obj.insert("domain".into(), serde_json::json!(cookie_domain));
                }
                if let Some(path) = cookie.get("path").and_then(|v| v.as_str()) {
                    obj.insert("path".into(), serde_json::json!(path));
                }
                cdp.send("Network.deleteCookies", Some(params)).await?;
            }
        }
    }

    Ok(Json(BrowserActionResponse { ok: true }))
}

/// Crawl multiple pages starting from a URL.
///
/// Performs a breadth-first crawl: navigates to each page, extracts content in
/// the requested format, collects links, and follows them within the configured
/// domain and depth limits.
#[utoipa::path(
    post,
    path = "/v1/browser/crawl",
    tag = "v1",
    request_body = BrowserCrawlRequest,
    responses(
        (status = 200, description = "Crawl results", body = BrowserCrawlResponse),
        (status = 409, description = "Browser runtime is not active", body = ProblemDetails),
        (status = 502, description = "CDP command failed", body = ProblemDetails)
    )
)]
async fn post_v1_browser_crawl(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BrowserCrawlRequest>,
) -> Result<Json<BrowserCrawlResponse>, ApiError> {
    let cdp = state.browser_runtime().get_cdp().await?;
    let response = crate::browser_crawl::crawl_pages(&cdp, &body).await?;
    Ok(Json(response))
}

/// Helper: get the current page URL and title via CDP Runtime.evaluate.
async fn get_page_info_via_cdp(
    cdp: &crate::browser_cdp::CdpClient,
) -> Result<(String, String), BrowserProblem> {
    let url_result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": "document.location.href",
                "returnByValue": true
            })),
        )
        .await?;
    let url = url_result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let title_result = cdp
        .send(
            "Runtime.evaluate",
            Some(serde_json::json!({
                "expression": "document.title",
                "returnByValue": true
            })),
        )
        .await?;
    let title = title_result
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok((url, title))
}

/// Capture a full desktop screenshot.
///
/// Performs a health-gated full-frame screenshot of the managed desktop and
/// returns the requested image bytes.
#[utoipa::path(
    get,
    path = "/v1/desktop/screenshot",
    tag = "v1",
    params(DesktopScreenshotQuery),
    responses(
        (status = 200, description = "Desktop screenshot as image bytes"),
        (status = 400, description = "Invalid screenshot query", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or screenshot capture failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_screenshot(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopScreenshotQuery>,
) -> Result<Response, ApiError> {
    let screenshot = state.desktop_runtime().screenshot(query).await?;
    Ok((
        [(header::CONTENT_TYPE, screenshot.content_type)],
        Bytes::from(screenshot.bytes),
    )
        .into_response())
}

/// Capture a desktop screenshot region.
///
/// Performs a health-gated screenshot crop against the managed desktop and
/// returns the requested region image bytes.
#[utoipa::path(
    get,
    path = "/v1/desktop/screenshot/region",
    tag = "v1",
    params(DesktopRegionScreenshotQuery),
    responses(
        (status = 200, description = "Desktop screenshot region as image bytes"),
        (status = 400, description = "Invalid screenshot region", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or screenshot capture failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_screenshot_region(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopRegionScreenshotQuery>,
) -> Result<Response, ApiError> {
    let screenshot = state.desktop_runtime().screenshot_region(query).await?;
    Ok((
        [(header::CONTENT_TYPE, screenshot.content_type)],
        Bytes::from(screenshot.bytes),
    )
        .into_response())
}

/// Get the current desktop mouse position.
///
/// Performs a health-gated mouse position query against the managed desktop.
#[utoipa::path(
    get,
    path = "/v1/desktop/mouse/position",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop mouse position", body = DesktopMousePositionResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input check failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_mouse_position(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().mouse_position().await?;
    Ok(Json(position))
}

/// Move the desktop mouse.
///
/// Performs a health-gated absolute pointer move on the managed desktop and
/// returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/move",
    tag = "v1",
    request_body = DesktopMouseMoveRequest,
    responses(
        (status = 200, description = "Desktop mouse position after move", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse move request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_move(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseMoveRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().move_mouse(body).await?;
    Ok(Json(position))
}

/// Click on the desktop.
///
/// Performs a health-gated pointer move and click against the managed desktop
/// and returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/click",
    tag = "v1",
    request_body = DesktopMouseClickRequest,
    responses(
        (status = 200, description = "Desktop mouse position after click", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse click request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_click(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseClickRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().click_mouse(body).await?;
    Ok(Json(position))
}

/// Press and hold a desktop mouse button.
///
/// Performs a health-gated optional pointer move followed by `xdotool mousedown`
/// and returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/down",
    tag = "v1",
    request_body = DesktopMouseDownRequest,
    responses(
        (status = 200, description = "Desktop mouse position after button press", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse down request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_down(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseDownRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().mouse_down(body).await?;
    Ok(Json(position))
}

/// Release a desktop mouse button.
///
/// Performs a health-gated optional pointer move followed by `xdotool mouseup`
/// and returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/up",
    tag = "v1",
    request_body = DesktopMouseUpRequest,
    responses(
        (status = 200, description = "Desktop mouse position after button release", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse up request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_up(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseUpRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().mouse_up(body).await?;
    Ok(Json(position))
}

/// Drag the desktop mouse.
///
/// Performs a health-gated drag gesture against the managed desktop and
/// returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/drag",
    tag = "v1",
    request_body = DesktopMouseDragRequest,
    responses(
        (status = 200, description = "Desktop mouse position after drag", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse drag request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_drag(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseDragRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().drag_mouse(body).await?;
    Ok(Json(position))
}

/// Scroll the desktop mouse wheel.
///
/// Performs a health-gated scroll gesture at the requested coordinates and
/// returns the resulting mouse position.
#[utoipa::path(
    post,
    path = "/v1/desktop/mouse/scroll",
    tag = "v1",
    request_body = DesktopMouseScrollRequest,
    responses(
        (status = 200, description = "Desktop mouse position after scroll", body = DesktopMousePositionResponse),
        (status = 400, description = "Invalid mouse scroll request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_mouse_scroll(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopMouseScrollRequest>,
) -> Result<Json<DesktopMousePositionResponse>, ApiError> {
    let position = state.desktop_runtime().scroll_mouse(body).await?;
    Ok(Json(position))
}

/// Type desktop keyboard text.
///
/// Performs a health-gated `xdotool type` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/type",
    tag = "v1",
    request_body = DesktopKeyboardTypeRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard type request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_type(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardTypeRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().type_text(body).await?;
    Ok(Json(response))
}

/// Press a desktop keyboard shortcut.
///
/// Performs a health-gated `xdotool key` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/press",
    tag = "v1",
    request_body = DesktopKeyboardPressRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard press request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_press(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardPressRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().press_key(body).await?;
    Ok(Json(response))
}

/// Press and hold a desktop keyboard key.
///
/// Performs a health-gated `xdotool keydown` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/down",
    tag = "v1",
    request_body = DesktopKeyboardDownRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard down request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_down(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardDownRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().key_down(body).await?;
    Ok(Json(response))
}

/// Release a desktop keyboard key.
///
/// Performs a health-gated `xdotool keyup` operation against the managed
/// desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/keyboard/up",
    tag = "v1",
    request_body = DesktopKeyboardUpRequest,
    responses(
        (status = 200, description = "Desktop keyboard action result", body = DesktopActionResponse),
        (status = 400, description = "Invalid keyboard up request", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop runtime health or input failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_keyboard_up(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopKeyboardUpRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let response = state.desktop_runtime().key_up(body).await?;
    Ok(Json(response))
}

/// Get desktop display information.
///
/// Performs a health-gated display query against the managed desktop and
/// returns the current display identifier and resolution.
#[utoipa::path(
    get,
    path = "/v1/desktop/display/info",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop display information", body = DesktopDisplayInfoResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 503, description = "Desktop runtime health or display query failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_display_info(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopDisplayInfoResponse>, ApiError> {
    let info = state.desktop_runtime().display_info().await?;
    Ok(Json(info))
}

/// List visible desktop windows.
///
/// Performs a health-gated visible-window enumeration against the managed
/// desktop and returns the current window metadata.
#[utoipa::path(
    get,
    path = "/v1/desktop/windows",
    tag = "v1",
    responses(
        (status = 200, description = "Visible desktop windows", body = DesktopWindowListResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 503, description = "Desktop runtime health or window query failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_windows(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopWindowListResponse>, ApiError> {
    let windows = state.desktop_runtime().list_windows().await?;
    Ok(Json(windows))
}

/// Get the currently focused desktop window.
///
/// Returns information about the window that currently has input focus.
#[utoipa::path(
    get,
    path = "/v1/desktop/windows/focused",
    tag = "v1",
    responses(
        (status = 200, description = "Focused window info", body = DesktopWindowInfo),
        (status = 404, description = "No window is focused", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_windows_focused(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().focused_window().await?;
    Ok(Json(window))
}

/// Focus a desktop window.
///
/// Brings the specified window to the foreground and gives it input focus.
#[utoipa::path(
    post,
    path = "/v1/desktop/windows/{id}/focus",
    tag = "v1",
    params(
        ("id" = String, Path, description = "X11 window ID")
    ),
    responses(
        (status = 200, description = "Window info after focus", body = DesktopWindowInfo),
        (status = 404, description = "Window not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_window_focus(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().focus_window(&id).await?;
    Ok(Json(window))
}

/// Move a desktop window.
///
/// Moves the specified window to the given position.
#[utoipa::path(
    post,
    path = "/v1/desktop/windows/{id}/move",
    tag = "v1",
    params(
        ("id" = String, Path, description = "X11 window ID")
    ),
    request_body = DesktopWindowMoveRequest,
    responses(
        (status = 200, description = "Window info after move", body = DesktopWindowInfo),
        (status = 404, description = "Window not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_window_move(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DesktopWindowMoveRequest>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().move_window(&id, body).await?;
    Ok(Json(window))
}

/// Resize a desktop window.
///
/// Resizes the specified window to the given dimensions.
#[utoipa::path(
    post,
    path = "/v1/desktop/windows/{id}/resize",
    tag = "v1",
    params(
        ("id" = String, Path, description = "X11 window ID")
    ),
    request_body = DesktopWindowResizeRequest,
    responses(
        (status = 200, description = "Window info after resize", body = DesktopWindowInfo),
        (status = 404, description = "Window not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_window_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DesktopWindowResizeRequest>,
) -> Result<Json<DesktopWindowInfo>, ApiError> {
    let window = state.desktop_runtime().resize_window(&id, body).await?;
    Ok(Json(window))
}

/// Read the desktop clipboard.
///
/// Returns the current text content of the X11 clipboard.
#[utoipa::path(
    get,
    path = "/v1/desktop/clipboard",
    tag = "v1",
    params(DesktopClipboardQuery),
    responses(
        (status = 200, description = "Clipboard contents", body = DesktopClipboardResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 500, description = "Clipboard read failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_clipboard(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DesktopClipboardQuery>,
) -> Result<Json<DesktopClipboardResponse>, ApiError> {
    let clipboard = state
        .desktop_runtime()
        .get_clipboard(query.selection)
        .await?;
    Ok(Json(clipboard))
}

/// Write to the desktop clipboard.
///
/// Sets the text content of the X11 clipboard.
#[utoipa::path(
    post,
    path = "/v1/desktop/clipboard",
    tag = "v1",
    request_body = DesktopClipboardWriteRequest,
    responses(
        (status = 200, description = "Clipboard updated", body = DesktopActionResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails),
        (status = 500, description = "Clipboard write failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_clipboard(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopClipboardWriteRequest>,
) -> Result<Json<DesktopActionResponse>, ApiError> {
    let result = state.desktop_runtime().set_clipboard(body).await?;
    Ok(Json(result))
}

/// Launch a desktop application.
///
/// Launches an application by name on the managed desktop, optionally waiting
/// for its window to appear.
#[utoipa::path(
    post,
    path = "/v1/desktop/launch",
    tag = "v1",
    request_body = DesktopLaunchRequest,
    responses(
        (status = 200, description = "Application launched", body = DesktopLaunchResponse),
        (status = 404, description = "Application not found", body = ProblemDetails),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_launch(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopLaunchRequest>,
) -> Result<Json<DesktopLaunchResponse>, ApiError> {
    let result = state.desktop_runtime().launch_app(body).await?;
    Ok(Json(result))
}

/// Open a file or URL with the default handler.
///
/// Opens a file path or URL using xdg-open on the managed desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/open",
    tag = "v1",
    request_body = DesktopOpenRequest,
    responses(
        (status = 200, description = "Target opened", body = DesktopOpenResponse),
        (status = 409, description = "Desktop runtime is not ready", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_open(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopOpenRequest>,
) -> Result<Json<DesktopOpenResponse>, ApiError> {
    let result = state.desktop_runtime().open_target(body).await?;
    Ok(Json(result))
}

/// Start desktop recording.
///
/// Starts an ffmpeg x11grab recording against the managed desktop and returns
/// the created recording metadata.
#[utoipa::path(
    post,
    path = "/v1/desktop/recording/start",
    tag = "v1",
    request_body = DesktopRecordingStartRequest,
    responses(
        (status = 200, description = "Desktop recording started", body = DesktopRecordingInfo),
        (status = 409, description = "Desktop runtime is not ready or a recording is already active", body = ProblemDetails),
        (status = 502, description = "Desktop recording failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_recording_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DesktopRecordingStartRequest>,
) -> Result<Json<DesktopRecordingInfo>, ApiError> {
    let recording = state.desktop_runtime().start_recording(body).await?;
    Ok(Json(recording))
}

/// Stop desktop recording.
///
/// Stops the active desktop recording and returns the finalized recording
/// metadata.
#[utoipa::path(
    post,
    path = "/v1/desktop/recording/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop recording stopped", body = DesktopRecordingInfo),
        (status = 409, description = "No active desktop recording", body = ProblemDetails),
        (status = 502, description = "Desktop recording stop failed", body = ProblemDetails)
    )
)]
async fn post_v1_desktop_recording_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopRecordingInfo>, ApiError> {
    let recording = state.desktop_runtime().stop_recording().await?;
    Ok(Json(recording))
}

/// List desktop recordings.
///
/// Returns the current desktop recording catalog.
#[utoipa::path(
    get,
    path = "/v1/desktop/recordings",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop recordings", body = DesktopRecordingListResponse),
        (status = 502, description = "Desktop recordings query failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_recordings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopRecordingListResponse>, ApiError> {
    let recordings = state.desktop_runtime().list_recordings().await?;
    Ok(Json(recordings))
}

/// Get desktop recording metadata.
///
/// Returns metadata for a single desktop recording.
#[utoipa::path(
    get,
    path = "/v1/desktop/recordings/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Desktop recording ID")
    ),
    responses(
        (status = 200, description = "Desktop recording metadata", body = DesktopRecordingInfo),
        (status = 404, description = "Unknown desktop recording", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<DesktopRecordingInfo>, ApiError> {
    let recording = state.desktop_runtime().get_recording(&id).await?;
    Ok(Json(recording))
}

/// Download a desktop recording.
///
/// Serves the recorded MP4 bytes for a completed desktop recording.
#[utoipa::path(
    get,
    path = "/v1/desktop/recordings/{id}/download",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Desktop recording ID")
    ),
    responses(
        (status = 200, description = "Desktop recording as MP4 bytes"),
        (status = 404, description = "Unknown desktop recording", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_recording_download(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let path = state.desktop_runtime().recording_download_path(&id).await?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| SandboxError::StreamError {
            message: format!("failed to read desktop recording {}: {err}", path.display()),
        })?;
    Ok(([(header::CONTENT_TYPE, "video/mp4")], Bytes::from(bytes)).into_response())
}

/// Delete a desktop recording.
///
/// Removes a completed desktop recording and its file from disk.
#[utoipa::path(
    delete,
    path = "/v1/desktop/recordings/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Desktop recording ID")
    ),
    responses(
        (status = 204, description = "Desktop recording deleted"),
        (status = 404, description = "Unknown desktop recording", body = ProblemDetails),
        (status = 409, description = "Desktop recording is still active", body = ProblemDetails)
    )
)]
async fn delete_v1_desktop_recording(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.desktop_runtime().delete_recording(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Start desktop streaming.
///
/// Enables desktop websocket streaming for the managed desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/stream/start",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop streaming started", body = DesktopStreamStatusResponse)
    )
)]
async fn post_v1_desktop_stream_start(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStreamStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().start_streaming().await?))
}

/// Stop desktop streaming.
///
/// Disables desktop websocket streaming for the managed desktop.
#[utoipa::path(
    post,
    path = "/v1/desktop/stream/stop",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop streaming stopped", body = DesktopStreamStatusResponse)
    )
)]
async fn post_v1_desktop_stream_stop(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStreamStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().stop_streaming().await))
}

/// Get desktop stream status.
///
/// Returns the current state of the desktop WebRTC streaming session.
#[utoipa::path(
    get,
    path = "/v1/desktop/stream/status",
    tag = "v1",
    responses(
        (status = 200, description = "Desktop stream status", body = DesktopStreamStatusResponse)
    )
)]
async fn get_v1_desktop_stream_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DesktopStreamStatusResponse>, ApiError> {
    Ok(Json(state.desktop_runtime().stream_status().await))
}

/// Open a desktop WebRTC signaling session.
///
/// Upgrades the connection to a WebSocket used for WebRTC signaling between
/// the browser client and the desktop streaming process. Also accepts mouse
/// and keyboard input frames as a fallback transport.
#[utoipa::path(
    get,
    path = "/v1/desktop/stream/signaling",
    tag = "v1",
    params(
        ("access_token" = Option<String>, Query, description = "Bearer token alternative for WS auth")
    ),
    responses(
        (status = 101, description = "WebSocket upgraded"),
        (status = 409, description = "Desktop runtime or streaming session is not ready", body = ProblemDetails),
        (status = 502, description = "Desktop stream failed", body = ProblemDetails)
    )
)]
async fn get_v1_desktop_stream_ws(
    State(state): State<Arc<AppState>>,
    Query(_query): Query<ProcessWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    state.desktop_runtime().ensure_streaming_active().await?;
    Ok(ws
        .on_upgrade(move |socket| desktop_stream_ws_session(socket, state.desktop_runtime()))
        .into_response())
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

/// Get process runtime configuration.
///
/// Returns the current runtime configuration for the process management API,
/// including limits for concurrency, timeouts, and buffer sizes.
#[utoipa::path(
    get,
    path = "/v1/processes/config",
    tag = "v1",
    responses(
        (status = 200, description = "Current runtime process config", body = ProcessConfig),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_processes_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ProcessConfig>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let config = state.process_runtime().get_config().await;
    Ok(Json(map_process_config(config)))
}

/// Update process runtime configuration.
///
/// Replaces the runtime configuration for the process management API.
/// Validates that all values are non-zero and clamps default timeout to max.
#[utoipa::path(
    post,
    path = "/v1/processes/config",
    tag = "v1",
    request_body = ProcessConfig,
    responses(
        (status = 200, description = "Updated runtime process config", body = ProcessConfig),
        (status = 400, description = "Invalid config", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_processes_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProcessConfig>,
) -> Result<Json<ProcessConfig>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let updated = runtime
        .set_config(into_runtime_process_config(body))
        .await?;
    Ok(Json(map_process_config(updated)))
}

/// Create a long-lived managed process.
///
/// Spawns a new process with the given command and arguments. Supports both
/// pipe-based and PTY (tty) modes. Returns the process descriptor on success.
#[utoipa::path(
    post,
    path = "/v1/processes",
    tag = "v1",
    request_body = ProcessCreateRequest,
    responses(
        (status = 200, description = "Started process", body = ProcessInfo),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 409, description = "Process limit or state conflict", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_processes(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProcessCreateRequest>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let snapshot = runtime
        .start_process(ProcessStartSpec {
            command: body.command,
            args: body.args,
            cwd: body.cwd,
            env: body.env.into_iter().collect(),
            tty: body.tty,
            interactive: body.interactive,
            owner: RuntimeProcessOwner::User,
            restart_policy: None,
        })
        .await?;

    Ok(Json(map_process_snapshot(snapshot)))
}

/// Run a one-shot command.
///
/// Executes a command to completion and returns its stdout, stderr, exit code,
/// and duration. Supports configurable timeout and output size limits.
#[utoipa::path(
    post,
    path = "/v1/processes/run",
    tag = "v1",
    request_body = ProcessRunRequest,
    responses(
        (status = 200, description = "One-off command result", body = ProcessRunResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_processes_run(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ProcessRunRequest>,
) -> Result<Json<ProcessRunResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let output = runtime
        .run_once(RunSpec {
            command: body.command,
            args: body.args,
            cwd: body.cwd,
            env: body.env.into_iter().collect(),
            timeout_ms: body.timeout_ms,
            max_output_bytes: body.max_output_bytes,
        })
        .await?;

    Ok(Json(ProcessRunResponse {
        exit_code: output.exit_code,
        timed_out: output.timed_out,
        stdout: output.stdout,
        stderr: output.stderr,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
        duration_ms: output.duration_ms,
    }))
}

/// List all managed processes.
///
/// Returns a list of all processes (running and exited) currently tracked
/// by the runtime, sorted by process ID.
#[utoipa::path(
    get,
    path = "/v1/processes",
    tag = "v1",
    params(ProcessListQuery),
    responses(
        (status = 200, description = "List processes", body = ProcessListResponse),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_processes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProcessListQuery>,
) -> Result<Json<ProcessListResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshots = state
        .process_runtime()
        .list_processes(query.owner.map(into_runtime_process_owner))
        .await;
    Ok(Json(ProcessListResponse {
        processes: snapshots.into_iter().map(map_process_snapshot).collect(),
    }))
}

/// Get a single process by ID.
///
/// Returns the current state of a managed process including its status,
/// PID, exit code, and creation/exit timestamps.
#[utoipa::path(
    get,
    path = "/v1/processes/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    responses(
        (status = 200, description = "Process details", body = ProcessInfo),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_process(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshot = state.process_runtime().snapshot(&id).await?;
    Ok(Json(map_process_snapshot(snapshot)))
}

/// Send SIGTERM to a process.
///
/// Sends SIGTERM to the process and optionally waits up to `waitMs`
/// milliseconds for the process to exit before returning.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/stop",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("waitMs" = Option<u64>, Query, description = "Wait up to N ms for process to exit")
    ),
    responses(
        (status = 200, description = "Stop signal sent", body = ProcessInfo),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_stop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ProcessSignalQuery>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshot = state
        .process_runtime()
        .stop_process(&id, query.wait_ms)
        .await?;
    Ok(Json(map_process_snapshot(snapshot)))
}

/// Send SIGKILL to a process.
///
/// Sends SIGKILL to the process and optionally waits up to `waitMs`
/// milliseconds for the process to exit before returning.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/kill",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("waitMs" = Option<u64>, Query, description = "Wait up to N ms for process to exit")
    ),
    responses(
        (status = 200, description = "Kill signal sent", body = ProcessInfo),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_kill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ProcessSignalQuery>,
) -> Result<Json<ProcessInfo>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let snapshot = state
        .process_runtime()
        .kill_process(&id, query.wait_ms)
        .await?;
    Ok(Json(map_process_snapshot(snapshot)))
}

/// Delete a process record.
///
/// Removes a stopped process from the runtime. Returns 409 if the process
/// is still running; stop or kill it first.
#[utoipa::path(
    delete,
    path = "/v1/processes/{id}",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    responses(
        (status = 204, description = "Process deleted"),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 409, description = "Process is still running", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn delete_v1_process(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    state.process_runtime().delete_process(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Fetch process logs.
///
/// Returns buffered log entries for a process. Supports filtering by stream
/// type, tail count, and sequence-based resumption. When `follow=true`,
/// returns an SSE stream that replays buffered entries then streams live output.
#[utoipa::path(
    get,
    path = "/v1/processes/{id}/logs",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("stream" = Option<ProcessLogsStream>, Query, description = "stdout|stderr|combined|pty"),
        ("tail" = Option<usize>, Query, description = "Tail N entries"),
        ("follow" = Option<bool>, Query, description = "Follow via SSE"),
        ("since" = Option<u64>, Query, description = "Only entries with sequence greater than this")
    ),
    responses(
        (status = 200, description = "Process logs", body = ProcessLogsResponse),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_process_logs(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ProcessLogsQuery>,
) -> Result<Response, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    let default_stream = if runtime.is_tty(&id).await? {
        ProcessLogsStream::Pty
    } else {
        ProcessLogsStream::Combined
    };
    let requested_stream = query.stream.unwrap_or(default_stream);
    let since = match (query.since, parse_last_event_id(&headers)?) {
        (Some(query_since), Some(last_event_id)) => Some(query_since.max(last_event_id)),
        (Some(query_since), None) => Some(query_since),
        (None, Some(last_event_id)) => Some(last_event_id),
        (None, None) => None,
    };
    let filter = ProcessLogFilter {
        stream: into_runtime_log_stream(requested_stream),
        tail: query.tail,
        since,
    };

    let entries = runtime.logs(&id, filter).await?;
    let response_entries: Vec<ProcessLogEntry> =
        entries.iter().cloned().map(map_process_log_line).collect();

    if query.follow.unwrap_or(false) {
        let rx = runtime.subscribe_logs(&id).await?;
        let replay_stream = stream::iter(response_entries.into_iter().map(|entry| {
            Ok::<axum::response::sse::Event, Infallible>(
                axum::response::sse::Event::default()
                    .event("log")
                    .id(entry.sequence.to_string())
                    .data(serde_json::to_string(&entry).unwrap_or_else(|_| "{}".to_string())),
            )
        }));

        let requested_stream_copy = requested_stream;
        let follow_stream = BroadcastStream::new(rx).filter_map(move |item| {
            let requested_stream_copy = requested_stream_copy;
            async move {
                match item {
                    Ok(line) => {
                        let entry = map_process_log_line(line);
                        if process_log_matches(&entry, requested_stream_copy) {
                            Some(Ok(axum::response::sse::Event::default()
                                .event("log")
                                .id(entry.sequence.to_string())
                                .data(
                                    serde_json::to_string(&entry)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                )))
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                }
            }
        });

        let stream = replay_stream.chain(follow_stream);
        let response =
            Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)));
        return Ok(response.into_response());
    }

    Ok(Json(ProcessLogsResponse {
        process_id: id,
        stream: requested_stream,
        entries: response_entries,
    })
    .into_response())
}

/// Write input to a process.
///
/// Sends data to a process's stdin (pipe mode) or PTY writer (tty mode).
/// Data can be encoded as base64, utf8, or text. Returns 413 if the decoded
/// payload exceeds the configured `maxInputBytesPerRequest` limit.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/input",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    request_body = ProcessInputRequest,
    responses(
        (status = 200, description = "Input accepted", body = ProcessInputResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 413, description = "Input exceeds configured limit", body = ProblemDetails),
        (status = 409, description = "Process not writable", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_input(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ProcessInputRequest>,
) -> Result<Json<ProcessInputResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let encoding = body.encoding.unwrap_or_else(|| "base64".to_string());
    let input = decode_input_bytes(&body.data, &encoding)?;
    let runtime = state.process_runtime();
    let max_input = runtime.max_input_bytes().await;
    if input.len() > max_input {
        return Err(SandboxError::InvalidRequest {
            message: format!("input payload exceeds maxInputBytesPerRequest ({max_input})"),
        }
        .into());
    }

    let bytes_written = runtime.write_input(&id, &input).await?;
    Ok(Json(ProcessInputResponse { bytes_written }))
}

/// Resize a process terminal.
///
/// Sets the PTY window size (columns and rows) for a tty-mode process and
/// sends SIGWINCH so the child process can adapt.
#[utoipa::path(
    post,
    path = "/v1/processes/{id}/terminal/resize",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID")
    ),
    request_body = ProcessTerminalResizeRequest,
    responses(
        (status = 200, description = "Resize accepted", body = ProcessTerminalResizeResponse),
        (status = 400, description = "Invalid request", body = ProblemDetails),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 409, description = "Not a terminal process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn post_v1_process_terminal_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ProcessTerminalResizeRequest>,
) -> Result<Json<ProcessTerminalResizeResponse>, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    state
        .process_runtime()
        .resize_terminal(&id, body.cols, body.rows)
        .await?;
    Ok(Json(ProcessTerminalResizeResponse {
        cols: body.cols,
        rows: body.rows,
    }))
}

/// Open an interactive WebSocket terminal session.
///
/// Upgrades the connection to a WebSocket for bidirectional PTY I/O. Accepts
/// `access_token` query param for browser-based auth (WebSocket API cannot
/// send custom headers). Streams raw PTY output as binary frames and accepts
/// JSON control frames for input, resize, and close.
#[utoipa::path(
    get,
    path = "/v1/processes/{id}/terminal/ws",
    tag = "v1",
    params(
        ("id" = String, Path, description = "Process ID"),
        ("access_token" = Option<String>, Query, description = "Bearer token alternative for WS auth")
    ),
    responses(
        (status = 101, description = "WebSocket upgraded"),
        (status = 400, description = "Invalid websocket frame or upgrade request", body = ProblemDetails),
        (status = 404, description = "Unknown process", body = ProblemDetails),
        (status = 409, description = "Not a terminal process", body = ProblemDetails),
        (status = 501, description = "Process API unsupported on this platform", body = ProblemDetails)
    )
)]
async fn get_v1_process_terminal_ws(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(_query): Query<ProcessWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !process_api_supported() {
        return Err(process_api_not_supported().into());
    }

    let runtime = state.process_runtime();
    if !runtime.is_tty(&id).await? {
        return Err(SandboxError::Conflict {
            message: "process is not running in tty mode".to_string(),
        }
        .into());
    }

    Ok(ws
        .on_upgrade(move |socket| process_terminal_ws_session(socket, runtime, id))
        .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalClientFrame {
    Input {
        data: String,
        #[serde(default)]
        encoding: Option<String>,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Close,
}

async fn process_terminal_ws_session(
    mut socket: WebSocket,
    runtime: Arc<ProcessRuntime>,
    id: String,
) {
    let _ = send_ws_json(
        &mut socket,
        json!({
            "type": "ready",
            "processId": &id,
        }),
    )
    .await;

    let mut log_rx = match runtime.subscribe_logs(&id).await {
        Ok(rx) => rx,
        Err(err) => {
            let _ = send_ws_error(&mut socket, &err.to_string()).await;
            let _ = socket.close().await;
            return;
        }
    };
    let mut exit_poll = tokio::time::interval(Duration::from_millis(150));

    loop {
        tokio::select! {
            ws_in = socket.recv() => {
                match ws_in {
                    Some(Ok(Message::Binary(_))) => {
                        let _ = send_ws_error(&mut socket, "binary input is not supported; use text JSON frames").await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let parsed = serde_json::from_str::<TerminalClientFrame>(&text);
                        match parsed {
                            Ok(TerminalClientFrame::Input { data, encoding }) => {
                                let input = match decode_input_bytes(&data, encoding.as_deref().unwrap_or("utf8")) {
                                    Ok(input) => input,
                                    Err(err) => {
                                        let _ = send_ws_error(&mut socket, &err.to_string()).await;
                                        continue;
                                    }
                                };
                                let max_input = runtime.max_input_bytes().await;
                                if input.len() > max_input {
                                    let _ = send_ws_error(&mut socket, &format!("input payload exceeds maxInputBytesPerRequest ({max_input})")).await;
                                    continue;
                                }
                                if let Err(err) = runtime.write_input(&id, &input).await {
                                    let _ = send_ws_error(&mut socket, &err.to_string()).await;
                                }
                            }
                            Ok(TerminalClientFrame::Resize { cols, rows }) => {
                                if let Err(err) = runtime.resize_terminal(&id, cols, rows).await {
                                    let _ = send_ws_error(&mut socket, &err.to_string()).await;
                                }
                            }
                            Ok(TerminalClientFrame::Close) => {
                                let _ = socket.close().await;
                                break;
                            }
                            Err(err) => {
                                let _ = send_ws_error(&mut socket, &format!("invalid terminal frame: {err}")).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            log_in = log_rx.recv() => {
                match log_in {
                    Ok(line) => {
                        if line.stream != ProcessStream::Pty {
                            continue;
                        }
                        let bytes = {
                            use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
                            use base64::Engine;
                            BASE64_ENGINE.decode(&line.data).unwrap_or_default()
                        };
                        if socket.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = exit_poll.tick() => {
                if let Ok(snapshot) = runtime.snapshot(&id).await {
                    if snapshot.status == ProcessStatus::Exited {
                        let _ = send_ws_json(
                            &mut socket,
                            json!({
                                "type": "exit",
                                "exitCode": snapshot.exit_code,
                            }),
                        )
                        .await;
                        let _ = socket.close().await;
                        break;
                    }
                }
            }
        }
    }
}

/// WebRTC signaling proxy session.
///
/// Proxies the WebSocket bidirectionally between the browser client and neko's
/// internal WebSocket endpoint. All neko signaling messages (SDP offers/answers,
/// ICE candidates, system events) are relayed transparently.
async fn desktop_stream_ws_session(mut client_ws: WebSocket, desktop_runtime: Arc<DesktopRuntime>) {
    use futures::SinkExt;
    use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

    // Get neko's internal WS URL from the streaming manager.
    let neko_ws_url = match desktop_runtime.streaming_manager().neko_ws_url().await {
        Some(url) => url,
        None => {
            let _ = send_ws_error(&mut client_ws, "streaming process is not available").await;
            let _ = client_ws.close().await;
            return;
        }
    };

    // Create a fresh neko login session for this connection.
    // Each proxy connection gets its own neko session to avoid conflicts
    // when multiple clients connect (neko sends signal/close to shared sessions).
    let session_cookie = desktop_runtime
        .streaming_manager()
        .create_neko_session()
        .await;

    // Build a WS request with the neko session cookie for authentication.
    let ws_req = {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut req = neko_ws_url
            .into_client_request()
            .expect("valid neko WS URL");
        if let Some(ref cookie) = session_cookie {
            req.headers_mut()
                .insert("Cookie", cookie.parse().expect("valid cookie header"));
        }
        req
    };

    // Connect to neko's internal WebSocket.
    let (neko_ws, _) = match tokio_tungstenite::connect_async(ws_req).await {
        Ok(conn) => conn,
        Err(err) => {
            let _ = send_ws_error(
                &mut client_ws,
                &format!("failed to connect to streaming process: {err}"),
            )
            .await;
            let _ = client_ws.close().await;
            return;
        }
    };

    let (mut neko_sink, mut neko_stream) = neko_ws.split();

    // Relay messages bidirectionally between client and neko.
    loop {
        tokio::select! {
            // Client → Neko (signaling passthrough; input goes via WebRTC data channel)
            client_msg = client_ws.recv() => {
                match client_msg {
                    Some(Ok(Message::Text(text))) => {
                        if neko_sink.send(TungsteniteMessage::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if neko_sink.send(TungsteniteMessage::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = client_ws.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Err(_)) => break,
                }
            }
            // Neko → Client
            neko_msg = neko_stream.next() => {
                match neko_msg {
                    Some(Ok(TungsteniteMessage::Text(text))) => {
                        if client_ws.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Binary(data))) => {
                        if client_ws.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Ping(payload))) => {
                        if neko_sink.send(TungsteniteMessage::Pong(payload.clone())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(TungsteniteMessage::Close(_))) | None => break,
                    Some(Ok(TungsteniteMessage::Pong(_))) => {}
                    Some(Ok(TungsteniteMessage::Frame(_))) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    let _ = neko_sink.close().await;
    let _ = client_ws.close().await;
}

async fn send_ws_json(socket: &mut WebSocket, payload: Value) -> Result<(), ()> {
    socket
        .send(Message::Text(
            serde_json::to_string(&payload).map_err(|_| ())?,
        ))
        .await
        .map_err(|_| ())
}

async fn send_ws_error(socket: &mut WebSocket, message: &str) -> Result<(), ()> {
    send_ws_json(
        socket,
        json!({
            "type": "error",
            "message": message,
        }),
    )
    .await
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

fn process_api_supported() -> bool {
    !cfg!(windows)
}

fn process_api_not_supported() -> ProblemDetails {
    ProblemDetails {
        type_: ErrorType::InvalidRequest.as_urn().to_string(),
        title: "Not Implemented".to_string(),
        status: 501,
        detail: Some("process API is not implemented on Windows".to_string()),
        instance: None,
        extensions: serde_json::Map::new(),
    }
}

fn map_process_config(config: ProcessRuntimeConfig) -> ProcessConfig {
    ProcessConfig {
        max_concurrent_processes: config.max_concurrent_processes,
        default_run_timeout_ms: config.default_run_timeout_ms,
        max_run_timeout_ms: config.max_run_timeout_ms,
        max_output_bytes: config.max_output_bytes,
        max_log_bytes_per_process: config.max_log_bytes_per_process,
        max_input_bytes_per_request: config.max_input_bytes_per_request,
    }
}

fn into_runtime_process_config(config: ProcessConfig) -> ProcessRuntimeConfig {
    ProcessRuntimeConfig {
        max_concurrent_processes: config.max_concurrent_processes,
        default_run_timeout_ms: config.default_run_timeout_ms,
        max_run_timeout_ms: config.max_run_timeout_ms,
        max_output_bytes: config.max_output_bytes,
        max_log_bytes_per_process: config.max_log_bytes_per_process,
        max_input_bytes_per_request: config.max_input_bytes_per_request,
    }
}

fn into_runtime_process_owner(owner: ProcessOwner) -> RuntimeProcessOwner {
    match owner {
        ProcessOwner::User => RuntimeProcessOwner::User,
        ProcessOwner::Desktop => RuntimeProcessOwner::Desktop,
        ProcessOwner::System => RuntimeProcessOwner::System,
    }
}

fn map_process_snapshot(snapshot: ProcessSnapshot) -> ProcessInfo {
    ProcessInfo {
        id: snapshot.id,
        command: snapshot.command,
        args: snapshot.args,
        cwd: snapshot.cwd,
        tty: snapshot.tty,
        interactive: snapshot.interactive,
        owner: match snapshot.owner {
            RuntimeProcessOwner::User => ProcessOwner::User,
            RuntimeProcessOwner::Desktop => ProcessOwner::Desktop,
            RuntimeProcessOwner::System => ProcessOwner::System,
        },
        status: match snapshot.status {
            ProcessStatus::Running => ProcessState::Running,
            ProcessStatus::Exited => ProcessState::Exited,
        },
        pid: snapshot.pid,
        exit_code: snapshot.exit_code,
        created_at_ms: snapshot.created_at_ms,
        exited_at_ms: snapshot.exited_at_ms,
    }
}

fn into_runtime_log_stream(stream: ProcessLogsStream) -> ProcessLogFilterStream {
    match stream {
        ProcessLogsStream::Stdout => ProcessLogFilterStream::Stdout,
        ProcessLogsStream::Stderr => ProcessLogFilterStream::Stderr,
        ProcessLogsStream::Combined => ProcessLogFilterStream::Combined,
        ProcessLogsStream::Pty => ProcessLogFilterStream::Pty,
    }
}

fn map_process_log_line(line: crate::process_runtime::ProcessLogLine) -> ProcessLogEntry {
    ProcessLogEntry {
        sequence: line.sequence,
        stream: match line.stream {
            ProcessStream::Stdout => ProcessLogsStream::Stdout,
            ProcessStream::Stderr => ProcessLogsStream::Stderr,
            ProcessStream::Pty => ProcessLogsStream::Pty,
        },
        timestamp_ms: line.timestamp_ms,
        data: line.data,
        encoding: line.encoding.to_string(),
    }
}

fn process_log_matches(entry: &ProcessLogEntry, stream: ProcessLogsStream) -> bool {
    match stream {
        ProcessLogsStream::Stdout => entry.stream == ProcessLogsStream::Stdout,
        ProcessLogsStream::Stderr => entry.stream == ProcessLogsStream::Stderr,
        ProcessLogsStream::Combined => {
            entry.stream == ProcessLogsStream::Stdout || entry.stream == ProcessLogsStream::Stderr
        }
        ProcessLogsStream::Pty => entry.stream == ProcessLogsStream::Pty,
    }
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
