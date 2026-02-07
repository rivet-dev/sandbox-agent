// Pi RPC integration tests (gated via SANDBOX_TEST_PI + PATH).
include!("../common/http.rs");

fn pi_test_config() -> Option<TestAgentConfig> {
    let configs = match test_agents_from_env() {
        Ok(configs) => configs,
        Err(err) => {
            eprintln!("Skipping Pi RPC integration test: {err}");
            return None;
        }
    };
    configs
        .into_iter()
        .find(|config| config.agent == AgentId::Pi)
}

async fn create_pi_session_with_native(app: &Router, session_id: &str) -> String {
    let payload = create_pi_session(app, session_id, None, None).await;
    let native_session_id = payload
        .get("native_session_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    assert!(
        !native_session_id.is_empty(),
        "expected native_session_id for pi session"
    );
    native_session_id
}

async fn create_pi_session(
    app: &Router,
    session_id: &str,
    model: Option<&str>,
    variant: Option<&str>,
) -> Value {
    let mut body = Map::new();
    body.insert("agent".to_string(), json!("pi"));
    body.insert(
        "permissionMode".to_string(),
        json!(test_permission_mode(AgentId::Pi)),
    );
    if let Some(model) = model {
        body.insert("model".to_string(), json!(model));
    }
    if let Some(variant) = variant {
        body.insert("variant".to_string(), json!(variant));
    }
    let (status, payload) = send_json(
        app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(Value::Object(body)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create pi session");
    payload
}

async fn fetch_pi_models(app: &Router) -> Vec<Value> {
    let (status, payload) = send_json(app, Method::GET, "/v1/agents/pi/models", None).await;
    assert_eq!(status, StatusCode::OK, "pi models endpoint");
    payload
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn model_variant_ids(model: &Value) -> Vec<&str> {
    model
        .get("variants")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default()
}

fn assert_strictly_increasing_sequences(events: &[Value], label: &str) {
    let mut last_sequence = 0u64;
    for event in events {
        let sequence = event
            .get("sequence")
            .and_then(Value::as_u64)
            .expect("missing sequence");
        assert!(
            sequence > last_sequence,
            "{label}: sequence did not increase (prev {last_sequence}, next {sequence})"
        );
        last_sequence = sequence;
    }
}

fn assert_all_events_for_session(events: &[Value], session_id: &str) {
    for event in events {
        let event_session_id = event
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert_eq!(
            event_session_id, session_id,
            "cross-session event detected in {session_id}: {event}"
        );
    }
}

fn assert_item_started_ids_unique(events: &[Value], label: &str) {
    let mut ids = std::collections::HashSet::new();
    for event in events {
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type != "item.started" {
            continue;
        }
        let Some(item_id) = event
            .get("data")
            .and_then(|data| data.get("item"))
            .and_then(|item| item.get("item_id"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        assert!(
            ids.insert(item_id.to_string()),
            "{label}: duplicate item.started id {item_id}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_rpc_session_and_stream() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let session_id = "pi-rpc-session";
    let _native_session_id = create_pi_session_with_native(&app.app, session_id).await;

    let events = read_turn_stream_events(&app.app, session_id, Duration::from_secs(120)).await;
    assert!(!events.is_empty(), "no events from pi stream");
    assert!(
        !events.iter().any(is_unparsed_event),
        "agent.unparsed event encountered"
    );
    assert!(
        should_stop(&events),
        "turn stream did not reach a terminal event"
    );
    assert_strictly_increasing_sequences(&events, "pi_rpc_session_and_stream");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_variant_high_applies_for_thinking_model() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let models = fetch_pi_models(&app.app).await;
    let thinking_model = models.iter().find_map(|model| {
        let model_id = model.get("id").and_then(Value::as_str)?;
        let variants = model_variant_ids(model);
        if variants.contains(&"high") {
            Some(model_id.to_string())
        } else {
            None
        }
    });
    let Some(model_id) = thinking_model else {
        eprintln!("Skipping PI variant thinking-model test: no model advertises high");
        return;
    };

    let session_id = "pi-variant-thinking-high";
    create_pi_session(&app.app, session_id, Some(&model_id), Some("high")).await;

    let events = read_turn_stream_events(&app.app, session_id, Duration::from_secs(120)).await;
    assert!(
        !events.is_empty(),
        "no events from pi thinking-variant stream"
    );
    assert!(
        !events.iter().any(is_unparsed_event),
        "agent.unparsed event encountered for thinking-variant session"
    );
    assert!(
        should_stop(&events),
        "thinking-variant turn stream did not reach a terminal event"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_variant_high_on_non_thinking_model_uses_pi_native_clamping() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let models = fetch_pi_models(&app.app).await;
    let non_thinking_model = models.iter().find_map(|model| {
        let model_id = model.get("id").and_then(Value::as_str)?;
        let variants = model_variant_ids(model);
        if variants == vec!["off"] {
            Some(model_id.to_string())
        } else {
            None
        }
    });
    let Some(model_id) = non_thinking_model else {
        eprintln!("Skipping PI non-thinking variant test: no off-only model reported");
        return;
    };

    let session_id = "pi-variant-nonthinking-high";
    create_pi_session(&app.app, session_id, Some(&model_id), Some("high")).await;

    let events = read_turn_stream_events(&app.app, session_id, Duration::from_secs(120)).await;
    assert!(
        !events.is_empty(),
        "no events from pi non-thinking variant stream"
    );
    assert!(
        !events.iter().any(is_unparsed_event),
        "agent.unparsed event encountered for non-thinking variant session"
    );
    assert!(
        should_stop(&events),
        "non-thinking variant turn stream did not reach a terminal event"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_parallel_sessions_turns() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let session_a = "pi-parallel-a";
    let session_b = "pi-parallel-b";
    create_pi_session_with_native(&app.app, session_a).await;
    create_pi_session_with_native(&app.app, session_b).await;

    let app_a = app.app.clone();
    let app_b = app.app.clone();
    let send_a = send_message(&app_a, session_a);
    let send_b = send_message(&app_b, session_b);
    tokio::join!(send_a, send_b);

    let app_a = app.app.clone();
    let app_b = app.app.clone();
    let poll_a = poll_events_until(&app_a, session_a, Duration::from_secs(120));
    let poll_b = poll_events_until(&app_b, session_b, Duration::from_secs(120));
    let (events_a, events_b) = tokio::join!(poll_a, poll_b);

    assert!(!events_a.is_empty(), "no events for session A");
    assert!(!events_b.is_empty(), "no events for session B");
    assert!(
        should_stop(&events_a),
        "session A did not reach a terminal event"
    );
    assert!(
        should_stop(&events_b),
        "session B did not reach a terminal event"
    );
    assert!(
        !events_a.iter().any(is_unparsed_event),
        "session A encountered agent.unparsed"
    );
    assert!(
        !events_b.iter().any(is_unparsed_event),
        "session B encountered agent.unparsed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_event_isolation() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let session_a = "pi-isolation-a";
    let session_b = "pi-isolation-b";
    create_pi_session_with_native(&app.app, session_a).await;
    create_pi_session_with_native(&app.app, session_b).await;

    let app_a = app.app.clone();
    let app_b = app.app.clone();
    let send_a = send_message(&app_a, session_a);
    let send_b = send_message(&app_b, session_b);
    tokio::join!(send_a, send_b);

    let app_a = app.app.clone();
    let app_b = app.app.clone();
    let poll_a = poll_events_until(&app_a, session_a, Duration::from_secs(120));
    let poll_b = poll_events_until(&app_b, session_b, Duration::from_secs(120));
    let (events_a, events_b) = tokio::join!(poll_a, poll_b);

    assert!(should_stop(&events_a), "session A did not complete");
    assert!(should_stop(&events_b), "session B did not complete");
    assert_all_events_for_session(&events_a, session_a);
    assert_all_events_for_session(&events_b, session_b);
    assert_strictly_increasing_sequences(&events_a, "session A");
    assert_strictly_increasing_sequences(&events_b, "session B");
    assert_item_started_ids_unique(&events_a, "session A");
    assert_item_started_ids_unique(&events_b, "session B");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_terminate_one_session_does_not_affect_other() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let session_a = "pi-terminate-a";
    let session_b = "pi-terminate-b";
    create_pi_session_with_native(&app.app, session_a).await;
    create_pi_session_with_native(&app.app, session_b).await;

    let terminate_status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_a}/terminate"),
        None,
    )
    .await;
    assert_eq!(
        terminate_status,
        StatusCode::NO_CONTENT,
        "terminate session A"
    );

    send_message(&app.app, session_b).await;
    let events_b = poll_events_until(&app.app, session_b, Duration::from_secs(120)).await;
    assert!(!events_b.is_empty(), "no events for session B");
    assert!(
        should_stop(&events_b),
        "session B did not complete after A terminated"
    );

    let events_a = poll_events_until(&app.app, session_a, Duration::from_secs(10)).await;
    assert!(
        events_a.iter().any(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|ty| ty == "session.ended")
        }),
        "session A missing session.ended after terminate"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pi_runtime_restart_scope() {
    let Some(config) = pi_test_config() else {
        return;
    };

    let app = TestApp::new();
    let _guard = apply_credentials(&config.credentials);
    install_agent(&app.app, config.agent).await;

    let session_a = "pi-restart-scope-a";
    let session_b = "pi-restart-scope-b";
    create_pi_session_with_native(&app.app, session_a).await;
    create_pi_session_with_native(&app.app, session_b).await;

    let terminate_status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_a}/terminate"),
        None,
    )
    .await;
    assert_eq!(
        terminate_status,
        StatusCode::NO_CONTENT,
        "terminate session A to stop only its runtime"
    );

    send_message(&app.app, session_b).await;
    let events_b = poll_events_until(&app.app, session_b, Duration::from_secs(120)).await;
    assert!(
        should_stop(&events_b),
        "session B did not continue after A stopped"
    );
    assert_all_events_for_session(&events_b, session_b);
}
