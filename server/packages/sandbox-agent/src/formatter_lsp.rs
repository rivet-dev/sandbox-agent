use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_SCAN_FILES: usize = 10_000;
const MAX_SCAN_DEPTH: usize = 6;

const IGNORE_DIRS: &[&str] = &[
    ".git",
    ".idea",
    ".sandbox-agent",
    ".venv",
    ".vscode",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatterStatus {
    pub name: String,
    pub extensions: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    pub id: String,
    pub name: String,
    pub root: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct FormatterService {
    formatters: Vec<FormatterDefinition>,
}

#[derive(Debug, Clone)]
pub struct LspRegistry {
    servers: Vec<LspDefinition>,
}

#[derive(Debug, Clone)]
struct FormatterDefinition {
    name: &'static str,
    extensions: &'static [&'static str],
    config_files: &'static [&'static str],
    binaries: &'static [&'static str],
}

#[derive(Debug, Clone)]
struct LspDefinition {
    id: &'static str,
    name: &'static str,
    extensions: &'static [&'static str],
    binaries: &'static [&'static str],
    #[allow(dead_code)]
    capabilities: &'static [&'static str],
}

impl FormatterService {
    pub fn new() -> Self {
        Self {
            formatters: vec![
                FormatterDefinition {
                    name: "prettier",
                    extensions: &[
                        ".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss", ".md", ".mdx",
                        ".yaml", ".yml", ".html",
                    ],
                    config_files: &[
                        ".prettierrc",
                        ".prettierrc.json",
                        ".prettierrc.yaml",
                        ".prettierrc.yml",
                        ".prettierrc.js",
                        ".prettierrc.cjs",
                        ".prettierrc.mjs",
                        "prettier.config.js",
                        "prettier.config.cjs",
                        "prettier.config.mjs",
                    ],
                    binaries: &["prettier"],
                },
                FormatterDefinition {
                    name: "rustfmt",
                    extensions: &[".rs"],
                    config_files: &["rustfmt.toml"],
                    binaries: &["rustfmt"],
                },
                FormatterDefinition {
                    name: "gofmt",
                    extensions: &[".go"],
                    config_files: &[],
                    binaries: &["gofmt"],
                },
                FormatterDefinition {
                    name: "black",
                    extensions: &[".py"],
                    config_files: &["pyproject.toml", "black.toml", "setup.cfg"],
                    binaries: &["black"],
                },
                FormatterDefinition {
                    name: "shfmt",
                    extensions: &[".sh", ".bash"],
                    config_files: &[],
                    binaries: &["shfmt"],
                },
                FormatterDefinition {
                    name: "stylua",
                    extensions: &[".lua"],
                    config_files: &["stylua.toml"],
                    binaries: &["stylua"],
                },
            ],
        }
    }

    pub fn status_for_directory(&self, directory: &str) -> Vec<FormatterStatus> {
        let root = resolve_root(directory);
        let scan = scan_workspace(root);
        let mut entries = Vec::new();

        for formatter in &self.formatters {
            let has_extension = formatter
                .extensions
                .iter()
                .any(|ext| scan.extensions.contains(&ext.to_ascii_lowercase()));
            let has_config = formatter
                .config_files
                .iter()
                .any(|name| scan.file_names.contains(&name.to_ascii_lowercase()));
            if !has_extension && !has_config {
                continue;
            }
            let enabled = has_binary_in_workspace(root, formatter.binaries);
            entries.push(FormatterStatus {
                name: formatter.name.to_string(),
                extensions: formatter
                    .extensions
                    .iter()
                    .map(|ext| ext.to_string())
                    .collect(),
                enabled,
            });
        }

        entries
    }
}

