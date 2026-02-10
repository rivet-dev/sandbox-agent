use super::*;
pub(super) async fn v1_removed() -> Response {
    let problem = ProblemDetails {
        type_: "urn:sandbox-agent:error:v1_removed".to_string(),
        title: "v1 API removed".to_string(),
        status: 410,
        detail: Some("v1 API removed; use /v2".to_string()),
        instance: None,
        extensions: serde_json::Map::new(),
    };

    (
        StatusCode::GONE,
        [(header::CONTENT_TYPE, "application/problem+json")],
        Json(problem),
    )
        .into_response()
}

pub(super) async fn opencode_disabled() -> Response {
    let problem = ProblemDetails {
        type_: "urn:sandbox-agent:error:opencode_disabled".to_string(),
        title: "OpenCode compatibility disabled".to_string(),
        status: 503,
        detail: Some(
            "/opencode is disabled during ACP core bring-up and will return in Phase 7".to_string(),
        ),
        instance: None,
        extensions: serde_json::Map::new(),
    };

    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CONTENT_TYPE, "application/problem+json")],
        Json(problem),
    )
        .into_response()
}

pub(super) async fn not_found() -> Response {
    let problem = ProblemDetails {
        type_: ErrorType::InvalidRequest.as_urn().to_string(),
        title: "Not Found".to_string(),
        status: 404,
        detail: Some("endpoint not found".to_string()),
        instance: None,
        extensions: serde_json::Map::new(),
    };

    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/problem+json")],
        Json(problem),
    )
        .into_response()
}

pub(super) async fn require_token(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, ApiError> {
    let Some(expected) = state.auth.token.as_ref() else {
        return Ok(next.run(request).await);
    };

    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    if bearer == Some(expected.as_str()) {
        return Ok(next.run(request).await);
    }

    Err(ApiError::Sandbox(SandboxError::TokenInvalid {
        message: Some("missing or invalid bearer token".to_string()),
    }))
}

pub(super) type PinBoxSseStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<axum::response::sse::Event, Infallible>> + Send>>;

pub(super) fn map_runtime_session(session: crate::acp_runtime::SessionRuntimeInfo) -> SessionInfo {
    SessionInfo {
        session_id: session.session_id,
        agent: session.agent.as_str().to_string(),
        agent_mode: session
            .mode_hint
            .clone()
            .unwrap_or_else(|| "build".to_string()),
        permission_mode: session
            .sandbox_meta
            .get("permissionMode")
            .or_else(|| session.sandbox_meta.get("permission_mode"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "default".to_string()),
        model: session.model_hint,
        native_session_id: session
            .sandbox_meta
            .get("nativeSessionId")
            .or_else(|| session.sandbox_meta.get("native_session_id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        ended: session.ended,
        event_count: session.event_count,
        created_at: session.created_at,
        updated_at: session.updated_at,
        directory: Some(session.cwd),
        title: session.title,
        termination_info: session.ended_data.map(map_termination_info),
    }
}

pub(super) fn map_termination_info(ended: crate::acp_runtime::SessionEndedData) -> TerminationInfo {
    let reason = match ended.reason {
        crate::acp_runtime::SessionEndReason::Completed => "completed",
        crate::acp_runtime::SessionEndReason::Error => "error",
        crate::acp_runtime::SessionEndReason::Terminated => "terminated",
    }
    .to_string();
    let terminated_by = match ended.terminated_by {
        crate::acp_runtime::TerminatedBy::Agent => "agent",
        crate::acp_runtime::TerminatedBy::Daemon => "daemon",
    }
    .to_string();
    TerminationInfo {
        reason,
        terminated_by,
        message: ended.message,
        exit_code: ended.exit_code,
        stderr: ended.stderr.map(|stderr| StderrOutput {
            head: stderr.head,
            tail: stderr.tail,
            truncated: stderr.truncated,
            total_lines: stderr.total_lines,
        }),
    }
}

pub(super) fn map_server_status(
    status: &crate::acp_runtime::RuntimeServerStatus,
) -> ServerStatusInfo {
    let server_status = if status.running {
        ServerStatus::Running
    } else if status.last_error.is_some() {
        ServerStatus::Error
    } else {
        ServerStatus::Stopped
    };
    ServerStatusInfo {
        status: server_status,
        base_url: status.base_url.clone(),
        uptime_ms: status.uptime_ms.map(|value| value.max(0) as u64),
        restart_count: status.restart_count,
        last_error: status.last_error.clone(),
    }
}

pub(super) fn credentials_available_for(
    agent: AgentId,
    has_anthropic: bool,
    has_openai: bool,
) -> bool {
    match agent {
        AgentId::Claude | AgentId::Amp => has_anthropic,
        AgentId::Codex => has_openai,
        AgentId::Opencode => has_anthropic || has_openai,
        AgentId::Mock => true,
    }
}

pub(super) fn agent_capabilities_for(agent: AgentId) -> AgentCapabilities {
    match agent {
        AgentId::Claude => AgentCapabilities {
            plan_mode: false,
            permissions: true,
            questions: true,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: false,
            file_attachments: false,
            session_lifecycle: false,
            error_events: false,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: false,
            shared_process: false,
        },
        AgentId::Codex => AgentCapabilities {
            plan_mode: true,
            permissions: true,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: true,
            status: true,
            command_execution: true,
            file_changes: true,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            shared_process: true,
        },
        AgentId::Opencode => AgentCapabilities {
            plan_mode: false,
            permissions: false,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            shared_process: true,
        },
        AgentId::Amp => AgentCapabilities {
            plan_mode: false,
            permissions: false,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: false,
            file_attachments: false,
            session_lifecycle: false,
            error_events: true,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: true,
            streaming_deltas: false,
            item_started: false,
            shared_process: false,
        },
        AgentId::Mock => AgentCapabilities {
            plan_mode: true,
            permissions: true,
            questions: true,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: true,
            status: true,
            command_execution: true,
            file_changes: true,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            shared_process: false,
        },
    }
}

pub(super) fn agent_modes_for(agent: AgentId) -> Vec<AgentModeInfo> {
    match agent {
        AgentId::Opencode => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Planning mode".to_string(),
            },
            AgentModeInfo {
                id: "custom".to_string(),
                name: "Custom".to_string(),
                description: "Any user-defined OpenCode agent name".to_string(),
            },
        ],
        AgentId::Codex => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Planning mode via prompt prefix".to_string(),
            },
        ],
        AgentId::Claude => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Plan mode (prompt-only)".to_string(),
            },
        ],
        AgentId::Amp => vec![AgentModeInfo {
            id: "build".to_string(),
            name: "Build".to_string(),
            description: "Default build mode".to_string(),
        }],
        AgentId::Mock => vec![
            AgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Mock agent for UI testing".to_string(),
            },
            AgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Plan-only mock mode".to_string(),
            },
        ],
    }
}

