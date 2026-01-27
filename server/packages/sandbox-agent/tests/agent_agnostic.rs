use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::util::ServiceExt;

use sandbox_agent_agent_management::agents::{AgentId, AgentManager};
use sandbox_agent_agent_management::testing::test_agents_from_env;
use sandbox_agent_agent_credentials::ExtractedCredentials;
use sandbox_agent::router::{
    build_router,
    AgentCapabilities,
    AgentListResponse,
    AuthConfig,
};

const PROMPT: &str = "Reply with exactly the single word OK.";
const TOOL_PROMPT: &str =
    "Use the bash tool to run `ls` in the current directory. Do not answer without using the tool.";
const QUESTION_PROMPT: &str =
    "Call the AskUserQuestion tool with exactly one yes/no question and wait for a reply. Do not answer yourself.";

/// Agent-agnostic event sequence tests.
///
/// These tests assert that the universal schema output is valid and consistent
/// across agents, and they use capability flags from /v1/agents to skip
/// unsupported flows.

struct TestApp {
    app: Router,
    _install_dir: TempDir,
}

impl TestApp {
    fn new() -> Self {
        let install_dir = tempfile::tempdir().expect("create temp install dir");
        let manager = AgentManager::new(install_dir.path())
            .expect("create agent manager");
        let state = sandbox_agent::router::AppState::new(AuthConfig::disabled(), manager);
        let app = build_router(state);
        Self {
            app,
            _install_dir: install_dir,
        }
    }
}

struct EnvGuard {
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

fn apply_credentials(creds: &ExtractedCredentials) -> EnvGuard {
    let keys = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"];
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

async fn send_json(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.map(|value| value.to_string()).unwrap_or_default()))
        .expect("request");
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("response");
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
    assert_eq!(status, StatusCode::NO_CONTENT, "install agent {}", agent.as_str());
}

async fn create_session(app: &Router, agent: AgentId, session_id: &str, permission_mode: &str) {
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

async fn create_session_with_mode(
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

fn test_permission_mode(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Opencode => "default",
        _ => "bypass",
    }
}

async fn send_message(app: &Router, session_id: &str, message: &str) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": message })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send message");
}

async fn poll_events_until<F>(
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

async fn fetch_capabilities(app: &Router) -> HashMap<String, AgentCapabilities> {
    let (status, payload) = send_json(app, Method::GET, "/v1/agents", None).await;
    assert_eq!(status, StatusCode::OK, "list agents");
    let response: AgentListResponse = serde_json::from_value(payload).expect("agents payload");
    response
        .agents
        .into_iter()
        .map(|agent| (agent.id, agent.capabilities))
        .collect()
}

fn has_event_type(events: &[Value], event_type: &str) -> bool {
    events
        .iter()
        .any(|event| event.get("type").and_then(Value::as_str) == Some(event_type))
}

fn find_assistant_message_item(events: &[Value]) -> Option<String> {
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

fn event_sequence(event: &Value) -> Option<u64> {
    event.get("sequence").and_then(Value::as_u64)
}

fn find_item_event_seq(events: &[Value], event_type: &str, item_id: &str) -> Option<u64> {
    events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some(event_type) {
            return None;
        }
        match event_type {
            "item.delta" => {
                let data = event.get("data")?;
                let id = data.get("item_id")?.as_str()?;
                if id == item_id {
                    event_sequence(event)
                } else {
                    None
                }
            }
            _ => {
                let item = event.get("data")?.get("item")?;
                let id = item.get("item_id")?.as_str()?;
                if id == item_id {
                    event_sequence(event)
                } else {
                    None
                }
            }
        }
    })
}

