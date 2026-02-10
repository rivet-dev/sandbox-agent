use super::*;
#[tokio::test]
async fn initialize_advertises_sandbox_extensions() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {},
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
        Some(initialize),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let extensions =
        &parsed["result"]["agentCapabilities"]["_meta"]["sandboxagent.dev"]["extensions"];
    assert_eq!(extensions["sessionDetach"], true);
    assert_eq!(extensions["sessionListModels"], true);
    assert_eq!(extensions["sessionSetMetadata"], true);
    assert_eq!(extensions["sessionAgentMeta"], true);
    assert_eq!(extensions["agentList"], true);
    assert_eq!(extensions["agentInstall"], true);
    assert_eq!(extensions["sessionList"], true);
    assert_eq!(extensions["sessionGet"], true);
    assert_eq!(extensions["fsListEntries"], true);
    assert_eq!(extensions["fsReadFile"], true);
    assert_eq!(extensions["fsWriteFile"], true);
    assert_eq!(extensions["fsDeleteEntry"], true);
    assert_eq!(extensions["fsMkdir"], true);
    assert_eq!(extensions["fsMove"], true);
    assert_eq!(extensions["fsStat"], true);
    assert_eq!(extensions["fsUploadBatch"], true);
}

#[tokio::test]
async fn agent_list_extension_returns_agents() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 8,
        "method": "_sandboxagent/agent/list",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(request),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let agents = parsed["result"]["agents"].as_array().expect("agents array");
    assert!(
        agents.iter().any(|agent| agent["id"] == "mock"),
        "expected mock agent in {agents:?}"
    );
}

#[tokio::test]
async fn session_get_extension_returns_session() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 9,
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

    let request = json!({
        "jsonrpc": "2.0",
        "id": 10,
        "method": "_sandboxagent/session/get",
        "params": {
            "sessionId": session_id
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
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["sessionId"], session_id);
}

#[tokio::test]
async fn session_list_models_extension_returns_mock_catalog() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 33,
        "method": "_sandboxagent/session/list_models",
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
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let models = parsed["result"]["availableModels"]
        .as_array()
        .expect("available models");
    assert!(
        models.iter().any(|model| model["modelId"] == "mock"),
        "expected mock model in {models:?}"
    );
    assert_eq!(parsed["result"]["currentModelId"], "mock");
}

#[tokio::test]
async fn session_set_metadata_extension_updates_session_list_entry() {
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
                    "agent": "mock",
                    "title": "From Meta",
                    "variant": "high",
                    "requestedSessionId": "alias-1"
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

    let update = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "_sandboxagent/session/set_metadata",
        "params": {
            "sessionId": session_id,
            "metadata": {
                "title": "Updated Title",
                "permissionMode": "ask",
                "model": "mock"
            }
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(update),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"], json!({}));

    let list_request = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "session/list",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(list_request),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let sessions = parsed["result"]["sessions"]
        .as_array()
        .expect("sessions array");
    let entry = sessions
        .iter()
        .find(|session| session["sessionId"] == session_id)
        .expect("session entry");
    assert_eq!(entry["title"], "Updated Title");
    assert_eq!(entry["_meta"]["sandboxagent.dev"]["variant"], "high");
    assert_eq!(
        entry["_meta"]["sandboxagent.dev"]["requestedSessionId"],
        "alias-1"
    );
    assert_eq!(entry["_meta"]["sandboxagent.dev"]["permissionMode"], "ask");
    assert_eq!(entry["_meta"]["sandboxagent.dev"]["model"], "mock");
}

#[tokio::test]
async fn session_list_is_shared_across_clients() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_a = create_mock_connection(&test_app.app, &[]).await;
    let connection_b = create_mock_connection(&test_app.app, &[]).await;

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
        &[("x-acp-connection-id", &connection_a)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let created_session_id = parse_json(&body)["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let list_request = json!({
        "jsonrpc": "2.0",
        "id": 77,
        "method": "session/list",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(list_request),
        &[("x-acp-connection-id", &connection_b)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let sessions = parsed["result"]["sessions"]
        .as_array()
        .expect("sessions array");
    assert!(
        sessions
            .iter()
            .any(|session| session["sessionId"] == created_session_id),
        "expected shared session list to include {created_session_id}, got {sessions:?}"
    );
}

#[tokio::test]
async fn session_detach_stops_stream_delivery_for_that_client() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_a = create_mock_connection(&test_app.app, &[]).await;
    let connection_b = create_mock_connection(&test_app.app, &[]).await;

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
        &[("x-acp-connection-id", &connection_a)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = parse_json(&body)["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let load_session = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "session/load",
        "params": {
            "sessionId": session_id,
            "cwd": "/tmp",
            "mcpServers": []
        }
    });
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(load_session),
        &[("x-acp-connection-id", &connection_b)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let leave = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "_sandboxagent/session/detach",
        "params": {
            "sessionId": session_id
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(leave),
        &[("x-acp-connection-id", &connection_b)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"], json!({}));

    let prompt = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": "hello"}]
        }
    });
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(prompt),
        &[("x-acp-connection-id", &connection_a)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let got_data = sse_has_data_with_last_id(
        &test_app.app,
        &connection_b,
        10_000,
        Duration::from_millis(400),
    )
    .await;
    assert!(
        !got_data,
        "connection should not receive session updates after leave"
    );
}

#[tokio::test]
async fn session_terminate_extension_is_idempotent_and_emits_session_ended() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 210,
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

    let terminate = json!({
        "jsonrpc": "2.0",
        "id": 211,
        "method": "_sandboxagent/session/terminate",
        "params": {
            "sessionId": session_id
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(terminate),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["terminated"], true);

    let ended_chunk = read_sse_until_contains(
        &test_app.app,
        &connection_id,
        0,
        "_sandboxagent/session/ended",
        6,
    )
    .await
    .expect("expected session ended event");
    let ended_payload = parse_sse_data(&ended_chunk);
    assert_eq!(ended_payload["method"], "_sandboxagent/session/ended");
    assert_eq!(ended_payload["params"]["session_id"], session_id);

    let terminate_again = json!({
        "jsonrpc": "2.0",
        "id": 212,
        "method": "_sandboxagent/session/terminate",
        "params": {
            "sessionId": session_id
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(terminate_again),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["terminated"], false);
}

#[tokio::test]
async fn delete_acp_detaches_but_does_not_terminate_session() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_a = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 220,
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
        &[("x-acp-connection-id", &connection_a)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = parse_json(&body)["result"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_string();

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v2/rpc",
        None,
        &[("x-acp-connection-id", &connection_a)],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let connection_b = create_mock_connection(&test_app.app, &[]).await;
    let load = json!({
        "jsonrpc": "2.0",
        "id": 221,
        "method": "session/load",
        "params": {
            "sessionId": session_id,
            "cwd": "/tmp",
            "mcpServers": []
        }
    });
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(load),
        &[("x-acp-connection-id", &connection_b)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
