use super::*;
impl SharedAgentBackend {
    pub(super) fn new_mock(agent: AgentId) -> Arc<Self> {
        Arc::new(Self {
            agent,
            sender: BackendSender::Mock(new_mock_backend()),
            pending_client_responses: Mutex::new(HashMap::new()),
        })
    }

    pub(super) async fn new_process(
        agent: AgentId,
        launch: AgentProcessLaunchSpec,
        runtime: Arc<AcpRuntimeInner>,
    ) -> Result<Arc<Self>, SandboxError> {
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (key, value) in &launch.env {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(|err| SandboxError::StreamError {
            message: format!(
                "failed to start ACP agent process {}: {err}",
                launch.program.display()
            ),
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture ACP agent process stdin".to_string(),
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture ACP agent process stdout".to_string(),
            })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SandboxError::StreamError {
                message: "failed to capture ACP agent process stderr".to_string(),
            })?;

        let process = ProcessBackend {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            stderr_capture: Arc::new(Mutex::new(StderrCapture::default())),
            terminate_requested: Arc::new(AtomicBool::new(false)),
        };
        let backend = Arc::new(Self {
            agent,
            sender: BackendSender::Process(process.clone()),
            pending_client_responses: Mutex::new(HashMap::new()),
        });

        backend.start_process_pumps(runtime, stdout, stderr, process);
        Ok(backend)
    }

    pub(super) async fn is_alive(&self) -> bool {
        match &self.sender {
            BackendSender::Mock(_) => true,
            BackendSender::Process(process) => process.is_alive().await,
        }
    }

    pub(super) fn start_process_pumps(
        self: &Arc<Self>,
        runtime: Arc<AcpRuntimeInner>,
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
        process: ProcessBackend,
    ) {
        let backend = self.clone();
        let runtime_stdout = runtime.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let message = match serde_json::from_str::<Value>(&line) {
                    Ok(message) => message,
                    Err(err) => json!({
                        "jsonrpc": "2.0",
                        "method": AGENT_UNPARSED_METHOD,
                        "params": {
                            "error": err.to_string(),
                            "raw": line,
                        },
                    }),
                };
                runtime_stdout
                    .handle_backend_message(backend.agent, message)
                    .await;
            }
        });

        let backend = self.clone();
        let stderr_capture = process.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_capture.record_stderr_line(line.clone()).await;
                tracing::debug!(
                    agent = %backend.agent,
                    "ACP agent process stderr: {}",
                    line
                );
            }
        });

        let backend = self.clone();
        let runtime_exit = runtime.clone();
        tokio::spawn(async move {
            loop {
                let probe = {
                    let mut child = process.child.lock().await;
                    match child.try_wait() {
                        Ok(Some(status)) => Ok(Some(status)),
                        Ok(None) => Ok(None),
                        Err(err) => Err(err.to_string()),
                    }
                };

                match probe {
                    Ok(Some(status)) => {
                        runtime_exit
                            .remove_backend_if_same(backend.agent, &backend)
                            .await;
                        runtime_exit
                            .handle_backend_process_exit(
                                backend.agent,
                                Some(status),
                                process.terminated_by(),
                                process.stderr_output().await,
                            )
                            .await;
                        break;
                    }
                    Ok(None) => {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    Err(err) => {
                        runtime_exit
                            .remove_backend_if_same(backend.agent, &backend)
                            .await;
                        runtime_exit
                            .mark_backend_stopped(
                                backend.agent,
                                Some(format!("failed to poll ACP agent process status: {err}")),
                            )
                            .await;
                        break;
                    }
                }
            }
        });
    }

    pub(super) async fn send(
        &self,
        runtime: Arc<AcpRuntimeInner>,
        payload: Value,
    ) -> Result<(), SandboxError> {
        match &self.sender {
            BackendSender::Process(process) => {
                let mut stdin = process.stdin.lock().await;
                let encoded =
                    serde_json::to_vec(&payload).map_err(|err| SandboxError::InvalidRequest {
                        message: format!("failed to serialize JSON-RPC payload: {err}"),
                    })?;
                if let Err(err) = stdin.write_all(&encoded).await {
                    let message = format!("failed to write to ACP agent process stdin: {err}");
                    runtime
                        .mark_backend_stopped(self.agent, Some(message.clone()))
                        .await;
                    return Err(SandboxError::StreamError { message });
                }
                if let Err(err) = stdin.write_all(b"\n").await {
                    let message =
                        format!("failed to write line delimiter to ACP agent process stdin: {err}");
                    runtime
                        .mark_backend_stopped(self.agent, Some(message.clone()))
                        .await;
                    return Err(SandboxError::StreamError { message });
                }
                if let Err(err) = stdin.flush().await {
                    let message = format!("failed to flush ACP agent process stdin: {err}");
                    runtime
                        .mark_backend_stopped(self.agent, Some(message.clone()))
                        .await;
                    return Err(SandboxError::StreamError { message });
                }
                Ok(())
            }
            BackendSender::Mock(mock) => {
                let agent = self.agent;
                Box::pin(handle_mock_payload(mock, &payload, |message| {
                    let runtime = runtime.clone();
                    async move {
                        runtime.handle_backend_message(agent, message).await;
                    }
                }))
                .await
            }
        }
    }

    pub(super) async fn shutdown(&self, grace: Duration) {
        if let BackendSender::Process(process) = &self.sender {
            process.terminate_requested.store(true, Ordering::SeqCst);
            tokio::time::sleep(grace).await;
            let mut child = process.child.lock().await;
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                Err(_) => {
                    let _ = child.kill().await;
                }
            }
        }
    }
}

