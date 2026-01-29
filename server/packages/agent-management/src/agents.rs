use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{
    Child,
    ChildStderr,
    ChildStdin,
    ChildStdout,
    Command,
    ExitStatus,
    Stdio,
};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use sandbox_agent_extracted_agent_schemas::codex as codex_schema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
    Opencode,
    Amp,
    Mock,
}

impl AgentId {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Opencode => "opencode",
            AgentId::Amp => "amp",
            AgentId::Mock => "mock",
        }
    }

    pub fn binary_name(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Opencode => "opencode",
            AgentId::Amp => "amp",
            AgentId::Mock => "mock",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(AgentId::Claude),
            "codex" => Some(AgentId::Codex),
            "opencode" => Some(AgentId::Opencode),
            "amp" => Some(AgentId::Amp),
            "mock" => Some(AgentId::Mock),
            _ => None,
        }
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    LinuxX64,
    LinuxX64Musl,
    LinuxArm64,
    MacosArm64,
    MacosX64,
}

impl Platform {
    pub fn detect() -> Result<Self, AgentError> {
        let os = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        // Detect musl at runtime by checking for the musl dynamic linker
        // This is more reliable than cfg!(target_env = "musl") which checks compile-time
        let is_musl = Self::detect_musl_runtime();

        match (os, arch, is_musl) {
            ("linux", "x86_64", true) => Ok(Self::LinuxX64Musl),
            ("linux", "x86_64", false) => Ok(Self::LinuxX64),
            ("linux", "aarch64", _) => Ok(Self::LinuxArm64),
            ("macos", "aarch64", _) => Ok(Self::MacosArm64),
            ("macos", "x86_64", _) => Ok(Self::MacosX64),
            _ => Err(AgentError::UnsupportedPlatform {
                os: os.to_string(),
                arch: arch.to_string(),
            }),
        }
    }

    /// Detect if the runtime environment uses musl libc by checking for musl dynamic linker
    fn detect_musl_runtime() -> bool {
        use std::path::Path;
        // Check for musl dynamic linkers (x86_64 and aarch64)
        Path::new("/lib/ld-musl-x86_64.so.1").exists()
            || Path::new("/lib/ld-musl-aarch64.so.1").exists()
    }
}

#[derive(Debug, Clone)]
pub struct AgentManager {
    install_dir: PathBuf,
    platform: Platform,
}

impl AgentManager {
    pub fn new(install_dir: impl Into<PathBuf>) -> Result<Self, AgentError> {
        Ok(Self {
            install_dir: install_dir.into(),
            platform: Platform::detect()?,
        })
    }

    pub fn with_platform(
        install_dir: impl Into<PathBuf>,
        platform: Platform,
    ) -> Self {
        Self {
            install_dir: install_dir.into(),
            platform,
        }
    }

    pub fn install(&self, agent: AgentId, options: InstallOptions) -> Result<InstallResult, AgentError> {
        let install_path = self.binary_path(agent);
        if !options.reinstall {
            if let Ok(existing_path) = self.resolve_binary(agent) {
                return Ok(InstallResult {
                    path: existing_path,
                    version: self.version(agent).unwrap_or(None),
                });
            }
        }

        fs::create_dir_all(&self.install_dir)?;

        match agent {
            AgentId::Claude => install_claude(&install_path, self.platform, options.version.as_deref())?,
            AgentId::Codex => install_codex(&install_path, self.platform, options.version.as_deref())?,
            AgentId::Opencode => install_opencode(&install_path, self.platform, options.version.as_deref())?,
            AgentId::Amp => install_amp(&install_path, self.platform, options.version.as_deref())?,
            AgentId::Mock => {
                if !install_path.exists() {
                    fs::write(&install_path, b"mock")?;
                }
            }
        }

        Ok(InstallResult {
            path: install_path,
            version: self.version(agent).unwrap_or(None),
        })
    }

    pub fn is_installed(&self, agent: AgentId) -> bool {
        if agent == AgentId::Mock {
            return true;
        }
        self.binary_path(agent).exists()
            || find_in_path(agent.binary_name()).is_some()
            || default_install_dir().join(agent.binary_name()).exists()
    }

    pub fn binary_path(&self, agent: AgentId) -> PathBuf {
        self.install_dir.join(agent.binary_name())
    }

