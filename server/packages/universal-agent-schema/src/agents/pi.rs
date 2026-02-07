use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::pi as schema;
use crate::{
    ContentPart, EventConversion, ItemDeltaData, ItemEventData, ItemKind, ItemRole, ItemStatus,
    ReasoningVisibility, UniversalEventData, UniversalEventType, UniversalItem,
};

#[derive(Default)]
pub struct PiEventConverter {
    tool_result_buffers: HashMap<String, String>,
    tool_result_started: HashSet<String>,
    message_completed: HashSet<String>,
    message_errors: HashSet<String>,
    message_reasoning: HashMap<String, String>,
    message_text: HashMap<String, String>,
    last_message_id: Option<String>,
    message_started: HashSet<String>,
    message_counter: u64,
}

impl PiEventConverter {
    pub fn event_value_to_universal(
        &mut self,
        raw: &Value,
    ) -> Result<Vec<EventConversion>, String> {
        let event_type = raw
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing event type".to_string())?;
        let native_session_id = extract_session_id(raw);

        let conversions = match event_type {
            "message_start" => self.message_start(raw),
            "message_update" => self.message_update(raw),
            "message_end" => self.message_end(raw),
            "tool_execution_start" => self.tool_execution_start(raw),
            "tool_execution_update" => self.tool_execution_update(raw),
            "tool_execution_end" => self.tool_execution_end(raw),
            "agent_start"
            | "agent_end"
            | "turn_start"
            | "turn_end"
            | "auto_compaction"
            | "auto_compaction_start"
            | "auto_compaction_end"
            | "auto_retry"
            | "auto_retry_start"
            | "auto_retry_end"
            | "hook_error" => Ok(vec![status_event(event_type, raw)]),
            "extension_ui_request" | "extension_ui_response" | "extension_error" => {
                Ok(vec![status_event(event_type, raw)])
            }
            other => Err(format!("unsupported Pi event type: {other}")),
        }?;

        Ok(conversions
            .into_iter()
            .map(|conversion| attach_metadata(conversion, &native_session_id, raw))
            .collect())
    }

    fn next_synthetic_message_id(&mut self) -> String {
        self.message_counter += 1;
        format!("pi_msg_{}", self.message_counter)
    }

    fn ensure_message_id(&mut self, message_id: Option<String>) -> String {
        if let Some(id) = message_id {
            self.last_message_id = Some(id.clone());
            return id;
        }
        if let Some(id) = self.last_message_id.clone() {
            return id;
        }
        let id = self.next_synthetic_message_id();
        self.last_message_id = Some(id.clone());
        id
    }

