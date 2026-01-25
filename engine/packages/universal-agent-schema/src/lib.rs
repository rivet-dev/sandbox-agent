use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use schemars::JsonSchema;
use thiserror::Error;
use utoipa::ToSchema;

pub use sandbox_daemon_agent_schema::{amp, claude, codex, opencode};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CrashInfo {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct UniversalMessageParsed {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub metadata: Map<String, Value>,
    pub parts: Vec<UniversalMessagePart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(untagged)]
pub enum UniversalMessage {
    Parsed(UniversalMessageParsed),
    Unparsed {
        raw: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequest {
    pub id: String,
    pub session_id: String,
    pub questions: Vec<QuestionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<QuestionToolRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionToolRef {
    pub message_id: String,
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
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

fn text_only_from_parts(parts: &[UniversalMessagePart]) -> Result<String, ConversionError> {
    let mut text = String::new();
    for part in parts {
        match part {
            UniversalMessagePart::Text { text: part_text } => {
                if !text.is_empty() {
                    text.push_str("\n");
                }
                text.push_str(part_text);
            }
            UniversalMessagePart::ToolCall { .. } => {
                return Err(ConversionError::Unsupported("tool call part"))
            }
            UniversalMessagePart::ToolResult { .. } => {
                return Err(ConversionError::Unsupported("tool result part"))
            }
            UniversalMessagePart::FunctionCall { .. } => {
                return Err(ConversionError::Unsupported("function call part"))
            }
            UniversalMessagePart::FunctionResult { .. } => {
                return Err(ConversionError::Unsupported("function result part"))
            }
            UniversalMessagePart::File { .. } => {
                return Err(ConversionError::Unsupported("file part"))
            }
            UniversalMessagePart::Image { .. } => {
                return Err(ConversionError::Unsupported("image part"))
            }
            UniversalMessagePart::Error { .. } => {
                return Err(ConversionError::Unsupported("error part"))
            }
            UniversalMessagePart::Unknown { .. } => {
                return Err(ConversionError::Unsupported("unknown part"))
            }
        }
    }
    if text.is_empty() {
        Err(ConversionError::MissingField("text part"))
    } else {
        Ok(text)
    }
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
                let opencode::EventMessageUpdated { properties, type_: _ } = updated;
                let opencode::EventMessageUpdatedProperties { info } = properties;
                let (message, session_id) = message_from_opencode(info);
                EventConversion::new(UniversalEventData::Message { message })
                    .with_session(session_id)
            }
            opencode::Event::MessagePartUpdated(updated) => {
                let opencode::EventMessagePartUpdated { properties, type_: _ } = updated;
                let opencode::EventMessagePartUpdatedProperties { part, delta } = properties;
                let (message, session_id) = part_to_message(part, delta.as_ref());
                EventConversion::new(UniversalEventData::Message { message })
                    .with_session(session_id)
            }
            opencode::Event::QuestionAsked(asked) => {
                let opencode::EventQuestionAsked { properties, type_: _ } = asked;
                let question = question_request_from_opencode(properties);
                let session_id = question.session_id.clone();
                EventConversion::new(UniversalEventData::QuestionAsked { question_asked: question })
                    .with_session(Some(session_id))
            }
            opencode::Event::PermissionAsked(asked) => {
                let opencode::EventPermissionAsked { properties, type_: _ } = asked;
                let permission = permission_request_from_opencode(properties);
                let session_id = permission.session_id.clone();
                EventConversion::new(UniversalEventData::PermissionAsked { permission_asked: permission })
                    .with_session(Some(session_id))
            }
            opencode::Event::SessionCreated(created) => {
                let opencode::EventSessionCreated { properties, type_: _ } = created;
                let opencode::EventSessionCreatedProperties { info } = properties;
                let details = serde_json::to_value(info).ok();
                let started = Started {
                    message: Some("session.created".to_string()),
                    details,
                };
                EventConversion::new(UniversalEventData::Started { started })
            }
            opencode::Event::SessionError(error) => {
                let opencode::EventSessionError { properties, type_: _ } = error;
                let opencode::EventSessionErrorProperties {
                    error: _error,
                    session_id,
                } = properties;
                let message = extract_message_from_value(&serde_json::to_value(properties).unwrap_or(Value::Null))
                    .unwrap_or_else(|| "opencode session error".to_string());
                let crash = CrashInfo {
                    message,
                    kind: Some("session.error".to_string()),
                    details: serde_json::to_value(properties).ok(),
                };
                EventConversion::new(UniversalEventData::Error { error: crash })
                    .with_session(session_id.clone())
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
                    parts.push(text_part_input_from_text(text));
                }
                UniversalMessagePart::ToolCall { .. }
                | UniversalMessagePart::ToolResult { .. }
                | UniversalMessagePart::FunctionCall { .. }
                | UniversalMessagePart::FunctionResult { .. }
                | UniversalMessagePart::File { .. }
                | UniversalMessagePart::Image { .. }
                | UniversalMessagePart::Error { .. }
                | UniversalMessagePart::Unknown { .. } => {
                    return Err(ConversionError::Unsupported("non-text part"))
                }
            }
        }
        if parts.is_empty() {
            return Err(ConversionError::MissingField("parts"));
        }
        Ok(parts)
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(untagged)]
    pub enum OpencodePartInput {
        Text(opencode::TextPartInput),
        File(opencode::FilePartInput),
    }

    pub fn universal_message_to_part_inputs(
        message: &UniversalMessage,
    ) -> Result<Vec<OpencodePartInput>, ConversionError> {
        let parsed = match message {
            UniversalMessage::Parsed(parsed) => parsed,
            UniversalMessage::Unparsed { .. } => {
                return Err(ConversionError::Unsupported("unparsed message"))
            }
        };
        universal_parts_to_part_inputs(&parsed.parts)
    }

    pub fn universal_parts_to_part_inputs(
        parts: &[UniversalMessagePart],
    ) -> Result<Vec<OpencodePartInput>, ConversionError> {
        let mut inputs = Vec::new();
        for part in parts {
            inputs.push(universal_part_to_opencode_input(part)?);
        }
        if inputs.is_empty() {
            return Err(ConversionError::MissingField("parts"));
        }
        Ok(inputs)
    }

    pub fn universal_part_to_opencode_input(
        part: &UniversalMessagePart,
    ) -> Result<OpencodePartInput, ConversionError> {
        match part {
            UniversalMessagePart::Text { text } => Ok(OpencodePartInput::Text(
                text_part_input_from_text(text),
            )),
            UniversalMessagePart::File {
                source,
                mime_type,
                filename,
                ..
            } => Ok(OpencodePartInput::File(file_part_input_from_universal(
                source,
                mime_type.as_deref(),
                filename.as_ref(),
            )?)),
            UniversalMessagePart::Image {
                source, mime_type, ..
            } => Ok(OpencodePartInput::File(file_part_input_from_universal(
                source,
                mime_type.as_deref(),
                None,
            )?)),
            UniversalMessagePart::ToolCall { .. }
            | UniversalMessagePart::ToolResult { .. }
            | UniversalMessagePart::FunctionCall { .. }
            | UniversalMessagePart::FunctionResult { .. }
            | UniversalMessagePart::Error { .. }
            | UniversalMessagePart::Unknown { .. } => {
                Err(ConversionError::Unsupported("unsupported part"))
            }
        }
    }

    fn text_part_input_from_text(text: &str) -> opencode::TextPartInput {
        opencode::TextPartInput {
            id: None,
            ignored: None,
            metadata: Map::new(),
            synthetic: None,
            text: text.to_string(),
            time: None,
            type_: "text".to_string(),
        }
    }

    pub fn text_part_input_to_universal(part: &opencode::TextPartInput) -> UniversalMessage {
        let opencode::TextPartInput {
            id,
            ignored,
            metadata,
            synthetic,
            text,
            time,
            type_,
        } = part;
        let mut metadata = metadata.clone();
        if let Some(id) = id {
            metadata.insert("partId".to_string(), Value::String(id.clone()));
        }
        if let Some(ignored) = ignored {
            metadata.insert("ignored".to_string(), Value::Bool(*ignored));
        }
        if let Some(synthetic) = synthetic {
            metadata.insert("synthetic".to_string(), Value::Bool(*synthetic));
        }
        if let Some(time) = time {
            metadata.insert(
                "time".to_string(),
                serde_json::to_value(time).unwrap_or(Value::Null),
            );
        }
        metadata.insert("type".to_string(), Value::String(type_.clone()));
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: "user".to_string(),
            id: None,
            metadata,
            parts: vec![UniversalMessagePart::Text { text: text.clone() }],
        })
    }

    fn file_part_input_from_universal(
        source: &AttachmentSource,
        mime_type: Option<&str>,
        filename: Option<&String>,
    ) -> Result<opencode::FilePartInput, ConversionError> {
        let mime = mime_type.ok_or(ConversionError::MissingField("mime_type"))?;
        let url = attachment_source_to_opencode_url(source, mime)?;
        Ok(opencode::FilePartInput {
            filename: filename.cloned(),
            id: None,
            mime: mime.to_string(),
            source: None,
            type_: "file".to_string(),
            url,
        })
    }

    fn attachment_source_to_opencode_url(
        source: &AttachmentSource,
        mime_type: &str,
    ) -> Result<String, ConversionError> {
        match source {
            AttachmentSource::Url { url } => Ok(url.clone()),
            AttachmentSource::Path { path } => Ok(format!("file://{}", path)),
            AttachmentSource::Data { data, encoding } => {
                let encoding = encoding.as_deref().unwrap_or("base64");
                if encoding != "base64" {
                    return Err(ConversionError::Unsupported("opencode data encoding"));
                }
                Ok(format!("data:{};base64,{}", mime_type, data))
            }
        }
    }

    fn message_from_opencode(message: &opencode::Message) -> (UniversalMessage, Option<String>) {
        match message {
            opencode::Message::UserMessage(user) => {
                let opencode::UserMessage {
                    agent,
                    id,
                    model,
                    role,
                    session_id,
                    summary,
                    system,
                    time,
                    tools,
                    variant,
                } = user;
                let mut metadata = Map::new();
                metadata.insert("agent".to_string(), Value::String(agent.clone()));
                metadata.insert(
                    "model".to_string(),
                    serde_json::to_value(model).unwrap_or(Value::Null),
                );
                metadata.insert(
                    "time".to_string(),
                    serde_json::to_value(time).unwrap_or(Value::Null),
                );
                metadata.insert(
                    "tools".to_string(),
                    serde_json::to_value(tools).unwrap_or(Value::Null),
                );
                if let Some(summary) = summary {
                    metadata.insert(
                        "summary".to_string(),
                        serde_json::to_value(summary).unwrap_or(Value::Null),
                    );
                }
                if let Some(system) = system {
                    metadata.insert("system".to_string(), Value::String(system.clone()));
                }
                if let Some(variant) = variant {
                    metadata.insert("variant".to_string(), Value::String(variant.clone()));
                }
                let parsed = UniversalMessageParsed {
                    role: role.clone(),
                    id: Some(id.clone()),
                    metadata,
                    parts: Vec::new(),
                };
                (
                    UniversalMessage::Parsed(parsed),
                    Some(session_id.clone()),
                )
            }
            opencode::Message::AssistantMessage(assistant) => {
                let opencode::AssistantMessage {
                    agent,
                    cost,
                    error,
                    finish,
                    id,
                    mode,
                    model_id,
                    parent_id,
                    path,
                    provider_id,
                    role,
                    session_id,
                    summary,
                    time,
                    tokens,
                } = assistant;
                let mut metadata = Map::new();
                metadata.insert("agent".to_string(), Value::String(agent.clone()));
                metadata.insert(
                    "cost".to_string(),
                    serde_json::to_value(cost).unwrap_or(Value::Null),
                );
                metadata.insert("mode".to_string(), Value::String(mode.clone()));
                metadata.insert("modelId".to_string(), Value::String(model_id.clone()));
                metadata.insert("providerId".to_string(), Value::String(provider_id.clone()));
                metadata.insert("parentId".to_string(), Value::String(parent_id.clone()));
                metadata.insert(
                    "path".to_string(),
                    serde_json::to_value(path).unwrap_or(Value::Null),
                );
                metadata.insert(
                    "tokens".to_string(),
                    serde_json::to_value(tokens).unwrap_or(Value::Null),
                );
                metadata.insert(
                    "time".to_string(),
                    serde_json::to_value(time).unwrap_or(Value::Null),
                );
                if let Some(error) = error {
                    metadata.insert(
                        "error".to_string(),
                        serde_json::to_value(error).unwrap_or(Value::Null),
                    );
                }
                if let Some(finish) = finish {
                    metadata.insert("finish".to_string(), Value::String(finish.clone()));
                }
                if let Some(summary) = summary {
                    metadata.insert(
                        "summary".to_string(),
                        serde_json::to_value(summary).unwrap_or(Value::Null),
                    );
                }
                let parsed = UniversalMessageParsed {
                    role: role.clone(),
                    id: Some(id.clone()),
                    metadata,
                    parts: Vec::new(),
                };
                (
                    UniversalMessage::Parsed(parsed),
                    Some(session_id.clone()),
                )
            }
        }
    }

    fn part_to_message(part: &opencode::Part, delta: Option<&String>) -> (UniversalMessage, Option<String>) {
        match part {
            opencode::Part::Variant0(text_part) => {
                let opencode::TextPart {
                    id,
                    ignored,
                    message_id,
                    metadata,
                    session_id,
                    synthetic,
                    text,
                    time,
                    type_,
                } = text_part;
                let mut part_metadata = base_part_metadata(message_id, id, delta);
                part_metadata.insert("type".to_string(), Value::String(type_.clone()));
                if let Some(ignored) = ignored {
                    part_metadata.insert("ignored".to_string(), Value::Bool(*ignored));
                }
                if let Some(synthetic) = synthetic {
                    part_metadata.insert("synthetic".to_string(), Value::Bool(*synthetic));
                }
                if let Some(time) = time {
                    part_metadata.insert(
                        "time".to_string(),
                        serde_json::to_value(time).unwrap_or(Value::Null),
                    );
                }
                if !metadata.is_empty() {
                    part_metadata.insert(
                        "partMetadata".to_string(),
                        Value::Object(metadata.clone()),
                    );
                }
                let parsed = UniversalMessageParsed {
                    role: "assistant".to_string(),
                    id: Some(message_id.clone()),
                    metadata: part_metadata,
                    parts: vec![UniversalMessagePart::Text { text: text.clone() }],
                };
                (UniversalMessage::Parsed(parsed), Some(session_id.clone()))
            }
            opencode::Part::Variant1 {
                agent: _agent,
                command: _command,
                description: _description,
                id,
                message_id,
                model: _model,
                prompt: _prompt,
                session_id,
                type_: _type,
            } => unknown_part_message(message_id, id, session_id, serde_json::to_value(part).unwrap_or(Value::Null), delta),
            opencode::Part::Variant2(reasoning_part) => {
                let opencode::ReasoningPart {
                    id,
                    message_id,
                    metadata: _metadata,
                    session_id,
                    text: _text,
                    time: _time,
                    type_: _type,
                } = reasoning_part;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(reasoning_part).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant3(file_part) => {
                let opencode::FilePart {
                    filename: _filename,
                    id,
                    message_id,
                    mime: _mime,
                    session_id,
                    source: _source,
                    type_: _type,
                    url: _url,
                } = file_part;
                let part_metadata = base_part_metadata(message_id, id, delta);
                let part = file_part_to_universal_part(file_part);
                let parsed = UniversalMessageParsed {
                    role: "assistant".to_string(),
                    id: Some(message_id.clone()),
                    metadata: part_metadata,
                    parts: vec![part],
                };
                (UniversalMessage::Parsed(parsed), Some(session_id.clone()))
            }
            opencode::Part::Variant4(tool_part) => {
                let opencode::ToolPart {
                    call_id,
                    id,
                    message_id,
                    metadata,
                    session_id,
                    state,
                    tool,
                    type_,
                } = tool_part;
                let mut part_metadata = base_part_metadata(message_id, id, delta);
                part_metadata.insert("type".to_string(), Value::String(type_.clone()));
                part_metadata.insert("callId".to_string(), Value::String(call_id.clone()));
                part_metadata.insert("tool".to_string(), Value::String(tool.clone()));
                if !metadata.is_empty() {
                    part_metadata.insert(
                        "partMetadata".to_string(),
                        Value::Object(metadata.clone()),
                    );
                }
                let (mut parts, state_meta) = tool_state_to_parts(call_id, tool, state);
                if let Some(state_meta) = state_meta {
                    part_metadata.insert("toolState".to_string(), state_meta);
                }
                let parsed = UniversalMessageParsed {
                    role: "assistant".to_string(),
                    id: Some(message_id.clone()),
                    metadata: part_metadata,
                    parts: parts.drain(..).collect(),
                };
                (UniversalMessage::Parsed(parsed), Some(session_id.clone()))
            }
            opencode::Part::Variant5(step_start) => {
                let opencode::StepStartPart {
                    id,
                    message_id,
                    session_id,
                    snapshot: _snapshot,
                    type_: _type,
                } = step_start;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(step_start).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant6(step_finish) => {
                let opencode::StepFinishPart {
                    cost: _cost,
                    id,
                    message_id,
                    reason: _reason,
                    session_id,
                    snapshot: _snapshot,
                    tokens: _tokens,
                    type_: _type,
                } = step_finish;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(step_finish).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant7(snapshot_part) => {
                let opencode::SnapshotPart {
                    id,
                    message_id,
                    session_id,
                    snapshot: _snapshot,
                    type_: _type,
                } = snapshot_part;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(snapshot_part).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant8(patch_part) => {
                let opencode::PatchPart {
                    files: _files,
                    hash: _hash,
                    id,
                    message_id,
                    session_id,
                    type_: _type,
                } = patch_part;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(patch_part).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant9(agent_part) => {
                let opencode::AgentPart {
                    id,
                    message_id,
                    name: _name,
                    session_id,
                    source: _source,
                    type_: _type,
                } = agent_part;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(agent_part).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant10(retry_part) => {
                let opencode::RetryPart {
                    attempt: _attempt,
                    error: _error,
                    id,
                    message_id,
                    session_id,
                    time: _time,
                    type_: _type,
                } = retry_part;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(retry_part).unwrap_or(Value::Null),
                    delta,
                )
            }
            opencode::Part::Variant11(compaction_part) => {
                let opencode::CompactionPart {
                    auto: _auto,
                    id,
                    message_id,
                    session_id,
                    type_: _type,
                } = compaction_part;
                unknown_part_message(
                    message_id,
                    id,
                    session_id,
                    serde_json::to_value(compaction_part).unwrap_or(Value::Null),
                    delta,
                )
            }
        }
    }

    fn base_part_metadata(message_id: &str, part_id: &str, delta: Option<&String>) -> Map<String, Value> {
        let mut metadata = Map::new();
        metadata.insert("messageId".to_string(), Value::String(message_id.to_string()));
        metadata.insert("partId".to_string(), Value::String(part_id.to_string()));
        if let Some(delta) = delta {
            metadata.insert("delta".to_string(), Value::String(delta.clone()));
        }
        metadata
    }

    fn unknown_part_message(
        message_id: &str,
        part_id: &str,
        session_id: &str,
        raw: Value,
        delta: Option<&String>,
    ) -> (UniversalMessage, Option<String>) {
        let metadata = base_part_metadata(message_id, part_id, delta);
        let parsed = UniversalMessageParsed {
            role: "assistant".to_string(),
            id: Some(message_id.to_string()),
            metadata,
            parts: vec![UniversalMessagePart::Unknown { raw }],
        };
        (UniversalMessage::Parsed(parsed), Some(session_id.to_string()))
    }

    fn file_part_to_universal_part(file_part: &opencode::FilePart) -> UniversalMessagePart {
        let opencode::FilePart {
            filename,
            id: _id,
            message_id: _message_id,
            mime,
            session_id: _session_id,
            source: _source,
            type_: _type,
            url,
        } = file_part;
        let raw = serde_json::to_value(file_part).unwrap_or(Value::Null);
        let source = AttachmentSource::Url { url: url.clone() };
        if mime.starts_with("image/") {
            UniversalMessagePart::Image {
                source,
                mime_type: Some(mime.clone()),
                alt: filename.clone(),
                raw: Some(raw),
            }
        } else {
            UniversalMessagePart::File {
                source,
                mime_type: Some(mime.clone()),
                filename: filename.clone(),
                raw: Some(raw),
            }
        }
    }

    fn tool_state_to_parts(
        call_id: &str,
        tool: &str,
        state: &opencode::ToolState,
    ) -> (Vec<UniversalMessagePart>, Option<Value>) {
        match state {
            opencode::ToolState::Pending(state) => {
                let opencode::ToolStatePending { input, raw, status } = state;
                let mut meta = Map::new();
                meta.insert("status".to_string(), Value::String(status.clone()));
                meta.insert("raw".to_string(), Value::String(raw.clone()));
                meta.insert("input".to_string(), Value::Object(input.clone()));
                (
                    vec![UniversalMessagePart::ToolCall {
                        id: Some(call_id.to_string()),
                        name: tool.to_string(),
                        input: Value::Object(input.clone()),
                    }],
                    Some(Value::Object(meta)),
                )
            }
            opencode::ToolState::Running(state) => {
                let opencode::ToolStateRunning {
                    input,
                    metadata,
                    status,
                    time,
                    title,
                } = state;
                let mut meta = Map::new();
                meta.insert("status".to_string(), Value::String(status.clone()));
                meta.insert("input".to_string(), Value::Object(input.clone()));
                meta.insert("metadata".to_string(), Value::Object(metadata.clone()));
                meta.insert(
                    "time".to_string(),
                    serde_json::to_value(time).unwrap_or(Value::Null),
                );
                if let Some(title) = title {
                    meta.insert("title".to_string(), Value::String(title.clone()));
                }
                (
                    vec![UniversalMessagePart::ToolCall {
                        id: Some(call_id.to_string()),
                        name: tool.to_string(),
                        input: Value::Object(input.clone()),
                    }],
                    Some(Value::Object(meta)),
                )
            }
            opencode::ToolState::Completed(state) => {
                let opencode::ToolStateCompleted {
                    attachments,
                    input,
                    metadata,
                    output,
                    status,
                    time,
                    title,
                } = state;
                let mut meta = Map::new();
                meta.insert("status".to_string(), Value::String(status.clone()));
                meta.insert("input".to_string(), Value::Object(input.clone()));
                meta.insert("metadata".to_string(), Value::Object(metadata.clone()));
                meta.insert(
                    "time".to_string(),
                    serde_json::to_value(time).unwrap_or(Value::Null),
                );
                meta.insert("title".to_string(), Value::String(title.clone()));
                if !attachments.is_empty() {
                    meta.insert(
                        "attachments".to_string(),
                        serde_json::to_value(attachments).unwrap_or(Value::Null),
                    );
                }
                let mut parts = vec![UniversalMessagePart::ToolResult {
                    id: Some(call_id.to_string()),
                    name: Some(tool.to_string()),
                    output: Value::String(output.clone()),
                    is_error: Some(false),
                }];
                for attachment in attachments {
                    parts.push(file_part_to_universal_part(attachment));
                }
                (parts, Some(Value::Object(meta)))
            }
            opencode::ToolState::Error(state) => {
                let opencode::ToolStateError {
                    error,
                    input,
                    metadata,
                    status,
                    time,
                } = state;
                let mut meta = Map::new();
                meta.insert("status".to_string(), Value::String(status.clone()));
                meta.insert("error".to_string(), Value::String(error.clone()));
                meta.insert("input".to_string(), Value::Object(input.clone()));
                meta.insert("metadata".to_string(), Value::Object(metadata.clone()));
                meta.insert(
                    "time".to_string(),
                    serde_json::to_value(time).unwrap_or(Value::Null),
                );
                (
                    vec![UniversalMessagePart::ToolResult {
                        id: Some(call_id.to_string()),
                        name: Some(tool.to_string()),
                        output: Value::String(error.clone()),
                        is_error: Some(true),
                    }],
                    Some(Value::Object(meta)),
                )
            }
        }
    }

    fn question_request_from_opencode(request: &opencode::QuestionRequest) -> QuestionRequest {
        let opencode::QuestionRequest {
            id,
            questions,
            session_id,
            tool,
        } = request;
        QuestionRequest {
            id: id.clone().into(),
            session_id: session_id.clone().into(),
            questions: questions
                .iter()
                .map(|question| {
                    let opencode::QuestionInfo {
                        custom,
                        header,
                        multiple,
                        options,
                        question,
                    } = question;
                    QuestionInfo {
                        question: question.clone(),
                        header: Some(header.clone()),
                        options: options
                            .iter()
                            .map(|opt| {
                                let opencode::QuestionOption { description, label } = opt;
                                QuestionOption {
                                    label: label.clone(),
                                    description: Some(description.clone()),
                                }
                            })
                            .collect(),
                        multi_select: *multiple,
                        custom: *custom,
                    }
                })
                .collect(),
            tool: tool.as_ref().map(|tool| {
                let opencode::QuestionRequestTool { message_id, call_id } = tool;
                QuestionToolRef {
                    message_id: message_id.clone(),
                    call_id: call_id.clone(),
                }
            }),
        }
    }

    fn permission_request_from_opencode(request: &opencode::PermissionRequest) -> PermissionRequest {
        let opencode::PermissionRequest {
            always,
            id,
            metadata,
            patterns,
            permission,
            session_id,
            tool,
        } = request;
        PermissionRequest {
            id: id.clone().into(),
            session_id: session_id.clone().into(),
            permission: permission.clone(),
            patterns: patterns.clone(),
            metadata: metadata.clone(),
            always: always.clone(),
            tool: tool.as_ref().map(|tool| {
                let opencode::PermissionRequestTool { message_id, call_id } = tool;
                PermissionToolRef {
                    message_id: message_id.clone(),
                    call_id: call_id.clone(),
                }
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
        let codex::ThreadEvent {
            error,
            item,
            thread_id,
            type_,
        } = event;
        match type_ {
            codex::ThreadEventType::ThreadCreated | codex::ThreadEventType::ThreadUpdated => {
                let started = Started {
                    message: Some(type_.to_string()),
                    details: serde_json::to_value(event).ok(),
                };
                EventConversion::new(UniversalEventData::Started { started })
                    .with_session(thread_id.clone())
            }
            codex::ThreadEventType::ItemCreated | codex::ThreadEventType::ItemUpdated => {
                if let Some(item) = item.as_ref() {
                    let message = thread_item_to_message(item);
                    EventConversion::new(UniversalEventData::Message { message })
                        .with_session(thread_id.clone())
                } else {
                    EventConversion::new(UniversalEventData::Unknown {
                        raw: serde_json::to_value(event).unwrap_or(Value::Null),
                    })
                }
            }
            codex::ThreadEventType::Error => {
                let message = extract_message_from_value(&Value::Object(error.clone()))
                    .unwrap_or_else(|| "codex error".to_string());
                let crash = CrashInfo {
                    message,
                    kind: Some("error".to_string()),
                    details: Some(Value::Object(error.clone())),
                };
                EventConversion::new(UniversalEventData::Error { error: crash })
                    .with_session(thread_id.clone())
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
                let content = text_only_from_parts(&parsed.parts)?;
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
        let codex::Message { role, content } = message;
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: role.to_string(),
            id: None,
            metadata: Map::new(),
            parts: vec![UniversalMessagePart::Text {
                text: content.clone(),
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
        let content = text_only_from_parts(&parsed.parts)?;
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

    pub fn inputs_to_universal_message(inputs: &[codex::Input], role: &str) -> UniversalMessage {
        let parts = inputs.iter().map(input_to_universal_part).collect();
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: role.to_string(),
            id: None,
            metadata: Map::new(),
            parts,
        })
    }

    pub fn input_to_universal_part(input: &codex::Input) -> UniversalMessagePart {
        let codex::Input {
            content,
            mime_type,
            path,
            type_,
        } = input;
        let raw = serde_json::to_value(input).unwrap_or(Value::Null);
        match type_ {
            codex::InputType::Text => match content {
                Some(content) => UniversalMessagePart::Text {
                    text: content.clone(),
                },
                None => UniversalMessagePart::Unknown { raw },
            },
            codex::InputType::File => {
                let source = if let Some(path) = path {
                    AttachmentSource::Path { path: path.clone() }
                } else if let Some(content) = content {
                    AttachmentSource::Data {
                        data: content.clone(),
                        encoding: None,
                    }
                } else {
                    return UniversalMessagePart::Unknown { raw };
                };
                UniversalMessagePart::File {
                    source,
                    mime_type: mime_type.clone(),
                    filename: None,
                    raw: Some(raw),
                }
            }
            codex::InputType::Image => {
                let source = if let Some(path) = path {
                    AttachmentSource::Path { path: path.clone() }
                } else if let Some(content) = content {
                    AttachmentSource::Data {
                        data: content.clone(),
                        encoding: None,
                    }
                } else {
                    return UniversalMessagePart::Unknown { raw };
                };
                UniversalMessagePart::Image {
                    source,
                    mime_type: mime_type.clone(),
                    alt: None,
                    raw: Some(raw),
                }
            }
        }
    }

    pub fn universal_message_to_inputs(
        message: &UniversalMessage,
    ) -> Result<Vec<codex::Input>, ConversionError> {
        let parsed = match message {
            UniversalMessage::Parsed(parsed) => parsed,
            UniversalMessage::Unparsed { .. } => {
                return Err(ConversionError::Unsupported("unparsed message"))
            }
        };
        universal_parts_to_inputs(&parsed.parts)
    }

    pub fn universal_parts_to_inputs(
        parts: &[UniversalMessagePart],
    ) -> Result<Vec<codex::Input>, ConversionError> {
        let mut inputs = Vec::new();
        for part in parts {
            match part {
                UniversalMessagePart::Text { text } => inputs.push(codex::Input {
                    content: Some(text.clone()),
                    mime_type: None,
                    path: None,
                    type_: codex::InputType::Text,
                }),
                UniversalMessagePart::File {
                    source,
                    mime_type,
                    ..
                } => inputs.push(input_from_attachment(source, mime_type.as_ref(), codex::InputType::File)?),
                UniversalMessagePart::Image {
                    source, mime_type, ..
                } => inputs.push(input_from_attachment(
                    source,
                    mime_type.as_ref(),
                    codex::InputType::Image,
                )?),
                UniversalMessagePart::ToolCall { .. }
                | UniversalMessagePart::ToolResult { .. }
                | UniversalMessagePart::FunctionCall { .. }
                | UniversalMessagePart::FunctionResult { .. }
                | UniversalMessagePart::Error { .. }
                | UniversalMessagePart::Unknown { .. } => {
                    return Err(ConversionError::Unsupported("unsupported part"))
                }
            }
        }
        if inputs.is_empty() {
            return Err(ConversionError::MissingField("parts"));
        }
        Ok(inputs)
    }

    fn input_from_attachment(
        source: &AttachmentSource,
        mime_type: Option<&String>,
        input_type: codex::InputType,
    ) -> Result<codex::Input, ConversionError> {
        match source {
            AttachmentSource::Path { path } => Ok(codex::Input {
                content: None,
                mime_type: mime_type.cloned(),
                path: Some(path.clone()),
                type_: input_type,
            }),
            AttachmentSource::Data { data, encoding } => {
                if let Some(encoding) = encoding.as_deref() {
                    if encoding != "base64" {
                        return Err(ConversionError::Unsupported("codex data encoding"));
                    }
                }
                Ok(codex::Input {
                    content: Some(data.clone()),
                    mime_type: mime_type.cloned(),
                    path: None,
                    type_: input_type,
                })
            }
            AttachmentSource::Url { .. } => Err(ConversionError::Unsupported("codex input url")),
        }
    }

    fn thread_item_to_message(item: &codex::ThreadItem) -> UniversalMessage {
        let codex::ThreadItem {
            content,
            id,
            role,
            status,
            type_,
        } = item;
        let mut metadata = Map::new();
        metadata.insert("itemType".to_string(), Value::String(type_.to_string()));
        if let Some(status) = status {
            metadata.insert("status".to_string(), Value::String(status.to_string()));
        }
        let role = role
            .as_ref()
            .map(|role| role.to_string())
            .unwrap_or_else(|| "assistant".to_string());
        let parts = match type_ {
            codex::ThreadItemType::Message => message_parts_from_codex_content(content),
            codex::ThreadItemType::FunctionCall => vec![function_call_part_from_codex(id, content)],
            codex::ThreadItemType::FunctionResult => vec![function_result_part_from_codex(id, content)],
        };
        UniversalMessage::Parsed(UniversalMessageParsed {
            role,
            id: Some(id.clone()),
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

    fn function_call_part_from_codex(
        item_id: &str,
        content: &Option<codex::ThreadItemContent>,
    ) -> UniversalMessagePart {
        let raw = thread_item_content_to_value(content);
        let name = extract_object_field(&raw, "name");
        let arguments = extract_object_value(&raw, "arguments").unwrap_or_else(|| raw.clone());
        UniversalMessagePart::FunctionCall {
            id: Some(item_id.to_string()),
            name,
            arguments,
            raw: Some(raw),
        }
    }

    fn function_result_part_from_codex(
        item_id: &str,
        content: &Option<codex::ThreadItemContent>,
    ) -> UniversalMessagePart {
        let raw = thread_item_content_to_value(content);
        let name = extract_object_field(&raw, "name");
        let result = extract_object_value(&raw, "result")
            .or_else(|| extract_object_value(&raw, "output"))
            .or_else(|| extract_object_value(&raw, "content"))
            .unwrap_or_else(|| raw.clone());
        UniversalMessagePart::FunctionResult {
            id: Some(item_id.to_string()),
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
        let amp::StreamJsonMessage {
            content,
            error,
            id,
            tool_call,
            type_,
        } = event;
        match type_ {
            amp::StreamJsonMessageType::Message => {
                let text = content.clone().unwrap_or_default();
                let mut message = message_from_text("assistant", text);
                if let UniversalMessage::Parsed(parsed) = &mut message {
                    parsed.id = id.clone();
                }
                EventConversion::new(UniversalEventData::Message { message })
            }
            amp::StreamJsonMessageType::ToolCall => {
                let tool_call = tool_call.as_ref();
                let part = if let Some(tool_call) = tool_call {
                    let amp::ToolCall { arguments, id, name } = tool_call;
                    let input = match arguments {
                        amp::ToolCallArguments::Variant0(text) => Value::String(text.clone()),
                        amp::ToolCallArguments::Variant1(map) => Value::Object(map.clone()),
                    };
                    UniversalMessagePart::ToolCall {
                        id: Some(id.clone()),
                        name: name.clone(),
                        input,
                    }
                } else {
                    UniversalMessagePart::Unknown { raw: Value::Null }
                };
                let mut message = message_from_parts("assistant", vec![part]);
                if let UniversalMessage::Parsed(parsed) = &mut message {
                    parsed.id = id.clone();
                }
                EventConversion::new(UniversalEventData::Message { message })
            }
            amp::StreamJsonMessageType::ToolResult => {
                let output = content
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null);
                let part = UniversalMessagePart::ToolResult {
                    id: id.clone(),
                    name: None,
                    output,
                    is_error: None,
                };
                let message = message_from_parts("tool", vec![part]);
                EventConversion::new(UniversalEventData::Message { message })
            }
            amp::StreamJsonMessageType::Error => {
                let message = error.clone().unwrap_or_else(|| "amp error".to_string());
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
                let content = text_only_from_parts(&parsed.parts)?;
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
        let amp::Message {
            role,
            content,
            tool_calls,
        } = message;
        let mut parts = vec![UniversalMessagePart::Text {
            text: content.clone(),
        }];
        for call in tool_calls {
            let amp::ToolCall { arguments, id, name } = call;
            let input = match arguments {
                amp::ToolCallArguments::Variant0(text) => Value::String(text.clone()),
                amp::ToolCallArguments::Variant1(map) => Value::Object(map.clone()),
            };
            parts.push(UniversalMessagePart::ToolCall {
                id: Some(id.clone()),
                name: name.clone(),
                input,
            });
        }
        UniversalMessage::Parsed(UniversalMessageParsed {
            role: role.to_string(),
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
        let content = text_only_from_parts(&parsed.parts)?;
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
                let text = text_only_from_parts(&parsed.parts)?;
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
        text_only_from_parts(&parsed.parts)
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
