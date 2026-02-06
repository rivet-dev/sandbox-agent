use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tokio::task;

use sandbox_agent_error::SandboxError;

const DEFAULT_TEXT_LIMIT: usize = 200;
const DEFAULT_FILE_LIMIT: usize = 200;
const DEFAULT_SYMBOL_LIMIT: usize = 200;
const MAX_TEXT_LIMIT: usize = 500;
const MAX_FILE_LIMIT: usize = 200;
const MAX_SYMBOL_LIMIT: usize = 200;
const RIPGREP_NOT_AVAILABLE: &str = "ripgrep not available";

const SYMBOL_KIND_CLASS: u32 = 5;
const SYMBOL_KIND_METHOD: u32 = 6;
const SYMBOL_KIND_INTERFACE: u32 = 11;
const SYMBOL_KIND_FUNCTION: u32 = 12;
const SYMBOL_KIND_VARIABLE: u32 = 13;
const SYMBOL_KIND_CONSTANT: u32 = 14;
const SYMBOL_KIND_ENUM: u32 = 10;
const SYMBOL_KIND_STRUCT: u32 = 23;
const SYMBOL_KIND_TYPE_PARAMETER: u32 = 26;

#[derive(Clone, Debug)]
pub(crate) struct SearchService {
    symbol_cache: Arc<Mutex<SymbolCache>>,
}

impl SearchService {
    pub fn new() -> Self {
        Self {
            symbol_cache: Arc::new(Mutex::new(SymbolCache::default())),
        }
    }

    pub async fn search_text(
        &self,
        params: SearchTextParams,
    ) -> Result<Vec<TextMatch>, SandboxError> {
        task::spawn_blocking(move || search_text_sync(params))
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?
    }

    pub async fn search_files(
        &self,
        params: SearchFileParams,
    ) -> Result<Vec<String>, SandboxError> {
        task::spawn_blocking(move || search_files_sync(params))
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?
    }

