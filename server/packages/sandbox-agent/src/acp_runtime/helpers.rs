use super::*;
pub(super) fn validate_jsonrpc_envelope(payload: &Value) -> Result<(), SandboxError> {
    let object = payload
        .as_object()
        .ok_or_else(|| SandboxError::InvalidRequest {
            message: "JSON-RPC payload must be an object".to_string(),
        })?;

    let Some(jsonrpc) = object.get("jsonrpc").and_then(Value::as_str) else {
        return Err(SandboxError::InvalidRequest {
            message: "JSON-RPC payload must include jsonrpc field".to_string(),
        });
    };

    if jsonrpc != "2.0" {
        return Err(SandboxError::InvalidRequest {
            message: "jsonrpc must be '2.0'".to_string(),
        });
    }

    let has_method = object.get("method").is_some();
    let has_id = object.get("id").is_some();
    let has_result_or_error = object.get("result").is_some() || object.get("error").is_some();

    if !has_method && !has_id {
        return Err(SandboxError::InvalidRequest {
            message: "JSON-RPC payload must include either method or id".to_string(),
        });
    }

    if has_method && has_result_or_error {
        return Err(SandboxError::InvalidRequest {
            message: "JSON-RPC request/notification must not include result or error".to_string(),
        });
    }

    Ok(())
}

pub(super) fn required_sandbox_agent_meta(
    payload: &Value,
    method: &str,
) -> Result<AgentId, SandboxError> {
    let Some(agent) = payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object)
        .and_then(|meta| meta.get(SANDBOX_META_KEY))
        .and_then(Value::as_object)
        .and_then(|sandbox| sandbox.get("agent"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(SandboxError::InvalidRequest {
            message: format!("{method} requires params._meta[\"{SANDBOX_META_KEY}\"].agent"),
        });
    };
    AgentId::parse(agent).ok_or_else(|| SandboxError::UnsupportedAgent {
        agent: agent.to_string(),
    })
}

pub(super) fn explicit_agent_param(payload: &Value) -> Result<Option<AgentId>, SandboxError> {
    let Some(agent_value) = payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("agent"))
    else {
        return Ok(None);
    };
    let Some(agent_name) = agent_value.as_str() else {
        return Err(SandboxError::InvalidRequest {
            message: "params.agent must be a string".to_string(),
        });
    };
    let agent_name = agent_name.trim();
    if agent_name.is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "params.agent must be non-empty".to_string(),
        });
    }
    AgentId::parse(agent_name)
        .map(Some)
        .ok_or_else(|| SandboxError::UnsupportedAgent {
            agent: agent_name.to_string(),
        })
}

pub(super) fn to_sse_event(message: StreamMessage) -> Event {
    let data = serde_json::to_string(&message.payload).unwrap_or_else(|_| "{}".to_string());
    Event::default()
        .event("message")
        .id(message.sequence.to_string())
        .data(data)
}

pub(super) fn message_id_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_string())
}

pub(super) fn set_payload_id(payload: &mut Value, id: Value) {
    if let Some(object) = payload.as_object_mut() {
        object.insert("id".to_string(), id);
    }
}

pub(super) fn extract_session_id_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("sessionId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn extract_session_id_from_response(payload: &Value) -> Option<String> {
    payload
        .get("result")
        .and_then(Value::as_object)
        .and_then(|result| result.get("sessionId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn extract_cwd_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("cwd"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn extract_model_id_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("modelId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn extract_mode_id_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("params")
        .and_then(Value::as_object)
        .and_then(|params| params.get("modeId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn extract_models_from_response(response: &Value) -> Option<AgentModelSnapshot> {
    let result = response.get("result")?.as_object()?;
    let models_root = result
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| result.clone());
    let available_models = models_root
        .get("availableModels")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let model_id = object.get("modelId").and_then(Value::as_str)?.to_string();
            let mut variants = object
                .get("variants")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            variants.sort();
            Some(AgentModelInfo {
                model_id,
                name: object
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                description: object
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                default_variant: object
                    .get("defaultVariant")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                variants,
            })
        })
        .collect::<Vec<_>>();

    let current_model_id = models_root
        .get("currentModelId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            available_models
                .first()
                .map(|entry| entry.model_id.to_string())
        });
    Some(AgentModelSnapshot {
        available_models,
        current_model_id,
    })
}

