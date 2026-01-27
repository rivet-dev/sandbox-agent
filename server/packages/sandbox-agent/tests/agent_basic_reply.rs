mod common;

use common::*;
use sandbox_agent_agent_management::testing::test_agents_from_env;
use serde_json::Value;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_basic_reply() {
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
