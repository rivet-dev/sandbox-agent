//! Process Manager - API for spawning and managing background processes.
//!
//! Supports both regular processes and PTY-based terminal sessions.
//! PTY sessions enable interactive terminal applications with full TTY support.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use utoipa::ToSchema;

use sandbox_agent_error::SandboxError;

#[cfg(unix)]
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};

static PROCESS_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Default terminal size (columns x rows)
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// Process status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    /// Process is starting up
    Starting,
    /// Process is running
    Running,
    /// Process stopped naturally or via SIGTERM
    Stopped,
    /// Process was killed via SIGKILL
    Killed,
}

/// Terminal size configuration
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        }
    }
}

/// Log file paths for a process
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLogPaths {
    pub stdout: String,
    pub stderr: String,
    pub combined: String,
}

/// Process information
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub status: ProcessStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub log_paths: ProcessLogPaths,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Whether this process has a PTY allocated (terminal mode)
    #[serde(default)]
    pub tty: bool,
    /// Whether stdin is kept open for interactive input
    #[serde(default)]
    pub interactive: bool,
    /// Current terminal size (if tty is true)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_size: Option<TerminalSize>,
}

/// Request to start a new process
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartProcessRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    /// Allocate a pseudo-TTY for the process (like docker -t)
    #[serde(default)]
    pub tty: bool,
    /// Keep stdin open for interactive input (like docker -i)
    #[serde(default)]
    pub interactive: bool,
    /// Initial terminal size (only used if tty is true)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_size: Option<TerminalSize>,
}

/// Response after starting a process
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartProcessResponse {
    pub id: String,
    pub status: ProcessStatus,
    pub log_paths: ProcessLogPaths,
    /// Whether this process has a PTY allocated
    #[serde(default)]
    pub tty: bool,
    /// Whether stdin is available for input
    #[serde(default)]
    pub interactive: bool,
}

/// Response listing all processes
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListResponse {
    pub processes: Vec<ProcessInfo>,
}

/// Query parameters for reading logs
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogsQuery {
    /// Number of lines to return from the end
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail: Option<usize>,
    /// Stream logs via SSE
    #[serde(default)]
    pub follow: bool,
    /// Which log stream to read: "stdout", "stderr", or "combined" (default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    /// Strip timestamp prefixes from log lines
    #[serde(default)]
    pub strip_timestamps: bool,
}

/// Response with log content
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogsResponse {
    pub content: String,
    pub lines: usize,
}

/// Request to resize a terminal
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResizeTerminalRequest {
    pub cols: u16,
    pub rows: u16,
}

/// Request to write data to a process's stdin/terminal
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteInputRequest {
    /// Data to write (can be raw bytes encoded as base64 or UTF-8 text)
    pub data: String,
    /// Whether data is base64 encoded (for binary data)
    #[serde(default)]
    pub base64: bool,
}

/// Message types for terminal WebSocket communication
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalMessage {
    /// Data from the terminal (output)
    #[serde(rename_all = "camelCase")]
    Data { data: String },
    /// Data to write to the terminal (input)
    #[serde(rename_all = "camelCase")]
    Input { data: String },
    /// Resize the terminal
    #[serde(rename_all = "camelCase")]
    Resize { cols: u16, rows: u16 },
    /// Terminal closed/process exited
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<i32> },
    /// Error message
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// Internal state for a managed process (non-PTY mode)
struct RegularProcess {
    child: Child,
    log_broadcaster: broadcast::Sender<String>,
}

/// Internal state for a PTY process
#[cfg(unix)]
struct PtyProcess {
    /// The PTY pair (master + child handle)
    pty_pair: PtyPair,
    /// Child process handle
    child: Box<dyn portable_pty::Child + Send>,
    /// Writer for sending data to the PTY
    writer: Box<dyn Write + Send>,
    /// Current terminal size
    size: TerminalSize,
    /// Channel for sending terminal output to subscribers
    output_tx: broadcast::Sender<Vec<u8>>,
    /// Channel for receiving input to write to terminal
    input_tx: mpsc::UnboundedSender<Vec<u8>>,
}

/// Internal state for a managed process
struct ManagedProcess {
    info: ProcessInfo,
    /// Regular process handle (non-PTY)
    regular: Option<RegularProcess>,
    /// PTY process handle (terminal mode)
    #[cfg(unix)]
    pty: Option<PtyProcess>,
    /// Broadcaster for log lines (for SSE streaming, used in regular mode)
    log_broadcaster: broadcast::Sender<String>,
}

