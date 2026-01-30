// Hooks integration tests using the mock agent as the source of truth.
include!("../common/http.rs");

use std::fs;

fn hooks_snapshot_suffix(prefix: &str) -> String {
    snapshot_name(prefix, Some(AgentId::Mock))
}

fn assert_hooks_snapshot(prefix: &str, value: Value) {
    insta::with_settings!({
        snapshot_suffix => hooks_snapshot_suffix(prefix),
    }, {
        insta::assert_yaml_snapshot!(value);
    });
}

/// Test that on_session_start hooks are executed when a session is created.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_session_start() {
    let work_dir = TempDir::new().expect("create work dir");
    let marker_file = work_dir.path().join("session_started.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-session-start";
    let hooks = json!({
        "onSessionStart": [
            {
                "command": format!("echo 'session started' > {}", marker_file.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _response) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session with hooks");

    // Give time for hook to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify the hook created the marker file
    assert!(marker_file.exists(), "session start hook should have created marker file");
    let content = fs::read_to_string(&marker_file).expect("read marker file");
    assert!(content.contains("session started"), "marker file should contain expected content");

    assert_hooks_snapshot("session_start", json!({
        "hook_executed": marker_file.exists(),
        "content_valid": content.contains("session started")
    }));
}

/// Test that on_session_end hooks are executed when a session is terminated.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_session_end() {
    let work_dir = TempDir::new().expect("create work dir");
    let marker_file = work_dir.path().join("session_ended.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-session-end";
    let hooks = json!({
        "onSessionEnd": [
            {
                "command": format!("echo 'session ended' > {}", marker_file.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Terminate the session
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/terminate"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "terminate session");

    // Give time for hook to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify the hook created the marker file
    assert!(marker_file.exists(), "session end hook should have created marker file");
    let content = fs::read_to_string(&marker_file).expect("read marker file");
    assert!(content.contains("session ended"), "marker file should contain expected content");

    assert_hooks_snapshot("session_end", json!({
        "hook_executed": marker_file.exists(),
        "content_valid": content.contains("session ended")
    }));
}

/// Test that on_message_start hooks are executed before processing a message.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_message_start() {
    let work_dir = TempDir::new().expect("create work dir");
    let marker_file = work_dir.path().join("message_started.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-message-start";
    let hooks = json!({
        "onMessageStart": [
            {
                "command": format!("echo \"$SANDBOX_MESSAGE\" > {}", marker_file.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Send a message
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": "test message content" })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send message");

    // Give time for hook to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify the hook created the marker file with the message
    assert!(marker_file.exists(), "message start hook should have created marker file");
    let content = fs::read_to_string(&marker_file).expect("read marker file");
    assert!(content.contains("test message content"), "marker file should contain message");

    assert_hooks_snapshot("message_start", json!({
        "hook_executed": marker_file.exists(),
        "content_valid": content.contains("test message content")
    }));
}

/// Test that on_message_end hooks are executed after a message is processed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_message_end() {
    let work_dir = TempDir::new().expect("create work dir");
    let marker_file = work_dir.path().join("message_ended.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-message-end";
    let hooks = json!({
        "onMessageEnd": [
            {
                "command": format!("echo 'message processed' > {}", marker_file.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Send a message and wait for completion
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": "Reply with OK." })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send message");

    // Wait for the mock agent to complete and hooks to run
    let events = poll_events_until(&app.app, session_id, std::time::Duration::from_secs(10)).await;
    
    // Give extra time for hook to complete
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;

    // Verify the hook created the marker file
    assert!(marker_file.exists(), "message end hook should have created marker file");
    let content = fs::read_to_string(&marker_file).expect("read marker file");
    assert!(content.contains("message processed"), "marker file should contain expected content");

    assert_hooks_snapshot("message_end", json!({
        "hook_executed": marker_file.exists(),
        "content_valid": content.contains("message processed"),
        "event_count": events.len()
    }));
}

/// Test multiple hooks in sequence.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_multiple_in_sequence() {
    let work_dir = TempDir::new().expect("create work dir");
    let file1 = work_dir.path().join("hook1.txt");
    let file2 = work_dir.path().join("hook2.txt");
    let file3 = work_dir.path().join("hook3.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-multiple";
    let hooks = json!({
        "onSessionStart": [
            {
                "command": format!("echo '1' > {}", file1.display()),
                "timeoutSecs": 5
            },
            {
                "command": format!("echo '2' > {}", file2.display()),
                "timeoutSecs": 5
            },
            {
                "command": format!("echo '3' > {}", file3.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Give time for hooks to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify all hooks ran
    assert!(file1.exists(), "hook 1 should have run");
    assert!(file2.exists(), "hook 2 should have run");
    assert!(file3.exists(), "hook 3 should have run");

    assert_hooks_snapshot("multiple_hooks", json!({
        "hook1_executed": file1.exists(),
        "hook2_executed": file2.exists(),
        "hook3_executed": file3.exists()
    }));
}

/// Test that hook failures with continue_on_failure=false stop execution.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_stop_on_failure() {
    let work_dir = TempDir::new().expect("create work dir");
    let file1 = work_dir.path().join("before_fail.txt");
    let file3 = work_dir.path().join("after_fail.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-stop-on-failure";
    let hooks = json!({
        "onSessionStart": [
            {
                "command": format!("echo 'first' > {}", file1.display()),
                "timeoutSecs": 5
            },
            {
                "command": "exit 1",
                "continueOnFailure": false,
                "timeoutSecs": 5
            },
            {
                "command": format!("echo 'third' > {}", file3.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Give time for hooks to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify first hook ran but third didn't (stopped at failure)
    assert!(file1.exists(), "first hook should have run");
    assert!(!file3.exists(), "third hook should NOT have run (stopped at failure)");

    assert_hooks_snapshot("stop_on_failure", json!({
        "first_executed": file1.exists(),
        "third_executed": file3.exists()
    }));
}

/// Test that hook failures with continue_on_failure=true continue execution.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_continue_on_failure() {
    let work_dir = TempDir::new().expect("create work dir");
    let file1 = work_dir.path().join("before_fail.txt");
    let file3 = work_dir.path().join("after_fail.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-continue-on-failure";
    let hooks = json!({
        "onSessionStart": [
            {
                "command": format!("echo 'first' > {}", file1.display()),
                "timeoutSecs": 5
            },
            {
                "command": "exit 1",
                "continueOnFailure": true,
                "timeoutSecs": 5
            },
            {
                "command": format!("echo 'third' > {}", file3.display()),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Give time for hooks to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify all hooks ran (continued past failure)
    assert!(file1.exists(), "first hook should have run");
    assert!(file3.exists(), "third hook should have run (continued past failure)");

    assert_hooks_snapshot("continue_on_failure", json!({
        "first_executed": file1.exists(),
        "third_executed": file3.exists()
    }));
}

/// Test hooks with environment variables.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_environment_variables() {
    let work_dir = TempDir::new().expect("create work dir");
    let env_file = work_dir.path().join("env_vars.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-env-vars";
    let hooks = json!({
        "onSessionStart": [
            {
                "command": format!(
                    "echo \"session=$SANDBOX_SESSION_ID agent=$SANDBOX_AGENT mode=$SANDBOX_AGENT_MODE hook=$SANDBOX_HOOK_TYPE\" > {}",
                    env_file.display()
                ),
                "timeoutSecs": 5
            }
        ]
    });

    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    // Give time for hook to execute
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Verify the environment variables were available
    assert!(env_file.exists(), "env file should exist");
    let content = fs::read_to_string(&env_file).expect("read env file");
    
    assert!(content.contains(&format!("session={session_id}")), "should have session id");
    assert!(content.contains("agent=mock"), "should have agent");
    assert!(content.contains("hook=session_start"), "should have hook type");

    assert_hooks_snapshot("env_vars", json!({
        "file_exists": env_file.exists(),
        "has_session_id": content.contains(&format!("session={session_id}")),
        "has_agent": content.contains("agent=mock"),
        "has_hook_type": content.contains("hook=session_start")
    }));
}

/// Test full lifecycle with all hook types.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_full_lifecycle() {
    let work_dir = TempDir::new().expect("create work dir");
    let session_start = work_dir.path().join("session_start.txt");
    let message_start = work_dir.path().join("message_start.txt");
    let message_end = work_dir.path().join("message_end.txt");
    let session_end = work_dir.path().join("session_end.txt");

    let app = TestApp::new();
    install_agent(&app.app, AgentId::Mock).await;

    let session_id = "hooks-full-lifecycle";
    let hooks = json!({
        "onSessionStart": [{
            "command": format!("echo 'started' > {}", session_start.display()),
            "timeoutSecs": 5
        }],
        "onMessageStart": [{
            "command": format!("echo 'msg start' > {}", message_start.display()),
            "timeoutSecs": 5
        }],
        "onMessageEnd": [{
            "command": format!("echo 'msg end' > {}", message_end.display()),
            "timeoutSecs": 5
        }],
        "onSessionEnd": [{
            "command": format!("echo 'ended' > {}", session_end.display()),
            "timeoutSecs": 5
        }]
    });

    // Create session (triggers onSessionStart)
    let (status, _) = send_json(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({
            "agent": "mock",
            "permissionMode": "bypass",
            "hooks": hooks,
            "workingDir": work_dir.path().to_str().unwrap()
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(session_start.exists(), "session start hook should run");

    // Send message (triggers onMessageStart and onMessageEnd)
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/messages"),
        Some(json!({ "message": "Reply with OK." })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "send message");
    
    // Wait for message processing
    let _ = poll_events_until(&app.app, session_id, std::time::Duration::from_secs(10)).await;
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    assert!(message_start.exists(), "message start hook should run");
    assert!(message_end.exists(), "message end hook should run");

    // Terminate session (triggers onSessionEnd)
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}/terminate"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "terminate session");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(session_end.exists(), "session end hook should run");

    assert_hooks_snapshot("full_lifecycle", json!({
        "session_start_executed": session_start.exists(),
        "message_start_executed": message_start.exists(),
        "message_end_executed": message_end.exists(),
        "session_end_executed": session_end.exists()
    }));
}
