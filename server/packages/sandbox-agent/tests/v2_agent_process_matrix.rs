use std::fs;
use std::path::Path;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::Router;
use futures::StreamExt;
use http_body_util::BodyExt;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent_agent_management::agents::AgentManager;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::util::ServiceExt;

struct TestApp {
    app: Router,
    _install_dir: TempDir,
}

impl TestApp {
    fn with_setup<F>(setup: F) -> Self
    where
        F: FnOnce(&Path),
    {
        let install_dir = tempfile::tempdir().expect("create temp install dir");
        setup(install_dir.path());
        let manager = AgentManager::new(install_dir.path()).expect("create agent manager");
        let state = AppState::new(AuthConfig::disabled(), manager);
        let app = build_router(state);
        Self {
            app,
            _install_dir: install_dir,
        }
    }
}

async fn send_request(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }

    let request_body = if let Some(body) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };

    let request = builder.body(request_body).expect("build request");
    let response = app.clone().oneshot(request).await.expect("request handled");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    (status, headers, bytes.to_vec())
}

fn parse_json(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).expect("valid json")
    }
}

async fn read_first_sse_chunk(app: &Router, connection_id: &str) -> String {
    let request = Request::builder()
        .method(Method::GET)
        .uri("/v2/rpc")
        .header("x-acp-connection-id", connection_id)
        .body(Body::empty())
        .expect("build request");

    let response = app.clone().oneshot(request).await.expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);

    let mut stream = response.into_body().into_data_stream();
    tokio::time::timeout(Duration::from_secs(5), async move {
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.expect("stream chunk");
            let text = String::from_utf8_lossy(&bytes).to_string();
            if text.contains("data:") {
                return text;
            }
        }
        panic!("SSE stream ended before data chunk")
    })
    .await
    .expect("timed out reading sse")
}

fn parse_sse_data(chunk: &str) -> Value {
    let data = chunk
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&data).expect("valid SSE payload json")
}

#[cfg(unix)]
fn set_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path).expect("metadata").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).expect("set executable bit");
}

fn write_stub_native(path: &Path, agent: &str) {
    let script = format!("#!/usr/bin/env sh\necho \"{agent} 0.0.1\"\nexit 0\n");
    fs::write(path, script).expect("write native stub");
    #[cfg(unix)]
    set_executable(path);
}

fn write_stub_agent_process(path: &Path, agent: &str) {
    write_stub_agent_process_with_counter(path, agent, None);
}

fn write_stub_agent_process_with_counter(
    path: &Path,
    agent: &str,
    start_counter_file: Option<&Path>,
) {
    let start_counter_block = start_counter_file.map_or_else(String::new, |file| {
        let path = file.display();
        format!(
            r#"
count=0
if [ -f "{path}" ]; then
  count=$(cat "{path}")
fi
count=$((count + 1))
printf '%s' "$count" > "{path}"
"#
        )
    });
    let script = format!(
        r#"#!/usr/bin/env sh
if [ "${{1:-}}" = "--help" ] || [ "${{1:-}}" = "--version" ] || [ "${{1:-}}" = "version" ] || [ "${{1:-}}" = "-V" ]; then
  echo "{agent}-agent-process 0.0.1"
  exit 0
fi
if [ "${{1:-}}" = "acp" ]; then
  shift
fi
{start_counter_block}

SESSION_ID="{agent}-session-1"
while IFS= read -r line; do
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([^,}}]*\).*/\1/p')

  case "$method" in
    initialize)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":"1.0","agentCapabilities":{{"canSetMode":true,"canSetModel":true}},"authMethods":[]}}}}\n' "$id"
      ;;
    model/list)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"data":[{{"model":"{agent}-model","displayName":"{agent} model","isDefault":true}}],"nextCursor":null}}}}\n' "$id"
      ;;
    session/new)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"%s","availableModes":[],"configOptions":[]}}}}\n' "$id" "$SESSION_ID"
      ;;
    session/prompt)
      printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"%s","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{agent}: stub response"}}}}}}}}\n' "$SESSION_ID"
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"stopReason":"end_turn"}}}}\n' "$id"
      ;;
    session/cancel)
      printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"%s","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{agent}: cancelled"}}}}}}}}\n' "$SESSION_ID"
      ;;
    *)
      if [ -n "$id" ]; then
        printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id"
      fi
      ;;
  esac
