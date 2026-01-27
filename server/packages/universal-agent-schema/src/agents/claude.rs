use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::{
    ContentPart,
    EventConversion,
    ItemEventData,
    ItemKind,
    ItemRole,
    ItemStatus,
    QuestionEventData,
    QuestionStatus,
    SessionStartedData,
    UniversalEventData,
    UniversalEventType,
    UniversalItem,
};

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

fn next_temp_id(prefix: &str) -> String {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{id}")
}

pub fn event_to_universal_with_session(
    event: &Value,
    session_id: String,
) -> Result<Vec<EventConversion>, String> {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let mut conversions = match event_type {
        "system" => vec![system_event_to_universal(event)],
        "assistant" => assistant_event_to_universal(event, &session_id),
        "tool_use" => tool_use_event_to_universal(event, &session_id),
        "tool_result" => tool_result_event_to_universal(event),
        "result" => result_event_to_universal(event, &session_id),
        _ => return Err(format!("unsupported Claude event type: {event_type}")),
    };

    for conversion in &mut conversions {
        conversion.raw = Some(event.clone());
    }

    Ok(conversions)
}

fn system_event_to_universal(event: &Value) -> EventConversion {
    let data = SessionStartedData {
        metadata: Some(event.clone()),
    };
    EventConversion::new(UniversalEventType::SessionStarted, UniversalEventData::SessionStarted(data))
        .with_raw(Some(event.clone()))
}

fn assistant_event_to_universal(event: &Value, session_id: &str) -> Vec<EventConversion> {
    let mut conversions = Vec::new();
    let content = event
        .get("message")
        .and_then(|msg| msg.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Use session-based native_item_id so `result` event can reference the same item
    let native_message_id = format!("{session_id}_message");
    let mut message_parts = Vec::new();

    for block in content {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        match block_type {
            "text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    message_parts.push(ContentPart::Text {
                        text: text.to_string(),
                    });
                }
            }
            "tool_use" => {
                if let Some(name) = block.get("name").and_then(Value::as_str) {
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| next_temp_id("tmp_claude_tool"));
                    let arguments = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
                    let tool_item = UniversalItem {
                        item_id: String::new(),
                        native_item_id: Some(call_id.clone()),
                        parent_id: Some(native_message_id.clone()),
                        kind: ItemKind::ToolCall,
                        role: Some(ItemRole::Assistant),
                        content: vec![ContentPart::ToolCall {
                            name: name.to_string(),
                            arguments,
                            call_id,
                        }],
                        status: ItemStatus::Completed,
                    };
                    conversions.extend(item_events(tool_item, true));
                }
            }
            _ => {
                message_parts.push(ContentPart::Json { json: block });
            }
        }
    }

    // `assistant` event emits item.started + item.delta only (in-progress state)
    // The `result` event will emit item.completed to finalize
    let message_item = UniversalItem {
        item_id: String::new(),
        native_item_id: Some(native_message_id.clone()),
        parent_id: None,
        kind: ItemKind::Message,
        role: Some(ItemRole::Assistant),
        content: message_parts.clone(),
        status: ItemStatus::InProgress,
    };

    conversions.extend(message_started_events(message_item, message_parts));
    conversions
}

fn tool_use_event_to_universal(event: &Value, session_id: &str) -> Vec<EventConversion> {
    let mut conversions = Vec::new();
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
        .map(|s| s.to_string())
        .unwrap_or_else(|| next_temp_id("tmp_claude_tool"));

    let is_question_tool = matches!(
        name,
        "AskUserQuestion" | "ask_user_question" | "askUserQuestion" | "ask-user-question"
    );
    let has_question_payload = input.get("questions").is_some();
    if is_question_tool || has_question_payload {
        if let Some(question) = question_from_claude_input(&input, id.clone()) {
            conversions.push(
                EventConversion::new(
                    UniversalEventType::QuestionRequested,
                    UniversalEventData::Question(question),
                )
                .with_raw(Some(event.clone())),
            );
        }
    }

    let arguments = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
    let tool_item = UniversalItem {
        item_id: String::new(),
        native_item_id: Some(id.clone()),
        parent_id: None,
        kind: ItemKind::ToolCall,
        role: Some(ItemRole::Assistant),
        content: vec![ContentPart::ToolCall {
            name: name.to_string(),
            arguments,
            call_id: id,
        }],
        status: ItemStatus::Completed,
    };
    conversions.extend(item_events(tool_item, true));

    if conversions.is_empty() {
        let data = QuestionEventData {
            question_id: next_temp_id("tmp_claude_question"),
            prompt: "".to_string(),
            options: Vec::new(),
            response: None,
            status: QuestionStatus::Requested,
        };
        conversions.push(
            EventConversion::new(
                UniversalEventType::QuestionRequested,
                UniversalEventData::Question(data),
            )
            .with_raw(Some(Value::String(format!(
                "unexpected question payload for session {session_id}"
            )))),
        );
    }

    conversions
}

