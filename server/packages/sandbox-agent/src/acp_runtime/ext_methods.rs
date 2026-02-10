use super::*;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use sandbox_agent_agent_management::agents::{InstallResult, InstallSource, InstalledArtifactKind};
use sandbox_agent_agent_management::credentials::{
    extract_all_credentials, CredentialExtractionOptions,
};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tar::Archive;

use crate::router::{
    AgentCapabilities as RouterAgentCapabilities, AgentInfo, AgentInstallArtifact,
    AgentInstallResponse, AgentListResponse, AgentModeInfo as RouterAgentModeInfo,
    AgentModelInfo as RouterAgentModelInfo, FsActionResponse, FsEntry, FsEntryType, FsMoveResponse,
    FsStat, FsUploadBatchResponse, FsWriteResponse, ServerStatus, ServerStatusInfo, SessionInfo,
    SessionListResponse, StderrOutput as RouterStderrOutput, TerminationInfo,
};

// NOTE ABOUT FILESYSTEM SURFACE:
// Sandbox Agent intentionally keeps binary filesystem transfer on dedicated HTTP endpoints
// (`GET/PUT /v2/fs/file`, `POST /v2/fs/upload-batch`) instead of ACP extension methods.
// Reason:
// 1) these operations are host/runtime responsibilities owned by Sandbox Agent (not by agent processes),
// 2) they need consistent cross-agent behavior, and
// 3) ACP JSON-RPC payloads are not suitable for streaming very large binary files.
// This is intentionally separate from ACP native `fs/read_text_file` and `fs/write_text_file`.
// If ACP variants are provided in parallel, they should share the same underlying filesystem
// service implementation as the HTTP endpoints, while SDK defaults still prefer HTTP for large/binary transfers.
pub(super) const SESSION_DETACH_METHOD: &str = "_sandboxagent/session/detach";
pub(super) const SESSION_TERMINATE_METHOD: &str = "_sandboxagent/session/terminate";
pub(super) const SESSION_LIST_MODELS_METHOD: &str = "_sandboxagent/session/list_models";
pub(super) const SESSION_SET_METADATA_METHOD: &str = "_sandboxagent/session/set_metadata";
pub(super) const SESSION_ENDED_METHOD: &str = "_sandboxagent/session/ended";
pub(super) const AGENT_UNPARSED_METHOD: &str = "_sandboxagent/agent/unparsed";
pub(super) const AGENT_LIST_METHOD: &str = "_sandboxagent/agent/list";
pub(super) const AGENT_INSTALL_METHOD: &str = "_sandboxagent/agent/install";
pub(super) const SESSION_LIST_METHOD: &str = "_sandboxagent/session/list";
pub(super) const SESSION_GET_METHOD: &str = "_sandboxagent/session/get";
pub(super) const FS_LIST_ENTRIES_METHOD: &str = "_sandboxagent/fs/list_entries";
pub(super) const FS_READ_FILE_METHOD: &str = "_sandboxagent/fs/read_file";
pub(super) const FS_WRITE_FILE_METHOD: &str = "_sandboxagent/fs/write_file";
pub(super) const FS_DELETE_ENTRY_METHOD: &str = "_sandboxagent/fs/delete_entry";
pub(super) const FS_MKDIR_METHOD: &str = "_sandboxagent/fs/mkdir";
pub(super) const FS_MOVE_METHOD: &str = "_sandboxagent/fs/move";
pub(super) const FS_STAT_METHOD: &str = "_sandboxagent/fs/stat";
pub(super) const FS_UPLOAD_BATCH_METHOD: &str = "_sandboxagent/fs/upload_batch";

impl AcpRuntime {
    pub(super) async fn handle_extension_request(
        &self,
        connection: &AcpClient,
        method: &str,
        payload: &Value,
    ) -> Option<Result<Value, SandboxError>> {
        match method {
            SESSION_DETACH_METHOD => {
                Some(self.session_detach_response(&connection.id, payload).await)
            }
            SESSION_TERMINATE_METHOD => Some(self.session_terminate_response(payload).await),
            SESSION_LIST_MODELS_METHOD => {
                Some(self.session_list_models_response(connection, payload).await)
            }
            SESSION_SET_METADATA_METHOD => Some(self.session_set_metadata_response(payload).await),
            AGENT_LIST_METHOD => Some(self.agent_list_response(payload).await),
            AGENT_INSTALL_METHOD => Some(self.agent_install_response(payload).await),
            SESSION_LIST_METHOD => Some(self.session_list_extension_response(payload).await),
            SESSION_GET_METHOD => Some(self.session_get_response(payload).await),
            FS_LIST_ENTRIES_METHOD => Some(self.fs_list_entries_response(payload).await),
            FS_READ_FILE_METHOD => Some(self.fs_read_file_response(payload).await),
            FS_WRITE_FILE_METHOD => Some(self.fs_write_file_response(payload).await),
            FS_DELETE_ENTRY_METHOD => Some(self.fs_delete_entry_response(payload).await),
            FS_MKDIR_METHOD => Some(self.fs_mkdir_response(payload).await),
            FS_MOVE_METHOD => Some(self.fs_move_response(payload).await),
            FS_STAT_METHOD => Some(self.fs_stat_response(payload).await),
            FS_UPLOAD_BATCH_METHOD => Some(self.fs_upload_batch_response(payload).await),
            _ => None,
        }
    }

