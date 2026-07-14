use std::path::Path;
use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

include!(concat!(env!("OUT_DIR"), "/inspector_assets.rs"));

static INSPECTOR_DEFAULT_CWD: OnceLock<String> = OnceLock::new();

pub fn is_enabled() -> bool {
    INSPECTOR_ENABLED
}

pub fn configure_default_cwd(value: Option<String>) {
    if let Some(value) = normalize_cwd(value) {
        let _ = INSPECTOR_DEFAULT_CWD.set(value);
    }
}

pub fn router() -> Router {
    if !INSPECTOR_ENABLED {
        return Router::new()
            .route("/ui", get(handle_not_built))
            .route("/ui/", get(handle_not_built))
            .route("/ui/*path", get(handle_not_built));
    }
    Router::new()
        .route("/ui", get(handle_index))
        .route("/ui/", get(handle_index))
        .route("/ui/*path", get(handle_path))
}

async fn handle_not_built() -> Response {
    let body = "Inspector UI was not included in this build.\n\n\
                To enable it, build the frontend first:\n\n\
                  cd frontend/packages/inspector && pnpm install && pnpm build\n\n\
                Then rebuild sandbox-agent without SANDBOX_AGENT_SKIP_INSPECTOR.\n";
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .unwrap()
}

async fn handle_index() -> Response {
    serve_path("")
}

async fn handle_path(AxumPath(path): AxumPath<String>) -> Response {
    serve_path(&path)
}

fn serve_path(path: &str) -> Response {
    let Some(dir) = inspector_dir() else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let trimmed = path.trim_start_matches('/');
    let target = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };

    if let Some(file) = dir.get_file(target) {
        return file_response(file);
    }

    if !target.contains('.') {
        if let Some(file) = dir.get_file("index.html") {
            return file_response(file);
        }
    }

    StatusCode::NOT_FOUND.into_response()
}

fn file_response(file: &include_dir::File) -> Response {
    if file.path().file_name().and_then(|name| name.to_str()) == Some("index.html") {
        return index_response(file);
    }

    let mut response = Response::new(Body::from(file.contents().to_vec()));
    *response.status_mut() = StatusCode::OK;
    let content_type = content_type_for(file.path());
    let value = HeaderValue::from_static(content_type);
    response.headers_mut().insert(header::CONTENT_TYPE, value);
    response
}

fn index_response(file: &include_dir::File) -> Response {
    let html = String::from_utf8_lossy(file.contents());
    let config_json = serde_json::json!({
        "defaultCwd": resolve_default_cwd(),
    })
    .to_string();
    let config_script = format!(
        r#"<script>window.__SANDBOX_AGENT_INSPECTOR_CONFIG__={};</script>"#,
        config_json
    );

    let body = if let Some(position) = html.find("</head>") {
        let mut injected = String::with_capacity(html.len() + config_script.len());
        injected.push_str(&html[..position]);
        injected.push_str(&config_script);
        injected.push_str(&html[position..]);
        injected
    } else {
        let mut injected = html.into_owned();
        injected.push_str(&config_script);
        injected
    };

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

fn resolve_default_cwd() -> String {
    INSPECTOR_DEFAULT_CWD
        .get()
        .cloned()
        .or_else(|| normalize_cwd(std::env::var("SANDBOX_AGENT_INSPECTOR_DEFAULT_CWD").ok()))
        .or_else(|| normalize_cwd(std::env::var("HOME").ok()))
        .unwrap_or_else(|| "/".to_string())
}

fn normalize_cwd(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("map") => "application/json",
        Some("txt") => "text/plain; charset=utf-8",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("eot") => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}