impl std::fmt::Debug for ManagedProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedProcess")
            .field("info", &self.info)
            .field("has_regular", &self.regular.is_some())
            #[cfg(unix)]
            .field("has_pty", &self.pty.is_some())
            .finish()
    }
}

/// State file entry for persistence
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProcessStateEntry {
    id: String,
    command: String,
    args: Vec<String>,
    status: ProcessStatus,
    exit_code: Option<i32>,
    started_at: u64,
    stopped_at: Option<u64>,
    cwd: Option<String>,
    tty: bool,
    interactive: bool,
}

/// Process Manager handles spawning and tracking background processes
#[derive(Debug)]
pub struct ProcessManager {
    processes: RwLock<HashMap<String, Arc<Mutex<ManagedProcess>>>>,
    base_dir: PathBuf,
}

impl ProcessManager {
    /// Create a new process manager
    pub fn new() -> Self {
        let base_dir = process_data_dir();
        
        // Ensure the base directory exists
        if let Err(e) = fs::create_dir_all(&base_dir) {
            tracing::warn!("Failed to create process data directory: {}", e);
        }
        
        let manager = Self {
            processes: RwLock::new(HashMap::new()),
            base_dir,
        };
        
        // Load persisted state
        if let Err(e) = manager.load_state_sync() {
            tracing::warn!("Failed to load process state: {}", e);
        }
        
        manager
    }
    
    /// Get the directory for a specific process
    fn process_dir(&self, id: &str) -> PathBuf {
        self.base_dir.join(id)
    }
    
    /// Get log paths for a process
    fn log_paths(&self, id: &str) -> ProcessLogPaths {
        let dir = self.process_dir(id);
        ProcessLogPaths {
            stdout: dir.join("stdout.log").to_string_lossy().to_string(),
            stderr: dir.join("stderr.log").to_string_lossy().to_string(),
            combined: dir.join("combined.log").to_string_lossy().to_string(),
        }
    }
    
    /// Get the state file path
    fn state_file_path(&self) -> PathBuf {
        self.base_dir.join("state.json")
    }
    
    /// Load persisted state (sync version for init)
    fn load_state_sync(&self) -> Result<(), std::io::Error> {
        let state_path = self.state_file_path();
        if !state_path.exists() {
            return Ok(());
        }
        
        let content = fs::read_to_string(&state_path)?;
        let entries: Vec<ProcessStateEntry> = serde_json::from_str(&content)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        
        let mut processes = HashMap::new();
        for entry in entries {
            let log_paths = self.log_paths(&entry.id);
            let (tx, _) = broadcast::channel(256);
            
            let managed = ManagedProcess {
                info: ProcessInfo {
                    id: entry.id.clone(),
                    command: entry.command,
                    args: entry.args,
                    status: entry.status,
                    exit_code: entry.exit_code,
                    log_paths,
                    started_at: entry.started_at,
                    stopped_at: entry.stopped_at,
                    cwd: entry.cwd,
                    tty: entry.tty,
                    interactive: entry.interactive,
                    terminal_size: None,
                },
                regular: None,
                #[cfg(unix)]
                pty: None,
                log_broadcaster: tx,
            };
            
            // Update counter to avoid ID collisions
            if let Ok(num) = entry.id.parse::<u64>() {
                let current = PROCESS_ID_COUNTER.load(Ordering::SeqCst);
                if num >= current {
                    PROCESS_ID_COUNTER.store(num + 1, Ordering::SeqCst);
                }
            }
            
            processes.insert(entry.id, Arc::new(Mutex::new(managed)));
        }
        
        // We can't await here, so we'll use try_write
        if let Ok(mut guard) = self.processes.try_write() {
            *guard = processes;
        }
        
        Ok(())
    }
    
