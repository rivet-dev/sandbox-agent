use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;

include!("common/http.rs");

#[derive(Clone)]
struct McpTestState {
    token: String,
}

async fn mcp_handler(
    State(state): State<Arc<McpTestState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let expected = format!("Bearer {}", state.token);
    let auth = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if auth != Some(expected.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "unauthorized"})),
        );
    }

    let method = body.get("method").and_then(|value| value.as_str()).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or_else(|| json!(null));
    match method {
        "initialize" => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {"serverInfo": {"name": "mcp-test", "version": "0.1.0"}}
            })),
        ),
        "tools/list" => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "weather",
                            "description": "Get weather",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "city": {"type": "string"}
                                },
                                "required": ["city"]
                            }
                        }
                    ]
                }
            })),
        ),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": "method not found"}
            })),
        ),
    }
}

async fn spawn_mcp_server(token: &str) -> (String, tokio::task::JoinHandle<()>) {
    let state = Arc::new(McpTestState {
        token: token.to_string(),
    });
    let app = Router::new().route("/mcp", post(mcp_handler)).with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mcp listener");
    let addr = listener.local_addr().expect("local addr");
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mcp server");
    });
    (format!("http://{}/mcp", addr), handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opencode_mcp_auth_and_tools() {
    let token = "mcp-test-token";
    let (mcp_url, handle) = spawn_mcp_server(token).await;
    let app = TestApp::new();

    let (status, payload) = send_json(
        &app.app,
        Method::POST,
        "/opencode/mcp",
        Some(json!({
            "name": "test",
            "config": {
                "type": "remote",
                "url": mcp_url,
                "oauth": {},
                "headers": {}
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "register mcp server");
    assert_eq!(
        payload
            .get("test")
            .and_then(|value| value.get("status"))
            .and_then(|value| value.as_str()),
        Some("needs_auth")
    );

    let (status, payload) = send_json(&app.app, Method::POST, "/opencode/mcp/test/auth", None).await;
    assert_eq!(status, StatusCode::OK, "start mcp auth");
    assert!(
        payload
            .get("authorizationUrl")
            .and_then(|value| value.as_str())
            .is_some(),
        "authorizationUrl missing"
    );

    let (status, payload) = send_json(
        &app.app,
        Method::POST,
        "/opencode/mcp/test/auth/callback",
        Some(json!({"code": token})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "complete mcp auth");
    assert_eq!(
        payload
            .get("status")
            .and_then(|value| value.as_str()),
        Some("connected")
    );

    let (status, payload) =
        send_json(&app.app, Method::POST, "/opencode/mcp/test/connect", None).await;
    assert_eq!(status, StatusCode::OK, "connect mcp server");
    assert_eq!(payload, json!(true));

    let (status, payload) = send_json(
        &app.app,
        Method::GET,
        "/opencode/experimental/tool/ids?provider=sandbox-agent&model=mock",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "tool ids");
    let ids = payload.as_array().expect("tool ids array");
    assert!(
        ids.contains(&Value::String("mcp:test:weather".to_string())),
        "missing tool id"
    );

    let (status, payload) = send_json(
        &app.app,
        Method::GET,
        "/opencode/experimental/tool?provider=sandbox-agent&model=mock",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "tool list");
    let tools = payload.as_array().expect("tools array");
    let tool = tools
        .iter()
        .find(|tool| tool.get("id").and_then(|value| value.as_str()) == Some("mcp:test:weather"))
        .expect("mcp tool entry");
    assert_eq!(
        tool.get("description").and_then(|value| value.as_str()),
        Some("Get weather")
    );

    handle.abort();
}