    pub async fn search_symbols(
        &self,
        params: SearchSymbolParams,
    ) -> Result<Vec<Symbol>, SandboxError> {
        let cache = self.symbol_cache.clone();
        task::spawn_blocking(move || search_symbols_sync(cache, params))
            .await
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SearchTextParams {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub pattern: String,
    pub case_sensitive: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) struct SearchFileParams {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub query: String,
    pub include_dirs: Option<bool>,
    pub file_type: Option<FileSearchType>,
    pub limit: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum FileSearchType {
    File,
    Directory,
}

#[derive(Clone, Debug)]
pub(crate) struct SearchSymbolParams {
    pub root: PathBuf,
    pub directory: PathBuf,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TextMatch {
    pub path: TextValue,
    pub lines: TextValue,
    pub line_number: u64,
    pub absolute_offset: u64,
    pub submatches: Vec<TextSubmatch>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TextValue {
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TextSubmatch {
    #[serde(rename = "match")]
    pub match_text: TextValue,
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Symbol {
    pub name: String,
    pub kind: u32,
    pub location: SymbolLocation,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SymbolLocation {
    pub uri: String,
    pub range: Range,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Default)]
struct SymbolCache {
    roots: HashMap<PathBuf, SymbolIndex>,
}

#[derive(Debug, Default)]
struct SymbolIndex {
    fingerprint: u64,
    symbols: Vec<Symbol>,
}

#[derive(Clone, Debug)]
struct SymbolPattern {
    regex: Regex,
    kind: u32,
}

fn search_text_sync(params: SearchTextParams) -> Result<Vec<TextMatch>, SandboxError> {
    if params.pattern.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "pattern is required".to_string(),
        });
    }
    let scope = resolve_scope(&params.root, &params.directory)?;
    let limit = clamp_limit(params.limit, DEFAULT_TEXT_LIMIT, MAX_TEXT_LIMIT);

    match rg_search(&scope, &params.pattern, params.case_sensitive, limit) {
        Ok(matches) => Ok(matches),
        Err(SandboxError::StreamError { message })
            if message == RIPGREP_NOT_AVAILABLE =>
        {
            search_text_fallback(&scope, &params.pattern, params.case_sensitive, limit)
        }
        Err(err) => Err(err),
    }
}

fn search_files_sync(params: SearchFileParams) -> Result<Vec<String>, SandboxError> {
    let scope = resolve_scope(&params.root, &params.directory)?;
    let limit = clamp_limit(params.limit, DEFAULT_FILE_LIMIT, MAX_FILE_LIMIT);

    if params.query.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "query is required".to_string(),
        });
    }

    let matcher = build_file_matcher(&params.query)?;
    let include_dirs = match params.file_type {
        Some(FileSearchType::File) => false,
        Some(FileSearchType::Directory) => true,
        None => params.include_dirs.unwrap_or(false),
    };
    let only_dirs = matches!(params.file_type, Some(FileSearchType::Directory));
    let only_files = matches!(params.file_type, Some(FileSearchType::File));

    let mut results = Vec::new();

    walk_dir(&scope.directory, |path, file_type| {
        if results.len() >= limit {
            return WalkAction::Stop;
        }
        if file_type.is_dir() {
            if should_skip_dir(path) {
                return WalkAction::Skip;
            }
            if include_dirs || only_dirs {
                let rel = relative_path(&scope.root, path);
                if matcher.is_match(&rel) {
                    results.push(rel);
                }
            }
            return WalkAction::Continue;
        }

        if file_type.is_file() {
            if only_dirs {
                return WalkAction::Continue;
            }
            if only_files || !only_dirs {
                let rel = relative_path(&scope.root, path);
                if matcher.is_match(&rel) {
                    results.push(rel);
                }
            }
        }
        WalkAction::Continue
    })?;

    Ok(results)
}

fn search_symbols_sync(
    cache: Arc<Mutex<SymbolCache>>,
    params: SearchSymbolParams,
) -> Result<Vec<Symbol>, SandboxError> {
    let scope = resolve_scope(&params.root, &params.directory)?;
    if params.query.trim().is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "query is required".to_string(),
        });
    }

    let limit = clamp_limit(params.limit, DEFAULT_SYMBOL_LIMIT, MAX_SYMBOL_LIMIT);
    let query = params.query.to_lowercase();

    let mut cache_guard = cache
        .lock()
        .map_err(|_| SandboxError::StreamError {
            message: "symbol cache poisoned".to_string(),
        })?;
    let entry = cache_guard
        .roots
        .entry(scope.directory.clone())
        .or_insert_with(SymbolIndex::default);
    update_symbol_index(entry, &scope.directory)?;

    let mut results = Vec::new();
    for symbol in entry.symbols.iter() {
        if results.len() >= limit {
            break;
        }
        if symbol.name.to_lowercase().contains(&query) {
            results.push(symbol.clone());
        }
    }

    Ok(results)
}

struct SearchScope {
    root: PathBuf,
    directory: PathBuf,
}

fn resolve_scope(root: &Path, directory: &Path) -> Result<SearchScope, SandboxError> {
    let root_abs = fs::canonicalize(root).map_err(|_| SandboxError::InvalidRequest {
        message: "root directory not found".to_string(),
    })?;

    let directory_path = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        root_abs.join(directory)
    };

    let directory_abs = fs::canonicalize(&directory_path).map_err(|_| SandboxError::InvalidRequest {
        message: "directory not found".to_string(),
    })?;

    if !directory_abs.starts_with(&root_abs) {
        return Err(SandboxError::InvalidRequest {
            message: "directory escapes worktree".to_string(),
        });
    }

    Ok(SearchScope {
        root: root_abs,
        directory: directory_abs,
    })
}

fn clamp_limit(limit: Option<usize>, default_limit: usize, max_limit: usize) -> usize {
    let limit = limit.unwrap_or(default_limit);
    let limit = limit.max(1).min(max_limit);
    limit
}