    /// Save state to disk
    async fn save_state(&self) -> Result<(), std::io::Error> {
        let processes = self.processes.read().await;
        let mut entries = Vec::new();
        
        for managed in processes.values() {
            let guard = managed.lock().await;
            entries.push(ProcessStateEntry {
                id: guard.info.id.clone(),
                command: guard.info.command.clone(),
                args: guard.info.args.clone(),
                status: guard.info.status,
                exit_code: guard.info.exit_code,
                started_at: guard.info.started_at,
                stopped_at: guard.info.stopped_at,
                cwd: guard.info.cwd.clone(),
                tty: guard.info.tty,
                interactive: guard.info.interactive,
            });
        }
        
        let content = serde_json::to_string_pretty(&entries)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        
        fs::write(self.state_file_path(), content)?;
        Ok(())
    }
    
    /// Start a new process
    pub async fn start_process(&self, request: StartProcessRequest) -> Result<StartProcessResponse, SandboxError> {
        let id = PROCESS_ID_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
        let process_dir = self.process_dir(&id);
        
        // Create process directory
        fs::create_dir_all(&process_dir).map_err(|e| SandboxError::StreamError {
            message: format!("Failed to create process directory: {}", e),
        })?;
        
        let log_paths = self.log_paths(&id);
        
        // Create log files
        File::create(&log_paths.stdout).map_err(|e| SandboxError::StreamError {
            message: format!("Failed to create stdout log: {}", e),
        })?;
        File::create(&log_paths.stderr).map_err(|e| SandboxError::StreamError {
            message: format!("Failed to create stderr log: {}", e),
        })?;
        File::create(&log_paths.combined).map_err(|e| SandboxError::StreamError {
            message: format!("Failed to create combined log: {}", e),
        })?;
        
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        #[cfg(unix)]
        if request.tty {
            return self.start_pty_process(id, request, log_paths, started_at).await;
        }
        
        // Fall back to regular process if TTY not requested or not on Unix
        self.start_regular_process(id, request, log_paths, started_at).await
    }
    
