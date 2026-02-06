use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant};

use reqwest::blocking::Client as HttpClient;

use crate::cli::{CliConfig, CliError};

mod build_id {
    include!(concat!(env!("OUT_DIR"), "/build_id.rs"));
}

pub use build_id::BUILD_ID;

const DAEMON_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub fn daemon_state_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("daemon"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("daemon"))
}

pub fn sanitize_host(host: &str) -> String {
    host.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

pub fn daemon_pid_path(host: &str, port: u16) -> PathBuf {
    let name = format!("daemon-{}-{}.pid", sanitize_host(host), port);
    daemon_state_dir().join(name)
}

pub fn daemon_log_path(host: &str, port: u16) -> PathBuf {
    let name = format!("daemon-{}-{}.log", sanitize_host(host), port);
    daemon_state_dir().join(name)
}

pub fn daemon_version_path(host: &str, port: u16) -> PathBuf {
    let name = format!("daemon-{}-{}.version", sanitize_host(host), port);
    daemon_state_dir().join(name)
}

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

pub fn read_pid(path: &Path) -> Option<u32> {
    let text = fs::read_to_string(path).ok()?;
    text.trim().parse::<u32>().ok()
}

pub fn write_pid(path: &Path, pid: u32) -> Result<(), CliError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, pid.to_string())?;
    Ok(())
}

pub fn remove_pid(path: &Path) -> Result<(), CliError> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

pub fn read_daemon_version(host: &str, port: u16) -> Option<String> {
    let path = daemon_version_path(host, port);
    let text = fs::read_to_string(path).ok()?;
    Some(text.trim().to_string())
}

pub fn write_daemon_version(host: &str, port: u16) -> Result<(), CliError> {
    let path = daemon_version_path(host, port);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, BUILD_ID)?;
    Ok(())
}

