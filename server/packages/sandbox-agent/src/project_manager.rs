use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use sandbox_agent_error::SandboxError;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ProjectIcon {
    pub(crate) url: Option<String>,
    pub(crate) override_name: Option<String>,
    pub(crate) color: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ProjectCommands {
    pub(crate) start: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) worktree: String,
    pub(crate) directory: String,
    pub(crate) branch: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) icon: Option<ProjectIcon>,
    pub(crate) commands: Option<ProjectCommands>,
}

#[derive(Clone, Debug)]
pub(crate) struct WorktreeInfo {
    pub(crate) name: String,
    pub(crate) branch: String,
    pub(crate) directory: String,
}

#[derive(Clone, Debug, Default)]
struct ProjectState {
    projects_by_id: HashMap<String, ProjectRecord>,
    project_id_by_root: HashMap<String, String>,
}

#[derive(Clone, Debug)]
struct ProjectRecord {
    id: String,
    root: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    icon: Option<ProjectIcon>,
    commands: Option<ProjectCommands>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ProjectUpdate {
    pub(crate) name: Option<String>,
    pub(crate) icon: Option<ProjectIcon>,
    pub(crate) commands: Option<ProjectCommands>,
}

pub(crate) struct ProjectManager {
    state: Mutex<ProjectState>,
    next_project_id: AtomicU64,
    next_worktree_id: AtomicU64,
}

impl ProjectManager {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(ProjectState::default()),
            next_project_id: AtomicU64::new(1),
            next_worktree_id: AtomicU64::new(1),
        }
    }

    pub(crate) async fn resolve_project(&self, directory: &str) -> Result<ProjectInfo, SandboxError> {
        let repo_root = resolve_repo_root(directory).await?;
        let repo_root = canonicalize_path(&repo_root).await.unwrap_or(repo_root);
        let repo_root_str = repo_root.to_string_lossy().to_string();
        let now = now_ms();

        let mut state = self.state.lock().await;
        let project_id = if let Some(existing_id) = state.project_id_by_root.get(&repo_root_str) {
            existing_id.clone()
        } else {
            let id = format!("proj_{}", self.next_project_id.fetch_add(1, Ordering::Relaxed));
            state
                .project_id_by_root
                .insert(repo_root_str.clone(), id.clone());
            let name = repo_root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("project")
                .to_string();
            state.projects_by_id.insert(
                id.clone(),
                ProjectRecord {
                    id: id.clone(),
                    root: repo_root_str.clone(),
                    name,
                    created_at: now,
                    updated_at: now,
                    icon: None,
                    commands: None,
                },
            );
            id
        };

        let record = state
            .projects_by_id
            .get_mut(&project_id)
            .expect("project record missing");
        record.updated_at = now;
        let branch = current_branch(directory).await.unwrap_or_else(|| "main".to_string());

        Ok(ProjectInfo {
            id: record.id.clone(),
            name: record.name.clone(),
            worktree: record.root.clone(),
            directory: directory.to_string(),
            branch,
            created_at: record.created_at,
            updated_at: record.updated_at,
            icon: record.icon.clone(),
            commands: record.commands.clone(),
        })
    }

    pub(crate) async fn list_projects(&self, directory: &str) -> Result<Vec<ProjectInfo>, SandboxError> {
        let _ = self.resolve_project(directory).await?;
        let state = self.state.lock().await;
        let mut projects = Vec::new();
        for record in state.projects_by_id.values() {
            let branch = current_branch(&record.root)
                .await
                .unwrap_or_else(|| "main".to_string());
            projects.push(ProjectInfo {
                id: record.id.clone(),
                name: record.name.clone(),
                worktree: record.root.clone(),
                directory: record.root.clone(),
                branch,
                created_at: record.created_at,
                updated_at: record.updated_at,
                icon: record.icon.clone(),
                commands: record.commands.clone(),
            });
        }
        Ok(projects)
    }

    pub(crate) async fn update_project(
        &self,
        project_id: &str,
        update: ProjectUpdate,
    ) -> Result<ProjectInfo, SandboxError> {
        let now = now_ms();
        let mut state = self.state.lock().await;
        let record = state
            .projects_by_id
            .get_mut(project_id)
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: project_id.to_string(),
            })?;

        if let Some(name) = update.name {
            record.name = name;
        }
        if let Some(icon) = update.icon {
            record.icon = Some(icon);
        }
        if let Some(commands) = update.commands {
            record.commands = Some(commands);
        }
        record.updated_at = now;

        let branch = current_branch(&record.root)
            .await
            .unwrap_or_else(|| "main".to_string());

        Ok(ProjectInfo {
            id: record.id.clone(),
            name: record.name.clone(),
            worktree: record.root.clone(),
            directory: record.root.clone(),
            branch,
            created_at: record.created_at,
            updated_at: record.updated_at,
            icon: record.icon.clone(),
            commands: record.commands.clone(),
        })
    }

    pub(crate) async fn list_worktrees(&self, directory: &str) -> Result<Vec<String>, SandboxError> {
        let repo_root = resolve_repo_root(directory).await?;
        list_git_worktrees(&repo_root).await
    }

    pub(crate) async fn create_worktree(
        &self,
        directory: &str,
        name: Option<String>,
    ) -> Result<WorktreeInfo, SandboxError> {
        let repo_root = resolve_repo_root(directory).await?;
        let repo_root = canonicalize_path(&repo_root).await.unwrap_or(repo_root);
        let default_branch = default_branch(&repo_root).await.unwrap_or_else(|| "main".to_string());
        let raw_name = name.unwrap_or_else(|| {
            let id = self.next_worktree_id.fetch_add(1, Ordering::Relaxed);
            format!("worktree-{id}")
        });
        let sanitized_name = sanitize_name(&raw_name);
        if sanitized_name.is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "worktree name is required".to_string(),
            });
        }

        let base_dir = repo_root.join(".opencode").join("worktrees");
        let worktree_dir = base_dir.join(&sanitized_name);
        if worktree_dir.exists() {
            return Err(SandboxError::InvalidRequest {
                message: format!("worktree directory already exists: {}", worktree_dir.display()),
            });
        }
        tokio::fs::create_dir_all(&base_dir)
            .await
            .map_err(|err| SandboxError::InvalidRequest {
                message: format!("failed to create worktree directory: {err}"),
            })?;

        let branch = sanitized_name.clone();
        let args = vec![
            "worktree".to_string(),
            "add".to_string(),
            "-b".to_string(),
            branch.clone(),
            worktree_dir.to_string_lossy().to_string(),
            default_branch,
        ];
        let _ = run_git_command(&repo_root, &args).await?;

        Ok(WorktreeInfo {
            name: sanitized_name,
            branch,
            directory: worktree_dir.to_string_lossy().to_string(),
        })
    }

    pub(crate) async fn remove_worktree(
        &self,
        target_directory: &str,
    ) -> Result<(), SandboxError> {
        let target_path = PathBuf::from(target_directory);
        if !target_path.exists() {
            return Err(SandboxError::InvalidRequest {
                message: format!("worktree directory does not exist: {}", target_directory),
            });
        }
        let branch = current_branch(&target_path)
            .await
            .unwrap_or_else(|| "".to_string());
        let repo_root = resolve_repo_root(&target_directory).await?;
        let args = vec![
            "worktree".to_string(),
            "remove".to_string(),
            "--force".to_string(),
            target_directory.to_string(),
        ];
        let _ = run_git_command(&repo_root, &args).await?;

        let default_branch = default_branch(&repo_root).await.unwrap_or_else(|| "main".to_string());
        if !branch.is_empty() && branch != "HEAD" && branch != default_branch {
            let delete_args = vec![
                "branch".to_string(),
                "-D".to_string(),
                branch,
            ];
            let _ = run_git_command(&repo_root, &delete_args).await;
        }

        Ok(())
    }

    pub(crate) async fn reset_worktree(
        &self,
        target_directory: &str,
    ) -> Result<(), SandboxError> {
        let repo_root = resolve_repo_root(&target_directory).await?;
        let default_branch = default_branch(&repo_root).await.unwrap_or_else(|| "main".to_string());
        let args = vec![
            "reset".to_string(),
            "--hard".to_string(),
            default_branch,
        ];
        let _ = run_git_command(Path::new(target_directory), &args).await?;
        Ok(())
    }
}

