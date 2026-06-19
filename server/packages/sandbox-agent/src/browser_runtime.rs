use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::browser_cdp::CdpClient;
use crate::browser_errors::BrowserProblem;
use crate::browser_install::{
    browser_platform_support_message, detect_missing_browser_dependencies,
};
use crate::browser_types::{
    BrowserConsoleMessage, BrowserNetworkRequest, BrowserStartRequest, BrowserState,
    BrowserStatusResponse,
};
use crate::desktop_install::find_binary;
use crate::desktop_runtime::DesktopRuntime;
use crate::desktop_streaming::DesktopStreamingManager;
use crate::desktop_types::{DesktopErrorInfo, DesktopProcessInfo, DesktopResolution};
use crate::process_runtime::{
    ProcessOwner, ProcessRuntime, ProcessStartSpec, ProcessStatus, RestartPolicy,
};

const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 720;
const DEFAULT_DPI: u32 = 96;
const DEFAULT_DISPLAY_NUM: i32 = 98;
const MAX_DISPLAY_PROBE: i32 = 10;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const CDP_POLL_TIMEOUT: Duration = Duration::from_secs(15);
const CDP_PORT: u16 = 9222;
const MAX_CONSOLE_MESSAGES: usize = 1000;
const MAX_NETWORK_REQUESTS: usize = 1000;

#[derive(Debug, Clone)]
pub struct BrowserRuntime {
    config: BrowserRuntimeConfig,
    process_runtime: Arc<ProcessRuntime>,
    desktop_runtime: Arc<DesktopRuntime>,
    streaming_manager: DesktopStreamingManager,
    inner: Arc<Mutex<BrowserRuntimeStateData>>,
}

#[derive(Debug, Clone)]
pub struct BrowserRuntimeConfig {
    state_dir: PathBuf,
    display_num: i32,
    assume_linux_for_tests: bool,
}

impl Default for BrowserRuntimeConfig {
    fn default() -> Self {
        Self {
            state_dir: default_state_dir(),
            display_num: DEFAULT_DISPLAY_NUM,
            assume_linux_for_tests: false,
        }
    }
}

struct BrowserRuntimeStateData {
    state: BrowserState,
    display_num: i32,
    display: Option<String>,
    resolution: Option<DesktopResolution>,
    started_at: Option<String>,
    last_error: Option<DesktopErrorInfo>,
    missing_dependencies: Vec<String>,
    install_command: Option<String>,
    runtime_log_path: PathBuf,
    environment: HashMap<String, String>,
    xvfb: Option<ManagedBrowserProcess>,
    chromium: Option<ManagedBrowserProcess>,
    cdp_client: Option<Arc<CdpClient>>,
    context_id: Option<String>,
    streaming_config: Option<crate::desktop_streaming::StreamingConfig>,
    recording_fps: Option<u32>,
    console_messages: VecDeque<BrowserConsoleMessage>,
    network_requests: VecDeque<BrowserNetworkRequest>,
    cdp_listener_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for BrowserRuntimeStateData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserRuntimeStateData")
            .field("state", &self.state)
            .field("display", &self.display)
            .field("resolution", &self.resolution)
            .field("started_at", &self.started_at)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct ManagedBrowserProcess {
    name: &'static str,
    process_id: String,
    pid: Option<u32>,
    running: bool,
}

impl BrowserRuntime {
    pub fn new(process_runtime: Arc<ProcessRuntime>, desktop_runtime: Arc<DesktopRuntime>) -> Self {
        Self::with_config(
            process_runtime,
            desktop_runtime,
            BrowserRuntimeConfig::default(),
        )
    }