pub(super) fn extract_modes_from_response(response: &Value) -> Option<AgentModeSnapshot> {
    let result = response.get("result")?.as_object()?;
    let modes_root = result
        .get("modes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| result.clone());
    let available_modes = modes_root
        .get("availableModes")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let mode_id = object
                .get("modeId")
                .and_then(Value::as_str)
                .or_else(|| object.get("id").and_then(Value::as_str))?
                .to_string();
            Some(AgentModeInfo {
                mode_id,
                name: object
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                description: object
                    .get("description")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            })
        })
        .collect::<Vec<_>>();
    let current_mode_id = modes_root
        .get("currentModeId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            available_modes
                .first()
                .map(|entry| entry.mode_id.to_string())
        });
    Some(AgentModeSnapshot {
        available_modes,
        current_mode_id,
    })
}

pub(super) fn fallback_models_for_agent(agent: AgentId) -> AgentModelSnapshot {
    match agent {
        // Copied from pre-ACP v1 fallback behavior in router.rs.
        AgentId::Claude => AgentModelSnapshot {
            available_models: vec![
                AgentModelInfo {
                    model_id: "default".to_string(),
                    name: Some("Default (recommended)".to_string()),
                    description: None,
                    default_variant: None,
                    variants: Vec::new(),
                },
                AgentModelInfo {
                    model_id: "sonnet".to_string(),
                    name: Some("Sonnet".to_string()),
                    description: None,
                    default_variant: None,
                    variants: Vec::new(),
                },
                AgentModelInfo {
                    model_id: "opus".to_string(),
                    name: Some("Opus".to_string()),
                    description: None,
                    default_variant: None,
                    variants: Vec::new(),
                },
                AgentModelInfo {
                    model_id: "haiku".to_string(),
                    name: Some("Haiku".to_string()),
                    description: None,
                    default_variant: None,
                    variants: Vec::new(),
                },
            ],
            current_model_id: Some("default".to_string()),
        },
        AgentId::Amp => AgentModelSnapshot {
            available_models: vec![AgentModelInfo {
                model_id: "amp-default".to_string(),
                name: Some("Amp Default".to_string()),
                description: None,
                default_variant: None,
                variants: Vec::new(),
            }],
            current_model_id: Some("amp-default".to_string()),
        },
        AgentId::Mock => AgentModelSnapshot {
            available_models: vec![AgentModelInfo {
                model_id: "mock".to_string(),
                name: Some("Mock".to_string()),
                description: None,
                default_variant: None,
                variants: Vec::new(),
            }],
            current_model_id: Some("mock".to_string()),
        },
        AgentId::Codex | AgentId::Opencode => AgentModelSnapshot::default(),
    }
}

pub(super) fn to_stream_error(
    error: sandbox_agent_agent_management::agents::AgentError,
) -> SandboxError {
    SandboxError::StreamError {
        message: error.to_string(),
    }
}

pub(super) fn duration_from_env_ms(var_name: &str, default: Duration) -> Duration {
    std::env::var(var_name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(default)
}

impl SessionEndReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Error => "error",
            Self::Terminated => "terminated",
        }
    }
}

impl TerminatedBy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Daemon => "daemon",
        }
    }
}

impl StderrCapture {
    pub(super) fn record(&mut self, line: String) {
        self.total_lines = self.total_lines.saturating_add(1);
        if self.full_if_small.len() < STDERR_HEAD_LINES + STDERR_TAIL_LINES {
            self.full_if_small.push(line.clone());
        }
        if self.head.len() < STDERR_HEAD_LINES {
            self.head.push(line.clone());
        }
        self.tail.push_back(line);
        while self.tail.len() > STDERR_TAIL_LINES {
            self.tail.pop_front();
        }
    }

    pub(super) fn snapshot(&self) -> Option<StderrOutput> {
        if self.total_lines == 0 {
            return None;
        }
        let max_untruncated = STDERR_HEAD_LINES + STDERR_TAIL_LINES;
        if self.total_lines <= max_untruncated {
            let head = if self.full_if_small.is_empty() {
                None
            } else {
                Some(self.full_if_small.join("\n"))
            };
            return Some(StderrOutput {
                head,
                tail: None,
                truncated: false,
                total_lines: Some(self.total_lines),
            });
        }
        Some(StderrOutput {
            head: if self.head.is_empty() {
                None
            } else {
                Some(self.head.join("\n"))
            },
            tail: if self.tail.is_empty() {
                None
            } else {
                Some(self.tail.iter().cloned().collect::<Vec<_>>().join("\n"))
            },
            truncated: true,
            total_lines: Some(self.total_lines),
        })
    }
}

