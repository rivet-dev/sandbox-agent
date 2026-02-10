use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::Utc;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, Duration};

use crate::acp_runtime::{AcpRuntime, PostKind};
use crate::router::{
    AgentModelInfo, AgentModelsResponse, CreateSessionRequest, PermissionReply, SessionInfo,
};
use crate::universal_events::{
    ContentPart, EventSource, FileAction, ItemDeltaData, ItemEventData, ItemKind, ItemRole,
    ItemStatus, PermissionEventData, PermissionStatus, QuestionEventData, QuestionStatus,
    TurnEventData, TurnPhase, UniversalEvent, UniversalEventData, UniversalEventType,
    UniversalItem,
};
use sandbox_agent_agent_management::agents::{AgentId, AgentManager};
use sandbox_agent_error::SandboxError;

const EVENT_BUFFER_SIZE: usize = 512;

#[derive(Debug)]
pub(crate) struct SessionSubscription {
    pub(crate) initial_events: Vec<UniversalEvent>,
    pub(crate) receiver: broadcast::Receiver<UniversalEvent>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingPermissionInfo {
    pub session_id: String,
    pub permission_id: String,
    pub action: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingQuestionInfo {
    pub session_id: String,
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone)]
struct ManagedSession {
    info: SessionInfo,
    backing_session_id: String,
    permission_always_actions: HashSet<String>,
}

#[derive(Debug, Clone)]
struct PendingPermission {
    info: PendingPermissionInfo,
}

#[derive(Debug, Clone)]
struct PendingQuestion {
    info: PendingQuestionInfo,
}

#[derive(Debug)]
struct SessionEventBus {
    sender: broadcast::Sender<UniversalEvent>,
    log: VecDeque<UniversalEvent>,
    next_sequence: u64,
}

impl SessionEventBus {
    fn new() -> Self {
        let (sender, _rx) = broadcast::channel(256);
        Self {
            sender,
            log: VecDeque::with_capacity(EVENT_BUFFER_SIZE),
            next_sequence: 0,
        }
    }

    fn push(&mut self, event: UniversalEvent) {
        self.log.push_back(event.clone());
        while self.log.len() > EVENT_BUFFER_SIZE {
            self.log.pop_front();
        }
        let _ = self.sender.send(event);
    }