    fn ensure_message_started(&mut self, message_id: &str) -> Option<EventConversion> {
        if !self.message_started.insert(message_id.to_string()) {
            return None;
        }
        let item = UniversalItem {
            item_id: String::new(),
            native_item_id: Some(message_id.to_string()),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::Assistant),
            content: Vec::new(),
            status: ItemStatus::InProgress,
        };
        Some(
            EventConversion::new(
                UniversalEventType::ItemStarted,
                UniversalEventData::Item(ItemEventData { item }),
            )
            .synthetic(),
        )
    }

    fn clear_last_message_id(&mut self, message_id: Option<&str>) {
        if message_id.is_none() || self.last_message_id.as_deref() == message_id {
            self.last_message_id = None;
        }
    }

    pub fn event_to_universal(
        &mut self,
        event: &schema::RpcEvent,
    ) -> Result<Vec<EventConversion>, String> {
        let raw = serde_json::to_value(event).map_err(|err| err.to_string())?;
        self.event_value_to_universal(&raw)
    }

    fn message_start(&mut self, raw: &Value) -> Result<Vec<EventConversion>, String> {
        let message = raw.get("message");
        if is_user_role(message) {
            return Ok(Vec::new());
        }
        let message_id = self.ensure_message_id(extract_message_id(raw));
        self.message_completed.remove(&message_id);
        self.message_started.insert(message_id.clone());
        let content = message.and_then(parse_message_content).unwrap_or_default();
        let entry = self.message_text.entry(message_id.clone()).or_default();
        for part in &content {
            if let ContentPart::Text { text } = part {
                entry.push_str(text);
            }
        }
        let item = UniversalItem {
            item_id: String::new(),
            native_item_id: Some(message_id),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::Assistant),
            content,
            status: ItemStatus::InProgress,
        };
        Ok(vec![EventConversion::new(
            UniversalEventType::ItemStarted,
            UniversalEventData::Item(ItemEventData { item }),
        )])
    }

    fn message_update(&mut self, raw: &Value) -> Result<Vec<EventConversion>, String> {
        let assistant_event = raw
            .get("assistantMessageEvent")
            .or_else(|| raw.get("assistant_message_event"))
            .ok_or_else(|| "missing assistantMessageEvent".to_string())?;
        let event_type = assistant_event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("");
        let message_id = extract_message_id(raw)
            .or_else(|| extract_message_id(assistant_event))
            .or_else(|| self.last_message_id.clone());

        match event_type {
            "start" => {
                if let Some(id) = message_id {
                    self.last_message_id = Some(id);
                }
                Ok(Vec::new())
            }
            "text_start" | "text_delta" | "text_end" => {
                let Some(delta) = extract_delta_text(assistant_event) else {
                    return Ok(Vec::new());
                };
                let message_id = self.ensure_message_id(message_id);
                let entry = self.message_text.entry(message_id.clone()).or_default();
                entry.push_str(&delta);
                let mut conversions = Vec::new();
                if let Some(start) = self.ensure_message_started(&message_id) {
                    conversions.push(start);
                }
                conversions.push(item_delta(Some(message_id), delta));
                Ok(conversions)
            }
            "thinking_start" | "thinking_delta" | "thinking_end" => {
                let Some(delta) = extract_delta_text(assistant_event) else {
                    return Ok(Vec::new());
                };
                let message_id = self.ensure_message_id(message_id);
                let entry = self
                    .message_reasoning
                    .entry(message_id.clone())
                    .or_default();
                entry.push_str(&delta);
                let mut conversions = Vec::new();
                if let Some(start) = self.ensure_message_started(&message_id) {
                    conversions.push(start);
                }
                conversions.push(item_delta(Some(message_id), delta));
                Ok(conversions)
            }
            "toolcall_start"
            | "toolcall_delta"
            | "toolcall_end"
            | "toolcall_args_start"
            | "toolcall_args_delta"
            | "toolcall_args_end" => Ok(Vec::new()),
            "done" => {
                let message_id = self.ensure_message_id(message_id);
                if self.message_errors.remove(&message_id) {
                    self.message_text.remove(&message_id);
                    self.message_reasoning.remove(&message_id);
                    self.message_started.remove(&message_id);
                    self.clear_last_message_id(Some(&message_id));
                    return Ok(Vec::new());
                }
                if self.message_completed.contains(&message_id) {
                    self.clear_last_message_id(Some(&message_id));
                    return Ok(Vec::new());
                }
                let message = raw
                    .get("message")
                    .or_else(|| assistant_event.get("message"));
                let conversion = self.complete_message(Some(message_id.clone()), message);
                self.message_completed.insert(message_id.clone());
                self.clear_last_message_id(Some(&message_id));
                Ok(vec![conversion])
            }
            "error" => {
                let message_id = self.ensure_message_id(message_id);
                if self.message_completed.contains(&message_id) {
                    self.clear_last_message_id(Some(&message_id));
                    return Ok(Vec::new());
                }
                let error_text = assistant_event
                    .get("error")
                    .or_else(|| raw.get("error"))
                    .map(value_to_string)
                    .unwrap_or_else(|| "Pi message error".to_string());
                self.message_reasoning.remove(&message_id);
                self.message_text.remove(&message_id);
                self.message_errors.insert(message_id.clone());
                self.message_started.remove(&message_id);
                self.message_completed.insert(message_id.clone());
                self.clear_last_message_id(Some(&message_id));
                let item = UniversalItem {
                    item_id: String::new(),
                    native_item_id: Some(message_id),
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::Assistant),
                    content: vec![ContentPart::Text { text: error_text }],
                    status: ItemStatus::Failed,
                };
                Ok(vec![EventConversion::new(
                    UniversalEventType::ItemCompleted,
                    UniversalEventData::Item(ItemEventData { item }),
                )])
            }
            other => Err(format!("unsupported assistantMessageEvent: {other}")),
        }
    }

    fn message_end(&mut self, raw: &Value) -> Result<Vec<EventConversion>, String> {
        let message = raw.get("message");
        if is_user_role(message) {
            return Ok(Vec::new());
        }
        let message_id = self
            .ensure_message_id(extract_message_id(raw).or_else(|| self.last_message_id.clone()));
        if self.message_errors.remove(&message_id) {
            self.message_text.remove(&message_id);
            self.message_reasoning.remove(&message_id);
            self.message_started.remove(&message_id);
            self.clear_last_message_id(Some(&message_id));
            return Ok(Vec::new());
        }
        if self.message_completed.contains(&message_id) {
            self.clear_last_message_id(Some(&message_id));
            return Ok(Vec::new());
        }
        let conversion = self.complete_message(Some(message_id.clone()), message);
        self.message_completed.insert(message_id.clone());
        self.clear_last_message_id(Some(&message_id));
        Ok(vec![conversion])
    }

    fn complete_message(
        &mut self,
        message_id: Option<String>,
        message: Option<&Value>,
    ) -> EventConversion {
        let mut content = message.and_then(parse_message_content).unwrap_or_default();
        let failed = message_is_failed(message);
        let message_error_text = extract_message_error_text(message);

        if let Some(id) = message_id.clone() {
            if content.is_empty() {
                if let Some(text) = self.message_text.remove(&id) {
                    if !text.is_empty() {
                        content.push(ContentPart::Text { text });
                    }
                }
            } else {
                self.message_text.remove(&id);
            }

            if let Some(reasoning) = self.message_reasoning.remove(&id) {
                if !reasoning.trim().is_empty()
                    && !content
                        .iter()
                        .any(|part| matches!(part, ContentPart::Reasoning { .. }))
                {
                    content.push(ContentPart::Reasoning {
                        text: reasoning,
                        visibility: ReasoningVisibility::Private,
                    });
                }
            }
            self.message_started.remove(&id);
        }

        if failed && content.is_empty() {
            if let Some(text) = message_error_text {
                content.push(ContentPart::Text { text });
            }
        }

        let item = UniversalItem {
            item_id: String::new(),
            native_item_id: message_id,
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::Assistant),
            content,
            status: if failed {
                ItemStatus::Failed
            } else {
                ItemStatus::Completed
            },
        };
        EventConversion::new(
            UniversalEventType::ItemCompleted,
            UniversalEventData::Item(ItemEventData { item }),
        )
    }

    fn tool_execution_start(&mut self, raw: &Value) -> Result<Vec<EventConversion>, String> {
        let tool_call_id =
            extract_tool_call_id(raw).ok_or_else(|| "missing toolCallId".to_string())?;
        let tool_name = extract_tool_name(raw).unwrap_or_else(|| "tool".to_string());
        let arguments = raw
            .get("args")
            .or_else(|| raw.get("arguments"))
            .map(value_to_string)
            .unwrap_or_else(|| "{}".to_string());
        let item = UniversalItem {
            item_id: String::new(),
            native_item_id: Some(tool_call_id.clone()),
            parent_id: None,
            kind: ItemKind::ToolCall,
            role: Some(ItemRole::Assistant),
            content: vec![ContentPart::ToolCall {
                name: tool_name,
                arguments,
                call_id: tool_call_id,
            }],
            status: ItemStatus::InProgress,
        };
        Ok(vec![EventConversion::new(
            UniversalEventType::ItemStarted,
            UniversalEventData::Item(ItemEventData { item }),
        )])
    }

    fn tool_execution_update(&mut self, raw: &Value) -> Result<Vec<EventConversion>, String> {
        let tool_call_id = match extract_tool_call_id(raw) {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };
        let partial = match raw
            .get("partialResult")
            .or_else(|| raw.get("partial_result"))
        {
            Some(value) => value_to_string(value),
            None => return Ok(Vec::new()),
        };
        let prior = self
            .tool_result_buffers
            .get(&tool_call_id)
            .cloned()
            .unwrap_or_default();
        let delta = delta_from_partial(&prior, &partial);
        self.tool_result_buffers
            .insert(tool_call_id.clone(), partial);

        let mut conversions = Vec::new();
        if self.tool_result_started.insert(tool_call_id.clone()) {
            let item = UniversalItem {
                item_id: String::new(),
                native_item_id: Some(tool_call_id.clone()),
                parent_id: None,
                kind: ItemKind::ToolResult,
                role: Some(ItemRole::Tool),
                content: vec![ContentPart::ToolResult {
                    call_id: tool_call_id.clone(),
                    output: String::new(),
                }],
                status: ItemStatus::InProgress,
            };
            conversions.push(
                EventConversion::new(
                    UniversalEventType::ItemStarted,
                    UniversalEventData::Item(ItemEventData { item }),
                )
                .synthetic(),
            );
        }

        if !delta.is_empty() {
            conversions.push(
                EventConversion::new(
                    UniversalEventType::ItemDelta,
                    UniversalEventData::ItemDelta(ItemDeltaData {
                        item_id: String::new(),
                        native_item_id: Some(tool_call_id.clone()),
                        delta,
                    }),
                )
                .synthetic(),
            );
        }

        Ok(conversions)
    }

    fn tool_execution_end(&mut self, raw: &Value) -> Result<Vec<EventConversion>, String> {
        let tool_call_id =
            extract_tool_call_id(raw).ok_or_else(|| "missing toolCallId".to_string())?;
        self.tool_result_buffers.remove(&tool_call_id);
        self.tool_result_started.remove(&tool_call_id);

        let output = raw
            .get("result")
            .and_then(extract_result_content)
            .unwrap_or_default();
        let is_error = raw.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let item = UniversalItem {
            item_id: String::new(),
            native_item_id: Some(tool_call_id.clone()),
            parent_id: None,
            kind: ItemKind::ToolResult,
            role: Some(ItemRole::Tool),
            content: vec![ContentPart::ToolResult {
                call_id: tool_call_id,
                output,
            }],
            status: if is_error {
                ItemStatus::Failed
            } else {
                ItemStatus::Completed
            },
        };
        Ok(vec![EventConversion::new(
            UniversalEventType::ItemCompleted,
            UniversalEventData::Item(ItemEventData { item }),
        )])
    }
}