fn rg_search(
    scope: &SearchScope,
    pattern: &str,
    case_sensitive: Option<bool>,
    limit: usize,
) -> Result<Vec<TextMatch>, SandboxError> {
    let mut cmd = Command::new("rg");
    cmd.arg("--json");
    match case_sensitive {
        Some(true) => {
            cmd.arg("--case-sensitive");
        }
        Some(false) => {
            cmd.arg("--ignore-case");
        }
        None => {
            cmd.arg("--smart-case");
        }
    }
    cmd.arg(pattern);

    let relative = scope
        .directory
        .strip_prefix(&scope.root)
        .unwrap_or(&scope.directory);
    if relative.as_os_str().is_empty() {
        cmd.arg(".");
    } else {
        cmd.arg(relative);
    }

    let output = cmd.current_dir(&scope.root).output();
    let output = match output {
        Ok(output) => output,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::NotFound {
                return Err(SandboxError::StreamError {
                    message: RIPGREP_NOT_AVAILABLE.to_string(),
                });
            }
            return Err(SandboxError::StreamError {
                message: err.to_string(),
            });
        }
    };

    if !output.status.success() {
        if output.status.code() == Some(1) {
            return Ok(Vec::new());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        if !message.is_empty() {
            return Err(SandboxError::InvalidRequest {
                message: message.to_string(),
            });
        }
        return Err(SandboxError::StreamError {
            message: "ripgrep failed".to_string(),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut matches = Vec::new();
    for line in stdout.lines() {
        if matches.len() >= limit {
            break;
        }
        let Ok(event) = serde_json::from_str::<RgEvent>(line) else {
            continue;
        };
        if event.event_type != "match" {
            continue;
        }
        let Some(data) = event.data else {
            continue;
        };
        let path = data.path.text;
        let rel_path = normalize_path_string(&scope.root, &PathBuf::from(path));
        let submatches = data
            .submatches
            .into_iter()
            .map(|sub| TextSubmatch {
                match_text: TextValue { text: sub.match_text.text },
                start: sub.start as u64,
                end: sub.end as u64,
            })
            .collect();
        matches.push(TextMatch {
            path: TextValue { text: rel_path },
            lines: TextValue { text: data.lines.text },
            line_number: data.line_number as u64,
            absolute_offset: data.absolute_offset as u64,
            submatches,
        });
    }

    Ok(matches)
}

fn search_text_fallback(
    scope: &SearchScope,
    pattern: &str,
    case_sensitive: Option<bool>,
    limit: usize,
) -> Result<Vec<TextMatch>, SandboxError> {
    let regex = build_text_regex(pattern, case_sensitive)?;
    let mut matches = Vec::new();

    walk_dir(&scope.directory, |path, file_type| {
        if matches.len() >= limit {
            return WalkAction::Stop;
        }
        if file_type.is_dir() {
            if should_skip_dir(path) {
                return WalkAction::Skip;
            }
            return WalkAction::Continue;
        }
        if !file_type.is_file() {
            return WalkAction::Continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            return WalkAction::Continue;
        };

        let mut absolute_offset = 0u64;
        for (line_index, line) in content.split_inclusive('\n').enumerate() {
            let line_text = line.trim_end_matches(['\n', '\r']);
            let mut submatches = Vec::new();
            for mat in regex.find_iter(line_text) {
                if matches.len() >= limit {
                    break;
                }
                submatches.push(TextSubmatch {
                    match_text: TextValue {
                        text: mat.as_str().to_string(),
                    },
                    start: mat.start() as u64,
                    end: mat.end() as u64,
                });
            }
            if !submatches.is_empty() {
                matches.push(TextMatch {
                    path: TextValue {
                        text: relative_path(&scope.root, path),
                    },
                    lines: TextValue {
                        text: line_text.to_string(),
                    },
                    line_number: (line_index + 1) as u64,
                    absolute_offset,
                    submatches,
                });
            }
            absolute_offset += line.as_bytes().len() as u64;
            if matches.len() >= limit {
                break;
            }
        }

        WalkAction::Continue
    })?;

    Ok(matches)
}

fn build_text_regex(pattern: &str, case_sensitive: Option<bool>) -> Result<Regex, SandboxError> {
    let case_sensitive = match case_sensitive {
        Some(value) => value,
        None => contains_uppercase(pattern),
    };

    let mut builder = RegexBuilder::new(pattern);
    builder.case_insensitive(!case_sensitive);
    builder
        .build()
        .map_err(|err| SandboxError::InvalidRequest {
            message: err.to_string(),
        })
}

fn contains_uppercase(pattern: &str) -> bool {
    pattern.chars().any(|c| c.is_ascii_uppercase())
}

fn build_file_matcher(query: &str) -> Result<Regex, SandboxError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(SandboxError::InvalidRequest {
            message: "query is required".to_string(),
        });
    }

    let is_glob = trimmed.contains('*') || trimmed.contains('?') || trimmed.contains('[');
    let pattern = if is_glob {
        trimmed.to_string()
    } else {
        format!("*{}*", trimmed)
    };

    let mut regex = String::from("(?i)^");
    let mut chars = pattern.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            '[' => {
                regex.push('[');
                while let Some(next) = chars.next() {
                    regex.push(next);
                    if next == ']' {
                        break;
                    }
                }
            }
            _ => regex.push_str(&regex::escape(&ch.to_string())),
        }
    }
    regex.push('$');

    Regex::new(&regex).map_err(|err| SandboxError::InvalidRequest {
        message: err.to_string(),
    })
}