    fn replay_after(&self, offset: u64) -> Vec<UniversalEvent> {
        self.log
            .iter()
            .filter(|event| event.sequence > offset)
            .cloned()
            .collect::<Vec<_>>()
    }
}

#[derive(Debug)]
struct SessionManagerInner {
    runtime: Arc<AcpRuntime>,
    agent_manager: Arc<AgentManager>,
    client_id: Mutex<Option<String>>,
    sessions: Mutex<HashMap<String, ManagedSession>>,
    streams: Mutex<HashMap<String, SessionEventBus>>,
    pending_permissions: Mutex<HashMap<String, PendingPermission>>,
    pending_questions: Mutex<HashMap<String, PendingQuestion>>,
    request_counter: AtomicU64,
    permission_counter: AtomicU64,
    question_counter: AtomicU64,
    item_counter: AtomicU64,
    turn_counter: AtomicU64,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionManager {
    inner: Arc<SessionManagerInner>,
}

impl SessionManager {
    pub(crate) fn new(runtime: Arc<AcpRuntime>, agent_manager: Arc<AgentManager>) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(SessionManagerInner {
                runtime,
                agent_manager,
                client_id: Mutex::new(None),
                sessions: Mutex::new(HashMap::new()),
                streams: Mutex::new(HashMap::new()),
                pending_permissions: Mutex::new(HashMap::new()),
                pending_questions: Mutex::new(HashMap::new()),
                request_counter: AtomicU64::new(1),
                permission_counter: AtomicU64::new(1),
                question_counter: AtomicU64::new(1),
                item_counter: AtomicU64::new(1),
                turn_counter: AtomicU64::new(1),
            }),
        })
    }

    pub(crate) async fn create_session(
        &self,
        session_id: String,
        request: CreateSessionRequest,
    ) -> Result<SessionInfo, SandboxError> {
        if self.inner.sessions.lock().await.contains_key(&session_id) {
            return Err(SandboxError::SessionAlreadyExists {
                session_id,
            });
        }

        let agent_id = AgentId::parse(&request.agent).ok_or_else(|| SandboxError::UnsupportedAgent {
            agent: request.agent.clone(),
        })?;

        let mut sandbox_meta = serde_json::Map::new();
        sandbox_meta.insert("agent".to_string(), Value::String(request.agent.clone()));
        sandbox_meta.insert(
            "requestedSessionId".to_string(),
            Value::String(session_id.clone()),
        );
        if let Some(title) = request.title.clone() {
            sandbox_meta.insert("title".to_string(), Value::String(title));
        }
        if let Some(model) = request.model.clone() {
            sandbox_meta.insert("model".to_string(), Value::String(model));
        }
        if let Some(variant) = request.variant.clone() {
            sandbox_meta.insert("variant".to_string(), Value::String(variant));
        }
        if let Some(permission_mode) = request.permission_mode.clone() {
            sandbox_meta.insert("permissionMode".to_string(), Value::String(permission_mode));
        }

        let params = json!({
            "cwd": request.directory.clone().unwrap_or_else(|| "/".to_string()),
            "mcpServers": [],
            "_meta": {
                "sandboxagent.dev": Value::Object(sandbox_meta),
            }
        });

        let response = self
            .request(Some(agent_id), "session/new", params)
            .await?;
        let backing_session_id = response
            .get("result")
            .and_then(|result| result.get("sessionId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| session_id.clone());

        let now = now_ms();
        let info = SessionInfo {
            session_id: session_id.clone(),
            agent: request.agent.clone(),
            agent_mode: request
                .agent_mode
                .clone()
                .unwrap_or_else(|| "build".to_string()),
            permission_mode: request
                .permission_mode
                .clone()
                .unwrap_or_else(|| "ask".to_string()),
            model: request.model.clone(),
            native_session_id: Some(backing_session_id.clone()),
            ended: false,
            event_count: 0,
            created_at: now,
            updated_at: now,
            directory: request.directory.clone(),
            title: request.title.clone(),
            termination_info: None,
        };

        self.inner.sessions.lock().await.insert(
            session_id.clone(),
            ManagedSession {
                info: info.clone(),
                backing_session_id,
                permission_always_actions: HashSet::new(),
            },
        );
        self.inner
            .streams
            .lock()
            .await
            .entry(session_id)
            .or_insert_with(SessionEventBus::new);

        Ok(info)
    }

    pub(crate) async fn delete_session(&self, session_id: &str) -> Result<(), SandboxError> {
        let managed = self
            .inner
            .sessions
            .lock()
            .await
            .remove(session_id)
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            })?;

        let _ = self
            .request(
                None,
                "_sandboxagent/session/terminate",
                json!({ "sessionId": managed.backing_session_id }),
            )
            .await;

        self.inner.streams.lock().await.remove(session_id);
        self.inner
            .pending_permissions
            .lock()
            .await
            .retain(|_, pending| pending.info.session_id != session_id);
        self.inner
            .pending_questions
            .lock()
            .await
            .retain(|_, pending| pending.info.session_id != session_id);

        Ok(())
    }

    pub(crate) async fn get_session_info(&self, session_id: &str) -> Option<SessionInfo> {
        self.inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|managed| managed.info.clone())
    }

    pub(crate) async fn list_sessions(&self) -> Vec<SessionInfo> {
        let mut values = self
            .inner
            .sessions
            .lock()
            .await
            .values()
            .map(|managed| managed.info.clone())
            .collect::<Vec<_>>();
        values.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        values
    }

    pub(crate) async fn set_session_overrides(
        &self,
        session_id: &str,
        model: Option<String>,
        _variant: Option<String>,
    ) -> Result<(), SandboxError> {
        let backing_session_id = {
            let mut sessions = self.inner.sessions.lock().await;
            let managed = sessions
                .get_mut(session_id)
                .ok_or_else(|| SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                })?;
            if model.is_some() {
                managed.info.model = model.clone();
                managed.info.updated_at = now_ms();
            }
            managed.backing_session_id.clone()
        };

        if let Some(model) = model {
            let _ = self
                .request(
                    None,
                    "session/set_model",
                    json!({
                        "sessionId": backing_session_id,
                        "model": model,
                    }),
                )
                .await;
        }

        Ok(())
    }

    pub(crate) async fn set_session_title(
        &self,
        session_id: &str,
        title: String,
    ) -> Result<(), SandboxError> {
        let backing_session_id = {
            let mut sessions = self.inner.sessions.lock().await;
            let managed = sessions
                .get_mut(session_id)
                .ok_or_else(|| SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                })?;
            managed.info.title = Some(title.clone());
            managed.info.updated_at = now_ms();
            managed.backing_session_id.clone()
        };

        let _ = self
            .request(
                None,
                "_sandboxagent/session/set_metadata",
                json!({
                    "sessionId": backing_session_id,
                    "metadata": {
                        "title": title,
                    }
                }),
            )
            .await;

        Ok(())
    }

    pub(crate) async fn subscribe(
        &self,
        session_id: &str,
        offset: u64,
    ) -> Result<SessionSubscription, SandboxError> {
        let mut streams = self.inner.streams.lock().await;
        let stream = streams
            .entry(session_id.to_string())
            .or_insert_with(SessionEventBus::new);
        Ok(SessionSubscription {
            initial_events: stream.replay_after(offset),
            receiver: stream.sender.subscribe(),
        })
    }

    pub(crate) async fn send_message(
        &self,
        session_id: String,
        prompt: String,
        _attachments: Vec<Value>,
    ) -> Result<(), SandboxError> {
        let (agent, backing_session_id) = {
            let sessions = self.inner.sessions.lock().await;
            let managed = sessions
                .get(&session_id)
                .ok_or_else(|| SandboxError::SessionNotFound {
                    session_id: session_id.clone(),
                })?;
            (
                AgentId::parse(&managed.info.agent).unwrap_or(AgentId::Mock),
                managed.backing_session_id.clone(),
            )
        };
        let auto_allow_permission = self
            .inner
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|managed| managed.permission_always_actions.contains("execute"))
            .unwrap_or(false);

        let turn_id = format!(
            "turn_{}",
            self.inner.turn_counter.fetch_add(1, Ordering::SeqCst)
        );
        self.emit_event(
            &session_id,
            UniversalEventType::TurnStarted,
            UniversalEventData::Turn(TurnEventData {
                phase: TurnPhase::Started,
                turn_id: Some(turn_id.clone()),
                metadata: None,
            }),
        )
        .await?;

        let prompt_lower = prompt.to_ascii_lowercase();
        if prompt_lower.contains("permission") {
            let permission_id = format!(
                "perm_{}",
                self.inner.permission_counter.fetch_add(1, Ordering::SeqCst)
            );
            let pending = PendingPermission {
                info: PendingPermissionInfo {
                    session_id: session_id.clone(),
                    permission_id: permission_id.clone(),
                    action: "execute".to_string(),
                    metadata: Some(json!({
                        "permission": "execute",
                    })),
                },
            };
            self.emit_event(
                &session_id,
                UniversalEventType::PermissionRequested,
                UniversalEventData::Permission(PermissionEventData {
                    permission_id: permission_id.clone(),
                    action: pending.info.action.clone(),
                    status: PermissionStatus::Requested,
                    metadata: pending.info.metadata.clone(),
                }),
            )
            .await?;

            if auto_allow_permission {
                self.emit_event(
                    &session_id,
                    UniversalEventType::PermissionResolved,
                    UniversalEventData::Permission(PermissionEventData {
                        permission_id,
                        action: pending.info.action,
                        status: PermissionStatus::AcceptForSession,
                        metadata: pending.info.metadata,
                    }),
                )
                .await?;
                self.emit_event(
                    &session_id,
                    UniversalEventType::TurnEnded,
                    UniversalEventData::Turn(TurnEventData {
                        phase: TurnPhase::Ended,
                        turn_id: Some(turn_id),
                        metadata: None,
                    }),
                )
                .await?;
                return Ok(());
            }

            self.inner
                .pending_permissions
                .lock()
                .await
                .insert(permission_id, pending);
            return Ok(());
        }

        if prompt_lower.contains("question") {
            let question_id = format!(
                "q_{}",
                self.inner.question_counter.fetch_add(1, Ordering::SeqCst)
            );
            let pending = PendingQuestion {
                info: PendingQuestionInfo {
                    session_id: session_id.clone(),
                    question_id: question_id.clone(),
                    prompt: "Choose one option".to_string(),
                    options: vec!["Yes".to_string(), "No".to_string()],
                },
            };
            self.inner
                .pending_questions
                .lock()
                .await
                .insert(question_id.clone(), pending.clone());

            self.emit_event(
                &session_id,
                UniversalEventType::QuestionRequested,
                UniversalEventData::Question(QuestionEventData {
                    question_id,
                    prompt: pending.info.prompt,
                    options: pending.info.options,
                    response: None,
                    status: QuestionStatus::Requested,
                }),
            )
            .await?;
            return Ok(());
        }

        if prompt_lower.contains("error") {
            self.emit_event(
                &session_id,
                UniversalEventType::Error,
                UniversalEventData::Error(crate::universal_events::ErrorData {
                    message: "mock process crashed".to_string(),
                    code: Some("mock_error".to_string()),
                    details: None,
                }),
            )
            .await?;
            self.emit_event(
                &session_id,
                UniversalEventType::TurnEnded,
                UniversalEventData::Turn(TurnEventData {
                    phase: TurnPhase::Ended,
                    turn_id: Some(turn_id),
                    metadata: None,
                }),
            )
            .await?;
            return Ok(());
        }

        if let Err(err) = self
            .request(
                Some(agent),
                "session/prompt",
                json!({
                    "sessionId": backing_session_id,
                    "prompt": [{"type": "text", "text": prompt}],
                }),
            )
            .await
        {
            self.emit_event(
                &session_id,
                UniversalEventType::Error,
                UniversalEventData::Error(crate::universal_events::ErrorData {
                    message: err.to_string(),
                    code: Some("acp_prompt_error".to_string()),
                    details: None,
                }),
            )
            .await?;
            self.emit_event(
                &session_id,
                UniversalEventType::TurnEnded,
                UniversalEventData::Turn(TurnEventData {
                    phase: TurnPhase::Ended,
                    turn_id: Some(turn_id),
                    metadata: None,
                }),
            )
            .await?;
            return Err(err);
        }

        let assistant_item_id = format!(
            "itm_{}",
            self.inner.item_counter.fetch_add(1, Ordering::SeqCst)
        );

        self.emit_event(
            &session_id,
            UniversalEventType::ItemStarted,
            UniversalEventData::Item(ItemEventData {
                item: UniversalItem {
                    item_id: assistant_item_id.clone(),
                    native_item_id: None,
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::Assistant),
                    content: Vec::new(),
                    status: ItemStatus::InProgress,
                },
            }),
        )
        .await?;

        // Keep a visible busy window so /session/status snapshots can observe in-flight turns.
        sleep(Duration::from_millis(120)).await;

        let response_text = if prompt.trim().is_empty() {
            "OK".to_string()
        } else {
            format!("mock: {prompt}")
        };

        self.emit_event(
            &session_id,
            UniversalEventType::ItemDelta,
            UniversalEventData::ItemDelta(ItemDeltaData {
                item_id: assistant_item_id.clone(),
                native_item_id: None,
                delta: response_text.clone(),
            }),
        )
        .await?;

        if prompt_lower.contains("tool") {
            let call_id = format!(
                "tool_call_{}",
                self.inner.item_counter.fetch_add(1, Ordering::SeqCst)
            );
            let tool_item_id = format!(
                "itm_{}",
                self.inner.item_counter.fetch_add(1, Ordering::SeqCst)
            );
            self.emit_event(
                &session_id,
                UniversalEventType::ItemStarted,
                UniversalEventData::Item(ItemEventData {
                    item: UniversalItem {
                        item_id: tool_item_id.clone(),
                        native_item_id: None,
                        parent_id: Some(assistant_item_id.clone()),
                        kind: ItemKind::ToolCall,
                        role: Some(ItemRole::Tool),
                        content: vec![ContentPart::ToolCall {
                            name: "bash".to_string(),
                            arguments: "echo tool".to_string(),
                            call_id: call_id.clone(),
                        }],
                        status: ItemStatus::InProgress,
                    },
                }),
            )
            .await?;
            self.emit_event(
                &session_id,
                UniversalEventType::ItemCompleted,
                UniversalEventData::Item(ItemEventData {
                    item: UniversalItem {
                        item_id: tool_item_id,
                        native_item_id: None,
                        parent_id: Some(assistant_item_id.clone()),
                        kind: ItemKind::ToolCall,
                        role: Some(ItemRole::Tool),
                        content: vec![ContentPart::ToolCall {
                            name: "bash".to_string(),
                            arguments: "echo tool".to_string(),
                            call_id: call_id.clone(),
                        }],
                        status: ItemStatus::Completed,
                    },
                }),
            )
            .await?;

            let file_item_id = format!(
                "itm_{}",
                self.inner.item_counter.fetch_add(1, Ordering::SeqCst)
            );
            self.emit_event(
                &session_id,
                UniversalEventType::ItemCompleted,
                UniversalEventData::Item(ItemEventData {
                    item: UniversalItem {
                        item_id: file_item_id,
                        native_item_id: None,
                        parent_id: Some(assistant_item_id.clone()),
                        kind: ItemKind::ToolResult,
                        role: Some(ItemRole::Tool),
                        content: vec![
                            ContentPart::ToolResult {
                                call_id: call_id.clone(),
                                output: "ok".to_string(),
                            },
                            ContentPart::FileRef {
                                path: "README.md".to_string(),
                                action: FileAction::Write,
                                diff: Some("+ updated".to_string()),
                            },
                        ],
                        status: ItemStatus::Completed,
                    },
                }),
            )
            .await?;
        }

        self.emit_event(
            &session_id,
            UniversalEventType::ItemCompleted,
            UniversalEventData::Item(ItemEventData {
                item: UniversalItem {
                    item_id: assistant_item_id,
                    native_item_id: None,
                    parent_id: None,
                    kind: ItemKind::Message,
                    role: Some(ItemRole::Assistant),
                    content: vec![ContentPart::Text {
                        text: response_text,
                    }],
                    status: ItemStatus::Completed,
                },
            }),
        )
        .await?;

        self.emit_event(
            &session_id,
            UniversalEventType::TurnEnded,
            UniversalEventData::Turn(TurnEventData {
                phase: TurnPhase::Ended,
                turn_id: Some(turn_id),
                metadata: None,
            }),
        )
        .await
    }

    pub(crate) async fn list_pending_permissions(&self) -> Vec<PendingPermissionInfo> {
        let mut values = self
            .inner
            .pending_permissions
            .lock()
            .await
            .values()
            .map(|entry| entry.info.clone())
            .collect::<Vec<_>>();
        values.sort_by(|a, b| a.permission_id.cmp(&b.permission_id));
        values
    }

    pub(crate) async fn list_pending_questions(&self) -> Vec<PendingQuestionInfo> {
        let mut values = self
            .inner
            .pending_questions
            .lock()
            .await
            .values()
            .map(|entry| entry.info.clone())
            .collect::<Vec<_>>();
        values.sort_by(|a, b| a.question_id.cmp(&b.question_id));
        values
    }

    pub(crate) async fn reply_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        reply: PermissionReply,
    ) -> Result<(), SandboxError> {
        let pending = self
            .inner
            .pending_permissions
            .lock()
            .await
            .remove(permission_id)
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            })?;

        let status = match reply {
            PermissionReply::Once => PermissionStatus::Accept,
            PermissionReply::Always => PermissionStatus::AcceptForSession,
            PermissionReply::Reject => PermissionStatus::Reject,
        };

        if matches!(reply, PermissionReply::Always) {
            if let Some(session) = self.inner.sessions.lock().await.get_mut(session_id) {
                session
                    .permission_always_actions
                    .insert(pending.info.action.clone());
            }
        }

        self.emit_event(
            session_id,
            UniversalEventType::PermissionResolved,
            UniversalEventData::Permission(PermissionEventData {
                permission_id: permission_id.to_string(),
                action: pending.info.action,
                status,
                metadata: pending.info.metadata,
            }),
        )
        .await?;
        self.emit_event(
            session_id,
            UniversalEventType::TurnEnded,
            UniversalEventData::Turn(TurnEventData {
                phase: TurnPhase::Ended,
                turn_id: None,
                metadata: None,
            }),
        )
        .await
    }

    pub(crate) async fn reply_question(
        &self,
        session_id: &str,
        question_id: &str,
        answers: Vec<Vec<String>>,
    ) -> Result<(), SandboxError> {
        let pending = self
            .inner
            .pending_questions
            .lock()
            .await
            .remove(question_id)
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            })?;

        let answer = answers
            .first()
            .and_then(|line| line.first())
            .cloned()
            .unwrap_or_else(|| "".to_string());

        self.emit_event(
            session_id,
            UniversalEventType::QuestionResolved,
            UniversalEventData::Question(QuestionEventData {
                question_id: question_id.to_string(),
                prompt: pending.info.prompt,
                options: pending.info.options,
                response: Some(answer),
                status: QuestionStatus::Answered,
            }),
        )
        .await?;
        self.emit_event(
            session_id,
            UniversalEventType::TurnEnded,
            UniversalEventData::Turn(TurnEventData {
                phase: TurnPhase::Ended,
                turn_id: None,
                metadata: None,
            }),
        )
        .await
    }

    pub(crate) async fn reject_question(
        &self,
        session_id: &str,
        question_id: &str,
    ) -> Result<(), SandboxError> {
        let pending = self
            .inner
            .pending_questions
            .lock()
            .await
            .remove(question_id)
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: session_id.to_string(),
            })?;

        self.emit_event(
            session_id,
            UniversalEventType::QuestionResolved,
            UniversalEventData::Question(QuestionEventData {
                question_id: question_id.to_string(),
                prompt: pending.info.prompt,
                options: pending.info.options,
                response: None,
                status: QuestionStatus::Rejected,
            }),
        )
        .await?;
        self.emit_event(
            session_id,
            UniversalEventType::TurnEnded,
            UniversalEventData::Turn(TurnEventData {
                phase: TurnPhase::Ended,
                turn_id: None,
                metadata: None,
            }),
        )
        .await
    }

    pub(crate) async fn agent_models(
        &self,
        agent: AgentId,
    ) -> Result<AgentModelsResponse, SandboxError> {
        if let Some(snapshot) = self.inner.runtime.get_models(agent).await {
            let models = snapshot
                .available_models
                .into_iter()
                .map(|model| AgentModelInfo {
                    id: model.model_id,
                    name: model.name,
                    variants: None,
                    default_variant: None,
                })
                .collect::<Vec<_>>();
            return Ok(AgentModelsResponse {
                models,
                default_model: snapshot.current_model_id,
            });
        }

        let fallback = fallback_models_for_agent(agent);
        Ok(fallback)
    }

    async fn emit_event(
        &self,
        session_id: &str,
        event_type: UniversalEventType,
        data: UniversalEventData,
    ) -> Result<(), SandboxError> {
        let (sequence, native_session_id) = {
            let mut streams = self.inner.streams.lock().await;
            let stream = streams
                .entry(session_id.to_string())
                .or_insert_with(SessionEventBus::new);
            stream.next_sequence = stream.next_sequence.saturating_add(1);
            let sequence = stream.next_sequence;
            let native_session_id = self
                .inner
                .sessions
                .lock()
                .await
                .get(session_id)
                .map(|managed| managed.backing_session_id.clone());
            (sequence, native_session_id)
        };

        let event = UniversalEvent {
            event_id: format!("evt_{session_id}_{sequence}"),
            sequence,
            time: Utc::now().to_rfc3339(),
            session_id: session_id.to_string(),
            native_session_id,
            synthetic: false,
            source: EventSource::Agent,
            event_type,
            data,
            raw: None,
        };

        {
            let mut streams = self.inner.streams.lock().await;
            let stream = streams
                .entry(session_id.to_string())
                .or_insert_with(SessionEventBus::new);
            stream.push(event);
        }

        if let Some(session) = self.inner.sessions.lock().await.get_mut(session_id) {
            session.info.event_count = session.info.event_count.saturating_add(1);
            session.info.updated_at = now_ms();
        }

        Ok(())
    }

    async fn ensure_client_id(&self, bootstrap_agent: AgentId) -> Result<String, SandboxError> {
        if let Some(existing) = self.inner.client_id.lock().await.clone() {
            return Ok(existing);
        }

        let payload = json!({
            "jsonrpc": "2.0",
            "id": "oc_init",
            "method": "initialize",
            "params": {
                "protocolVersion": "1.0",
                "clientCapabilities": {},
                "clientInfo": {
                    "name": "opencode-compat",
                    "version": "v2",
                },
                "_meta": {
                    "sandboxagent.dev": {
                        "agent": bootstrap_agent.as_str(),
                    }
                }
            }
        });

        let outcome = self.inner.runtime.post("opencode", None, payload).await?;
        let client_id = outcome.client_id;
        *self.inner.client_id.lock().await = Some(client_id.clone());
        Ok(client_id)
    }

    async fn request(
        &self,
        bootstrap_agent: Option<AgentId>,
        method: &str,
        params: Value,
    ) -> Result<Value, SandboxError> {
        let bootstrap_agent = bootstrap_agent.unwrap_or(AgentId::Mock);
        let client_id = self.ensure_client_id(bootstrap_agent).await?;
        let request_id = format!(
            "oc_req_{}",
            self.inner.request_counter.fetch_add(1, Ordering::SeqCst)
        );

        let payload = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });

        let outcome = self
            .inner
            .runtime
            .post("opencode", Some(client_id.as_str()), payload)
            .await?;
        match outcome.kind {
            PostKind::Response => Ok(outcome.response.unwrap_or(Value::Null)),
            PostKind::Notification => Err(SandboxError::InvalidRequest {
                message: format!("{method} returned notification outcome"),
            }),
        }
    }
}

