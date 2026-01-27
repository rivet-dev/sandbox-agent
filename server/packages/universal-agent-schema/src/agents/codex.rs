use serde_json::Value;

use crate::codex as schema;
use crate::{
    ContentPart,
    ErrorData,
    EventConversion,
    ItemDeltaData,
    ItemEventData,
    ItemKind,
    ItemRole,
    ItemStatus,
    ReasoningVisibility,
    SessionEndedData,
    SessionEndReason,
    SessionStartedData,
    TerminatedBy,
    UniversalEventData,
    UniversalEventType,
    UniversalItem,
};

/// Convert a Codex ServerNotification to universal events.
pub fn notification_to_universal(
    notification: &schema::ServerNotification,
) -> Result<Vec<EventConversion>, String> {
    let raw = serde_json::to_value(notification).ok();
    match notification {
        schema::ServerNotification::ThreadStarted(params) => {
            let data = SessionStartedData {
                metadata: serde_json::to_value(&params.thread).ok(),
            };
            Ok(vec![
                EventConversion::new(
                    UniversalEventType::SessionStarted,
                    UniversalEventData::SessionStarted(data),
                )
                .with_native_session(Some(params.thread.id.clone()))
                .with_raw(raw),
            ])
        }
        schema::ServerNotification::ThreadCompacted(params) => Ok(vec![status_event(
            "thread.compacted",
            serde_json::to_string(params).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::ThreadTokenUsageUpdated(params) => Ok(vec![status_event(
            "thread.token_usage.updated",
            serde_json::to_string(params).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::TurnStarted(params) => Ok(vec![status_event(
            "turn.started",
            serde_json::to_string(&params.turn).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::TurnCompleted(params) => Ok(vec![status_event(
            "turn.completed",
            serde_json::to_string(&params.turn).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::TurnDiffUpdated(params) => Ok(vec![status_event(
            "turn.diff.updated",
            serde_json::to_string(params).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::TurnPlanUpdated(params) => Ok(vec![status_event(
            "turn.plan.updated",
            serde_json::to_string(params).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::ItemStarted(params) => {
            let item = thread_item_to_item(&params.item, ItemStatus::InProgress);
            Ok(vec![
                EventConversion::new(
                    UniversalEventType::ItemStarted,
                    UniversalEventData::Item(ItemEventData { item }),
                )
                .with_native_session(Some(params.thread_id.clone()))
                .with_raw(raw),
            ])
        }
        schema::ServerNotification::ItemCompleted(params) => {
            let item = thread_item_to_item(&params.item, ItemStatus::Completed);
            Ok(vec![
                EventConversion::new(
                    UniversalEventType::ItemCompleted,
                    UniversalEventData::Item(ItemEventData { item }),
                )
                .with_native_session(Some(params.thread_id.clone()))
                .with_raw(raw),
            ])
        }
        schema::ServerNotification::ItemAgentMessageDelta(params) => Ok(vec![
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: String::new(),
                    native_item_id: Some(params.item_id.clone()),
                    delta: params.delta.clone(),
                }),
            )
            .with_native_session(Some(params.thread_id.clone()))
            .with_raw(raw),
        ]),
        schema::ServerNotification::ItemReasoningTextDelta(params) => Ok(vec![
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: String::new(),
                    native_item_id: Some(params.item_id.clone()),
                    delta: params.delta.clone(),
                }),
            )
            .with_native_session(Some(params.thread_id.clone()))
            .with_raw(raw),
        ]),
        schema::ServerNotification::ItemReasoningSummaryTextDelta(params) => Ok(vec![
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: String::new(),
                    native_item_id: Some(params.item_id.clone()),
                    delta: params.delta.clone(),
                }),
            )
            .with_native_session(Some(params.thread_id.clone()))
            .with_raw(raw),
        ]),
        schema::ServerNotification::ItemCommandExecutionOutputDelta(params) => Ok(vec![
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: String::new(),
                    native_item_id: Some(params.item_id.clone()),
                    delta: params.delta.clone(),
                }),
            )
            .with_native_session(Some(params.thread_id.clone()))
            .with_raw(raw),
        ]),
        schema::ServerNotification::ItemFileChangeOutputDelta(params) => Ok(vec![
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: String::new(),
                    native_item_id: Some(params.item_id.clone()),
                    delta: params.delta.clone(),
                }),
            )
            .with_native_session(Some(params.thread_id.clone()))
            .with_raw(raw),
        ]),
        schema::ServerNotification::ItemCommandExecutionTerminalInteraction(params) => Ok(vec![
            EventConversion::new(
                UniversalEventType::ItemDelta,
                UniversalEventData::ItemDelta(ItemDeltaData {
                    item_id: String::new(),
                    native_item_id: Some(params.item_id.clone()),
                    delta: params.stdin.clone(),
                }),
            )
            .with_native_session(Some(params.thread_id.clone()))
            .with_raw(raw),
        ]),
        schema::ServerNotification::ItemMcpToolCallProgress(params) => Ok(vec![status_event(
            "mcp.progress",
            serde_json::to_string(params).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::ItemReasoningSummaryPartAdded(params) => Ok(vec![
            status_event(
                "reasoning.summary.part_added",
                serde_json::to_string(params).ok(),
                Some(params.thread_id.clone()),
                raw,
            ),
        ]),
        schema::ServerNotification::Error(params) => {
            let data = ErrorData {
                message: params.error.message.clone(),
                code: None,
                details: serde_json::to_value(params).ok(),
            };
            Ok(vec![
                EventConversion::new(UniversalEventType::Error, UniversalEventData::Error(data))
                    .with_native_session(Some(params.thread_id.clone()))
                    .with_raw(raw),
            ])
        }
        schema::ServerNotification::RawResponseItemCompleted(params) => Ok(vec![status_event(
            "raw.item.completed",
            serde_json::to_string(params).ok(),
            Some(params.thread_id.clone()),
            raw,
        )]),
        schema::ServerNotification::AccountUpdated(_)
        | schema::ServerNotification::AccountRateLimitsUpdated(_)
        | schema::ServerNotification::AccountLoginCompleted(_)
        | schema::ServerNotification::McpServerOauthLoginCompleted(_)
        | schema::ServerNotification::AuthStatusChange(_)
        | schema::ServerNotification::LoginChatGptComplete(_)
        | schema::ServerNotification::SessionConfigured(_)
        | schema::ServerNotification::DeprecationNotice(_)
        | schema::ServerNotification::ConfigWarning(_)
        | schema::ServerNotification::WindowsWorldWritableWarning(_) => Ok(vec![status_event(
            "notice",
            serde_json::to_string(notification).ok(),
            None,
            raw,
        )]),
    }
}

fn thread_item_to_item(item: &schema::ThreadItem, status: ItemStatus) -> UniversalItem {
    match item {
        schema::ThreadItem::UserMessage { content, id } => UniversalItem {
            item_id: String::new(),
            native_item_id: Some(id.clone()),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::User),
            content: content.iter().map(user_input_to_content).collect(),
            status,
        },
        schema::ThreadItem::AgentMessage { id, text } => UniversalItem {
            item_id: String::new(),
            native_item_id: Some(id.clone()),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::Assistant),
            content: vec![ContentPart::Text { text: text.clone() }],
            status,
        },
        schema::ThreadItem::Reasoning { content, id, summary } => {
            let mut parts = Vec::new();
            for line in content {
                parts.push(ContentPart::Reasoning {
                    text: line.clone(),
                    visibility: ReasoningVisibility::Private,
                });
            }
            for line in summary {
                parts.push(ContentPart::Reasoning {
                    text: line.clone(),
                    visibility: ReasoningVisibility::Public,
                });
            }
            UniversalItem {
                item_id: String::new(),
                native_item_id: Some(id.clone()),
                parent_id: None,
                kind: ItemKind::Message,
                role: Some(ItemRole::Assistant),
                content: parts,
                status,
            }
        }
        schema::ThreadItem::CommandExecution {
            aggregated_output,
            command,
            cwd,
            id,
            status: exec_status,
            ..
        } => {
            let mut parts = Vec::new();
            if let Some(output) = aggregated_output {
                parts.push(ContentPart::ToolResult {
                    call_id: id.clone(),
                    output: output.clone(),
                });
            }
            parts.push(ContentPart::Json {
                json: serde_json::json!({
                    "command": command,
                    "cwd": cwd,
                    "status": format!("{:?}", exec_status)
                }),
            });
            UniversalItem {
                item_id: String::new(),
                native_item_id: Some(id.clone()),
                parent_id: None,
                kind: ItemKind::ToolResult,
                role: Some(ItemRole::Tool),
                content: parts,
                status,
            }
        }
        schema::ThreadItem::FileChange { changes, id, status: file_status } => UniversalItem {
            item_id: String::new(),
            native_item_id: Some(id.clone()),
            parent_id: None,
            kind: ItemKind::ToolResult,
            role: Some(ItemRole::Tool),
            content: vec![ContentPart::Json {
                json: serde_json::json!({
                    "changes": changes,
                    "status": format!("{:?}", file_status)
                }),
            }],
            status,
        },
        schema::ThreadItem::McpToolCall {
            arguments,
            error,
            id,
            result,
            server,
            status: tool_status,
            tool,
            ..
        } => {
            let mut parts = Vec::new();
            if matches!(tool_status, schema::McpToolCallStatus::Completed) {
                let output = result
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok())
                    .unwrap_or_else(|| "".to_string());
                parts.push(ContentPart::ToolResult {
                    call_id: id.clone(),
                    output,
                });
            } else if matches!(tool_status, schema::McpToolCallStatus::Failed) {
                let output = error
                    .as_ref()
                    .map(|value| value.message.clone())
                    .unwrap_or_else(|| "".to_string());
                parts.push(ContentPart::ToolResult {
                    call_id: id.clone(),
                    output,
                });
            } else {
                let arguments = serde_json::to_string(arguments).unwrap_or_else(|_| "{}".to_string());
                parts.push(ContentPart::ToolCall {
                    name: format!("{server}.{tool}"),
                    arguments,
                    call_id: id.clone(),
                });
            }
            let kind = if matches!(tool_status, schema::McpToolCallStatus::Completed)
                || matches!(tool_status, schema::McpToolCallStatus::Failed)
            {
                ItemKind::ToolResult
            } else {
                ItemKind::ToolCall
            };
            let role = if kind == ItemKind::ToolResult {
                ItemRole::Tool
            } else {
                ItemRole::Assistant
            };
            UniversalItem {
                item_id: String::new(),
                native_item_id: Some(id.clone()),
                parent_id: None,
                kind,
                role: Some(role),
                content: parts,
                status,
            }
        }
        schema::ThreadItem::CollabAgentToolCall {
            id,
            prompt,
            tool,
            status: tool_status,
            ..
        } => {
            let mut parts = Vec::new();
            if matches!(tool_status, schema::CollabAgentToolCallStatus::Completed) {
                parts.push(ContentPart::ToolResult {
                    call_id: id.clone(),
                    output: prompt.clone().unwrap_or_default(),
                });
            } else {
                parts.push(ContentPart::ToolCall {
                    name: tool.to_string(),
                    arguments: prompt.clone().unwrap_or_default(),
                    call_id: id.clone(),
                });
            }
            let kind = if matches!(tool_status, schema::CollabAgentToolCallStatus::Completed) {
                ItemKind::ToolResult
            } else {
                ItemKind::ToolCall
            };
            let role = if kind == ItemKind::ToolResult {
                ItemRole::Tool
            } else {
                ItemRole::Assistant
            };
            UniversalItem {
                item_id: String::new(),
                native_item_id: Some(id.clone()),
                parent_id: None,
                kind,
                role: Some(role),
                content: parts,
                status,
            }
        }
        schema::ThreadItem::WebSearch { id, query } => UniversalItem {
            item_id: String::new(),
            native_item_id: Some(id.clone()),
            parent_id: None,
            kind: ItemKind::ToolCall,
            role: Some(ItemRole::Assistant),
            content: vec![ContentPart::ToolCall {
                name: "web_search".to_string(),
                arguments: query.clone(),
                call_id: id.clone(),
            }],
            status,
        },
        schema::ThreadItem::ImageView { id, path } => UniversalItem {
            item_id: String::new(),
            native_item_id: Some(id.clone()),
            parent_id: None,
            kind: ItemKind::Message,
            role: Some(ItemRole::Assistant),
            content: vec![ContentPart::Image {
                path: path.clone(),
                mime: None,
            }],
            status,
        },
        schema::ThreadItem::EnteredReviewMode { id, review } => status_item_internal(
            id,
            "review.entered",
            Some(review.clone()),
            status,
        ),
        schema::ThreadItem::ExitedReviewMode { id, review } => status_item_internal(
            id,
            "review.exited",
            Some(review.clone()),
            status,
        ),
    }
}

fn status_item(label: &str, detail: Option<String>) -> UniversalItem {
    UniversalItem {
        item_id: String::new(),
        native_item_id: None,
        parent_id: None,
        kind: ItemKind::Status,
        role: Some(ItemRole::System),
        content: vec![ContentPart::Status {
            label: label.to_string(),
            detail,
        }],
        status: ItemStatus::Completed,
    }
}

fn status_item_internal(id: &str, label: &str, detail: Option<String>, status: ItemStatus) -> UniversalItem {
    UniversalItem {
        item_id: String::new(),
        native_item_id: Some(id.to_string()),
        parent_id: None,
        kind: ItemKind::Status,
        role: Some(ItemRole::System),
        content: vec![ContentPart::Status {
            label: label.to_string(),
            detail,
        }],
        status,
    }
}

fn status_event(
    label: &str,
    detail: Option<String>,
    session_id: Option<String>,
    raw: Option<Value>,
) -> EventConversion {
    EventConversion::new(
        UniversalEventType::ItemCompleted,
        UniversalEventData::Item(ItemEventData {
            item: status_item(label, detail),
        }),
    )
    .with_native_session(session_id)
    .with_raw(raw)
}

fn user_input_to_content(input: &schema::UserInput) -> ContentPart {
    match input {
        schema::UserInput::Text { text, .. } => ContentPart::Text { text: text.clone() },
        schema::UserInput::Image { image_url } => ContentPart::Image {
            path: image_url.clone(),
            mime: None,
        },
        schema::UserInput::LocalImage { path } => ContentPart::Image {
            path: path.clone(),
            mime: None,
        },
        schema::UserInput::Skill { name, path } => ContentPart::Json {
            json: serde_json::json!({
                "type": "skill",
                "name": name,
                "path": path,
            }),
        },
    }
}

pub fn session_ended_event(thread_id: &str, reason: SessionEndReason) -> EventConversion {
    EventConversion::new(
        UniversalEventType::SessionEnded,
        UniversalEventData::SessionEnded(SessionEndedData {
            reason,
            terminated_by: TerminatedBy::Agent,
        }),
    )
    .with_native_session(Some(thread_id.to_string()))
}
