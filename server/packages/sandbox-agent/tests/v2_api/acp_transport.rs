use super::*;
#[tokio::test]
async fn acp_mock_prompt_flow_and_replay() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": "/tmp",
            "mcpServers": [],
            "_meta": {
                "sandboxagent.dev": {
                    "agent": "mock"
                }
            }
        }
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = parse_json(&body)["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let prompt = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [
                {
                    "type": "text",
                    "text": "hello"
                }
            ]
        }
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(prompt),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["stopReason"], "end_turn");

    let sse_chunk = read_first_sse_data(&test_app.app, &connection_id).await;
    assert!(sse_chunk.contains("session/update"), "{sse_chunk}");
    assert!(sse_chunk.contains("mock:"), "{sse_chunk}");
    assert!(!sse_chunk.contains("mock: hello"), "{sse_chunk}");
}

#[tokio::test]
async fn acp_delete_is_idempotent() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v2/rpc",
        None,
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v2/rpc",
        None,
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let prompt = json!({
        "jsonrpc": "2.0",
        "id": 99,
        "method": "session/prompt",
        "params": {
            "sessionId": "mock-session-1",
            "prompt": [{"type": "text", "text": "ping"}]
        }
    });

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(prompt),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn session_cancel_notification_emits_cancelled_update() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let cancel = json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {
            "sessionId": "mock-session-1",
            "agent": "mock"
        }
    });

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(cancel),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let sse_chunk = read_first_sse_data(&test_app.app, &connection_id).await;
    assert!(sse_chunk.contains("session/update"), "{sse_chunk}");
    assert!(sse_chunk.contains("cancelled"), "{sse_chunk}");
}

#[tokio::test]
async fn hitl_permission_request_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": "/tmp",
            "mcpServers": [],
            "_meta": {
                "sandboxagent.dev": {
                    "agent": "mock"
                }
            }
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = parse_json(&body)["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let prompt = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": "needs permission"}]
        }
    });
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(prompt),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let sse_chunk = read_first_sse_data(&test_app.app, &connection_id).await;
    assert!(
        sse_chunk.contains("session/request_permission"),
        "{sse_chunk}"
    );

    let permission_request = parse_sse_data(&sse_chunk);
    let permission_response = json!({
        "jsonrpc": "2.0",
        "id": permission_request["id"].clone(),
        "result": {
            "outcome": {
                "outcome": "cancelled"
            }
        }
    });
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(permission_response),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
}

#[tokio::test]
async fn invalid_acp_envelope_returns_bad_request() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) =
        send_request(&test_app.app, Method::POST, "/v2/rpc", Some(json!([])), &[]).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    let parsed = parse_json(&body);
    assert_eq!(parsed["status"], 400);
}

#[tokio::test]
async fn post_requires_json_content_type() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let payload = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0","clientCapabilities":{}}}"#
        .to_vec();
    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(payload),
        &[],
        Some("text/plain"),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(parse_json(&body)["status"], 415);
}

#[tokio::test]
async fn post_rejects_non_json_accept() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {}
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(payload),
        &[("accept", "text/event-stream")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
    assert_eq!(parse_json(&body)["status"], 406);
}

#[tokio::test]
async fn post_rejects_removed_x_acp_agent_header() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let payload = initialize_payload("mock");
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(payload),
        &[("x-acp-agent", "mock")],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(parse_json(&body)["status"], 400);
}

#[tokio::test]
async fn session_new_requires_sandbox_meta_agent() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;
    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 42,
        "method": "session/new",
        "params": {
            "cwd": "/tmp",
            "mcpServers": []
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(parse_json(&body)["status"], 400);
}

#[tokio::test]
async fn unstable_methods_available_on_mock() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let methods = [
        "session/list",
        "session/fork",
        "session/resume",
        "session/set_model",
        "$/cancel_request",
    ];

    for (index, method) in methods.iter().enumerate() {
        let request = json!({
            "jsonrpc": "2.0",
            "id": index + 10,
            "method": method,
            "params": {
                "agent": "mock"
            }
        });

        let (status, _, body) = send_request(
            &test_app.app,
            Method::POST,
            "/v2/rpc",
            Some(request),
            &[("x-acp-connection-id", &connection_id)],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{method}");
        assert!(parse_json(&body).get("result").is_some(), "{method}");
    }
}

