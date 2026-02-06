// Filesystem HTTP endpoints.
include!("../common/http.rs");

use std::fs as stdfs;

use tar::{Builder, Header};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_read_write_move_delete() {
    let app = TestApp::new();
    let cwd = std::env::current_dir().expect("cwd");
    let temp = tempfile::tempdir_in(&cwd).expect("tempdir");

    let dir_path = temp.path();
    let file_path = dir_path.join("hello.txt");
    let file_path_str = file_path.to_string_lossy().to_string();

    let request = Request::builder()
        .method(Method::PUT)
        .uri(format!("/v1/fs/file?path={file_path_str}"))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from("hello"))
        .expect("write request");
    let (status, _headers, _payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "write file");

    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("/v1/fs/file?path={file_path_str}"))
        .body(Body::empty())
        .expect("read request");
    let (status, headers, bytes) = send_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "read file");
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/octet-stream")
    );
    assert_eq!(bytes.as_ref(), b"hello");

    let entries_path = dir_path.to_string_lossy().to_string();
    let (status, entries) = send_json(
        &app.app,
        Method::GET,
        &format!("/v1/fs/entries?path={entries_path}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "list entries");
    let entry_list = entries.as_array().cloned().unwrap_or_default();
    let entry_names: Vec<String> = entry_list
        .iter()
        .filter_map(|entry| entry.get("name").and_then(|value| value.as_str()))
        .map(|value| value.to_string())
        .collect();
    assert!(entry_names.contains(&"hello.txt".to_string()));

    let new_path = dir_path.join("moved.txt");
    let new_path_str = new_path.to_string_lossy().to_string();
    let (status, _payload) = send_json(
        &app.app,
        Method::POST,
        "/v1/fs/move",
        Some(json!({
            "from": file_path_str,
            "to": new_path_str,
            "overwrite": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "move file");
    assert!(new_path.exists(), "moved file exists");

    let (status, _payload) = send_json(
        &app.app,
        Method::DELETE,
        &format!("/v1/fs/entry?path={}", new_path.to_string_lossy()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "delete file");
    assert!(!new_path.exists(), "file deleted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_upload_batch_tar() {
    let app = TestApp::new();
    let cwd = std::env::current_dir().expect("cwd");
    let dest_dir = tempfile::tempdir_in(&cwd).expect("tempdir");

    let mut builder = Builder::new(Vec::new());
    let mut tar_header = Header::new_gnu();
    let contents = b"hello";
    tar_header.set_size(contents.len() as u64);
    tar_header.set_cksum();
    builder
        .append_data(&mut tar_header, "a.txt", &contents[..])
        .expect("append tar entry");

    let mut tar_header = Header::new_gnu();
    let contents = b"world";
    tar_header.set_size(contents.len() as u64);
    tar_header.set_cksum();
    builder
        .append_data(&mut tar_header, "nested/b.txt", &contents[..])
        .expect("append tar entry");

    let tar_bytes = builder.into_inner().expect("tar bytes");

    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "/v1/fs/upload-batch?path={}",
            dest_dir.path().to_string_lossy()
        ))
        .header(header::CONTENT_TYPE, "application/x-tar")
        .body(Body::from(tar_bytes))
        .expect("tar request");

    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "upload batch");
    assert!(payload
        .get("paths")
        .and_then(|value| value.as_array())
        .map(|value| !value.is_empty())
        .unwrap_or(false));
    assert!(payload.get("truncated").and_then(|value| value.as_bool()) == Some(false));

    let a_path = dest_dir.path().join("a.txt");
    let b_path = dest_dir.path().join("nested").join("b.txt");
    assert!(a_path.exists(), "a.txt extracted");
    assert!(b_path.exists(), "b.txt extracted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_relative_paths_use_session_dir() {
    let app = TestApp::new();

    let session_id = "fs-session";
    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/sessions/{session_id}"),
        Some(json!({ "agent": "mock" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session");

    let cwd = std::env::current_dir().expect("cwd");
    let temp = tempfile::tempdir_in(&cwd).expect("tempdir");
    let relative_dir = temp
        .path()
        .strip_prefix(&cwd)
        .expect("strip prefix")
        .to_path_buf();
    let relative_path = relative_dir.join("session.txt");

    let request = Request::builder()
        .method(Method::PUT)
        .uri(format!(
            "/v1/fs/file?session_id={session_id}&path={}",
            relative_path.to_string_lossy()
        ))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from("session"))
        .expect("write request");
    let (status, _headers, _payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "write relative file");

    let absolute_path = cwd.join(relative_path);
    let content = stdfs::read_to_string(&absolute_path).expect("read file");
    assert_eq!(content, "session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_upload_batch_truncates_paths() {
    let app = TestApp::new();
    let cwd = std::env::current_dir().expect("cwd");
    let dest_dir = tempfile::tempdir_in(&cwd).expect("tempdir");

    let mut builder = Builder::new(Vec::new());
    for index in 0..1030 {
        let mut tar_header = Header::new_gnu();
        tar_header.set_size(0);
        tar_header.set_cksum();
        let name = format!("file_{index}.txt");
        builder
            .append_data(&mut tar_header, name, &[][..])
            .expect("append tar entry");
    }
    let tar_bytes = builder.into_inner().expect("tar bytes");

    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "/v1/fs/upload-batch?path={}",
            dest_dir.path().to_string_lossy()
        ))
        .header(header::CONTENT_TYPE, "application/x-tar")
        .body(Body::from(tar_bytes))
        .expect("tar request");

    let (status, _headers, payload) = send_json_request(&app.app, request).await;
    assert_eq!(status, StatusCode::OK, "upload batch");
    let paths = payload
        .get("paths")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    assert_eq!(paths.len(), 1024);
    assert_eq!(payload.get("truncated").and_then(|value| value.as_bool()), Some(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_mkdir_stat_and_delete_directory() {
    let app = TestApp::new();
    let cwd = std::env::current_dir().expect("cwd");
    let temp = tempfile::tempdir_in(&cwd).expect("tempdir");

    let dir_path = temp.path().join("nested");
    let dir_path_str = dir_path.to_string_lossy().to_string();

    let status = send_status(
        &app.app,
        Method::POST,
        &format!("/v1/fs/mkdir?path={dir_path_str}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "mkdir");
    assert!(dir_path.exists(), "directory created");

    let (status, stat) = send_json(
        &app.app,
        Method::GET,
        &format!("/v1/fs/stat?path={dir_path_str}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "stat directory");
    assert_eq!(stat["entryType"], "directory");

    let file_path = dir_path.join("note.txt");
    stdfs::write(&file_path, "content").expect("write file");
    let file_path_str = file_path.to_string_lossy().to_string();

    let (status, stat) = send_json(
        &app.app,
        Method::GET,
        &format!("/v1/fs/stat?path={file_path_str}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "stat file");
    assert_eq!(stat["entryType"], "file");

    let status = send_status(
        &app.app,
        Method::DELETE,
        &format!("/v1/fs/entry?path={dir_path_str}&recursive=true"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "delete directory");
    assert!(!dir_path.exists(), "directory deleted");
}