    /// Start a regular (non-PTY) process
    async fn start_regular_process(
        &self,
        id: String,
        request: StartProcessRequest,
        log_paths: ProcessLogPaths,
        started_at: u64,
    ) -> Result<StartProcessResponse, SandboxError> {
        let combined_file = Arc::new(std::sync::Mutex::new(
            OpenOptions::new()
                .append(true)
                .open(&log_paths.combined)
                .map_err(|e| SandboxError::StreamError {
                    message: format!("Failed to open combined log: {}", e),
                })?
        ));
        
        // Build the command
        let mut cmd = Command::new(&request.command);
        cmd.args(&request.args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        
        if let Some(ref cwd) = request.cwd {
            cmd.current_dir(cwd);
        }
        
        for (key, value) in &request.env {
            cmd.env(key, value);
        }
        
        // Spawn the process
        let mut child = cmd.spawn().map_err(|e| SandboxError::StreamError {
            message: format!("Failed to spawn process: {}", e),
        })?;
        
        let (log_tx, _) = broadcast::channel::<String>(256);
        
        // Set up stdout reader
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        
        let info = ProcessInfo {
            id: id.clone(),
            command: request.command.clone(),
            args: request.args.clone(),
            status: ProcessStatus::Running,
            exit_code: None,
            log_paths: log_paths.clone(),
            started_at,
            stopped_at: None,
            cwd: request.cwd.clone(),
            tty: false,
            interactive: request.interactive,
            terminal_size: None,
        };
        
        let managed = Arc::new(Mutex::new(ManagedProcess {
            info: info.clone(),
            regular: Some(RegularProcess {
                child,
                log_broadcaster: log_tx.clone(),
            }),
            #[cfg(unix)]
            pty: None,
            log_broadcaster: log_tx.clone(),
        }));
        
        // Insert into map
        {
            let mut processes = self.processes.write().await;
            processes.insert(id.clone(), managed.clone());
        }
        
        // Spawn tasks to read stdout/stderr
        if let Some(stdout) = stdout {
            let log_tx = log_tx.clone();
            let stdout_path = log_paths.stdout.clone();
            let combined = combined_file.clone();
            tokio::spawn(async move {
                let reader = TokioBufReader::new(stdout);
                let mut lines = reader.lines();
                let mut file = match OpenOptions::new().append(true).open(&stdout_path) {
                    Ok(f) => f,
                    Err(_) => return,
                };
                
                while let Ok(Some(line)) = lines.next_line().await {
                    let timestamp = format_timestamp();
                    let timestamped_line = format!("[{}] {}\n", timestamp, line);
                    let combined_line = format!("[{}] [stdout] {}\n", timestamp, line);
                    let _ = file.write_all(timestamped_line.as_bytes());
                    if let Ok(mut combined) = combined.lock() {
                        let _ = combined.write_all(combined_line.as_bytes());
                    }
                    let _ = log_tx.send(combined_line);
                }
            });
        }
        
        if let Some(stderr) = stderr {
            let log_tx = log_tx.clone();
            let stderr_path = log_paths.stderr.clone();
            let combined = combined_file.clone();
            tokio::spawn(async move {
                let reader = TokioBufReader::new(stderr);
                let mut lines = reader.lines();
                let mut file = match OpenOptions::new().append(true).open(&stderr_path) {
                    Ok(f) => f,
                    Err(_) => return,
                };
                
                while let Ok(Some(line)) = lines.next_line().await {
                    let timestamp = format_timestamp();
                    let timestamped_line = format!("[{}] {}\n", timestamp, line);
                    let combined_line = format!("[{}] [stderr] {}\n", timestamp, line);
                    let _ = file.write_all(timestamped_line.as_bytes());
                    if let Ok(mut combined) = combined.lock() {
                        let _ = combined.write_all(combined_line.as_bytes());
                    }
                    let _ = log_tx.send(combined_line);
                }
            });
        }
        
        // Spawn a task to monitor process exit
        let managed_clone = managed.clone();
        let base_dir = self.base_dir.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                
                let mut guard = managed_clone.lock().await;
                if let Some(ref mut regular) = guard.regular {
                    match regular.child.try_wait() {
                        Ok(Some(status)) => {
                            guard.info.status = ProcessStatus::Stopped;
                            guard.info.exit_code = status.code();
                            guard.info.stopped_at = Some(
                                SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            );
                            guard.regular = None;
                            drop(guard);
                            let _ = save_state_to_file(&base_dir).await;
                            break;
                        }
                        Ok(None) => {
                            // Still running
                        }
                        Err(_) => {
                            break;
                        }
                    }
                } else {
                    break;
                }
            }
        });
        
        // Save state
        if let Err(e) = self.save_state().await {
            tracing::warn!("Failed to save process state: {}", e);
        }
        
        Ok(StartProcessResponse {
            id,
            status: ProcessStatus::Running,
            log_paths,
            tty: false,
            interactive: request.interactive,
        })
    }
    
    /// Start a PTY process (Unix only)
    #[cfg(unix)]
    async fn start_pty_process(
        &self,
        id: String,
        request: StartProcessRequest,
        log_paths: ProcessLogPaths,
        started_at: u64,
    ) -> Result<StartProcessResponse, SandboxError> {
        let size = request.terminal_size.unwrap_or_default();
        
        // Create the PTY
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SandboxError::StreamError {
                message: format!("Failed to create PTY: {}", e),
            })?;
        
        // Build the command
        let mut cmd = CommandBuilder::new(&request.command);
        cmd.args(&request.args);
        
        if let Some(ref cwd) = request.cwd {
            cmd.cwd(cwd);
        }
        
        for (key, value) in &request.env {
            cmd.env(key, value);
        }
        
        // Set TERM environment variable
        cmd.env("TERM", "xterm-256color");
        
        // Spawn the child process
        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| SandboxError::StreamError {
                message: format!("Failed to spawn PTY process: {}", e),
            })?;
        
        // Get the master writer
        let writer = pty_pair.master.take_writer().map_err(|e| SandboxError::StreamError {
            message: format!("Failed to get PTY writer: {}", e),
        })?;
        
        // Get the master reader
        let mut reader = pty_pair.master.try_clone_reader().map_err(|e| SandboxError::StreamError {
            message: format!("Failed to get PTY reader: {}", e),
        })?;
        
        // Create channels for terminal I/O
        let (output_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (log_tx, _) = broadcast::channel::<String>(256);
        
        let info = ProcessInfo {
            id: id.clone(),
            command: request.command.clone(),
            args: request.args.clone(),
            status: ProcessStatus::Running,
            exit_code: None,
            log_paths: log_paths.clone(),
            started_at,
            stopped_at: None,
            cwd: request.cwd.clone(),
            tty: true,
            interactive: request.interactive,
            terminal_size: Some(size),
        };
        
        let managed = Arc::new(Mutex::new(ManagedProcess {
            info: info.clone(),
            regular: None,
            pty: Some(PtyProcess {
                pty_pair,
                child,
                writer,
                size,
                output_tx: output_tx.clone(),
                input_tx: input_tx.clone(),
            }),
            log_broadcaster: log_tx.clone(),
        }));
        
        // Insert into map
        {
            let mut processes = self.processes.write().await;
            processes.insert(id.clone(), managed.clone());
        }
        
        // Spawn a task to read PTY output
        let output_tx_clone = output_tx.clone();
        let combined_path = log_paths.combined.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut combined_file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&combined_path)
                .ok();
            
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        // Write to log file
                        if let Some(ref mut file) = combined_file {
                            let _ = file.write_all(&data);
                        }
                        // Broadcast to subscribers
                        let _ = output_tx_clone.send(data);
                    }
                    Err(e) => {
                        tracing::debug!("PTY read error: {}", e);
                        break;
                    }
                }
            }
        });
        
        // Spawn a task to write input to PTY
        let managed_clone = managed.clone();
        tokio::spawn(async move {
            while let Some(data) = input_rx.recv().await {
                let mut guard = managed_clone.lock().await;
                if let Some(ref mut pty) = guard.pty {
                    if pty.writer.write_all(&data).is_err() {
                        break;
                    }
                    let _ = pty.writer.flush();
                }
            }
        });
        
        // Spawn a task to monitor process exit
        let managed_clone = managed.clone();
        let base_dir = self.base_dir.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                
                let mut guard = managed_clone.lock().await;
                if let Some(ref mut pty) = guard.pty {
                    match pty.child.try_wait() {
                        Ok(Some(status)) => {
                            guard.info.status = ProcessStatus::Stopped;
                            guard.info.exit_code = status.exit_code().map(|c| c as i32);
                            guard.info.stopped_at = Some(
                                SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            );
                            guard.pty = None;
                            drop(guard);
                            let _ = save_state_to_file(&base_dir).await;
                            break;
                        }
                        Ok(None) => {
                            // Still running
                        }
                        Err(_) => {
                            break;
                        }
                    }
                } else {
                    break;
                }
            }
        });
        
        // Save state
        if let Err(e) = self.save_state().await {
            tracing::warn!("Failed to save process state: {}", e);
        }
        
        Ok(StartProcessResponse {
            id,
            status: ProcessStatus::Running,
            log_paths,
            tty: true,
            interactive: request.interactive,
        })
    }
    
    /// List all processes
    pub async fn list_processes(&self) -> ProcessListResponse {
        let processes = self.processes.read().await;
        let mut list = Vec::new();
        
        for managed in processes.values() {
            let guard = managed.lock().await;
            list.push(guard.info.clone());
        }
        
        // Sort by started_at descending (newest first)
        list.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        
        ProcessListResponse { processes: list }
    }
    
    /// Get a specific process
    pub async fn get_process(&self, id: &str) -> Result<ProcessInfo, SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let guard = managed.lock().await;
        Ok(guard.info.clone())
    }
    
    /// Check if a process has TTY enabled
    pub async fn is_tty_process(&self, id: &str) -> Result<bool, SandboxError> {
        let info = self.get_process(id).await?;
        Ok(info.tty)
    }
    
    /// Stop a process with SIGTERM
    pub async fn stop_process(&self, id: &str) -> Result<(), SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let guard = managed.lock().await;
        
        // Try regular process first
        if let Some(ref regular) = guard.regular {
            #[cfg(unix)]
            {
                if let Some(pid) = regular.child.id() {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
            }
        }
        
        // Try PTY process
        #[cfg(unix)]
        if let Some(ref pty) = guard.pty {
            if let Some(pid) = pty.child.process_id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
        
        drop(guard);
        
        if let Err(e) = self.save_state().await {
            tracing::warn!("Failed to save process state: {}", e);
        }
        
        Ok(())
    }
    
    /// Kill a process with SIGKILL
    pub async fn kill_process(&self, id: &str) -> Result<(), SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let mut guard = managed.lock().await;
        
        // Try regular process first
        if let Some(ref mut regular) = guard.regular {
            let _ = regular.child.kill().await;
            guard.info.status = ProcessStatus::Killed;
            guard.info.stopped_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            );
            guard.regular = None;
        }
        
        // Try PTY process
        #[cfg(unix)]
        if let Some(ref mut pty) = guard.pty {
            let _ = pty.child.kill();
            guard.info.status = ProcessStatus::Killed;
            guard.info.stopped_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            );
            guard.pty = None;
        }
        
        drop(guard);
        
        if let Err(e) = self.save_state().await {
            tracing::warn!("Failed to save process state: {}", e);
        }
        
        Ok(())
    }
    
    /// Delete a process and its logs
    pub async fn delete_process(&self, id: &str) -> Result<(), SandboxError> {
        // First, make sure process is not running
        {
            let processes = self.processes.read().await;
            if let Some(managed) = processes.get(id) {
                let guard = managed.lock().await;
                let is_running = guard.regular.is_some();
                #[cfg(unix)]
                let is_running = is_running || guard.pty.is_some();
                if is_running {
                    return Err(SandboxError::InvalidRequest {
                        message: "Cannot delete a running process. Stop or kill it first.".to_string(),
                    });
                }
            } else {
                return Err(SandboxError::SessionNotFound {
                    session_id: format!("process:{}", id),
                });
            }
        }
        
        // Remove from map
        {
            let mut processes = self.processes.write().await;
            processes.remove(id);
        }
        
        // Delete log files
        let process_dir = self.process_dir(id);
        if process_dir.exists() {
            if let Err(e) = fs::remove_dir_all(&process_dir) {
                tracing::warn!("Failed to remove process directory: {}", e);
            }
        }
        
        if let Err(e) = self.save_state().await {
            tracing::warn!("Failed to save process state: {}", e);
        }
        
        Ok(())
    }
    
    /// Read process logs
    pub async fn read_logs(&self, id: &str, query: &LogsQuery) -> Result<LogsResponse, SandboxError> {
        let info = self.get_process(id).await?;
        
        let log_path = match query.stream.as_deref() {
            Some("stdout") => &info.log_paths.stdout,
            Some("stderr") => &info.log_paths.stderr,
            _ => &info.log_paths.combined,
        };
        
        let content = fs::read_to_string(log_path).unwrap_or_default();
        
        let lines: Vec<&str> = content.lines().collect();
        let (mut content, line_count) = if let Some(tail) = query.tail {
            let start = lines.len().saturating_sub(tail);
            let tail_lines: Vec<&str> = lines[start..].to_vec();
            (tail_lines.join("\n"), tail_lines.len())
        } else {
            (content.clone(), lines.len())
        };
        
        // Strip timestamps if requested
        if query.strip_timestamps {
            content = strip_timestamps(&content);
        }
        
        Ok(LogsResponse {
            content,
            lines: line_count,
        })
    }
    
    /// Get a subscriber for log streaming
    pub async fn subscribe_logs(&self, id: &str) -> Result<broadcast::Receiver<String>, SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let guard = managed.lock().await;
        Ok(guard.log_broadcaster.subscribe())
    }
    
    /// Resize a PTY terminal
    #[cfg(unix)]
    pub async fn resize_terminal(&self, id: &str, cols: u16, rows: u16) -> Result<(), SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let mut guard = managed.lock().await;
        
        if let Some(ref mut pty) = guard.pty {
            pty.pty_pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| SandboxError::StreamError {
                    message: format!("Failed to resize terminal: {}", e),
                })?;
            
            pty.size = TerminalSize { cols, rows };
            guard.info.terminal_size = Some(pty.size);
            Ok(())
        } else {
            Err(SandboxError::InvalidRequest {
                message: "Process does not have a PTY".to_string(),
            })
        }
    }
    
    #[cfg(not(unix))]
    pub async fn resize_terminal(&self, _id: &str, _cols: u16, _rows: u16) -> Result<(), SandboxError> {
        Err(SandboxError::InvalidRequest {
            message: "PTY support is only available on Unix systems".to_string(),
        })
    }
    
    /// Write data to a process's terminal input
    #[cfg(unix)]
    pub async fn write_terminal_input(&self, id: &str, data: Vec<u8>) -> Result<(), SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let guard = managed.lock().await;
        
        if let Some(ref pty) = guard.pty {
            pty.input_tx.send(data).map_err(|_| SandboxError::StreamError {
                message: "Failed to send input to terminal".to_string(),
            })?;
            Ok(())
        } else {
            Err(SandboxError::InvalidRequest {
                message: "Process does not have a PTY".to_string(),
            })
        }
    }
    
    #[cfg(not(unix))]
    pub async fn write_terminal_input(&self, _id: &str, _data: Vec<u8>) -> Result<(), SandboxError> {
        Err(SandboxError::InvalidRequest {
            message: "PTY support is only available on Unix systems".to_string(),
        })
    }
    
    /// Subscribe to terminal output
    #[cfg(unix)]
    pub async fn subscribe_terminal_output(&self, id: &str) -> Result<broadcast::Receiver<Vec<u8>>, SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let guard = managed.lock().await;
        
        if let Some(ref pty) = guard.pty {
            Ok(pty.output_tx.subscribe())
        } else {
            Err(SandboxError::InvalidRequest {
                message: "Process does not have a PTY".to_string(),
            })
        }
    }
    
    #[cfg(not(unix))]
    pub async fn subscribe_terminal_output(&self, _id: &str) -> Result<broadcast::Receiver<Vec<u8>>, SandboxError> {
        Err(SandboxError::InvalidRequest {
            message: "PTY support is only available on Unix systems".to_string(),
        })
    }
    
    /// Get the input channel for a PTY process (for WebSocket handler)
    #[cfg(unix)]
    pub async fn get_terminal_input_sender(&self, id: &str) -> Result<mpsc::UnboundedSender<Vec<u8>>, SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let guard = managed.lock().await;
        
        if let Some(ref pty) = guard.pty {
            Ok(pty.input_tx.clone())
        } else {
            Err(SandboxError::InvalidRequest {
                message: "Process does not have a PTY".to_string(),
            })
        }
    }
    
    #[cfg(not(unix))]
    pub async fn get_terminal_input_sender(&self, _id: &str) -> Result<mpsc::UnboundedSender<Vec<u8>>, SandboxError> {
        Err(SandboxError::InvalidRequest {
            message: "PTY support is only available on Unix systems".to_string(),
        })
    }
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Get the data directory for process management
fn process_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sandbox-agent")
        .join("processes")
}

