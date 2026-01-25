use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

pub use sandbox_daemon_agent_schema::{amp, claude, codex, opencode};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniversalEvent {
    pub id: u64,
    pub timestamp: String,
    pub session_id: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    pub data: UniversalEventData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UniversalEventData {
    Message { message: UniversalMessage },
    Started { started: Started },
    Error { error: CrashInfo },
    QuestionAsked {
        #[serde(rename = "questionAsked")]
        question_asked: QuestionRequest,
    },
    PermissionAsked {
        #[serde(rename = "permissionAsked")]
        permission_asked: PermissionRequest,
    },
    Unknown { raw: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashInfo {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniversalMessageParsed {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub metadata: Map<String, Value>,
    pub parts: Vec<UniversalMessagePart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UniversalMessage {
    Parsed(UniversalMessageParsed),
    Unparsed {
        raw: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UniversalMessagePart {
    Text { text: String },
    ToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        name: String,
        input: Value,
    },
    ToolResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        output: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    FunctionCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<Value>,
    },
    FunctionResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        result: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<Value>,
    },
    File {
        source: AttachmentSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<Value>,
    },
    Image {
        source: AttachmentSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw: Option<Value>,
    },
    Error { message: String },
    Unknown { raw: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachmentSource {
    Path { path: String },
    Url { url: String },
    Data {
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encoding: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequest {
    pub id: String,
    pub session_id: String,
    pub questions: Vec<QuestionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<QuestionToolRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionInfo {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<QuestionOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionToolRef {
    pub message_id: String,
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub session_id: String,
    pub permission: String,
    pub patterns: Vec<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub metadata: Map<String, Value>,
    pub always: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<PermissionToolRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolRef {
    pub message_id: String,
    pub call_id: String,
}

#[derive(Debug, Error)]
pub enum ConversionError {
    #[error("unsupported conversion: {0}")]
    Unsupported(&'static str),
    #[error("missing field: {0}")]
    MissingField(&'static str),
    #[error("invalid value: {0}")]
    InvalidValue(String),
    #[error("serde error: {0}")]
    Serde(String),
}

impl From<serde_json::Error> for ConversionError {
    fn from(err: serde_json::Error) -> Self {
        Self::Serde(err.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct EventConversion {
    pub data: UniversalEventData,
    pub agent_session_id: Option<String>,
}

impl EventConversion {
    pub fn new(data: UniversalEventData) -> Self {
        Self {
            data,
            agent_session_id: None,
        }
    }

    pub fn with_session(mut self, session_id: Option<String>) -> Self {
        self.agent_session_id = session_id;
        self
    }
}

fn message_from_text(role: &str, text: String) -> UniversalMessage {
    UniversalMessage::Parsed(UniversalMessageParsed {
        role: role.to_string(),
        id: None,
        metadata: Map::new(),
        parts: vec![UniversalMessagePart::Text { text }],
    })
}

fn message_from_parts(role: &str, parts: Vec<UniversalMessagePart>) -> UniversalMessage {
    UniversalMessage::Parsed(UniversalMessageParsed {
        role: role.to_string(),
        id: None,
        metadata: Map::new(),
        parts,
    })
}

fn message_parts_to_text(parts: &[UniversalMessagePart]) -> Option<String> {
    let mut text = String::new();
    for part in parts {
        if let UniversalMessagePart::Text { text: part_text } = part {
            if !text.is_empty() {
                text.push_str("\n");
            }
            text.push_str(part_text);
        }
    }
    if text.is_empty() { None } else { Some(text) }
}

fn extract_message_from_value(value: &Value) -> Option<String> {
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(message) = value.get("error").and_then(|v| v.get("message")).and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(message) = value.get("data").and_then(|v| v.get("message")).and_then(Value::as_str) {
        return Some(message.to_string());
    }
    None
}

pub mod convert_opencode {
    use super::*;

    pub fn event_to_universal(event: &opencode::Event) -> EventConversion {
        match event {
            opencode::Event::MessageUpdated(updated) => {
                let (message, session_id) = message_from_opencode(&updated.properties.info);
                EventConversion::new(UniversalEventData::Message { message })
                    .with_session(session_id)
            }
            opencode::Event::MessagePartUpdated(updated) => {
                let (message, session_id) = part_to_message(&updated.properties.part);
                EventConversion::new(UniversalEventData::Message { message })
                    .with_session(session_id)
            }
            opencode::Event::QuestionAsked(asked) => {
                let question = question_request_from_opencode(&asked.properties);
                EventConversion::new(UniversalEventData::QuestionAsked { question_asked: question })
                    .with_session(Some(String::from(asked.properties.session_id.clone())))
            }
            opencode::Event::PermissionAsked(asked) => {
                let permission = permission_request_from_opencode(&asked.properties);
                EventConversion::new(UniversalEventData::PermissionAsked { permission_asked: permission })
                    .with_session(Some(String::from(asked.properties.session_id.clone())))
            }
            opencode::Event::SessionCreated(created) => {
                let details = serde_json::to_value(created).ok();
                let started = Started {
                    message: Some("session.created".to_string()),
                    details,
                };
                EventConversion::new(UniversalEventData::Started { started })
            }
            opencode::Event::SessionError(error) => {
                let message = extract_message_from_value(&serde_json::to_value(&error.properties).unwrap_or(Value::Null))
                    .unwrap_or_else(|| "opencode session error".to_string());
                let crash = CrashInfo {
                    message,
                    kind: Some("session.error".to_string()),
                    details: serde_json::to_value(&error.properties).ok(),
                };
                EventConversion::new(UniversalEventData::Error { error: crash })
                    .with_session(error.properties.session_id.clone())
            }
            _ => EventConversion::new(UniversalEventData::Unknown {
                raw: serde_json::to_value(event).unwrap_or(Value::Null),
            }),
        }
    }

    pub fn universal_event_to_opencode(event: &UniversalEventData) -> Result<opencode::Event, ConversionError> {
        match event {
            UniversalEventData::QuestionAsked { question_asked } => {
                let properties = question_request_to_opencode(question_asked)?;
                Ok(opencode::Event::QuestionAsked(opencode::EventQuestionAsked {
                    properties,
                    type_: "question.asked".to_string(),
                }))
            }
            UniversalEventData::PermissionAsked { permission_asked } => {
                let properties = permission_request_to_opencode(permission_asked)?;
                Ok(opencode::Event::PermissionAsked(opencode::EventPermissionAsked {
                    properties,
                    type_: "permission.asked".to_string(),
                }))
            }
            _ => Err(ConversionError::Unsupported("opencode event")),
        }
    }

    pub fn universal_message_to_parts(
        message: &UniversalMessage,
    ) -> Result<Vec<opencode::TextPartInput>, ConversionError> {
        let parsed = match message {
            UniversalMessage::Parsed(parsed) => parsed,
            UniversalMessage::Unparsed { .. } => {
                return Err(ConversionError::Unsupported("unparsed message"))
            }
        };
        let mut parts = Vec::new();
        for part in &parsed.parts {
            match part {
                UniversalMessagePart::Text { text } => {
                    parts.push(opencode::TextPartInput {
                        id: None,
                        ignored: None,
                        metadata: Map::new(),
                        synthetic: None,
                        text: text.clone(),
                        time: None,
                        type_: "text".to_string(),
                    });
                }
                _ => return Err(ConversionError::Unsupported("non-text part")),
            }
        }
        if parts.is_empty() {
            return Err(ConversionError::MissingField("parts"));
        }
        Ok(parts)
    }

    pub fn text_part_input_to_universal(part: &opencode::TextPartInput) -> UniversalMessage {
        let mut metadata = part.metadata.clone();
        if let Some(id) = &part.id {
            metadata.insert("partId".to_string(), Value::String(id.clone()));
        }
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: "user".to_string(),
            id: None,
            metadata,
            parts: vec![UniversalMessagePart::Text {
                text: part.text.clone(),
            }],
        })
    }

    fn message_from_opencode(message: &opencode::Message) -> (UniversalMessage, Option<String>) {
        match message {
            opencode::Message::UserMessage(user) => {
                let mut metadata = Map::new();
                metadata.insert("agent".to_string(), Value::String(user.agent.clone()));
                let parsed = UniversalMessageParsed {
                    role: user.role.clone(),
                    id: Some(user.id.clone()),
                    metadata,
                    parts: Vec::new(),
                };
                (
                    UniversalMessage::Parsed(parsed),
                    Some(user.session_id.clone()),
                )
            }
            opencode::Message::AssistantMessage(assistant) => {
                let mut metadata = Map::new();
                metadata.insert("agent".to_string(), Value::String(assistant.agent.clone()));
                let parsed = UniversalMessageParsed {
                    role: assistant.role.clone(),
                    id: Some(assistant.id.clone()),
                    metadata,
                    parts: Vec::new(),
                };
                (
                    UniversalMessage::Parsed(parsed),
                    Some(assistant.session_id.clone()),
                )
            }
        }
    }

    fn part_to_message(part: &opencode::Part) -> (UniversalMessage, Option<String>) {
        match part {
            opencode::Part::Variant0(text_part) => {
                let mut metadata = Map::new();
                metadata.insert("messageId".to_string(), Value::String(text_part.message_id.clone()));
                metadata.insert("partId".to_string(), Value::String(text_part.id.clone()));
                let parsed = UniversalMessageParsed {
                    role: "assistant".to_string(),
                    id: Some(text_part.message_id.clone()),
                    metadata,
                    parts: vec![UniversalMessagePart::Text {
                        text: text_part.text.clone(),
                    }],
                };
                (
                    UniversalMessage::Parsed(parsed),
                    Some(text_part.session_id.clone()),
                )
            }
            opencode::Part::Variant4(tool_part) => {
                let mut metadata = Map::new();
                metadata.insert("messageId".to_string(), Value::String(tool_part.message_id.clone()));
                metadata.insert("partId".to_string(), Value::String(tool_part.id.clone()));
                let parts = tool_state_to_parts(&tool_part);
                let parsed = UniversalMessageParsed {
                    role: "assistant".to_string(),
                    id: Some(tool_part.message_id.clone()),
                    metadata,
                    parts,
                };
                (
                    UniversalMessage::Parsed(parsed),
                    Some(tool_part.session_id.clone()),
                )
            }
            _ => (
                UniversalMessage::Unparsed {
                    raw: serde_json::to_value(part).unwrap_or(Value::Null),
                    error: Some("unsupported opencode part".to_string()),
                },
                None,
            ),
        }
    }

    fn tool_state_to_parts(tool_part: &opencode::ToolPart) -> Vec<UniversalMessagePart> {
        match &tool_part.state {
            opencode::ToolState::Pending(state) => vec![UniversalMessagePart::ToolCall {
                id: Some(tool_part.call_id.clone()),
                name: tool_part.tool.clone(),
                input: Value::Object(state.input.clone()),
            }],
            opencode::ToolState::Running(state) => vec![UniversalMessagePart::ToolCall {
                id: Some(tool_part.call_id.clone()),
                name: tool_part.tool.clone(),
                input: Value::Object(state.input.clone()),
            }],
            opencode::ToolState::Completed(state) => vec![UniversalMessagePart::ToolResult {
                id: Some(tool_part.call_id.clone()),
                name: Some(tool_part.tool.clone()),
                output: Value::String(state.output.clone()),
                is_error: Some(false),
            }],
            opencode::ToolState::Error(state) => vec![UniversalMessagePart::ToolResult {
                id: Some(tool_part.call_id.clone()),
                name: Some(tool_part.tool.clone()),
                output: Value::String(state.error.clone()),
                is_error: Some(true),
            }],
        }
    }

    fn question_request_from_opencode(request: &opencode::QuestionRequest) -> QuestionRequest {
        QuestionRequest {
            id: String::from(request.id.clone()),
            session_id: String::from(request.session_id.clone()),
            questions: request
                .questions
                .iter()
                .map(|question| QuestionInfo {
                    question: question.question.clone(),
                    header: Some(question.header.clone()),
                    options: question
                        .options
                        .iter()
                        .map(|opt| QuestionOption {
                            label: opt.label.clone(),
                            description: Some(opt.description.clone()),
                        })
                        .collect(),
                    multi_select: question.multiple,
                    custom: question.custom,
                })
                .collect(),
            tool: request.tool.as_ref().map(|tool| QuestionToolRef {
                message_id: tool.message_id.clone(),
                call_id: tool.call_id.clone(),
            }),
        }
    }

    fn permission_request_from_opencode(request: &opencode::PermissionRequest) -> PermissionRequest {
        PermissionRequest {
            id: String::from(request.id.clone()),
            session_id: String::from(request.session_id.clone()),
            permission: request.permission.clone(),
            patterns: request.patterns.clone(),
            metadata: request.metadata.clone(),
            always: request.always.clone(),
            tool: request.tool.as_ref().map(|tool| PermissionToolRef {
                message_id: tool.message_id.clone(),
                call_id: tool.call_id.clone(),
            }),
        }
    }

    fn question_request_to_opencode(request: &QuestionRequest) -> Result<opencode::QuestionRequest, ConversionError> {
        let id = opencode::QuestionRequestId::try_from(request.id.as_str())
            .map_err(|err| ConversionError::InvalidValue(err.to_string()))?;
        let session_id = opencode::QuestionRequestSessionId::try_from(request.session_id.as_str())
            .map_err(|err| ConversionError::InvalidValue(err.to_string()))?;
        let questions = request
            .questions
            .iter()
            .map(|question| opencode::QuestionInfo {
                question: question.question.clone(),
                header: question
                    .header
                    .clone()
                    .unwrap_or_else(|| "Question".to_string()),
                options: question
                    .options
                    .iter()
                    .map(|opt| opencode::QuestionOption {
                        label: opt.label.clone(),
                        description: opt.description.clone().unwrap_or_default(),
                    })
                    .collect(),
                multiple: question.multi_select,
                custom: question.custom,
            })
            .collect();

        Ok(opencode::QuestionRequest {
            id,
            session_id,
            questions,
            tool: request.tool.as_ref().map(|tool| opencode::QuestionRequestTool {
                message_id: tool.message_id.clone(),
                call_id: tool.call_id.clone(),
            }),
        })
    }

    fn permission_request_to_opencode(
        request: &PermissionRequest,
    ) -> Result<opencode::PermissionRequest, ConversionError> {
        let id = opencode::PermissionRequestId::try_from(request.id.as_str())
            .map_err(|err| ConversionError::InvalidValue(err.to_string()))?;
        let session_id = opencode::PermissionRequestSessionId::try_from(request.session_id.as_str())
            .map_err(|err| ConversionError::InvalidValue(err.to_string()))?;
        Ok(opencode::PermissionRequest {
            id,
            session_id,
            permission: request.permission.clone(),
            patterns: request.patterns.clone(),
            metadata: request.metadata.clone(),
            always: request.always.clone(),
            tool: request.tool.as_ref().map(|tool| opencode::PermissionRequestTool {
                message_id: tool.message_id.clone(),
                call_id: tool.call_id.clone(),
            }),
        })
    }
}

pub mod convert_codex {
    use super::*;

    pub fn event_to_universal(event: &codex::ThreadEvent) -> EventConversion {
        match event.type_ {
            codex::ThreadEventType::ThreadCreated | codex::ThreadEventType::ThreadUpdated => {
                let started = Started {
                    message: Some(event.type_.to_string()),
                    details: serde_json::to_value(event).ok(),
                };
                EventConversion::new(UniversalEventData::Started { started })
                    .with_session(event.thread_id.clone())
            }
            codex::ThreadEventType::ItemCreated | codex::ThreadEventType::ItemUpdated => {
                if let Some(item) = &event.item {
                    let message = thread_item_to_message(item);
                    EventConversion::new(UniversalEventData::Message { message })
                        .with_session(event.thread_id.clone())
                } else {
                    EventConversion::new(UniversalEventData::Unknown {
                        raw: serde_json::to_value(event).unwrap_or(Value::Null),
                    })
                }
            }
            codex::ThreadEventType::Error => {
                let message = extract_message_from_value(&Value::Object(event.error.clone()))
                    .unwrap_or_else(|| "codex error".to_string());
                let crash = CrashInfo {
                    message,
                    kind: Some("error".to_string()),
                    details: Some(Value::Object(event.error.clone())),
                };
                EventConversion::new(UniversalEventData::Error { error: crash })
                    .with_session(event.thread_id.clone())
            }
        }
    }

    pub fn universal_event_to_codex(event: &UniversalEventData) -> Result<codex::ThreadEvent, ConversionError> {
        match event {
            UniversalEventData::Message { message } => {
                let parsed = match message {
                    UniversalMessage::Parsed(parsed) => parsed,
                    UniversalMessage::Unparsed { .. } => {
                        return Err(ConversionError::Unsupported("unparsed message"))
                    }
                };
                let id = parsed.id.clone().ok_or(ConversionError::MissingField("message.id"))?;
                let content = message_parts_to_text(&parsed.parts)
                    .ok_or(ConversionError::MissingField("text part"))?;
                let role = match parsed.role.as_str() {
                    "user" => Some(codex::ThreadItemRole::User),
                    "assistant" => Some(codex::ThreadItemRole::Assistant),
                    "system" => Some(codex::ThreadItemRole::System),
                    _ => None,
                };
                let item = codex::ThreadItem {
                    content: Some(codex::ThreadItemContent::Variant0(content)),
                    id,
                    role,
                    status: None,
                    type_: codex::ThreadItemType::Message,
                };
                Ok(codex::ThreadEvent {
                    error: Map::new(),
                    item: Some(item),
                    thread_id: None,
                    type_: codex::ThreadEventType::ItemCreated,
                })
            }
            _ => Err(ConversionError::Unsupported("codex event")),
        }
    }

    pub fn message_to_universal(message: &codex::Message) -> UniversalMessage {
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: message.role.to_string(),
            id: None,
            metadata: Map::new(),
            parts: vec![UniversalMessagePart::Text {
                text: message.content.clone(),
            }],
        })
    }

    pub fn universal_message_to_message(
        message: &UniversalMessage,
    ) -> Result<codex::Message, ConversionError> {
        let parsed = match message {
            UniversalMessage::Parsed(parsed) => parsed,
            UniversalMessage::Unparsed { .. } => {
                return Err(ConversionError::Unsupported("unparsed message"))
            }
        };
        let content = message_parts_to_text(&parsed.parts)
            .ok_or(ConversionError::MissingField("text part"))?;
        Ok(codex::Message {
            role: match parsed.role.as_str() {
                "user" => codex::MessageRole::User,
                "assistant" => codex::MessageRole::Assistant,
                "system" => codex::MessageRole::System,
                _ => codex::MessageRole::User,
            },
            content,
        })
    }

    fn thread_item_to_message(item: &codex::ThreadItem) -> UniversalMessage {
        let mut metadata = Map::new();
        metadata.insert("itemType".to_string(), Value::String(item.type_.to_string()));
        let role = item
            .role
            .as_ref()
            .map(|role| role.to_string())
            .unwrap_or_else(|| "assistant".to_string());
        let parts = match item.type_ {
            codex::ThreadItemType::Message => message_parts_from_codex_content(&item.content),
            codex::ThreadItemType::FunctionCall => {
                vec![function_call_part_from_codex(item)]
            }
            codex::ThreadItemType::FunctionResult => {
                vec![function_result_part_from_codex(item)]
            }
        };
        UniversalMessage::Parsed(UniversalMessageParsed {
            role,
            id: Some(item.id.clone()),
            metadata,
            parts,
        })
    }

    fn message_parts_from_codex_content(
        content: &Option<codex::ThreadItemContent>,
    ) -> Vec<UniversalMessagePart> {
        match content {
            Some(codex::ThreadItemContent::Variant0(text)) => {
                vec![UniversalMessagePart::Text { text: text.clone() }]
            }
            Some(codex::ThreadItemContent::Variant1(raw)) => {
                vec![UniversalMessagePart::Unknown {
                    raw: serde_json::to_value(raw).unwrap_or(Value::Null),
                }]
            }
            None => Vec::new(),
        }
    }

    fn function_call_part_from_codex(item: &codex::ThreadItem) -> UniversalMessagePart {
        let raw = thread_item_content_to_value(&item.content);
        let name = extract_object_field(&raw, "name");
        let arguments = extract_object_value(&raw, "arguments").unwrap_or_else(|| raw.clone());
        UniversalMessagePart::FunctionCall {
            id: Some(item.id.clone()),
            name,
            arguments,
            raw: Some(raw),
        }
    }

    fn function_result_part_from_codex(item: &codex::ThreadItem) -> UniversalMessagePart {
        let raw = thread_item_content_to_value(&item.content);
        let name = extract_object_field(&raw, "name");
        let result = extract_object_value(&raw, "result")
            .or_else(|| extract_object_value(&raw, "output"))
            .or_else(|| extract_object_value(&raw, "content"))
            .unwrap_or_else(|| raw.clone());
        UniversalMessagePart::FunctionResult {
            id: Some(item.id.clone()),
            name,
            result,
            is_error: None,
            raw: Some(raw),
        }
    }

    fn thread_item_content_to_value(content: &Option<codex::ThreadItemContent>) -> Value {
        match content {
            Some(codex::ThreadItemContent::Variant0(text)) => Value::String(text.clone()),
            Some(codex::ThreadItemContent::Variant1(raw)) => {
                Value::Array(raw.iter().cloned().map(Value::Object).collect())
            }
            None => Value::Null,
        }
    }

    fn extract_object_field(raw: &Value, field: &str) -> Option<String> {
        extract_object_value(raw, field)
            .and_then(|value| value.as_str().map(|s| s.to_string()))
    }

    fn extract_object_value(raw: &Value, field: &str) -> Option<Value> {
        match raw {
            Value::Object(map) => map.get(field).cloned(),
            Value::Array(values) => values
                .first()
                .and_then(|value| value.as_object())
                .and_then(|map| map.get(field).cloned()),
            _ => None,
        }
    }
}

pub mod convert_amp {
    use super::*;

    pub fn event_to_universal(event: &amp::StreamJsonMessage) -> EventConversion {
        match event.type_ {
            amp::StreamJsonMessageType::Message => {
                let text = event.content.clone().unwrap_or_default();
                let mut message = message_from_text("assistant", text);
                if let UniversalMessage::Parsed(parsed) = &mut message {
                    parsed.id = event.id.clone();
                }
                EventConversion::new(UniversalEventData::Message { message })
            }
            amp::StreamJsonMessageType::ToolCall => {
                let tool_call = event.tool_call.as_ref();
                let part = if let Some(tool_call) = tool_call {
                    let input = match &tool_call.arguments {
                        amp::ToolCallArguments::Variant0(text) => Value::String(text.clone()),
                        amp::ToolCallArguments::Variant1(map) => Value::Object(map.clone()),
                    };
                    UniversalMessagePart::ToolCall {
                        id: Some(tool_call.id.clone()),
                        name: tool_call.name.clone(),
                        input,
                    }
                } else {
                    UniversalMessagePart::Unknown { raw: Value::Null }
                };
                let mut message = message_from_parts("assistant", vec![part]);
                if let UniversalMessage::Parsed(parsed) = &mut message {
                    parsed.id = event.id.clone();
                }
                EventConversion::new(UniversalEventData::Message { message })
            }
            amp::StreamJsonMessageType::ToolResult => {
                let output = event
                    .content
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null);
                let part = UniversalMessagePart::ToolResult {
                    id: event.id.clone(),
                    name: None,
                    output,
                    is_error: None,
                };
                let message = message_from_parts("tool", vec![part]);
                EventConversion::new(UniversalEventData::Message { message })
            }
            amp::StreamJsonMessageType::Error => {
                let message = event.error.clone().unwrap_or_else(|| "amp error".to_string());
                let crash = CrashInfo {
                    message,
                    kind: Some("amp".to_string()),
                    details: serde_json::to_value(event).ok(),
                };
                EventConversion::new(UniversalEventData::Error { error: crash })
            }
            amp::StreamJsonMessageType::Done => EventConversion::new(UniversalEventData::Unknown {
                raw: serde_json::to_value(event).unwrap_or(Value::Null),
            }),
        }
    }

    pub fn universal_event_to_amp(event: &UniversalEventData) -> Result<amp::StreamJsonMessage, ConversionError> {
        match event {
            UniversalEventData::Message { message } => {
                let parsed = match message {
                    UniversalMessage::Parsed(parsed) => parsed,
                    UniversalMessage::Unparsed { .. } => {
                        return Err(ConversionError::Unsupported("unparsed message"))
                    }
                };
                let content = message_parts_to_text(&parsed.parts)
                    .ok_or(ConversionError::MissingField("text part"))?;
                Ok(amp::StreamJsonMessage {
                    content: Some(content),
                    error: None,
                    id: parsed.id.clone(),
                    tool_call: None,
                    type_: amp::StreamJsonMessageType::Message,
                })
            }
            _ => Err(ConversionError::Unsupported("amp event")),
        }
    }

    pub fn message_to_universal(message: &amp::Message) -> UniversalMessage {
        let mut parts = vec![UniversalMessagePart::Text {
            text: message.content.clone(),
        }];
        for call in &message.tool_calls {
            let input = match &call.arguments {
                amp::ToolCallArguments::Variant0(text) => Value::String(text.clone()),
                amp::ToolCallArguments::Variant1(map) => Value::Object(map.clone()),
            };
            parts.push(UniversalMessagePart::ToolCall {
                id: Some(call.id.clone()),
                name: call.name.clone(),
                input,
            });
        }
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: message.role.to_string(),
            id: None,
            metadata: Map::new(),
            parts,
        })
    }

    pub fn universal_message_to_message(
        message: &UniversalMessage,
    ) -> Result<amp::Message, ConversionError> {
        let parsed = match message {
            UniversalMessage::Parsed(parsed) => parsed,
            UniversalMessage::Unparsed { .. } => {
                return Err(ConversionError::Unsupported("unparsed message"))
            }
        };
        let content = message_parts_to_text(&parsed.parts)
            .ok_or(ConversionError::MissingField("text part"))?;
        Ok(amp::Message {
            role: match parsed.role.as_str() {
                "user" => amp::MessageRole::User,
                "assistant" => amp::MessageRole::Assistant,
                "system" => amp::MessageRole::System,
                _ => amp::MessageRole::User,
            },
            content,
            tool_calls: vec![],
        })
    }
}

pub mod convert_claude {
    use super::*;

    pub fn event_to_universal_with_session(
        event: &Value,
        session_id: String,
    ) -> EventConversion {
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "assistant" => assistant_event_to_universal(event),
            "tool_use" => tool_use_event_to_universal(event, session_id),
            "tool_result" => tool_result_event_to_universal(event),
            "result" => result_event_to_universal(event),
            _ => EventConversion::new(UniversalEventData::Unknown { raw: event.clone() }),
        }
    }

    pub fn universal_event_to_claude(event: &UniversalEventData) -> Result<Value, ConversionError> {
        match event {
            UniversalEventData::Message { message } => {
                let parsed = match message {
                    UniversalMessage::Parsed(parsed) => parsed,
                    UniversalMessage::Unparsed { .. } => {
                        return Err(ConversionError::Unsupported("unparsed message"))
                    }
                };
                let text = message_parts_to_text(&parsed.parts)
                    .ok_or(ConversionError::MissingField("text part"))?;
                Ok(Value::Object(Map::from_iter([
                    ("type".to_string(), Value::String("assistant".to_string())),
                    (
                        "message".to_string(),
                        Value::Object(Map::from_iter([(
                            "content".to_string(),
                            Value::Array(vec![Value::Object(Map::from_iter([(
                                "type".to_string(),
                                Value::String("text".to_string()),
                            ), (
                                "text".to_string(),
                                Value::String(text),
                            )]))]),
                        )])),
                    ),
                ])))
            }
            _ => Err(ConversionError::Unsupported("claude event")),
        }
    }

    pub fn prompt_to_universal(prompt: &str) -> UniversalMessage {
        message_from_text("user", prompt.to_string())
    }

    pub fn universal_message_to_prompt(message: &UniversalMessage) -> Result<String, ConversionError> {
        let parsed = match message {
            UniversalMessage::Parsed(parsed) => parsed,
            UniversalMessage::Unparsed { .. } => {
                return Err(ConversionError::Unsupported("unparsed message"))
            }
        };
        message_parts_to_text(&parsed.parts)
            .ok_or(ConversionError::MissingField("text part"))
    }

    fn assistant_event_to_universal(event: &Value) -> EventConversion {
        let content = event
            .get("message")
            .and_then(|msg| msg.get("content"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut parts = Vec::new();
        for block in content {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        parts.push(UniversalMessagePart::Text {
                            text: text.to_string(),
                        });
                    }
                }
                "tool_use" => {
                    if let Some(name) = block.get("name").and_then(Value::as_str) {
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let id = block.get("id").and_then(Value::as_str).map(|s| s.to_string());
                        parts.push(UniversalMessagePart::ToolCall {
                            id,
                            name: name.to_string(),
                            input,
                        });
                    }
                }
                _ => parts.push(UniversalMessagePart::Unknown { raw: block }),
            }
        }
        let message = UniversalMessage::Parsed(UniversalMessageParsed {
            role: "assistant".to_string(),
            id: None,
            metadata: Map::new(),
            parts,
        });
        EventConversion::new(UniversalEventData::Message { message })
    }

    fn tool_use_event_to_universal(event: &Value, session_id: String) -> EventConversion {
        let tool_use = event.get("tool_use");
        let name = tool_use
            .and_then(|tool| tool.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let input = tool_use
            .and_then(|tool| tool.get("input"))
            .cloned()
            .unwrap_or(Value::Null);
        let id = tool_use
            .and_then(|tool| tool.get("id"))
            .and_then(Value::as_str)
            .map(|s| s.to_string());

        if name == "AskUserQuestion" {
            if let Some(question) =
                question_from_claude_input(&input, id.clone(), session_id.clone())
            {
                return EventConversion::new(UniversalEventData::QuestionAsked {
                    question_asked: question,
                });
            }
        }

        let message = message_from_parts(
            "assistant",
            vec![UniversalMessagePart::ToolCall {
                id,
                name: name.to_string(),
                input,
            }],
        );
        EventConversion::new(UniversalEventData::Message { message })
    }

    fn tool_result_event_to_universal(event: &Value) -> EventConversion {
        let tool_result = event.get("tool_result");
        let output = tool_result
            .and_then(|tool| tool.get("content"))
            .cloned()
            .unwrap_or(Value::Null);
        let is_error = tool_result
            .and_then(|tool| tool.get("is_error"))
            .and_then(Value::as_bool);
        let id = tool_result
            .and_then(|tool| tool.get("id"))
            .and_then(Value::as_str)
            .map(|s| s.to_string());

        let message = message_from_parts(
            "tool",
            vec![UniversalMessagePart::ToolResult {
                id,
                name: None,
                output,
                is_error,
            }],
        );
        EventConversion::new(UniversalEventData::Message { message })
    }

    fn result_event_to_universal(event: &Value) -> EventConversion {
        let result_text = event
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let session_id = event
            .get("session_id")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        let message = message_from_text("assistant", result_text);
        EventConversion::new(UniversalEventData::Message { message }).with_session(session_id)
    }

    fn question_from_claude_input(
        input: &Value,
        tool_id: Option<String>,
        session_id: String,
    ) -> Option<QuestionRequest> {
        let questions = input.get("questions").and_then(Value::as_array)?;
        let mut parsed_questions = Vec::new();
        for question in questions {
            let question_text = question.get("question")?.as_str()?.to_string();
            let header = question
                .get("header")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let multi_select = question
                .get("multiSelect")
                .and_then(Value::as_bool);
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let label = option.get("label")?.as_str()?.to_string();
                            let description = option
                                .get("description")
                                .and_then(Value::as_str)
                                .map(|s| s.to_string());
                            Some(QuestionOption { label, description })
                        })
                        .collect::<Vec<_>>()
                })?;
            parsed_questions.push(QuestionInfo {
                question: question_text,
                header,
                options,
                multi_select,
                custom: None,
            });
        }
        Some(QuestionRequest {
            id: tool_id.unwrap_or_else(|| "claude-question".to_string()),
            session_id,
            questions: parsed_questions,
            tool: None,
        })
    }
}
