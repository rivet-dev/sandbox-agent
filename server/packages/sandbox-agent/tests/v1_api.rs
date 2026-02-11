use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
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
use serial_test::serial;
use tempfile::TempDir;
use tower::util::ServiceExt;

struct TestApp {
    app: Router,
    install_dir: TempDir,
}

impl TestApp {
    fn new(auth: AuthConfig) -> Self {
        Self::with_setup(auth, |_| {})
    }

    fn with_setup<F>(auth: AuthConfig, setup: F) -> Self
    where
        F: FnOnce(&Path),
    {
        let install_dir = tempfile::tempdir().expect("create temp install dir");
        setup(install_dir.path());
        let manager = AgentManager::new(install_dir.path()).expect("create agent manager");
        let state = AppState::new(auth, manager);
        let app = build_router(state);
        Self { app, install_dir }
    }

    fn install_path(&self) -> &Path {
        self.install_dir.path()
    }
}

struct EnvVarGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }

    fn set_os(key: &'static str, value: &std::ffi::OsStr) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
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

fn serve_registry_once(document: Value) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind registry server");
    let address = listener.local_addr().expect("registry address");
    let body = document.to_string();

    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            respond_json(&mut stream, &body);
        }
    });

    format!("http://{address}/registry.json")
}

fn respond_json(stream: &mut TcpStream, body: &str) {
    let mut buffer = [0_u8; 4096];
    let _ = stream.read(&mut buffer);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .expect("write registry response");
    stream.flush().expect("flush registry response");
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

async fn send_request_raw(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Vec<u8>>,
    headers: &[(&str, &str)],
    content_type: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }

    let request_body = if let Some(body) = body {
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        Body::from(body)
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

fn initialize_payload() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {}
        }
    })
}

async fn bootstrap_server(app: &Router, server_id: &str, agent: &str) {
    let initialize = initialize_payload();
    let (status, _, _body) = send_request(
        app,
        Method::POST,
        &format!("/v1/acp/{server_id}?agent={agent}"),
        Some(initialize),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

async fn read_first_sse_data(app: &Router, server_id: &str) -> String {
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/v1/acp/{server_id}"))
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

async fn read_first_sse_data_with_last_id(
    app: &Router,
    server_id: &str,
    last_event_id: u64,
) -> String {
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/v1/acp/{server_id}"))
        .header("last-event-id", last_event_id.to_string())
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

fn parse_sse_event_id(chunk: &str) -> u64 {
    chunk
        .lines()
        .find_map(|line| line.strip_prefix("id: "))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .expect("sse event id")
}

#[path = "v1_api/acp_transport.rs"]
mod acp_transport;
#[path = "v1_api/config_endpoints.rs"]
mod config_endpoints;
#[path = "v1_api/control_plane.rs"]
mod control_plane;
