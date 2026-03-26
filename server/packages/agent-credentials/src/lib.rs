use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCredentials {
    pub api_key: String,
    pub source: String,
    pub auth_type: AuthType,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    ApiKey,
    Oauth,
    ApiKeyHelper,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractedCredentials {
    pub anthropic: Option<ProviderCredentials>,
    pub openai: Option<ProviderCredentials>,
    pub other: HashMap<String, ProviderCredentials>,
}

#[derive(Debug, Clone, Default)]
pub struct CredentialExtractionOptions {
    pub home_dir: Option<PathBuf>,
    pub include_oauth: bool,
}

impl CredentialExtractionOptions {
    pub fn new() -> Self {
        Self {
            home_dir: None,
            include_oauth: true,
        }
    }
}

pub fn extract_claude_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;

    let config_paths = [
        home_dir.join(".claude.json.api"),
        home_dir.join(".claude.json"),
        home_dir.join(".claude.json.nathan"),
    ];

    let key_paths = [
        vec!["primaryApiKey"],
        vec!["apiKey"],
        vec!["anthropicApiKey"],
        vec!["customApiKey"],
    ];

    for path in config_paths {
        let Some(data) = read_json_file(&path) else {
            continue;
        };
        for key_path in &key_paths {
            if let Some(key) = read_string_field(&data, key_path) {
                if key.starts_with("sk-ant-") {
                    return Some(ProviderCredentials {
                        api_key: key,
                        source: "claude-code".to_string(),
                        auth_type: AuthType::ApiKey,
                        provider: "anthropic".to_string(),
                    });
                }
            }
        }
    }

    if include_oauth {
        let oauth_paths = [
            home_dir.join(".claude").join(".credentials.json"),
            home_dir.join(".claude-oauth-credentials.json"),
        ];
        for path in oauth_paths {
            let data = match read_json_file(&path) {
                Some(value) => value,
                None => continue,
            };
            if let Some(cred) = extract_claude_oauth_from_json(&data) {
                return Some(cred);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Some(cred) = extract_claude_oauth_from_keychain() {
                return Some(cred);
            }
        }
    }

    // Check for apiKeyHelper in Claude Code settings — if configured, Claude Code
    // can obtain credentials dynamically via an external command (e.g. a corporate proxy)
    let settings_path = home_dir.join(".claude").join("settings.json");
    if let Some(settings) = read_json_file(&settings_path) {
        if let Some(helper) = read_string_field(&settings, &["apiKeyHelper"]) {
            if !helper.is_empty() {
                return Some(ProviderCredentials {
                    api_key: String::new(),
                    source: "claude-code-api-key-helper".to_string(),
                    auth_type: AuthType::ApiKeyHelper,
                    provider: "anthropic".to_string(),
                });
            }
        }
    }

    None
}

fn extract_claude_oauth_from_json(data: &Value) -> Option<ProviderCredentials> {
    let access = read_string_field(data, &["claudeAiOauth", "accessToken"])?;
    if access.is_empty() {
        return None;
    }

    // Check expiry — the field can be an RFC 3339 string or an epoch-millis number
    if let Some(expires_str) = read_string_field(data, &["claudeAiOauth", "expiresAt"]) {
        if is_expired_rfc3339(&expires_str) {
            return None;
        }
    } else if let Some(expires_ms) = data
        .get("claudeAiOauth")
        .and_then(|v| v.get("expiresAt"))
        .and_then(Value::as_i64)
    {
        if expires_ms < current_epoch_millis() {
            return None;
        }
    }

    Some(ProviderCredentials {
        api_key: access,
        source: "claude-code".to_string(),
        auth_type: AuthType::Oauth,
        provider: "anthropic".to_string(),
    })
}

#[cfg(target_os = "macos")]
fn extract_claude_oauth_from_keychain() -> Option<ProviderCredentials> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let json_str = String::from_utf8(output.stdout).ok()?;
    let data: Value = serde_json::from_str(json_str.trim()).ok()?;
    extract_claude_oauth_from_json(&data)
}

pub fn extract_codex_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;
    let path = home_dir.join(".codex").join("auth.json");
    let data = read_json_file(&path)?;

    if let Some(key) = data.get("OPENAI_API_KEY").and_then(Value::as_str) {
        if !key.is_empty() {
            return Some(ProviderCredentials {
                api_key: key.to_string(),
                source: "codex".to_string(),
                auth_type: AuthType::ApiKey,
                provider: "openai".to_string(),
            });
        }
    }

    if include_oauth {
        if let Some(token) = read_string_field(&data, &["tokens", "access_token"]) {
            return Some(ProviderCredentials {
                api_key: token,
                source: "codex".to_string(),
                auth_type: AuthType::Oauth,
                provider: "openai".to_string(),
            });
        }
    }

    None
}