fn sanitize_name(name: &str) -> String {
    let mut sanitized = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch);
        } else if ch.is_ascii_whitespace() || ch == '/' {
            sanitized.push('-');
        }
    }
    while sanitized.contains("--") {
        sanitized = sanitized.replace("--", "-");
    }
    sanitized.trim_matches('-').to_string()
}

async fn resolve_repo_root(directory: &str) -> Result<PathBuf, SandboxError> {
    let output = run_git_command(Path::new(directory), &[
        "rev-parse".to_string(),
        "--show-toplevel".to_string(),
    ])
    .await?;
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "unable to resolve git worktree".to_string(),
        });
    }
    Ok(PathBuf::from(trimmed))
}

async fn list_git_worktrees(repo_root: &Path) -> Result<Vec<String>, SandboxError> {
    let output = run_git_command(
        repo_root,
        &[
            "worktree".to_string(),
            "list".to_string(),
            "--porcelain".to_string(),
        ],
    )
    .await?;
    let mut worktrees = Vec::new();
    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            worktrees.push(path.trim().to_string());
        }
    }
    Ok(worktrees)
}

async fn current_branch(directory: impl AsRef<Path>) -> Option<String> {
    let output = run_git_command(
        directory.as_ref(),
        &[
            "rev-parse".to_string(),
            "--abbrev-ref".to_string(),
            "HEAD".to_string(),
        ],
    )
    .await
    .ok()?;
    let trimmed = output.trim();
    if trimmed.is_empty() || trimmed == "HEAD" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn default_branch(repo_root: &Path) -> Option<String> {
    let output = run_git_command(
        repo_root,
        &[
            "symbolic-ref".to_string(),
            "--short".to_string(),
            "refs/remotes/origin/HEAD".to_string(),
        ],
    )
    .await
    .ok();
    if let Some(output) = output {
        let trimmed = output.trim();
        if let Some((_, branch)) = trimmed.split_once('/') {
            return Some(branch.to_string());
        }
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    current_branch(repo_root).await
}

async fn run_git_command(directory: &Path, args: &[String]) -> Result<String, SandboxError> {
    let directory = directory.to_path_buf();
    let args = args.to_vec();
    let output = tokio::task::spawn_blocking(move || Command::new("git").args(&args).current_dir(directory).output())
        .await
        .map_err(|err| SandboxError::InvalidRequest {
            message: format!("git command failed: {err}"),
        })
        .and_then(|result| result.map_err(|err| SandboxError::InvalidRequest {
            message: format!("git command failed: {err}"),
        }))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(SandboxError::InvalidRequest {
            message: if stderr.is_empty() {
                "git command failed".to_string()
            } else {
                stderr
            },
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn canonicalize_path(path: &Path) -> Option<PathBuf> {
    tokio::task::spawn_blocking(move || std::fs::canonicalize(path))
        .await
        .ok()?
        .ok()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
