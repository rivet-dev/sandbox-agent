use super::*;
use serial_test::serial;
use std::collections::BTreeMap;

#[tokio::test]
#[serial]
async fn v1_desktop_status_reports_install_required_when_dependencies_are_missing() {
    let temp = tempfile::tempdir().expect("create empty path tempdir");
    let mut env = BTreeMap::new();
    env.insert(
        "PATH".to_string(),
        temp.path().to_string_lossy().to_string(),
    );

    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        docker_support::TestAppOptions {
            env,
            replace_path: true,
            ..Default::default()
        },
        |_| {},
    );

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/desktop/status", None, &[]).await;

    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "install_required");
    assert!(parsed["missingDependencies"]
        .as_array()
        .expect("missingDependencies array")
        .iter()
        .any(|value| value == "Xvfb"));
    assert_eq!(
        parsed["installCommand"],
        "sandbox-agent install desktop --yes"
    );
}

#[tokio::test]
#[serial]
async fn v1_desktop_lifecycle_and_actions_work_with_real_runtime() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/start",
        Some(json!({
            "width": 1440,
            "height": 900,
            "dpi": 96
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "unexpected start response: {}",
        String::from_utf8_lossy(&body)
    );
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "active");
    let display = parsed["display"]
        .as_str()
        .expect("desktop display")
        .to_string();
    assert!(display.starts_with(':'));
    assert_eq!(parsed["resolution"]["width"], 1440);
    assert_eq!(parsed["resolution"]["height"], 900);

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/desktop/screenshot",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("image/png")
    );
    assert!(body.starts_with(b"\x89PNG\r\n\x1a\n"));

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/desktop/screenshot/region?x=10&y=20&width=30&height=40",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with(b"\x89PNG\r\n\x1a\n"));

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/desktop/display/info",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let display_info = parse_json(&body);
    assert_eq!(display_info["display"], display);
    assert_eq!(display_info["resolution"]["width"], 1440);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/move",
        Some(json!({ "x": 400, "y": 300 })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mouse = parse_json(&body);
    assert_eq!(mouse["x"], 400);
    assert_eq!(mouse["y"], 300);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/drag",
        Some(json!({
            "startX": 100,
            "startY": 110,
            "endX": 220,
            "endY": 230,
            "button": "left"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let dragged = parse_json(&body);
    assert_eq!(dragged["x"], 220);
    assert_eq!(dragged["y"], 230);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/click",
        Some(json!({
            "x": 220,
            "y": 230,
            "button": "left",
            "clickCount": 1
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let clicked = parse_json(&body);
    assert_eq!(clicked["x"], 220);
    assert_eq!(clicked["y"], 230);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/mouse/scroll",
        Some(json!({
            "x": 220,
            "y": 230,
            "deltaY": -3
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let scrolled = parse_json(&body);
    assert_eq!(scrolled["x"], 220);
    assert_eq!(scrolled["y"], 230);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/desktop/mouse/position",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let position = parse_json(&body);
    assert_eq!(position["x"], 220);
    assert_eq!(position["y"], 230);

    launch_desktop_focus_window(&test_app.app, &display).await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/type",
        Some(json!({ "text": "hello world", "delayMs": 5 })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/desktop/keyboard/press",
        Some(json!({ "key": "ctrl+l" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    let (status, _, body) =
        send_request(&test_app.app, Method::POST, "/v1/desktop/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["state"], "inactive");
}
