use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::Router;
use futures::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Map, Value};
use tempfile::TempDir;

use sandbox_agent_agent_management::agents::{AgentId, AgentManager};
use sandbox_agent_agent_management::testing::{test_agents_from_env, TestAgentConfig};
use sandbox_agent_agent_credentials::ExtractedCredentials;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use tower::util::ServiceExt;
use tower_http::cors::CorsLayer;

const PROMPT: &str = "Reply with exactly the single word OK.";
const PERMISSION_PROMPT: &str = "List files in the current directory using available tools.";
const QUESTION_PROMPT: &str =
    "Use the AskUserQuestion tool to ask exactly one yes/no question, then wait for a reply. Do not answer yourself.";

struct TestApp {
    app: Router,
    _install_dir: TempDir,
}

impl TestApp {
    fn new() -> Self {
        Self::new_with_auth(AuthConfig::disabled())
    }

    fn new_with_auth(auth: AuthConfig) -> Self {
        Self::new_with_auth_and_cors(auth, None)
    }

    fn new_with_auth_and_cors(auth: AuthConfig, cors: Option<CorsLayer>) -> Self {
        let install_dir = tempfile::tempdir().expect("create temp install dir");
        let manager = AgentManager::new(install_dir.path())
            .expect("create agent manager");
        let state = AppState::new(auth, manager);
        let mut app = build_router(state);
        if let Some(cors) = cors {
            app = app.layer(cors);
        }
        Self {
            app,
            _install_dir: install_dir,
        }
    }
}

struct EnvGuard {
    saved: BTreeMap<String, Option<String>>,
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn apply_credentials(creds: &ExtractedCredentials) -> EnvGuard {
    let keys = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"];
    let mut saved = BTreeMap::new();
    for key in keys {
        saved.insert(key.to_string(), std::env::var(key).ok());
    }

    match creds.anthropic.as_ref() {
        Some(cred) => {
            std::env::set_var("ANTHROPIC_API_KEY", &cred.api_key);
            std::env::set_var("CLAUDE_API_KEY", &cred.api_key);
        }
        None => {
            std::env::remove_var("ANTHROPIC_API_KEY");
            std::env::remove_var("CLAUDE_API_KEY");
        }
    }

    match creds.openai.as_ref() {
        Some(cred) => {
            std::env::set_var("OPENAI_API_KEY", &cred.api_key);
            std::env::set_var("CODEX_API_KEY", &cred.api_key);
        }
        None => {
            std::env::remove_var("OPENAI_API_KEY");
            std::env::remove_var("CODEX_API_KEY");
        }
    }

    EnvGuard { saved }
}

async fn send_json(app: &Router, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    let body = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let request = builder.body(body).expect("request");
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("request handled");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).to_string()))
    };
    (status, value)
}

async fn send_request(app: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Bytes) {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("request handled");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    (status, headers, bytes)
}

async fn send_json_request(
    app: &Router,
    request: Request<Body>,
) -> (StatusCode, HeaderMap, Value) {
    let (status, headers, bytes) = send_request(app, request).await;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).to_string()))
    };
    (status, headers, value)
}

async fn send_status(app: &Router, method: Method, path: &str, body: Option<Value>) -> StatusCode {
    let (status, _) = send_json(app, method, path, body).await;
    status
}

async fn install_agent(app: &Router, agent: AgentId) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/agents/{}/install", agent.as_str()),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "install {agent}");
}

/// Returns the default permission mode for tests. OpenCode only supports "default",
/// while other agents support "bypass" which skips tool approval.
fn test_permission_mode(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Opencode => "default",
        _ => "bypass",
    }
}

async fn create_session(app: &Router, agent: AgentId, session_id: &str, permission_mode: &str) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": agent.as_str(),
            "permissionMode": permission_mode
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session {agent}");
}

async fn send_message(app: &Router, session_id: &str) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": PROMPT })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send message");
}

