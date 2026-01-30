//! Terminal WebSocket handler for interactive PTY sessions.
//!
//! Provides bidirectional terminal I/O over WebSocket connections.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast;

use crate::process_manager::{ProcessManager, TerminalMessage};
use sandbox_agent_error::SandboxError;

/// WebSocket upgrade handler for terminal connections
pub async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(process_manager): State<Arc<ProcessManager>>,
) -> Result<Response, SandboxError> {
    // Verify the process exists and has PTY
    let info = process_manager.get_process(&id).await?;
    if !info.tty {
        return Err(SandboxError::InvalidRequest {
            message: "Process does not have a PTY allocated. Start with tty: true".to_string(),
        });
    }
    
    // Check if process is still running
    if info.exit_code.is_some() {
        return Err(SandboxError::InvalidRequest {
            message: "Process has already exited".to_string(),
        });
    }
    
    Ok(ws.on_upgrade(move |socket| handle_terminal_socket(socket, id, process_manager)))
}

/// Handle the WebSocket connection for terminal I/O
async fn handle_terminal_socket(
    socket: WebSocket,
    process_id: String,
    process_manager: Arc<ProcessManager>,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    
    // Get terminal output subscription and input sender
    let output_rx = match process_manager.subscribe_terminal_output(&process_id).await {
        Ok(rx) => rx,
        Err(e) => {
            let msg = TerminalMessage::Error {
                message: format!("Failed to subscribe to terminal output: {}", e),
            };
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap()))
                .await;
            return;
        }
    };
    
    let input_tx = match process_manager.get_terminal_input_sender(&process_id).await {
        Ok(tx) => tx,
        Err(e) => {
            let msg = TerminalMessage::Error {
                message: format!("Failed to get terminal input channel: {}", e),
            };
            let _ = ws_sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap()))
                .await;
            return;
        }
    };
    
    // Task to forward terminal output to WebSocket
    let process_manager_clone = process_manager.clone();
    let process_id_clone = process_id.clone();
    let output_task = tokio::spawn(async move {
        forward_output_to_ws(output_rx, ws_sender, process_manager_clone, process_id_clone).await;
    });
    
    // Handle input from WebSocket
    let process_manager_clone = process_manager.clone();
    let process_id_clone = process_id.clone();
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(terminal_msg) = serde_json::from_str::<TerminalMessage>(&text) {
                    match terminal_msg {
                        TerminalMessage::Input { data } => {
                            // Send input to terminal
                            if input_tx.send(data.into_bytes()).is_err() {
                                break;
                            }
                        }
                        TerminalMessage::Resize { cols, rows } => {
                            // Resize terminal
                            if let Err(e) = process_manager_clone
                                .resize_terminal(&process_id_clone, cols, rows)
                                .await
                            {
                                tracing::warn!("Failed to resize terminal: {}", e);
                            }
                        }
                        _ => {
                            // Ignore other message types from client
                        }
                    }
                }
            }
            Ok(Message::Binary(data)) => {
                // Binary data is treated as raw terminal input
                if input_tx.send(data).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => {
                break;
            }
            Err(_) => {
                break;
            }
            _ => {}
        }
    }
    
    // Cancel output task
    output_task.abort();
}

/// Forward terminal output to WebSocket
async fn forward_output_to_ws(
    mut output_rx: broadcast::Receiver<Vec<u8>>,
    mut ws_sender: futures::stream::SplitSink<WebSocket, Message>,
    process_manager: Arc<ProcessManager>,
    process_id: String,
) {
    loop {
        tokio::select! {
            result = output_rx.recv() => {
                match result {
                    Ok(data) => {
                        // Try to convert to UTF-8, otherwise send as binary
                        match String::from_utf8(data.clone()) {
                            Ok(text) => {
                                let msg = TerminalMessage::Data { data: text };
                                if ws_sender
                                    .send(Message::Text(serde_json::to_string(&msg).unwrap()))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(_) => {
                                // Send as binary for non-UTF8 data
                                if ws_sender.send(Message::Binary(data)).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // Channel closed, process likely exited
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Missed some messages, continue
                        continue;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                // Check if process is still running
                if let Ok(info) = process_manager.get_process(&process_id).await {
                    if info.exit_code.is_some() {
                        // Send exit message
                        let msg = TerminalMessage::Exit { code: info.exit_code };
                        let _ = ws_sender
                            .send(Message::Text(serde_json::to_string(&msg).unwrap()))
                            .await;
                        break;
                    }
                } else {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_terminal_message_serialization() {
        let msg = TerminalMessage::Data {
            data: "hello".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"data\""));
        assert!(json.contains("\"data\":\"hello\""));
        
        let msg = TerminalMessage::Resize { cols: 80, rows: 24 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"resize\""));
        assert!(json.contains("\"cols\":80"));
        assert!(json.contains("\"rows\":24"));
    }
}
