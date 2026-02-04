include!("./common/http.rs");

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run_git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .expect("run git command");
    assert!(status.success(), "git command failed: {:?}", args);
}

fn init_repo() -> tempfile::TempDir {
    let repo = tempfile::tempdir().expect("create repo dir");
    run_git(repo.path(), &["init", "-b", "main"]);
    fs::write(repo.path().join("README.md"), "hello\n").expect("write file");
    run_git(repo.path(), &["add", "."]);
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=Sandbox",
            "-c",
            "user.email=sandbox@example.com",
            "commit",
            "-m",
            "init",
        ])
        .current_dir(repo.path())
        .status()
        .expect("git commit");
    assert!(status.success(), "git commit failed");
    repo
}

fn opencode_request(
    method: Method,
    path: &str,
    directory: &Path,
    body: Option<Value>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("x-opencode-directory", directory.to_string_lossy().to_string());
    let body = if let Some(body) = body {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    builder.body(body).expect("request")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opencode_project_metadata() {
    let repo = init_repo();
    let app = TestApp::new();

    let request = opencode_request(Method::GET, "/opencode/project/current", repo.path(), None);
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "project current status");
    let project_id = payload.get("id").and_then(Value::as_str).unwrap_or("");
    assert!(!project_id.is_empty(), "project id missing");
    assert_eq!(
        payload.get("vcs").and_then(Value::as_str),
        Some("git")
    );
    assert_eq!(
        payload.get("worktree").and_then(Value::as_str),
        Some(repo.path().to_string_lossy().as_ref())
    );
    assert_eq!(
        payload.get("directory").and_then(Value::as_str),
        Some(repo.path().to_string_lossy().as_ref())
    );
    assert_eq!(
        payload.get("branch").and_then(Value::as_str),
        Some("main")
    );
    let repo_name = repo
        .path()
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    assert_eq!(payload.get("name").and_then(Value::as_str), Some(repo_name));

    let request = opencode_request(Method::GET, "/opencode/project", repo.path(), None);
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "project list status");
    let list = payload.as_array().cloned().unwrap_or_default();
    assert!(
        list.iter()
            .any(|project| project.get("id").and_then(Value::as_str) == Some(project_id)),
        "project list missing current id"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opencode_worktree_lifecycle() {
    let repo = init_repo();
    let app = TestApp::new();

    let create_body = json!({"name": "feature-a"});
    let request = opencode_request(
        Method::POST,
        "/opencode/experimental/worktree",
        repo.path(),
        Some(create_body),
    );
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "worktree create status");

    let expected_dir: PathBuf = repo
        .path()
        .join(".opencode")
        .join("worktrees")
        .join("feature-a");
    assert_eq!(
        payload.get("directory").and_then(Value::as_str),
        Some(expected_dir.to_string_lossy().as_ref())
    );
    assert!(expected_dir.exists(), "worktree directory missing");

    let request = opencode_request(Method::GET, "/opencode/experimental/worktree", repo.path(), None);
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "worktree list status");
    let list = payload.as_array().cloned().unwrap_or_default();
    assert!(
        list.iter()
            .any(|value| value.as_str() == Some(expected_dir.to_string_lossy().as_ref())),
        "worktree list missing new worktree"
    );

    let reset_body = json!({"directory": expected_dir.to_string_lossy()});
    let request = opencode_request(
        Method::POST,
        "/opencode/experimental/worktree/reset",
        repo.path(),
        Some(reset_body),
    );
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "worktree reset status");
    assert_eq!(payload, json!(true));

    let remove_body = json!({"directory": expected_dir.to_string_lossy()});
    let request = opencode_request(
        Method::DELETE,
        "/opencode/experimental/worktree",
        repo.path(),
        Some(remove_body),
    );
    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "worktree delete status");
    assert_eq!(payload, json!(true));
    assert!(!expected_dir.exists(), "worktree directory not removed");
}
