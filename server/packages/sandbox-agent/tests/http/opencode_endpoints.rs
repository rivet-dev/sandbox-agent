include!("../common/http.rs");

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::Path;

struct PathGuard {
    old_path: Option<std::ffi::OsString>,
}

impl PathGuard {
    fn new(bin_dir: &Path) -> Self {
        let old_path = env::var_os("PATH");
        let mut paths = vec![bin_dir.to_path_buf()];
        if let Some(existing) = &old_path {
            paths.extend(env::split_paths(existing));
        }
        let joined = env::join_paths(paths).expect("join PATH");
        env::set_var("PATH", &joined);
        Self { old_path }
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.old_path {
            env::set_var("PATH", value);
        } else {
            env::remove_var("PATH");
        }
    }
}

#[cfg(windows)]
fn binary_filename(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn binary_filename(name: &str) -> String {
    name.to_string()
}

fn write_executable(path: &Path) {
    fs::write(path, "").expect("write fake binary");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .expect("metadata")
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).expect("set permissions");
    }
}

fn add_fake_binary(dir: &Path, name: &str) {
    let path = dir.join(binary_filename(name));
    write_executable(&path);
}

fn create_fixture_file(root: &Path, name: &str) {
    let path = root.join(name);
    fs::write(path, "test").expect("write fixture");
}

fn collect_names(value: &serde_json::Value, field: &str) -> HashSet<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get(field).and_then(|value| value.as_str()))
        .map(|value| value.to_string())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opencode_formatter_lsp_status_for_workspace() {
    let fixture_dir = tempfile::tempdir().expect("fixture dir");
    create_fixture_file(fixture_dir.path(), "main.rs");
    create_fixture_file(fixture_dir.path(), "main.ts");
    create_fixture_file(fixture_dir.path(), "main.py");
    create_fixture_file(fixture_dir.path(), "main.go");

    let bin_dir = tempfile::tempdir().expect("bin dir");
    add_fake_binary(bin_dir.path(), "rust-analyzer");
    add_fake_binary(bin_dir.path(), "typescript-language-server");
    add_fake_binary(bin_dir.path(), "pyright-langserver");
    add_fake_binary(bin_dir.path(), "gopls");
    let _guard = PathGuard::new(bin_dir.path());

    let app = TestApp::new();
    let directory = fixture_dir
        .path()
        .to_str()
        .expect("fixture dir path");

    let formatter_request = Request::builder()
        .method(Method::GET)
        .uri("/opencode/formatter")
        .header("x-opencode-directory", directory)
        .body(Body::empty())
        .expect("formatter request");
    let (status, _headers, payload) = send_json_request(&app.app, formatter_request).await;
    assert_eq!(status, StatusCode::OK, "formatter status");

    let formatter_names = collect_names(&payload, "name");
    for expected in ["prettier", "rustfmt", "gofmt", "black"] {
        assert!(
            formatter_names.contains(expected),
            "expected formatter {expected}"
        );
    }

    let lsp_request = Request::builder()
        .method(Method::GET)
        .uri("/opencode/lsp")
        .header("x-opencode-directory", directory)
        .body(Body::empty())
        .expect("lsp request");
    let (status, _headers, payload) = send_json_request(&app.app, lsp_request).await;
    assert_eq!(status, StatusCode::OK, "lsp status");

    let lsp_ids = collect_names(&payload, "id");
    for expected in [
        "typescript-language-server",
        "rust-analyzer",
        "gopls",
        "pyright",
    ] {
        assert!(lsp_ids.contains(expected), "expected lsp {expected}");
    }

    let statuses: HashSet<String> = payload
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("status").and_then(|value| value.as_str()))
        .map(|value| value.to_string())
        .collect();
    assert!(
        statuses.iter().all(|value| value == "connected"),
        "expected all LSPs connected"
    );
}