fn update_symbol_index(index: &mut SymbolIndex, directory: &Path) -> Result<(), SandboxError> {
    let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
    let mut files = Vec::new();

    walk_dir(directory, |path, file_type| {
        if file_type.is_dir() {
            if should_skip_dir(path) {
                return WalkAction::Skip;
            }
            return WalkAction::Continue;
        }
        if !file_type.is_file() {
            return WalkAction::Continue;
        }

        if !is_supported_symbol_file(path) {
            return WalkAction::Continue;
        }

        if let Ok(metadata) = fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                path.hash(&mut fingerprint);
                modified
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs())
                    .hash(&mut fingerprint);
            }
        }
        files.push(path.to_path_buf());

        WalkAction::Continue
    })?;

    let new_fingerprint = fingerprint.finish();
    if new_fingerprint == index.fingerprint {
        return Ok(());
    }

    let mut symbols = Vec::new();
    for path in files {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        symbols.extend(extract_symbols_for_file(&path, &content));
    }

    index.fingerprint = new_fingerprint;
    index.symbols = symbols;

    Ok(())
}

fn extract_symbols_for_file(path: &Path, content: &str) -> Vec<Symbol> {
    let Some(ext) = path.extension().and_then(|v| v.to_str()) else {
        return Vec::new();
    };
    let patterns = symbol_patterns_for_extension(ext);
    if patterns.is_empty() {
        return Vec::new();
    }

    let uri = path_to_file_uri(path);
    let mut symbols = Vec::new();

    for (line_index, line) in content.lines().enumerate() {
        for pattern in &patterns {
            for caps in pattern.regex.captures_iter(line) {
                let Some(matched) = caps.get(1) else {
                    continue;
                };
                let name = matched.as_str();
                let start = matched.start() as u32;
                let end = matched.end() as u32;
                symbols.push(Symbol {
                    name: name.to_string(),
                    kind: pattern.kind,
                    location: SymbolLocation {
                        uri: uri.clone(),
                        range: Range {
                            start: Position {
                                line: line_index as u32,
                                character: start,
                            },
                            end: Position {
                                line: line_index as u32,
                                character: end,
                            },
                        },
                    },
                });
            }
        }
    }

    symbols
}

fn symbol_patterns_for_extension(ext: &str) -> Vec<SymbolPattern> {
    match ext {
        "rs" => rust_symbol_patterns(),
        "js" | "jsx" | "ts" | "tsx" => js_symbol_patterns(),
        "py" => python_symbol_patterns(),
        "go" => go_symbol_patterns(),
        _ => Vec::new(),
    }
}

fn rust_symbol_patterns() -> Vec<SymbolPattern> {
    vec![
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)")
                .unwrap(),
            kind: SYMBOL_KIND_FUNCTION,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_STRUCT,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_ENUM,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_INTERFACE,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:pub\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_CONSTANT,
        },
    ]
}

