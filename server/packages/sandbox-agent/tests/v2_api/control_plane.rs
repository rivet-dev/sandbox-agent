use super::*;
#[tokio::test]
async fn v2_health_and_v1_removed() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v2/health", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["status"], "ok");

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/anything", None, &[]).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(parse_json(&body)["detail"], "v1 API removed; use /v2");

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/opencode/session", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(parse_json(&body).is_array());
}

#[tokio::test]
async fn v2_sessions_http_endpoints_removed_and_acp_extensions_work() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 100,
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

    let (status, _, _) = send_request(&test_app.app, Method::GET, "/v2/sessions", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::GET,
        &format!("/v2/sessions/{session_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let list_request = json!({
        "jsonrpc": "2.0",
        "id": 101,
        "method": "_sandboxagent/session/list",
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
    let sessions = parsed["result"]["sessions"].as_array().expect("sessions");
    assert!(
        sessions
            .iter()
            .any(|entry| entry["sessionId"] == session_id),
        "expected listed session in {sessions:?}"
    );

    let get_request = json!({
        "jsonrpc": "2.0",
        "id": 102,
        "method": "_sandboxagent/session/get",
        "params": {
            "sessionId": session_id
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(get_request),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["result"]["sessionId"], session_id);
}

#[tokio::test]
async fn v2_filesystem_endpoints_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let connection_id = create_mock_connection(&test_app.app, &[]).await;

    let new_session = json!({
        "jsonrpc": "2.0",
        "id": 200,
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

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v2/fs/mkdir?path=docs&session_id={session_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let mkdir_request = json!({
        "jsonrpc": "2.0",
        "id": 201,
        "method": "_sandboxagent/fs/mkdir",
        "params": {
            "path": "docs",
            "sessionId": session_id
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(mkdir_request),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(parse_json(&body)["result"]["path"].is_string());

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::PUT,
        &format!("/v2/fs/file?path=docs/file.txt&session_id={session_id}"),
        Some(b"hello".to_vec()),
        &[],
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["bytesWritten"], 5);

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        &format!("/v2/fs/file?path=docs/file.txt&session_id={session_id}"),
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        "application/octet-stream"
    );
    assert_eq!(String::from_utf8_lossy(&body), "hello");

    let stat_request = json!({
        "jsonrpc": "2.0",
        "id": 202,
        "method": "_sandboxagent/fs/stat",
        "params": {
            "path": "docs/file.txt",
            "sessionId": session_id
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(stat_request),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["entryType"], "file");
}

#[tokio::test]
async fn v2_auth_enforced_when_token_configured() {
    let test_app = TestApp::new(AuthConfig::with_token("secret-token".to_string()));

    let (status, _, _) = send_request(&test_app.app, Method::GET, "/v2/health", None, &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v2/health",
        None,
        &[("authorization", "Bearer secret-token")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["status"], "ok");
}

#[tokio::test]
#[serial]
async fn require_preinstall_blocks_missing_agent() {
    let test_app = {
        let _preinstall = EnvVarGuard::set("SANDBOX_AGENT_REQUIRE_PREINSTALL", "true");
        TestApp::new(AuthConfig::disabled())
    };

    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
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

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let parsed = parse_json(&body);
    assert_eq!(parsed["status"], 404);
    assert_eq!(parsed["title"], "Agent Not Installed");
}
#[tokio::test]
#[serial]
async fn lazy_install_runs_on_first_initialize() {
    let registry_url = serve_registry_once(json!({
        "agents": [
            {
                "id": "codex-acp",
                "version": "1.2.3",
                "distribution": {
                    "npx": {
                        "package": "@example/codex-acp@1.2.3",
                        "args": [],
                        "env": {}
                    }
                }
            }
        ]
    }));

    let _registry = EnvVarGuard::set("SANDBOX_AGENT_ACP_REGISTRY_URL", &registry_url);
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_path| {
        fs::create_dir_all(install_path.join("agent_processes"))
            .expect("create agent processes dir");
        write_executable(&install_path.join("codex"), "#!/usr/bin/env sh\nexit 0\n");
        fs::create_dir_all(install_path.join("bin")).expect("create bin dir");
        write_executable(
            &install_path.join("bin").join("npx"),
            "#!/usr/bin/env sh\nwhile IFS= read -r _line; do :; done\n",
        );
    });

    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![test_app.install_path().join("bin")];
    paths.extend(std::env::split_paths(&original_path));
    let merged_path = std::env::join_paths(paths).expect("join PATH");
    let _path_guard = EnvVarGuard::set_os("PATH", merged_path.as_os_str());

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

    let launcher_path = test_app
        .install_path()
        .join("agent_processes")
        .join("codex-acp");
    assert!(
        launcher_path.exists(),
        "expected lazy install to create agent process launcher"
    );

    let connection_id = headers
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id");
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