pub fn extract_opencode_credentials(options: &CredentialExtractionOptions) -> ExtractedCredentials {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let include_oauth = options.include_oauth;
    let path = home_dir
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");

    let mut result = ExtractedCredentials::default();
    let data = match read_json_file(&path) {
        Some(value) => value,
        None => return result,
    };

    let obj = match data.as_object() {
        Some(obj) => obj,
        None => return result,
    };

    for (provider_name, value) in obj {
        let config = match value.as_object() {
            Some(config) => config,
            None => continue,
        };

        let auth_type = config.get("type").and_then(Value::as_str).unwrap_or("");

        let credentials = if auth_type == "api" {
            config
                .get("key")
                .and_then(Value::as_str)
                .map(|key| ProviderCredentials {
                    api_key: key.to_string(),
                    source: "opencode".to_string(),
                    auth_type: AuthType::ApiKey,
                    provider: provider_name.to_string(),
                })
        } else if auth_type == "oauth" && include_oauth {
            let expires = config.get("expires").and_then(Value::as_i64);
            if let Some(expires) = expires {
                if expires < current_epoch_millis() {
                    None
                } else {
                    config
                        .get("access")
                        .and_then(Value::as_str)
                        .map(|token| ProviderCredentials {
                            api_key: token.to_string(),
                            source: "opencode".to_string(),
                            auth_type: AuthType::Oauth,
                            provider: provider_name.to_string(),
                        })
                }
            } else {
                config
                    .get("access")
                    .and_then(Value::as_str)
                    .map(|token| ProviderCredentials {
                        api_key: token.to_string(),
                        source: "opencode".to_string(),
                        auth_type: AuthType::Oauth,
                        provider: provider_name.to_string(),
                    })
            }
        } else {
            None
        };

        if let Some(credentials) = credentials {
            if provider_name == "anthropic" {
                result.anthropic = Some(credentials.clone());
            } else if provider_name == "openai" {
                result.openai = Some(credentials.clone());
            } else {
                result
                    .other
                    .insert(provider_name.to_string(), credentials.clone());
            }
        }
    }

    result
}

pub fn extract_amp_credentials(
    options: &CredentialExtractionOptions,
) -> Option<ProviderCredentials> {
    let home_dir = options.home_dir.clone().unwrap_or_else(default_home_dir);
    let path = home_dir.join(".amp").join("config.json");
    let data = read_json_file(&path)?;

    let key_paths: Vec<Vec<&str>> = vec![
        vec!["anthropicApiKey"],
        vec!["anthropic_api_key"],
        vec!["apiKey"],
        vec!["api_key"],
        vec!["accessToken"],
        vec!["access_token"],
        vec!["token"],
        vec!["auth", "anthropicApiKey"],
        vec!["auth", "apiKey"],
        vec!["auth", "token"],
        vec!["anthropic", "apiKey"],
        vec!["anthropic", "token"],
    ];

    for key_path in key_paths {
        if let Some(key) = read_string_field(&data, &key_path) {
            if !key.is_empty() {
                return Some(ProviderCredentials {
                    api_key: key,
                    source: "amp".to_string(),
                    auth_type: AuthType::ApiKey,
                    provider: "anthropic".to_string(),
                });
            }
        }
    }

    None
}

