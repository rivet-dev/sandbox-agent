use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::desktop_errors::DesktopProblem;
use crate::desktop_install::desktop_platform_support_message;
use crate::desktop_types::{
    DesktopActionResponse, DesktopDisplayInfoResponse, DesktopErrorInfo,
    DesktopKeyboardPressRequest, DesktopKeyboardTypeRequest, DesktopMouseButton,
    DesktopMouseClickRequest, DesktopMouseDragRequest, DesktopMouseMoveRequest,
    DesktopMousePositionResponse, DesktopMouseScrollRequest, DesktopProcessInfo,
    DesktopRegionScreenshotQuery, DesktopResolution, DesktopStartRequest, DesktopState,
    DesktopStatusResponse,
};

const DEFAULT_WIDTH: u32 = 1440;
const DEFAULT_HEIGHT: u32 = 900;
const DEFAULT_DPI: u32 = 96;
const DEFAULT_DISPLAY_NUM: i32 = 99;
const MAX_DISPLAY_PROBE: i32 = 10;
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const INPUT_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Clone)]
pub struct DesktopRuntime {
    config: DesktopRuntimeConfig,
    inner: Arc<Mutex<DesktopRuntimeStateData>>,
}

#[derive(Debug, Clone)]
pub struct DesktopRuntimeConfig {
    state_dir: PathBuf,
    display_num: i32,
    assume_linux_for_tests: bool,
}

#[derive(Debug)]
struct DesktopRuntimeStateData {
    state: DesktopState,
    display_num: i32,
    display: Option<String>,
    resolution: Option<DesktopResolution>,
    started_at: Option<String>,
    last_error: Option<DesktopErrorInfo>,
    missing_dependencies: Vec<String>,
    install_command: Option<String>,
    runtime_log_path: PathBuf,
    environment: HashMap<String, String>,
    xvfb: Option<ManagedDesktopChild>,
    openbox: Option<ManagedDesktopChild>,
    dbus_pid: Option<u32>,
}

#[derive(Debug)]
struct ManagedDesktopChild {
    name: &'static str,
    child: Child,
    log_path: PathBuf,
}

#[derive(Debug, Clone)]
struct DesktopReadyContext {
    display: String,
    environment: HashMap<String, String>,
    resolution: DesktopResolution,
}

impl Default for DesktopRuntimeConfig {
    fn default() -> Self {
        let display_num = std::env::var("SANDBOX_AGENT_DESKTOP_DISPLAY_NUM")
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_DISPLAY_NUM);

        let state_dir = std::env::var("SANDBOX_AGENT_DESKTOP_STATE_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(default_state_dir);

        let assume_linux_for_tests = std::env::var("SANDBOX_AGENT_DESKTOP_TEST_ASSUME_LINUX")
            .ok()
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        Self {
            state_dir,
            display_num,
            assume_linux_for_tests,
        }
    }
}

impl DesktopRuntime {
    pub fn new() -> Self {
        Self::with_config(DesktopRuntimeConfig::default())
    }

    pub fn with_config(config: DesktopRuntimeConfig) -> Self {
        let runtime_log_path = config.state_dir.join("desktop-runtime.log");
        Self {
            inner: Arc::new(Mutex::new(DesktopRuntimeStateData {
                state: DesktopState::Inactive,
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
                openbox: None,
                dbus_pid: None,
            })),
            config,
        }
    }

    pub async fn status(&self) -> DesktopStatusResponse {
        let mut state = self.inner.lock().await;
        self.refresh_status_locked(&mut state).await;
        self.snapshot_locked(&state)
    }

    pub async fn start(
        &self,
        request: DesktopStartRequest,
    ) -> Result<DesktopStatusResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;

        if !self.platform_supported() {
            let problem = DesktopProblem::unsupported_platform(desktop_platform_support_message());
            self.record_problem_locked(&mut state, &problem);
            state.state = DesktopState::Failed;
            return Err(problem);
        }

        if matches!(state.state, DesktopState::Starting | DesktopState::Stopping) {
            return Err(DesktopProblem::runtime_starting(
                "Desktop runtime is busy transitioning state",
            ));
        }

        self.refresh_status_locked(&mut state).await;
        if state.state == DesktopState::Active {
            return Ok(self.snapshot_locked(&state));
        }

        if !state.missing_dependencies.is_empty() {
            return Err(DesktopProblem::dependencies_missing(
                state.missing_dependencies.clone(),
                state.install_command.clone(),
                self.processes_locked(&state),
            ));
        }

        self.ensure_state_dir_locked(&state).map_err(|err| {
            DesktopProblem::runtime_failed(err, None, self.processes_locked(&state))
        })?;
        self.write_runtime_log_locked(&state, "starting desktop runtime");