async fn poll_events_until(
    app: &Router,
    session_id: &str,
    timeout: Duration,
) -> Vec<Value> {
    let start = Instant::now();
    let mut offset = 0u64;
    let mut events = Vec::new();
    while start.elapsed() < timeout {
        let path = format!("/v1/sessions/{session_id}/events?offset={offset}&limit=200");
        let (status, payload) = send_json(app, Method::GET, &path, None).await;
        assert_eq!(status, StatusCode::OK, "poll events");
        let new_events = payload
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !new_events.is_empty() {
            if let Some(last) = new_events
                .last()
                .and_then(|event| event.get("sequence"))
                .and_then(Value::as_u64)
            {
                offset = last;
            }
            events.extend(new_events);
            if should_stop(&events) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    events
}

async fn read_sse_events(
    app: &Router,
    session_id: &str,
    timeout: Duration,
) -> Vec<Value> {
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/v1/sessions/{session_id}/events/sse?offset=0"))
        .body(Body::empty())
        .expect("sse request");
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK, "sse status");

    let mut stream = response.into_body().into_data_stream();
    let mut buffer = String::new();
    let mut events = Vec::new();
    let start = Instant::now();
    loop {
        let remaining = match timeout.checked_sub(start.elapsed()) {
            Some(remaining) if !remaining.is_zero() => remaining,
            _ => break,
        };
        let next = tokio::time::timeout(remaining, stream.next()).await;
        let chunk: Bytes = match next {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(_))) => break,
            Ok(None) => break,
            Err(_) => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find("\n\n") {
            let block = buffer[..idx].to_string();
            buffer = buffer[idx + 2..].to_string();
            if let Some(event) = parse_sse_block(&block) {
                events.push(event);
            }
        }
        if should_stop(&events) {
            break;
        }
    }
    events
}

async fn read_turn_stream_events(
    app: &Router,
    session_id: &str,
    timeout: Duration,
) -> Vec<Value> {
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!("/v1/sessions/{session_id}/messages/stream"))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "message": PROMPT }).to_string()))
        .expect("turn stream request");
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("turn stream response");
    assert_eq!(response.status(), StatusCode::OK, "turn stream status");

    let mut stream = response.into_body().into_data_stream();
    let mut buffer = String::new();
    let mut events = Vec::new();
    let start = Instant::now();
    let mut ended = false;
    loop {
        let remaining = match timeout.checked_sub(start.elapsed()) {
            Some(remaining) if !remaining.is_zero() => remaining,
            _ => break,
        };
        let next = tokio::time::timeout(remaining, stream.next()).await;
        let chunk: Bytes = match next {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(Some(Err(_))) => break,
            Ok(None) => {
                ended = true;
                break;
            }
            Err(_) => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find("\n\n") {
            let block = buffer[..idx].to_string();
            buffer = buffer[idx + 2..].to_string();
            if let Some(event) = parse_sse_block(&block) {
                events.push(event);
            }
        }
    }
    assert!(ended, "turn stream did not close before timeout");
    events
}

fn parse_sse_block(block: &str) -> Option<Value> {
    let mut data_lines = Vec::new();
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    let data = data_lines.join("\n");
    serde_json::from_str(&data).ok()
}

fn should_stop(events: &[Value]) -> bool {
    events.iter().any(|event| is_assistant_message(event) || is_error_event(event))
}

fn is_assistant_message(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|event_type| event_type == "item.completed")
        .unwrap_or(false)
        && event
            .get("data")
            .and_then(|data| data.get("item"))
            .and_then(|item| item.get("role"))
            .and_then(Value::as_str)
            .map(|role| role == "assistant")
            .unwrap_or(false)
}

fn is_error_event(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("error") | Some("agent.unparsed")
    )
}

fn is_unparsed_event(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value == "agent.unparsed")
        .unwrap_or(false)
}

fn is_permission_event(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value == "permission.requested")
        .unwrap_or(false)
}

fn is_question_event(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value == "question.requested")
        .unwrap_or(false)
}

fn truncate_permission_events(events: &[Value]) -> Vec<Value> {
    if let Some(idx) = events.iter().position(is_permission_event) {
        return events[..=idx].to_vec();
    }
    if let Some(idx) = events.iter().position(is_assistant_message) {
        return events[..=idx].to_vec();
    }
    events.to_vec()
}

fn truncate_question_events(events: &[Value]) -> Vec<Value> {
    if let Some(idx) = events.iter().position(is_question_event) {
        return events[..=idx].to_vec();
    }
    if let Some(idx) = events.iter().position(is_assistant_message) {
        return events[..=idx].to_vec();
    }
    events.to_vec()
}

fn normalize_events(events: &[Value]) -> Value {
    assert!(
        !events.iter().any(is_unparsed_event),
        "agent.unparsed event encountered"
    );
    let normalized = events
        .iter()
        .enumerate()
        .map(|(idx, event)| normalize_event(event, idx + 1))
        .collect::<Vec<_>>();
    Value::Array(normalized)
}