#[tokio::test]
async fn sse_replay_honors_last_event_id() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": "/tmp",
            "mcpServers": [],
            "_meta": {
                "sandboxagent.dev": {
                    "agent": "mock"
                }
            }
        }
    });
    let (_status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    let session_id = parse_json(&body)["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    for (id, text) in [(3, "one"), (4, "two")] {
        let prompt = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}]
            }
        });
        let (status, _, _) = send_request(
            &test_app.app,
            Method::POST,
            "/v2/rpc",
            Some(prompt),
            &[("x-acp-connection-id", &connection_id)],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    // First stream event should have id > 1 when replaying from Last-Event-ID=1.
    let replay_chunk = read_first_sse_data_with_last_id(&test_app.app, &connection_id, 1).await;
    assert!(
        replay_chunk.contains("id: 2") || replay_chunk.contains("id: 3"),
        "{replay_chunk}"
    );
}

#[tokio::test]
async fn post_with_unknown_connection_returns_not_found() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let request = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "session/new",
        "params": { "cwd": "/", "mcpServers": [] }
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(request),
        &[("x-acp-connection-id", "missing-connection")],
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let parsed = parse_json(&body);
    assert_eq!(parsed["status"], 404);
    assert_eq!(parsed["title"], "ACP client not found");
}

#[tokio::test]
async fn sse_requires_connection_id_header() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v2/rpc", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        parse_json(&body)["detail"],
        "invalid request: missing x-acp-connection-id header"
    );
}

#[tokio::test]
async fn sse_rejects_non_sse_accept() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v2/rpc",
        None,
        &[
            ("x-acp-connection-id", &connection_id),
            ("accept", "application/json"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
    assert_eq!(parse_json(&body)["status"], 406);
}

#[tokio::test]
async fn sse_single_active_stream_per_connection() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let first_request = Request::builder()
        .method(Method::GET)
        .uri("/v2/rpc")
        .header("x-acp-connection-id", connection_id.as_str())
        .header("accept", "text/event-stream")
        .body(Body::empty())
        .expect("build first sse request");
    let first_response = test_app
        .app
        .clone()
        .oneshot(first_request)
        .await
        .expect("first sse response");
    assert_eq!(first_response.status(), StatusCode::OK);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v2/rpc",
        None,
        &[
            ("x-acp-connection-id", connection_id.as_str()),
            ("accept", "text/event-stream"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(parse_json(&body)["status"], 409);

    drop(first_response);
}

#[tokio::test]
async fn delete_requires_connection_id_header() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) = send_request(&test_app.app, Method::DELETE, "/v2/rpc", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        parse_json(&body)["detail"],
        "invalid request: missing x-acp-connection-id header"
    );
}

#[tokio::test]
async fn invalid_last_event_id_returns_bad_request() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v2/rpc",
        None,
        &[
            ("x-acp-connection-id", &connection_id),
            ("last-event-id", "not-a-number"),
        ],
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        parse_json(&body)["detail"],
        "invalid request: Last-Event-ID must be a positive integer"
    );
}

#[tokio::test]
#[serial]
async fn agent_process_request_timeout_maps_to_gateway_timeout() {
    let test_app = {
        let _timeout = EnvVarGuard::set("SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS", "75");
        let _close_grace = EnvVarGuard::set("SANDBOX_AGENT_ACP_CLOSE_GRACE_MS", "10");
        TestApp::with_setup(AuthConfig::disabled(), |install_path| {
            fs::create_dir_all(install_path.join("agent_processes"))
                .expect("create agent processes dir");
            write_executable(&install_path.join("codex"), "#!/usr/bin/env sh\nexit 0\n");
            write_executable(
                &install_path.join("agent_processes").join("codex-acp"),
                "#!/usr/bin/env sh\nwhile IFS= read -r _line; do sleep 10; done\n",
            );
        })
    };

    assert!(test_app.install_path().exists(), "install dir should exist");

    let initialize_notification = json!({
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {},
            "_meta": {
                "sandboxagent.dev": {
                    "agent": "codex"
                }
            }
        }
    });

    let (status, headers, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize_notification),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let connection_id = headers
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id");

    let request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": "/tmp",
            "mcpServers": [],
            "_meta": {
                "sandboxagent.dev": {
                    "agent": "codex"
                }
            }
        }
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(request),
        &[("x-acp-connection-id", connection_id)],
    )
    .await;

    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(parse_json(&body)["status"], 504);

    let (close_status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v2/rpc",
        None,
        &[("x-acp-connection-id", connection_id)],
    )
    .await;
    assert_eq!(close_status, StatusCode::NO_CONTENT);
}