        let width = request.width.unwrap_or(DEFAULT_WIDTH);
        let height = request.height.unwrap_or(DEFAULT_HEIGHT);
        let dpi = request.dpi.unwrap_or(DEFAULT_DPI);
        validate_start_request(width, height, dpi)?;

        let display_num = self.choose_display_num()?;
        let display = format!(":{display_num}");
        let resolution = DesktopResolution {
            width,
            height,
            dpi: Some(dpi),
        };
        let environment = self.base_environment(&display)?;

        state.state = DesktopState::Starting;
        state.display_num = display_num;
        state.display = Some(display.clone());
        state.resolution = Some(resolution.clone());
        state.started_at = None;
        state.last_error = None;
        state.environment = environment;
        state.install_command = None;

        if let Err(problem) = self.start_dbus_locked(&mut state).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }
        if let Err(problem) = self.start_xvfb_locked(&mut state, &resolution).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }
        if let Err(problem) = self.wait_for_socket(display_num).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }
        if let Err(problem) = self.start_openbox_locked(&mut state).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }

        let ready = DesktopReadyContext {
            display,
            environment: state.environment.clone(),
            resolution,
        };

        let display_info = match self.query_display_info_locked(&state, &ready).await {
            Ok(display_info) => display_info,
            Err(problem) => return Err(self.fail_start_locked(&mut state, problem).await),
        };
        state.resolution = Some(display_info.resolution.clone());

        if let Err(problem) = self.capture_screenshot_locked(&state, None).await {
            return Err(self.fail_start_locked(&mut state, problem).await);
        }

        state.state = DesktopState::Active;
        state.started_at = Some(chrono::Utc::now().to_rfc3339());
        state.last_error = None;
        self.write_runtime_log_locked(
            &state,
            &format!(
                "desktop runtime active on {} ({}x{}, dpi {})",
                display_info.display,
                display_info.resolution.width,
                display_info.resolution.height,
                display_info.resolution.dpi.unwrap_or(DEFAULT_DPI)
            ),
        );

        Ok(self.snapshot_locked(&state))
    }

    pub async fn stop(&self) -> Result<DesktopStatusResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        if matches!(state.state, DesktopState::Starting | DesktopState::Stopping) {
            return Err(DesktopProblem::runtime_starting(
                "Desktop runtime is busy transitioning state",
            ));
        }

        state.state = DesktopState::Stopping;
        self.write_runtime_log_locked(&state, "stopping desktop runtime");

        self.stop_openbox_locked(&mut state).await;
        self.stop_xvfb_locked(&mut state).await;
        self.stop_dbus_locked(&mut state);

        state.state = DesktopState::Inactive;
        state.display = None;
        state.resolution = None;
        state.started_at = None;
        state.last_error = None;
        state.missing_dependencies = self.detect_missing_dependencies();
        state.install_command = self.install_command_for(&state.missing_dependencies);
        state.environment.clear();

        Ok(self.snapshot_locked(&state))
    }

    pub async fn shutdown(&self) {
        let _ = self.stop().await;
    }

    pub async fn screenshot(&self) -> Result<Vec<u8>, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        self.capture_screenshot_locked(&state, Some(&ready)).await
    }

    pub async fn screenshot_region(
        &self,
        query: DesktopRegionScreenshotQuery,
    ) -> Result<Vec<u8>, DesktopProblem> {
        validate_region(&query)?;
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let crop = format!("{}x{}+{}+{}", query.width, query.height, query.x, query.y);
        self.capture_screenshot_with_crop_locked(&state, &ready, &crop)
            .await
    }

    pub async fn mouse_position(&self) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn move_mouse(
        &self,
        request: DesktopMouseMoveRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.x, request.y)?;
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = vec![
            "mousemove".to_string(),
            request.x.to_string(),
            request.y.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn click_mouse(
        &self,
        request: DesktopMouseClickRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.x, request.y)?;
        let click_count = request.click_count.unwrap_or(1);
        if click_count == 0 {
            return Err(DesktopProblem::invalid_action(
                "clickCount must be greater than 0",
            ));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let button = mouse_button_code(request.button.unwrap_or(DesktopMouseButton::Left));
        let mut args = vec![
            "mousemove".to_string(),
            request.x.to_string(),
            request.y.to_string(),
            "click".to_string(),
        ];
        if click_count > 1 {
            args.push("--repeat".to_string());
            args.push(click_count.to_string());
        }
        args.push(button.to_string());
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn drag_mouse(
        &self,
        request: DesktopMouseDragRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.start_x, request.start_y)?;
        validate_coordinates(request.end_x, request.end_y)?;

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let button = mouse_button_code(request.button.unwrap_or(DesktopMouseButton::Left));
        let args = vec![
            "mousemove".to_string(),
            request.start_x.to_string(),
            request.start_y.to_string(),
            "mousedown".to_string(),
            button.to_string(),
            "mousemove".to_string(),
            request.end_x.to_string(),
            request.end_y.to_string(),
            "mouseup".to_string(),
            button.to_string(),
        ];
        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn scroll_mouse(
        &self,
        request: DesktopMouseScrollRequest,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        validate_coordinates(request.x, request.y)?;
        let delta_x = request.delta_x.unwrap_or(0);
        let delta_y = request.delta_y.unwrap_or(0);
        if delta_x == 0 && delta_y == 0 {
            return Err(DesktopProblem::invalid_action(
                "deltaX or deltaY must be non-zero",
            ));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let mut args = vec![
            "mousemove".to_string(),
            request.x.to_string(),
            request.y.to_string(),
        ];

        append_scroll_clicks(&mut args, delta_y, 5, 4);
        append_scroll_clicks(&mut args, delta_x, 7, 6);

        self.run_input_command_locked(&state, &ready, args).await?;
        self.mouse_position_locked(&state, &ready).await
    }

    pub async fn type_text(
        &self,
        request: DesktopKeyboardTypeRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        if request.text.is_empty() {
            return Err(DesktopProblem::invalid_action("text must not be empty"));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = type_text_args(request.text, request.delay_ms.unwrap_or(10));
        self.run_input_command_locked(&state, &ready, args).await?;
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn press_key(
        &self,
        request: DesktopKeyboardPressRequest,
    ) -> Result<DesktopActionResponse, DesktopProblem> {
        if request.key.trim().is_empty() {
            return Err(DesktopProblem::invalid_action("key must not be empty"));
        }

        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        let args = press_key_args(request.key);
        self.run_input_command_locked(&state, &ready, args).await?;
        Ok(DesktopActionResponse { ok: true })
    }

    pub async fn display_info(&self) -> Result<DesktopDisplayInfoResponse, DesktopProblem> {
        let mut state = self.inner.lock().await;
        let ready = self.ensure_ready_locked(&mut state).await?;
        self.query_display_info_locked(&state, &ready).await
    }

    async fn ensure_ready_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
    ) -> Result<DesktopReadyContext, DesktopProblem> {
        self.refresh_status_locked(state).await;
        match state.state {
            DesktopState::Active => {
                let display = state.display.clone().ok_or_else(|| {
                    DesktopProblem::runtime_failed(
                        "Desktop runtime has no active display",
                        state.install_command.clone(),
                        self.processes_locked(state),
                    )
                })?;
                let resolution = state.resolution.clone().ok_or_else(|| {
                    DesktopProblem::runtime_failed(
                        "Desktop runtime has no active resolution",
                        state.install_command.clone(),
                        self.processes_locked(state),
                    )
                })?;
                Ok(DesktopReadyContext {
                    display,
                    environment: state.environment.clone(),
                    resolution,
                })
            }
            DesktopState::InstallRequired => Err(DesktopProblem::dependencies_missing(
                state.missing_dependencies.clone(),
                state.install_command.clone(),
                self.processes_locked(state),
            )),
            DesktopState::Inactive => Err(DesktopProblem::runtime_inactive(
                "Desktop runtime has not been started",
            )),
            DesktopState::Starting | DesktopState::Stopping => Err(
                DesktopProblem::runtime_starting("Desktop runtime is still transitioning"),
            ),
            DesktopState::Failed => Err(DesktopProblem::runtime_failed(
                state
                    .last_error
                    .as_ref()
                    .map(|error| error.message.clone())
                    .unwrap_or_else(|| "Desktop runtime is unhealthy".to_string()),
                state.install_command.clone(),
                self.processes_locked(state),
            )),
        }
    }

    async fn refresh_status_locked(&self, state: &mut DesktopRuntimeStateData) {
        let missing_dependencies = if self.platform_supported() {
            self.detect_missing_dependencies()
        } else {
            Vec::new()
        };
        state.missing_dependencies = missing_dependencies.clone();
        state.install_command = self.install_command_for(&missing_dependencies);

        if !self.platform_supported() {
            state.state = DesktopState::Failed;
            state.last_error = Some(
                DesktopProblem::unsupported_platform(desktop_platform_support_message())
                    .to_error_info(),
            );
            return;
        }

        if !missing_dependencies.is_empty() {
            state.state = DesktopState::InstallRequired;
            state.last_error = Some(
                DesktopProblem::dependencies_missing(
                    missing_dependencies,
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
                .to_error_info(),
            );
            return;
        }

        if matches!(
            state.state,
            DesktopState::Inactive | DesktopState::Starting | DesktopState::Stopping
        ) {
            if state.state == DesktopState::Inactive {
                state.last_error = None;
            }
            return;
        }

        if state.state == DesktopState::Failed
            && state.display.is_none()
            && state.xvfb.is_none()
            && state.openbox.is_none()
            && state.dbus_pid.is_none()
        {
            return;
        }

        let Some(display) = state.display.clone() else {
            state.state = DesktopState::Failed;
            state.last_error = Some(
                DesktopProblem::runtime_failed(
                    "Desktop runtime has no display",
                    None,
                    self.processes_locked(state),
                )
                .to_error_info(),
            );
            return;
        };

        if let Err(problem) = self.ensure_process_running_locked(state, "Xvfb").await {
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }
        if let Err(problem) = self.ensure_process_running_locked(state, "openbox").await {
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }

        if !socket_path(state.display_num).exists() {
            let problem = DesktopProblem::runtime_failed(
                format!("X socket for display {display} is missing"),
                state.install_command.clone(),
                self.processes_locked(state),
            );
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }

        let ready = DesktopReadyContext {
            display,
            environment: state.environment.clone(),
            resolution: state.resolution.clone().unwrap_or(DesktopResolution {
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
                dpi: Some(DEFAULT_DPI),
            }),
        };

        match self.query_display_info_locked(state, &ready).await {
            Ok(display_info) => {
                state.resolution = Some(display_info.resolution);
            }
            Err(problem) => {
                self.record_problem_locked(state, &problem);
                state.state = DesktopState::Failed;
                return;
            }
        }

        if let Err(problem) = self.capture_screenshot_locked(state, Some(&ready)).await {
            self.record_problem_locked(state, &problem);
            state.state = DesktopState::Failed;
            return;
        }

        state.state = DesktopState::Active;
        state.last_error = None;
    }

    async fn ensure_process_running_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
        name: &str,
    ) -> Result<(), DesktopProblem> {
        let process = match name {
            "Xvfb" => state.xvfb.as_mut(),
            "openbox" => state.openbox.as_mut(),
            _ => None,
        };

        let Some(process) = process else {
            return Err(DesktopProblem::runtime_failed(
                format!("{name} is not running"),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        };

        match process.child.try_wait() {
            Ok(None) => Ok(()),
            Ok(Some(status)) => Err(DesktopProblem::runtime_failed(
                format!("{name} exited with status {status}"),
                state.install_command.clone(),
                self.processes_locked(state),
            )),
            Err(err) => Err(DesktopProblem::runtime_failed(
                format!("failed to inspect {name}: {err}"),
                state.install_command.clone(),
                self.processes_locked(state),
            )),
        }
    }

    async fn start_dbus_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
    ) -> Result<(), DesktopProblem> {
        if find_binary("dbus-launch").is_none() {
            self.write_runtime_log_locked(
                state,
                "dbus-launch not found; continuing without D-Bus session",
            );
            return Ok(());
        }

        let output = run_command_output("dbus-launch", &[], &state.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to launch dbus-launch: {err}"),
                    None,
                    self.processes_locked(state),
                )
            })?;

        if !output.status.success() {
            self.write_runtime_log_locked(
                state,
                &format!(
                    "dbus-launch failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            );
            return Ok(());
        }

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some((key, value)) = line.split_once('=') {
                let cleaned = value.trim().trim_end_matches(';').to_string();
                if key == "DBUS_SESSION_BUS_ADDRESS" {
                    state.environment.insert(key.to_string(), cleaned);
                } else if key == "DBUS_SESSION_BUS_PID" {
                    state.dbus_pid = cleaned.parse::<u32>().ok();
                }
            }
        }

        Ok(())
    }

    async fn start_xvfb_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
        resolution: &DesktopResolution,
    ) -> Result<(), DesktopProblem> {
        let Some(display) = state.display.clone() else {
            return Err(DesktopProblem::runtime_failed(
                "Desktop display was not configured before starting Xvfb",
                None,
                self.processes_locked(state),
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
        let log_path = self.config.state_dir.join("desktop-xvfb.log");
        let child =
            self.spawn_logged_process("Xvfb", "Xvfb", &args, &state.environment, &log_path)?;
        state.xvfb = Some(child);
        Ok(())
    }

    async fn start_openbox_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
    ) -> Result<(), DesktopProblem> {
        let log_path = self.config.state_dir.join("desktop-openbox.log");
        let child =
            self.spawn_logged_process("openbox", "openbox", &[], &state.environment, &log_path)?;
        state.openbox = Some(child);
        Ok(())
    }

    async fn stop_xvfb_locked(&self, state: &mut DesktopRuntimeStateData) {
        if let Some(mut child) = state.xvfb.take() {
            self.write_runtime_log_locked(state, "stopping Xvfb");
            let _ = terminate_child(&mut child.child).await;
        }
    }

    async fn stop_openbox_locked(&self, state: &mut DesktopRuntimeStateData) {
        if let Some(mut child) = state.openbox.take() {
            self.write_runtime_log_locked(state, "stopping openbox");
            let _ = terminate_child(&mut child.child).await;
        }
    }

    fn stop_dbus_locked(&self, state: &mut DesktopRuntimeStateData) {
        if let Some(pid) = state.dbus_pid.take() {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }

    async fn fail_start_locked(
        &self,
        state: &mut DesktopRuntimeStateData,
        problem: DesktopProblem,
    ) -> DesktopProblem {
        self.record_problem_locked(state, &problem);
        self.write_runtime_log_locked(state, "desktop runtime startup failed; cleaning up");
        self.stop_openbox_locked(state).await;
        self.stop_xvfb_locked(state).await;
        self.stop_dbus_locked(state);
        state.state = DesktopState::Failed;
        state.display = None;
        state.resolution = None;
        state.started_at = None;
        state.environment.clear();
        problem
    }

    async fn capture_screenshot_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: Option<&DesktopReadyContext>,
    ) -> Result<Vec<u8>, DesktopProblem> {
        match ready {
            Some(ready) => {
                self.capture_screenshot_with_crop_locked(state, ready, "")
                    .await
            }
            None => {
                let ready = DesktopReadyContext {
                    display: state
                        .display
                        .clone()
                        .unwrap_or_else(|| format!(":{}", state.display_num)),
                    environment: state.environment.clone(),
                    resolution: state.resolution.clone().unwrap_or(DesktopResolution {
                        width: DEFAULT_WIDTH,
                        height: DEFAULT_HEIGHT,
                        dpi: Some(DEFAULT_DPI),
                    }),
                };
                self.capture_screenshot_with_crop_locked(state, &ready, "")
                    .await
            }
        }
    }

    async fn capture_screenshot_with_crop_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        crop: &str,
    ) -> Result<Vec<u8>, DesktopProblem> {
        let mut args = vec!["-window".to_string(), "root".to_string()];
        if !crop.is_empty() {
            args.push("-crop".to_string());
            args.push(crop.to_string());
        }
        args.push("png:-".to_string());

        let output = run_command_output("import", &args, &ready.environment, SCREENSHOT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::screenshot_failed(
                    format!("failed to capture desktop screenshot: {err}"),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::screenshot_failed(
                format!(
                    "desktop screenshot command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                self.processes_locked(state),
            ));
        }
        validate_png(&output.stdout).map_err(|message| {
            DesktopProblem::screenshot_failed(message, self.processes_locked(state))
        })?;
        Ok(output.stdout)
    }

    async fn mouse_position_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
    ) -> Result<DesktopMousePositionResponse, DesktopProblem> {
        let args = vec!["getmouselocation".to_string(), "--shell".to_string()];
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::input_failed(
                    format!("failed to query mouse position: {err}"),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::input_failed(
                format!(
                    "mouse position command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                self.processes_locked(state),
            ));
        }
        parse_mouse_position(&output.stdout)
            .map_err(|message| DesktopProblem::input_failed(message, self.processes_locked(state)))
    }

    async fn run_input_command_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
        args: Vec<String>,
    ) -> Result<(), DesktopProblem> {
        let output = run_command_output("xdotool", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::input_failed(
                    format!("failed to execute desktop input command: {err}"),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::input_failed(
                format!(
                    "desktop input command failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                self.processes_locked(state),
            ));
        }
        Ok(())
    }

    async fn query_display_info_locked(
        &self,
        state: &DesktopRuntimeStateData,
        ready: &DesktopReadyContext,
    ) -> Result<DesktopDisplayInfoResponse, DesktopProblem> {
        let args = vec!["--current".to_string()];
        let output = run_command_output("xrandr", &args, &ready.environment, INPUT_TIMEOUT)
            .await
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to query display info: {err}"),
                    state.install_command.clone(),
                    self.processes_locked(state),
                )
            })?;
        if !output.status.success() {
            return Err(DesktopProblem::runtime_failed(
                format!(
                    "display query failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
                state.install_command.clone(),
                self.processes_locked(state),
            ));
        }
        let resolution = parse_xrandr_resolution(&output.stdout).map_err(|message| {
            DesktopProblem::runtime_failed(
                message,
                state.install_command.clone(),
                self.processes_locked(state),
            )
        })?;
        Ok(DesktopDisplayInfoResponse {
            display: ready.display.clone(),
            resolution: DesktopResolution {
                dpi: ready.resolution.dpi,
                ..resolution
            },
        })
    }

    fn detect_missing_dependencies(&self) -> Vec<String> {
        let mut missing = Vec::new();
        for (name, binary) in [
            ("Xvfb", "Xvfb"),
            ("openbox", "openbox"),
            ("xdotool", "xdotool"),
            ("import", "import"),
            ("xrandr", "xrandr"),
        ] {
            if find_binary(binary).is_none() {
                missing.push(name.to_string());
            }
        }
        missing
    }

    fn install_command_for(&self, missing_dependencies: &[String]) -> Option<String> {
        if !self.platform_supported() || missing_dependencies.is_empty() {
            None
        } else {
            Some("sandbox-agent install desktop --yes".to_string())
        }
    }

    fn platform_supported(&self) -> bool {
        cfg!(target_os = "linux") || self.config.assume_linux_for_tests
    }

    fn choose_display_num(&self) -> Result<i32, DesktopProblem> {
        for offset in 0..MAX_DISPLAY_PROBE {
            let candidate = self.config.display_num + offset;
            if !socket_path(candidate).exists() {
                return Ok(candidate);
            }
        }
        Err(DesktopProblem::runtime_failed(
            "unable to find an available X display starting at :99",
            None,
            Vec::new(),
        ))
    }

    fn base_environment(&self, display: &str) -> Result<HashMap<String, String>, DesktopProblem> {
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
            DesktopProblem::runtime_failed(
                format!("failed to create desktop home: {err}"),
                None,
                Vec::new(),
            )
        })?;
        Ok(environment)
    }

    fn spawn_logged_process(
        &self,
        name: &'static str,
        command: &str,
        args: &[String],
        environment: &HashMap<String, String>,
        log_path: &Path,
    ) -> Result<ManagedDesktopChild, DesktopProblem> {
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!("failed to create desktop log directory: {err}"),
                    None,
                    Vec::new(),
                )
            })?;
        }

        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|err| {
                DesktopProblem::runtime_failed(
                    format!(
                        "failed to open desktop log file {}: {err}",
                        log_path.display()
                    ),
                    None,
                    Vec::new(),
                )
            })?;
        let stderr = stdout.try_clone().map_err(|err| {
            DesktopProblem::runtime_failed(
                format!(
                    "failed to clone desktop log file {}: {err}",
                    log_path.display()
                ),
                None,
                Vec::new(),
            )
        })?;

        let mut child = Command::new(command);
        child.args(args);
        child.envs(environment);
        child.stdin(Stdio::null());
        child.stdout(Stdio::from(stdout));
        child.stderr(Stdio::from(stderr));

        let child = child.spawn().map_err(|err| {
            DesktopProblem::runtime_failed(
                format!("failed to spawn {name}: {err}"),
                None,
                Vec::new(),
            )
        })?;

        Ok(ManagedDesktopChild {
            name,
            child,
            log_path: log_path.to_path_buf(),
        })
    }

    async fn wait_for_socket(&self, display_num: i32) -> Result<(), DesktopProblem> {
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

        Err(DesktopProblem::runtime_failed(
            format!("timed out waiting for X socket {}", socket.display()),
            None,
            Vec::new(),
        ))
    }

    fn snapshot_locked(&self, state: &DesktopRuntimeStateData) -> DesktopStatusResponse {
        DesktopStatusResponse {
            state: state.state,
            display: state.display.clone(),
            resolution: state.resolution.clone(),
            started_at: state.started_at.clone(),
            last_error: state.last_error.clone(),
            missing_dependencies: state.missing_dependencies.clone(),
            install_command: state.install_command.clone(),
            processes: self.processes_locked(state),
            runtime_log_path: Some(state.runtime_log_path.to_string_lossy().to_string()),
        }
    }

    fn processes_locked(&self, state: &DesktopRuntimeStateData) -> Vec<DesktopProcessInfo> {
        let mut processes = Vec::new();
        if let Some(child) = state.xvfb.as_ref() {
            processes.push(DesktopProcessInfo {
                name: child.name.to_string(),
                pid: child.child.id(),
                running: child_is_running(&child.child),
                log_path: Some(child.log_path.to_string_lossy().to_string()),
            });
        }
        if let Some(child) = state.openbox.as_ref() {
            processes.push(DesktopProcessInfo {
                name: child.name.to_string(),
                pid: child.child.id(),
                running: child_is_running(&child.child),
                log_path: Some(child.log_path.to_string_lossy().to_string()),
            });
        }
        if let Some(pid) = state.dbus_pid {
            processes.push(DesktopProcessInfo {
                name: "dbus".to_string(),
                pid: Some(pid),
                running: process_exists(pid),
                log_path: None,
            });
        }
        processes
    }

    fn record_problem_locked(&self, state: &mut DesktopRuntimeStateData, problem: &DesktopProblem) {
        state.last_error = Some(problem.to_error_info());
        self.write_runtime_log_locked(
            state,
            &format!("{}: {}", problem.code(), problem.to_error_info().message),
        );
    }

    fn ensure_state_dir_locked(&self, state: &DesktopRuntimeStateData) -> Result<(), String> {
        fs::create_dir_all(&self.config.state_dir).map_err(|err| {
            format!(
                "failed to create desktop state dir {}: {err}",
                self.config.state_dir.display()
            )
        })?;
        if let Some(parent) = state.runtime_log_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create runtime log dir {}: {err}",
                    parent.display()
                )
            })?;
        }
        Ok(())
    }

    fn write_runtime_log_locked(&self, state: &DesktopRuntimeStateData, message: &str) {
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

fn default_state_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XDG_STATE_HOME") {
        return PathBuf::from(value).join("sandbox-agent").join("desktop");
    }
    if let Some(home) = dirs::home_dir() {
        return home
            .join(".local")
            .join("state")
            .join("sandbox-agent")
            .join("desktop");
    }
    std::env::temp_dir().join("sandbox-agent-desktop")
}