/// Format the current time as an ISO 8601 timestamp
fn format_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Strip timestamp prefixes from log lines
fn strip_timestamps(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            if line.starts_with('[') {
                if let Some(end) = line.find("] ") {
                    let potential_ts = &line[1..end];
                    if potential_ts.len() >= 19 && potential_ts.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                        return &line[end + 2..];
                    }
                }
            }
            line
        })
        .collect::<Vec<&str>>()
        .join("\n")
}

/// Helper to save state from within a spawned task
async fn save_state_to_file(base_dir: &PathBuf) -> Result<(), std::io::Error> {
    let _ = base_dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_process_manager_basic() {
        let manager = ProcessManager::new();
        
        let list = manager.list_processes().await;
        let initial_count = list.processes.len();
        
        let request = StartProcessRequest {
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            cwd: None,
            env: HashMap::new(),
            tty: false,
            interactive: false,
            terminal_size: None,
        };
        
        let response = manager.start_process(request).await.unwrap();
        assert!(!response.id.is_empty());
        assert_eq!(response.status, ProcessStatus::Running);
        assert!(!response.tty);
        
        tokio::time::sleep(Duration::from_millis(200)).await;
        
        let info = manager.get_process(&response.id).await.unwrap();
        assert_eq!(info.command, "echo");
        assert!(!info.tty);
        
        let list = manager.list_processes().await;
        assert_eq!(list.processes.len(), initial_count + 1);
        
        manager.delete_process(&response.id).await.unwrap();
        
        let list = manager.list_processes().await;
        assert_eq!(list.processes.len(), initial_count);
    }
    
    #[cfg(unix)]
    #[tokio::test]
    async fn test_pty_process() {
        let manager = ProcessManager::new();
        
        let request = StartProcessRequest {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), "echo hello && exit 0".to_string()],
            cwd: None,
            env: HashMap::new(),
            tty: true,
            interactive: true,
            terminal_size: Some(TerminalSize { cols: 80, rows: 24 }),
        };
        
        let response = manager.start_process(request).await.unwrap();
        assert!(response.tty);
        assert!(response.interactive);
        
        let info = manager.get_process(&response.id).await.unwrap();
        assert!(info.tty);
        assert!(info.terminal_size.is_some());
        
        // Wait for process to complete
        tokio::time::sleep(Duration::from_millis(500)).await;
        
        // Cleanup
        let _ = manager.delete_process(&response.id).await;
    }
}