    pub(super) async fn handle_extension_notification(
        &self,
        connection: &AcpClient,
        method: &str,
        payload: &Value,
    ) -> Option<Result<(), SandboxError>> {
        match method {
            SESSION_DETACH_METHOD => Some(
                self.session_detach_notification(&connection.id, payload)
                    .await,
            ),
            SESSION_TERMINATE_METHOD => Some(self.session_terminate_notification(payload).await),
            SESSION_SET_METADATA_METHOD => {
                Some(self.session_set_metadata_notification(payload).await)
            }
            _ => None,
        }
    }

    async fn agent_list_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, AGENT_LIST_METHOD)?;
        let credentials = tokio::task::spawn_blocking(move || {
            extract_all_credentials(&CredentialExtractionOptions::new())
        })
        .await
        .map_err(|err| SandboxError::StreamError {
            message: format!("failed to resolve credentials: {err}"),
        })?;
        let has_anthropic = credentials.anthropic.is_some();
        let has_openai = credentials.openai.is_some();

        let mut status_map = std::collections::HashMap::new();
        for status in self.list_server_statuses().await {
            status_map.insert(status.agent, status);
        }

        let mut agents = Vec::new();
        for agent_id in AgentId::all().iter().copied() {
            let capabilities = extension_agent_capabilities_for(agent_id);
            let installed = self.inner.agent_manager.is_installed(agent_id);
            let credentials_available =
                extension_credentials_available_for(agent_id, has_anthropic, has_openai);
            let version = self.inner.agent_manager.version(agent_id).ok().flatten();
            let path = self
                .inner
                .agent_manager
                .resolve_binary(agent_id)
                .ok()
                .map(|path| path.to_string_lossy().to_string());

            let server_status = if capabilities.shared_process {
                Some(match status_map.get(&agent_id) {
                    Some(status) => extension_map_server_status(status),
                    None => ServerStatusInfo {
                        status: ServerStatus::Stopped,
                        base_url: None,
                        uptime_ms: None,
                        restart_count: 0,
                        last_error: None,
                    },
                })
            } else {
                None
            };

            let (models, default_model) = if installed {
                if let Some(snapshot) = self.get_models(agent_id).await {
                    let list = snapshot
                        .available_models
                        .into_iter()
                        .map(|model| RouterAgentModelInfo {
                            id: model.model_id,
                            name: model.name,
                            variants: None,
                            default_variant: None,
                        })
                        .collect::<Vec<_>>();
                    (Some(list), snapshot.current_model_id)
                } else {
                    let fallback = fallback_models_for_agent(agent_id);
                    if fallback.available_models.is_empty() {
                        (None, None)
                    } else {
                        (
                            Some(
                                fallback
                                    .available_models
                                    .into_iter()
                                    .map(|model| RouterAgentModelInfo {
                                        id: model.model_id,
                                        name: model.name,
                                        variants: None,
                                        default_variant: None,
                                    })
                                    .collect::<Vec<_>>(),
                            ),
                            fallback.current_model_id,
                        )
                    }
                }
            } else {
                (None, None)
            };

            let modes = if installed {
                Some(extension_agent_modes_for(agent_id))
            } else {
                None
            };

            agents.push(AgentInfo {
                id: agent_id.as_str().to_string(),
                installed,
                credentials_available,
                version,
                path,
                capabilities,
                server_status,
                models,
                default_model,
                modes,
            });
        }

        let response = extension_to_value(AgentListResponse { agents })?;
        Ok(extension_result(id, response))
    }

    async fn agent_install_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, AGENT_INSTALL_METHOD)?;
        let params = extension_params(payload);
        let agent =
            extension_required_string(AGENT_INSTALL_METHOD, &params, &["agent"], "params.agent")?;
        let agent_id = AgentId::parse(&agent).ok_or_else(|| SandboxError::UnsupportedAgent {
            agent: agent.clone(),
        })?;
        let reinstall = extension_bool(&params, &["reinstall"]).unwrap_or(false);
        let version = extension_string(&params, &["agentVersion", "agent_version"]);
        let agent_process_version =
            extension_string(&params, &["agentProcessVersion", "agent_process_version"]);

        let manager = self.inner.agent_manager.clone();
        let install_result = tokio::task::spawn_blocking(move || {
            manager.install(
                agent_id,
                InstallOptions {
                    reinstall,
                    version,
                    agent_process_version,
                },
            )
        })
        .await
        .map_err(|err| SandboxError::InstallFailed {
            agent,
            stderr: Some(format!("installer task failed: {err}")),
        })?
        .map_err(|err| SandboxError::InstallFailed {
            agent: agent_id.as_str().to_string(),
            stderr: Some(err.to_string()),
        })?;

        let response = extension_to_value(extension_map_install_result(install_result))?;
        Ok(extension_result(id, response))
    }

    async fn session_list_extension_response(
        &self,
        payload: &Value,
    ) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, SESSION_LIST_METHOD)?;
        let sessions = self
            .list_sessions()
            .await
            .into_iter()
            .map(extension_map_runtime_session)
            .collect::<Vec<_>>();
        let response = extension_to_value(SessionListResponse { sessions })?;
        Ok(extension_result(id, response))
    }

    async fn session_get_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, SESSION_GET_METHOD)?;
        let params = extension_params(payload);
        let session_id = extension_required_string(
            SESSION_GET_METHOD,
            &params,
            &["sessionId", "session_id"],
            "params.sessionId",
        )?;
        let Some(session) = self.get_session(&session_id).await else {
            return Err(SandboxError::SessionNotFound { session_id });
        };
        let response = extension_to_value(extension_map_runtime_session(session))?;
        Ok(extension_result(id, response))
    }

    async fn fs_list_entries_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_LIST_ENTRIES_METHOD)?;
        let params = extension_params(payload);
        let path = extension_string(&params, &["path"]).unwrap_or_else(|| ".".to_string());
        let session_id = extension_string(&params, &["sessionId", "session_id"]);

        let target = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        let metadata = fs::metadata(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        if !metadata.is_dir() {
            return Err(SandboxError::InvalidRequest {
                message: format!("path is not a directory: {}", target.display()),
            });
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&target).map_err(|err| extension_map_fs_error(&target, err))? {
            let entry = entry.map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
            let entry_type = if metadata.is_dir() {
                FsEntryType::Directory
            } else {
                FsEntryType::File
            };
            let modified = metadata
                .modified()
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
            entries.push(FsEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                entry_type,
                size: metadata.len(),
                modified,
            });
        }

        Ok(extension_result(id, json!({ "entries": entries })))
    }

    async fn fs_read_file_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_READ_FILE_METHOD)?;
        let params = extension_params(payload);
        let path =
            extension_required_string(FS_READ_FILE_METHOD, &params, &["path"], "params.path")?;
        let session_id = extension_string(&params, &["sessionId", "session_id"]);
        let target = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        let metadata = fs::metadata(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        if !metadata.is_file() {
            return Err(SandboxError::InvalidRequest {
                message: format!("path is not a file: {}", target.display()),
            });
        }
        let bytes = fs::read(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        Ok(extension_result(
            id,
            json!({
                "path": target.to_string_lossy().to_string(),
                "size": bytes.len(),
                "contentBase64": BASE64_STANDARD.encode(bytes),
            }),
        ))
    }

    async fn fs_write_file_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_WRITE_FILE_METHOD)?;
        let params = extension_params(payload);
        let path =
            extension_required_string(FS_WRITE_FILE_METHOD, &params, &["path"], "params.path")?;
        let session_id = extension_string(&params, &["sessionId", "session_id"]);
        let content_base64 = extension_required_string(
            FS_WRITE_FILE_METHOD,
            &params,
            &["contentBase64", "content_base64"],
            "params.contentBase64",
        )?;
        let body =
            BASE64_STANDARD
                .decode(content_base64)
                .map_err(|err| SandboxError::InvalidRequest {
                    message: format!("{FS_WRITE_FILE_METHOD} invalid base64 content: {err}"),
                })?;

        let target = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|err| extension_map_fs_error(parent, err))?;
        }
        fs::write(&target, &body).map_err(|err| extension_map_fs_error(&target, err))?;

        let response = extension_to_value(FsWriteResponse {
            path: target.to_string_lossy().to_string(),
            bytes_written: body.len() as u64,
        })?;
        Ok(extension_result(id, response))
    }

    async fn fs_delete_entry_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_DELETE_ENTRY_METHOD)?;
        let params = extension_params(payload);
        let path =
            extension_required_string(FS_DELETE_ENTRY_METHOD, &params, &["path"], "params.path")?;
        let session_id = extension_string(&params, &["sessionId", "session_id"]);
        let recursive = extension_bool(&params, &["recursive"]).unwrap_or(false);

        let target = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        let metadata = fs::metadata(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        if metadata.is_dir() {
            if recursive {
                fs::remove_dir_all(&target).map_err(|err| extension_map_fs_error(&target, err))?;
            } else {
                fs::remove_dir(&target).map_err(|err| extension_map_fs_error(&target, err))?;
            }
        } else {
            fs::remove_file(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        }

        let response = extension_to_value(FsActionResponse {
            path: target.to_string_lossy().to_string(),
        })?;
        Ok(extension_result(id, response))
    }

    async fn fs_mkdir_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_MKDIR_METHOD)?;
        let params = extension_params(payload);
        let path = extension_required_string(FS_MKDIR_METHOD, &params, &["path"], "params.path")?;
        let session_id = extension_string(&params, &["sessionId", "session_id"]);

        let target = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        fs::create_dir_all(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        let response = extension_to_value(FsActionResponse {
            path: target.to_string_lossy().to_string(),
        })?;
        Ok(extension_result(id, response))
    }

    async fn fs_move_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_MOVE_METHOD)?;
        let params = extension_params(payload);
        let session_id = extension_string(&params, &["sessionId", "session_id"]);
        let from = extension_required_string(FS_MOVE_METHOD, &params, &["from"], "params.from")?;
        let to = extension_required_string(FS_MOVE_METHOD, &params, &["to"], "params.to")?;
        let overwrite = extension_bool(&params, &["overwrite"]).unwrap_or(false);

        let from = self
            .resolve_extension_fs_path(session_id.as_deref(), &from)
            .await?;
        let to = self
            .resolve_extension_fs_path(session_id.as_deref(), &to)
            .await?;

        if to.exists() {
            if overwrite {
                let metadata = fs::metadata(&to).map_err(|err| extension_map_fs_error(&to, err))?;
                if metadata.is_dir() {
                    fs::remove_dir_all(&to).map_err(|err| extension_map_fs_error(&to, err))?;
                } else {
                    fs::remove_file(&to).map_err(|err| extension_map_fs_error(&to, err))?;
                }
            } else {
                return Err(SandboxError::InvalidRequest {
                    message: format!("destination already exists: {}", to.display()),
                });
            }
        }

        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|err| extension_map_fs_error(parent, err))?;
        }
        fs::rename(&from, &to).map_err(|err| extension_map_fs_error(&from, err))?;

        let response = extension_to_value(FsMoveResponse {
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
        })?;
        Ok(extension_result(id, response))
    }

    async fn fs_stat_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_STAT_METHOD)?;
        let params = extension_params(payload);
        let path = extension_required_string(FS_STAT_METHOD, &params, &["path"], "params.path")?;
        let session_id = extension_string(&params, &["sessionId", "session_id"]);

        let target = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        let metadata = fs::metadata(&target).map_err(|err| extension_map_fs_error(&target, err))?;
        let entry_type = if metadata.is_dir() {
            FsEntryType::Directory
        } else {
            FsEntryType::File
        };
        let modified = metadata
            .modified()
            .ok()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
        let response = extension_to_value(FsStat {
            path: target.to_string_lossy().to_string(),
            entry_type,
            size: metadata.len(),
            modified,
        })?;
        Ok(extension_result(id, response))
    }

    async fn fs_upload_batch_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let id = extension_request_id(payload, FS_UPLOAD_BATCH_METHOD)?;
        let params = extension_params(payload);
        let path = extension_string(&params, &["path"]).unwrap_or_else(|| ".".to_string());
        let session_id = extension_string(&params, &["sessionId", "session_id"]);
        let content_base64 = extension_required_string(
            FS_UPLOAD_BATCH_METHOD,
            &params,
            &["contentBase64", "content_base64"],
            "params.contentBase64",
        )?;
        let body =
            BASE64_STANDARD
                .decode(content_base64)
                .map_err(|err| SandboxError::InvalidRequest {
                    message: format!("{FS_UPLOAD_BATCH_METHOD} invalid base64 content: {err}"),
                })?;

        let base = self
            .resolve_extension_fs_path(session_id.as_deref(), &path)
            .await?;
        fs::create_dir_all(&base).map_err(|err| extension_map_fs_error(&base, err))?;

        let mut archive = Archive::new(Cursor::new(body));
        let mut extracted = Vec::new();
        let mut truncated = false;

        for entry in archive.entries().map_err(|err| SandboxError::StreamError {
            message: err.to_string(),
        })? {
            let mut entry = entry.map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
            let entry_path = entry.path().map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;
            let clean_path = extension_sanitize_relative_path(&entry_path)?;
            if clean_path.as_os_str().is_empty() {
                continue;
            }
            let dest = base.join(&clean_path);
            if !dest.starts_with(&base) {
                return Err(SandboxError::InvalidRequest {
                    message: format!("tar entry escapes destination: {}", entry_path.display()),
                });
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|err| extension_map_fs_error(parent, err))?;
            }
            entry
                .unpack(&dest)
                .map_err(|err| SandboxError::StreamError {
                    message: err.to_string(),
                })?;
            if extracted.len() < 1024 {
                extracted.push(dest.to_string_lossy().to_string());
            } else {
                truncated = true;
            }
        }

        let response = extension_to_value(FsUploadBatchResponse {
            paths: extracted,
            truncated,
        })?;
        Ok(extension_result(id, response))
    }

    async fn resolve_extension_fs_path(
        &self,
        session_id: Option<&str>,
        raw_path: &str,
    ) -> Result<PathBuf, SandboxError> {
        let path = PathBuf::from(raw_path);
        if path.is_absolute() {
            return Ok(path);
        }
        let root = self.resolve_extension_fs_root(session_id).await?;
        let relative = extension_sanitize_relative_path(&path)?;
        Ok(root.join(relative))
    }

    async fn resolve_extension_fs_root(
        &self,
        session_id: Option<&str>,
    ) -> Result<PathBuf, SandboxError> {
        if let Some(session_id) = session_id {
            let session = self
                .inner
                .session_snapshot(session_id)
                .await
                .ok_or_else(|| SandboxError::SessionNotFound {
                    session_id: session_id.to_string(),
                })?;
            return Ok(PathBuf::from(session.cwd));
        }
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: "home directory unavailable".to_string(),
            })?;
        Ok(home)
    }

    async fn session_detach_response(
        &self,
        client_id: &str,
        payload: &Value,
    ) -> Result<Value, SandboxError> {
        let session_id = extract_session_id_from_payload(payload).ok_or_else(|| {
            SandboxError::InvalidRequest {
                message: format!("{SESSION_DETACH_METHOD} requires params.sessionId"),
            }
        })?;

        self.inner
            .detach_client_from_session(client_id, &session_id)
            .await;

        let id = payload
            .get("id")
            .cloned()
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: format!("{SESSION_DETACH_METHOD} request is missing id"),
            })?;

        Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }))
    }

    async fn session_detach_notification(
        &self,
        client_id: &str,
        payload: &Value,
    ) -> Result<(), SandboxError> {
        let session_id = extract_session_id_from_payload(payload).ok_or_else(|| {
            SandboxError::InvalidRequest {
                message: format!("{SESSION_DETACH_METHOD} requires params.sessionId"),
            }
        })?;

        self.inner
            .detach_client_from_session(client_id, &session_id)
            .await;
        Ok(())
    }

    async fn session_terminate_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        let session_id = extract_session_id_from_payload(payload).ok_or_else(|| {
            SandboxError::InvalidRequest {
                message: format!("{SESSION_TERMINATE_METHOD} requires params.sessionId"),
            }
        })?;
        let id = payload
            .get("id")
            .cloned()
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: format!("{SESSION_TERMINATE_METHOD} request is missing id"),
            })?;

        let terminated = self.terminate_session(&session_id).await?;
        Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "terminated": terminated,
                "alreadyEnded": !terminated,
                "reason": "terminated",
                "terminatedBy": "daemon"
            }
        }))
    }

    async fn session_terminate_notification(&self, payload: &Value) -> Result<(), SandboxError> {
        let session_id = extract_session_id_from_payload(payload).ok_or_else(|| {
            SandboxError::InvalidRequest {
                message: format!("{SESSION_TERMINATE_METHOD} requires params.sessionId"),
            }
        })?;
        let _ = self.terminate_session(&session_id).await?;
        Ok(())
    }

    async fn terminate_session(&self, session_id: &str) -> Result<bool, SandboxError> {
        let snapshot = self.inner.session_snapshot(session_id).await;
        let Some(session) = snapshot else {
            return Ok(false);
        };
        if session.ended {
            return Ok(false);
        }

        if let Ok(backend) = self.get_or_create_backend(session.agent).await {
            let cancel = json!({
                "jsonrpc": "2.0",
                "method": "session/cancel",
                "params": {
                    "sessionId": session_id
                }
            });
            let _ = backend.send(self.inner.clone(), cancel).await;
        }

        let ended = SessionEndedData {
            reason: SessionEndReason::Terminated,
            terminated_by: TerminatedBy::Daemon,
            message: None,
            exit_code: None,
            stderr: None,
        };

        if !self
            .inner
            .mark_session_ended(session_id, ended.clone())
            .await
        {
            return Ok(false);
        }
        self.inner.emit_session_ended(session_id, ended).await;
        Ok(true)
    }

    async fn session_set_metadata_response(&self, payload: &Value) -> Result<Value, SandboxError> {
        self.apply_set_metadata_payload(payload).await?;
        let id = payload
            .get("id")
            .cloned()
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: format!("{SESSION_SET_METADATA_METHOD} request is missing id"),
            })?;
        Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }))
    }

    async fn session_set_metadata_notification(&self, payload: &Value) -> Result<(), SandboxError> {
        self.apply_set_metadata_payload(payload).await
    }

    async fn apply_set_metadata_payload(&self, payload: &Value) -> Result<(), SandboxError> {
        let session_id = extract_session_id_from_payload(payload).ok_or_else(|| {
            SandboxError::InvalidRequest {
                message: format!("{SESSION_SET_METADATA_METHOD} requires params.sessionId"),
            }
        })?;

        let metadata = payload
            .get("params")
            .and_then(Value::as_object)
            .and_then(|params| {
                params
                    .get("metadata")
                    .and_then(Value::as_object)
                    .cloned()
                    .or_else(|| {
                        params
                            .get("_meta")
                            .and_then(Value::as_object)
                            .and_then(|meta| meta.get(SANDBOX_META_KEY))
                            .and_then(Value::as_object)
                            .cloned()
                    })
            })
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: format!(
                    "{SESSION_SET_METADATA_METHOD} requires params.metadata object or params._meta.{SANDBOX_META_KEY}"
                ),
            })?;

        self.inner
            .merge_session_metadata(&session_id, metadata)
            .await?;
        Ok(())
    }

    async fn session_list_models_response(
        &self,
        _connection: &AcpClient,
        payload: &Value,
    ) -> Result<Value, SandboxError> {
        let id = payload
            .get("id")
            .cloned()
            .ok_or_else(|| SandboxError::InvalidRequest {
                message: format!("{SESSION_LIST_MODELS_METHOD} request is missing id"),
            })?;

        let params = payload
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let explicit_agent = explicit_agent_param(payload)?;

        let agent = if let Some(session_id) = session_id.as_deref() {
            self.inner
                .session_agent(session_id)
                .await
                .or(explicit_agent)
                .ok_or_else(|| SandboxError::InvalidRequest {
                    message: format!(
                        "{SESSION_LIST_MODELS_METHOD} requires params.agent when sessionId '{session_id}' is unknown"
                    ),
                })?
        } else {
            explicit_agent.ok_or_else(|| SandboxError::InvalidRequest {
                message: format!(
                    "{SESSION_LIST_MODELS_METHOD} requires params.agent when params.sessionId is absent"
                ),
            })?
        };

        if self.inner.agent_manager.is_installed(agent) {
            let _ = self.refresh_models_from_backend(agent).await;
        }

        let snapshot = self
            .inner
            .get_models_for_agent(agent)
            .await
            .unwrap_or_else(|| fallback_models_for_agent(agent));
        let current_model_id = if let Some(session_id) = session_id.as_deref() {
            self.inner
                .session_model_hint(session_id)
                .await
                .or(snapshot.current_model_id.clone())
        } else {
            snapshot.current_model_id.clone()
        };

        let available_models = snapshot
            .available_models
            .iter()
            .map(|model| {
                json!({
                    "modelId": model.model_id,
                    "name": model.name,
                    "description": model.description,
                    "defaultVariant": model.default_variant,
                    "variants": model.variants,
                })
            })
            .collect::<Vec<_>>();

        Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "availableModels": available_models,
                "currentModelId": current_model_id,
            }
        }))
    }

    async fn refresh_models_from_backend(&self, agent: AgentId) -> Result<(), SandboxError> {
        let mut cursor: Option<String> = None;
        let mut models: Vec<AgentModelInfo> = Vec::new();
        let mut seen = HashSet::new();
        let mut default_model_id: Option<String> = None;

        for _ in 0..20 {
            let result = self
                .send_runtime_request(
                    agent,
                    "model/list",
                    json!({
                        "cursor": cursor,
                        "limit": Value::Null
                    }),
                )
                .await?;

            let data = result
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            for item in data {
                let model_id = item
                    .get("model")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("id").and_then(Value::as_str));
                let Some(model_id) = model_id else {
                    continue;
                };
                if !seen.insert(model_id.to_string()) {
                    continue;
                }
                let name = item
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| {
                        item.get("name")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    });

                if default_model_id.is_none()
                    && item
                        .get("isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    default_model_id = Some(model_id.to_string());
                }

                models.push(AgentModelInfo {
                    model_id: model_id.to_string(),
                    name,
                    description: None,
                    default_variant: None,
                    variants: Vec::new(),
                });
            }

            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if cursor.is_none() {
                break;
            }
        }

        if models.is_empty() {
            return Err(SandboxError::StreamError {
                message: "model/list returned no models".to_string(),
            });
        }

        models.sort_by(|left, right| left.model_id.cmp(&right.model_id));
        if default_model_id.is_none() {
            default_model_id = models.first().map(|entry| entry.model_id.clone());
        }

        self.inner
            .set_models_for_agent(
                agent,
                AgentModelSnapshot {
                    available_models: models,
                    current_model_id: default_model_id,
                },
            )
            .await;
        Ok(())
    }

    async fn send_runtime_request(
        &self,
        agent: AgentId,
        method: &str,
        params: Value,
    ) -> Result<Value, SandboxError> {
        let backend = self.get_or_create_backend(agent).await?;
        let request_id = format!(
            "runtime_req_{}",
            self.inner
                .next_backend_request_id
                .fetch_add(1, Ordering::SeqCst)
        );

        let (tx, rx) = oneshot::channel();
        self.inner.pending_runtime_responses.lock().await.insert(
            request_id.clone(),
            PendingRuntimeResponse { agent, sender: tx },
        );

        let payload = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });

        if let Err(err) = backend.send(self.inner.clone(), payload).await {
            self.inner
                .pending_runtime_responses
                .lock()
                .await
                .remove(&request_id);
            return Err(err);
        }

        tokio::time::timeout(self.inner.request_timeout, rx)
            .await
            .map_err(|_| SandboxError::Timeout {
                message: Some(format!("timed out waiting for {method} response")),
            })?
            .map_err(|_| SandboxError::StreamError {
                message: format!("runtime response channel closed for {method}"),
            })
            .and_then(|payload| {
                if let Some(error) = payload.get("error") {
                    return Err(SandboxError::StreamError {
                        message: format!("runtime request {method} failed: {error}"),
                    });
                }
                Ok(payload
                    .get("result")
                    .cloned()
                    .unwrap_or(Value::Object(Map::new())))
            })
    }
}

