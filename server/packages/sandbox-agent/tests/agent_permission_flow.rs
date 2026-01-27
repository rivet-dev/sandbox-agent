mod common;

use common::*;
use sandbox_agent_agent_management::testing::test_agents_from_env;
use std::time::Duration;
use axum::http::Method;
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_permission_flow() {
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
        assert_eq!(status, axum::http::StatusCode::NO_CONTENT, "permission reply");

        let resolved = poll_events_until(&app.app, &session_id, Duration::from_secs(120), |events| {
            events.iter().any(|event| {
                event.get("type").and_then(serde_json::Value::as_str) == Some("permission.resolved")
            })
        })
        .await;

        assert!(
            resolved.iter().any(|event| {
                event.get("type").and_then(serde_json::Value::as_str) == Some("permission.resolved")
                    && event
                        .get("synthetic")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
            }),
            "permission.resolved should be synthetic"
        );
    }
}
