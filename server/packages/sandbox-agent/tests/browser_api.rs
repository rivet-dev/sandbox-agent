/// Integration tests for the browser HTTP API.
///
/// These tests use docker/test-agent/Dockerfile which includes Chromium and
/// its dependencies pre-installed.
///
/// Run with:
///   cargo test -p sandbox-agent --test browser_api
use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use sandbox_agent::router::AuthConfig;
use serde_json::{json, Value};
use serial_test::serial;

#[path = "support/docker.rs"]
mod docker_support;
use docker_support::TestApp;

async fn send_request(
    app: &docker_support::DockerApp,
    method: Method,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let client = reqwest::Client::new();
    let mut builder = client.request(method, app.http_url(uri));
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes()).expect("header name");
        let header_value = HeaderValue::from_str(value).expect("header value");
        builder = builder.header(header_name, header_value);
    }

    let response = if let Some(body) = body {
        builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("request handled")
    } else {
        builder.send().await.expect("request handled")
    };
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.expect("collect body");

    (status, headers, bytes.to_vec())
}

async fn send_request_raw(
    app: &docker_support::DockerApp,
    method: Method,
    uri: &str,
    body: Option<Vec<u8>>,
    headers: &[(&str, &str)],
    content_type: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let client = reqwest::Client::new();
    let mut builder = client.request(method, app.http_url(uri));
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes()).expect("header name");
        let header_value = HeaderValue::from_str(value).expect("header value");
        builder = builder.header(header_name, header_value);
    }

    let response = if let Some(body) = body {
        if let Some(content_type) = content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        builder.body(body).send().await.expect("request handled")
    } else {
        builder.send().await.expect("request handled")
    };
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.bytes().await.expect("collect body");

    (status, headers, bytes.to_vec())
}

fn parse_json(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes).expect("valid json")
    }
}

/// Write a file into the container using the filesystem API.
async fn write_test_file(app: &docker_support::DockerApp, path: &str, content: &str) {
    let client = reqwest::Client::new();
    let response = client
        .put(app.http_url("/v1/fs/file"))
        .query(&[("path", path)])
        .body(content.to_string())
        .send()
        .await
        .expect("write test file");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "failed to write test file at {path}"
    );
}

const TEST_HTML: &str = r#"<!DOCTYPE html>
<html>
<head><title>Browser Test Page</title></head>
<body>
  <h1 id="heading">Hello Browser</h1>
  <p class="content">Test paragraph</p>
  <a href="https://example.com">Example Link</a>
  <button id="btn" onclick="document.getElementById('result').textContent='clicked'">Click Me</button>
  <input id="input" type="text" value="" />
  <div id="result"></div>
</body>
</html>"#;

const TEST_HTML_PAGE2: &str = r#"<!DOCTYPE html>
<html>
<head><title>Page Two</title></head>
<body><h1>Second Page</h1></body>
</html>"#;

#[tokio::test]
#[serial]
async fn v1_browser_status_reports_install_required_when_chromium_missing() {
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
        send_request(&test_app.app, Method::GET, "/v1/browser/status", None, &[]).await;

    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "install_required");
    assert!(parsed["missingDependencies"]
        .as_array()
        .expect("missingDependencies array")
        .iter()
        .any(|value| value
            .as_str()
            .map(|s| s.contains("chromium"))
            .unwrap_or(false)));
    assert_eq!(
        parsed["installCommand"],
        "sandbox-agent install browser --yes"
    );
}

