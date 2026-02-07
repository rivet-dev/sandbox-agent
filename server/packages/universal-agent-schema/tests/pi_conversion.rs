use sandbox_agent_universal_agent_schema::convert_pi::PiEventConverter;
use sandbox_agent_universal_agent_schema::pi as pi_schema;
use sandbox_agent_universal_agent_schema::{
    ContentPart, ItemKind, ItemRole, ItemStatus, UniversalEventData, UniversalEventType,
};
use serde_json::json;

fn parse_event(value: serde_json::Value) -> pi_schema::RpcEvent {
    serde_json::from_value(value).expect("pi event")
}

#[test]
fn pi_message_flow_converts() {
    let mut converter = PiEventConverter::default();

    let start_event = parse_event(json!({
        "type": "message_start",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "Hello" }]
        }
    }));
    let start_events = converter
        .event_to_universal(&start_event)
        .expect("start conversions");
    assert_eq!(start_events[0].event_type, UniversalEventType::ItemStarted);
    if let UniversalEventData::Item(item) = &start_events[0].data {
        assert_eq!(item.item.kind, ItemKind::Message);
        assert_eq!(item.item.role, Some(ItemRole::Assistant));
        assert_eq!(item.item.status, ItemStatus::InProgress);
    } else {
        panic!("expected item event");
    }

    let update_event = parse_event(json!({
        "type": "message_update",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "assistantMessageEvent": { "type": "text_delta", "delta": " world" }
    }));
    let update_events = converter
        .event_to_universal(&update_event)
        .expect("update conversions");
    assert_eq!(update_events[0].event_type, UniversalEventType::ItemDelta);

    let end_event = parse_event(json!({
        "type": "message_end",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "Hello world" }]
        }
    }));
    let end_events = converter
        .event_to_universal(&end_event)
        .expect("end conversions");
    assert_eq!(end_events[0].event_type, UniversalEventType::ItemCompleted);
    if let UniversalEventData::Item(item) = &end_events[0].data {
        assert_eq!(item.item.kind, ItemKind::Message);
        assert_eq!(item.item.role, Some(ItemRole::Assistant));
        assert_eq!(item.item.status, ItemStatus::Completed);
    } else {
        panic!("expected item event");
    }
}

#[test]
fn pi_user_message_echo_is_skipped() {
    let mut converter = PiEventConverter::default();

    // Pi may echo the user message as a message_start with role "user".
    // The daemon already records synthetic user events, so the converter
    // must skip these to avoid a duplicate assistant-looking bubble.
    let start_event = parse_event(json!({
        "type": "message_start",
        "sessionId": "session-1",
        "messageId": "user-msg-1",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": "hello!" }]
        }
    }));
    let events = converter
        .event_to_universal(&start_event)
        .expect("user message_start should not error");
    assert!(
        events.is_empty(),
        "user message_start should produce no events, got {}",
        events.len()
    );

    let end_event = parse_event(json!({
        "type": "message_end",
        "sessionId": "session-1",
        "messageId": "user-msg-1",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": "hello!" }]
        }
    }));
    let events = converter
        .event_to_universal(&end_event)
        .expect("user message_end should not error");
    assert!(
        events.is_empty(),
        "user message_end should produce no events, got {}",
        events.len()
    );

    // A subsequent assistant message should still work normally.
    let assistant_start = parse_event(json!({
        "type": "message_start",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "Hello! How can I help?" }]
        }
    }));
    let events = converter
        .event_to_universal(&assistant_start)
        .expect("assistant message_start");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, UniversalEventType::ItemStarted);
    if let UniversalEventData::Item(item) = &events[0].data {
        assert_eq!(item.item.role, Some(ItemRole::Assistant));
    } else {
        panic!("expected item event");
    }
}