pub fn event_to_universal(event: &schema::RpcEvent) -> Result<Vec<EventConversion>, String> {
    PiEventConverter::default().event_to_universal(event)
}

pub fn event_value_to_universal(raw: &Value) -> Result<Vec<EventConversion>, String> {
    PiEventConverter::default().event_value_to_universal(raw)
}

fn attach_metadata(
    conversion: EventConversion,
    native_session_id: &Option<String>,
    raw: &Value,
) -> EventConversion {
    conversion
        .with_native_session(native_session_id.clone())
        .with_raw(Some(raw.clone()))
}

fn status_event(label: &str, raw: &Value) -> EventConversion {
    let detail = raw
        .get("error")
        .or_else(|| raw.get("message"))
        .map(value_to_string);
    let item = UniversalItem {
        item_id: String::new(),
        native_item_id: None,
        parent_id: None,
        kind: ItemKind::Status,
        role: Some(ItemRole::System),
        content: vec![ContentPart::Status {
            label: pi_status_label(label),
            detail,
        }],
        status: ItemStatus::Completed,
    };
    EventConversion::new(
        UniversalEventType::ItemCompleted,
        UniversalEventData::Item(ItemEventData { item }),
    )
}

fn pi_status_label(label: &str) -> String {
    match label {
        "turn_end" => "turn.completed".to_string(),
        "agent_end" => "session.idle".to_string(),
        _ => format!("pi.{label}"),
    }
}