#[tokio::test]
#[serial]
async fn v1_browser_lifecycle_and_navigation() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // -- Status should be inactive before start --
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/status", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "inactive");

    // -- Start browser (headless) --
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({
            "width": 1280,
            "height": 720,
            "headless": true
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

    // -- Status should be active --
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/status", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "active");
    assert!(parsed["startedAt"].is_string());

    // -- Write test HTML pages --
    write_test_file(&test_app.app, "/tmp/test-page1.html", TEST_HTML).await;
    write_test_file(&test_app.app, "/tmp/test-page2.html", TEST_HTML_PAGE2).await;

    // -- Navigate to test page --
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": "file:///tmp/test-page1.html" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert!(
        parsed["url"]
            .as_str()
            .unwrap_or("")
            .contains("test-page1.html"),
        "expected URL to contain test-page1.html, got: {}",
        parsed["url"]
    );
    assert_eq!(parsed["title"], "Browser Test Page");

    // -- Navigate to second page --
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": "file:///tmp/test-page2.html" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["title"], "Page Two");

    // -- Navigate back --
    let (status, _, body) =
        send_request(&test_app.app, Method::POST, "/v1/browser/back", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert!(
        parsed["url"]
            .as_str()
            .unwrap_or("")
            .contains("test-page1.html"),
        "expected back to return to page1, got: {}",
        parsed["url"]
    );

    // -- Navigate forward --
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/forward",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert!(
        parsed["url"]
            .as_str()
            .unwrap_or("")
            .contains("test-page2.html"),
        "expected forward to return to page2, got: {}",
        parsed["url"]
    );

    // -- Reload --
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/reload",
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert!(parsed["url"]
        .as_str()
        .unwrap_or("")
        .contains("test-page2.html"));

    // -- Stop browser --
    let (status, _, body) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["state"], "inactive");

    // -- Status should be inactive after stop --
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/status", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["state"], "inactive");
}

