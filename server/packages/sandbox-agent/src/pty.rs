use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, mpsc, Mutex as AsyncMutex};

use sandbox_agent_error::SandboxError;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;
const OUTPUT_BUFFER_SIZE: usize = 8192;
const OUTPUT_CHANNEL_CAPACITY: usize = 256;
const INPUT_CHANNEL_CAPACITY: usize = 256;
const EXIT_POLL_INTERVAL_MS: u64 = 200;

#[derive(Debug, Clone)]
pub struct PtyRecord {
    pub id: String,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub status: PtyStatus,
    pub pid: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

#[derive(Debug, Clone)]
pub struct PtySizeSpec {
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone)]
pub struct PtyCreateOptions {
    pub id: String,
    pub title: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub owner_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PtyUpdateOptions {
    pub title: Option<String>,
    pub size: Option<PtySizeSpec>,
}

#[derive(Debug)]
pub struct PtyIo {
    pub output: mpsc::Receiver<Arc<[u8]>>,
    pub input: mpsc::Sender<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub enum PtyEvent {
    Exited { id: String, exit_code: i32 },
}

#[derive(Debug)]
pub struct PtyManager {
    ptys: AsyncMutex<HashMap<String, Arc<PtyHandle>>>,
    event_tx: broadcast::Sender<PtyEvent>,
}

#[derive(Debug)]
struct PtyHandle {
    record: Mutex<PtyRecordState>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    input_tx: mpsc::Sender<Vec<u8>>,
    output_listeners: Mutex<Vec<mpsc::Sender<Arc<[u8]>>>>,
    owner_session_id: Option<String>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

#[derive(Debug, Clone)]
struct PtyRecordState {
    record: PtyRecord,
    exit_code: Option<i32>,
}

impl PtyRecordState {
    fn snapshot(&self) -> PtyRecord {
        self.record.clone()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(128);
        Self {
            ptys: AsyncMutex::new(HashMap::new()),
            event_tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PtyEvent> {
        self.event_tx.subscribe()
    }

    pub async fn list(&self) -> Vec<PtyRecord> {
        let ptys = self.ptys.lock().await;
        ptys.values()
            .map(|handle| handle.record.lock().unwrap().snapshot())
            .collect()
    }

    pub async fn get(&self, id: &str) -> Option<PtyRecord> {
        let ptys = self.ptys.lock().await;
        ptys.get(id)
            .map(|handle| handle.record.lock().unwrap().snapshot())
    }

    pub async fn connect(&self, id: &str) -> Option<PtyIo> {
        let ptys = self.ptys.lock().await;
        let handle = ptys.get(id)?.clone();
        drop(ptys);

        let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        handle
            .output_listeners
            .lock()
            .unwrap()
            .push(output_tx);

        Some(PtyIo {
            output: output_rx,
            input: handle.input_tx.clone(),
        })
    }

    pub async fn create(&self, options: PtyCreateOptions) -> Result<PtyRecord, SandboxError> {
        let pty_system = native_pty_system();
        let pty_size = PtySize {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(pty_size).map_err(|err| SandboxError::StreamError {
            message: format!("failed to open pty: {err}"),
        })?;

        let mut cmd = CommandBuilder::new(&options.command);
        cmd.args(&options.args);
        cmd.cwd(&options.cwd);
        for (key, value) in &options.env {
            cmd.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| SandboxError::StreamError {
                message: format!("failed to spawn pty command: {err}"),
            })?;
        let pid = child
            .process_id()
            .map(|value| value as i64)
            .unwrap_or(0);

        let record = PtyRecord {
            id: options.id.clone(),
            title: options.title.clone(),
            command: options.command.clone(),
            args: options.args.clone(),
            cwd: options.cwd.clone(),
            status: PtyStatus::Running,
            pid,
        };
        let record_state = PtyRecordState {
            record: record.clone(),
            exit_code: None,
        };

        let mut master = pair.master;
        let reader = master
            .try_clone_reader()
            .map_err(|err| SandboxError::StreamError {
                message: format!("failed to clone pty reader: {err}"),
            })?;
        let writer = master
            .take_writer()
            .map_err(|err| SandboxError::StreamError {
                message: format!("failed to take pty writer: {err}"),
            })?;

        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(INPUT_CHANNEL_CAPACITY);
        let output_listeners = Mutex::new(Vec::new());
        let handle = Arc::new(PtyHandle {
            record: Mutex::new(record_state),
            master: Mutex::new(master),
            input_tx,
            output_listeners,
            owner_session_id: options.owner_session_id.clone(),
            child: Mutex::new(child),
        });

        self.spawn_output_reader(handle.clone(), reader);
        self.spawn_input_writer(writer, input_rx);
        self.spawn_exit_watcher(handle.clone());

        let mut ptys = self.ptys.lock().await;
        ptys.insert(options.id.clone(), handle);
        drop(ptys);

        Ok(record)
    }

    pub async fn update(&self, id: &str, options: PtyUpdateOptions) -> Result<Option<PtyRecord>, SandboxError> {
        let ptys = self.ptys.lock().await;
        let handle = match ptys.get(id) {
            Some(handle) => handle.clone(),
            None => return Ok(None),
        };
        drop(ptys);

        if let Some(title) = options.title {
            let mut record = handle.record.lock().unwrap();
            record.record.title = title;
        }

        if let Some(size) = options.size {
            let pty_size = PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            };
            handle
                .master
                .lock()
                .unwrap()
                .resize(pty_size)
                .map_err(|err| SandboxError::StreamError {
                    message: format!("failed to resize pty: {err}"),
                })?;
        }

        let record = handle.record.lock().unwrap().snapshot();
        Ok(Some(record))
    }

    pub async fn remove(&self, id: &str) -> Option<PtyRecord> {
        let mut ptys = self.ptys.lock().await;
        let handle = ptys.remove(id)?;
        drop(ptys);

        let _ = handle.child.lock().unwrap().kill();
        Some(handle.record.lock().unwrap().snapshot())
    }

    pub async fn cleanup_session(&self, session_id: &str) {
        let mut ptys = self.ptys.lock().await;
        let ids: Vec<String> = ptys
            .iter()
            .filter_map(|(id, handle)| {
                if handle.owner_session_id.as_deref() == Some(session_id) {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in ids {
            if let Some(handle) = ptys.remove(&id) {
                let _ = handle.child.lock().unwrap().kill();
            }
        }
    }

    fn spawn_output_reader(&self, handle: Arc<PtyHandle>, mut reader: Box<dyn Read + Send>) {
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; OUTPUT_BUFFER_SIZE];
            loop {
                let size = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => size,
                    Err(_) => break,
                };
                let payload: Arc<[u8]> = Arc::from(buffer[..size].to_vec());
                let mut listeners = handle.output_listeners.lock().unwrap();
                listeners.retain(|listener| listener.blocking_send(payload.clone()).is_ok());
            }
        });
    }

    fn spawn_input_writer(
        &self,
        writer: Box<dyn Write + Send>,
        mut input_rx: mpsc::Receiver<Vec<u8>>,
    ) {
        let writer = Arc::new(Mutex::new(writer));
        tokio::spawn(async move {
            while let Some(chunk) = input_rx.recv().await {
                let writer = writer.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let mut writer = writer.lock().unwrap();
                    writer.write_all(&chunk)?;
                    writer.flush()
                })
                .await;
                if result.is_err() {
                    break;
                }
            }
        });
    }

    fn spawn_exit_watcher(&self, handle: Arc<PtyHandle>) {
        let event_tx = self.event_tx.clone();
        std::thread::spawn(move || loop {
            let exit_code = {
                let mut child = handle.child.lock().unwrap();
                match child.try_wait() {
                    Ok(Some(status)) => Some(status.code().unwrap_or(0)),
                    Ok(None) => None,
                    Err(_) => Some(1),
                }
            };
            if let Some(exit_code) = exit_code {
                {
                    let mut record = handle.record.lock().unwrap();
                    record.record.status = PtyStatus::Exited;
                    record.exit_code = Some(exit_code);
                }
                let _ = event_tx.send(PtyEvent::Exited {
                    id: handle.record.lock().unwrap().record.id.clone(),
                    exit_code,
                });
                break;
            }
            std::thread::sleep(Duration::from_millis(EXIT_POLL_INTERVAL_MS));
        });
    }
}