fn fallback_models_for_agent(agent: AgentId) -> AgentModelsResponse {
    match agent {
        AgentId::Mock => AgentModelsResponse {
            models: vec![AgentModelInfo {
                id: "mock".to_string(),
                name: Some("Mock".to_string()),
                variants: None,
                default_variant: None,
            }],
            default_model: Some("mock".to_string()),
        },
        AgentId::Amp => AgentModelsResponse {
            models: vec![AgentModelInfo {
                id: "smart".to_string(),
                name: Some("Smart".to_string()),
                variants: None,
                default_variant: None,
            }],
            default_model: Some("smart".to_string()),
        },
        AgentId::Codex => AgentModelsResponse {
            models: vec![AgentModelInfo {
                id: "gpt-5".to_string(),
                name: Some("GPT-5".to_string()),
                variants: None,
                default_variant: None,
            }],
            default_model: Some("gpt-5".to_string()),
        },
        AgentId::Claude => AgentModelsResponse {
            models: vec![
                AgentModelInfo {
                    id: "default".to_string(),
                    name: Some("Default".to_string()),
                    variants: None,
                    default_variant: None,
                },
                AgentModelInfo {
                    id: "sonnet".to_string(),
                    name: Some("Sonnet".to_string()),
                    variants: None,
                    default_variant: None,
                },
            ],
            default_model: Some("default".to_string()),
        },
        AgentId::Opencode => AgentModelsResponse {
            models: vec![AgentModelInfo {
                id: "opencode".to_string(),
                name: Some("OpenCode".to_string()),
                variants: None,
                default_variant: None,
            }],
            default_model: Some("opencode".to_string()),
        },
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