pub fn remove_version_file(host: &str, port: u16) -> Result<(), CliError> {
    let path = daemon_version_path(host, port);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn is_version_current(host: &str, port: u16) -> bool {
    match read_daemon_version(host, port) {
        Some(v) => v == BUILD_ID,
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

#[cfg(unix)]
pub fn is_process_running(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(code) if code == libc::EPERM => true,
        _ => false,
    }
}

#[cfg(windows)]
pub fn is_process_running(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if handle.is_invalid() {
            return false;
        }
        let mut exit_code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut exit_code).as_bool();
        let _ = CloseHandle(handle);
        ok && exit_code == 259
    }
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

pub fn check_health(base_url: &str, token: Option<&str>) -> Result<bool, CliError> {
    let client = HttpClient::builder().build()?;
    let url = format!("{base_url}/v1/health");
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    match request.send() {
        Ok(response) if response.status().is_success() => Ok(true),
        Ok(_) => Ok(false),
        Err(_) => Ok(false),
    }
}

pub fn wait_for_health(
    mut server_child: Option<&mut Child>,
    base_url: &str,
    token: Option<&str>,
    timeout: Duration,
) -> Result<(), CliError> {
    let client = HttpClient::builder().build()?;
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if let Some(child) = server_child.as_mut() {
            if let Some(status) = child.try_wait()? {
                return Err(CliError::Server(format!(
                    "sandbox-agent exited before becoming healthy ({status})"
                )));
            }
        }

        let url = format!("{base_url}/v1/health");
        let mut request = client.get(&url);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        match request.send() {
            Ok(response) if response.status().is_success() => return Ok(()),
            _ => {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    Err(CliError::Server(
        "timed out waiting for sandbox-agent health".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

pub fn spawn_sandbox_agent_daemon(
    cli: &CliConfig,
    host: &str,
    port: u16,
    token: Option<&str>,
    log_path: &Path,
) -> Result<Child, CliError> {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let log_file = fs::File::create(log_path)?;
    let log_file_err = log_file.try_clone()?;

    let exe = std::env::current_exe()?;
    let mut cmd = ProcessCommand::new(exe);
    cmd.arg("server")
        .arg("--host")
        .arg(host)
        .arg("--port")
        .arg(port.to_string())
        .env("SANDBOX_AGENT_LOG_STDOUT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    if cli.no_token {
        cmd.arg("--no-token");
    } else if let Some(token) = token {
        cmd.arg("--token").arg(token);
    } else {
        return Err(CliError::MissingToken);
    }

    cmd.spawn().map_err(CliError::from)
}

// ---------------------------------------------------------------------------
// DaemonStatus
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DaemonStatus {
    Running {
        pid: u32,
        version: Option<String>,
        version_current: bool,
        log_path: PathBuf,
    },
    NotRunning,
}

impl std::fmt::Display for DaemonStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DaemonStatus::Running {
                pid,
                version,
                version_current,
                log_path,
            } => {
                let version_str = version.as_deref().unwrap_or("unknown");
                let outdated = if *version_current {
                    ""
                } else {
                    " [outdated, restart recommended]"
                };
                write!(
                    f,
                    "Daemon running (PID {pid}, build {version_str}, logs: {}){}",
                    log_path.display(),
                    outdated
                )
            }
            DaemonStatus::NotRunning => write!(f, "Daemon not running"),
        }
    }
}

// ---------------------------------------------------------------------------
// High-level commands
// ---------------------------------------------------------------------------

pub fn status(host: &str, port: u16, token: Option<&str>) -> Result<DaemonStatus, CliError> {
    let pid_path = daemon_pid_path(host, port);
    let log_path = daemon_log_path(host, port);

    if let Some(pid) = read_pid(&pid_path) {
        if is_process_running(pid) {
            let version = read_daemon_version(host, port);
            let version_current = is_version_current(host, port);
            return Ok(DaemonStatus::Running {
                pid,
                version,
                version_current,
                log_path,
            });
        }
        // Stale PID file
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
    }

    // Also try a health check in case the daemon is running but we lost the PID file
    let base_url = format!("http://{host}:{port}");
    if check_health(&base_url, token)? {
        return Ok(DaemonStatus::Running {
            pid: 0,
            version: read_daemon_version(host, port),
            version_current: is_version_current(host, port),
            log_path,
        });
    }

    Ok(DaemonStatus::NotRunning)
}

pub fn start(
    cli: &CliConfig,
    host: &str,
    port: u16,
    token: Option<&str>,
) -> Result<(), CliError> {
    let base_url = format!("http://{host}:{port}");
    let pid_path = daemon_pid_path(host, port);
    let log_path = daemon_log_path(host, port);

    // Already healthy?
    if check_health(&base_url, token)? {
        eprintln!("daemon already running at {base_url}");
        return Ok(());
    }

    // Stale PID?
    if let Some(pid) = read_pid(&pid_path) {
        if is_process_running(pid) {
            eprintln!("daemon process {pid} exists; waiting for health");
            return wait_for_health(None, &base_url, token, DAEMON_HEALTH_TIMEOUT);
        }
        let _ = remove_pid(&pid_path);
    }

    eprintln!(
        "starting daemon at {base_url} (logs: {})",
        log_path.display()
    );

    let mut child = spawn_sandbox_agent_daemon(cli, host, port, token, &log_path)?;
    let pid = child.id();
    write_pid(&pid_path, pid)?;
    write_daemon_version(host, port)?;

    let result = wait_for_health(Some(&mut child), &base_url, token, DAEMON_HEALTH_TIMEOUT);
    if result.is_err() {
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
        return result;
    }

    eprintln!("daemon started (PID {pid}, logs: {})", log_path.display());
    Ok(())
}

#[cfg(unix)]
pub fn stop(host: &str, port: u16) -> Result<(), CliError> {
    let pid_path = daemon_pid_path(host, port);

    let pid = match read_pid(&pid_path) {
        Some(pid) => pid,
        None => {
            eprintln!("daemon is not running (no PID file)");
            return Ok(());
        }
    };

    if !is_process_running(pid) {
        eprintln!("daemon is not running (stale PID file)");
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
        return Ok(());
    }

    eprintln!("stopping daemon (PID {pid})...");

    // SIGTERM
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }

    // Wait up to 5 seconds for graceful exit
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        if !is_process_running(pid) {
            let _ = remove_pid(&pid_path);
            let _ = remove_version_file(host, port);
            eprintln!("daemon stopped");
            return Ok(());
        }
    }

    // SIGKILL
    eprintln!("daemon did not stop gracefully, sending SIGKILL...");
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    std::thread::sleep(Duration::from_millis(100));
    let _ = remove_pid(&pid_path);
    let _ = remove_version_file(host, port);
    eprintln!("daemon killed");
    Ok(())
}

#[cfg(windows)]
pub fn stop(host: &str, port: u16) -> Result<(), CliError> {
    let pid_path = daemon_pid_path(host, port);

    let pid = match read_pid(&pid_path) {
        Some(pid) => pid,
        None => {
            eprintln!("daemon is not running (no PID file)");
            return Ok(());
        }
    };

    if !is_process_running(pid) {
        eprintln!("daemon is not running (stale PID file)");
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
        return Ok(());
    }

    eprintln!("stopping daemon (PID {pid})...");

    // Use taskkill on Windows
    let _ = ProcessCommand::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .status();

    std::thread::sleep(Duration::from_millis(500));
    let _ = remove_pid(&pid_path);
    let _ = remove_version_file(host, port);
    eprintln!("daemon stopped");
    Ok(())
}

pub fn ensure_running(
    cli: &CliConfig,
    host: &str,
    port: u16,
    token: Option<&str>,
) -> Result<(), CliError> {
    let base_url = format!("http://{host}:{port}");
    let pid_path = daemon_pid_path(host, port);

    // Check if daemon is already healthy
    if check_health(&base_url, token)? {
        // Check build version
        if !is_version_current(host, port) {
            let old = read_daemon_version(host, port).unwrap_or_else(|| "unknown".to_string());
            eprintln!(
                "daemon outdated (build {old} -> {BUILD_ID}), restarting..."
            );
            stop(host, port)?;
            return start(cli, host, port, token);
        }
        let log_path = daemon_log_path(host, port);
        if let Some(pid) = read_pid(&pid_path) {
            eprintln!(
                "daemon already running at {base_url} (PID {pid}, logs: {})",
                log_path.display()
            );
        } else {
            eprintln!("daemon already running at {base_url}");
        }
        return Ok(());
    }

    // Not healthy — check for stale PID
    if let Some(pid) = read_pid(&pid_path) {
        if is_process_running(pid) {
            eprintln!("daemon process {pid} running; waiting for health");
            return wait_for_health(None, &base_url, token, DAEMON_HEALTH_TIMEOUT);
        }
        let _ = remove_pid(&pid_path);
        let _ = remove_version_file(host, port);
    }

    start(cli, host, port, token)
}