#[test]
fn pi_tool_execution_converts_with_partial_deltas() {
    let mut converter = PiEventConverter::default();

    let start_event = parse_event(json!({
        "type": "tool_execution_start",
        "sessionId": "session-1",
        "toolCallId": "call-1",
        "toolName": "bash",
        "args": { "command": "ls" }
    }));
    let start_events = converter
        .event_to_universal(&start_event)
        .expect("tool start");
    assert_eq!(start_events[0].event_type, UniversalEventType::ItemStarted);
    if let UniversalEventData::Item(item) = &start_events[0].data {
        assert_eq!(item.item.kind, ItemKind::ToolCall);
        assert_eq!(item.item.role, Some(ItemRole::Assistant));
        match &item.item.content[0] {
            ContentPart::ToolCall { name, .. } => assert_eq!(name, "bash"),
            _ => panic!("expected tool call content"),
        }
    }

    let update_event = parse_event(json!({
        "type": "tool_execution_update",
        "sessionId": "session-1",
        "toolCallId": "call-1",
        "partialResult": "foo"
    }));
    let update_events = converter
        .event_to_universal(&update_event)
        .expect("tool update");
    assert!(update_events
        .iter()
        .any(|event| event.event_type == UniversalEventType::ItemDelta));

    let update_event2 = parse_event(json!({
        "type": "tool_execution_update",
        "sessionId": "session-1",
        "toolCallId": "call-1",
        "partialResult": "foobar"
    }));
    let update_events2 = converter
        .event_to_universal(&update_event2)
        .expect("tool update 2");
    let delta = update_events2
        .iter()
        .find_map(|event| match &event.data {
            UniversalEventData::ItemDelta(data) => Some(data.delta.clone()),
            _ => None,
        })
        .unwrap_or_default();
    assert_eq!(delta, "bar");

    let end_event = parse_event(json!({
        "type": "tool_execution_end",
        "sessionId": "session-1",
        "toolCallId": "call-1",
        "result": { "type": "text", "content": "done" },
        "isError": false
    }));
    let end_events = converter.event_to_universal(&end_event).expect("tool end");
    assert_eq!(end_events[0].event_type, UniversalEventType::ItemCompleted);
    if let UniversalEventData::Item(item) = &end_events[0].data {
        assert_eq!(item.item.kind, ItemKind::ToolResult);
        assert_eq!(item.item.role, Some(ItemRole::Tool));
        match &item.item.content[0] {
            ContentPart::ToolResult { output, .. } => assert_eq!(output, "done"),
            _ => panic!("expected tool result content"),
        }
    }
}

#[test]
fn pi_unknown_event_returns_error() {
    let mut converter = PiEventConverter::default();
    let event = parse_event(json!({
        "type": "unknown_event",
        "sessionId": "session-1"
    }));
    assert!(converter.event_to_universal(&event).is_err());
}

#[test]
fn pi_turn_and_agent_end_emit_terminal_status_labels() {
    let mut converter = PiEventConverter::default();

    let turn_end = parse_event(json!({
        "type": "turn_end",
        "sessionId": "session-1"
    }));
    let turn_events = converter
        .event_to_universal(&turn_end)
        .expect("turn_end conversions");
    assert_eq!(turn_events[0].event_type, UniversalEventType::ItemCompleted);
    if let UniversalEventData::Item(item) = &turn_events[0].data {
        assert_eq!(item.item.kind, ItemKind::Status);
        assert!(
            matches!(
                item.item.content.first(),
                Some(ContentPart::Status { label, .. }) if label == "turn.completed"
            ),
            "turn_end should map to turn.completed status"
        );
    } else {
        panic!("expected item event");
    }

    let agent_end = parse_event(json!({
        "type": "agent_end",
        "sessionId": "session-1"
    }));
    let agent_events = converter
        .event_to_universal(&agent_end)
        .expect("agent_end conversions");
    assert_eq!(
        agent_events[0].event_type,
        UniversalEventType::ItemCompleted
    );
    if let UniversalEventData::Item(item) = &agent_events[0].data {
        assert_eq!(item.item.kind, ItemKind::Status);
        assert!(
            matches!(
                item.item.content.first(),
                Some(ContentPart::Status { label, .. }) if label == "session.idle"
            ),
            "agent_end should map to session.idle status"
        );
    } else {
        panic!("expected item event");
    }
}