fn js_symbol_patterns() -> Vec<SymbolPattern> {
    vec![
        SymbolPattern {
            regex: Regex::new(
                r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            )
            .unwrap(),
            kind: SYMBOL_KIND_FUNCTION,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)")
                .unwrap(),
            kind: SYMBOL_KIND_CLASS,
        },
        SymbolPattern {
            regex: Regex::new(
                r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            )
            .unwrap(),
            kind: SYMBOL_KIND_INTERFACE,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)").unwrap(),
            kind: SYMBOL_KIND_TYPE_PARAMETER,
        },
        SymbolPattern {
            regex: Regex::new(
                r"^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            )
            .unwrap(),
            kind: SYMBOL_KIND_CONSTANT,
        },
        SymbolPattern {
            regex: Regex::new(
                r"^\s*(?:export\s+)?(?:let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            )
            .unwrap(),
            kind: SYMBOL_KIND_VARIABLE,
        },
    ]
}

fn python_symbol_patterns() -> Vec<SymbolPattern> {
    vec![
        SymbolPattern {
            regex: Regex::new(r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_FUNCTION,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_CLASS,
        },
    ]
}

fn go_symbol_patterns() -> Vec<SymbolPattern> {
    vec![
        SymbolPattern {
            regex: Regex::new(r"^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap(),
            kind: SYMBOL_KIND_FUNCTION,
        },
        SymbolPattern {
            regex: Regex::new(
                r"^\s*func\s*\(.*?\)\s*([A-Za-z_][A-Za-z0-9_]*)",
            )
            .unwrap(),
            kind: SYMBOL_KIND_METHOD,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct").unwrap(),
            kind: SYMBOL_KIND_STRUCT,
        },
        SymbolPattern {
            regex: Regex::new(r"^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface").unwrap(),
            kind: SYMBOL_KIND_INTERFACE,
        },
    ]
}

fn is_supported_symbol_file(path: &Path) -> bool {
    match path.extension().and_then(|v| v.to_str()) {
        Some("rs" | "js" | "jsx" | "ts" | "tsx" | "py" | "go") => true,
        _ => false,
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    normalize_path_string(root, path)
}

fn normalize_path_string(root: &Path, path: &Path) -> String {
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let rel = candidate.strip_prefix(root).unwrap_or(candidate.as_path());
    rel.to_string_lossy().replace('\\', "/")
}

fn path_to_file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let encoded = percent_encode_path(&raw);
    format!("file://{}", encoded)
}

fn percent_encode_path(path: &str) -> String {
    let mut out = String::new();
    for byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'/'
            | b'-'
            | b'.'
            | b'_'
            | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

#[derive(Clone, Copy, Debug)]
enum WalkAction {
    Continue,
    Skip,
    Stop,
}

fn walk_dir(
    root: &Path,
    mut visit: impl FnMut(&Path, &fs::FileType) -> WalkAction,
) -> Result<(), SandboxError> {
    let mut stack = vec![root.to_path_buf()];
    let mut visited = HashSet::new();

    while let Some(dir) = stack.pop() {
        if !visited.insert(dir.clone()) {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            match visit(&path, &file_type) {
                WalkAction::Stop => return Ok(()),
                WalkAction::Skip => {
                    if file_type.is_dir() {
                        continue;
                    }
                }
                WalkAction::Continue => {}
            }
            if file_type.is_dir() {
                stack.push(path);
            }
        }
    }
    Ok(())
}

fn should_skip_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | ".opencode"
            | ".cache"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
    )
}

#[derive(Debug, Deserialize)]
struct RgEvent {
    #[serde(rename = "type")]
    event_type: String,
    data: Option<RgMatchData>,
}

#[derive(Debug, Deserialize)]
struct RgMatchData {
    path: RgText,
    lines: RgText,
    line_number: u64,
    absolute_offset: u64,
    submatches: Vec<RgSubmatch>,
}

#[derive(Debug, Deserialize)]
struct RgText {
    text: String,
}

#[derive(Debug, Deserialize)]
struct RgSubmatch {
    #[serde(rename = "match")]
    match_text: RgText,
    start: u64,
    end: u64,
}
