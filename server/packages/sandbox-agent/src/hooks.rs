//! Universal hooks support for sandbox-agent.
//!
//! Hooks are shell commands executed at specific lifecycle points in a session.
//! They are managed by sandbox-agent itself (not the underlying agent) and work
//! universally across all agents (Claude, Codex, OpenCode, Amp, Mock).
//!
//! # Hook Types
//!
//! - `on_session_start` - Executed when a session is created
//! - `on_session_end` - Executed when a session terminates
//! - `on_message_start` - Executed before processing each message
//! - `on_message_end` - Executed after each message is fully processed
//!
//! # Environment Variables
//!
//! Hooks receive context via environment variables:
//! - `SANDBOX_SESSION_ID` - The session identifier
//! - `SANDBOX_AGENT` - The agent type (e.g., "claude", "codex", "mock")
//! - `SANDBOX_AGENT_MODE` - The agent mode
//! - `SANDBOX_HOOK_TYPE` - The hook type being executed
//! - `SANDBOX_MESSAGE` - The message content (for message hooks)

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;
use tracing::{debug, error, info, warn};
use utoipa::ToSchema;

/// Default timeout for hook execution in seconds.
const DEFAULT_HOOK_TIMEOUT_SECS: u64 = 30;

/// Maximum output size to capture from hooks (64KB).
const MAX_OUTPUT_SIZE: usize = 64 * 1024;

/// Configuration for hooks in a session.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HooksConfig {
    /// Hooks to run when a session starts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on_session_start: Vec<HookDefinition>,

    /// Hooks to run when a session ends.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on_session_end: Vec<HookDefinition>,

    /// Hooks to run before processing each message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on_message_start: Vec<HookDefinition>,

    /// Hooks to run after each message is fully processed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on_message_end: Vec<HookDefinition>,
}

impl HooksConfig {
    /// Returns true if no hooks are configured.
    pub fn is_empty(&self) -> bool {
        self.on_session_start.is_empty()
            && self.on_session_end.is_empty()
            && self.on_message_start.is_empty()
            && self.on_message_end.is_empty()
    }
}

/// Definition of a single hook.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HookDefinition {
    /// Shell command to execute.
    pub command: String,

    /// Timeout in seconds. Defaults to 30 seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,

    /// Working directory for the command. Defaults to the session's working directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,

    /// Whether to continue if the hook fails. Defaults to true.
    #[serde(default = "default_continue_on_failure")]
    pub continue_on_failure: bool,
}

fn default_continue_on_failure() -> bool {
    true
}

/// Type of hook being executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookType {
    SessionStart,
    SessionEnd,
    MessageStart,
    MessageEnd,
}

impl HookType {
    /// Returns the string representation used in environment variables.
    pub fn as_str(&self) -> &'static str {
        match self {
            HookType::SessionStart => "session_start",
            HookType::SessionEnd => "session_end",
            HookType::MessageStart => "message_start",
            HookType::MessageEnd => "message_end",
        }
    }
}

/// Context passed to hooks via environment variables.
#[derive(Debug, Clone)]
pub struct HookContext {
    pub session_id: String,
    pub agent: String,
    pub agent_mode: String,
    pub hook_type: HookType,
    pub message: Option<String>,
    pub working_dir: Option<String>,
}

/// Result of executing a single hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookResult {
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/// Result of executing all hooks for a lifecycle event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HooksExecutionResult {
    pub hook_type: String,
    pub results: Vec<HookResult>,
    pub all_succeeded: bool,
    pub should_continue: bool,
}

/// Executes hooks for a given lifecycle event.
pub async fn execute_hooks(
    hooks: &[HookDefinition],
    context: &HookContext,
) -> HooksExecutionResult {
    let mut results = Vec::new();
    let mut all_succeeded = true;
    let mut should_continue = true;

    for hook in hooks {
        let result = execute_single_hook(hook, context).await;
        
        if !result.success {
            all_succeeded = false;
            if !hook.continue_on_failure {
                should_continue = false;
            }
        }

        results.push(result);

        if !should_continue {
            break;
        }
    }

    HooksExecutionResult {
        hook_type: context.hook_type.as_str().to_string(),
        results,
        all_succeeded,
        should_continue,
    }
}

