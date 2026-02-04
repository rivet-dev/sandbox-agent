use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{broadcast, mpsc, Mutex as AsyncMutex};

use sandbox_agent_error::SandboxError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PtyStatus {
    Running,
    Exited,
}

impl PtyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            PtyStatus::Running => "running",
            PtyStatus::Exited => "exited",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PtyInfo {
    pub id: String,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub status: PtyStatus,
    pub pid: i64,
    pub exit_code: Option<i32>,
    pub owner_session_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PtySpawnRequest {
    pub id: String,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Option<HashMap<String, String>>,
    pub owner_session_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PtyUpdateRequest {
    pub title: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PtyExit {
    pub id: String,
    pub exit_code: i32,
}

#[derive(Clone)]
pub struct PtyConnection {
    pub output: broadcast::Receiver<Vec<u8>>,
    pub input: mpsc::Sender<Vec<u8>>,
}

struct PtyInstance {
    info: Mutex<PtyInfo>,
    output_tx: broadcast::Sender<Vec<u8>>,
    input_tx: mpsc::Sender<Vec<u8>>,
    exit_tx: broadcast::Sender<PtyExit>,
}

#[derive(Default)]
pub struct PtyManager {
    ptys: AsyncMutex<HashMap<String, Arc<PtyInstance>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            ptys: AsyncMutex::new(HashMap::new()),
        }
    }

    pub async fn spawn(&self, request: PtySpawnRequest) -> Result<PtyInfo, SandboxError> {
        if request.command.trim().is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "command is required".to_string(),
            });
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| SandboxError::InvalidRequest {
                message: format!("failed to open PTY: {err}"),
            })?;

        let mut cmd = CommandBuilder::new(&request.command);
        cmd.args(&request.args);
        cmd.cwd(&request.cwd);
        if let Some(env) = &request.env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| SandboxError::InvalidRequest {
                message: format!("failed to spawn PTY command: {err}"),
            })?;

        let pid = child.process_id().unwrap_or(0) as i64;
        let (output_tx, _) = broadcast::channel(512);
        let (exit_tx, _) = broadcast::channel(8);
        let (input_tx, mut input_rx) = mpsc::channel(256);

        let info = PtyInfo {
            id: request.id.clone(),
            title: request.title.clone(),
            command: request.command.clone(),
            args: request.args.clone(),
            cwd: request.cwd.clone(),
            status: PtyStatus::Running,
            pid,
            exit_code: None,
            owner_session_id: request.owner_session_id.clone(),
        };

        let instance = Arc::new(PtyInstance {
            info: Mutex::new(info.clone()),
            output_tx,
            input_tx: input_tx.clone(),
            exit_tx,
        });

        let mut ptys = self.ptys.lock().await;
        ptys.insert(request.id.clone(), instance.clone());
        drop(ptys);

        let output_tx = instance.output_tx.clone();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| SandboxError::InvalidRequest {
                message: format!("failed to clone PTY reader: {err}"),
            })?;
        tokio::task::spawn_blocking(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let _ = output_tx.send(buffer[..count].to_vec());
                    }
                    Err(_) => break,
                }
            }
        });

        let mut writer = pair
            .master
            .take_writer()
            .map_err(|err| SandboxError::InvalidRequest {
                message: format!("failed to take PTY writer: {err}"),
            })?;
        tokio::task::spawn_blocking(move || {
            while let Some(payload) = input_rx.blocking_recv() {
                if writer.write_all(&payload).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
        });

        let exit_tx = instance.exit_tx.clone();
        let info_ref = Arc::clone(&instance);
        tokio::task::spawn_blocking(move || {
            let exit_code = child
                .wait()
                .ok()
                .and_then(|status| status.exit_code().map(|code| code as i32));
            let mut info = info_ref.info.lock().expect("pty info lock");
            info.status = PtyStatus::Exited;
            info.exit_code = exit_code;
            let code = exit_code.unwrap_or(-1);
            let _ = exit_tx.send(PtyExit {
                id: info.id.clone(),
                exit_code: code,
            });
        });

        Ok(info)
    }

    pub async fn list(&self) -> Vec<PtyInfo> {
        let ptys = self.ptys.lock().await;
        ptys.values()
            .map(|pty| pty.info.lock().expect("pty info lock").clone())
            .collect()
    }

    pub async fn get(&self, pty_id: &str) -> Option<PtyInfo> {
        let ptys = self.ptys.lock().await;
        ptys.get(pty_id)
            .map(|pty| pty.info.lock().expect("pty info lock").clone())
    }

    pub async fn update(&self, pty_id: &str, update: PtyUpdateRequest) -> Option<PtyInfo> {
        let ptys = self.ptys.lock().await;
        let pty = ptys.get(pty_id)?;
        let mut info = pty.info.lock().expect("pty info lock");
        if let Some(title) = update.title {
            info.title = title;
        }
        if let Some(command) = update.command {
            info.command = command;
        }
        if let Some(args) = update.args {
            info.args = args;
        }
        if let Some(cwd) = update.cwd {
            info.cwd = cwd;
        }
        Some(info.clone())
    }

    pub async fn remove(&self, pty_id: &str) -> Option<PtyInfo> {
        let mut ptys = self.ptys.lock().await;
        let pty = ptys.remove(pty_id)?;
        let info = pty.info.lock().expect("pty info lock").clone();
        terminate_process(info.pid);
        Some(info)
    }

    pub async fn connect(&self, pty_id: &str) -> Option<PtyConnection> {
        let ptys = self.ptys.lock().await;
        let pty = ptys.get(pty_id)?.clone();
        Some(PtyConnection {
            output: pty.output_tx.subscribe(),
            input: pty.input_tx.clone(),
        })
    }

    pub async fn subscribe_exit(&self, pty_id: &str) -> Option<broadcast::Receiver<PtyExit>> {
        let ptys = self.ptys.lock().await;
        let pty = ptys.get(pty_id)?.clone();
        Some(pty.exit_tx.subscribe())
    }

    pub async fn cleanup_for_session(&self, session_id: &str) {
        let ids = {
            let ptys = self.ptys.lock().await;
            ptys.values()
                .filter(|pty| {
                    pty.info
                        .lock()
                        .expect("pty info lock")
                        .owner_session_id
                        .as_deref()
                        == Some(session_id)
                })
                .map(|pty| pty.info.lock().expect("pty info lock").id.clone())
                .collect::<Vec<_>>()
        };
        for id in ids {
            let _ = self.remove(&id).await;
        }
    }
}

#[cfg(unix)]
fn terminate_process(pid: i64) {
    if pid <= 0 {
        return;
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn terminate_process(_pid: i64) {}