impl From<MetaSession> for SessionRuntimeInfo {
    fn from(value: MetaSession) -> Self {
        Self {
            session_id: value.session_id,
            created_at: value.created_at,
            updated_at: value.updated_at_ms,
            ended: value.ended,
            event_count: value.event_count,
            model_hint: value.model_hint,
            mode_hint: value.mode_hint,
            title: value.title,
            cwd: value.cwd,
            sandbox_meta: value.sandbox_meta,
            agent: value.agent,
            ended_data: value.ended_data,
        }
    }
}

impl From<AgentModelSnapshot> for RuntimeModelSnapshot {
    fn from(value: AgentModelSnapshot) -> Self {
        Self {
            available_models: value
                .available_models
                .into_iter()
                .map(|model| RuntimeModelInfo {
                    model_id: model.model_id,
                    name: model.name,
                    description: model.description,
                })
                .collect(),
            current_model_id: value.current_model_id,
        }
    }
}

impl From<AgentModeSnapshot> for RuntimeModeSnapshot {
    fn from(value: AgentModeSnapshot) -> Self {
        Self {
            available_modes: value
                .available_modes
                .into_iter()
                .map(|mode| RuntimeModeInfo {
                    mode_id: mode.mode_id,
                    name: mode.name,
                    description: mode.description,
                })
                .collect(),
            current_mode_id: value.current_mode_id,
        }
    }
}

pub(super) fn ended_data_to_value(data: &SessionEndedData) -> Value {
    let mut output = Map::new();
    output.insert(
        "reason".to_string(),
        Value::String(data.reason.as_str().to_string()),
    );
    output.insert(
        "terminated_by".to_string(),
        Value::String(data.terminated_by.as_str().to_string()),
    );
    if let Some(message) = &data.message {
        output.insert("message".to_string(), Value::String(message.clone()));
    }
    if let Some(exit_code) = data.exit_code {
        output.insert("exit_code".to_string(), Value::from(exit_code));
    }
    if let Some(stderr) = &data.stderr {
        let mut stderr_value = Map::new();
        if let Some(head) = &stderr.head {
            stderr_value.insert("head".to_string(), Value::String(head.clone()));
        }
        if let Some(tail) = &stderr.tail {
            stderr_value.insert("tail".to_string(), Value::String(tail.clone()));
        }
        stderr_value.insert("truncated".to_string(), Value::Bool(stderr.truncated));
        if let Some(total_lines) = stderr.total_lines {
            stderr_value.insert("total_lines".to_string(), Value::from(total_lines as u64));
        }
        output.insert("stderr".to_string(), Value::Object(stderr_value));
    }
    Value::Object(output)
}

pub(super) fn ended_data_from_process_exit(
    status: Option<ExitStatus>,
    terminated_by: TerminatedBy,
    stderr: Option<StderrOutput>,
) -> SessionEndedData {
    if terminated_by == TerminatedBy::Daemon {
        return SessionEndedData {
            reason: SessionEndReason::Terminated,
            terminated_by,
            message: None,
            exit_code: None,
            stderr: None,
        };
    }
    if status.as_ref().is_some_and(ExitStatus::success) {
        return SessionEndedData {
            reason: SessionEndReason::Completed,
            terminated_by,
            message: None,
            exit_code: None,
            stderr: None,
        };
    }
    let message = status
        .as_ref()
        .map(|value| format!("agent exited with status {value}"))
        .or_else(|| Some("agent exited".to_string()));
    SessionEndedData {
        reason: SessionEndReason::Error,
        terminated_by,
        message,
        exit_code: status.and_then(|value| value.code()),
        stderr,
    }
}

pub(super) fn infer_base_url_from_launch(launch: &AgentProcessLaunchSpec) -> Option<String> {
    for (key, value) in &launch.env {
        if (key.contains("BASE_URL") || key.ends_with("_URL")) && is_http_url(value) {
            return Some(value.clone());
        }
    }
    for arg in &launch.args {
        if let Some(value) = arg.strip_prefix("--base-url=") {
            if is_http_url(value) {
                return Some(value.to_string());
            }
        }
        if let Some(value) = arg.strip_prefix("--base_url=") {
            if is_http_url(value) {
                return Some(value.to_string());
            }
        }
        if let Some(value) = arg.strip_prefix("--url=") {
            if is_http_url(value) {
                return Some(value.to_string());
            }
        }
    }
    let mut args = launch.args.iter();
    while let Some(arg) = args.next() {
        if arg == "--base-url" || arg == "--base_url" || arg == "--url" {
            if let Some(value) = args.next() {
                if is_http_url(value) {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

pub(super) fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