fn item_delta(message_id: Option<String>, delta: String) -> EventConversion {
    EventConversion::new(
        UniversalEventType::ItemDelta,
        UniversalEventData::ItemDelta(ItemDeltaData {
            item_id: String::new(),
            native_item_id: message_id,
            delta,
        }),
    )
}

fn is_user_role(message: Option<&Value>) -> bool {
    message
        .and_then(|msg| msg.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| role == "user")
}

fn extract_session_id(value: &Value) -> Option<String> {
    extract_string(value, &["sessionId"])
        .or_else(|| extract_string(value, &["session_id"]))
        .or_else(|| extract_string(value, &["session", "id"]))
        .or_else(|| extract_string(value, &["message", "sessionId"]))
}

fn extract_message_id(value: &Value) -> Option<String> {
    extract_string(value, &["messageId"])
        .or_else(|| extract_string(value, &["message_id"]))
        .or_else(|| extract_string(value, &["message", "id"]))
        .or_else(|| extract_string(value, &["message", "messageId"]))
        .or_else(|| extract_string(value, &["assistantMessageEvent", "messageId"]))
}

fn extract_tool_call_id(value: &Value) -> Option<String> {
    extract_string(value, &["toolCallId"]).or_else(|| extract_string(value, &["tool_call_id"]))
}

fn extract_tool_name(value: &Value) -> Option<String> {
    extract_string(value, &["toolName"]).or_else(|| extract_string(value, &["tool_name"]))
}

