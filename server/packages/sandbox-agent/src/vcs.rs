use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use sandbox_agent_error::SandboxError;

#[derive(Debug, Clone)]
pub struct VcsStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_files: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum VcsFileStatus {
    Added,
    Deleted,
    Modified,
}

#[derive(Debug, Clone)]
pub struct VcsFileDiff {
    pub file: String,
    pub before: String,
    pub after: String,
    pub additions: u32,
    pub deletions: u32,
    pub status: VcsFileStatus,
}

#[derive(Debug, Clone)]
pub struct VcsFileSummary {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub status: VcsFileStatus,
}

#[derive(Debug, Clone)]
struct StatusEntry {
    status: String,
    path: String,
}

#[derive(Debug, Clone)]
struct BranchInfo {
    branch: String,
    ahead: u32,
    behind: u32,
}

#[derive(Debug, Clone)]
struct VcsStashInfo {
    repo_root: PathBuf,
    stash_ref: String,
}

#[derive(Debug, Default)]
pub struct VcsService {
    stashes: Mutex<HashMap<String, VcsStashInfo>>,
}

impl VcsService {
    pub fn new() -> Self {
        Self {
            stashes: Mutex::new(HashMap::new()),
        }
    }

    pub fn discover_repo(&self, directory: &str) -> Option<PathBuf> {
        let root = run_git(Path::new(directory), &["rev-parse", "--show-toplevel"]).ok()?;
        let root = root.trim();
        if root.is_empty() {
            return None;
        }
        Some(PathBuf::from(root))
    }

    pub fn status(&self, directory: &str) -> Option<VcsStatus> {
        let repo_root = self.discover_repo(directory)?;
        let (branch_info, entries) = status_entries(&repo_root)?;
        let branch_info = branch_info.unwrap_or_else(|| BranchInfo {
            branch: "HEAD".to_string(),
            ahead: 0,
            behind: 0,
        });
        let dirty_files = entries.into_iter().map(|entry| entry.path).collect();
        Some(VcsStatus {
            branch: branch_info.branch,
            ahead: branch_info.ahead,
            behind: branch_info.behind,
            dirty_files,
        })
    }

    pub fn diff(&self, directory: &str) -> Option<Vec<VcsFileDiff>> {
        let repo_root = self.discover_repo(directory)?;
        let (_branch, entries) = status_entries(&repo_root)?;
        let mut diffs = Vec::new();
        for entry in entries {
            let status = status_from_codes(&entry.status);
            let before = match status {
                VcsFileStatus::Added => String::new(),
                VcsFileStatus::Deleted | VcsFileStatus::Modified => {
                    git_show_file(&repo_root, &entry.path).unwrap_or_default()
                }
            };
            let after = match status {
                VcsFileStatus::Deleted => String::new(),
                VcsFileStatus::Added | VcsFileStatus::Modified => {
                    read_file(&repo_root, &entry.path).unwrap_or_default()
                }
            };
            let (additions, deletions) = match numstat_for_file(&repo_root, &entry.path) {
                Some((adds, dels)) => (adds, dels),
                None => match status {
                    VcsFileStatus::Added => (count_lines(&after), 0),
                    VcsFileStatus::Deleted => (0, count_lines(&before)),
                    VcsFileStatus::Modified => (count_lines(&after), count_lines(&before)),
                },
            };
            diffs.push(VcsFileDiff {
                file: entry.path,
                before,
                after,
                additions,
                deletions,
                status,
            });
        }
        Some(diffs)
    }

    pub fn diff_text(&self, directory: &str) -> Option<String> {
        let repo_root = self.discover_repo(directory)?;
        run_git(&repo_root, &["diff", "HEAD"]).ok()
    }

    pub fn file_status(&self, directory: &str) -> Option<Vec<VcsFileSummary>> {
        let repo_root = self.discover_repo(directory)?;
        let (_branch, entries) = status_entries(&repo_root)?;
        let mut summaries = Vec::new();
        for entry in entries {
            let status = status_from_codes(&entry.status);
            let (added, removed) = match numstat_for_file(&repo_root, &entry.path) {
                Some((adds, dels)) => (adds, dels),
                None => match status {
                    VcsFileStatus::Added => {
                        let after = read_file(&repo_root, &entry.path).unwrap_or_default();
                        (count_lines(&after), 0)
                    }
                    VcsFileStatus::Deleted => {
                        let before = git_show_file(&repo_root, &entry.path).unwrap_or_default();
                        (0, count_lines(&before))
                    }
                    VcsFileStatus::Modified => (0, 0),
                },
            };
            summaries.push(VcsFileSummary {
                path: entry.path,
                added,
                removed,
                status,
            });
        }
        Some(summaries)
    }

    pub fn revert(&self, directory: &str, session_id: &str) -> Result<bool, SandboxError> {
        let repo_root = match self.discover_repo(directory) {
            Some(root) => root,
            None => return Ok(false),
        };
        let key = stash_key(&repo_root, session_id);
        {
            let stashes = self.stashes.lock().unwrap();
            if stashes.contains_key(&key) {
                return Ok(true);
            }
        }

        let message = format!("sandbox-agent:session:{session_id}:revert");
        let output = run_git(&repo_root, &["stash", "push", "-u", "-m", &message])?;
        if output.contains("No local changes to save") {
            return Ok(false);
        }
        let stash_ref = find_stash_ref(&repo_root, &message)?;
        let mut stashes = self.stashes.lock().unwrap();
        stashes.insert(
            key,
            VcsStashInfo {
                repo_root,
                stash_ref,
            },
        );
        Ok(true)
    }

