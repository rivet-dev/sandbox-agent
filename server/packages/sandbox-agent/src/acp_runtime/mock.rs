use sandbox_agent_error::SandboxError;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::sleep;

const MOCK_WORD_STREAM_DELAY_MS: u64 = 30;

#[derive(Debug)]
pub(super) struct MockBackend {
    session_counter: Mutex<u64>,
    permission_counter: Mutex<u64>,
    sessions: Mutex<HashSet<String>>,
    ended_sessions: Mutex<HashSet<String>>,
}

pub(super) fn new_mock_backend() -> MockBackend {
    MockBackend {
        session_counter: Mutex::new(0),
        permission_counter: Mutex::new(0),
        sessions: Mutex::new(HashSet::new()),
        ended_sessions: Mutex::new(HashSet::new()),
    }
}

pub(super) async fn handle_mock_payload<F, Fut>(
    mock: &MockBackend,
    payload: &Value,
    mut emit: F,
) -> Result<(), SandboxError>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    if let Some(method) = payload.get("method").and_then(Value::as_str) {
        let id = payload.get("id").cloned();
        let params = payload.get("params").cloned().unwrap_or(Value::Null);

        if let Some(id_value) = id {
            let response = mock_request(mock, &mut emit, id_value, method, params).await;
            emit(response).await;
            return Ok(());
        }

        mock_notification(&mut emit, method, params).await;
        return Ok(());
    }

    Ok(())
}

