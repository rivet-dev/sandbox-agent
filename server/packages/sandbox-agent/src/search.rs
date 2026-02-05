use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use regress::Regex;
use sandbox_agent_error::SandboxError;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1_000;
const MAX_FILES: usize = 50_000;
const MAX_FILE_BYTES: u64 = 1_000_000;
const IGNORED_DIRS: [&str; 10] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    ".turbo",
    ".sandbox-agent",
    "coverage",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindFileKind {
    File,
    Directory,
    Any,
}

impl Default for FindFileKind {
    fn default() -> Self {
        Self::File
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindFileOptions {
    #[serde(default)]
    pub kind: FindFileKind,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

impl Default for FindFileOptions {
    fn default() -> Self {
        Self {
            kind: FindFileKind::default(),
            case_sensitive: false,
            limit: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextField {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindTextMatch {
    pub path: TextField,
    pub lines: TextField,
    pub line_number: u64,
    pub absolute_offset: u64,
    pub submatches: Vec<FindTextSubmatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindTextSubmatch {
    #[serde(rename = "match")]
    pub match_field: TextField,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolResult {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FindTextOptions {
    pub case_sensitive: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FindSymbolOptions {
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
struct FileSymbols {
    modified: SystemTime,
    symbols: Vec<SymbolResult>,
}

#[derive(Debug, Default, Clone)]
struct SymbolIndex {
    files: HashMap<PathBuf, FileSymbols>,
}

#[derive(Debug, Clone)]
struct SymbolPattern {
    regex: Regex,
    kind: &'static str,
}

#[derive(Debug, Clone)]
pub struct SearchService {
    symbol_cache: Arc<Mutex<HashMap<PathBuf, SymbolIndex>>>,
    symbol_patterns: Arc<Vec<SymbolPattern>>,
}

impl SearchService {
    pub fn new() -> Self {
        let patterns = vec![
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid fn regex"),
                kind: "function",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:def)\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid def regex"),
                kind: "function",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid function regex"),
                kind: "function",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid struct regex"),
                kind: "struct",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid enum regex"),
                kind: "enum",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:class)\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid class regex"),
                kind: "class",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:interface)\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid interface regex"),
                kind: "interface",
            },
            SymbolPattern {
                regex: Regex::new(r"^\s*(?:trait)\s+([A-Za-z_][A-Za-z0-9_]*)")
                    .expect("valid trait regex"),
                kind: "trait",
            },
        ];
        Self {
            symbol_cache: Arc::new(Mutex::new(HashMap::new())),
            symbol_patterns: Arc::new(patterns),
        }
    }

    pub fn resolve_directory(directory: &str) -> Result<PathBuf, SandboxError> {
        let trimmed = directory.trim();
        if trimmed.is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: "directory is required".to_string(),
            });
        }
        let root = PathBuf::from(trimmed);
        if !root.exists() {
            return Err(SandboxError::InvalidRequest {
                message: "directory does not exist".to_string(),
            });
        }
        let canonical = root.canonicalize().map_err(|_| SandboxError::InvalidRequest {
            message: "directory could not be resolved".to_string(),
        })?;
        if !canonical.is_dir() {
            return Err(SandboxError::InvalidRequest {
                message: "directory is not a folder".to_string(),
            });
        }
        Ok(canonical)
    }

    pub async fn find_text(
        &self,
        root: PathBuf,
        pattern: String,
        options: Option<FindTextOptions>,
    ) -> Result<Vec<FindTextMatch>, SandboxError> {
        let options = options.unwrap_or_default();
        let limit = resolve_limit(options.limit);
        if limit == 0 {
            return Ok(Vec::new());
        }
        match rg_text_matches(&root, &pattern, limit, options.case_sensitive).await {
            Ok(matches) => Ok(matches),
            Err(RgError::NotAvailable) => {
                let service = self.clone();
                let pattern = pattern.clone();
                tokio::task::spawn_blocking(move || {
                    service.find_text_fallback(&root, &pattern, limit, options.case_sensitive)
                })
                .await
                .unwrap_or_else(|_| {
                    Err(SandboxError::StreamError {
                        message: "search failed".to_string(),
                    })
                })
            }
            Err(RgError::InvalidPattern(message)) => Err(SandboxError::InvalidRequest { message }),
            Err(RgError::Failed(message)) => Err(SandboxError::StreamError { message }),
        }
    }

    pub async fn find_files(
        &self,
        root: PathBuf,
        query: String,
        options: FindFileOptions,
    ) -> Result<Vec<String>, SandboxError> {
        let limit = resolve_limit(options.limit);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let service = self.clone();
        tokio::task::spawn_blocking(move || service.find_files_blocking(&root, &query, options, limit))
            .await
            .unwrap_or_else(|_| {
                Err(SandboxError::StreamError {
                    message: "search failed".to_string(),
                })
            })
    }

    pub async fn find_symbols(
        &self,
        root: PathBuf,
        query: String,
        options: Option<FindSymbolOptions>,
    ) -> Result<Vec<SymbolResult>, SandboxError> {
        let options = options.unwrap_or_default();
        let limit = resolve_limit(options.limit);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let service = self.clone();
        tokio::task::spawn_blocking(move || service.find_symbols_blocking(&root, &query, limit))
            .await
            .unwrap_or_else(|_| {
                Err(SandboxError::StreamError {
                    message: "search failed".to_string(),
                })
            })
    }

    fn find_text_fallback(
        &self,
        root: &Path,
        pattern: &str,
        limit: usize,
        case_sensitive: Option<bool>,
    ) -> Result<Vec<FindTextMatch>, SandboxError> {
        let regex = if case_sensitive == Some(false) {
            Regex::with_flags(pattern, "i")
        } else {
            Regex::new(pattern)
        }
        .map_err(|err| SandboxError::InvalidRequest {
            message: format!("invalid pattern: {err}"),
        })?;

        let files = collect_files(root, MAX_FILES, FindFileKind::File);
        let mut results = Vec::new();
        for file in files {
            if results.len() >= limit {
                break;
            }
            let metadata = match fs::metadata(&file) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let Ok(handle) = fs::File::open(&file) else {
                continue;
            };
            let reader = BufReader::new(handle);
            let mut absolute_offset = 0u64;
            for (index, line) in reader.lines().enumerate() {
                if results.len() >= limit {
                    break;
                }
                let Ok(line) = line else {
                    continue;
                };
                let line_start = absolute_offset;
                absolute_offset = absolute_offset.saturating_add(line.as_bytes().len() as u64 + 1);
                for matched in regex.find_iter(&line) {
                    let relative = match file.strip_prefix(root) {
                        Ok(path) => path,
                        Err(_) => continue,
                    };
                    let start = matched.range().start as u64;
                    let end = matched.range().end as u64;
                    results.push(FindTextMatch {
                        path: TextField {
                            text: normalize_path(relative),
                        },
                        lines: TextField {
                            text: line.clone(),
                        },
                        line_number: (index + 1) as u64,
                        absolute_offset: line_start.saturating_add(start),
                        submatches: vec![FindTextSubmatch {
                            match_field: TextField {
                                text: matched.as_str().to_string(),
                            },
                            start,
                            end,
                        }],
                    });
                    if results.len() >= limit {
                        break;
                    }
                }
            }
        }
        Ok(results)
    }

    fn find_files_blocking(
        &self,
        root: &Path,
        query: &str,
        options: FindFileOptions,
        limit: usize,
    ) -> Result<Vec<String>, SandboxError> {
        let files = collect_files(root, MAX_FILES, options.kind);
        let mut results = Vec::new();
        for path in files {
            if results.len() >= limit {
                break;
            }
            let relative = match path.strip_prefix(root) {
                Ok(path) => path,
                Err(_) => continue,
            };
            let path_text = normalize_path(relative);
            if path_text.is_empty() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let file_name = normalize_query(file_name, options.case_sensitive);
            let candidate = normalize_query(&path_text, options.case_sensitive);
            if matches_query(&candidate, query, options.case_sensitive)
                || matches_query(&file_name, query, options.case_sensitive)
            {
                results.push(path_text);
            }
        }
        Ok(results)
    }

    fn find_symbols_blocking(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SymbolResult>, SandboxError> {
        let files = collect_files(root, MAX_FILES, FindFileKind::File);
        let mut cache = self
            .symbol_cache
            .lock()
            .expect("symbol cache lock");
        let index = cache.entry(root.to_path_buf()).or_default();

        for file in &files {
            let metadata = match fs::metadata(file) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let modified = match metadata.modified() {
                Ok(time) => time,
                Err(_) => continue,
            };
            let needs_refresh = index
                .files
                .get(file)
                .map(|entry| entry.modified != modified)
                .unwrap_or(true);
            if !needs_refresh {
                continue;
            }
            let symbols = extract_symbols(file, root, &self.symbol_patterns);
            index.files.insert(
                file.clone(),
                FileSymbols {
                    modified,
                    symbols,
                },
            );
        }

        let mut results = Vec::new();
        let query = normalize_query(query, false);
        for entry in index.files.values() {
            for symbol in &entry.symbols {
                if results.len() >= limit {
                    break;
                }
                if normalize_query(&symbol.name, false).contains(&query) {
                    results.push(symbol.clone());
                }
            }
            if results.len() >= limit {
                break;
            }
        }
        Ok(results)
    }
}

#[derive(Debug)]
enum RgError {
    NotAvailable,
    InvalidPattern(String),
    Failed(String),
}

async fn rg_text_matches(
    root: &Path,
    pattern: &str,
    limit: usize,
    case_sensitive: Option<bool>,
) -> Result<Vec<FindTextMatch>, RgError> {
    let mut command = Command::new("rg");
    command
        .arg("--json")
        .arg("--line-number")
        .arg("--byte-offset")
        .arg("--with-filename")
        .arg("--max-count")
        .arg(limit.to_string());
    if case_sensitive == Some(false) {
        command.arg("--ignore-case");
    }
    command.arg(pattern);
    command.current_dir(root);

    let output = match command.output().await {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(RgError::NotAvailable),
        Err(err) => return Err(RgError::Failed(err.to_string())),
    };
    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.contains("regex parse error") || stderr.contains("error parsing") {
            return Err(RgError::InvalidPattern(stderr.trim().to_string()));
        }
        return Err(RgError::Failed("ripgrep failed".to_string()));
    }

    let mut results = Vec::new();
    for line in output.stdout.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("match") {
            continue;
        }
        let Some(data) = value.get("data") else {
            continue;
        };
        if let Some(entry) = match_from_rg_data(root, data) {
            results.push(entry);
            if results.len() >= limit {
                break;
            }
        }
    }

    Ok(results)
}

fn match_from_rg_data(root: &Path, data: &serde_json::Value) -> Option<FindTextMatch> {
    let path_text = data
        .get("path")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())?;
    let line_number = data.get("line_number").and_then(|v| v.as_u64())?;
    let absolute_offset = data.get("absolute_offset").and_then(|v| v.as_u64())?;
    let line_text = data
        .get("lines")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())?
        .trim_end_matches('\n')
        .to_string();
    let submatches = data
        .get("submatches")
        .and_then(|v| v.as_array())
        .map(|matches| {
            matches
                .iter()
                .filter_map(|submatch| {
                    let match_text = submatch
                        .get("match")
                        .and_then(|v| v.get("text"))
                        .and_then(|v| v.as_str())?;
                    let start = submatch.get("start").and_then(|v| v.as_u64())?;
                    let end = submatch.get("end").and_then(|v| v.as_u64())?;
                    Some(FindTextSubmatch {
                        match_field: TextField {
                            text: match_text.to_string(),
                        },
                        start,
                        end,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let path = Path::new(path_text);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let relative = absolute.strip_prefix(root).unwrap_or(&absolute);

    Some(FindTextMatch {
        path: TextField {
            text: normalize_path(relative),
        },
        lines: TextField { text: line_text },
        line_number,
        absolute_offset,
        submatches,
    })
}

fn resolve_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT)
}

fn normalize_query(value: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        value.to_string()
    } else {
        value.to_lowercase()
    }
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_ignored_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| IGNORED_DIRS.contains(&name))
        .unwrap_or(false)
}

fn collect_files(root: &Path, max_files: usize, kind: FindFileKind) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries_iter = match fs::read_dir(&dir) {
            Ok(entries_iter) => entries_iter,
            Err(_) => continue,
        };
        for entry in entries_iter.flatten() {
            if entries.len() >= max_files {
                return entries;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if is_ignored_dir(&path) {
                    continue;
                }
                if matches!(kind, FindFileKind::Directory | FindFileKind::Any) {
                    entries.push(path.clone());
                }
                stack.push(path);
            } else if file_type.is_file() {
                if matches!(kind, FindFileKind::File | FindFileKind::Any) {
                    entries.push(path);
                }
            }
        }
    }
    entries
}

fn matches_query(candidate: &str, query: &str, case_sensitive: bool) -> bool {
    let candidate = normalize_query(candidate, case_sensitive);
    let query = normalize_query(query, case_sensitive);
    if query.contains('*') || query.contains('?') {
        return glob_match(&query, &candidate);
    }
    candidate.contains(&query)
}

fn glob_match(pattern: &str, text: &str) -> bool {
    glob_match_inner(pattern.as_bytes(), text.as_bytes())
}

fn glob_match_inner(pattern: &[u8], text: &[u8]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }
    match pattern[0] {
        b'*' => {
            if glob_match_inner(&pattern[1..], text) {
                return true;
            }
            if !text.is_empty() {
                return glob_match_inner(pattern, &text[1..]);
            }
            false
        }
        b'?' => {
            if text.is_empty() {
                false
            } else {
                glob_match_inner(&pattern[1..], &text[1..])
            }
        }
        ch => {
            if text.first().copied() == Some(ch) {
                glob_match_inner(&pattern[1..], &text[1..])
            } else {
                false
            }
        }
    }
}

fn extract_symbols(path: &Path, root: &Path, patterns: &[SymbolPattern]) -> Vec<SymbolResult> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut symbols = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let Ok(line) = line else {
            continue;
        };
        for pattern in patterns {
            for matched in pattern.regex.find_iter(&line) {
                let Some(group) = matched.group(1) else {
                    continue;
                };
                let name = line.get(group.clone()).unwrap_or("").to_string();
                if name.is_empty() {
                    continue;
                }
                let relative = match path.strip_prefix(root) {
                    Ok(path) => path,
                    Err(_) => continue,
                };
                symbols.push(SymbolResult {
                    name,
                    kind: pattern.kind.to_string(),
                    path: normalize_path(relative),
                    line: index + 1,
                    column: group.start + 1,
                });
            }
        }
    }
    symbols
}
