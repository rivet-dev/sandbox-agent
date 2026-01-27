use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use sandbox_agent_agent_management::agents::AgentManager;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent::ui;
use tempfile::TempDir;
use tower::util::ServiceExt;

#[tokio::test]
async fn serves_inspector_ui() {
    if !ui::is_enabled() {
        return;
    }

    let install_dir = TempDir::new().expect("create temp install dir");
    let manager = AgentManager::new(install_dir.path()).expect("create agent manager");
    let state = AppState::new(AuthConfig::disabled(), manager);
    let app = build_router(state);

    let request = Request::builder()
        .uri("/ui")
        .body(Body::empty())
        .expect("build request");
    let response = app
        .oneshot(request)
        .await
        .expect("request handled");

    assert_eq!(response.status(), StatusCode::OK);

    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    let body = String::from_utf8_lossy(&bytes);
    assert!(body.contains("<!doctype html") || body.contains("<html"));
}
