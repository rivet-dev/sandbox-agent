use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use acp_http_adapter::process::{AdapterError, AdapterRuntime, PostOutcome};
use acp_http_adapter::registry::LaunchSpec;
use axum::response::sse::Event;
use futures::Stream;
use sandbox_agent_agent_management::agents::{AgentId, AgentManager, InstallOptions};
use sandbox_agent_error::SandboxError;
use sandbox_agent_opencode_adapter::{AcpDispatch, AcpDispatchResult, AcpPayloadStream};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone)]
pub struct AcpProxyRuntime {
    inner: Arc<AcpProxyRuntimeInner>,
}

#[derive(Debug)]
struct AcpProxyRuntimeInner {
    agent_manager: Arc<AgentManager>,
    require_preinstall: bool,
    request_timeout: Duration,
    instances: RwLock<HashMap<String, Arc<ProxyInstance>>>,
    instance_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    install_locks: Mutex<HashMap<AgentId, Arc<Mutex<()>>>>,
}

#[derive(Debug)]
struct ProxyInstance {
    server_id: String,
    agent: AgentId,
    runtime: Arc<AdapterRuntime>,
    created_at_ms: i64,
}

#[derive(Debug)]
pub enum ProxyPostOutcome {
    Response(Value),
    Accepted,
}

#[derive(Debug, Clone)]
pub struct AcpServerInstanceInfo {
    pub server_id: String,
    pub agent: AgentId,
    pub created_at_ms: i64,
}

pub type PinBoxSseStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>>;

impl AcpProxyRuntime {
    pub fn new(agent_manager: Arc<AgentManager>) -> Self {
        let require_preinstall = std::env::var("SANDBOX_AGENT_REQUIRE_PREINSTALL")
            .ok()
            .is_some_and(|value| {
                let trimmed = value.trim();
                trimmed == "1"
                    || trimmed.eq_ignore_ascii_case("true")
                    || trimmed.eq_ignore_ascii_case("yes")
            });

        let request_timeout = duration_from_env_ms(
            "SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS",
            Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS),
        );