fn tool_result_event_to_universal(event: &Value) -> Vec<EventConversion> {
    let mut conversions = Vec::new();
    let tool_result = event.get("tool_result");
    let output = tool_result
        .and_then(|tool| tool.get("content"))
        .cloned()
        .unwrap_or(Value::Null);
    let id = tool_result
        .and_then(|tool| tool.get("id"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| next_temp_id("tmp_claude_tool"));
    let output_text = serde_json::to_string(&output).unwrap_or_else(|_| "".to_string());

    let tool_item = UniversalItem {
        item_id: next_temp_id("tmp_claude_tool_result"),
        native_item_id: Some(id.clone()),
        parent_id: None,
        kind: ItemKind::ToolResult,
        role: Some(ItemRole::Tool),
        content: vec![ContentPart::ToolResult {
            call_id: id,
            output: output_text,
        }],
        status: ItemStatus::Completed,
    };
    conversions.extend(item_events(tool_item, true));
    conversions
}

fn result_event_to_universal(event: &Value, session_id: &str) -> Vec<EventConversion> {
    // The `result` event completes the message started by `assistant`.
    // Use the same native_item_id so they link to the same universal item.
    let native_message_id = format!("{session_id}_message");
    let result_text = event
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let message_item = UniversalItem {
        item_id: String::new(),
        native_item_id: Some(native_message_id),
        parent_id: None,
        kind: ItemKind::Message,
        role: Some(ItemRole::Assistant),
        content: vec![ContentPart::Text { text: result_text }],
        status: ItemStatus::Completed,
    };

    vec![EventConversion::new(
        UniversalEventType::ItemCompleted,
        UniversalEventData::Item(ItemEventData { item: message_item }),
    )]
}

fn item_events(item: UniversalItem, synthetic_start: bool) -> Vec<EventConversion> {
    let mut events = Vec::new();
    if synthetic_start {
        let mut started_item = item.clone();
        started_item.status = ItemStatus::InProgress;
        events.push(
            EventConversion::new(
                UniversalEventType::ItemStarted,
                UniversalEventData::Item(ItemEventData { item: started_item }),
            )
            .synthetic(),
        );
    }
    events.push(EventConversion::new(
        UniversalEventType::ItemCompleted,
        UniversalEventData::Item(ItemEventData { item }),
    ));
    events
}

/// Emits item.started + item.delta only (for `assistant` event).
/// The item.completed will come from the `result` event.
fn message_started_events(item: UniversalItem, parts: Vec<ContentPart>) -> Vec<EventConversion> {
    let mut events = Vec::new();

    // Emit item.started (in-progress)
    events.push(EventConversion::new(
        UniversalEventType::ItemStarted,
        UniversalEventData::Item(ItemEventData { item: item.clone() }),
    ));

    // Emit item.delta with the text content
    let mut delta_text = String::new();
    for part in &parts {
        if let ContentPart::Text { text } = part {
            delta_text.push_str(text);
        }
    }
    if !delta_text.is_empty() {
        events.push(EventConversion::new(
            UniversalEventType::ItemDelta,
            UniversalEventData::ItemDelta(crate::ItemDeltaData {
                item_id: item.item_id.clone(),
                native_item_id: item.native_item_id.clone(),
                delta: delta_text,
            }),
        ));
    }

    events
}

fn question_from_claude_input(input: &Value, tool_id: String) -> Option<QuestionEventData> {
    if let Some(questions) = input.get("questions").and_then(Value::as_array) {
        if let Some(first) = questions.first() {
            let prompt = first.get("question")?.as_str()?.to_string();
            let options = first
                .get("options")
                .and_then(Value::as_array)
                .map(|opts| {
                    opts.iter()
                        .filter_map(|opt| opt.get("label").and_then(Value::as_str))
                        .map(|label| label.to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            return Some(QuestionEventData {
                question_id: tool_id,
                prompt,
                options,
                response: None,
                status: QuestionStatus::Requested,
            });
        }
    }

    let prompt = input
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if prompt.is_empty() {
        return None;
    }
    Some(QuestionEventData {
        question_id: tool_id,
        prompt,
        options: input
            .get("options")
            .and_then(Value::as_array)
            .map(|opts| {
                opts.iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        response: None,
        status: QuestionStatus::Requested,
    })
}