pub fn extract_all_credentials(options: &CredentialExtractionOptions) -> ExtractedCredentials {
    let mut result = ExtractedCredentials::default();

    if let Ok(value) = std::env::var("ANTHROPIC_API_KEY") {
        result.anthropic = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        });
    } else if let Ok(value) = std::env::var("CLAUDE_API_KEY") {
        result.anthropic = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "anthropic".to_string(),
        });
    } else if options.include_oauth {
        if let Ok(value) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
            result.anthropic = Some(ProviderCredentials {
                api_key: value,
                source: "environment".to_string(),
                auth_type: AuthType::Oauth,
                provider: "anthropic".to_string(),
            });
        } else if let Ok(value) = std::env::var("ANTHROPIC_AUTH_TOKEN") {
            result.anthropic = Some(ProviderCredentials {
                api_key: value,
                source: "environment".to_string(),
                auth_type: AuthType::Oauth,
                provider: "anthropic".to_string(),
            });
        }
    }

    if let Ok(value) = std::env::var("OPENAI_API_KEY") {
        result.openai = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        });
    } else if let Ok(value) = std::env::var("CODEX_API_KEY") {
        result.openai = Some(ProviderCredentials {
            api_key: value,
            source: "environment".to_string(),
            auth_type: AuthType::ApiKey,
            provider: "openai".to_string(),
        });
    }

    if result.anthropic.is_none() {
        result.anthropic = extract_amp_credentials(options);
    }

    if result.anthropic.is_none() {
        result.anthropic = extract_claude_credentials(options);
    }

    if result.openai.is_none() {
        result.openai = extract_codex_credentials(options);
    }

    let opencode_credentials = extract_opencode_credentials(options);
    if result.anthropic.is_none() {
        result.anthropic = opencode_credentials.anthropic.clone();
    }
    if result.openai.is_none() {
        result.openai = opencode_credentials.openai.clone();
    }

    for (key, value) in opencode_credentials.other {
        result.other.entry(key).or_insert(value);
    }

    result
}

pub fn get_anthropic_api_key(options: &CredentialExtractionOptions) -> Option<String> {
    extract_all_credentials(options)
        .anthropic
        .map(|cred| cred.api_key)
}

pub fn get_openai_api_key(options: &CredentialExtractionOptions) -> Option<String> {
    extract_all_credentials(options)
        .openai
        .map(|cred| cred.api_key)
}