        Self {
            inner: Arc::new(AcpProxyRuntimeInner {
                agent_manager,
                require_preinstall,
                request_timeout,
                instances: RwLock::new(HashMap::new()),
                instance_locks: Mutex::new(HashMap::new()),
                install_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn list_instances(&self) -> Vec<AcpServerInstanceInfo> {
        let mut infos = self
            .inner
            .instances
            .read()
            .await
            .values()
            .map(|instance| AcpServerInstanceInfo {
                server_id: instance.server_id.clone(),
                agent: instance.agent,
                created_at_ms: instance.created_at_ms,
            })
            .collect::<Vec<_>>();
        infos.sort_by(|left, right| left.server_id.cmp(&right.server_id));
        infos
    }

    pub async fn post(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
        payload: Value,
    ) -> Result<ProxyPostOutcome, SandboxError> {
        let method: String = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>")
            .to_string();
        let id: String = payload.get("id").map(|v| v.to_string()).unwrap_or_default();

        tracing::info!(
            server_id = server_id,
            method = method,
            id = %id,
            bootstrap_agent = ?bootstrap_agent,
            "acp_proxy: POST received"
        );

        let start = std::time::Instant::now();
        let instance = self
            .get_or_create_instance(server_id, bootstrap_agent)
            .await?;
        let instance_elapsed = start.elapsed();

        tracing::debug!(
            server_id = server_id,
            agent = instance.agent.as_str(),
            instance_ms = instance_elapsed.as_millis() as u64,
            "acp_proxy: instance resolved"
        );

        match instance.runtime.post(payload).await {
            Ok(PostOutcome::Response(value)) => {
                let total_ms = start.elapsed().as_millis() as u64;
                tracing::info!(
                    server_id = server_id,
                    method = method,
                    id = %id,
                    total_ms = total_ms,
                    "acp_proxy: POST → response"
                );
                let value = annotate_agent_error(instance.agent, value);
                Ok(ProxyPostOutcome::Response(value))
            }
            Ok(PostOutcome::Accepted) => {
                tracing::info!(
                    server_id = server_id,
                    method = method,
                    "acp_proxy: POST → accepted"
                );
                Ok(ProxyPostOutcome::Accepted)
            }
            Err(err) => {
                let total_ms = start.elapsed().as_millis() as u64;
                tracing::error!(
                    server_id = server_id,
                    method = method,
                    id = %id,
                    total_ms = total_ms,
                    error = %err,
                    "acp_proxy: POST → error"
                );
                Err(map_adapter_error(err))
            }
        }
    }

    pub async fn sse(
        &self,
        server_id: &str,
        last_event_id: Option<u64>,
    ) -> Result<PinBoxSseStream, SandboxError> {
        let instance = self.get_instance(server_id).await?;
        let stream = instance.runtime.clone().sse_stream(last_event_id).await;
        Ok(Box::pin(stream))
    }

    pub async fn delete(&self, server_id: &str) -> Result<(), SandboxError> {
        let removed = self.inner.instances.write().await.remove(server_id);
        if let Some(instance) = removed {
            instance.runtime.shutdown().await;
        }
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        let instances = {
            let mut guard = self.inner.instances.write().await;
            guard
                .drain()
                .map(|(_, instance)| instance)
                .collect::<Vec<_>>()
        };

        for instance in instances {
            instance.runtime.shutdown().await;
        }
    }

    async fn get_instance(&self, server_id: &str) -> Result<Arc<ProxyInstance>, SandboxError> {
        self.inner
            .instances
            .read()
            .await
            .get(server_id)
            .cloned()
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: server_id.to_string(),
            })
    }

    async fn get_or_create_instance(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
    ) -> Result<Arc<ProxyInstance>, SandboxError> {
        if let Some(existing) = self.inner.instances.read().await.get(server_id).cloned() {
            if let Some(agent) = bootstrap_agent {
                if agent != existing.agent {
                    return Err(SandboxError::Conflict {
                        message: format!(
                            "server '{server_id}' already exists for agent '{}'; requested '{agent}'",
                            existing.agent.as_str()
                        ),
                    });
                }
            }
            return Ok(existing);
        }

        let lock = {
            let mut locks = self.inner.instance_locks.lock().await;
            locks
                .entry(server_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        if let Some(existing) = self.inner.instances.read().await.get(server_id).cloned() {
            if let Some(agent) = bootstrap_agent {
                if agent != existing.agent {
                    return Err(SandboxError::Conflict {
                        message: format!(
                            "server '{server_id}' already exists for agent '{}'; requested '{agent}'",
                            existing.agent.as_str()
                        ),
                    });
                }
            }
            return Ok(existing);
        }

        let agent = bootstrap_agent.ok_or_else(|| SandboxError::InvalidRequest {
            message: format!(
                "missing required 'agent' query parameter for first POST to /v1/acp/{server_id}"
            ),
        })?;

        let created = self.create_instance(server_id, agent).await?;
        self.inner
            .instances
            .write()
            .await
            .insert(server_id.to_string(), created.clone());

        Ok(created)
    }

    async fn create_instance(
        &self,
        server_id: &str,
        agent: AgentId,
    ) -> Result<Arc<ProxyInstance>, SandboxError> {
        let start = std::time::Instant::now();
        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            "create_instance: starting"
        );

        self.ensure_installed(agent).await?;
        let install_elapsed = start.elapsed();
        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            install_ms = install_elapsed.as_millis() as u64,
            "create_instance: agent installed/verified"
        );

        let manager = self.inner.agent_manager.clone();
        let launch = tokio::task::spawn_blocking(move || manager.resolve_agent_process(agent))
            .await
            .map_err(|err| SandboxError::StreamError {
                message: format!("failed to resolve ACP agent process launch spec: {err}"),
            })?
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;

        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            program = ?launch.program,
            args = ?launch.args,
            resolve_ms = start.elapsed().as_millis() as u64,
            "create_instance: launch spec resolved, spawning"
        );

        let runtime = AdapterRuntime::start(
            LaunchSpec {
                program: launch.program,
                args: launch.args,
                env: launch.env,
            },
            self.inner.request_timeout,
        )
        .await
        .map_err(map_adapter_error)?;

        let total_ms = start.elapsed().as_millis() as u64;
        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            total_ms = total_ms,
            "create_instance: ready"
        );

