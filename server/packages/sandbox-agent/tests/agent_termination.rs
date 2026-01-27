mod common;

use common::*;
use sandbox_agent_agent_management::testing::test_agents_from_env;
use std::time::Duration;
use axum::http::Method;
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_termination() {
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
        assert_eq!(status, axum::http::StatusCode::NO_CONTENT, "terminate session");

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
