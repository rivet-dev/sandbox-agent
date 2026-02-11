use std::fs;
use std::path::Path;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use futures::StreamExt;
use http_body_util::BodyExt;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent_agent_management::agents::AgentManager;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::util::ServiceExt;

struct TestApp {
    app: axum::Router,
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

fn write_executable(path: &Path, script: &str) {
    fs::write(path, script).expect("write executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).expect("set mode");
    }
}

fn write_stub_native(path: &Path, agent: &str) {
    let script = format!("#!/usr/bin/env sh\necho \"{agent} 0.0.1\"\nexit 0\n");
    write_executable(path, &script);
}

fn write_stub_agent_process(path: &Path, agent: &str) {
    let script = format!(
        r#"#!/usr/bin/env sh
if [ "${{1:-}}" = "--help" ] || [ "${{1:-}}" = "--version" ] || [ "${{1:-}}" = "version" ] || [ "${{1:-}}" = "-V" ]; then
  echo "{agent}-agent-process 0.0.1"
  exit 0
fi

while IFS= read -r line; do
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([^,}}]*\).*/\1/p')

  if [ -n "$method" ]; then
    printf '{{"jsonrpc":"2.0","method":"server/echo","params":{{"agent":"{agent}","method":"%s"}}}}\n' "$method"
  fi

  if [ -n "$method" ] && [ -n "$id" ]; then
    printf '{{"jsonrpc":"2.0","id":%s,"result":{{"ok":true,"agent":"{agent}","echoedMethod":"%s"}}}}\n' "$id" "$method"
  fi
done
"#
    );

    write_executable(path, &script);
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

fn setup_stub_agent_process_only(install_dir: &Path, agent: &str) {
    let agent_processes = install_dir.join("agent_processes");
    fs::create_dir_all(&agent_processes).expect("create agent processes dir");
    let launcher = if cfg!(windows) {
        agent_processes.join(format!("{agent}-acp.cmd"))
    } else {
        agent_processes.join(format!("{agent}-acp"))
    };
    write_stub_agent_process(&launcher, agent);
}

async fn send_request(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    let request_body = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };

    let request = builder.body(request_body).expect("build request");
    let response = app.clone().oneshot(request).await.expect("request handled");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();

    (status, bytes.to_vec())
}

fn parse_json(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).expect("valid json")
    }
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_matrix_smoke_and_jsonrpc_conformance() {
    let native_agents = ["claude", "codex", "opencode"];
    let agent_process_only_agents = ["pi", "cursor"];
    let agents: Vec<&str> = native_agents
        .iter()
        .chain(agent_process_only_agents.iter())
        .copied()
        .collect();
    let test_app = TestApp::with_setup(|install_dir| {
        for agent in native_agents {
            setup_stub_artifacts(install_dir, agent);
        }
        for agent in agent_process_only_agents {
            setup_stub_agent_process_only(install_dir, agent);
        }
    });

    for agent in agents {
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "1.0",
                "clientCapabilities": {}
            }
        });
        let (status, init_body) = send_request(
            &test_app.app,
            Method::POST,
            &format!("/v1/acp/{agent}-server?agent={agent}"),
            Some(initialize),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{agent}: initialize status");
        let init_json = parse_json(&init_body);
        assert_eq!(init_json["jsonrpc"], "2.0", "{agent}: initialize jsonrpc");
        assert_eq!(init_json["id"], 1, "{agent}: initialize id");
        assert_eq!(
            init_json["result"]["agent"], agent,
            "{agent}: initialize agent"
        );

        let new_session = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {
                "cwd": "/tmp"
            }
        });
        let (status, new_body) = send_request(
            &test_app.app,
            Method::POST,
            &format!("/v1/acp/{agent}-server"),
            Some(new_session),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{agent}: session/new status");
        let new_json = parse_json(&new_body);
        assert_eq!(new_json["jsonrpc"], "2.0", "{agent}: session/new jsonrpc");
        assert_eq!(new_json["id"], 2, "{agent}: session/new id");
        assert_eq!(new_json["result"]["echoedMethod"], "session/new");

        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("/v1/acp/{agent}-server"))
            .body(Body::empty())
            .expect("build sse request");

        let response = test_app
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("sse response");
        assert_eq!(response.status(), StatusCode::OK);

        let mut stream = response.into_body().into_data_stream();
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            while let Some(item) = stream.next().await {
                let bytes = item.expect("sse chunk");
                let text = String::from_utf8_lossy(&bytes).to_string();
                if text.contains("server/echo") {
                    return text;
                }
            }
            panic!("sse ended")
        })
        .await
        .expect("sse timeout");

        assert!(
            chunk.contains("server/echo"),
            "{agent}: missing server/echo"
        );
    }
}