fn truncate_after_first_stop(events: &[Value]) -> Vec<Value> {
    if let Some(idx) = events
        .iter()
        .position(|event| is_assistant_message(event) || is_error_event(event))
    {
        return events[..=idx].to_vec();
    }
    events.to_vec()
}

fn normalize_event(event: &Value, seq: usize) -> Value {
    let mut map = Map::new();
    map.insert("seq".to_string(), Value::Number(seq.into()));
    if let Some(event_type) = event.get("type").and_then(Value::as_str) {
        map.insert("type".to_string(), Value::String(event_type.to_string()));
    }
    if let Some(source) = event.get("source").and_then(Value::as_str) {
        map.insert("source".to_string(), Value::String(source.to_string()));
    }
    if let Some(synthetic) = event.get("synthetic").and_then(Value::as_bool) {
        map.insert("synthetic".to_string(), Value::Bool(synthetic));
    }

    let data = event.get("data").unwrap_or(&Value::Null);
    match event.get("type").and_then(Value::as_str).unwrap_or("") {
        "session.started" => {
            map.insert("session".to_string(), Value::String("started".to_string()));
            if data.get("metadata").is_some() {
                map.insert("metadata".to_string(), Value::Bool(true));
            }
        }
        "session.ended" => {
            map.insert("session".to_string(), Value::String("ended".to_string()));
            map.insert("ended".to_string(), normalize_session_end(data));
        }
        "item.started" | "item.completed" => {
            if let Some(item) = data.get("item") {
                map.insert("item".to_string(), normalize_item(item));
            }
        }
        "item.delta" => {
            let mut delta = Map::new();
            if data.get("item_id").is_some() {
                delta.insert("item_id".to_string(), Value::String("<redacted>".to_string()));
            }
            if data.get("native_item_id").is_some() {
                delta.insert("native_item_id".to_string(), Value::String("<redacted>".to_string()));
            }
            if data.get("delta").is_some() {
                delta.insert("delta".to_string(), Value::String("<redacted>".to_string()));
            }
            map.insert("delta".to_string(), Value::Object(delta));
        }
        "permission.requested" | "permission.resolved" => {
            map.insert("permission".to_string(), normalize_permission(data));
        }
        "question.requested" | "question.resolved" => {
            map.insert("question".to_string(), normalize_question(data));
        }
        "error" => {
            map.insert("error".to_string(), normalize_error(data));
        }
        "agent.unparsed" => {
            map.insert("unparsed".to_string(), Value::Bool(true));
        }
        _ => {}
    }
    Value::Object(map)
}

fn normalize_item(item: &Value) -> Value {
    let mut map = Map::new();
    if let Some(kind) = item.get("kind").and_then(Value::as_str) {
        map.insert("kind".to_string(), Value::String(kind.to_string()));
    }
    if let Some(role) = item.get("role").and_then(Value::as_str) {
        map.insert("role".to_string(), Value::String(role.to_string()));
    }
    if let Some(status) = item.get("status").and_then(Value::as_str) {
        map.insert("status".to_string(), Value::String(status.to_string()));
    }
    if let Some(content) = item.get("content").and_then(Value::as_array) {
        let types = content
            .iter()
            .filter_map(|part| part.get("type").and_then(Value::as_str))
            .map(|value| Value::String(value.to_string()))
            .collect::<Vec<_>>();
        map.insert("content_types".to_string(), Value::Array(types));
    }
    Value::Object(map)
}

fn normalize_session_end(data: &Value) -> Value {
    let mut map = Map::new();
    if let Some(reason) = data.get("reason").and_then(Value::as_str) {
        map.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    if let Some(terminated_by) = data.get("terminated_by").and_then(Value::as_str) {
        map.insert("terminated_by".to_string(), Value::String(terminated_by.to_string()));
    }
    Value::Object(map)
}

fn normalize_error(error: &Value) -> Value {
    let mut map = Map::new();
    if let Some(code) = error.get("code").and_then(Value::as_str) {
        map.insert("code".to_string(), Value::String(code.to_string()));
    }
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        map.insert("message".to_string(), Value::String(message.to_string()));
    }
    Value::Object(map)
}