/// Executes a single hook command.
async fn execute_single_hook(hook: &HookDefinition, context: &HookContext) -> HookResult {
    let start = std::time::Instant::now();
    let timeout_duration = Duration::from_secs(
        hook.timeout_secs.unwrap_or(DEFAULT_HOOK_TIMEOUT_SECS),
    );

    // Determine working directory
    let working_dir = hook
        .working_dir
        .clone()
        .or_else(|| context.working_dir.clone());

    info!(
        command = %hook.command,
        hook_type = %context.hook_type.as_str(),
        session_id = %context.session_id,
        "Executing hook"
    );

    // Build environment variables
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("SANDBOX_SESSION_ID".to_string(), context.session_id.clone());
    env.insert("SANDBOX_AGENT".to_string(), context.agent.clone());
    env.insert("SANDBOX_AGENT_MODE".to_string(), context.agent_mode.clone());
    env.insert("SANDBOX_HOOK_TYPE".to_string(), context.hook_type.as_str().to_string());
    if let Some(message) = &context.message {
        env.insert("SANDBOX_MESSAGE".to_string(), message.clone());
    }

    // Clone values for the blocking task
    let command = hook.command.clone();
    let command_for_result = hook.command.clone();

    // Execute in a blocking task with timeout
    let execution = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(&command);
        cmd.envs(&env);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(dir) = working_dir.as_ref() {
            if Path::new(dir).exists() {
                cmd.current_dir(dir);
            }
        }

        let mut child = cmd.spawn()?;
        
        let mut stdout = String::new();
        let mut stderr = String::new();

        if let Some(ref mut handle) = child.stdout {
            let mut buf = vec![0u8; MAX_OUTPUT_SIZE];
            let n = handle.read(&mut buf).unwrap_or(0);
            stdout = String::from_utf8_lossy(&buf[..n]).to_string();
        }

        if let Some(ref mut handle) = child.stderr {
            let mut buf = vec![0u8; MAX_OUTPUT_SIZE];
            let n = handle.read(&mut buf).unwrap_or(0);
            stderr = String::from_utf8_lossy(&buf[..n]).to_string();
        }

        let status = child.wait()?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    });

    match timeout(timeout_duration, execution).await {
        Ok(Ok(Ok((status, stdout, stderr)))) => {
            let exit_code = status.code();
            let success = status.success();
            let duration_ms = start.elapsed().as_millis() as u64;

            debug!(
                command = %command_for_result,
                success = %success,
                exit_code = ?exit_code,
                duration_ms = %duration_ms,
                "Hook completed"
            );

            if !success {
                warn!(
                    command = %command_for_result,
                    exit_code = ?exit_code,
                    stderr = %stderr,
                    "Hook failed"
                );
            }

            HookResult {
                command: command_for_result,
                success,
                exit_code,
                stdout,
                stderr,
                duration_ms,
                timed_out: false,
            }
        }
        Ok(Ok(Err(err))) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            error!(
                command = %command_for_result,
                error = %err,
                "Hook execution error"
            );
            HookResult {
                command: command_for_result,
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: err.to_string(),
                duration_ms,
                timed_out: false,
            }
        }
        Ok(Err(err)) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            error!(
                command = %command_for_result,
                error = %err,
                "Hook task join error"
            );
            HookResult {
                command: command_for_result,
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: err.to_string(),
                duration_ms,
                timed_out: false,
            }
        }
        Err(_) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            warn!(
                command = %command_for_result,
                timeout_secs = %timeout_duration.as_secs(),
                "Hook timed out"
            );
            HookResult {
                command: command_for_result,
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("Hook timed out after {} seconds", timeout_duration.as_secs()),
                duration_ms,
                timed_out: true,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_simple_hook_execution() {
        let hook = HookDefinition {
            command: "echo 'hello world'".to_string(),
            timeout_secs: None,
            working_dir: None,
            continue_on_failure: true,
        };

        let context = HookContext {
            session_id: "test-session".to_string(),
            agent: "mock".to_string(),
            agent_mode: "default".to_string(),
            hook_type: HookType::SessionStart,
            message: None,
            working_dir: None,
        };

        let result = execute_single_hook(&hook, &context).await;
        assert!(result.success);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("hello world"));
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn test_hook_with_env_vars() {
        let hook = HookDefinition {
            command: "echo $SANDBOX_SESSION_ID $SANDBOX_AGENT".to_string(),
            timeout_secs: None,
            working_dir: None,
            continue_on_failure: true,
        };

        let context = HookContext {
            session_id: "my-session-123".to_string(),
            agent: "codex".to_string(),
            agent_mode: "auto".to_string(),
            hook_type: HookType::MessageStart,
            message: Some("test message".to_string()),
            working_dir: None,
        };

        let result = execute_single_hook(&hook, &context).await;
        assert!(result.success);
        assert!(result.stdout.contains("my-session-123"));
        assert!(result.stdout.contains("codex"));
    }

    #[tokio::test]
    async fn test_hook_failure() {
        let hook = HookDefinition {
            command: "exit 1".to_string(),
            timeout_secs: None,
            working_dir: None,
            continue_on_failure: true,
        };

        let context = HookContext {
            session_id: "test".to_string(),
            agent: "mock".to_string(),
            agent_mode: "default".to_string(),
            hook_type: HookType::SessionEnd,
            message: None,
            working_dir: None,
        };

        let result = execute_single_hook(&hook, &context).await;
        assert!(!result.success);
        assert_eq!(result.exit_code, Some(1));
    }

    #[tokio::test]
    async fn test_hook_timeout() {
        let hook = HookDefinition {
            command: "sleep 10".to_string(),
            timeout_secs: Some(1),
            working_dir: None,
            continue_on_failure: true,
        };

        let context = HookContext {
            session_id: "test".to_string(),
            agent: "mock".to_string(),
            agent_mode: "default".to_string(),
            hook_type: HookType::MessageEnd,
            message: None,
            working_dir: None,
        };

        let result = execute_single_hook(&hook, &context).await;
        assert!(!result.success);
        assert!(result.timed_out);
    }

    #[tokio::test]
    async fn test_multiple_hooks_all_succeed() {
        let hooks = vec![
            HookDefinition {
                command: "echo 'first'".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true,
            },
            HookDefinition {
                command: "echo 'second'".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true,
            },
        ];

        let context = HookContext {
            session_id: "test".to_string(),
            agent: "mock".to_string(),
            agent_mode: "default".to_string(),
            hook_type: HookType::SessionStart,
            message: None,
            working_dir: None,
        };

        let result = execute_hooks(&hooks, &context).await;
        assert!(result.all_succeeded);
        assert!(result.should_continue);
        assert_eq!(result.results.len(), 2);
    }

    #[tokio::test]
    async fn test_hooks_stop_on_failure_when_configured() {
        let hooks = vec![
            HookDefinition {
                command: "echo 'first'".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true,
            },
            HookDefinition {
                command: "exit 1".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: false, // Don't continue on failure
            },
            HookDefinition {
                command: "echo 'third'".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true,
            },
        ];

        let context = HookContext {
            session_id: "test".to_string(),
            agent: "mock".to_string(),
            agent_mode: "default".to_string(),
            hook_type: HookType::MessageStart,
            message: None,
            working_dir: None,
        };

        let result = execute_hooks(&hooks, &context).await;
        assert!(!result.all_succeeded);
        assert!(!result.should_continue);
        // Third hook should not have been executed
        assert_eq!(result.results.len(), 2);
    }

    #[tokio::test]
    async fn test_hooks_continue_on_failure_when_configured() {
        let hooks = vec![
            HookDefinition {
                command: "exit 1".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true, // Continue despite failure
            },
            HookDefinition {
                command: "echo 'second'".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true,
            },
        ];

        let context = HookContext {
            session_id: "test".to_string(),
            agent: "mock".to_string(),
            agent_mode: "default".to_string(),
            hook_type: HookType::SessionEnd,
            message: None,
            working_dir: None,
        };

        let result = execute_hooks(&hooks, &context).await;
        assert!(!result.all_succeeded);
        assert!(result.should_continue);
        // Both hooks should have been executed
        assert_eq!(result.results.len(), 2);
        assert!(result.results[1].success);
    }

    #[test]
    fn test_hooks_config_is_empty() {
        let config = HooksConfig::default();
        assert!(config.is_empty());

        let config = HooksConfig {
            on_session_start: vec![HookDefinition {
                command: "echo test".to_string(),
                timeout_secs: None,
                working_dir: None,
                continue_on_failure: true,
            }],
            ..Default::default()
        };
        assert!(!config.is_empty());
    }
}
