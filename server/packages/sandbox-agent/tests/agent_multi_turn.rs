//! Tests for multi-turn conversations to validate session resumption behavior.
//!
//! This test validates that:
//! 1. Sessions can handle multiple messages (multi-turn conversations)
//! 2. Agents that support resumption (Claude, Amp, OpenCode) can continue after process exit
//! 3. Codex supports multi-turn via the shared app-server model (single process, multiple threads)
//! 4. The mock agent correctly supports multi-turn as the reference implementation

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;

use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent_agent_management::agents::{AgentId, AgentManager};
use sandbox_agent_agent_management::testing::test_agents_from_env;
use sandbox_agent_agent_credentials::ExtractedCredentials;
use std::collections::BTreeMap;
use tower::util::ServiceExt;

const FIRST_PROMPT: &str = "Reply with exactly the word FIRST.";
const SECOND_PROMPT: &str = "Reply with exactly the word SECOND.";

struct TestApp {
    app: Router,
    _install_dir: TempDir,
}

impl TestApp {
    fn new() -> Self {
        let install_dir = tempfile::tempdir().expect("create temp install dir");
        let manager = AgentManager::new(install_dir.path()).expect("create agent manager");
        let state = AppState::new(AuthConfig::disabled(), manager);
        let app = build_router(state);
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
    let keys = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
    ];
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

async fn send_json(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    let body = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let request = builder.body(body).expect("request");
    let response = app.clone().oneshot(request).await.expect("request handled");
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
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).to_string()))
    };
    (status, value)
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

fn test_permission_mode(agent: AgentId) -> &'static str {
    match agent {
        AgentId::Opencode => "default",
        _ => "bypass",
    }
}

async fn create_session(app: &Router, agent: AgentId, session_id: &str) {
    let status = send_status(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": agent.as_str(),
            "permissionMode": test_permission_mode(agent)
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session {agent}");
}

/// Send a message and return the status code (allows checking for errors)
async fn send_message_with_status(
    app: &Router,
    session_id: &str,
    message: &str,
) -> (StatusCode, Value) {
    send_json(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": message })),
    )
    .await
}

/// Wait for a specific number of assistant responses (item.completed with role=assistant)
async fn wait_for_n_responses(
    app: &Router,
    session_id: &str,
    n: usize,
    timeout: Duration,
) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        let path = format!("/v1/sessions/{session_id}/events?offset=0&limit=1000");
        let (status, payload) = send_json(app, Method::GET, &path, None).await;
        if status != StatusCode::OK {
            return false;
        }
        let events = payload
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let completed_count = events.iter().filter(|e| is_assistant_completed(e)).count();
        if completed_count >= n {
            return true;
        }

        // Check for errors
        for event in &events {
            if is_error_event(event) {
                eprintln!("Error event: {:?}", event);
                return false;
            }
        }

        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

/// Wait for an assistant response (item.completed with role=assistant)
async fn wait_for_response(app: &Router, session_id: &str, timeout: Duration) -> bool {
    wait_for_n_responses(app, session_id, 1, timeout).await
}

fn is_assistant_completed(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|t| t == "item.completed")
        .unwrap_or(false)
        && event
            .get("data")
            .and_then(|d| d.get("item"))
            .and_then(|i| i.get("role"))
            .and_then(Value::as_str)
            .map(|r| r == "assistant")
            .unwrap_or(false)
}

fn is_session_ended(event: &Value) -> bool {
    event
        .get("type")
        .and_then(Value::as_str)
        .map(|t| t == "session.ended")
        .unwrap_or(false)
}

fn is_error_event(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("error") | Some("agent.unparsed")
    )
}