pub fn set_credentials_as_env_vars(credentials: &ExtractedCredentials) {
    if let Some(cred) = &credentials.anthropic {
        // ApiKeyHelper credentials don't have a static key to set —
        // the agent obtains its own token via the helper command
        if cred.auth_type != AuthType::ApiKeyHelper {
            std::env::set_var("ANTHROPIC_API_KEY", &cred.api_key);
        }
    }
    if let Some(cred) = &credentials.openai {
        std::env::set_var("OPENAI_API_KEY", &cred.api_key);
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn read_string_field(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn default_home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn current_epoch_millis() -> i64 {
    let now = OffsetDateTime::now_utc();
    (now.unix_timestamp() * 1000) + (now.millisecond() as i64)
}

fn is_expired_rfc3339(value: &str) -> bool {
    match OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339) {
        Ok(expiry) => expiry < OffsetDateTime::now_utc(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const ANTHROPIC_ENV_KEYS: [&str; 5] = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "OPENAI_API_KEY",
    ];

    fn with_env(mutations: &[(&str, Option<&str>)], test_fn: impl FnOnce()) {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");

        let mut snapshot: HashMap<String, Option<String>> = HashMap::new();
        for key in ANTHROPIC_ENV_KEYS {
            snapshot.insert(key.to_string(), std::env::var(key).ok());
        }

        for (key, value) in mutations {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        test_fn();

        for (key, value) in snapshot {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    fn empty_home_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("sandbox-agent-agent-credentials-test-{nanos}"));
        fs::create_dir_all(&path).expect("failed to create temp home dir");
        path
    }

    #[test]
    fn extract_all_credentials_reads_claude_code_oauth_env() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from oauth env");

                assert_eq!(anthropic.api_key, "oauth-token-123");
                assert_eq!(anthropic.source, "environment");
                assert_eq!(anthropic.auth_type, AuthType::Oauth);
                assert_eq!(anthropic.provider, "anthropic");
            },
        );
    }

    #[test]
    fn extract_all_credentials_ignores_oauth_env_when_disabled() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: false,
                };
                let creds = extract_all_credentials(&options);
                assert!(
                    creds.anthropic.is_none(),
                    "oauth env should be ignored when include_oauth is false"
                );
            },
        );
    }

    #[test]
    fn extract_claude_oauth_from_json_with_epoch_millis_expiry() {
        let future_ms = current_epoch_millis() + 3_600_000; // 1 hour from now
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-test-token",
                "expiresAt": future_ms,
            }
        });
        let cred = extract_claude_oauth_from_json(&data).expect("should extract valid oauth");
        assert_eq!(cred.api_key, "sk-ant-oat01-test-token");
        assert_eq!(cred.source, "claude-code");
        assert_eq!(cred.auth_type, AuthType::Oauth);
        assert_eq!(cred.provider, "anthropic");
    }

    #[test]
    fn extract_claude_oauth_from_json_expired_epoch_millis() {
        let past_ms = current_epoch_millis() - 3_600_000; // 1 hour ago
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-expired",
                "expiresAt": past_ms,
            }
        });
        assert!(
            extract_claude_oauth_from_json(&data).is_none(),
            "should reject expired token"
        );
    }

    #[test]
    fn extract_claude_oauth_from_json_with_rfc3339_expiry() {
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-rfc-token",
                "expiresAt": "2099-01-01T00:00:00Z",
            }
        });
        let cred = extract_claude_oauth_from_json(&data).expect("should extract valid oauth");
        assert_eq!(cred.api_key, "sk-ant-oat01-rfc-token");
    }

    #[test]
    fn extract_claude_oauth_from_json_expired_rfc3339() {
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-old",
                "expiresAt": "2020-01-01T00:00:00Z",
            }
        });
        assert!(
            extract_claude_oauth_from_json(&data).is_none(),
            "should reject expired rfc3339 token"
        );
    }

    #[test]
    fn extract_claude_oauth_from_json_empty_access_token() {
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "",
                "expiresAt": 9999999999999_i64,
            }
        });
        assert!(
            extract_claude_oauth_from_json(&data).is_none(),
            "should reject empty access token"
        );
    }

    #[test]
    fn extract_claude_oauth_from_json_no_expiry() {
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-no-expiry",
            }
        });
        let cred =
            extract_claude_oauth_from_json(&data).expect("should accept token without expiry");
        assert_eq!(cred.api_key, "sk-ant-oat01-no-expiry");
    }

    #[test]
    fn extract_claude_oauth_from_json_with_extra_fields() {
        let future_ms = current_epoch_millis() + 3_600_000;
        let data = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-full",
                "refreshToken": "sk-ant-ort01-refresh",
                "expiresAt": future_ms,
                "scopes": ["user:inference"],
                "subscriptionType": "max",
            },
            "mcpOAuth": {}
        });
        let cred = extract_claude_oauth_from_json(&data).expect("should extract oauth");
        assert_eq!(cred.api_key, "sk-ant-oat01-full");
    }

    #[test]
    fn extract_claude_credentials_detects_api_key_helper() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", None),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let home = empty_home_dir();
                let claude_dir = home.join(".claude");
                fs::create_dir_all(&claude_dir).unwrap();
                fs::write(
                    claude_dir.join("settings.json"),
                    r#"{"apiKeyHelper": "/opt/dev/bin/user/devx llm-gateway print-token --key"}"#,
                )
                .unwrap();

                let options = CredentialExtractionOptions {
                    home_dir: Some(home),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from apiKeyHelper");

                assert_eq!(anthropic.source, "claude-code-api-key-helper");
                assert_eq!(anthropic.auth_type, AuthType::ApiKeyHelper);
                assert_eq!(anthropic.provider, "anthropic");
                assert!(anthropic.api_key.is_empty());
            },
        );
    }

    #[test]
    fn extract_claude_credentials_ignores_empty_api_key_helper() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", None),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", None),
                ("ANTHROPIC_AUTH_TOKEN", None),
            ],
            || {
                let home = empty_home_dir();
                let claude_dir = home.join(".claude");
                fs::create_dir_all(&claude_dir).unwrap();
                fs::write(
                    claude_dir.join("settings.json"),
                    r#"{"apiKeyHelper": ""}"#,
                )
                .unwrap();

                let options = CredentialExtractionOptions {
                    home_dir: Some(home),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                assert!(
                    creds.anthropic.is_none(),
                    "empty apiKeyHelper should not produce credentials"
                );
            },
        );
    }

    #[test]
    fn extract_all_credentials_prefers_api_key_over_oauth_env() {
        with_env(
            &[
                ("ANTHROPIC_API_KEY", Some("sk-ant-priority")),
                ("CLAUDE_API_KEY", None),
                ("CLAUDE_CODE_OAUTH_TOKEN", Some("oauth-token-123")),
                ("ANTHROPIC_AUTH_TOKEN", Some("oauth-token-456")),
            ],
            || {
                let options = CredentialExtractionOptions {
                    home_dir: Some(empty_home_dir()),
                    include_oauth: true,
                };
                let creds = extract_all_credentials(&options);
                let anthropic = creds
                    .anthropic
                    .expect("expected anthropic credentials from api key env");

                assert_eq!(anthropic.api_key, "sk-ant-priority");
                assert_eq!(anthropic.auth_type, AuthType::ApiKey);
            },
        );
    }
}
