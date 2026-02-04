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

fn has_item_kind(events: &[Value], kind: &str) -> bool {
    events.iter().any(|event| {
        event
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|event_type| event_type == "item.completed")
            && event
                .get("data")
                .and_then(|data| data.get("item"))
                .and_then(|item| item.get("kind"))
                .and_then(Value::as_str)
                .is_some_and(|item_kind| item_kind == kind)
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_tunnel_end_to_end() {
    let app = TestApp::new();
    let session_id = "mcp-tunnel";

    let (status, _created) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "mcpTunnel": {
                "tools": [
                    {
                        "name": "private.lookup",
                        "description": "Lookup data",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" }
                            },
                            "required": ["id"]
                        }
                    }
                ]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    let (status, list_response) = send_json(
        &app.app,
        Method::POST,
        &format!("/mcp/{session_id}"),
        Some(json!({
            "jsonrpc": "2.0",
            "id": "list",
            "method": "tools/list"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list tools");
    let tools = list_response
        .get("result")
        .and_then(|result| result.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(tools.len(), 1, "tools list length");

    let call_request = json!({
        "jsonrpc": "2.0",
        "id": "call-1",
        "method": "tools/call",
        "params": {
            "name": "private.lookup",
            "arguments": { "id": "123" }
        }
    });
    let app_clone = app.app.clone();
    let call_task = tokio::spawn(async move {
        send_json(
            &app_clone,
            Method::POST,
            &format!("/mcp/{session_id}"),
            Some(call_request),
        )
        .await
    });

    let _ = poll_events_until_match(&app.app, session_id, Duration::from_secs(10), |events| {
        has_item_kind(events, "tool_call")
    })
    .await;

    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/mcp-tunnel/calls/call-1/response"),
        Some(json!({ "output": "lookup ok" })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "reply mcp tunnel");

    let (status, call_response) = call_task.await.expect("call task");
    assert_eq!(status, StatusCode::OK, "mcp call response");
    assert!(call_response.get("result").is_some(), "mcp result missing");

    let events = poll_events_until_match(&app.app, session_id, Duration::from_secs(10), |events| {
        has_item_kind(events, "tool_result")
    })
    .await;
    assert_session_snapshot("mcp_tunnel", normalize_events(&events));
}