done
"#
    );

    fs::write(path, script).expect("write agent process stub");
    #[cfg(unix)]
    set_executable(path);
}

fn setup_stub_artifacts(install_dir: &Path, agent: &str) {
    let native = install_dir.join(agent);
    write_stub_native(&native, agent);

    let agent_processes = install_dir.join("agent_processes");
    fs::create_dir_all(&agent_processes).expect("create agent processes dir");
    let launcher = if cfg!(windows) {
        agent_processes.join(format!("{agent}-acp.cmd"))
    } else {
        agent_processes.join(format!("{agent}-acp"))
    };
    write_stub_agent_process(&launcher, agent);
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_matrix_smoke_and_jsonrpc_conformance() {
    let agents = ["claude", "codex", "opencode"];
    let test_app = TestApp::with_setup(|install_dir| {
        for agent in agents {
            setup_stub_artifacts(install_dir, agent);
        }
    });

    for agent in agents {
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "1.0",
                "clientCapabilities": {},
                "_meta": {
                    "sandboxagent.dev": {
                        "agent": agent
                    }
                }
            }
        });
        let (status, init_headers, init_body) = send_request(
            &test_app.app,
            Method::POST,
            "/v2/rpc",
            Some(initialize),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{agent}: initialize status");
        let init_json = parse_json(&init_body);
        assert_eq!(init_json["jsonrpc"], "2.0", "{agent}: initialize jsonrpc");
        assert_eq!(init_json["id"], 1, "{agent}: initialize id");

        let connection_id = init_headers
            .get("x-acp-connection-id")
            .and_then(|value| value.to_str().ok())
            .expect("connection id");

        let new_session = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {
                "cwd": "/tmp",
                "mcpServers": [],
                "_meta": {
                    "sandboxagent.dev": {
                        "agent": agent
                    }
                }
            }
        });
        let (status, _, new_body) = send_request(
            &test_app.app,
            Method::POST,
            "/v2/rpc",
            Some(new_session),
            &[("x-acp-connection-id", connection_id)],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{agent}: session/new status");
        let new_json = parse_json(&new_body);
        assert_eq!(new_json["jsonrpc"], "2.0", "{agent}: session/new jsonrpc");
        assert_eq!(new_json["id"], 2, "{agent}: session/new id");

        let session_id = new_json["result"]["sessionId"]
            .as_str()
            .expect("session id");

        let prompt = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": "ping"}]
            }
        });
        let (status, _, prompt_body) = send_request(
            &test_app.app,
            Method::POST,
            "/v2/rpc",
            Some(prompt),
            &[("x-acp-connection-id", connection_id)],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{agent}: prompt status");
        let prompt_json = parse_json(&prompt_body);
        assert_eq!(prompt_json["jsonrpc"], "2.0", "{agent}: prompt jsonrpc");
        assert_eq!(prompt_json["id"], 3, "{agent}: prompt id");
        assert_eq!(
            prompt_json["result"]["stopReason"], "end_turn",
            "{agent}: prompt stop reason"
        );

        let sse_chunk = read_first_sse_chunk(&test_app.app, connection_id).await;
        let sse_envelope = parse_sse_data(&sse_chunk);
        assert_eq!(sse_envelope["jsonrpc"], "2.0", "{agent}: SSE jsonrpc");
        assert_eq!(
            sse_envelope["method"], "session/update",
            "{agent}: SSE method"
        );
        assert!(
            sse_envelope["params"]["update"]["content"]["text"]
                .as_str()
                .is_some_and(|text| text.contains(agent)),
            "{agent}: SSE content text"
        );

        let (close_status, _, _) = send_request(
            &test_app.app,
            Method::DELETE,
            "/v2/rpc",
            None,
            &[("x-acp-connection-id", connection_id)],
        )
        .await;
        assert_eq!(
            close_status,
            StatusCode::NO_CONTENT,
            "{agent}: close status"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn one_agent_process_is_shared_across_connections() {
    let test_app = TestApp::with_setup(|install_dir| {
        let counter_file = install_dir.join("codex-process-start-count.txt");
        setup_stub_artifacts(install_dir, "codex");
        let launcher = install_dir.join("agent_processes").join("codex-acp");
        write_stub_agent_process_with_counter(&launcher, "codex", Some(&counter_file));
    });

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

    let (status, headers_a, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize.clone()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let connection_a = headers_a
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id")
        .to_string();

    let (status, headers_b, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let connection_b = headers_b
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id")
        .to_string();

    let new_session = json!({
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
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session.clone()),
        &[("x-acp-connection-id", &connection_a)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session),
        &[("x-acp-connection-id", &connection_b)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let counter_file = test_app
        ._install_dir
        .path()
        .join("codex-process-start-count.txt");
    let count = fs::read_to_string(counter_file).expect("read process start count file");
    assert_eq!(count.trim(), "1");
}

#[cfg(unix)]
#[tokio::test]
async fn session_list_is_global_across_agents() {
    let test_app = TestApp::with_setup(|install_dir| {
        setup_stub_artifacts(install_dir, "claude");
        setup_stub_artifacts(install_dir, "codex");
    });

    let initialize = |id: i64, agent: &str| {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "1.0",
                "clientCapabilities": {},
                "_meta": {
                    "sandboxagent.dev": {
                        "agent": agent
                    }
                }
            }
        })
    };

    let (status, claude_headers, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize(1, "claude")),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let claude_conn = claude_headers
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id")
        .to_string();

    let (status, codex_headers, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize(2, "codex")),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let codex_conn = codex_headers
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id")
        .to_string();

    let new_session = |id: i64, agent: &str| {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/new",
            "params": {
                "cwd": "/tmp",
                "mcpServers": [],
                "_meta": {
                    "sandboxagent.dev": {
                        "agent": agent
                    }
                }
            }
        })
    };

    let (status, _, claude_session_body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session(3, "claude")),
        &[("x-acp-connection-id", &claude_conn)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let claude_session = parse_json(&claude_session_body)["result"]["sessionId"]
        .as_str()
        .expect("claude session")
        .to_string();

    let (status, _, codex_session_body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(new_session(4, "codex")),
        &[("x-acp-connection-id", &codex_conn)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let codex_session = parse_json(&codex_session_body)["result"]["sessionId"]
        .as_str()
        .expect("codex session")
        .to_string();

    let list_request = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "session/list",
        "params": {}
    });
    let (status, _, list_body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(list_request),
        &[("x-acp-connection-id", &claude_conn)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list_json = parse_json(&list_body);
    let sessions = list_json["result"]["sessions"]
        .as_array()
        .expect("sessions");
    assert!(sessions
        .iter()
        .any(|session| session["sessionId"] == claude_session));
    assert!(sessions
        .iter()
        .any(|session| session["sessionId"] == codex_session));
}

#[cfg(unix)]
#[tokio::test]
async fn list_models_extension_uses_non_mock_agent_process() {
    let test_app = TestApp::with_setup(|install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

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
    let (status, headers, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(initialize),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let connection_id = headers
        .get("x-acp-connection-id")
        .and_then(|value| value.to_str().ok())
        .expect("connection id")
        .to_string();

    let list_models = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "_sandboxagent/session/list_models",
        "params": {
            "agent": "codex"
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v2/rpc",
        Some(list_models),
        &[("x-acp-connection-id", &connection_id)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let models = parsed["result"]["availableModels"]
        .as_array()
        .expect("available models");
    assert!(
        models.iter().any(|model| model["modelId"] == "codex-model"),
        "expected codex model in {models:?}"
    );
    assert_eq!(parsed["result"]["currentModelId"], "codex-model");
}