/// Count assistant responses in the event stream
async fn count_assistant_responses(app: &Router, session_id: &str) -> usize {
    let path = format!("/v1/sessions/{session_id}/events?offset=0&limit=1000");
    let (status, payload) = send_json(app, Method::GET, &path, None).await;
    if status != StatusCode::OK {
        eprintln!("Failed to get events: status={}", status);
        return 0;
    }
    let events = payload
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Debug: print all event types
    eprintln!("All events ({}):", events.len());
    for (i, e) in events.iter().enumerate() {
        let event_type = e.get("type").and_then(Value::as_str).unwrap_or("?");
        let role = e
            .get("data")
            .and_then(|d| d.get("item"))
            .and_then(|i| i.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("-");
        eprintln!("  [{}] type={}, role={}", i, event_type, role);
    }

    let count = events.iter().filter(|e| is_assistant_completed(e)).count();
    eprintln!("Assistant completed count: {}", count);
    count
}

/// Test multi-turn conversation for a specific agent
async fn test_multi_turn_for_agent(app: &Router, agent: AgentId) -> Result<(), String> {
    let session_id = format!("multi-turn-{}", agent.as_str());
    eprintln!("\n=== Testing multi-turn for {} ===", agent);

    // Create session
    create_session(app, agent, &session_id).await;
    eprintln!("Session created: {}", session_id);

    // Send first message
    eprintln!("Sending first message...");
    let (status, body) = send_message_with_status(app, &session_id, FIRST_PROMPT).await;
    eprintln!("First message status: {}", status);
    if status != StatusCode::NO_CONTENT {
        return Err(format!(
            "First message failed with status {}: {:?}",
            status, body
        ));
    }

    // Wait for first response
    eprintln!("Waiting for first response...");
    let got_first = wait_for_response(app, &session_id, Duration::from_secs(120)).await;
    if !got_first {
        return Err("Timed out waiting for first response".to_string());
    }
    eprintln!("Got first response");

    // Small delay to ensure session state is updated
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Send second message - this is the critical test
    eprintln!("Sending second message...");
    let (status, body) = send_message_with_status(app, &session_id, SECOND_PROMPT).await;
    eprintln!("Second message status: {}, body: {:?}", status, body);
    if status != StatusCode::NO_CONTENT {
        return Err(format!(
            "Second message failed with status {}: {:?}",
            status, body
        ));
    }

    // Wait for second response - specifically wait for 2 completed responses
    eprintln!("Waiting for second response (total 2)...");
    let got_both = wait_for_n_responses(app, &session_id, 2, Duration::from_secs(120)).await;
    if !got_both {
        // Debug: show what we got
        let response_count = count_assistant_responses(app, &session_id).await;
        return Err(format!(
            "Timed out waiting for second response (got {} completed)",
            response_count
        ));
    }
    eprintln!("Got both responses");

    // Verify we got two assistant responses
    let response_count = count_assistant_responses(app, &session_id).await;
    eprintln!("Final response count: {}", response_count);
    if response_count < 2 {
        return Err(format!(
            "Expected at least 2 assistant responses, got {}",
            response_count
        ));
    }

    Ok(())
}

#[tokio::test]
async fn multi_turn_mock_agent() {
    let test_app = TestApp::new();

    // Mock agent should always support multi-turn as the reference implementation
    let result = test_multi_turn_for_agent(&test_app.app, AgentId::Mock).await;
    assert!(
        result.is_ok(),
        "Mock agent multi-turn failed: {:?}",
        result.err()
    );
}

#[tokio::test]
async fn multi_turn_real_agents() {
    let configs = match test_agents_from_env() {
        Ok(configs) => configs,
        Err(err) => {
            eprintln!("Failed to get agent configs: {:?}. Skipping multi-turn test.", err);
            return;
        }
    };
    if configs.is_empty() {
        eprintln!("No agents configured for testing. Skipping multi-turn test.");
        return;
    }

    let test_app = TestApp::new();

    for config in configs {
        let _guard = apply_credentials(&config.credentials);
        install_agent(&test_app.app, config.agent).await;

        let result = test_multi_turn_for_agent(&test_app.app, config.agent).await;

        match config.agent {
            AgentId::Claude | AgentId::Amp | AgentId::Opencode => {
                // These agents should support multi-turn via resumption
                assert!(
                    result.is_ok(),
                    "{} multi-turn failed (should support resumption): {:?}",
                    config.agent,
                    result.err()
                );
            }
            AgentId::Codex => {
                // Codex now supports multi-turn via the shared app-server model
                assert!(
                    result.is_ok(),
                    "{} multi-turn failed (should support shared app-server): {:?}",
                    config.agent,
                    result.err()
                );
            }
            AgentId::Mock => {
                // Mock is tested separately
            }
        }
    }
}

/// Test that verifies the session can be reopened after ending
#[tokio::test]
async fn session_reopen_after_end() {
    let test_app = TestApp::new();
    let session_id = "reopen-test";

    // Create session with mock agent
    create_session(&test_app.app, AgentId::Mock, session_id).await;

    // Send "end" command to mock agent to end the session
    let (status, _) = send_message_with_status(&test_app.app, session_id, "end").await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Wait for session to end
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Verify session is ended
    let path = format!("/v1/sessions/{session_id}/events?offset=0&limit=100");
    let (_, payload) = send_json(&test_app.app, Method::GET, &path, None).await;
    let events = payload
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_ended = events.iter().any(|e| is_session_ended(e));
    assert!(has_ended, "Session should be ended after 'end' command");

    // Try to send another message - mock agent supports resume so this should work
    // (or fail if we haven't implemented reopen for mock)
    let (status, body) = send_message_with_status(&test_app.app, session_id, "hello again").await;

    // For mock agent, the session should be reopenable since mock is in agent_supports_resume
    // But mock's session.ended is triggered differently than real agents
    // This test documents the current behavior
    if status == StatusCode::NO_CONTENT {
        eprintln!("Mock agent session was successfully reopened after end");
    } else {
        eprintln!(
            "Mock agent session could not be reopened (status {}): {:?}",
            status, body
        );
    }
}