fn extension_request_id(payload: &Value, method: &str) -> Result<Value, SandboxError> {
    payload
        .get("id")
        .cloned()
        .ok_or_else(|| SandboxError::InvalidRequest {
            message: format!("{method} request is missing id"),
        })
}

fn extension_result(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn extension_params(payload: &Value) -> Map<String, Value> {
    payload
        .get("params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn extension_string(params: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| params.get(*key).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn extension_required_string(
    method: &str,
    params: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<String, SandboxError> {
    extension_string(params, keys).ok_or_else(|| SandboxError::InvalidRequest {
        message: format!("{method} requires {label}"),
    })
}

fn extension_bool(params: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| params.get(*key).and_then(Value::as_bool))
}

fn extension_to_value<T: serde::Serialize>(value: T) -> Result<Value, SandboxError> {
    serde_json::to_value(value).map_err(|err| SandboxError::StreamError {
        message: format!("failed to serialize extension result: {err}"),
    })
}

fn extension_map_runtime_session(session: SessionRuntimeInfo) -> SessionInfo {
    SessionInfo {
        session_id: session.session_id,
        agent: session.agent.as_str().to_string(),
        agent_mode: session
            .mode_hint
            .clone()
            .unwrap_or_else(|| "build".to_string()),
        permission_mode: session
            .sandbox_meta
            .get("permissionMode")
            .or_else(|| session.sandbox_meta.get("permission_mode"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "default".to_string()),
        model: session.model_hint,
        native_session_id: session
            .sandbox_meta
            .get("nativeSessionId")
            .or_else(|| session.sandbox_meta.get("native_session_id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        ended: session.ended,
        event_count: session.event_count,
        created_at: session.created_at,
        updated_at: session.updated_at,
        directory: Some(session.cwd),
        title: session.title,
        termination_info: session.ended_data.map(extension_map_termination_info),
    }
}

fn extension_map_termination_info(ended: SessionEndedData) -> TerminationInfo {
    let reason = match ended.reason {
        SessionEndReason::Completed => "completed",
        SessionEndReason::Error => "error",
        SessionEndReason::Terminated => "terminated",
    }
    .to_string();
    let terminated_by = match ended.terminated_by {
        TerminatedBy::Agent => "agent",
        TerminatedBy::Daemon => "daemon",
    }
    .to_string();
    TerminationInfo {
        reason,
        terminated_by,
        message: ended.message,
        exit_code: ended.exit_code,
        stderr: ended.stderr.map(|stderr| RouterStderrOutput {
            head: stderr.head,
            tail: stderr.tail,
            truncated: stderr.truncated,
            total_lines: stderr.total_lines,
        }),
    }
}

fn extension_map_server_status(status: &RuntimeServerStatus) -> ServerStatusInfo {
    let server_status = if status.running {
        ServerStatus::Running
    } else if status.last_error.is_some() {
        ServerStatus::Error
    } else {
        ServerStatus::Stopped
    };
    ServerStatusInfo {
        status: server_status,
        base_url: status.base_url.clone(),
        uptime_ms: status.uptime_ms.map(|value| value.max(0) as u64),
        restart_count: status.restart_count,
        last_error: status.last_error.clone(),
    }
}

fn extension_credentials_available_for(
    agent: AgentId,
    has_anthropic: bool,
    has_openai: bool,
) -> bool {
    match agent {
        AgentId::Claude | AgentId::Amp => has_anthropic,
        AgentId::Codex => has_openai,
        AgentId::Opencode => has_anthropic || has_openai,
        AgentId::Mock => true,
    }
}

fn extension_agent_capabilities_for(agent: AgentId) -> RouterAgentCapabilities {
    match agent {
        AgentId::Claude => RouterAgentCapabilities {
            plan_mode: false,
            permissions: true,
            questions: true,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: false,
            file_attachments: false,
            session_lifecycle: false,
            error_events: false,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: false,
            shared_process: false,
        },
        AgentId::Codex => RouterAgentCapabilities {
            plan_mode: true,
            permissions: true,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: true,
            status: true,
            command_execution: true,
            file_changes: true,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            shared_process: true,
        },
        AgentId::Opencode => RouterAgentCapabilities {
            plan_mode: false,
            permissions: false,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            shared_process: true,
        },
        AgentId::Amp => RouterAgentCapabilities {
            plan_mode: false,
            permissions: false,
            questions: false,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: false,
            file_attachments: false,
            session_lifecycle: false,
            error_events: true,
            reasoning: false,
            status: false,
            command_execution: false,
            file_changes: false,
            mcp_tools: true,
            streaming_deltas: false,
            item_started: false,
            shared_process: false,
        },
        AgentId::Mock => RouterAgentCapabilities {
            plan_mode: true,
            permissions: true,
            questions: true,
            tool_calls: true,
            tool_results: true,
            text_messages: true,
            images: true,
            file_attachments: true,
            session_lifecycle: true,
            error_events: true,
            reasoning: true,
            status: true,
            command_execution: true,
            file_changes: true,
            mcp_tools: true,
            streaming_deltas: true,
            item_started: true,
            shared_process: false,
        },
    }
}

fn extension_agent_modes_for(agent: AgentId) -> Vec<RouterAgentModeInfo> {
    match agent {
        AgentId::Opencode => vec![
            RouterAgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            RouterAgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Planning mode".to_string(),
            },
            RouterAgentModeInfo {
                id: "custom".to_string(),
                name: "Custom".to_string(),
                description: "Any user-defined OpenCode agent name".to_string(),
            },
        ],
        AgentId::Codex => vec![
            RouterAgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            RouterAgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Planning mode via prompt prefix".to_string(),
            },
        ],
        AgentId::Claude => vec![
            RouterAgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Default build mode".to_string(),
            },
            RouterAgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Plan mode (prompt-only)".to_string(),
            },
        ],
        AgentId::Amp => vec![RouterAgentModeInfo {
            id: "build".to_string(),
            name: "Build".to_string(),
            description: "Default build mode".to_string(),
        }],
        AgentId::Mock => vec![
            RouterAgentModeInfo {
                id: "build".to_string(),
                name: "Build".to_string(),
                description: "Mock agent for UI testing".to_string(),
            },
            RouterAgentModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: "Plan-only mock mode".to_string(),
            },
        ],
    }
}