fn socket_path(display_num: i32) -> PathBuf {
    PathBuf::from(format!("/tmp/.X11-unix/X{display_num}"))
}

fn find_binary(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_env) {
        let candidate = path.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

async fn run_command_output(
    command: &str,
    args: &[String],
    environment: &HashMap<String, String>,
    timeout: Duration,
) -> Result<Output, String> {
    use tokio::io::AsyncReadExt;

    let mut child = Command::new(command);
    child.args(args);
    child.envs(environment);
    child.stdin(Stdio::null());
    child.stdout(Stdio::piped());
    child.stderr(Stdio::piped());

    let mut child = child.spawn().map_err(|err| err.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture child stderr".to_string())?;

    let stdout_task = tokio::spawn(async move {
        let mut stdout = stdout;
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(|err| err.to_string())?,
        Err(_) => {
            terminate_child(&mut child).await?;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("command timed out after {}s", timeout.as_secs()));
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    let stderr = stderr_task
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn terminate_child(child: &mut Child) -> Result<(), String> {
    if let Ok(Some(_)) = child.try_wait() {
        return Ok(());
    }
    child.start_kill().map_err(|err| err.to_string())?;
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    Ok(())
}

fn child_is_running(child: &Child) -> bool {
    child.id().is_some()
}

fn process_exists(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        return libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn validate_png(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < PNG_SIGNATURE.len() || &bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("desktop screenshot did not return PNG bytes".to_string());
    }
    Ok(())
}

fn parse_xrandr_resolution(bytes: &[u8]) -> Result<DesktopResolution, String> {
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines() {
        if let Some(index) = line.find(" current ") {
            let tail = &line[index + " current ".len()..];
            let mut parts = tail.split(',');
            if let Some(current) = parts.next() {
                let dims: Vec<&str> = current.split_whitespace().collect();
                if dims.len() >= 3 {
                    let width = dims[0]
                        .parse::<u32>()
                        .map_err(|_| "failed to parse xrandr width".to_string())?;
                    let height = dims[2]
                        .parse::<u32>()
                        .map_err(|_| "failed to parse xrandr height".to_string())?;
                    return Ok(DesktopResolution {
                        width,
                        height,
                        dpi: None,
                    });
                }
            }
        }
    }
    Err("unable to parse xrandr current resolution".to_string())
}

fn parse_mouse_position(bytes: &[u8]) -> Result<DesktopMousePositionResponse, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut x = None;
    let mut y = None;
    let mut screen = None;
    let mut window = None;
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            match key {
                "X" => x = value.parse::<i32>().ok(),
                "Y" => y = value.parse::<i32>().ok(),
                "SCREEN" => screen = value.parse::<i32>().ok(),
                "WINDOW" => window = Some(value.to_string()),
                _ => {}
            }
        }
    }
    match (x, y) {
        (Some(x), Some(y)) => Ok(DesktopMousePositionResponse {
            x,
            y,
            screen,
            window,
        }),
        _ => Err("unable to parse xdotool mouse position".to_string()),
    }
}

fn type_text_args(text: String, delay_ms: u32) -> Vec<String> {
    vec![
        "type".to_string(),
        "--delay".to_string(),
        delay_ms.to_string(),
        "--".to_string(),
        text,
    ]
}

fn press_key_args(key: String) -> Vec<String> {
    vec!["key".to_string(), "--".to_string(), key]
}

fn validate_start_request(width: u32, height: u32, dpi: u32) -> Result<(), DesktopProblem> {
    if width == 0 || height == 0 {
        return Err(DesktopProblem::invalid_action(
            "Desktop width and height must be greater than 0",
        ));
    }
    if dpi == 0 {
        return Err(DesktopProblem::invalid_action(
            "Desktop dpi must be greater than 0",
        ));
    }
    Ok(())
}

fn validate_region(query: &DesktopRegionScreenshotQuery) -> Result<(), DesktopProblem> {
    validate_coordinates(query.x, query.y)?;
    if query.width == 0 || query.height == 0 {
        return Err(DesktopProblem::invalid_action(
            "Screenshot region width and height must be greater than 0",
        ));
    }
    Ok(())
}

fn validate_coordinates(x: i32, y: i32) -> Result<(), DesktopProblem> {
    if x < 0 || y < 0 {
        return Err(DesktopProblem::invalid_action(
            "Desktop coordinates must be non-negative",
        ));
    }
    Ok(())
}

fn mouse_button_code(button: DesktopMouseButton) -> u8 {
    match button {
        DesktopMouseButton::Left => 1,
        DesktopMouseButton::Middle => 2,
        DesktopMouseButton::Right => 3,
    }
}

fn append_scroll_clicks(
    args: &mut Vec<String>,
    delta: i32,
    positive_button: u8,
    negative_button: u8,
) {
    if delta == 0 {
        return;
    }
    let button = if delta > 0 {
        positive_button
    } else {
        negative_button
    };
    let repeat = delta.unsigned_abs();
    args.push("click".to_string());
    if repeat > 1 {
        args.push("--repeat".to_string());
        args.push(repeat.to_string());
    }
    args.push(button.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_xrandr_resolution_reads_current_geometry() {
        let bytes = b"Screen 0: minimum 1 x 1, current 1440 x 900, maximum 32767 x 32767\n";
        let parsed = parse_xrandr_resolution(bytes).expect("parse resolution");
        assert_eq!(parsed.width, 1440);
        assert_eq!(parsed.height, 900);
    }

    #[test]
    fn parse_mouse_position_reads_shell_output() {
        let bytes = b"X=123\nY=456\nSCREEN=0\nWINDOW=0\n";
        let parsed = parse_mouse_position(bytes).expect("parse mouse position");
        assert_eq!(parsed.x, 123);
        assert_eq!(parsed.y, 456);
        assert_eq!(parsed.screen, Some(0));
        assert_eq!(parsed.window.as_deref(), Some("0"));
    }

    #[test]
    fn png_validation_rejects_non_png_bytes() {
        let error = validate_png(b"not png").expect_err("validation should fail");
        assert!(error.contains("PNG"));
    }

    #[test]
    fn type_text_args_insert_double_dash_before_user_text() {
        let args = type_text_args("--help".to_string(), 5);
        assert_eq!(args, vec!["type", "--delay", "5", "--", "--help"]);
    }

    #[test]
    fn press_key_args_insert_double_dash_before_user_key() {
        let args = press_key_args("--help".to_string());
        assert_eq!(args, vec!["key", "--", "--help"]);
    }

    #[test]
    fn append_scroll_clicks_uses_positive_direction_buttons() {
        let mut args = Vec::new();
        append_scroll_clicks(&mut args, 2, 5, 4);
        append_scroll_clicks(&mut args, -3, 7, 6);
        assert_eq!(
            args,
            vec!["click", "--repeat", "2", "5", "click", "--repeat", "3", "6"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_command_output_kills_child_on_timeout() {
        let pid_file = std::env::temp_dir().join(format!(
            "sandbox-agent-desktop-runtime-timeout-{}.pid",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&pid_file);
        let command = format!("echo $$ > {}; exec sleep 30", pid_file.display());
        let args = vec!["-c".to_string(), command];

        let error = run_command_output("sh", &args, &HashMap::new(), Duration::from_millis(200))
            .await
            .expect_err("command should time out");
        assert!(error.contains("timed out"));

        let pid = std::fs::read_to_string(&pid_file)
            .expect("pid file should exist")
            .trim()
            .parse::<u32>()
            .expect("pid should parse");

        for _ in 0..20 {
            if !process_exists(pid) {
                let _ = std::fs::remove_file(&pid_file);
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let _ = std::fs::remove_file(&pid_file);
        panic!("timed out child process {pid} still exists after timeout cleanup");
    }
}