    pub fn version(&self, agent: AgentId) -> Result<Option<String>, AgentError> {
        if agent == AgentId::Mock {
            return Ok(Some("builtin".to_string()));
        }
        let path = self.resolve_binary(agent)?;
        let attempts = [vec!["--version"], vec!["version"], vec!["-V"]];
        for args in attempts {
            let output = Command::new(&path).args(args).output();
            if let Ok(output) = output {
                if output.status.success() {
                    if let Some(version) = parse_version_output(&output) {
                        return Ok(Some(version));
                    }
                }
            }
        }
        Ok(None)
    }

    pub fn spawn(&self, agent: AgentId, options: SpawnOptions) -> Result<SpawnResult, AgentError> {
        if agent == AgentId::Mock {
            return Err(AgentError::UnsupportedAgent {
                agent: agent.as_str().to_string(),
            });
        }
        if agent == AgentId::Codex {
            return self.spawn_codex_app_server(options);
        }
        let path = self.resolve_binary(agent)?;
        let working_dir = options
            .working_dir
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let mut command = Command::new(&path);
        command.current_dir(&working_dir);

        match agent {
            AgentId::Claude => {
                command
                    .arg("--output-format")
                    .arg("stream-json")
                    .arg("--verbose");
                if let Some(model) = options.model.as_deref() {
                    command.arg("--model").arg(model);
                }
                if let Some(session_id) = options.session_id.as_deref() {
                    command.arg("--resume").arg(session_id);
                }
                match options.permission_mode.as_deref() {
                    Some("plan") => {
                        command.arg("--permission-mode").arg("plan");
                    }
                    Some("bypass") => {
                        command.arg("--dangerously-skip-permissions");
                    }
                    Some("acceptEdits") => {
                        command.arg("--permission-mode").arg("acceptEdits");
                    }
                    _ => {}
                }
                if options.streaming_input {
                    command
                        .arg("--input-format")
                        .arg("stream-json")
                        .arg("--permission-prompt-tool")
                        .arg("stdio")
                        .arg("--include-partial-messages");
                } else {
                    command.arg("--print").arg("--").arg(&options.prompt);
                }
            }
            AgentId::Codex => {
                if options.session_id.is_some() {
                    return Err(AgentError::ResumeUnsupported { agent });
                }
                command.arg("app-server");
            }
            AgentId::Opencode => {
                command
                    .arg("run")
                    .arg("--format")
                    .arg("json");
                if let Some(model) = options.model.as_deref() {
                    command.arg("-m").arg(model);
                }
                if let Some(agent_mode) = options.agent_mode.as_deref() {
                    command.arg("--agent").arg(agent_mode);
                }
                if let Some(variant) = options.variant.as_deref() {
                    command.arg("--variant").arg(variant);
                }
                if let Some(session_id) = options.session_id.as_deref() {
                    command.arg("-s").arg(session_id);
                }
                command.arg(&options.prompt);
            }
            AgentId::Amp => {
                let output = spawn_amp(&path, &working_dir, &options)?;
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let events = parse_jsonl_from_outputs(&stdout, &stderr);
                return Ok(SpawnResult {
                    status: output.status,
                    stdout,
                    stderr,
                    session_id: extract_session_id(agent, &events),
                    result: extract_result_text(agent, &events),
                    events,
                });
            }
            AgentId::Mock => {
                return Err(AgentError::UnsupportedAgent {
                    agent: agent.as_str().to_string(),
                });
            }
        }

        for (key, value) in options.env {
            command.env(key, value);
        }

        let output = command.output().map_err(AgentError::Io)?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let events = parse_jsonl_from_outputs(&stdout, &stderr);
        Ok(SpawnResult {
            status: output.status,
            stdout,
            stderr,
            session_id: extract_session_id(agent, &events),
            result: extract_result_text(agent, &events),
            events,
        })
    }

    pub fn spawn_streaming(
        &self,
        agent: AgentId,
        mut options: SpawnOptions,
    ) -> Result<StreamingSpawn, AgentError> {
        let codex_options = if agent == AgentId::Codex {
            Some(options.clone())
        } else {
            None
        };
        if agent == AgentId::Claude {
            options.streaming_input = true;
        }
        let mut command = self.build_command(agent, &options)?;
        if matches!(agent, AgentId::Codex | AgentId::Claude) {
            command.stdin(Stdio::piped());
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(AgentError::Io)?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        Ok(StreamingSpawn {
            child,
            stdin,
            stdout,
            stderr,
            codex_options,
        })
    }

    fn spawn_codex_app_server(&self, options: SpawnOptions) -> Result<SpawnResult, AgentError> {
        if options.session_id.is_some() {
            return Err(AgentError::ResumeUnsupported { agent: AgentId::Codex });
        }
        let mut command = self.build_command(AgentId::Codex, &options)?;
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (key, value) in options.env {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(AgentError::Io)?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            AgentError::Io(io::Error::new(io::ErrorKind::Other, "missing codex stdin"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AgentError::Io(io::Error::new(io::ErrorKind::Other, "missing codex stdout"))
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AgentError::Io(io::Error::new(io::ErrorKind::Other, "missing codex stderr"))
        })?;

        let stderr_handle = std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut buffer);
            buffer
        });