fn extension_map_install_result(result: InstallResult) -> AgentInstallResponse {
    AgentInstallResponse {
        already_installed: result.already_installed,
        artifacts: result
            .artifacts
            .into_iter()
            .map(|artifact| AgentInstallArtifact {
                kind: extension_map_artifact_kind(artifact.kind),
                path: artifact.path.to_string_lossy().to_string(),
                source: extension_map_install_source(artifact.source),
                version: artifact.version,
            })
            .collect(),
    }
}

fn extension_map_install_source(source: InstallSource) -> String {
    match source {
        InstallSource::Registry => "registry",
        InstallSource::Fallback => "fallback",
        InstallSource::LocalPath => "local_path",
        InstallSource::Builtin => "builtin",
    }
    .to_string()
}

fn extension_map_artifact_kind(kind: InstalledArtifactKind) -> String {
    match kind {
        InstalledArtifactKind::NativeAgent => "native_agent",
        InstalledArtifactKind::AgentProcess => "agent_process",
    }
    .to_string()
}

fn extension_map_fs_error(path: &Path, err: std::io::Error) -> SandboxError {
    if err.kind() == std::io::ErrorKind::NotFound {
        SandboxError::InvalidRequest {
            message: format!("path not found: {}", path.display()),
        }
    } else {
        SandboxError::StreamError {
            message: err.to_string(),
        }
    }
}

fn extension_sanitize_relative_path(path: &Path) -> Result<PathBuf, SandboxError> {
    use std::path::Component;
    let mut sanitized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => sanitized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SandboxError::InvalidRequest {
                    message: format!("invalid relative path: {}", path.display()),
                });
            }
        }
    }
    Ok(sanitized)
}
