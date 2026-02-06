use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

pub use sandbox_agent_extracted_agent_schemas::{amp, claude, codex, opencode};

pub mod agents;

pub use agents::{
    amp as convert_amp, claude as convert_claude, codex as convert_codex,
    opencode as convert_opencode,
};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct UniversalEvent {
    pub event_id: String,
    pub sequence: u64,
    pub time: String,
    pub session_id: String,
    pub native_session_id: Option<String>,
    pub synthetic: bool,
    pub source: EventSource,
    #[serde(rename = "type")]
    pub event_type: UniversalEventType,
    pub data: UniversalEventData,
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Agent,
    Daemon,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
pub enum UniversalEventType {
    #[serde(rename = "session.started")]
    SessionStarted,
    #[serde(rename = "session.ended")]
    SessionEnded,
    #[serde(rename = "item.started")]
    ItemStarted,
    #[serde(rename = "item.delta")]
    ItemDelta,
    #[serde(rename = "item.completed")]
    ItemCompleted,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "permission.requested")]
    PermissionRequested,
    #[serde(rename = "permission.resolved")]
    PermissionResolved,
    #[serde(rename = "question.requested")]
    QuestionRequested,
    #[serde(rename = "question.resolved")]
    QuestionResolved,
    #[serde(rename = "agent.unparsed")]
    AgentUnparsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(untagged)]
pub enum UniversalEventData {
    SessionStarted(SessionStartedData),
    SessionEnded(SessionEndedData),
    Item(ItemEventData),
    ItemDelta(ItemDeltaData),
    Error(ErrorData),
    Permission(PermissionEventData),
    Question(QuestionEventData),
    AgentUnparsed(AgentUnparsedData),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct SessionStartedData {
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct SessionEndedData {
    pub reason: SessionEndReason,
    pub terminated_by: TerminatedBy,
    /// Error message when reason is Error
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Process exit code when reason is Error
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Agent stderr output when reason is Error
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<StderrOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct StderrOutput {
    /// First N lines of stderr (if truncated) or full stderr (if not truncated)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Last N lines of stderr (only present if truncated)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    /// Whether the output was truncated
    pub truncated: bool,
    /// Total number of lines in stderr
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason {
    Completed,
    Error,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminatedBy {
    Agent,
    Daemon,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ItemEventData {
    pub item: UniversalItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ItemDeltaData {
    pub item_id: String,
    pub native_item_id: Option<String>,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct ErrorData {
    pub message: String,
    pub code: Option<String>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct AgentUnparsedData {
    pub error: String,
    pub location: String,
    pub raw_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct PermissionEventData {
    pub permission_id: String,
    pub action: String,
    pub status: PermissionStatus,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    Requested,
    Approved,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct QuestionEventData {
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub response: Option<String>,
    pub status: QuestionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Requested,
    Answered,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct UniversalItem {
    pub item_id: String,
    pub native_item_id: Option<String>,
    pub parent_id: Option<String>,
    pub kind: ItemKind,
    pub role: Option<ItemRole>,
    pub content: Vec<ContentPart>,
    pub status: ItemStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Message,
    ToolCall,
    ToolResult,
    System,
    Status,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    Json {
        json: Value,
    },
    ToolCall {
        name: String,
        arguments: String,
        call_id: String,
    },
    ToolResult {
        call_id: String,
        output: String,
    },
    FileRef {
        path: String,
        action: FileAction,
        diff: Option<String>,
    },
    Reasoning {
        text: String,
        visibility: ReasoningVisibility,
    },
    Image {
        path: String,
        mime: Option<String>,
    },
    Status {
        label: String,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileAction {
    Read,
    Write,
    Patch,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningVisibility {
    Public,
    Private,
}

#[derive(Debug, Clone)]
pub struct EventConversion {
    pub event_type: UniversalEventType,
    pub data: UniversalEventData,
    pub native_session_id: Option<String>,
    pub source: EventSource,
    pub synthetic: bool,
    pub raw: Option<Value>,
}

impl EventConversion {
    pub fn new(event_type: UniversalEventType, data: UniversalEventData) -> Self {
        Self {
            event_type,
            data,
            native_session_id: None,
            source: EventSource::Agent,
            synthetic: false,
            raw: None,
        }
    }

    pub fn with_native_session(mut self, session_id: Option<String>) -> Self {
        self.native_session_id = session_id;
        self
    }

    pub fn with_raw(mut self, raw: Option<Value>) -> Self {
        self.raw = raw;
        self
    }

    pub fn synthetic(mut self) -> Self {
        self.synthetic = true;
        self.source = EventSource::Daemon;
        self
    }

    pub fn with_source(mut self, source: EventSource) -> Self {
        self.source = source;
        self
    }
}

pub fn turn_completed_event() -> EventConversion {
    EventConversion::new(
        UniversalEventType::ItemCompleted,
        UniversalEventData::Item(ItemEventData {
            item: UniversalItem {
                item_id: String::new(),
                native_item_id: None,
                parent_id: None,
                kind: ItemKind::Status,
                role: Some(ItemRole::System),
                content: vec![ContentPart::Status {
                    label: "turn.completed".to_string(),
                    detail: None,
                }],
                status: ItemStatus::Completed,
            },
        }),
    )
    .synthetic()
}

pub fn item_from_text(role: ItemRole, text: String) -> UniversalItem {
    UniversalItem {
        item_id: String::new(),
        native_item_id: None,
        parent_id: None,
        kind: ItemKind::Message,
        role: Some(role),
        content: vec![ContentPart::Text { text }],
        status: ItemStatus::Completed,
    }
}

pub fn item_from_parts(role: ItemRole, kind: ItemKind, parts: Vec<ContentPart>) -> UniversalItem {
    UniversalItem {
        item_id: String::new(),
        native_item_id: None,
        parent_id: None,
        kind,
        role: Some(role),
        content: parts,
        status: ItemStatus::Completed,
    }
}