        let approval_policy = codex_approval_policy(options.permission_mode.as_deref());
        let sandbox_mode = codex_sandbox_mode(options.permission_mode.as_deref());
        let sandbox_policy = codex_sandbox_policy(options.permission_mode.as_deref());
        let prompt = codex_prompt_for_mode(&options.prompt, options.agent_mode.as_deref());
        let cwd = options
            .working_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());

        let mut next_id = 1i64;
        let init_id = next_request_id(&mut next_id);
        send_json_line(
            &mut stdin,
            &codex_schema::ClientRequest::Initialize {
                id: init_id.clone(),
                params: codex_schema::InitializeParams {
                    client_info: codex_schema::ClientInfo {
                        name: "sandbox-agent".to_string(),
                        title: Some("sandbox-agent".to_string()),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                },
            },
        )?;

        let mut init_done = false;
        let mut thread_start_sent = false;
        let mut thread_start_id: Option<String> = None;
        let mut turn_start_sent = false;
        let mut thread_id: Option<String> = None;
        let mut stdout_buffer = String::new();
        let mut events = Vec::new();
        let mut line = String::new();
        let mut reader = BufReader::new(stdout);
        let mut completed = false;
        while reader.read_line(&mut line).map_err(AgentError::Io)? > 0 {
            stdout_buffer.push_str(&line);
            let trimmed = line.trim_end_matches(&['\r', '\n'][..]).to_string();
            line.clear();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&trimmed) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let message: codex_schema::JsonrpcMessage =
                match serde_json::from_value(value.clone()) {
                    Ok(message) => message,
                    Err(_) => continue,
                };
            match message {
                codex_schema::JsonrpcMessage::Response(response) => {
                    let response_id = response.id.to_string();
                    if !init_done && response_id == init_id.to_string() {
                        init_done = true;
                        send_json_line(
                            &mut stdin,
                            &codex_schema::JsonrpcNotification {
                                method: "initialized".to_string(),
                                params: None,
                            },
                        )?;
                        let request_id = next_request_id(&mut next_id);
                        let request_id_str = request_id.to_string();
                        let mut params = codex_schema::ThreadStartParams::default();
                        params.approval_policy = approval_policy;
                        params.sandbox = sandbox_mode;
                        params.model = options.model.clone();
                        params.cwd = cwd.clone();
                        send_json_line(
                            &mut stdin,
                            &codex_schema::ClientRequest::ThreadStart { id: request_id, params },
                        )?;
                        thread_start_id = Some(request_id_str);
                        thread_start_sent = true;
                    } else if thread_start_id.as_deref() == Some(&response_id) && thread_id.is_none() {
                        thread_id = codex_thread_id_from_response(&response.result);
                    }
                    events.push(value);
                }
                codex_schema::JsonrpcMessage::Notification(_) => {
                    if let Ok(notification) =
                        serde_json::from_value::<codex_schema::ServerNotification>(value.clone())
                    {
                        if thread_id.is_none() {
                            thread_id = codex_thread_id_from_notification(&notification);
                        }
                        if matches!(
                            notification,
                            codex_schema::ServerNotification::TurnCompleted(_)
                                | codex_schema::ServerNotification::Error(_)
                        ) {
                            completed = true;
                        }
                        if let codex_schema::ServerNotification::ItemCompleted(params) = &notification {
                            if matches!(params.item, codex_schema::ThreadItem::AgentMessage { .. }) {
                                completed = true;
                            }
                        }
                    }
                    events.push(value);
                }
                codex_schema::JsonrpcMessage::Request(_) => {
                    events.push(value);
                }
                codex_schema::JsonrpcMessage::Error(_) => {
                    events.push(value);
                    completed = true;
                }
            }
            if thread_id.is_some() && thread_start_sent && !turn_start_sent {
                let request_id = next_request_id(&mut next_id);
                let params = codex_schema::TurnStartParams {
                    approval_policy,
                    collaboration_mode: None,
                    cwd: cwd.clone(),
                    effort: None,
                    input: vec![codex_schema::UserInput::Text {
                        text: prompt.clone(),
                        text_elements: Vec::new(),
                    }],
                    model: options.model.clone(),
                    output_schema: None,
                    sandbox_policy: sandbox_policy.clone(),
                    summary: None,
                    thread_id: thread_id.clone().unwrap_or_default(),
                };
                send_json_line(
                    &mut stdin,
                    &codex_schema::ClientRequest::TurnStart {
                        id: request_id,
                        params,
                    },
                )?;
                turn_start_sent = true;
            }
            if completed {
                break;
            }
        }

        drop(stdin);
        let status = if completed {
            let start = Instant::now();
            loop {
                if let Some(status) = child.try_wait().map_err(AgentError::Io)? {
                    break status;
                }
                if start.elapsed() > Duration::from_secs(5) {
                    let _ = child.kill();
                    break child.wait().map_err(AgentError::Io)?;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        } else {
            child.wait().map_err(AgentError::Io)?
        };
        let stderr_output = stderr_handle.join().unwrap_or_default();

        Ok(SpawnResult {
            status,
            stdout: stdout_buffer,
            stderr: stderr_output,
            session_id: extract_session_id(AgentId::Codex, &events),
            result: extract_result_text(AgentId::Codex, &events),
            events,
        })
    }

    fn build_command(&self, agent: AgentId, options: &SpawnOptions) -> Result<Command, AgentError> {
        let path = self.resolve_binary(agent)?;
        let working_dir = options
            .working_dir
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let mut command = Command::new(&path);
        command.current_dir(&working_dir);

        match agent {
            AgentId::Claude => {
                command
                    .arg("--output-format")
                    .arg("stream-json")
                    .arg("--verbose");
                if let Some(model) = options.model.as_deref() {
                    command.arg("--model").arg(model);
                }
                if let Some(session_id) = options.session_id.as_deref() {
                    command.arg("--resume").arg(session_id);
                }
                match options.permission_mode.as_deref() {
                    Some("plan") => {
                        command.arg("--permission-mode").arg("plan");
                    }
                    Some("bypass") => {
                        command.arg("--dangerously-skip-permissions");
                    }
                    Some("acceptEdits") => {
                        command.arg("--permission-mode").arg("acceptEdits");
                    }
                    _ => {}
                }
                if options.streaming_input {
                    command
                        .arg("--input-format")
                        .arg("stream-json")
                        .arg("--permission-prompt-tool")
                        .arg("stdio")
                        .arg("--include-partial-messages");
                } else {
                    command.arg(&options.prompt);
                }
            }
            AgentId::Codex => {
                if options.session_id.is_some() {
                    return Err(AgentError::ResumeUnsupported { agent });
                }
                command.arg("app-server");
            }
            AgentId::Opencode => {
                command.arg("run").arg("--format").arg("json");
                if let Some(model) = options.model.as_deref() {
                    command.arg("-m").arg(model);
                }
                if let Some(agent_mode) = options.agent_mode.as_deref() {
                    command.arg("--agent").arg(agent_mode);
                }
                if let Some(variant) = options.variant.as_deref() {
                    command.arg("--variant").arg(variant);
                }
                if let Some(session_id) = options.session_id.as_deref() {
                    command.arg("-s").arg(session_id);
                }
                command.arg(&options.prompt);
            }
            AgentId::Amp => {
                return Ok(build_amp_command(&path, &working_dir, options));
            }
            AgentId::Mock => {
                return Err(AgentError::UnsupportedAgent {
                    agent: agent.as_str().to_string(),
                });
            }
        }

        for (key, value) in &options.env {
            command.env(key, value);
        }

        Ok(command)
    }

    pub fn resolve_binary(&self, agent: AgentId) -> Result<PathBuf, AgentError> {
        let path = self.binary_path(agent);
        if path.exists() {
            return Ok(path);
        }
        if let Some(path) = find_in_path(agent.binary_name()) {
            return Ok(path);
        }
        let fallback = default_install_dir().join(agent.binary_name());
        if fallback.exists() {
            return Ok(fallback);
        }
        Err(AgentError::BinaryNotFound { agent })
    }
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub reinstall: bool,
    pub version: Option<String>,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            reinstall: false,
            version: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct InstallResult {
    pub path: PathBuf,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub prompt: String,
    pub model: Option<String>,
    pub variant: Option<String>,
    pub agent_mode: Option<String>,
    pub permission_mode: Option<String>,
    pub session_id: Option<String>,
    pub working_dir: Option<PathBuf>,
    pub env: HashMap<String, String>,
    /// Use stream-json input via stdin (Claude only).
    pub streaming_input: bool,
}

impl SpawnOptions {
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            model: None,
            variant: None,
            agent_mode: None,
            permission_mode: None,
            session_id: None,
            working_dir: None,
            env: HashMap::new(),
            streaming_input: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SpawnResult {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
    pub events: Vec<Value>,
    pub session_id: Option<String>,
    pub result: Option<String>,
}

#[derive(Debug)]
pub struct StreamingSpawn {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
    pub codex_options: Option<SpawnOptions>,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("unsupported platform {os}/{arch}")]
    UnsupportedPlatform { os: String, arch: String },
    #[error("unsupported agent {agent}")]
    UnsupportedAgent { agent: String },
    #[error("binary not found for {agent}")]
    BinaryNotFound { agent: AgentId },
    #[error("download failed: {url}")]
    DownloadFailed { url: Url },
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("url parse error: {0}")]
    UrlParse(#[from] url::ParseError),
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("extract failed: {0}")]
    ExtractFailed(String),
    #[error("resume unsupported for {agent}")]
    ResumeUnsupported { agent: AgentId },
}

