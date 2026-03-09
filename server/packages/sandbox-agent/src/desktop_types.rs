use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopState {
    Inactive,
    InstallRequired,
    Starting,
    Active,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResolution {
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpi: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProcessInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatusResponse {
    pub state: DesktopState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<DesktopResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<DesktopErrorInfo>,
    #[serde(default)]
    pub missing_dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_command: Option<String>,
    #[serde(default)]
    pub processes: Vec<DesktopProcessInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpi: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopScreenshotQuery {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRegionScreenshotQuery {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMousePositionResponse {
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopMouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseMoveRequest {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseClickRequest {
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<DesktopMouseButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub click_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseDragRequest {
    pub start_x: i32,
    pub start_y: i32,
    pub end_x: i32,
    pub end_y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<DesktopMouseButton>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMouseScrollRequest {
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyboardTypeRequest {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesktopKeyboardPressRequest {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActionResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDisplayInfoResponse {
    pub display: String,
    pub resolution: DesktopResolution,
}