impl LspRegistry {
    pub fn new() -> Self {
        Self {
            servers: vec![
                LspDefinition {
                    id: "rust-analyzer",
                    name: "Rust Analyzer",
                    extensions: &[".rs"],
                    binaries: &["rust-analyzer"],
                    capabilities: &["completion", "diagnostics", "formatting"],
                },
                LspDefinition {
                    id: "typescript-language-server",
                    name: "TypeScript Language Server",
                    extensions: &[".ts", ".tsx", ".js", ".jsx"],
                    binaries: &["typescript-language-server", "tsserver"],
                    capabilities: &["completion", "diagnostics", "formatting"],
                },
                LspDefinition {
                    id: "pyright",
                    name: "Pyright",
                    extensions: &[".py"],
                    binaries: &["pyright-langserver", "pyright"],
                    capabilities: &["completion", "diagnostics"],
                },
                LspDefinition {
                    id: "gopls",
                    name: "gopls",
                    extensions: &[".go"],
                    binaries: &["gopls"],
                    capabilities: &["completion", "diagnostics", "formatting"],
                },
            ],
        }
    }

    pub fn status_for_directory(&self, directory: &str) -> Vec<LspStatus> {
        let root = resolve_root(directory);
        let scan = scan_workspace(root);
        let mut entries = Vec::new();

        for server in &self.servers {
            let has_extension = server
                .extensions
                .iter()
                .any(|ext| scan.extensions.contains(&ext.to_ascii_lowercase()));
            if !has_extension {
                continue;
            }
            let status = if has_binary_in_workspace(root, server.binaries) {
                "connected"
            } else {
                "error"
            };
            entries.push(LspStatus {
                id: server.id.to_string(),
                name: server.name.to_string(),
                root: root.to_string_lossy().to_string(),
                status: status.to_string(),
            });
        }

        entries
    }
}

#[derive(Default)]
struct WorkspaceScan {
    extensions: HashSet<String>,
    file_names: HashSet<String>,
}

fn resolve_root(directory: &str) -> PathBuf {
    let root = PathBuf::from(directory);
    if root.is_dir() {
        return root;
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn scan_workspace(root: &Path) -> WorkspaceScan {
    let mut scan = WorkspaceScan::default();
    let mut stack = Vec::new();
    let mut files_seen = 0usize;
    stack.push((root.to_path_buf(), 0usize));

    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_SCAN_DEPTH {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            let name = entry.file_name();
            if file_type.is_dir() {
                if should_skip_dir(&name) {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if file_type.is_file() {
                files_seen += 1;
                if files_seen > MAX_SCAN_FILES {
                    return scan;
                }
                if let Some(extension) = path.extension().and_then(|ext| ext.to_str()) {
                    scan.extensions
                        .insert(format!(".{}", extension.to_ascii_lowercase()));
                }
                if let Some(name) = name.to_str() {
                    scan.file_names.insert(name.to_ascii_lowercase());
                }
            }
        }
    }

    scan
}

fn should_skip_dir(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    IGNORE_DIRS.iter().any(|dir| dir == &name)
}

fn has_binary_in_workspace(root: &Path, binaries: &[&str]) -> bool {
    binaries
        .iter()
        .any(|binary| binary_exists_in_workspace(root, binary) || binary_exists_in_path(binary))
}

fn binary_exists_in_workspace(root: &Path, binary: &str) -> bool {
    let bin_dir = root.join("node_modules").join(".bin");
    if !bin_dir.is_dir() {
        return false;
    }
    path_has_binary(&bin_dir, binary)
}

fn binary_exists_in_path(binary: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };
    for path in env::split_paths(&paths) {
        if path_has_binary(&path, binary) {
            return true;
        }
    }
    false
}

fn path_has_binary(path: &Path, binary: &str) -> bool {
    let candidate = path.join(binary);
    if candidate.is_file() {
        return true;
    }
    if cfg!(windows) {
        if let Some(exts) = std::env::var_os("PATHEXT") {
            for ext in std::env::split_paths(&exts) {
                if let Some(ext_str) = ext.to_str() {
                    let candidate = path.join(format!("{}{}", binary, ext_str));
                    if candidate.is_file() {
                        return true;
                    }
                }
            }
        }
    }
    false
}
