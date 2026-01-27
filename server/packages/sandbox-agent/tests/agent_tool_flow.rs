mod common;

use common::*;
use sandbox_agent_agent_management::testing::test_agents_from_env;
use serde_json::Value;
use std::time::{Duration, Instant};
use axum::http::Method;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_tool_flow() {
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
        create_session(
            &app.app,
            config.agent,
            &session_id,
            test_permission_mode(config.agent),
        )
        .await;
        send_message(&app.app, &session_id, TOOL_PROMPT).await;

        let start = Instant::now();
        let mut offset = 0u64;
        let mut events = Vec::new();
        let mut replied = false;
        while start.elapsed() < Duration::from_secs(180) {
            let path = format!("/v1/sessions/{session_id}/events?offset={offset}&limit=200");
            let (status, payload) = send_json(&app.app, Method::GET, &path, None).await;
            assert_eq!(status, axum::http::StatusCode::OK, "poll events");
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
                            Some(serde_json::json!({ "reply": "once" })),
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
