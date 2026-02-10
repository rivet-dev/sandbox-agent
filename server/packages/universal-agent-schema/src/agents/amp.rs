use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::amp as schema;
use crate::{
    turn_ended_event, ContentPart, ErrorData, EventConversion, ItemDeltaData, ItemEventData,
    ItemKind, ItemRole, ItemStatus, SessionEndReason, SessionEndedData, TerminatedBy,
    UniversalEventData, UniversalEventType, UniversalItem,
};

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

fn next_temp_id(prefix: &str) -> String {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{id}")
}

pub fn event_to_universal(
    event: &schema::StreamJsonMessage,
) -> Result<Vec<EventConversion>, String> {
    let mut events = Vec::new();
    match event.type_ {
        // System init message - contains metadata like cwd, tools, session_id
        // We skip this as it's not a user-facing event
        schema::StreamJsonMessageType::System => {}
        // User message - extract content from the nested message field
        schema::StreamJsonMessageType::User => {
            if !event.message.is_empty() {
                let text = event
                    .message
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let item = UniversalItem {
                    item_id: next_temp_id("tmp_amp_user"),
                    native_item_id: event.session_id.clone(),
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::User),
                    content: vec![ContentPart::Text { text: text.clone() }],
                    status: ItemStatus::Completed,
                };
                events.extend(message_events(item, text));
            }
        }
        // Assistant message - extract content from the nested message field
        schema::StreamJsonMessageType::Assistant => {
            if !event.message.is_empty() {
                let text = event
                    .message
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let item = UniversalItem {
                    item_id: next_temp_id("tmp_amp_assistant"),
                    native_item_id: event.session_id.clone(),
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::Assistant),
                    content: vec![ContentPart::Text { text: text.clone() }],
                    status: ItemStatus::Completed,
                };
                events.extend(message_events(item, text));
            }
        }
        // Result message - signals completion
        schema::StreamJsonMessageType::Result => {
            events.push(turn_ended_event(None, None).synthetic());
            events.push(
                EventConversion::new(
                    UniversalEventType::SessionEnded,
                    UniversalEventData::SessionEnded(SessionEndedData {
                        reason: if event.is_error.unwrap_or(false) {
                            SessionEndReason::Error
                        } else {
                            SessionEndReason::Completed
                        },
                        terminated_by: TerminatedBy::Agent,
                        message: event.result.clone(),
                        exit_code: None,
                        stderr: None,
                    }),
                )
                .with_raw(serde_json::to_value(event).ok()),
            );
        }
        schema::StreamJsonMessageType::Message => {
            let text = event.content.clone().unwrap_or_default();
            let item = UniversalItem {
                item_id: next_temp_id("tmp_amp_message"),
                native_item_id: event.id.clone(),
                parent_id: None,
                kind: ItemKind::Message,
                role: Some(ItemRole::Assistant),
                content: vec![ContentPart::Text { text: text.clone() }],
                status: ItemStatus::Completed,
            };
            events.extend(message_events(item, text));
        }
        schema::StreamJsonMessageType::ToolCall => {
            let tool_call = event.tool_call.clone();
            let (name, arguments, call_id) = if let Some(call) = tool_call {
                let arguments = match call.arguments {
                    schema::ToolCallArguments::Variant0(text) => text,
                    schema::ToolCallArguments::Variant1(map) => {
                        serde_json::to_string(&Value::Object(map))
                            .unwrap_or_else(|_| "{}".to_string())
                    }
                };
                (call.name, arguments, call.id)
            } else {
                (
                    "unknown".to_string(),
                    "{}".to_string(),
                    next_temp_id("tmp_amp_tool"),
                )
            };
            let item = UniversalItem {
                item_id: next_temp_id("tmp_amp_tool_call"),
                native_item_id: Some(call_id.clone()),
                parent_id: None,
                kind: ItemKind::ToolCall,
                role: Some(ItemRole::Assistant),
                content: vec![ContentPart::ToolCall {
                    name,
                    arguments,
                    call_id,
                }],
                status: ItemStatus::Completed,
            };
            events.extend(item_events(item));
        }
        schema::StreamJsonMessageType::ToolResult => {
            let output = event.content.clone().unwrap_or_default();
            let call_id = event
                .id
                .clone()
                .unwrap_or_else(|| next_temp_id("tmp_amp_tool"));
            let item = UniversalItem {
                item_id: next_temp_id("tmp_amp_tool_result"),
                native_item_id: Some(call_id.clone()),
                parent_id: None,
                kind: ItemKind::ToolResult,
                role: Some(ItemRole::Tool),
                content: vec![ContentPart::ToolResult { call_id, output }],
                status: ItemStatus::Completed,
            };
            events.extend(item_events(item));
        }
        schema::StreamJsonMessageType::Error => {
            let message = event
                .error
                .clone()
                .unwrap_or_else(|| "amp error".to_string());
            events.push(EventConversion::new(
                UniversalEventType::Error,
                UniversalEventData::Error(ErrorData {
                    message,
                    code: Some("amp".to_string()),
                    details: serde_json::to_value(event).ok(),
                }),
            ));
        }
        schema::StreamJsonMessageType::Done => {
            events.push(turn_ended_event(None, None).synthetic());
            events.push(
                EventConversion::new(
                    UniversalEventType::SessionEnded,
                    UniversalEventData::SessionEnded(SessionEndedData {
                        reason: SessionEndReason::Completed,
                        terminated_by: TerminatedBy::Agent,
                        message: None,
                        exit_code: None,
                        stderr: None,
                    }),
                )
                .with_raw(serde_json::to_value(event).ok()),
            );
        }
    }

    for conversion in &mut events {
        conversion.raw = serde_json::to_value(event).ok();
    }
    Ok(events)
}

fn item_events(item: UniversalItem) -> Vec<EventConversion> {
    vec![EventConversion::new(
        UniversalEventType::ItemCompleted,
        UniversalEventData::Item(ItemEventData { item }),
    )]
}

fn message_events(item: UniversalItem, delta: String) -> Vec<EventConversion> {
    let mut events = Vec::new();
    let mut started = item.clone();
    started.status = ItemStatus::InProgress;
    events.push(
        EventConversion::new(
            UniversalEventType::ItemStarted,
            UniversalEventData::Item(ItemEventData { item: started }),
        )
        .synthetic(),
    );
    if !delta.is_empty() {
        events.push(
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: item.item_id.clone(),
                    native_item_id: item.native_item_id.clone(),
                    delta,
                }),
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