fn parse_version_output(output: &std::process::Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn parse_jsonl(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn parse_jsonl_from_outputs(stdout: &str, stderr: &str) -> Vec<Value> {
    let mut events = parse_jsonl(stdout);
    events.extend(parse_jsonl(stderr));
    events
}

fn codex_prompt_for_mode(prompt: &str, mode: Option<&str>) -> String {
    match mode {
        Some("plan") => format!("Make a plan before acting.\n\n{prompt}"),
        _ => prompt.to_string(),
    }
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

fn next_request_id(next_id: &mut i64) -> codex_schema::RequestId {
    let id = *next_id;
    *next_id += 1;
    codex_schema::RequestId::from(id)
}

fn send_json_line<T: Serialize>(stdin: &mut ChildStdin, payload: &T) -> Result<(), AgentError> {
    let line = serde_json::to_string(payload)
        .map_err(|err| AgentError::Io(io::Error::new(io::ErrorKind::Other, err)))?;
    writeln!(stdin, "{line}").map_err(AgentError::Io)?;
    stdin.flush().map_err(AgentError::Io)?;
    Ok(())
}

fn codex_thread_id_from_notification(
    notification: &codex_schema::ServerNotification,
) -> Option<String> {
    match notification {
        codex_schema::ServerNotification::ThreadStarted(params) => Some(params.thread.id.clone()),
        codex_schema::ServerNotification::TurnStarted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::TurnCompleted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemStarted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemCompleted(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemAgentMessageDelta(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemReasoningTextDelta(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemReasoningSummaryTextDelta(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemCommandExecutionOutputDelta(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemFileChangeOutputDelta(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemMcpToolCallProgress(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ThreadTokenUsageUpdated(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::TurnDiffUpdated(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::TurnPlanUpdated(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemCommandExecutionTerminalInteraction(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ItemReasoningSummaryPartAdded(params) => Some(params.thread_id.clone()),
        codex_schema::ServerNotification::ThreadCompacted(params) => Some(params.thread_id.clone()),
        _ => None,
    }
}

fn codex_thread_id_from_response(result: &Value) -> Option<String> {
    if let Some(id) = result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
    {
        return Some(id.to_string());
    }
    if let Some(id) = result.get("threadId").and_then(Value::as_str) {
        return Some(id.to_string());
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

fn extract_session_id(agent: AgentId, events: &[Value]) -> Option<String> {
    for event in events {
        match agent {
            AgentId::Claude | AgentId::Amp => {
                if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
        AgentId::Codex => {
            if let Ok(notification) =
                serde_json::from_value::<codex_schema::ServerNotification>(event.clone())
            {
                match notification {
                    codex_schema::ServerNotification::ThreadStarted(params) => {
                        return Some(params.thread.id);
                    }
                    codex_schema::ServerNotification::TurnStarted(params) => {
                        return Some(params.thread_id);
                    }
                    codex_schema::ServerNotification::TurnCompleted(params) => {
                        return Some(params.thread_id);
                    }
                    codex_schema::ServerNotification::ItemStarted(params) => {
                        return Some(params.thread_id);
                    }
                    codex_schema::ServerNotification::ItemCompleted(params) => {
                        return Some(params.thread_id);
                    }
                    _ => {}
                }
            }
            if let Some(id) = event.get("thread_id").and_then(Value::as_str) {
                return Some(id.to_string());
            }
            if let Some(id) = event.get("threadId").and_then(Value::as_str) {
                return Some(id.to_string());
            }
        }
            AgentId::Opencode => {
                if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                    return Some(id.to_string());
                }
                if let Some(id) = event.get("sessionID").and_then(Value::as_str) {
                    return Some(id.to_string());
                }
                if let Some(id) = event.get("sessionId").and_then(Value::as_str) {
                    return Some(id.to_string());
                }
                if let Some(id) = extract_nested_string(event, &["properties", "sessionID"]) {
                    return Some(id);
                }
                if let Some(id) = extract_nested_string(event, &["properties", "part", "sessionID"]) {
                    return Some(id);
                }
                if let Some(id) = extract_nested_string(event, &["session", "id"]) {
                    return Some(id);
                }
                if let Some(id) = extract_nested_string(event, &["properties", "session", "id"]) {
                    return Some(id);
                }
            }
            AgentId::Mock => {}
        }
    }
    None
}

fn extract_result_text(agent: AgentId, events: &[Value]) -> Option<String> {
    match agent {
        AgentId::Claude | AgentId::Amp => {
            for event in events {
                if let Some(result) = event.get("result").and_then(Value::as_str) {
                    return Some(result.to_string());
                }
                if let Some(text) = extract_nested_string(event, &["message", "content", "0", "text"]) {
                    return Some(text);
                }
            }
            None
        }
        AgentId::Codex => {
            let mut last = None;
            for event in events {
                if let Ok(notification) =
                    serde_json::from_value::<codex_schema::ServerNotification>(event.clone())
                {
                    match notification {
                        codex_schema::ServerNotification::ItemCompleted(params) => {
                            if let codex_schema::ThreadItem::AgentMessage { text, .. } = params.item
                            {
                                last = Some(text);
                            }
                        }
                        codex_schema::ServerNotification::TurnCompleted(params) => {
                            for item in params.turn.items.iter().rev() {
                                if let codex_schema::ThreadItem::AgentMessage { text, .. } = item {
                                    last = Some(text.clone());
                                    break;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(result) = event.get("result").and_then(Value::as_str) {
                    last = Some(result.to_string());
                }
                if let Some(output) = event.get("output").and_then(Value::as_str) {
                    last = Some(output.to_string());
                }
                if let Some(message) = event.get("message").and_then(Value::as_str) {
                    last = Some(message.to_string());
                }
            }
            last
        }
        AgentId::Opencode => {
            let mut buffer = String::new();
            for event in events {
                if event.get("type").and_then(Value::as_str) == Some("message.part.updated") {
                    if let Some(delta) = extract_nested_string(event, &["properties", "delta"]) {
                        buffer.push_str(&delta);
                    }
                    if let Some(content) = extract_nested_string(event, &["properties", "part", "content"]) {
                        buffer.push_str(&content);
                    }
                }
                if let Some(result) = event.get("result").and_then(Value::as_str) {
                    if buffer.is_empty() {
                        buffer.push_str(result);
                    }
                }
            }
            if buffer.is_empty() {
                None
            } else {
                Some(buffer)
            }
        }
        AgentId::Mock => None,
    }
}

fn spawn_amp(
    path: &Path,
    working_dir: &Path,
    options: &SpawnOptions,
) -> Result<std::process::Output, AgentError> {
    let flags = detect_amp_flags(path, working_dir).unwrap_or_default();
    let mut args: Vec<&str> = Vec::new();
    if flags.execute {
        args.push("--execute");
    } else if flags.print {
        args.push("--print");
    }
    if flags.output_format {
        args.push("--output-format");
        args.push("stream-json");
    }
    if flags.dangerously_skip_permissions && options.permission_mode.as_deref() == Some("bypass") {
        args.push("--dangerously-skip-permissions");
    }

    let mut command = Command::new(path);
    command.current_dir(working_dir);
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(session_id) = options.session_id.as_deref() {
        command.arg("--continue").arg(session_id);
    }
    command.args(&args).arg(&options.prompt);
    for (key, value) in &options.env {
        command.env(key, value);
    }
    let output = command.output().map_err(AgentError::Io)?;
    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("unknown option")
        || stderr.contains("unknown flag")
        || stderr.contains("User message must be provided")
    {
        return spawn_amp_fallback(path, working_dir, options);
    }

    Ok(output)
}

fn build_amp_command(path: &Path, working_dir: &Path, options: &SpawnOptions) -> Command {
    let flags = detect_amp_flags(path, working_dir).unwrap_or_default();
    let mut command = Command::new(path);
    command.current_dir(working_dir);
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(session_id) = options.session_id.as_deref() {
        command.arg("--continue").arg(session_id);
    }
    if flags.execute {
        command.arg("--execute");
    } else if flags.print {
        command.arg("--print");
    }
    if flags.output_format {
        command.arg("--output-format").arg("stream-json");
    }
    if flags.dangerously_skip_permissions && options.permission_mode.as_deref() == Some("bypass") {
        command.arg("--dangerously-skip-permissions");
    }
    command.arg(&options.prompt);
    for (key, value) in &options.env {
        command.env(key, value);
    }
    command
}

#[derive(Debug, Default, Clone, Copy)]
struct AmpFlags {
    execute: bool,
    print: bool,
    output_format: bool,
    dangerously_skip_permissions: bool,
}

fn detect_amp_flags(path: &Path, working_dir: &Path) -> Option<AmpFlags> {
    let output = Command::new(path)
        .current_dir(working_dir)
        .arg("--help")
        .output()
        .ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Some(AmpFlags {
        execute: text.contains("--execute"),
        print: text.contains("--print"),
        output_format: text.contains("--output-format"),
        dangerously_skip_permissions: text.contains("--dangerously-skip-permissions"),
    })
}

fn spawn_amp_fallback(
    path: &Path,
    working_dir: &Path,
    options: &SpawnOptions,
) -> Result<std::process::Output, AgentError> {
    let mut attempts = vec![
        vec!["--execute"],
        vec!["--print", "--output-format", "stream-json"],
        vec!["--output-format", "stream-json"],
        vec!["--dangerously-skip-permissions"],
        vec![],
    ];
    if options.permission_mode.as_deref() != Some("bypass") {
        attempts.retain(|args| !args.contains(&"--dangerously-skip-permissions"));
    }

    for args in attempts {
        let mut command = Command::new(path);
        command.current_dir(working_dir);
        if let Some(model) = options.model.as_deref() {
            command.arg("--model").arg(model);
        }
        if let Some(session_id) = options.session_id.as_deref() {
            command.arg("--continue").arg(session_id);
        }
        if !args.is_empty() {
            command.args(&args);
        }
        command.arg(&options.prompt);
        for (key, value) in &options.env {
            command.env(key, value);
        }
        let output = command.output().map_err(AgentError::Io)?;
        if output.status.success() {
            return Ok(output);
        }
    }

    let mut command = Command::new(path);
    command.current_dir(working_dir);
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(session_id) = options.session_id.as_deref() {
        command.arg("--continue").arg(session_id);
    }
    command.arg(&options.prompt);
    for (key, value) in &options.env {
        command.env(key, value);
    }
    Ok(command.output().map_err(AgentError::Io)?)
}

fn find_in_path(binary_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_var) {
        let candidate = path.join(binary_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn default_install_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("bin"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("bin"))
}

fn download_bytes(url: &Url) -> Result<Vec<u8>, AgentError> {
    let client = Client::builder().build()?;
    let mut response = client.get(url.clone()).send()?;
    if !response.status().is_success() {
        return Err(AgentError::DownloadFailed { url: url.clone() });
    }
    let mut bytes = Vec::new();
    response.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn install_claude(path: &Path, platform: Platform, version: Option<&str>) -> Result<(), AgentError> {
    let version = match version {
        Some(version) => version.to_string(),
        None => {
            let url = Url::parse(
                "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest",
            )?;
            let text = String::from_utf8(download_bytes(&url)?).map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
            text.trim().to_string()
        }
    };

    let platform_segment = match platform {
        Platform::LinuxX64 => "linux-x64",
        Platform::LinuxX64Musl => "linux-x64-musl",
        Platform::LinuxArm64 => "linux-arm64",
        Platform::MacosArm64 => "darwin-arm64",
        Platform::MacosX64 => "darwin-x64",
    };

    let url = Url::parse(&format!(
        "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{version}/{platform_segment}/claude"
    ))?;
    let bytes = download_bytes(&url)?;
    write_executable(path, &bytes)?;
    Ok(())
}

fn install_amp(path: &Path, platform: Platform, version: Option<&str>) -> Result<(), AgentError> {
    let version = match version {
        Some(version) => version.to_string(),
        None => {
            let url = Url::parse("https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt")?;
            let text = String::from_utf8(download_bytes(&url)?).map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
            text.trim().to_string()
        }
    };

    let platform_segment = match platform {
        Platform::LinuxX64 | Platform::LinuxX64Musl => "linux-x64",
        Platform::LinuxArm64 => "linux-arm64",
        Platform::MacosArm64 => "darwin-arm64",
        Platform::MacosX64 => "darwin-x64",
    };

    let url = Url::parse(&format!(
        "https://storage.googleapis.com/amp-public-assets-prod-0/cli/{version}/amp-{platform_segment}"
    ))?;
    let bytes = download_bytes(&url)?;
    write_executable(path, &bytes)?;
    Ok(())
}

fn install_codex(path: &Path, platform: Platform, version: Option<&str>) -> Result<(), AgentError> {
    let target = match platform {
        Platform::LinuxX64 | Platform::LinuxX64Musl => "x86_64-unknown-linux-musl",
        Platform::LinuxArm64 => "aarch64-unknown-linux-musl",
        Platform::MacosArm64 => "aarch64-apple-darwin",
        Platform::MacosX64 => "x86_64-apple-darwin",
    };

    let url = match version {
        Some(version) => Url::parse(&format!(
            "https://github.com/openai/codex/releases/download/{version}/codex-{target}.tar.gz"
        ))?,
        None => Url::parse(&format!(
            "https://github.com/openai/codex/releases/latest/download/codex-{target}.tar.gz"
        ))?,
    };

    let bytes = download_bytes(&url)?;
    let temp_dir = tempfile::tempdir()?;
    let cursor = io::Cursor::new(bytes);
    let mut archive = tar::Archive::new(GzDecoder::new(cursor));
    archive.unpack(temp_dir.path())?;

    let expected = format!("codex-{target}");
    let binary = find_file_recursive(temp_dir.path(), &expected)?
        .ok_or_else(|| AgentError::ExtractFailed(format!("missing {expected}")))?;
    move_executable(&binary, path)?;
    Ok(())
}

fn install_opencode(path: &Path, platform: Platform, version: Option<&str>) -> Result<(), AgentError> {
    match platform {
        Platform::MacosArm64 => {
            let url = match version {
                Some(version) => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/download/{version}/opencode-darwin-arm64.zip"
                ))?,
                None => Url::parse(
                    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-arm64.zip",
                )?,
            };
            install_zip_binary(path, &url, "opencode")
        }
        Platform::MacosX64 => {
            let url = match version {
                Some(version) => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/download/{version}/opencode-darwin-x64.zip"
                ))?,
                None => Url::parse(
                    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-x64.zip",
                )?,
            };
            install_zip_binary(path, &url, "opencode")
        }
        _ => {
            let platform_segment = match platform {
                Platform::LinuxX64 => "linux-x64",
                Platform::LinuxX64Musl => "linux-x64-musl",
                Platform::LinuxArm64 => "linux-arm64",
                Platform::MacosArm64 | Platform::MacosX64 => unreachable!(),
            };
            let url = match version {
                Some(version) => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/download/{version}/opencode-{platform_segment}.tar.gz"
                ))?,
                None => Url::parse(&format!(
                    "https://github.com/anomalyco/opencode/releases/latest/download/opencode-{platform_segment}.tar.gz"
                ))?,
            };

            let bytes = download_bytes(&url)?;
            let temp_dir = tempfile::tempdir()?;
            let cursor = io::Cursor::new(bytes);
            let mut archive = tar::Archive::new(GzDecoder::new(cursor));
            archive.unpack(temp_dir.path())?;
            let binary = find_file_recursive(temp_dir.path(), "opencode")?
                .ok_or_else(|| AgentError::ExtractFailed("missing opencode".to_string()))?;
            move_executable(&binary, path)?;
            Ok(())
        }
    }
}

fn install_zip_binary(path: &Path, url: &Url, binary_name: &str) -> Result<(), AgentError> {
    let bytes = download_bytes(url)?;
    let reader = io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
    let temp_dir = tempfile::tempdir()?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|err| AgentError::ExtractFailed(err.to_string()))?;
        if !file.name().ends_with(binary_name) {
            continue;
        }
        let out_path = temp_dir.path().join(binary_name);
        let mut out_file = fs::File::create(&out_path)?;
        io::copy(&mut file, &mut out_file)?;
        move_executable(&out_path, path)?;
        return Ok(());
    }
    Err(AgentError::ExtractFailed(format!("missing {binary_name}")))
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), AgentError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    set_executable(path)?;
    Ok(())
}

fn move_executable(source: &Path, dest: &Path) -> Result<(), AgentError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    if dest.exists() {
        fs::remove_file(dest)?;
    }
    fs::copy(source, dest)?;
    set_executable(dest)?;
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), AgentError> {
    Ok(())
}

fn find_file_recursive(dir: &Path, filename: &str) -> Result<Option<PathBuf>, AgentError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, filename)? {
                return Ok(Some(found));
            }
        } else if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name == filename {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}