pub(super) fn fallback_models_for_agent(
    agent: AgentId,
) -> Option<(Vec<AgentModelInfo>, Option<String>)> {
    match agent {
        AgentId::Claude => Some((
            vec![
                AgentModelInfo {
                    id: "default".to_string(),
                    name: Some("Default (recommended)".to_string()),
                    variants: None,
                    default_variant: None,
                },
                AgentModelInfo {
                    id: "sonnet".to_string(),
                    name: Some("Sonnet".to_string()),
                    variants: None,
                    default_variant: None,
                },
                AgentModelInfo {
                    id: "opus".to_string(),
                    name: Some("Opus".to_string()),
                    variants: None,
                    default_variant: None,
                },
                AgentModelInfo {
                    id: "haiku".to_string(),
                    name: Some("Haiku".to_string()),
                    variants: None,
                    default_variant: None,
                },
            ],
            Some("default".to_string()),
        )),
        AgentId::Amp => Some((
            vec![AgentModelInfo {
                id: "amp-default".to_string(),
                name: Some("Amp Default".to_string()),
                variants: None,
                default_variant: None,
            }],
            Some("amp-default".to_string()),
        )),
        AgentId::Mock => Some((
            vec![AgentModelInfo {
                id: "mock".to_string(),
                name: Some("Mock".to_string()),
                variants: None,
                default_variant: None,
            }],
            Some("mock".to_string()),
        )),
        AgentId::Codex | AgentId::Opencode => None,
    }
}

pub(super) fn map_install_result(result: InstallResult) -> AgentInstallResponse {
    AgentInstallResponse {
        already_installed: result.already_installed,
        artifacts: result
            .artifacts
            .into_iter()
            .map(|artifact| AgentInstallArtifact {
                kind: map_artifact_kind(artifact.kind),
                path: artifact.path.to_string_lossy().to_string(),
                source: map_install_source(artifact.source),
                version: artifact.version,
            })
            .collect(),
    }
}

pub(super) fn map_install_source(source: InstallSource) -> String {
    match source {
        InstallSource::Registry => "registry",
        InstallSource::Fallback => "fallback",
        InstallSource::LocalPath => "local_path",
        InstallSource::Builtin => "builtin",
    }
    .to_string()
}

