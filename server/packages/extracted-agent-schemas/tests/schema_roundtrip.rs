use sandbox_agent_extracted_agent_schemas::{amp, claude, codex};

#[test]
fn test_claude_bash_input() {
    let input = claude::BashInput {
        command: "ls -la".to_string(),
        timeout: Some(5000.0),
        working_directory: None,
    };

    let json = serde_json::to_string(&input).unwrap();
    assert!(json.contains("ls -la"));

    let parsed: claude::BashInput = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.command, "ls -la");
}

#[test]
fn test_codex_server_notification() {
    let notification = codex::ServerNotification::ItemCompleted(codex::ItemCompletedNotification {
        item: codex::ThreadItem::AgentMessage {
            id: "msg-123".to_string(),
            text: "Hello from Codex".to_string(),
        },
        thread_id: "thread-123".to_string(),
        turn_id: "turn-456".to_string(),
    });

    let json = serde_json::to_string(&notification).unwrap();
    assert!(json.contains("item/completed"));
    assert!(json.contains("Hello from Codex"));
    assert!(json.contains("agentMessage"));
}

#[test]
fn test_codex_thread_item_variants() {
    let user_msg = codex::ThreadItem::UserMessage {
        content: vec![codex::UserInput::Text {
            text: "Hello".to_string(),
            text_elements: vec![],
        }],
        id: "user-1".to_string(),
    };
    let json = serde_json::to_string(&user_msg).unwrap();
    assert!(json.contains("userMessage"));
    assert!(json.contains("Hello"));

    let cmd = codex::ThreadItem::CommandExecution {
        aggregated_output: Some("output".to_string()),
        command: "ls -la".to_string(),
        command_actions: vec![],
        cwd: "/tmp".to_string(),
        duration_ms: Some(100),
        exit_code: Some(0),
        id: "cmd-1".to_string(),
        process_id: None,
        status: codex::CommandExecutionStatus::Completed,
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("commandExecution"));
    assert!(json.contains("ls -la"));
}

#[test]
fn test_amp_message() {
    let msg = amp::Message {
        role: amp::MessageRole::User,
        content: "Hello".to_string(),
        tool_calls: vec![],
    };

    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("user"));
    assert!(json.contains("Hello"));
}

#[test]
fn test_amp_stream_json_message_types() {
    // Test that all new message types can be parsed
    let system_msg = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"sess-1","tools":["Bash"],"mcp_servers":[]}"#;
    let parsed: amp::StreamJsonMessage = serde_json::from_str(system_msg).unwrap();
    assert!(matches!(parsed.type_, amp::StreamJsonMessageType::System));

    let user_msg = r#"{"type":"user","message":{"role":"user","content":"Hello"},"session_id":"sess-1"}"#;
    let parsed: amp::StreamJsonMessage = serde_json::from_str(user_msg).unwrap();
    assert!(matches!(parsed.type_, amp::StreamJsonMessageType::User));

    let assistant_msg = r#"{"type":"assistant","message":{"role":"assistant","content":"Hi there"},"session_id":"sess-1"}"#;
    let parsed: amp::StreamJsonMessage = serde_json::from_str(assistant_msg).unwrap();
    assert!(matches!(parsed.type_, amp::StreamJsonMessageType::Assistant));

    let result_msg = r#"{"type":"result","subtype":"success","duration_ms":1000,"is_error":false,"num_turns":1,"result":"Done","session_id":"sess-1"}"#;
    let parsed: amp::StreamJsonMessage = serde_json::from_str(result_msg).unwrap();
    assert!(matches!(parsed.type_, amp::StreamJsonMessageType::Result));

    // Test legacy types still work
    let message_msg = r#"{"type":"message","id":"msg-1","content":"Hello"}"#;
    let parsed: amp::StreamJsonMessage = serde_json::from_str(message_msg).unwrap();
    assert!(matches!(parsed.type_, amp::StreamJsonMessageType::Message));

    let done_msg = r#"{"type":"done"}"#;
    let parsed: amp::StreamJsonMessage = serde_json::from_str(done_msg).unwrap();
    assert!(matches!(parsed.type_, amp::StreamJsonMessageType::Done));
}