    pub fn with_config(
        process_runtime: Arc<ProcessRuntime>,
        desktop_runtime: Arc<DesktopRuntime>,
        config: BrowserRuntimeConfig,
    ) -> Self {
        let runtime_log_path = config.state_dir.join("browser-runtime.log");
        Self {
            streaming_manager: DesktopStreamingManager::new(process_runtime.clone()),
            process_runtime,
            desktop_runtime,
            inner: Arc::new(Mutex::new(BrowserRuntimeStateData {
                state: BrowserState::Inactive,
                display_num: config.display_num,
                display: None,
                resolution: None,
                started_at: None,
                last_error: None,
                missing_dependencies: Vec::new(),
                install_command: None,
                runtime_log_path,
                environment: HashMap::new(),
                xvfb: None,
                chromium: None,
                cdp_client: None,
                context_id: None,
                streaming_config: None,
                recording_fps: None,
                console_messages: VecDeque::new(),
                network_requests: VecDeque::new(),
                cdp_listener_tasks: Vec::new(),
            })),
            config,
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    pub async fn status(&self) -> BrowserStatusResponse {
        let mut state = self.inner.lock().await;
        self.refresh_status_locked(&mut state).await;
        let mut response = self.snapshot_locked(&state);
        drop(state);
        self.append_neko_process(&mut response).await;
        response
    }

    pub async fn start(
        &self,
        request: BrowserStartRequest,
    ) -> Result<BrowserStatusResponse, BrowserProblem> {
        // Check mutual exclusivity with desktop runtime
        let desktop_status = self.desktop_runtime.status().await;
        if desktop_status.state == crate::desktop_types::DesktopState::Active {
            return Err(BrowserProblem::desktop_conflict());
        }

        let mut state = self.inner.lock().await;

        if !self.platform_supported() {
            let problem = BrowserProblem::start_failed(browser_platform_support_message());
            self.record_problem_locked(&mut state, &problem);
            state.state = BrowserState::Failed;
            return Err(problem);
        }

        if matches!(state.state, BrowserState::Starting | BrowserState::Stopping) {
            return Err(BrowserProblem::start_failed(
                "Browser runtime is busy transitioning state",
            ));
        }

        self.refresh_status_locked(&mut state).await;
        if state.state == BrowserState::Active {
            let mut response = self.snapshot_locked(&state);
            drop(state);
            self.append_neko_process(&mut response).await;
            return Ok(response);
        }

        if !state.missing_dependencies.is_empty() {
            return Err(BrowserProblem::install_required(format!(
                "Missing browser dependencies: {}. Run: sandbox-agent install browser --yes",
                state.missing_dependencies.join(", ")
            )));
        }

        self.ensure_state_dir()
            .map_err(|err| BrowserProblem::start_failed(err))?;
        self.write_runtime_log_locked(&state, "starting browser runtime");

        let width = request.width.unwrap_or(DEFAULT_WIDTH);
        let height = request.height.unwrap_or(DEFAULT_HEIGHT);
        let dpi = request.dpi.unwrap_or(DEFAULT_DPI);
        if width == 0 || height == 0 {
            return Err(BrowserProblem::start_failed(
                "Browser width and height must be greater than 0",
            ));
        }

        let headless = request.headless.unwrap_or(false);

        // Store streaming/recording config
        state.streaming_config = if request.stream_video_codec.is_some()
            || request.stream_audio_codec.is_some()
            || request.stream_frame_rate.is_some()
            || request.webrtc_port_range.is_some()
        {
            Some(crate::desktop_streaming::StreamingConfig {
                video_codec: request
                    .stream_video_codec
                    .unwrap_or_else(|| "vp8".to_string()),
                audio_codec: request
                    .stream_audio_codec
                    .unwrap_or_else(|| "opus".to_string()),
                frame_rate: request.stream_frame_rate.unwrap_or(30).clamp(1, 60),
                webrtc_port_range: request
                    .webrtc_port_range
                    .unwrap_or_else(|| "59050-59070".to_string()),
            })
        } else {
            None
        };
        state.recording_fps = request.recording_fps.map(|fps| fps.clamp(1, 60));
        state.context_id = request.context_id.clone();

        // Choose display and set up environment
        let display_num = if headless {
            // Headless doesn't need Xvfb but we still pick a display_num for consistency
            self.config.display_num
        } else {
            self.choose_display_num()?
        };
        let display = format!(":{display_num}");
        let resolution = DesktopResolution {
            width,
            height,
            dpi: Some(dpi),
        };
        let environment = self.base_environment(&display)?;

        state.state = BrowserState::Starting;
        state.display_num = display_num;
        state.display = Some(display.clone());
        state.resolution = Some(resolution.clone());
        state.started_at = None;
        state.last_error = None;
        state.environment = environment;
        state.install_command = None;
        state.console_messages.clear();
        state.network_requests.clear();

        // Start Xvfb (unless headless)
        if !headless {
            if let Err(problem) = self.start_xvfb_locked(&mut state, &resolution).await {
                return Err(self.fail_start_locked(&mut state, problem).await);
            }
            if let Err(problem) = self.wait_for_socket(display_num).await {
                return Err(self.fail_start_locked(&mut state, problem).await);
            }
        }

        // Start Chromium
        if let Err(problem) = self
            .start_chromium_locked(&mut state, &resolution, headless, request.url.as_deref())
            .await
        {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }

        // Wait for CDP to become ready
        if let Err(problem) = self.wait_for_cdp().await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }

        // Connect CDP client
        match CdpClient::connect().await {
            Ok(client) => {
                let cdp = Arc::new(client);
                state.cdp_client = Some(cdp.clone());

                // Enable Runtime and Network domains for event monitoring
                let _ = cdp.send("Runtime.enable", None).await;
                let _ = cdp.send("Network.enable", None).await;

                // Subscribe to console events and populate ring buffer
                let console_rx = cdp.subscribe("Runtime.consoleAPICalled").await;
                let inner_clone = self.inner.clone();
                let console_handle = tokio::spawn(async move {
                    let mut rx = console_rx;
                    while let Some(params) = rx.recv().await {
                        let raw_level =
                            params.get("type").and_then(|v| v.as_str()).unwrap_or("log");
                        // CDP uses "warning" as type but we normalize to "warn"
                        let level = if raw_level == "warning" {
                            "warn".to_string()
                        } else {
                            raw_level.to_string()
                        };
                        let args = params
                            .get("args")
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        let text = args
                            .iter()
                            .filter_map(|a| {
                                a.get("value")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| {
                                        a.get("description")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.to_string())
                                    })
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        let stack_trace = params.get("stackTrace");
                        let call_frame = stack_trace
                            .and_then(|st| st.get("callFrames"))
                            .and_then(|cf| cf.as_array())
                            .and_then(|cf| cf.first());
                        let url = call_frame
                            .and_then(|f| f.get("url"))
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                        let line = call_frame
                            .and_then(|f| f.get("lineNumber"))
                            .and_then(|v| v.as_u64())
                            .map(|n| n as u32);
                        let timestamp = params
                            .get("timestamp")
                            .and_then(|v| v.as_f64())
                            .map(|ts| {
                                chrono::DateTime::from_timestamp_millis((ts * 1000.0) as i64)
                                    .map(|dt| dt.to_rfc3339())
                                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
                            })
                            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

                        let msg = BrowserConsoleMessage {
                            level,
                            text,
                            url,
                            line,
                            timestamp,
                        };
                        let mut state = inner_clone.lock().await;
                        if state.console_messages.len() >= MAX_CONSOLE_MESSAGES {
                            state.console_messages.pop_front();
                        }
                        state.console_messages.push_back(msg);
                    }
                });

                // Subscribe to network request events and populate ring buffer
                let request_rx = cdp.subscribe("Network.requestWillBeSent").await;
                let response_rx = cdp.subscribe("Network.responseReceived").await;
                let inner_clone2 = self.inner.clone();
                let request_handle = tokio::spawn(async move {
                    let mut rx = request_rx;
                    while let Some(params) = rx.recv().await {
                        let request_id = params
                            .get("requestId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let request = params.get("request");
                        let url = request
                            .and_then(|r| r.get("url"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let method = request
                            .and_then(|r| r.get("method"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("GET")
                            .to_string();
                        let timestamp = params
                            .get("timestamp")
                            .and_then(|v| v.as_f64())
                            .map(|ts| {
                                chrono::DateTime::from_timestamp_millis((ts * 1000.0) as i64)
                                    .map(|dt| dt.to_rfc3339())
                                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
                            })
                            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

                        let net_req = BrowserNetworkRequest {
                            request_id: Some(request_id),
                            url,
                            method,
                            status: None,
                            mime_type: None,
                            response_size: None,
                            duration: None,
                            timestamp,
                        };
                        let mut state = inner_clone2.lock().await;
                        if state.network_requests.len() >= MAX_NETWORK_REQUESTS {
                            state.network_requests.pop_front();
                        }
                        state.network_requests.push_back(net_req);
                    }
                });

                // Subscribe to network response events to update existing requests
                let inner_clone3 = self.inner.clone();
                let response_handle = tokio::spawn(async move {
                    let mut rx = response_rx;
                    while let Some(params) = rx.recv().await {
                        let request_id = params
                            .get("requestId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let response = params.get("response");
                        let status = response
                            .and_then(|r| r.get("status"))
                            .and_then(|v| v.as_u64())
                            .map(|s| s as u16);
                        let mime_type = response
                            .and_then(|r| r.get("mimeType"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let response_size = response
                            .and_then(|r| r.get("encodedDataLength"))
                            .and_then(|v| v.as_u64());

                        let mut state = inner_clone3.lock().await;
                        // Find the matching request and update it
                        if let Some(req) = state
                            .network_requests
                            .iter_mut()
                            .rev()
                            .find(|r| r.request_id.as_deref() == Some(request_id))
                        {
                            req.status = status;
                            req.mime_type = mime_type;
                            req.response_size = response_size;
                        }
                    }
                });

                state.cdp_listener_tasks = vec![console_handle, request_handle, response_handle];
            }
            Err(problem) => {
                return Err(self.fail_start_locked(&mut state, problem).await);
            }
        }

        // Optionally start Neko for streaming
        if !headless {
            if let Some(streaming_config) = state.streaming_config.clone() {
                let display_ref = state.display.clone().unwrap_or_default();
                let resolution_ref = state.resolution.clone().unwrap_or(DesktopResolution {
                    width,
                    height,
                    dpi: Some(dpi),
                });
                let env_ref = state.environment.clone();
                drop(state);
                let _ = self
                    .streaming_manager
                    .start(
                        &display_ref,
                        resolution_ref,
                        &env_ref,
                        Some(streaming_config),
                        None,
                    )
                    .await;
                state = self.inner.lock().await;
            }
        }

        state.state = BrowserState::Active;
        state.started_at = Some(chrono::Utc::now().to_rfc3339());
        state.last_error = None;
        self.write_runtime_log_locked(
            &state,
            &format!(
                "browser runtime active on {} ({}x{}, dpi {})",
                display, width, height, dpi
            ),
        );

        let mut response = self.snapshot_locked(&state);
        drop(state);
        self.append_neko_process(&mut response).await;
        Ok(response)
    }

    pub async fn stop(&self) -> Result<BrowserStatusResponse, BrowserProblem> {
        let mut state = self.inner.lock().await;
        if matches!(state.state, BrowserState::Starting | BrowserState::Stopping) {
            return Err(BrowserProblem::start_failed(
                "Browser runtime is busy transitioning state",
            ));
        }

        state.state = BrowserState::Stopping;
        self.write_runtime_log_locked(&state, "stopping browser runtime");

        // Abort CDP listener tasks before closing the client
        for handle in state.cdp_listener_tasks.drain(..) {
            handle.abort();
        }

        // Close CDP client
        if let Some(ref cdp_client) = state.cdp_client.take() {
            cdp_client.close().await;
        }

        // Stop streaming
        let _ = self.streaming_manager.stop().await;

        // Stop Chromium
        self.stop_chromium_locked(&mut state).await;

        // Stop Xvfb
        self.stop_xvfb_locked(&mut state).await;

        state.state = BrowserState::Inactive;
        state.display = None;
        state.resolution = None;
        state.started_at = None;
        state.last_error = None;
        state.context_id = None;
        state.missing_dependencies = self.detect_missing_dependencies();
        state.install_command = self.install_command_for(&state.missing_dependencies);
        state.environment.clear();
        state.streaming_config = None;
        state.recording_fps = None;
        state.console_messages.clear();
        state.network_requests.clear();

        let mut response = self.snapshot_locked(&state);
        drop(state);
        self.append_neko_process(&mut response).await;
        Ok(response)
    }

    pub async fn shutdown(&self) {
        let _ = self.stop().await;
    }

    /// Get an Arc-wrapped CDP client handle.
    ///
    /// Returns a cloned `Arc<CdpClient>` after verifying the browser is active.
    /// The caller can use the returned handle without holding the state lock.
    pub async fn get_cdp(&self) -> Result<Arc<CdpClient>, BrowserProblem> {
        let state = self.inner.lock().await;
        if state.state != BrowserState::Active {
            return Err(BrowserProblem::not_active());
        }
        state
            .cdp_client
            .clone()
            .ok_or_else(|| BrowserProblem::cdp_error("CDP client is not connected"))
    }

    /// Ensure the browser runtime is active.
    ///
    /// Returns `BrowserProblem::NotActive` if the browser is not running.
    pub async fn ensure_active(&self) -> Result<(), BrowserProblem> {
        let state = self.inner.lock().await;
        if state.state != BrowserState::Active {
            return Err(BrowserProblem::not_active());
        }
        Ok(())
    }

    /// Discover the CDP WebSocket debugger URL from Chromium.
    ///
    /// Queries `http://127.0.0.1:9222/json/version` and extracts the
    /// `webSocketDebuggerUrl` field.
    pub async fn cdp_ws_url(&self) -> Result<String, BrowserProblem> {
        self.ensure_active().await?;

        let version_url = format!("http://127.0.0.1:{CDP_PORT}/json/version");
        let resp = reqwest::get(&version_url).await.map_err(|e| {
            BrowserProblem::cdp_error(format!(
                "failed to reach CDP endpoint at {version_url}: {e}"
            ))
        })?;
        let version_info: serde_json::Value = resp.json().await.map_err(|e| {
            BrowserProblem::cdp_error(format!("invalid JSON from {version_url}: {e}"))
        })?;
        version_info["webSocketDebuggerUrl"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| {
                BrowserProblem::cdp_error(
                    "webSocketDebuggerUrl not found in /json/version response",
                )
            })
    }

    /// Get the streaming manager for WebRTC signaling.
    pub fn streaming_manager(&self) -> &DesktopStreamingManager {
        &self.streaming_manager
    }

    /// Return the state directory used for browser data (contexts, logs, etc.).
    pub fn state_dir(&self) -> &Path {
        &self.config.state_dir
    }

    /// Push a console message into the ring buffer.
    pub async fn push_console_message(&self, message: BrowserConsoleMessage) {
        let mut state = self.inner.lock().await;
        if state.console_messages.len() >= MAX_CONSOLE_MESSAGES {
            state.console_messages.pop_front();
        }
        state.console_messages.push_back(message);
    }

    /// Push a network request into the ring buffer.
    pub async fn push_network_request(&self, request: BrowserNetworkRequest) {
        let mut state = self.inner.lock().await;
        if state.network_requests.len() >= MAX_NETWORK_REQUESTS {
            state.network_requests.pop_front();
        }
        state.network_requests.push_back(request);
    }

    /// Get console messages, optionally filtered by level.
    pub async fn console_messages(
        &self,
        level: Option<&str>,
        limit: Option<u32>,
    ) -> Vec<BrowserConsoleMessage> {
        let state = self.inner.lock().await;
        let limit = limit.unwrap_or(100) as usize;
        state
            .console_messages
            .iter()
            .filter(|msg| level.map_or(true, |l| msg.level == l))
            .rev()
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    /// Get network requests, optionally filtered by URL pattern.
    pub async fn network_requests(
        &self,
        url_pattern: Option<&str>,
        limit: Option<u32>,
    ) -> Vec<BrowserNetworkRequest> {
        let state = self.inner.lock().await;
        let limit = limit.unwrap_or(100) as usize;
        state
            .network_requests
            .iter()
            .filter(|req| url_pattern.map_or(true, |pattern| req.url.contains(pattern)))
            .rev()
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    // -----------------------------------------------------------------------
    // Internal: state management
    // -----------------------------------------------------------------------

    async fn refresh_status_locked(&self, state: &mut BrowserRuntimeStateData) {
        let missing_dependencies = if self.platform_supported() {
            self.detect_missing_dependencies()
        } else {
            Vec::new()
        };
        state.missing_dependencies = missing_dependencies.clone();
        state.install_command = self.install_command_for(&missing_dependencies);

        if !self.platform_supported() {
            state.state = BrowserState::Failed;
            state.last_error = Some(
                BrowserProblem::start_failed(browser_platform_support_message()).to_error_info(),
            );
            return;
        }

        if !missing_dependencies.is_empty() {
            state.state = BrowserState::InstallRequired;
            state.last_error = Some(
                BrowserProblem::install_required(format!(
                    "Missing: {}",
                    missing_dependencies.join(", ")
                ))
                .to_error_info(),
            );
            return;
        }

        if matches!(
            state.state,
            BrowserState::Inactive | BrowserState::Starting | BrowserState::Stopping
        ) {
            if state.state == BrowserState::Inactive {
                state.last_error = None;
            }
            return;
        }

        if state.state == BrowserState::Failed
            && state.display.is_none()
            && state.xvfb.is_none()
            && state.chromium.is_none()
        {
            return;
        }

        // Check Xvfb is running (if we started one)
        if let Some(ref xvfb) = state.xvfb {
            if let Ok(snapshot) = self.process_runtime.snapshot(&xvfb.process_id).await {
                if snapshot.status != ProcessStatus::Running {
                    let problem = BrowserProblem::start_failed("Xvfb process exited unexpectedly");
                    self.record_problem_locked(state, &problem);
                    state.state = BrowserState::Failed;
                    return;
                }
            }
        }

        // Check Chromium is running
        if let Some(ref chromium) = state.chromium {
            if let Ok(snapshot) = self.process_runtime.snapshot(&chromium.process_id).await {
                if snapshot.status != ProcessStatus::Running {
                    let problem =
                        BrowserProblem::start_failed("Chromium process exited unexpectedly");
                    self.record_problem_locked(state, &problem);
                    state.state = BrowserState::Failed;
                    return;
                }
            }
        }

        // Check CDP WebSocket connection is alive
        if let Some(ref cdp) = state.cdp_client {
            if !cdp.is_alive() {
                let problem =
                    BrowserProblem::cdp_error("CDP WebSocket connection died unexpectedly");
                self.record_problem_locked(state, &problem);
                state.state = BrowserState::Failed;
                return;
            }
        }
    }

    fn snapshot_locked(&self, state: &BrowserRuntimeStateData) -> BrowserStatusResponse {
        BrowserStatusResponse {
            state: state.state,
            display: state.display.clone(),
            resolution: state.resolution.clone(),
            started_at: state.started_at.clone(),
            cdp_url: if state.state == BrowserState::Active {
                Some(format!("ws://127.0.0.1:{CDP_PORT}/devtools/browser"))
            } else {
                None
            },
            url: None,
            missing_dependencies: state.missing_dependencies.clone(),
            install_command: state.install_command.clone(),
            processes: self.processes_locked(state),
            last_error: state.last_error.clone(),
        }
    }

    fn processes_locked(&self, state: &BrowserRuntimeStateData) -> Vec<DesktopProcessInfo> {
        let mut processes = Vec::new();
        if let Some(ref process) = state.xvfb {
            processes.push(DesktopProcessInfo {
                name: process.name.to_string(),
                pid: process.pid,
                running: process.running,
                log_path: None,
            });
        }
        if let Some(ref process) = state.chromium {
            processes.push(DesktopProcessInfo {
                name: process.name.to_string(),
                pid: process.pid,
                running: process.running,
                log_path: None,
            });
        }
        processes
    }

    async fn append_neko_process(&self, response: &mut BrowserStatusResponse) {
        if let Some(neko_info) = self.streaming_manager.process_info().await {
            response.processes.push(neko_info);
        }
    }

    fn record_problem_locked(&self, state: &mut BrowserRuntimeStateData, problem: &BrowserProblem) {
        state.last_error = Some(problem.to_error_info());
        self.write_runtime_log_locked(
            state,
            &format!("{}: {}", problem.code(), problem.to_error_info().message),
        );
    }

    // -----------------------------------------------------------------------
    // Internal: subprocess management
    // -----------------------------------------------------------------------

    async fn start_xvfb_locked(
        &self,
        state: &mut BrowserRuntimeStateData,
        resolution: &DesktopResolution,
    ) -> Result<(), BrowserProblem> {
        let Some(display) = state.display.clone() else {
            return Err(BrowserProblem::start_failed(
                "Display was not configured before starting Xvfb",
            ));
        };
        let args = vec![
            display,
            "-screen".to_string(),
            "0".to_string(),
            format!("{}x{}x24", resolution.width, resolution.height),
            "-dpi".to_string(),
            resolution.dpi.unwrap_or(DEFAULT_DPI).to_string(),
            "-nolisten".to_string(),
            "tcp".to_string(),
        ];
        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: "Xvfb".to_string(),
                args,
                cwd: None,
                env: state.environment.clone(),
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: Some(RestartPolicy::Always),
            })
            .await
            .map_err(|err| BrowserProblem::start_failed(format!("failed to start Xvfb: {err}")))?;
        state.xvfb = Some(ManagedBrowserProcess {
            name: "Xvfb",
            process_id: snapshot.id,
            pid: snapshot.pid,
            running: snapshot.status == ProcessStatus::Running,
        });
        Ok(())
    }

    async fn start_chromium_locked(
        &self,
        state: &mut BrowserRuntimeStateData,
        resolution: &DesktopResolution,
        headless: bool,
        initial_url: Option<&str>,
    ) -> Result<(), BrowserProblem> {
        let chromium_binary = find_chromium_binary().ok_or_else(|| {
            BrowserProblem::install_required(
                "Chromium binary not found. Run: sandbox-agent install browser --yes",
            )
        })?;

        let mut args = vec![
            "--no-sandbox".to_string(),
            "--disable-gpu".to_string(),
            "--disable-dev-shm-usage".to_string(),
            "--disable-software-rasterizer".to_string(),
            format!("--remote-debugging-port={CDP_PORT}"),
            "--remote-debugging-address=127.0.0.1".to_string(),
            format!("--window-size={},{}", resolution.width, resolution.height),
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
        ];

        if headless {
            args.push("--headless=new".to_string());
        }

        // Set user-data-dir for persistent contexts
        if let Some(ref context_id) = state.context_id {
            let base = crate::browser_context::contexts_base_dir(&self.config.state_dir);
            let context_dir = crate::browser_context::validate_context_id(&base, context_id)?;
            args.push(format!("--user-data-dir={}", context_dir.display()));
        }

        // Initial URL
        let url = initial_url.unwrap_or("about:blank");
        args.push(url.to_string());

        let snapshot = self
            .process_runtime
            .start_process(ProcessStartSpec {
                command: chromium_binary.to_string_lossy().to_string(),
                args,
                cwd: None,
                env: state.environment.clone(),
                tty: false,
                interactive: false,
                owner: ProcessOwner::Desktop,
                restart_policy: Some(RestartPolicy::Never),
            })
            .await
            .map_err(|err| {
                BrowserProblem::start_failed(format!("failed to start Chromium: {err}"))
            })?;
        state.chromium = Some(ManagedBrowserProcess {
            name: "chromium",
            process_id: snapshot.id,
            pid: snapshot.pid,
            running: snapshot.status == ProcessStatus::Running,
        });
        Ok(())
    }

    async fn stop_xvfb_locked(&self, state: &mut BrowserRuntimeStateData) {
        if let Some(process) = state.xvfb.take() {
            self.write_runtime_log_locked(state, "stopping Xvfb");
            let _ = self
                .process_runtime
                .stop_process(&process.process_id, Some(2_000))
                .await;
            if self
                .process_runtime
                .snapshot(&process.process_id)
                .await
                .ok()
                .is_some_and(|snapshot| snapshot.status == ProcessStatus::Running)
            {
                let _ = self
                    .process_runtime
                    .kill_process(&process.process_id, Some(1_000))
                    .await;
            }
        }
    }

    async fn stop_chromium_locked(&self, state: &mut BrowserRuntimeStateData) {
        if let Some(process) = state.chromium.take() {
            self.write_runtime_log_locked(state, "stopping Chromium");
            let _ = self
                .process_runtime
                .stop_process(&process.process_id, Some(2_000))
                .await;
            if self
                .process_runtime
                .snapshot(&process.process_id)
                .await
                .ok()
                .is_some_and(|snapshot| snapshot.status == ProcessStatus::Running)
            {
                let _ = self
                    .process_runtime
                    .kill_process(&process.process_id, Some(1_000))
                    .await;
            }
        }
    }

    async fn fail_start_locked(
        &self,
        state: &mut BrowserRuntimeStateData,
        problem: BrowserProblem,
    ) -> BrowserProblem {
        self.record_problem_locked(state, &problem);
        self.write_runtime_log_locked(state, "browser runtime startup failed; cleaning up");

        // Close CDP client if any
        if let Some(ref cdp) = state.cdp_client.take() {
            cdp.close().await;
        }

        self.stop_chromium_locked(state).await;
        self.stop_xvfb_locked(state).await;

        state.state = BrowserState::Failed;
        state.display = None;
        state.resolution = None;
        state.started_at = None;
        state.environment.clear();
        problem
    }

    // -----------------------------------------------------------------------
    // Internal: helpers
    // -----------------------------------------------------------------------

    async fn wait_for_socket(&self, display_num: i32) -> Result<(), BrowserProblem> {
        let socket = socket_path(display_num);
        let parent = socket
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("/tmp/.X11-unix"));
        let _ = fs::create_dir_all(parent);

        let start = tokio::time::Instant::now();
        while start.elapsed() < STARTUP_TIMEOUT {
            if socket.exists() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Err(BrowserProblem::timeout(format!(
            "timed out waiting for X socket {}",
            socket.display()
        )))
    }

    async fn wait_for_cdp(&self) -> Result<(), BrowserProblem> {
        let url = format!("http://127.0.0.1:{CDP_PORT}/json/version");
        let client = reqwest::Client::new();
        let start = tokio::time::Instant::now();

        while start.elapsed() < CDP_POLL_TIMEOUT {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        Err(BrowserProblem::timeout(format!(
            "CDP endpoint at {url} did not become ready within {}s",
            CDP_POLL_TIMEOUT.as_secs()
        )))
    }

    fn choose_display_num(&self) -> Result<i32, BrowserProblem> {
        let start = self.config.display_num;
        if start <= 0 {
            return Err(BrowserProblem::start_failed("displayNum must be > 0"));
        }
        for offset in 0..MAX_DISPLAY_PROBE {
            let candidate = start + offset;
            if !socket_path(candidate).exists() {
                return Ok(candidate);
            }
        }
        Err(BrowserProblem::start_failed(format!(
            "unable to find an available X display starting at :{start}"
        )))
    }

    fn base_environment(&self, display: &str) -> Result<HashMap<String, String>, BrowserProblem> {
        let mut environment = HashMap::new();
        environment.insert("DISPLAY".to_string(), display.to_string());
        environment.insert(
            "HOME".to_string(),
            self.config
                .state_dir
                .join("home")
                .to_string_lossy()
                .to_string(),
        );
        environment.insert(
            "USER".to_string(),
            std::env::var("USER").unwrap_or_else(|_| "sandbox-agent".to_string()),
        );
        environment.insert(
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        );
        fs::create_dir_all(self.config.state_dir.join("home")).map_err(|err| {
            BrowserProblem::start_failed(format!("failed to create browser home: {err}"))
        })?;
        Ok(environment)
    }

    fn detect_missing_dependencies(&self) -> Vec<String> {
        detect_missing_browser_dependencies()
    }

    fn install_command_for(&self, missing_dependencies: &[String]) -> Option<String> {
        if !self.platform_supported() || missing_dependencies.is_empty() {
            None
        } else {
            Some("sandbox-agent install browser --yes".to_string())
        }
    }

    fn platform_supported(&self) -> bool {
        cfg!(target_os = "linux") || self.config.assume_linux_for_tests
    }

    fn ensure_state_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.config.state_dir).map_err(|err| {
            format!(
                "failed to create browser state dir {}: {err}",
                self.config.state_dir.display()
            )
        })
    }

    fn write_runtime_log_locked(&self, state: &BrowserRuntimeStateData, message: &str) {
        if let Some(parent) = state.runtime_log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = format!("{} {}\n", chrono::Utc::now().to_rfc3339(), message);
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&state.runtime_log_path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
    }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

fn default_state_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XDG_STATE_HOME") {
        return PathBuf::from(value).join("sandbox-agent").join("browser");
    }
    if let Some(home) = dirs::home_dir() {
        return home
            .join(".local")
            .join("state")
            .join("sandbox-agent")
            .join("browser");
    }
    PathBuf::from("/tmp/sandbox-agent/browser")
}

fn socket_path(display_num: i32) -> PathBuf {
    PathBuf::from(format!("/tmp/.X11-unix/X{display_num}"))
}

fn find_chromium_binary() -> Option<PathBuf> {
    find_binary("chromium")
        .or_else(|| find_binary("chromium-browser"))
        .or_else(|| find_binary("google-chrome"))
        .or_else(|| find_binary("google-chrome-stable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_display_98() {
        let config = BrowserRuntimeConfig::default();
        assert_eq!(config.display_num, DEFAULT_DISPLAY_NUM);
    }

    #[test]
    fn find_chromium_binary_returns_some_on_path() {
        // This test is environment-dependent; just ensure no panic
        let _ = find_chromium_binary();
    }

    #[test]
    fn socket_path_matches_expected_format() {
        let path = socket_path(98);
        assert_eq!(path, PathBuf::from("/tmp/.X11-unix/X98"));
    }

    #[test]
    fn install_command_for_empty_deps_is_none() {
        let rt = BrowserRuntime::new(
            Arc::new(ProcessRuntime::new()),
            Arc::new(DesktopRuntime::new(Arc::new(ProcessRuntime::new()))),
        );
        assert_eq!(rt.install_command_for(&[]), None);
    }
}