fn normalize_question(question: &Value) -> Value {
    let mut map = Map::new();
    if question.get("question_id").is_some() {
        map.insert("id".to_string(), Value::String("<redacted>".to_string()));
    }
    if let Some(options) = question.get("options").and_then(Value::as_array) {
        map.insert("options".to_string(), Value::Number(options.len().into()));
    }
    if let Some(status) = question.get("status").and_then(Value::as_str) {
        map.insert("status".to_string(), Value::String(status.to_string()));
    }
    Value::Object(map)
}

fn normalize_permission(permission: &Value) -> Value {
    let mut map = Map::new();
    if permission.get("permission_id").is_some() {
        map.insert("id".to_string(), Value::String("<redacted>".to_string()));
    }
    if let Some(value) = permission.get("action").and_then(Value::as_str) {
        map.insert("action".to_string(), Value::String(value.to_string()));
    }
    if let Some(status) = permission.get("status").and_then(Value::as_str) {
        map.insert("status".to_string(), Value::String(status.to_string()));
    }
    Value::Object(map)
}

fn normalize_agent_list(value: &Value) -> Value {
    let agents = value
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut normalized = Vec::new();
    for agent in agents {
        let mut map = Map::new();
        if let Some(id) = agent.get("id").and_then(Value::as_str) {
            map.insert("id".to_string(), Value::String(id.to_string()));
        }
        // Skip installed/version/path fields - they depend on local environment
        // and make snapshots non-deterministic
        normalized.push(Value::Object(map));
    }
    normalized.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .cmp(&b.get("id").and_then(Value::as_str))
    });
    json!({ "agents": normalized })
}

fn normalize_agent_modes(value: &Value) -> Value {
    let modes = value
        .get("modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut normalized = Vec::new();
    for mode in modes {
        let mut map = Map::new();
        if let Some(id) = mode.get("id").and_then(Value::as_str) {
            map.insert("id".to_string(), Value::String(id.to_string()));
        }
        if let Some(name) = mode.get("name").and_then(Value::as_str) {
            map.insert("name".to_string(), Value::String(name.to_string()));
        }
        if mode.get("description").is_some() {
            map.insert("description".to_string(), Value::Bool(true));
        }
        normalized.push(Value::Object(map));
    }
    normalized.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .cmp(&b.get("id").and_then(Value::as_str))
    });
    json!({ "modes": normalized })
}

fn normalize_sessions(value: &Value) -> Value {
    let sessions = value
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // For the global sessions list snapshot, we just verify the count and structure
    // since the specific agents/sessions vary based on test configuration
    json!({
        "sessionCount": sessions.len(),
        "hasExpectedFields": sessions.iter().all(|s| {
            s.get("sessionId").is_some()
                && s.get("agent").is_some()
                && s.get("agentMode").is_some()
                && s.get("permissionMode").is_some()
                && s.get("ended").is_some()
        })
    })
}

fn normalize_create_session(value: &Value) -> Value {
    let mut map = Map::new();
    if let Some(healthy) = value.get("healthy").and_then(Value::as_bool) {
        map.insert("healthy".to_string(), Value::Bool(healthy));
    }
    if value.get("nativeSessionId").is_some() {
        map.insert("nativeSessionId".to_string(), Value::String("<redacted>".to_string()));
    }
    if let Some(error) = value.get("error") {
        map.insert("error".to_string(), error.clone());
    }
    Value::Object(map)
}

fn normalize_health(value: &Value) -> Value {
    let mut map = Map::new();
    if let Some(status) = value.get("status").and_then(Value::as_str) {
        map.insert("status".to_string(), Value::String(status.to_string()));
    }
    Value::Object(map)
}

fn snapshot_status(status: StatusCode) -> Value {
    json!({ "status": status.as_u16() })
}

fn snapshot_cors(status: StatusCode, headers: &HeaderMap) -> Value {
    let mut map = Map::new();
    map.insert("status".to_string(), Value::Number(status.as_u16().into()));
    for name in [
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::ACCESS_CONTROL_ALLOW_METHODS,
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        header::VARY,
    ] {
        if let Some(value) = headers.get(&name) {
            map.insert(
                name.as_str().to_string(),
                Value::String(value.to_str().unwrap_or("<invalid>").to_string()),
            );
        }
    }
    Value::Object(map)
}

fn snapshot_name(prefix: &str, agent: Option<AgentId>) -> String {
    match agent {
        Some(agent) => format!("{prefix}_{}", agent.as_str()),
        None => format!("{prefix}_global"),
    }
}


