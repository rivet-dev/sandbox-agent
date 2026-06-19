use sandbox_agent_error::ProblemDetails;
use serde_json::{Map, Value};

use crate::desktop_types::DesktopErrorInfo;

#[derive(Debug, Clone)]
pub struct BrowserProblem {
    status: u16,
    title: &'static str,
    code: &'static str,
    message: String,
}

impl BrowserProblem {
    // 409 - browser is not running
    pub fn not_active() -> Self {
        Self::new(
            409,
            "Browser Not Active",
            "browser/not-active",
            "The browser is not running. Call POST /v1/browser/start first.",
        )
    }

    // 409 - browser is already running
    pub fn already_active() -> Self {
        Self::new(
            409,
            "Browser Already Active",
            "browser/already-active",
            "The browser is already running. Stop it first with POST /v1/browser/stop.",
        )
    }

    // 409 - desktop mode is active, cannot start browser
    pub fn desktop_conflict() -> Self {
        Self::new(
            409,
            "Desktop Conflict",
            "browser/desktop-conflict",
            "The desktop runtime is currently active. Browser and desktop modes are mutually exclusive.",
        )
    }

    // 424 - missing dependencies
    pub fn install_required(message: impl Into<String>) -> Self {
        Self::new(
            424,
            "Browser Install Required",
            "browser/install-required",
            message,
        )
    }

    // 500 - startup sequence failed
    pub fn start_failed(message: impl Into<String>) -> Self {
        Self::new(500, "Browser Start Failed", "browser/start-failed", message)
    }

    // 500 - internal error (filesystem, serialization, etc.)
    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new(500, "Internal Error", "browser/internal-error", message)
    }

    // 502 - CDP communication error
    pub fn cdp_error(message: impl Into<String>) -> Self {
        Self::new(502, "CDP Error", "browser/cdp-error", message)
    }

    // 504 - operation timed out
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(504, "Browser Timeout", "browser/timeout", message)
    }

    // 404 - tab/context/element not found
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "Not Found", "browser/not-found", message)
    }

    // 400 - bad CSS selector
    pub fn invalid_selector(message: impl Into<String>) -> Self {
        Self::new(400, "Invalid Selector", "browser/invalid-selector", message)
    }

    // 400 - invalid URL (e.g. disallowed scheme)
    pub fn invalid_url(message: impl Into<String>) -> Self {
        Self::new(400, "Invalid URL", "browser/invalid-url", message)
    }

    pub fn to_problem_details(&self) -> ProblemDetails {
        let mut extensions = Map::new();
        extensions.insert("code".to_string(), Value::String(self.code.to_string()));

        ProblemDetails {
            type_: format!("tag:sandboxagent.dev,2025:{}", self.code),
            title: self.title.to_string(),
            status: self.status,
            detail: Some(self.message.clone()),
            instance: None,
            extensions,
        }
    }

    pub fn to_error_info(&self) -> DesktopErrorInfo {
        DesktopErrorInfo {
            code: self.code.to_string(),
            message: self.message.clone(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(
        status: u16,
        title: &'static str,
        code: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            title,
            code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_active_produces_correct_problem_details() {
        let problem = BrowserProblem::not_active();
        let details = problem.to_problem_details();
        assert_eq!(details.status, 409);
        assert_eq!(
            details.type_,
            "tag:sandboxagent.dev,2025:browser/not-active"
        );
        assert_eq!(details.title, "Browser Not Active");
        assert!(details.detail.unwrap().contains("not running"));
    }

    #[test]
    fn cdp_error_includes_custom_message() {
        let problem = BrowserProblem::cdp_error("connection refused");
        let details = problem.to_problem_details();
        assert_eq!(details.status, 502);
        assert_eq!(details.detail.unwrap(), "connection refused");
        assert_eq!(
            details.extensions.get("code"),
            Some(&Value::String("browser/cdp-error".to_string()))
        );
    }

    #[test]
    fn install_required_uses_424_status() {
        let problem = BrowserProblem::install_required("chromium not found");
        let details = problem.to_problem_details();
        assert_eq!(details.status, 424);
        assert_eq!(
            details.type_,
            "tag:sandboxagent.dev,2025:browser/install-required"
        );
    }

    #[test]
    fn to_error_info_returns_code_and_message() {
        let problem = BrowserProblem::timeout("CDP poll timed out after 15s");
        let info = problem.to_error_info();
        assert_eq!(info.code, "browser/timeout");
        assert_eq!(info.message, "CDP poll timed out after 15s");
    }
}