#[tokio::test]
#[serial]
async fn v1_browser_tabs_management() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    // List tabs - should have 1 initial tab
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/tabs", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let tabs = parsed["tabs"].as_array().expect("tabs array");
    assert!(!tabs.is_empty(), "should have at least 1 tab");
    let initial_tab_count = tabs.len();

    // Create a new tab
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/tabs",
        Some(json!({ "url": "about:blank" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let new_tab = parse_json(&body);
    let new_tab_id = new_tab["id"].as_str().expect("new tab id").to_string();
    assert!(!new_tab_id.is_empty());

    // List tabs should now show one more
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/tabs", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let tabs = parsed["tabs"].as_array().expect("tabs array");
    assert_eq!(tabs.len(), initial_tab_count + 1);

    // Activate the new tab
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        &format!("/v1/browser/tabs/{new_tab_id}/activate"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let activated = parse_json(&body);
    assert_eq!(activated["id"], new_tab_id);

    // Close the new tab
    let (status, _, body) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/browser/tabs/{new_tab_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    // List tabs should be back to initial count
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/tabs", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let tabs = parsed["tabs"].as_array().expect("tabs array");
    assert_eq!(tabs.len(), initial_tab_count);

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn v1_browser_screenshots() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true, "width": 800, "height": 600 })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    // Navigate to a page so there's content
    write_test_file(&test_app.app, "/tmp/test-screenshot.html", TEST_HTML).await;
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": "file:///tmp/test-screenshot.html" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // PNG screenshot
    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/browser/screenshot",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );
    assert!(
        body.starts_with(b"\x89PNG\r\n\x1a\n"),
        "expected PNG magic bytes"
    );
    assert!(body.len() > 100, "screenshot should be non-trivial size");

    // JPEG screenshot
    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/browser/screenshot?format=jpeg&quality=50",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("image/jpeg")
    );
    assert!(body.starts_with(&[0xff, 0xd8, 0xff]), "expected JPEG magic");

    // WebP screenshot
    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/browser/screenshot?format=webp",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("image/webp")
    );
    assert!(body.len() > 100, "webp screenshot should be non-trivial");

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn v1_browser_content_extraction() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    // Navigate to test page
    write_test_file(&test_app.app, "/tmp/test-content.html", TEST_HTML).await;
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": "file:///tmp/test-content.html" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Get HTML content
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/content", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let html = parsed["html"].as_str().unwrap_or("");
    assert!(
        html.contains("Hello Browser"),
        "HTML should contain heading text"
    );
    assert!(
        html.contains("<button"),
        "HTML should contain button element"
    );

    // Get markdown
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/browser/markdown",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let markdown = parsed["markdown"].as_str().unwrap_or("");
    assert!(!markdown.is_empty(), "markdown should not be empty");

    // Get links
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/links", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let links = parsed["links"].as_array().expect("links array");
    assert!(
        links
            .iter()
            .any(|l| l["href"].as_str().unwrap_or("").contains("example.com")),
        "should find example.com link"
    );

    // Get accessibility snapshot
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/browser/snapshot",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let snapshot = parsed["snapshot"].as_str().unwrap_or("");
    assert!(!snapshot.is_empty(), "snapshot should not be empty");

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn v1_browser_interaction() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    // Navigate to test page
    write_test_file(&test_app.app, "/tmp/test-interact.html", TEST_HTML).await;
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": "file:///tmp/test-interact.html" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Click the button
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/click",
        Some(json!({ "selector": "#btn" })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "click: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(parse_json(&body)["ok"], true);

    // Verify click effect via execute
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/execute",
        Some(json!({ "expression": "document.getElementById('result').textContent" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(
        parsed["result"], "clicked",
        "button click should have updated result div"
    );

    // Type text into input
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/type",
        Some(json!({ "selector": "#input", "text": "hello world" })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "type: {}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(parse_json(&body)["ok"], true);

    // Verify typed text
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/execute",
        Some(json!({ "expression": "document.getElementById('input').value" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(
        parsed["result"], "hello world",
        "input should contain typed text"
    );

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn v1_browser_contexts_management() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // List contexts (should be empty initially)
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/browser/contexts",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let initial_count = parsed["contexts"].as_array().expect("contexts array").len();

    // Create a context
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/contexts",
        Some(json!({ "name": "test-profile" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let ctx = parse_json(&body);
    let context_id = ctx["id"].as_str().expect("context id").to_string();
    assert_eq!(ctx["name"], "test-profile");
    assert!(ctx["createdAt"].is_string());

    // List contexts should show one more
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/browser/contexts",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let contexts = parsed["contexts"].as_array().expect("contexts array");
    assert_eq!(contexts.len(), initial_count + 1);
    assert!(contexts
        .iter()
        .any(|c| c["id"].as_str() == Some(&context_id)));

    // Delete context
    let (status, _, body) = send_request(
        &test_app.app,
        Method::DELETE,
        &format!("/v1/browser/contexts/{context_id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["ok"], true);

    // List contexts should be back to initial count
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/browser/contexts",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(
        parsed["contexts"].as_array().expect("contexts array").len(),
        initial_count
    );
}

const TEST_HTML_CONSOLE: &str = r#"<!DOCTYPE html>
<html>
<head><title>Console Test</title></head>
<body>
<script>
console.log('test-message');
console.error('test-error');
console.warn('test-warning');
</script>
</body>
</html>"#;

#[tokio::test]
#[serial]
async fn v1_browser_console_monitoring() {
    let test_app = TestApp::new(AuthConfig::disabled());

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    // Write test page with console calls and navigate to it
    write_test_file(&test_app.app, "/tmp/test-console.html", TEST_HTML_CONSOLE).await;
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": "file:///tmp/test-console.html" })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Wait for CDP events to be captured by background tasks
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Get all console messages
    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/browser/console", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let messages = parsed["messages"].as_array().expect("messages array");

    // Verify we captured the console.log message
    assert!(
        messages
            .iter()
            .any(|m| m["text"].as_str() == Some("test-message")
                && m["level"].as_str() == Some("log")),
        "should contain console.log('test-message'), got: {messages:?}"
    );

    // Verify we captured the console.error message
    assert!(
        messages
            .iter()
            .any(|m| m["text"].as_str() == Some("test-error")
                && m["level"].as_str() == Some("error")),
        "should contain console.error('test-error'), got: {messages:?}"
    );

    // Verify we captured the console.warn message (CDP reports level as "warn")
    assert!(
        messages
            .iter()
            .any(|m| m["text"].as_str() == Some("test-warning")
                && m["level"].as_str() == Some("warn")),
        "should contain console.warn('test-warning'), got: {messages:?}"
    );

    // Filter by level=error - should only return error messages
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/browser/console?level=error",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let messages = parsed["messages"].as_array().expect("messages array");
    assert!(
        !messages.is_empty(),
        "should have at least one error message"
    );
    assert!(
        messages
            .iter()
            .all(|m| m["level"].as_str() == Some("error")),
        "all messages should be error level when filtered, got: {messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|m| m["text"].as_str() == Some("test-error")),
        "should contain 'test-error' message"
    );

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

const TEST_HTML_NETWORK: &str = r#"<!DOCTYPE html>
<html>
<head><title>Network Test</title></head>
<body>
<p>Network test page</p>
<script>
// Trigger a real HTTP fetch so CDP captures a network request with a response
fetch('/hello.txt').catch(function() {});
</script>
</body>
</html>"#;

const TEST_NETWORK_HELLO: &str = "hello from network test";

#[tokio::test]
#[serial]
async fn v1_browser_network_monitoring() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let http_port: u16 = 18770;

    // Write test assets into the container
    write_test_file(
        &test_app.app,
        "/tmp/network-test/index.html",
        TEST_HTML_NETWORK,
    )
    .await;
    write_test_file(
        &test_app.app,
        "/tmp/network-test/hello.txt",
        TEST_NETWORK_HELLO,
    )
    .await;

    // Start an HTTP server inside the container to serve the test pages
    let server_pid = start_http_server(&test_app.app, "/tmp/network-test", http_port).await;

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    // Navigate to the test page served over HTTP (triggers a fetch to /hello.txt)
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/navigate",
        Some(json!({ "url": format!("http://localhost:{http_port}/index.html") })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Poll for network requests until the expected entry appears (up to 5s)
    let mut captured_requests: Vec<serde_json::Value> = Vec::new();
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let (status, _, body) =
            send_request(&test_app.app, Method::GET, "/v1/browser/network", None, &[]).await;
        assert_eq!(status, StatusCode::OK);
        let parsed = parse_json(&body);
        let requests = parsed["requests"].as_array().expect("requests array");
        // Look for the hello.txt request with a populated status
        if requests.iter().any(|r| {
            r["url"]
                .as_str()
                .map_or(false, |u| u.contains("/hello.txt"))
                && r["status"].as_u64().is_some()
        }) {
            captured_requests = requests.clone();
            break;
        }
    }

    assert!(
        !captured_requests.is_empty(),
        "should have captured network requests"
    );

    // Find the hello.txt request and verify its values
    let hello_req = captured_requests
        .iter()
        .find(|r| {
            r["url"]
                .as_str()
                .map_or(false, |u| u.contains("/hello.txt"))
        })
        .expect("should have captured the /hello.txt request");

    assert_eq!(
        hello_req["method"].as_str(),
        Some("GET"),
        "request method should be GET"
    );
    assert_eq!(
        hello_req["status"].as_u64(),
        Some(200),
        "request status should be 200"
    );

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);

    stop_http_server(&test_app.app, &server_pid).await;
}

const TEST_HTML_CRAWL_A: &str = r#"<!DOCTYPE html>
<html>
<head><title>Page A</title></head>
<body>
<h1>Page A</h1>
<p>This is page A content.</p>
<a href="page-b.html">Go to Page B</a>
</body>
</html>"#;

const TEST_HTML_CRAWL_B: &str = r#"<!DOCTYPE html>
<html>
<head><title>Page B</title></head>
<body>
<h1>Page B</h1>
<p>This is page B content.</p>
<a href="page-c.html">Go to Page C</a>
</body>
</html>"#;

const TEST_HTML_CRAWL_C: &str = r#"<!DOCTYPE html>
<html>
<head><title>Page C</title></head>
<body>
<h1>Page C</h1>
<p>This is page C content. No more links.</p>
</body>
</html>"#;

/// Start a Python HTTP server inside the container serving a directory on the
/// given port. Returns the process ID so the caller can clean it up.
async fn start_http_server(app: &docker_support::DockerApp, dir: &str, port: u16) -> String {
    let client = reqwest::Client::new();
    let response = client
        .post(app.http_url("/v1/processes"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(
            json!({
                "command": "python3",
                "args": ["-m", "http.server", port.to_string(), "--directory", dir],
            })
            .to_string(),
        )
        .send()
        .await
        .expect("start http server process");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "failed to start http server"
    );
    let body: Value = response.json().await.expect("json response");
    let process_id = body["id"].as_str().expect("process id").to_string();

    // Wait for the server to bind inside the container by running a curl check.
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let check = client
            .post(app.http_url("/v1/processes/run"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(
                json!({
                    "command": "curl",
                    "args": ["-sf", "-o", "/dev/null", format!("http://localhost:{port}/")],
                    "timeoutMs": 2000
                })
                .to_string(),
            )
            .send()
            .await;
        if let Ok(resp) = check {
            if let Ok(val) = resp.json::<Value>().await {
                if val["exitCode"] == 0 {
                    break;
                }
            }
        }
    }

    process_id
}

/// Stop a process started via the process API.
async fn stop_http_server(app: &docker_support::DockerApp, process_id: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .post(app.http_url(&format!("/v1/processes/{process_id}/kill")))
        .send()
        .await;
}

#[tokio::test]
#[serial]
async fn v1_browser_crawl() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let http_port: u16 = 18765;

    // Write the 3 linked test HTML pages
    write_test_file(
        &test_app.app,
        "/tmp/crawl-test/page-a.html",
        TEST_HTML_CRAWL_A,
    )
    .await;
    write_test_file(
        &test_app.app,
        "/tmp/crawl-test/page-b.html",
        TEST_HTML_CRAWL_B,
    )
    .await;
    write_test_file(
        &test_app.app,
        "/tmp/crawl-test/page-c.html",
        TEST_HTML_CRAWL_C,
    )
    .await;

    // Start a local HTTP server inside the container to serve the test pages.
    let server_pid = start_http_server(&test_app.app, "/tmp/crawl-test", http_port).await;

    // Start browser
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/start",
        Some(json!({ "headless": true })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start: {}",
        String::from_utf8_lossy(&body)
    );

    let base_url = format!("http://localhost:{http_port}");

    // Crawl starting from page-a with maxDepth=2, extract=text
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/crawl",
        Some(json!({
            "url": format!("{base_url}/page-a.html"),
            "maxDepth": 2,
            "extract": "text"
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "crawl: {}",
        String::from_utf8_lossy(&body)
    );
    let parsed = parse_json(&body);
    let pages = parsed["pages"].as_array().expect("pages array");

    // Should have 3 pages: page-a (depth 0), page-b (depth 1), page-c (depth 2)
    assert_eq!(
        pages.len(),
        3,
        "expected 3 crawled pages, got {}: {parsed}",
        pages.len()
    );

    // Verify depths
    assert_eq!(pages[0]["depth"], 0, "page-a should be depth 0");
    assert_eq!(pages[1]["depth"], 1, "page-b should be depth 1");
    assert_eq!(pages[2]["depth"], 2, "page-c should be depth 2");

    // Verify page content (text extraction)
    assert!(
        pages[0]["content"]
            .as_str()
            .unwrap_or("")
            .contains("Page A"),
        "page-a content should contain 'Page A'"
    );
    assert!(
        pages[1]["content"]
            .as_str()
            .unwrap_or("")
            .contains("Page B"),
        "page-b content should contain 'Page B'"
    );
    assert!(
        pages[2]["content"]
            .as_str()
            .unwrap_or("")
            .contains("Page C"),
        "page-c content should contain 'Page C'"
    );

    // Verify totalPages and truncated
    assert_eq!(parsed["totalPages"], 3);
    assert_eq!(parsed["truncated"], false);

    // Test maxPages=1 returns only 1 page and truncated is true
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/crawl",
        Some(json!({
            "url": format!("{base_url}/page-a.html"),
            "maxPages": 1,
            "maxDepth": 2,
            "extract": "text"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let pages = parsed["pages"].as_array().expect("pages array");
    assert_eq!(pages.len(), 1, "maxPages=1 should return only 1 page");
    assert_eq!(parsed["totalPages"], 1);
    assert_eq!(
        parsed["truncated"], true,
        "should be truncated when more pages exist"
    );

    // Test that file:// URLs are rejected with 400
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/browser/crawl",
        Some(json!({
            "url": "file:///etc/passwd",
            "extract": "text"
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "file:// URL should be rejected: {}",
        String::from_utf8_lossy(&body)
    );
    let parsed = parse_json(&body);
    assert_eq!(
        parsed["code"], "browser/invalid-url",
        "should return invalid-url error code"
    );

    // Stop browser
    let (status, _, _) =
        send_request(&test_app.app, Method::POST, "/v1/browser/stop", None, &[]).await;
    assert_eq!(status, StatusCode::OK);

    // Clean up the HTTP server
    stop_http_server(&test_app.app, &server_pid).await;
}