    pub fn unrevert(&self, directory: &str, session_id: &str) -> Result<bool, SandboxError> {
        let repo_root = match self.discover_repo(directory) {
            Some(root) => root,
            None => return Ok(false),
        };
        let key = stash_key(&repo_root, session_id);
        let stash = {
            let mut stashes = self.stashes.lock().unwrap();
            stashes.remove(&key)
        };
        let Some(stash) = stash else {
            return Ok(false);
        };
        run_git(&stash.repo_root, &["stash", "apply", &stash.stash_ref])?;
        let _ = run_git(&stash.repo_root, &["stash", "drop", &stash.stash_ref]);
        Ok(true)
    }
}

fn stash_key(repo_root: &Path, session_id: &str) -> String {
    format!("{}::{}", repo_root.display(), session_id)
}

fn run_git(directory: &Path, args: &[&str]) -> Result<String, SandboxError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .map_err(|err| SandboxError::InvalidRequest {
            message: format!("git execution failed: {err}"),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SandboxError::InvalidRequest {
            message: format!("git command failed: {stderr}"),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn status_entries(repo_root: &Path) -> Option<(Option<BranchInfo>, Vec<StatusEntry>)> {
    let output = run_git(repo_root, &["status", "--porcelain=v1", "-b", "-z"]).ok()?;
    let mut entries = Vec::new();
    let mut branch_info = None;
    let mut iter = output.split_terminator('\0');
    while let Some(entry) = iter.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(info) = parse_branch_line(entry) {
            branch_info = Some(info);
            continue;
        }
        if entry.len() < 3 {
            continue;
        }
        let status = entry[..2].to_string();
        let mut path = entry[3..].to_string();
        if status.starts_with('R') || status.starts_with('C') {
            if let Some(new_path) = iter.next() {
                path = new_path.to_string();
            }
        }
        entries.push(StatusEntry { status, path });
    }
    Some((branch_info, entries))
}

fn parse_branch_line(line: &str) -> Option<BranchInfo> {
    if !line.starts_with("## ") {
        return None;
    }
    let line = line.trim_start_matches("## ").trim();
    let mut branch = line;
    let mut ahead = 0;
    let mut behind = 0;
    if let Some((name, rest)) = line.split_once("...") {
        branch = name;
        if let Some((start, end)) = rest.find('[').zip(rest.find(']')) {
            let stats = &rest[start + 1..end];
            for part in stats.split(',') {
                let part = part.trim();
                if let Some(count) = part.strip_prefix("ahead ") {
                    ahead = count.parse::<u32>().unwrap_or(0);
                } else if let Some(count) = part.strip_prefix("behind ") {
                    behind = count.parse::<u32>().unwrap_or(0);
                }
            }
        }
    }
    if branch.starts_with("HEAD") {
        branch = "HEAD";
    }
    Some(BranchInfo {
        branch: branch.to_string(),
        ahead,
        behind,
    })
}

fn status_from_codes(status: &str) -> VcsFileStatus {
    let bytes = status.as_bytes();
    if bytes.len() < 2 {
        return VcsFileStatus::Modified;
    }
    let index = bytes[0] as char;
    let worktree = bytes[1] as char;
    if index == 'A' || worktree == 'A' || index == '?' || worktree == '?' {
        VcsFileStatus::Added
    } else if index == 'D' || worktree == 'D' {
        VcsFileStatus::Deleted
    } else {
        VcsFileStatus::Modified
    }
}

fn git_show_file(repo_root: &Path, path: &str) -> Option<String> {
    let output = run_git(repo_root, &["show", &format!("HEAD:{path}")]).ok()?;
    Some(output)
}

fn read_file(repo_root: &Path, path: &str) -> Option<String> {
    let full_path = repo_root.join(path);
    let bytes = std::fs::read(full_path).ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn numstat_for_file(repo_root: &Path, path: &str) -> Option<(u32, u32)> {
    let output = run_git(repo_root, &["diff", "--numstat", "HEAD", "--", path]).ok()?;
    let line = output.lines().next()?;
    let mut parts = line.split('\t');
    let adds = parts.next()?;
    let dels = parts.next()?;
    let parse_field = |value: &str| -> Option<u32> {
        if value == "-" {
            Some(0)
        } else {
            value.parse::<u32>().ok()
        }
    };
    Some((parse_field(adds)?, parse_field(dels)?))
}

fn count_lines(text: &str) -> u32 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as u32
    }
}

fn find_stash_ref(repo_root: &Path, message: &str) -> Result<String, SandboxError> {
    let output = run_git(repo_root, &["stash", "list", "--format=%gd:%s"])?;
    for line in output.lines() {
        if let Some((stash_ref, subject)) = line.split_once(':') {
            if subject.trim() == message {
                return Ok(stash_ref.to_string());
            }
        }
    }
    Err(SandboxError::InvalidRequest {
        message: "unable to locate stash reference".to_string(),
    })
}