        Ok(Arc::new(ProxyInstance {
            server_id: server_id.to_string(),
            agent,
            runtime: Arc::new(runtime),
            created_at_ms: now_ms(),
        }))
    }

    async fn ensure_installed(&self, agent: AgentId) -> Result<(), SandboxError> {
        if self.inner.require_preinstall {
            if !self.is_ready(agent).await {
                return Err(SandboxError::AgentNotInstalled {
                    agent: agent.as_str().to_string(),
                });
            }
            return Ok(());
        }

        if self.is_ready(agent).await {
            return Ok(());
        }

        let lock = {
            let mut locks = self.inner.install_locks.lock().await;
            locks
                .entry(agent)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        if self.is_ready(agent).await {
            return Ok(());
        }

        let manager = self.inner.agent_manager.clone();
        tokio::task::spawn_blocking(move || manager.install(agent, InstallOptions::default()))
            .await
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent.as_str().to_string(),
                stderr: Some(format!("installer task failed: {err}")),
            })?
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent.as_str().to_string(),
                stderr: Some(err.to_string()),
            })?;

        Ok(())
    }

    async fn is_ready(&self, agent: AgentId) -> bool {
        if agent == AgentId::Mock {
            return self.inner.agent_manager.agent_process_path(agent).exists();
        }
        self.inner.agent_manager.is_installed(agent)
    }
}

impl AcpDispatch for AcpProxyRuntime {
    fn post(
        &self,
        server_id: &str,
        bootstrap_agent: Option<&str>,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<AcpDispatchResult, String>> + Send + '_>> {
        let server_id = server_id.to_string();
        let agent = bootstrap_agent.and_then(AgentId::parse);
        Box::pin(async move {
            match self.post(&server_id, agent, payload).await {
                Ok(ProxyPostOutcome::Response(value)) => Ok(AcpDispatchResult::Response(value)),
                Ok(ProxyPostOutcome::Accepted) => Ok(AcpDispatchResult::Accepted),
                Err(err) => Err(err.to_string()),
            }
        })
    }

    fn notification_stream(
        &self,
        server_id: &str,
        last_event_id: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = Result<AcpPayloadStream, String>> + Send + '_>> {
        let server_id = server_id.to_string();
        Box::pin(async move {
            let instance = self
                .get_instance(&server_id)
                .await
                .map_err(|e| e.to_string())?;
            let stream = instance.runtime.clone().value_stream(last_event_id).await;
            Ok(Box::pin(stream) as AcpPayloadStream)
        })
    }

    fn delete(
        &self,
        server_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let server_id = server_id.to_string();
        Box::pin(async move { self.delete(&server_id).await.map_err(|err| err.to_string()) })
    }
}

fn map_adapter_error(err: AdapterError) -> SandboxError {
    match err {
        AdapterError::InvalidEnvelope => SandboxError::InvalidRequest {
            message: "request body must be a JSON-RPC object".to_string(),
        },
        AdapterError::Timeout => SandboxError::Timeout {
            message: Some("timed out waiting for agent response".to_string()),
        },
        AdapterError::Serialize(error) => SandboxError::InvalidRequest {
            message: format!("failed to serialize JSON payload: {error}"),
        },
        AdapterError::Write(error) => SandboxError::StreamError {
            message: format!("failed writing to agent stdin: {error}"),
        },
        AdapterError::Spawn(error) => SandboxError::StreamError {
            message: format!("failed to start agent process: {error}"),
        },
        AdapterError::MissingStdin | AdapterError::MissingStdout | AdapterError::MissingStderr => {
            SandboxError::StreamError {
                message: "agent subprocess pipes were not available".to_string(),
            }
        }
    }
}

/// Inspect JSON-RPC error responses from agent processes and add helpful hints
/// when we can infer the root cause from a known error pattern.
fn annotate_agent_error(agent: AgentId, mut value: Value) -> Value {
    if agent != AgentId::Pi {
        return value;
    }

    let matches = value
        .pointer("/error/data/details")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.contains("Cannot call write after a stream was destroyed"));

    if matches {
        if let Some(data) = value.pointer_mut("/error/data") {
            if let Some(obj) = data.as_object_mut() {
                obj.insert(
                    "hint".to_string(),
                    Value::String(
                        "The pi CLI exited immediately — this usually means no API key is \
                         configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, \
                         or another supported provider key."
                            .to_string(),
                    ),
                );
            }
        }
    }

    value
}

fn duration_from_env_ms(key: &str, default: Duration) -> Duration {
    match std::env::var(key) {
        Ok(raw) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .map(Duration::from_millis)
            .unwrap_or(default),
        Err(_) => default,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
