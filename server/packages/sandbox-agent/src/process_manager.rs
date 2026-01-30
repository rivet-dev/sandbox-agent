//! Process Manager - API for spawning and managing background processes.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
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
use tokio::sync::{broadcast, Mutex, RwLock};
use utoipa::ToSchema;

use sandbox_agent_error::SandboxError;

static PROCESS_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

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
}

/// Response after starting a process
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartProcessResponse {
    pub id: String,
    pub status: ProcessStatus,
    pub log_paths: ProcessLogPaths,
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

/// Internal state for a managed process
#[derive(Debug)]
struct ManagedProcess {
    info: ProcessInfo,
    /// Handle to the running process (None if process has exited)
    child: Option<Child>,
    /// Broadcaster for log lines (for SSE streaming)
    log_broadcaster: broadcast::Sender<String>,
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
                },
                child: None,
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
        let combined_file = Arc::new(std::sync::Mutex::new(
            File::create(&log_paths.combined).map_err(|e| SandboxError::StreamError {
                message: format!("Failed to create combined log: {}", e),
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
        
        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
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
        };
        
        let managed = Arc::new(Mutex::new(ManagedProcess {
            info: info.clone(),
            child: Some(child),
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
                if let Some(ref mut child) = guard.child {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            guard.info.status = ProcessStatus::Stopped;
                            guard.info.exit_code = status.code();
                            guard.info.stopped_at = Some(
                                SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                            );
                            guard.child = None;
                            drop(guard);
                            
                            // Save state - we need to do this manually since we don't have self
                            // This is a simplified version that just updates the state file
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
    
    /// Stop a process with SIGTERM
    pub async fn stop_process(&self, id: &str) -> Result<(), SandboxError> {
        let processes = self.processes.read().await;
        let managed = processes.get(id).ok_or_else(|| SandboxError::SessionNotFound {
            session_id: format!("process:{}", id),
        })?;
        
        let mut guard = managed.lock().await;
        
        if let Some(ref child) = guard.child {
            #[cfg(unix)]
            {
                // Send SIGTERM
                if let Some(pid) = child.id() {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
            }
            #[cfg(not(unix))]
            {
                // On non-Unix, we can't send SIGTERM, so just mark as stopping
                // The process will be killed when delete is called if needed
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
        
        if let Some(ref mut child) = guard.child {
            let _ = child.kill().await;
            guard.info.status = ProcessStatus::Killed;
            guard.info.stopped_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            );
            guard.child = None;
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
                if guard.child.is_some() {
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
/// Timestamps are in format: [2026-01-30T12:32:45.123Z] or [2026-01-30T12:32:45Z]
fn strip_timestamps(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            // Match pattern: [YYYY-MM-DDTHH:MM:SS...Z] at start of line
            if line.starts_with('[') {
                if let Some(end) = line.find("] ") {
                    // Check if it looks like a timestamp (starts with digit after [)
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

/// Helper to save state from within a spawned task (simplified version)
async fn save_state_to_file(base_dir: &PathBuf) -> Result<(), std::io::Error> {
    // This is a no-op for now - the state will be saved on the next explicit save_state call
    // A more robust implementation would use a channel to communicate with the ProcessManager
    let _ = base_dir;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_process_manager_basic() {
        let manager = ProcessManager::new();
        
        // List should be empty initially (or have persisted state)
        let list = manager.list_processes().await;
        let initial_count = list.processes.len();
        
        // Start a simple process
        let request = StartProcessRequest {
            command: "echo".to_string(),
            args: vec!["hello".to_string()],
            cwd: None,
            env: HashMap::new(),
        };
        
        let response = manager.start_process(request).await.unwrap();
        assert!(!response.id.is_empty());
        assert_eq!(response.status, ProcessStatus::Running);
        
        // Wait a bit for the process to complete
        tokio::time::sleep(Duration::from_millis(200)).await;
        
        // Check the process info
        let info = manager.get_process(&response.id).await.unwrap();
        assert_eq!(info.command, "echo");
        
        // List should have one more process
        let list = manager.list_processes().await;
        assert_eq!(list.processes.len(), initial_count + 1);
        
        // Delete the process
        manager.delete_process(&response.id).await.unwrap();
        
        // List should be back to initial count
        let list = manager.list_processes().await;
        assert_eq!(list.processes.len(), initial_count);
    }
}