async fn poll_events_until_match<F>(
    app: &Router,
    session_id: &str,
    timeout: Duration,
    stop: F,
) -> Vec<Value>
where
    F: Fn(&[Value]) -> bool,
{
    let start = Instant::now();
    let mut offset = 0u64;
    let mut events = Vec::new();
    while start.elapsed() < timeout {
        let path = format!("/v1/sessions/{session_id}/events?offset={offset}&limit=200");
        let (status, payload) = send_json(app, Method::GET, &path, None).await;
        assert_eq!(status, StatusCode::OK, "poll events");
        let new_events = payload
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if !new_events.is_empty() {
            if let Some(last) = new_events
                .last()
                .and_then(|event| event.get("sequence"))
                .and_then(Value::as_u64)
            {
                offset = last;
            }
            events.extend(new_events);
            if stop(&events) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    events
}

fn find_permission_id(events: &[Value]) -> Option<String> {
    events
        .iter()
        .find_map(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .filter(|value| *value == "permission.requested")
                .and_then(|_| event.get("data"))
                .and_then(|data| data.get("permission_id"))
                .and_then(Value::as_str)
                .map(|id| id.to_string())
        })
}

fn find_question_id_and_answers(events: &[Value]) -> Option<(String, Vec<Vec<String>>)> {
    let question = events.iter().find_map(|event| {
        let event_type = event.get("type").and_then(Value::as_str)?;
        if event_type != "question.requested" {
            return None;
        }
        event.get("data").cloned()
    })?;
    let id = question.get("question_id").and_then(Value::as_str)?.to_string();
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut answers = Vec::new();
    if let Some(option) = options.first().and_then(Value::as_str) {
        answers.push(vec![option.to_string()]);
    } else {
        answers.push(Vec::new());
    }
    Some((id, answers))
}

async fn run_http_events_snapshot(app: &Router, config: &TestAgentConfig) {
    let _guard = apply_credentials(&config.credentials);
    install_agent(app, config.agent).await;

    let session_id = format!("session-{}", config.agent.as_str());
    create_session(app, config.agent, &session_id, test_permission_mode(config.agent)).await;
    send_message(app, &session_id).await;

    let events = poll_events_until(app, &session_id, Duration::from_secs(120)).await;
    let events = truncate_after_first_stop(&events);
    assert!(
        !events.is_empty(),
        "no events collected for {}",
        config.agent
    );
    assert!(
        should_stop(&events),
        "timed out waiting for assistant/error event for {}",
        config.agent
    );
    let normalized = normalize_events(&events);
    insta::with_settings!({
        snapshot_suffix => snapshot_name("http_events", Some(config.agent)),
    }, {
        insta::assert_yaml_snapshot!(normalized);
    });
}

async fn run_sse_events_snapshot(app: &Router, config: &TestAgentConfig) {
    let _guard = apply_credentials(&config.credentials);
    install_agent(app, config.agent).await;

    let session_id = format!("sse-{}", config.agent.as_str());
    create_session(app, config.agent, &session_id, test_permission_mode(config.agent)).await;

    let sse_task = {
        let app = app.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move {
            read_sse_events(&app, &session_id, Duration::from_secs(120)).await
        })
    };

    send_message(app, &session_id).await;

    let events = sse_task.await.expect("sse task");
    let events = truncate_after_first_stop(&events);
    assert!(
        !events.is_empty(),
        "no sse events collected for {}",
        config.agent
    );
    assert!(
        should_stop(&events),
        "timed out waiting for assistant/error event for {}",
        config.agent
    );
    let normalized = normalize_events(&events);
    insta::with_settings!({
        snapshot_suffix => snapshot_name("sse_events", Some(config.agent)),
    }, {
        insta::assert_yaml_snapshot!(normalized);
    });
}