#[test]
fn pi_message_done_completes_without_message_end() {
    let mut converter = PiEventConverter::default();

    let start_event = parse_event(json!({
        "type": "message_start",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "Hello" }]
        }
    }));
    let _start_events = converter
        .event_to_universal(&start_event)
        .expect("start conversions");

    let update_event = parse_event(json!({
        "type": "message_update",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "assistantMessageEvent": { "type": "text_delta", "delta": " world" }
    }));
    let _update_events = converter
        .event_to_universal(&update_event)
        .expect("update conversions");

    let done_event = parse_event(json!({
        "type": "message_update",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "assistantMessageEvent": { "type": "done" }
    }));
    let done_events = converter
        .event_to_universal(&done_event)
        .expect("done conversions");
    assert_eq!(done_events[0].event_type, UniversalEventType::ItemCompleted);
    if let UniversalEventData::Item(item) = &done_events[0].data {
        assert_eq!(item.item.status, ItemStatus::Completed);
        assert!(
            matches!(item.item.content.get(0), Some(ContentPart::Text { text }) if text == "Hello world")
        );
    } else {
        panic!("expected item event");
    }
}

#[test]
fn pi_message_done_then_message_end_does_not_double_complete() {
    let mut converter = PiEventConverter::default();

    let start_event = parse_event(json!({
        "type": "message_start",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "Hello" }]
        }
    }));
    let _ = converter
        .event_to_universal(&start_event)
        .expect("start conversions");

    let update_event = parse_event(json!({
        "type": "message_update",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "assistantMessageEvent": { "type": "text_delta", "delta": " world" }
    }));
    let _ = converter
        .event_to_universal(&update_event)
        .expect("update conversions");

    let done_event = parse_event(json!({
        "type": "message_update",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "assistantMessageEvent": { "type": "done" }
    }));
    let done_events = converter
        .event_to_universal(&done_event)
        .expect("done conversions");
    assert_eq!(done_events.len(), 1);
    assert_eq!(done_events[0].event_type, UniversalEventType::ItemCompleted);

    let end_event = parse_event(json!({
        "type": "message_end",
        "sessionId": "session-1",
        "messageId": "msg-1",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "Hello world" }]
        }
    }));
    let end_events = converter
        .event_to_universal(&end_event)
        .expect("end conversions");
    assert!(
        end_events.is_empty(),
        "message_end after done should not emit a second completion"
    );
}

#[test]
fn pi_message_end_error_surfaces_failed_status_and_error_text() {
    let mut converter = PiEventConverter::default();

    let start_event = parse_event(json!({
        "type": "message_start",
        "sessionId": "session-1",
        "messageId": "msg-err",
        "message": {
            "role": "assistant",
            "content": []
        }
    }));
    let _ = converter
        .event_to_universal(&start_event)
        .expect("start conversions");

    let end_raw = json!({
        "type": "message_end",
        "sessionId": "session-1",
        "messageId": "msg-err",
        "message": {
            "role": "assistant",
            "content": [],
            "stopReason": "error",
            "errorMessage": "Connection error."
        }
    });
    let end_events = converter
        .event_value_to_universal(&end_raw)
        .expect("end conversions");

    assert_eq!(end_events[0].event_type, UniversalEventType::ItemCompleted);
    if let UniversalEventData::Item(item) = &end_events[0].data {
        assert_eq!(item.item.status, ItemStatus::Failed);
        assert!(
            matches!(item.item.content.first(), Some(ContentPart::Text { text }) if text == "Connection error.")
        );
    } else {
        panic!("expected item event");
    }
}
