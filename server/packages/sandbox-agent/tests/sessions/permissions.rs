// Permission flow snapshots compare every agent to the mock baseline.
include!("../common/http.rs");

fn session_snapshot_suffix(prefix: &str) -> String {
    snapshot_name(prefix, Some(AgentId::Mock))
}

fn assert_session_snapshot(prefix: &str, value: Value) {
    insta::with_settings!({
        snapshot_suffix => session_snapshot_suffix(prefix),
    }, {
        insta::assert_yaml_snapshot!(value);
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_flow_snapshots() {
    let configs = test_agents_from_env().expect("configure SANDBOX_TEST_AGENTS or install agents");

    for config in &configs {
        let app = TestApp::new();
        let capabilities = fetch_capabilities(&app.app).await;
        let caps = capabilities
            .get(config.agent.as_str())
            .expect("capabilities missing");
        if !(caps.plan_mode && caps.permissions) {
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
        assert_session_snapshot("permission_events", normalize_events(&permission_events));

        if let Some(permission_id) = find_permission_id(&permission_events) {
            let status = send_status(
                &app.app,
                Method::POST,
                &format!("/v1/sessions/{permission_session}/permissions/{permission_id}/reply"),
                Some(json!({ "reply": "once" })),
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT, "reply permission");
            assert_session_snapshot("permission_reply", snapshot_status(status));
        } else {
            let (status, payload) = send_json(
                &app.app,
                Method::POST,
                &format!("/v1/sessions/{permission_session}/permissions/missing-permission/reply"),
                Some(json!({ "reply": "once" })),
            )
            .await;
            assert!(!status.is_success(), "missing permission id should error");
            assert_session_snapshot(
                "permission_reply_missing",
                json!({
                    "status": status.as_u16(),
                    "payload": payload,
                }),
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_reply_always_sets_accept_for_session_status() {
    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "perm-always-mock";
    create_session(&app.app, AgentId::Mock, session_id, "plan").await;
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": PERMISSION_PROMPT })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send permission prompt");

    let events = poll_events_until_match(&app.app, session_id, Duration::from_secs(30), |events| {
        find_permission_id(events).is_some() || should_stop(events)
    })
    .await;
    let permission_id = find_permission_id(&events).expect("permission.requested missing");

    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/permissions/{permission_id}/reply"),
        Some(json!({ "reply": "always" })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "reply permission always");

    let resolved_events =
        poll_events_until_match(&app.app, session_id, Duration::from_secs(30), |events| {
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("permission.resolved")
                    && event
                        .get("data")
                        .and_then(|data| data.get("permission_id"))
                        .and_then(Value::as_str)
                        == Some(permission_id.as_str())
            })
        })
        .await;

    let resolved = resolved_events
        .iter()
        .rev()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("permission.resolved")
                && event
                    .get("data")
                    .and_then(|data| data.get("permission_id"))
                    .and_then(Value::as_str)
                    == Some(permission_id.as_str())
        })
        .expect("permission.resolved missing");
    let status = resolved
        .get("data")
        .and_then(|data| data.get("status"))
        .and_then(Value::as_str);
    assert_eq!(status, Some("accept_for_session"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_reply_always_auto_approves_subsequent_permissions() {
    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "perm-always-auto-mock";
    create_session(&app.app, AgentId::Mock, session_id, "plan").await;

    let first_status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": PERMISSION_PROMPT })),
    )
    .await;
    assert_eq!(
        first_status,
        StatusCode::NO_CONTENT,
        "send first permission prompt"
    );

    let first_events =
        poll_events_until_match(&app.app, session_id, Duration::from_secs(30), |events| {
            find_permission_id(events).is_some() || should_stop(events)
        })
        .await;
    let first_permission_id =
        find_permission_id(&first_events).expect("first permission.requested missing");

    let reply_status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/permissions/{first_permission_id}/reply"),
        Some(json!({ "reply": "always" })),
    )
    .await;
    assert_eq!(
        reply_status,
        StatusCode::NO_CONTENT,
        "reply first permission always"
    );

    let second_status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": PERMISSION_PROMPT })),
    )
    .await;
    assert_eq!(
        second_status,
        StatusCode::NO_CONTENT,
        "send second permission prompt"
    );

    let events = poll_events_until_match(&app.app, session_id, Duration::from_secs(30), |events| {
        let requested_ids = events
            .iter()
            .filter_map(|event| {
                if event.get("type").and_then(Value::as_str) != Some("permission.requested") {
                    return None;
                }
                event
                    .get("data")
                    .and_then(|data| data.get("permission_id"))
                    .and_then(Value::as_str)
                    .map(|value| value.to_string())
            })
            .collect::<Vec<_>>();
        if requested_ids.len() < 2 {
            return false;
        }
        let second_permission_id = &requested_ids[1];
        events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("permission.resolved")
                && event
                    .get("data")
                    .and_then(|data| data.get("permission_id"))
                    .and_then(Value::as_str)
                    == Some(second_permission_id.as_str())
                && event
                    .get("data")
                    .and_then(|data| data.get("status"))
                    .and_then(Value::as_str)
                    == Some("accept_for_session")
        })
    })
    .await;

    let requested_ids = events
        .iter()
        .filter_map(|event| {
            if event.get("type").and_then(Value::as_str) != Some("permission.requested") {
                return None;
            }
            event
                .get("data")
                .and_then(|data| data.get("permission_id"))
                .and_then(Value::as_str)
                .map(|value| value.to_string())
        })
        .collect::<Vec<_>>();
    assert!(
        requested_ids.len() >= 2,
        "expected at least two permission.requested events"
    );
    let second_permission_id = &requested_ids[1];

    let second_resolved = events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("permission.resolved")
            && event
                .get("data")
                .and_then(|data| data.get("permission_id"))
                .and_then(Value::as_str)
                == Some(second_permission_id.as_str())
            && event
                .get("data")
                .and_then(|data| data.get("status"))
                .and_then(Value::as_str)
                == Some("accept_for_session")
    });
    assert!(
        second_resolved,
        "second permission should auto-resolve as accept_for_session"
    );
}