async fn run_turn_stream_check(app: &Router, config: &TestAgentConfig) {
    let _guard = apply_credentials(&config.credentials);
    install_agent(app, config.agent).await;

    let session_id = format!("turn-{}", config.agent.as_str());
    create_session(app, config.agent, &session_id, test_permission_mode(config.agent)).await;

    let events = read_turn_stream_events(app, &session_id, Duration::from_secs(120)).await;
    let events = truncate_after_first_stop(&events);
    assert!(
        !events.is_empty(),
        "no turn stream events collected for {}",
        config.agent
    );
    assert!(
        should_stop(&events),
        "timed out waiting for assistant/error event for {}",
        config.agent
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_snapshots() {
    let token = "test-token";
    let app = TestApp::new_with_auth(AuthConfig::with_token(token.to_string()));

    let (status, payload) = send_json(&app.app, Method::GET, "/v1/health", None).await;
    assert_eq!(status, StatusCode::OK, "health should be public");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_health_public", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": normalize_health(&payload),
        }));
    });

    let (status, payload) = send_json(&app.app, Method::GET, "/v1/agents", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "missing token should 401");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_missing_token", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": payload,
        }));
    });

    let request = Request::builder()
        .method(Method::GET)
        .uri("/v1/agents")
        .header(header::AUTHORIZATION, "Bearer wrong-token")
        .body(Body::empty())
        .expect("auth invalid request");
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "invalid token should 401");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_invalid_token", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": payload,
        }));
    });

    let request = Request::builder()
        .method(Method::GET)
        .uri("/v1/agents")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .expect("auth valid request");
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "valid token should allow request");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("auth_valid_token", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "status": status.as_u16(),
            "payload": normalize_agent_list(&payload),
        }));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cors_snapshots() {
    let cors = CorsLayer::new()
        .allow_origin(vec![HeaderValue::from_static("http://example.com")])
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_credentials(true);
    let app = TestApp::new_with_auth_and_cors(AuthConfig::disabled(), Some(cors));

    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/v1/health")
        .header(header::ORIGIN, "http://example.com")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type",
        )
        .body(Body::empty())
        .expect("cors preflight request");
    let (status, headers, _payload) = send_request(&app.app, preflight).await;
    insta::with_settings!({
        snapshot_suffix => snapshot_name("cors_preflight", None),
    }, {
        insta::assert_yaml_snapshot!(snapshot_cors(status, &headers));
    });

    let actual = Request::builder()
        .method(Method::GET)
        .uri("/v1/health")
        .header(header::ORIGIN, "http://example.com")
        .body(Body::empty())
        .expect("cors actual request");
    let (status, headers, payload) = send_json_request(&app.app, actual).await;
    assert_eq!(status, StatusCode::OK, "cors actual request should succeed");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("cors_actual", None),
    }, {
        insta::assert_yaml_snapshot!(json!({
            "cors": snapshot_cors(status, &headers),
            "payload": normalize_health(&payload),
        }));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn api_endpoints_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();

    let (status, health) = send_json(&app.app, Method::GET, "/v1/health", None).await;
    assert_eq!(status, StatusCode::OK, "health status");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("health", None),
    }, {
        insta::assert_yaml_snapshot!(normalize_health(&health));
    });

    // List agents (just verify the API returns correct agent IDs, not install state)
    let (status, agents) = send_json(&app.app, Method::GET, "/v1/agents", None).await;
    assert_eq!(status, StatusCode::OK, "agents list");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("agents_list", None),
    }, {
        insta::assert_yaml_snapshot!(normalize_agent_list(&agents));
    });

    // Install agents (ensure they're available for subsequent tests)
    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/agents/{}/install", config.agent.as_str()),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "install agent");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("agent_install", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(snapshot_status(status));
        });
    }

    let mut session_ids = Vec::new();
    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        let (status, modes) = send_json(
            &app.app,
            Method::GET,
            &format!("/v1/agents/{}/modes", config.agent.as_str()),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "agent modes");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("agent_modes", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_agent_modes(&modes));
        });

        let session_id = format!("snapshot-{}", config.agent.as_str());
        let permission_mode = test_permission_mode(config.agent);
        let (status, created) = send_json(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{session_id}"),
            Some(json!({
                "agent": config.agent.as_str(),
                "permissionMode": permission_mode
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "create session");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("create_session", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_create_session(&created));
        });
        session_ids.push((config.agent, session_id));
    }

    let (status, sessions) = send_json(&app.app, Method::GET, "/v1/sessions", None).await;
    assert_eq!(status, StatusCode::OK, "list sessions");
    insta::with_settings!({
        snapshot_suffix => snapshot_name("sessions_list", None),
    }, {
        insta::assert_yaml_snapshot!(normalize_sessions(&sessions));
    });

    for (agent, session_id) in &session_ids {
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{session_id}/messages"),
            Some(json!({ "message": PROMPT })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "send message");
        insta::with_settings!({
            snapshot_suffix => snapshot_name("send_message", Some(*agent)),
        }, {
            insta::assert_yaml_snapshot!(snapshot_status(status));
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_flow_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();

    for config in &configs {
        // OpenCode doesn't support "plan" permission mode required for approval flows
        if config.agent == AgentId::Opencode {
            continue;
        }

        let _guard = apply_credentials(&config.credentials);
        install_agent(&app.app, config.agent).await;

        let permission_session = format!("perm-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &permission_session, "plan").await;
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{permission_session}/messages"),
            Some(json!({ "message": PERMISSION_PROMPT })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "send permission prompt");

        let permission_events = poll_events_until_match(
            &app.app,
            &permission_session,
            Duration::from_secs(120),
            |events| find_permission_id(events).is_some() || should_stop(events),
        )
        .await;
        let permission_events = truncate_permission_events(&permission_events);
        insta::with_settings!({
            snapshot_suffix => snapshot_name("permission_events", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_events(&permission_events));
        });

        if let Some(permission_id) = find_permission_id(&permission_events) {
            let status = send_status(
                &app.app,
                Method::POST,
                &format!(
                    "/v1/sessions/{permission_session}/permissions/{permission_id}/reply"
                ),
                Some(json!({ "reply": "once" })),
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT, "reply permission");
            insta::with_settings!({
                snapshot_suffix => snapshot_name("permission_reply", Some(config.agent)),
            }, {
                insta::assert_yaml_snapshot!(snapshot_status(status));
            });
        } else {
            let (status, payload) = send_json(
                &app.app,
                Method::POST,
                &format!(
                    "/v1/sessions/{permission_session}/permissions/missing-permission/reply"
                ),
                Some(json!({ "reply": "once" })),
            )
            .await;
            assert!(!status.is_success(), "missing permission id should error");
            insta::with_settings!({
                snapshot_suffix => snapshot_name("permission_reply_missing", Some(config.agent)),
            }, {
                insta::assert_yaml_snapshot!(json!({
                    "status": status.as_u16(),
                    "payload": payload,
                }));
            });
        }

        let question_reply_session = format!("question-reply-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &question_reply_session, "plan").await;
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{question_reply_session}/messages"),
            Some(json!({ "message": QUESTION_PROMPT })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "send question prompt");

        let question_events = poll_events_until_match(
            &app.app,
            &question_reply_session,
            Duration::from_secs(120),
            |events| find_question_id_and_answers(events).is_some() || should_stop(events),
        )
        .await;
        let question_events = truncate_question_events(&question_events);
        insta::with_settings!({
            snapshot_suffix => snapshot_name("question_reply_events", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_events(&question_events));
        });

        if let Some((question_id, answers)) = find_question_id_and_answers(&question_events) {
            let status = send_status(
                &app.app,
                Method::POST,
                &format!(
                    "/v1/sessions/{question_reply_session}/questions/{question_id}/reply"
                ),
                Some(json!({ "answers": answers })),
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT, "reply question");
            insta::with_settings!({
                snapshot_suffix => snapshot_name("question_reply", Some(config.agent)),
            }, {
                insta::assert_yaml_snapshot!(snapshot_status(status));
            });
        } else {
            let (status, payload) = send_json(
                &app.app,
                Method::POST,
                &format!(
                    "/v1/sessions/{question_reply_session}/questions/missing-question/reply"
                ),
                Some(json!({ "answers": [] })),
            )
            .await;
            assert!(!status.is_success(), "missing question id should error");
            insta::with_settings!({
                snapshot_suffix => snapshot_name("question_reply_missing", Some(config.agent)),
            }, {
                insta::assert_yaml_snapshot!(json!({
                    "status": status.as_u16(),
                    "payload": payload,
                }));
            });
        }

        let question_reject_session = format!("question-reject-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &question_reject_session, "plan").await;
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{question_reject_session}/messages"),
            Some(json!({ "message": QUESTION_PROMPT })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "send question prompt reject");

        let reject_events = poll_events_until_match(
            &app.app,
            &question_reject_session,
            Duration::from_secs(120),
            |events| find_question_id_and_answers(events).is_some() || should_stop(events),
        )
        .await;
        let reject_events = truncate_question_events(&reject_events);
        insta::with_settings!({
            snapshot_suffix => snapshot_name("question_reject_events", Some(config.agent)),
        }, {
            insta::assert_yaml_snapshot!(normalize_events(&reject_events));
        });

        if let Some((question_id, _)) = find_question_id_and_answers(&reject_events) {
            let status = send_status(
                &app.app,
                Method::POST,
                &format!(
                    "/v1/sessions/{question_reject_session}/questions/{question_id}/reject"
                ),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT, "reject question");
            insta::with_settings!({
                snapshot_suffix => snapshot_name("question_reject", Some(config.agent)),
            }, {
                insta::assert_yaml_snapshot!(snapshot_status(status));
            });
        } else {
            let (status, payload) = send_json(
                &app.app,
                Method::POST,
                &format!(
                    "/v1/sessions/{question_reject_session}/questions/missing-question/reject"
                ),
                None,
            )
            .await;
            assert!(!status.is_success(), "missing question id reject should error");
            insta::with_settings!({
                snapshot_suffix => snapshot_name("question_reject_missing", Some(config.agent)),
            }, {
                insta::assert_yaml_snapshot!(json!({
                    "status": status.as_u16(),
                    "payload": payload,
                }));
            });
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_events_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    for config in &configs {
        // OpenCode's embedded bun hangs when installing plugins, blocking SSE event streaming.
        // See: https://github.com/opencode-ai/opencode/issues/XXX
        if config.agent == AgentId::Opencode {
            continue;
        }
        run_http_events_snapshot(&app.app, config).await;
    }
}

async fn run_concurrency_snapshot(app: &Router, config: &TestAgentConfig) {
    let _guard = apply_credentials(&config.credentials);
    install_agent(app, config.agent).await;

    let session_a = format!("concurrent-a-{}", config.agent.as_str());
    let session_b = format!("concurrent-b-{}", config.agent.as_str());
    let perm_mode = test_permission_mode(config.agent);
    create_session(app, config.agent, &session_a, perm_mode).await;
    create_session(app, config.agent, &session_b, perm_mode).await;

    let app_a = app.clone();
    let app_b = app.clone();
    let send_a = send_message(&app_a, &session_a);
    let send_b = send_message(&app_b, &session_b);
    tokio::join!(send_a, send_b);

    let app_a = app.clone();
    let app_b = app.clone();
    let poll_a = poll_events_until(&app_a, &session_a, Duration::from_secs(120));
    let poll_b = poll_events_until(&app_b, &session_b, Duration::from_secs(120));
    let (events_a, events_b) = tokio::join!(poll_a, poll_b);
    let events_a = truncate_after_first_stop(&events_a);
    let events_b = truncate_after_first_stop(&events_b);

    assert!(
        !events_a.is_empty(),
        "no events collected for concurrent session a {}",
        config.agent
    );
    assert!(
        !events_b.is_empty(),
        "no events collected for concurrent session b {}",
        config.agent
    );
    assert!(
        should_stop(&events_a),
        "timed out waiting for assistant/error event for concurrent session a {}",
        config.agent
    );
    assert!(
        should_stop(&events_b),
        "timed out waiting for assistant/error event for concurrent session b {}",
        config.agent
    );

    let snapshot = json!({
        "session_a": normalize_events(&events_a),
        "session_b": normalize_events(&events_b),
    });
    insta::with_settings!({
        snapshot_suffix => snapshot_name("concurrency_events", Some(config.agent)),
    }, {
        insta::assert_yaml_snapshot!(snapshot);
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sse_events_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    for config in &configs {
        // OpenCode's embedded bun hangs when installing plugins, blocking SSE event streaming.
        // See: https://github.com/opencode-ai/opencode/issues/XXX
        if config.agent == AgentId::Opencode {
            continue;
        }
        run_sse_events_snapshot(&app.app, config).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_stream_route() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    for config in &configs {
        // OpenCode's embedded bun hangs when installing plugins, blocking SSE event streaming.
        // See: https://github.com/opencode-ai/opencode/issues/XXX
        if config.agent == AgentId::Opencode {
            continue;
        }
        run_turn_stream_check(&app.app, config).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrency_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    for config in &configs {
        // OpenCode's embedded bun hangs when installing plugins, blocking SSE event streaming.
        // See: https://github.com/opencode-ai/opencode/issues/XXX
        if config.agent == AgentId::Opencode {
            continue;
        }
        run_concurrency_snapshot(&app.app, config).await;
    }
}
