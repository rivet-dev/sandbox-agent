include!("../common/http.rs");

fn expect_formatter(payload: &serde_json::Value, name: &str, ext: &str) {
    let entries = payload
        .as_array()
        .unwrap_or_else(|| panic!("formatter payload should be array: {payload}"));
    let entry = entries
        .iter()
        .find(|value| value.get("name").and_then(|v| v.as_str()) == Some(name))
        .unwrap_or_else(|| panic!("formatter {name} not found in {entries:?}"));
    let enabled = entry.get("enabled").and_then(|value| value.as_bool());
    assert_eq!(enabled, Some(true), "formatter {name} should be enabled");
    let extensions = entry
        .get("extensions")
        .and_then(|value| value.as_array())
        .unwrap_or_else(|| panic!("formatter {name} extensions missing: {entry}"));
    let has_ext = extensions
        .iter()
        .any(|value| value.as_str() == Some(ext));
    assert!(has_ext, "formatter {name} missing extension {ext}");
}

fn expect_lsp(payload: &serde_json::Value, id: &str, root: &str) {
    let entries = payload
        .as_array()
        .unwrap_or_else(|| panic!("lsp payload should be array: {payload}"));
    let entry = entries
        .iter()
        .find(|value| value.get("id").and_then(|v| v.as_str()) == Some(id))
        .unwrap_or_else(|| panic!("lsp {id} not found in {entries:?}"));
    let entry_root = entry
        .get("root")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    assert_eq!(entry_root, root, "lsp {id} root mismatch");
    let status = entry
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    assert!(
        matches!(status, "connected" | "error"),
        "lsp {id} status unexpected: {status}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opencode_formatter_and_lsp_status() {
    let app = TestApp::new();
    let tempdir = tempfile::tempdir().expect("tempdir");
    let root = tempdir.path();
    std::fs::create_dir_all(root.join("src")).expect("create src");
    std::fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("write rs");
    std::fs::write(root.join("src/app.ts"), "export const x = 1;\n").expect("write ts");

    let root_str = root
        .to_str()
        .unwrap_or_else(|| panic!("tempdir path not utf8: {root:?}"));

    let formatter_request = Request::builder()
        .method(Method::GET)
        .uri("/opencode/formatter")
        .header("x-opencode-directory", root_str)
        .body(Body::empty())
        .expect("formatter request");
    let (status, _headers, payload) = send_json_request(&app.app, formatter_request).await;
    assert_eq!(status, StatusCode::OK, "formatter status");
    expect_formatter(&payload, "rustfmt", ".rs");
    expect_formatter(&payload, "prettier", ".ts");

    let lsp_request = Request::builder()
        .method(Method::GET)
        .uri("/opencode/lsp")
        .header("x-opencode-directory", root_str)
        .body(Body::empty())
        .expect("lsp request");
    let (status, _headers, payload) = send_json_request(&app.app, lsp_request).await;
    assert_eq!(status, StatusCode::OK, "lsp status");
    expect_lsp(&payload, "rust-analyzer", root_str);
    expect_lsp(&payload, "typescript-language-server", root_str);
}
