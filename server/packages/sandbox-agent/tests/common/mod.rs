use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::util::ServiceExt;

use sandbox_agent::router::{build_router, AgentCapabilities, AgentListResponse, AuthConfig};
use sandbox_agent_agent_credentials::ExtractedCredentials;
use sandbox_agent_agent_management::agents::{AgentId, AgentManager};

pub const PROMPT: &str = "Reply with exactly the single word OK.";
pub const TOOL_PROMPT: &str =
    "Use the bash tool to run `ls` in the current directory. Do not answer without using the tool.";
pub const QUESTION_PROMPT: &str =
    "Call the AskUserQuestion tool with exactly one yes/no question and wait for a reply. Do not answer yourself.";

pub struct TestApp {
    pub app: Router,
    _install_dir: TempDir,
}

impl TestApp {
    pub fn new() -> Self {
        let install_dir = tempfile::tempdir().expect("create temp install dir");
        let manager = AgentManager::new(install_dir.path()).expect("create agent manager");
        let state = sandbox_agent::router::AppState::new(AuthConfig::disabled(), manager);
        let app = build_router(state);
        Self {
            app,
            _install_dir: install_dir,
        }
    }
}

pub struct EnvGuard {
    saved: HashMap<String, Option<String>>,
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

pub fn apply_credentials(creds: &ExtractedCredentials) -> EnvGuard {
    let keys = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
    ];
    let mut saved = HashMap::new();
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

pub async fn send_json(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(
            body.map(|value| value.to_string()).unwrap_or_default(),
        ))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let payload = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, payload)
}

pub async fn send_status(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> StatusCode {
    let (status, _) = send_json(app, method, path, body).await;
    status
}

pub async fn install_agent(app: &Router, agent: AgentId) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/agents/{}/install", agent.as_str()),
        Some(json!({})),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "install agent {}",
        agent.as_str()
    );
}

pub async fn create_session(app: &Router, agent: AgentId, session_id: &str, permission_mode: &str) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": agent.as_str(),
            "permissionMode": permission_mode,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");
}

pub async fn create_session_with_mode(
    app: &Router,
    agent: AgentId,
    session_id: &str,
    agent_mode: &str,
    permission_mode: &str,
) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": agent.as_str(),
            "agentMode": agent_mode,
            "permissionMode": permission_mode,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");
}

pub fn test_permission_mode(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Opencode | AgentId::Pi => "default",
        _ => "bypass",
    }
}

pub async fn send_message(app: &Router, session_id: &str, message: &str) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": message })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send message");
}

pub async fn poll_events_until<F>(
    app: &Router,
    session_id: &str,
    timeout: Duration,
    mut stop: F,
) -> Vec<Value>
where
    F: FnMut(&[Value]) -> bool,
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

pub async fn fetch_capabilities(app: &Router) -> HashMap<String, AgentCapabilities> {
    let (status, payload) = send_json(app, Method::GET, "/v1/agents", None).await;
    assert_eq!(status, StatusCode::OK, "list agents");
    let response: AgentListResponse = serde_json::from_value(payload).expect("agents payload");
    response
        .agents
        .into_iter()
        .map(|agent| (agent.id, agent.capabilities))
        .collect()
}

pub fn has_event_type(events: &[Value], event_type: &str) -> bool {
    events
        .iter()
        .any(|event| event.get("type").and_then(Value::as_str) == Some(event_type))
}

pub fn find_assistant_message_item(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("item.completed") {
            return None;
        }
        let item = event.get("data")?.get("item")?;
        let role = item.get("role")?.as_str()?;
        let kind = item.get("kind")?.as_str()?;
        if role != "assistant" || kind != "message" {
            return None;
        }
        item.get("item_id")?.as_str().map(|id| id.to_string())
    })
}

pub fn find_permission_id(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("permission.requested") {
            return None;
        }
        event
            .get("data")
            .and_then(|data| data.get("permission_id"))
            .and_then(Value::as_str)
            .map(|id| id.to_string())
    })
}

pub fn find_question_id(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("question.requested") {
            return None;
        }
        event
            .get("data")
            .and_then(|data| data.get("question_id"))
            .and_then(Value::as_str)
            .map(|id| id.to_string())
    })
}

pub fn find_first_answer(events: &[Value]) -> Option<Vec<Vec<String>>> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("question.requested") {
            return None;
        }
        let options = event
            .get("data")
            .and_then(|data| data.get("options"))
            .and_then(Value::as_array)?;
        let option = options.first()?.as_str()?.to_string();
        Some(vec![vec![option]])
    })
}

pub fn find_tool_call(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("item.started")
            && event.get("type").and_then(Value::as_str) != Some("item.completed")
        {
            return None;
        }
        let item = event.get("data")?.get("item")?;
        let kind = item.get("kind")?.as_str()?;
        if kind != "tool_call" {
            return None;
        }
        item.get("item_id")?.as_str().map(|id| id.to_string())
    })
}

pub fn has_tool_result(events: &[Value]) -> bool {
    events.iter().any(|event| {
        if event.get("type").and_then(Value::as_str) != Some("item.completed") {
            return false;
        }
        let item = match event.get("data").and_then(|data| data.get("item")) {
            Some(item) => item,
            None => return false,
        };
        item.get("kind").and_then(Value::as_str) == Some("tool_result")
    })
}