impl ProcessBackend {
    pub(super) async fn record_stderr_line(&self, line: String) {
        self.stderr_capture.lock().await.record(line);
    }

    pub(super) async fn stderr_output(&self) -> Option<StderrOutput> {
        self.stderr_capture.lock().await.snapshot()
    }

    pub(super) async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        matches!(child.try_wait(), Ok(None))
    }

    pub(super) fn terminated_by(&self) -> TerminatedBy {
        if self.terminate_requested.load(Ordering::SeqCst) {
            TerminatedBy::Daemon
        } else {
            TerminatedBy::Agent
        }
    }
}

impl AcpClient {
    pub(super) fn new(id: String, default_agent: AgentId) -> Arc<Self> {
        let (sender, _rx) = broadcast::channel(512);
        Arc::new(Self {
            id,
            default_agent,
            seq: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            sse_stream_active: Arc::new(AtomicBool::new(false)),
            sender,
            ring: Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE)),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub(super) async fn push_stream(&self, payload: Value) {
        let sequence = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let message = StreamMessage { sequence, payload };

        {
            let mut ring = self.ring.lock().await;
            ring.push_back(message.clone());
            while ring.len() > RING_BUFFER_SIZE {
                ring.pop_front();
            }
        }

        let _ = self.sender.send(message);
    }

    pub(super) async fn subscribe(
        &self,
        last_event_id: Option<u64>,
    ) -> (Vec<StreamMessage>, broadcast::Receiver<StreamMessage>) {
        let replay = {
            let ring = self.ring.lock().await;
            ring.iter()
                .filter(|message| {
                    if let Some(last_event_id) = last_event_id {
                        message.sequence > last_event_id
                    } else {
                        true
                    }
                })
                .cloned()
                .collect::<Vec<_>>()
        };

        (replay, self.sender.subscribe())
    }

    pub(super) fn try_claim_sse_stream(&self) -> bool {
        self.sse_stream_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub(super) fn sse_active_flag(&self) -> Arc<AtomicBool> {
        self.sse_stream_active.clone()
    }

    pub(super) async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }

        self.sse_stream_active.store(false, Ordering::SeqCst);
        self.pending.lock().await.clear();
    }
}