fn find_permission_id(events: &[Value]) -> Option<String> {
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

fn find_question_id(events: &[Value]) -> Option<String> {
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

fn find_first_answer(events: &[Value]) -> Option<Vec<Vec<String>>> {
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

fn find_tool_call(events: &[Value]) -> Option<String> {
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

fn has_tool_result(events: &[Value]) -> bool {
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

fn expect_basic_sequence(events: &[Value]) {
    assert!(has_event_type(events, "session.started"), "session.started missing");
    let item_id = find_assistant_message_item(events).expect("assistant message missing");
    let started_seq = find_item_event_seq(events, "item.started", &item_id)
        .expect("item.started missing");
    // Intentionally require deltas here to validate our synthetic delta behavior.
    let delta_seq = find_item_event_seq(events, "item.delta", &item_id)
        .expect("item.delta missing");
    let completed_seq = find_item_event_seq(events, "item.completed", &item_id)
        .expect("item.completed missing");
    assert!(started_seq < delta_seq, "item.started must precede delta");
    assert!(delta_seq < completed_seq, "delta must precede completion");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_agnostic_basic_reply() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    let capabilities = fetch_capabilities(&app.app).await;

    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        install_agent(&app.app, config.agent).await;

        let session_id = format!("basic-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &session_id, "default").await;
        send_message(&app.app, &session_id, PROMPT).await;

        let events = poll_events_until(&app.app, &session_id, Duration::from_secs(120), |events| {
            has_event_type(events, "error") || find_assistant_message_item(events).is_some()
        })
        .await;

        assert!(
            !events.is_empty(),
            "no events collected for {}",
            config.agent.as_str()
        );
        expect_basic_sequence(&events);

        let caps = capabilities
            .get(config.agent.as_str())
            .expect("capabilities missing");
        if caps.tool_calls {
            assert!(
                !events.iter().any(|event| {
                    event.get("type").and_then(Value::as_str) == Some("agent.unparsed")
                }),
                "agent.unparsed event detected"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_agnostic_tool_flow() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    let capabilities = fetch_capabilities(&app.app).await;

    for config in &configs {
        let caps = capabilities
            .get(config.agent.as_str())
            .expect("capabilities missing");
        if !caps.tool_calls {
            continue;
        }

        let _guard = apply_credentials(&config.credentials);
        install_agent(&app.app, config.agent).await;

        let session_id = format!("tool-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &session_id, test_permission_mode(config.agent)).await;
        send_message(&app.app, &session_id, TOOL_PROMPT).await;

        let start = Instant::now();
        let mut offset = 0u64;
        let mut events = Vec::new();
        let mut replied = false;
        while start.elapsed() < Duration::from_secs(180) {
            let path = format!("/v1/sessions/{session_id}/events?offset={offset}&limit=200");
            let (status, payload) = send_json(&app.app, Method::GET, &path, None).await;
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
                if !replied {
                    if let Some(permission_id) = find_permission_id(&events) {
                        let _ = send_status(
                            &app.app,
                            Method::POST,
                            &format!(
                                "/v1/sessions/{session_id}/permissions/{permission_id}/reply"
                            ),
                            Some(json!({ "reply": "once" })),
                        )
                        .await;
                        replied = true;
                    }
                }
                if has_tool_result(&events) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }

        let tool_call = find_tool_call(&events);
        let tool_result = has_tool_result(&events);
        assert!(
            tool_call.is_some(),
            "tool_call missing for tool-capable agent {}",
            config.agent.as_str()
        );
        if tool_call.is_some() {
            assert!(
                tool_result,
                "tool_result missing after tool_call for {}",
                config.agent.as_str()
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_agnostic_permission_flow() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    let capabilities = fetch_capabilities(&app.app).await;

    for config in &configs {
        let caps = capabilities
            .get(config.agent.as_str())
            .expect("capabilities missing");
        if !(caps.plan_mode && caps.permissions) {
            continue;
        }

        let _guard = apply_credentials(&config.credentials);
        install_agent(&app.app, config.agent).await;

        let session_id = format!("perm-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &session_id, "plan").await;
        send_message(&app.app, &session_id, TOOL_PROMPT).await;

        let events = poll_events_until(&app.app, &session_id, Duration::from_secs(120), |events| {
            find_permission_id(events).is_some() || has_event_type(events, "error")
        })
        .await;

        let permission_id = find_permission_id(&events).expect("permission.requested missing");
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{session_id}/permissions/{permission_id}/reply"),
            Some(json!({ "reply": "once" })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "permission reply");

        let resolved = poll_events_until(&app.app, &session_id, Duration::from_secs(120), |events| {
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("permission.resolved")
            })
        })
        .await;

        assert!(
            resolved.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("permission.resolved")
                    && event
                        .get("synthetic")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            }),
            "permission.resolved should be synthetic"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_agnostic_question_flow() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();
    let capabilities = fetch_capabilities(&app.app).await;

    for config in &configs {
        let caps = capabilities
            .get(config.agent.as_str())
            .expect("capabilities missing");
        if !caps.questions {
            continue;
        }

        let _guard = apply_credentials(&config.credentials);
        install_agent(&app.app, config.agent).await;

        let session_id = format!("question-{}", config.agent.as_str());
        create_session_with_mode(&app.app, config.agent, &session_id, "plan", "plan").await;
        send_message(&app.app, &session_id, QUESTION_PROMPT).await;

        let events = poll_events_until(&app.app, &session_id, Duration::from_secs(120), |events| {
            find_question_id(events).is_some() || has_event_type(events, "error")
        })
        .await;

        let question_id = find_question_id(&events).expect("question.requested missing");
        let answers = find_first_answer(&events).unwrap_or_else(|| vec![vec![]]);
        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{session_id}/questions/{question_id}/reply"),
            Some(json!({ "answers": answers })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "question reply");

        let resolved = poll_events_until(&app.app, &session_id, Duration::from_secs(120), |events| {
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("question.resolved")
            })
        })
        .await;

        assert!(
            resolved.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("question.resolved")
                    && event
                        .get("synthetic")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            }),
            "question.resolved should be synthetic"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_agnostic_termination() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");
    let app = TestApp::new();

    for config in &configs {
        let _guard = apply_credentials(&config.credentials);
        install_agent(&app.app, config.agent).await;

        let session_id = format!("terminate-{}", config.agent.as_str());
        create_session(&app.app, config.agent, &session_id, "default").await;

        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{session_id}/terminate"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "terminate session");

        let events = poll_events_until(&app.app, &session_id, Duration::from_secs(30), |events| {
            has_event_type(events, "session.ended")
        })
        .await;
        assert!(has_event_type(&events, "session.ended"), "missing session.ended");

        let status = send_status(
            &app.app,
            Method::POST,
            &format!("/v1/sessions/{session_id}/messages"),
            Some(json!({ "message": PROMPT })),
        )
        .await;
        assert!(!status.is_success(), "terminated session should reject messages");
    }
}