pub(super) fn map_artifact_kind(kind: InstalledArtifactKind) -> String {
    match kind {
        InstalledArtifactKind::NativeAgent => "native_agent",
        InstalledArtifactKind::AgentProcess => "agent_process",
    }
    .to_string()
}

pub(super) async fn resolve_fs_path(
    state: &Arc<AppState>,
    session_id: Option<&str>,
    raw_path: &str,
) -> Result<PathBuf, SandboxError> {
    let path = PathBuf::from(raw_path);
    if path.is_absolute() {
        return Ok(path);
    }
    let root = resolve_fs_root(state, session_id).await?;
    let relative = sanitize_relative_path(&path)?;
    Ok(root.join(relative))
}

pub(super) async fn resolve_fs_root(
    state: &Arc<AppState>,
    session_id: Option<&str>,
) -> Result<PathBuf, SandboxError> {
    if let Some(session_id) = session_id {
        let session = state
            .acp_runtime()
            .get_session(session_id)
            .await
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            })?;
        return Ok(PathBuf::from(session.cwd));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| SandboxError::InvalidRequest {
            message: "home directory unavailable".to_string(),
        })?;
    Ok(home)
}

pub(super) fn sanitize_relative_path(path: &StdPath) -> Result<PathBuf, SandboxError> {
    use std::path::Component;
    let mut sanitized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => sanitized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SandboxError::InvalidRequest {
                    message: format!("invalid relative path: {}", path.display()),
                });
            }
        }
    }
    Ok(sanitized)
}

pub(super) fn map_fs_error(path: &StdPath, err: std::io::Error) -> SandboxError {
    if err.kind() == std::io::ErrorKind::NotFound {
        SandboxError::InvalidRequest {
            message: format!("path not found: {}", path.display()),
        }
    } else {
        SandboxError::StreamError {
            message: err.to_string(),
        }
    }
}

pub(super) fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn content_type_is(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    media_type_eq(value, expected)
}

pub(super) fn accept_allows(headers: &HeaderMap, expected: &str) -> bool {
    let values = headers.get_all(header::ACCEPT);
    if values.iter().next().is_none() {
        return true;
    }

    values
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| media_type_matches(value, expected))
}

fn media_type_eq(raw: &str, expected: &str) -> bool {
    normalize_media_type(raw).as_deref() == Some(expected)
}

fn media_type_matches(raw: &str, expected: &str) -> bool {
    let Some(media) = normalize_media_type(raw) else {
        return false;
    };
    if media == expected || media == "*/*" {
        return true;
    }

    let Some((media_type, media_subtype)) = media.split_once('/') else {
        return false;
    };
    let Some((expected_type, _expected_subtype)) = expected.split_once('/') else {
        return false;
    };

    media_subtype == "*" && media_type == expected_type
}

fn normalize_media_type(raw: &str) -> Option<String> {
    let media = raw.split(';').next().unwrap_or_default().trim();
    if media.is_empty() {
        return None;
    }
    Some(media.to_ascii_lowercase())
}

pub(super) fn parse_last_event_id(headers: &HeaderMap) -> Result<Option<u64>, SandboxError> {
    let value = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok());

    match value {
        Some(value) if !value.trim().is_empty() => {
            value
                .trim()
                .parse::<u64>()
                .map(Some)
                .map_err(|_| SandboxError::InvalidRequest {
                    message: "Last-Event-ID must be a positive integer".to_string(),
                })
        }
        _ => Ok(None),
    }
}

pub(super) fn set_client_id_header(
    response: &mut Response,
    client_id: &str,
) -> Result<(), ApiError> {
    let header_value = HeaderValue::from_str(client_id).map_err(|err| {
        ApiError::Sandbox(SandboxError::StreamError {
            message: format!("invalid client id header value: {err}"),
        })
    })?;

    response
        .headers_mut()
        .insert(ACP_CLIENT_HEADER, header_value);
    Ok(())
}

pub(super) fn request_principal(state: &AppState, headers: &HeaderMap) -> String {
    if state.auth.token.is_some() {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "authenticated".to_string())
    } else {
        "anonymous".to_string()
    }
}

pub(super) fn problem_from_sandbox_error(error: &SandboxError) -> ProblemDetails {
    let mut problem = error.to_problem_details();

    match error {
        SandboxError::SessionNotFound { .. } => {
            problem.type_ = "urn:sandbox-agent:error:client_not_found".to_string();
            problem.title = "ACP client not found".to_string();
            problem.detail = Some("unknown ACP client id".to_string());
            problem.status = 404;
        }
        SandboxError::InvalidRequest { .. } => {
            problem.status = 400;
        }
        SandboxError::Timeout { .. } => {
            problem.status = 504;
        }
        _ => {}
    }

    problem
}