fn extract_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|value| value.to_string())
}

fn extract_delta_text(event: &Value) -> Option<String> {
    if let Some(value) = event.get("delta") {
        return Some(value_to_string(value));
    }
    if let Some(value) = event.get("text") {
        return Some(value_to_string(value));
    }
    if let Some(value) = event.get("partial") {
        return extract_text_from_value(value);
    }
    if let Some(value) = event.get("content") {
        return extract_text_from_value(value);
    }
    None
}

fn extract_text_from_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    None
}

fn extract_result_content(value: &Value) -> Option<String> {
    let content = value.get("content").and_then(Value::as_str);
    let text = value.get("text").and_then(Value::as_str);
    content
        .or(text)
        .map(|value| value.to_string())
        .or_else(|| Some(value_to_string(value)))
}

fn parse_message_content(message: &Value) -> Option<Vec<ContentPart>> {
    if let Some(text) = message.as_str() {
        return Some(vec![ContentPart::Text {
            text: text.to_string(),
        }]);
    }
    let content_value = message
        .get("content")
        .or_else(|| message.get("text"))
        .or_else(|| message.get("value"))?;
    let mut parts = Vec::new();
    match content_value {
        Value::String(text) => parts.push(ContentPart::Text { text: text.clone() }),
        Value::Array(items) => {
            for item in items {
                if let Some(part) = content_part_from_value(item) {
                    parts.push(part);
                }
            }
        }
        Value::Object(_) => {
            if let Some(part) = content_part_from_value(content_value) {
                parts.push(part);
            }
        }
        _ => {}
    }
    Some(parts)
}

fn message_is_failed(message: Option<&Value>) -> bool {
    message
        .and_then(|value| {
            value
                .get("stopReason")
                .or_else(|| value.get("stop_reason"))
                .and_then(Value::as_str)
        })
        .is_some_and(|reason| reason == "error" || reason == "aborted")
}

fn extract_message_error_text(message: Option<&Value>) -> Option<String> {
    let value = message?;

    if let Some(text) = value
        .get("errorMessage")
        .or_else(|| value.get("error_message"))
        .and_then(Value::as_str)
    {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let error = value.get("error")?;
    if let Some(text) = error.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(text) = error
        .get("errorMessage")
        .or_else(|| error.get("error_message"))
        .or_else(|| error.get("message"))
        .and_then(Value::as_str)
    {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn content_part_from_value(value: &Value) -> Option<ContentPart> {
    if let Some(text) = value.as_str() {
        return Some(ContentPart::Text {
            text: text.to_string(),
        });
    }
    let part_type = value.get("type").and_then(Value::as_str);
    match part_type {
        Some("text") | Some("markdown") => {
            extract_text_from_value(value).map(|text| ContentPart::Text { text })
        }
        Some("thinking") | Some("reasoning") => {
            extract_text_from_value(value).map(|text| ContentPart::Reasoning {
                text,
                visibility: ReasoningVisibility::Private,
            })
        }
        Some("image") => value
            .get("path")
            .or_else(|| value.get("url"))
            .and_then(|path| {
                path.as_str().map(|path| ContentPart::Image {
                    path: path.to_string(),
                    mime: value
                        .get("mime")
                        .or_else(|| value.get("mimeType"))
                        .and_then(Value::as_str)
                        .map(|mime| mime.to_string()),
                })
            }),
        Some("tool_call") | Some("toolcall") => {
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let arguments = value
                .get("arguments")
                .or_else(|| value.get("args"))
                .map(value_to_string)
                .unwrap_or_else(|| "{}".to_string());
            let call_id = value
                .get("call_id")
                .or_else(|| value.get("callId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Some(ContentPart::ToolCall {
                name,
                arguments,
                call_id,
            })
        }
        Some("tool_result") => {
            let call_id = value
                .get("call_id")
                .or_else(|| value.get("callId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let output = value
                .get("output")
                .or_else(|| value.get("content"))
                .map(value_to_string)
                .unwrap_or_default();
            Some(ContentPart::ToolResult { call_id, output })
        }
        _ => Some(ContentPart::Json {
            json: value.clone(),
        }),
    }
}

fn value_to_string(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        text.to_string()
    } else {
        value.to_string()
    }
}

fn delta_from_partial(previous: &str, next: &str) -> String {
    if next.starts_with(previous) {
        next[previous.len()..].to_string()
    } else {
        next.to_string()
    }
}