async fn mock_request<F, Fut>(
    mock: &MockBackend,
    emit: &mut F,
    id: Value,
    method: &str,
    params: Value,
) -> Value
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": params
                    .get("protocolVersion")
                    .cloned()
                    .unwrap_or(Value::String("1.0".to_string())),
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": {
                        "image": false,
                        "audio": false
                    },
                    "canSetMode": true,
                    "canSetModel": true,
                    "sessionCapabilities": {
                        "list": {}
                    }
                },
                "authMethods": []
            }
        }),
        "session/new" => {
            let mut counter = mock.session_counter.lock().await;
            *counter += 1;
            let session_id = format!("mock-session-{}", *counter);
            mock.sessions.lock().await.insert(session_id.clone());
            mock.ended_sessions.lock().await.remove(&session_id);
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "sessionId": session_id,
                    "availableModes": [],
                    "configOptions": []
                }
            })
        }
        "session/prompt" => {
            let known_session = {
                let sessions = mock.sessions.lock().await;
                sessions.iter().next().cloned()
            };
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or(known_session)
                .unwrap_or_else(|| "mock-session-1".to_string());
            mock.sessions.lock().await.insert(session_id.clone());
            if mock.ended_sessions.lock().await.contains(&session_id) {
                return json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32000,
                        "message": "session already ended"
                    }
                });
            }

            let prompt_text = extract_prompt_text(&params);
            let response_text = prompt_text
                .clone()
                .map(|text| {
                    if text.trim().is_empty() {
                        "OK".to_string()
                    } else {
                        format!("mock: {text}")
                    }
                })
                .unwrap_or_else(|| "OK".to_string());

            let requires_permission = prompt_text
                .as_deref()
                .map(|text| text.to_ascii_lowercase().contains("permission"))
                .unwrap_or(false);

            if requires_permission {
                let mut permission_counter = mock.permission_counter.lock().await;
                *permission_counter += 1;
                let permission_id = format!("mock-permission-{}", *permission_counter);

                emit(json!({
                    "jsonrpc": "2.0",
                    "id": permission_id,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": session_id,
                        "options": [
                            {
                                "id": "allow_once",
                                "name": "Allow once"
                            },
                            {
                                "id": "deny",
                                "name": "Deny"
                            }
                        ],
                        "toolCall": {
                            "toolCallId": "tool-call-1",
                            "kind": "execute",
                            "status": "pending",
                            "rawInput": {
                                "command": "echo test"
                            }
                        }
                    }
                }))
                .await;
            }

            let should_crash = prompt_text
                .as_deref()
                .map(|text| text.to_ascii_lowercase().contains("crash"))
                .unwrap_or(false);
            if should_crash {
                mock.ended_sessions.lock().await.insert(session_id.clone());
                emit(json!({
                    "jsonrpc": "2.0",
                    "method": "_sandboxagent/session/ended",
                    "params": {
                        "session_id": session_id,
                        "data": {
                            "reason": "error",
                            "terminated_by": "agent",
                            "message": "mock process crashed",
                            "exit_code": 1,
                            "stderr": {
                                "head": "mock stderr line 1\nmock stderr line 2",
                                "truncated": false,
                                "total_lines": 2
                            }
                        }
                    }
                }))
                .await;
                return json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32000,
                        "message": "mock process crashed"
                    }
                });
            }

            let word_chunks = split_text_into_word_chunks(&response_text);
            for (index, chunk) in word_chunks.iter().enumerate() {
                emit(json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {
                                "type": "text",
                                "text": chunk
                            }
                        }
                    }
                }))
                .await;

                if index + 1 < word_chunks.len() {
                    sleep(Duration::from_millis(MOCK_WORD_STREAM_DELAY_MS)).await;
                }
            }

            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "stopReason": "end_turn"
                }
            })
        }
        "session/list" => {
            let sessions = mock
                .sessions
                .lock()
                .await
                .iter()
                .cloned()
                .collect::<Vec<_>>();
            let sessions = sessions
                .into_iter()
                .map(|session_id| {
                    json!({
                        "sessionId": session_id,
                        "cwd": "/"
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "sessions": sessions,
                    "nextCursor": null
                }
            })
        }
        "session/fork" | "session/resume" | "session/load" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("mock-session-1")
                .to_string();
            mock.sessions.lock().await.insert(session_id.clone());
            mock.ended_sessions.lock().await.remove(&session_id);
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "sessionId": session_id,
                    "configOptions": [],
                    "availableModes": []
                }
            })
        }
        "session/set_mode" | "session/set_model" | "session/set_config_option" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "authenticate" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "$/cancel_request" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "_sandboxagent/session/terminate" => {
            let fallback_session = {
                let sessions = mock.sessions.lock().await;
                sessions.iter().next().cloned()
            };
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or(fallback_session)
                .unwrap_or_else(|| "mock-session-1".to_string());
            let exists = mock.sessions.lock().await.contains(&session_id);
            let mut ended_sessions = mock.ended_sessions.lock().await;
            let terminated = exists && ended_sessions.insert(session_id.clone());
            drop(ended_sessions);
            if terminated {
                emit(json!({
                    "jsonrpc": "2.0",
                    "method": "_sandboxagent/session/ended",
                    "params": {
                        "session_id": session_id,
                        "data": {
                            "reason": "terminated",
                            "terminated_by": "daemon"
                        }
                    }
                }))
                .await;
            }
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "terminated": terminated,
                    "alreadyEnded": !terminated,
                    "reason": "terminated",
                    "terminatedBy": "daemon"
                }
            })
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "_meta": {
                    "sandboxagent.dev": {
                        "mockMethod": method,
                        "echoParams": params
                    }
                }
            }
        }),
    }
}

async fn mock_notification<F, Fut>(emit: &mut F, method: &str, params: Value)
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    if method == "session/cancel" {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("mock-session-1");
        emit(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "cancelled"
                    }
                }
            }
        }))
        .await;
    }
}

fn split_text_into_word_chunks(text: &str) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return vec![text.to_string()];
    }

    let last = words.len() - 1;
    words
        .into_iter()
        .enumerate()
        .map(|(index, word)| {
            if index == last {
                word.to_string()
            } else {
                format!("{word} ")
            }
        })
        .collect()
}

fn extract_prompt_text(params: &Value) -> Option<String> {
    let prompt = params.get("prompt")?.as_array()?;
    let mut output = String::new();
    for block in prompt {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(text);
            }
        }
    }
    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}
