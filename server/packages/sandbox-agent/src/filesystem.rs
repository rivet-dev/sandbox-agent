use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use mime_guess::MimeGuess;
use serde::Serialize;

use sandbox_agent_error::SandboxError;

#[derive(Debug, Clone, Copy)]
pub(crate) struct FileReadRange {
    pub start: Option<u64>,
    pub end: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct FileReadOptions {
    pub path: String,
    pub range: Option<FileReadRange>,
}

#[derive(Debug, Clone)]
pub(crate) struct FileListOptions {
    pub path: String,
    pub glob: Option<String>,
    pub depth: Option<usize>,
    pub include_hidden: bool,
    pub directories_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileNode {
    pub name: String,
    pub path: String,
    pub absolute: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub ignored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceVcsStatus {
    pub status: String,
    pub added: i64,
    pub removed: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileStatus {
    pub path: String,
    pub exists: bool,
    #[serde(rename = "type")]
    pub entry_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcs: Option<WorkspaceVcsStatus>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct WorkspaceFilesystemService;

impl WorkspaceFilesystemService {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) fn scoped(
        &self,
        root: impl Into<PathBuf>,
    ) -> Result<WorkspaceFilesystem, SandboxError> {
        WorkspaceFilesystem::new(root.into())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct WorkspaceFilesystem {
    root: PathBuf,
}

impl WorkspaceFilesystem {
    fn new(root: PathBuf) -> Result<Self, SandboxError> {
        let root = fs::canonicalize(&root).unwrap_or(root);
        if !root.exists() {
            return Err(SandboxError::InvalidRequest {
                message: "workspace root does not exist".to_string(),
            });
        }
        if !root.is_dir() {
            return Err(SandboxError::InvalidRequest {
                message: "workspace root is not a directory".to_string(),
            });
        }
        Ok(Self { root })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn list(
        &self,
        options: FileListOptions,
    ) -> Result<Vec<WorkspaceFileNode>, SandboxError> {
        let path = options.path.trim();
        if path.is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "path is required".to_string(),
            });
        }
        let directory = self.resolve_path(path, false)?;
        let metadata = fs::metadata(&directory).map_err(|err| SandboxError::InvalidRequest {
            message: format!("failed to access directory: {err}"),
        })?;
        if !metadata.is_dir() {
            return Err(SandboxError::InvalidRequest {
                message: "path is not a directory".to_string(),
            });
        }

        let matcher = build_glob_matcher(options.glob.as_deref())?;
        let max_depth = options.depth.unwrap_or(1);
        let mut queue = VecDeque::new();
        let mut entries = Vec::new();
        queue.push_back((directory, 0usize));

        while let Some((current_dir, depth)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            let read_dir =
                fs::read_dir(&current_dir).map_err(|err| SandboxError::InvalidRequest {
                    message: format!("failed to read directory: {err}"),
                })?;

            for entry in read_dir {
                let entry = entry.map_err(|err| SandboxError::InvalidRequest {
                    message: format!("failed to read directory entry: {err}"),
                })?;
                let file_name = entry.file_name();
                let name = file_name.to_string_lossy().to_string();
                if !options.include_hidden && name.starts_with('.') {
                    continue;
                }
                let file_type = entry
                    .file_type()
                    .map_err(|err| SandboxError::InvalidRequest {
                        message: format!("failed to read file type: {err}"),
                    })?;
                let entry_path = entry.path();

                if file_type.is_dir() && !options.include_hidden && is_hidden_dir(&entry_path) {
                    continue;
                }

                let relative_path = path_relative_to_root(&self.root, &entry_path)?;
                if let Some(matcher) = matcher.as_ref() {
                    if !matcher.is_match(relative_path.as_str()) {
                        if file_type.is_dir() {
                            if depth + 1 < max_depth {
                                queue.push_back((entry_path.clone(), depth + 1));
                            }
                        }
                        continue;
                    }
                }

                if options.directories_only && !file_type.is_dir() {
                    continue;
                }

                let entry_type = if file_type.is_dir() {
                    "directory"
                } else {
                    "file"
                };

                entries.push(WorkspaceFileNode {
                    name,
                    path: relative_path,
                    absolute: entry_path.to_string_lossy().to_string(),
                    entry_type: entry_type.to_string(),
                    ignored: false,
                });

                if file_type.is_dir() && depth + 1 < max_depth {
                    queue.push_back((entry_path, depth + 1));
                }
            }
        }

        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    pub(crate) fn read(
        &self,
        options: FileReadOptions,
    ) -> Result<WorkspaceFileContent, SandboxError> {
        let path = options.path.trim();
        if path.is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "path is required".to_string(),
            });
        }
        let file_path = self.resolve_path(path, false)?;
        let metadata = fs::metadata(&file_path).map_err(|err| SandboxError::InvalidRequest {
            message: format!("failed to access file: {err}"),
        })?;
        if !metadata.is_file() {
            return Err(SandboxError::InvalidRequest {
                message: "path is not a file".to_string(),
            });
        }
        let mut bytes = fs::read(&file_path).map_err(|err| SandboxError::InvalidRequest {
            message: format!("failed to read file: {err}"),
        })?;

        if let Some(range) = options.range {
            bytes = apply_byte_range(bytes, range)?;
        }

        let mime = MimeGuess::from_path(&file_path)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        if let Ok(text) = String::from_utf8(bytes.clone()) {
            return Ok(WorkspaceFileContent {
                content_type: "text".to_string(),
                content: text,
                encoding: None,
                mime_type: Some(mime),
            });
        }

        Ok(WorkspaceFileContent {
            content_type: "binary".to_string(),
            content: STANDARD.encode(bytes),
            encoding: Some("base64".to_string()),
            mime_type: Some(mime),
        })
    }

    pub(crate) fn status(&self) -> Result<Vec<WorkspaceFileStatus>, SandboxError> {
        if !self.root.join(".git").exists() {
            return Ok(Vec::new());
        }
        let output = Command::new("git")
            .arg("status")
            .arg("--porcelain=v1")
            .arg("-z")
            .current_dir(&self.root)
            .output()
            .map_err(|err| SandboxError::StreamError {
                message: format!("failed to run git status: {err}"),
            })?;
        if !output.status.success() {
            return Err(SandboxError::StreamError {
                message: format!("git status failed: {}", output.status),
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut entries = Vec::new();
        for record in stdout.split('\0').filter(|line| !line.is_empty()) {
            let (status_code, path) = parse_git_porcelain_entry(record);
            let Some(path) = path else {
                continue;
            };
            let status = map_git_status(status_code);
            let absolute = self.root.join(&path);
            let (exists, entry_type, size, modified) = file_metadata(&absolute);
            entries.push(WorkspaceFileStatus {
                path,
                exists,
                entry_type,
                size,
                modified,
                vcs: Some(WorkspaceVcsStatus {
                    status,
                    added: 0,
                    removed: 0,
                }),
            });
        }

        Ok(entries)
    }

    fn resolve_path(&self, input: &str, allow_missing: bool) -> Result<PathBuf, SandboxError> {
        let input_path = PathBuf::from(input);
        if input_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(SandboxError::InvalidRequest {
                message: "path traversal is not allowed".to_string(),
            });
        }

        let joined = if input_path.is_absolute() {
            input_path
        } else {
            self.root.join(input_path)
        };

        let normalized = if allow_missing {
            normalize_path(&joined)
        } else {
            fs::canonicalize(&joined).unwrap_or(joined.clone())
        };

        if !normalized.starts_with(&self.root) {
            return Err(SandboxError::InvalidRequest {
                message: "path is outside the workspace".to_string(),
            });
        }

        Ok(normalized)
    }
}

fn build_glob_matcher(glob: Option<&str>) -> Result<Option<GlobSet>, SandboxError> {
    let Some(pattern) = glob else {
        return Ok(None);
    };
    let mut builder = GlobSetBuilder::new();
    let glob = GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|err| SandboxError::InvalidRequest {
            message: format!("invalid glob pattern: {err}"),
        })?;
    builder.add(glob);
    let set = builder
        .build()
        .map_err(|err| SandboxError::InvalidRequest {
            message: format!("invalid glob matcher: {err}"),
        })?;
    Ok(Some(set))
}

fn apply_byte_range(bytes: Vec<u8>, range: FileReadRange) -> Result<Vec<u8>, SandboxError> {
    let len = bytes.len() as u64;
    let start = range.start.unwrap_or(0);
    let end = range.end.unwrap_or(len);
    if start > end || end > len {
        return Err(SandboxError::InvalidRequest {
            message: "invalid byte range".to_string(),
        });
    }
    Ok(bytes[start as usize..end as usize].to_vec())
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    normalized
}

fn path_relative_to_root(root: &Path, path: &Path) -> Result<String, SandboxError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| SandboxError::InvalidRequest {
            message: "path is outside the workspace".to_string(),
        })?;
    Ok(relative.to_string_lossy().to_string())
}

fn is_hidden_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
}

fn file_metadata(path: &Path) -> (bool, String, Option<u64>, Option<i64>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (false, "file".to_string(), None, None);
    };
    let entry_type = if metadata.is_dir() {
        "directory"
    } else {
        "file"
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    (true, entry_type.to_string(), Some(metadata.len()), modified)
}

fn parse_git_porcelain_entry(entry: &str) -> (&str, Option<String>) {
    if entry.len() < 3 {
        return ("", None);
    }
    let status = &entry[0..2];
    let path = entry[3..].trim();
    if path.is_empty() {
        return (status, None);
    }
    if let Some((_, new_path)) = path.split_once(" -> ") {
        return (status, Some(new_path.to_string()));
    }
    (status, Some(path.to_string()))
}

fn map_git_status(status: &str) -> String {
    if status.contains('D') {
        return "deleted".to_string();
    }
    if status.contains('A') || status.contains('?') {
        return "added".to_string();
    }
    "modified".to_string()
}
