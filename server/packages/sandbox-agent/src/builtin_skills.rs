//! Built-in skills and CLAUDE.md instructions that are automatically written
//! to the agent's config directory when an agent instance is created.
//!
//! Each skill is embedded at compile time from `builtin-skills/` and written to
//! disk so the agent process can discover it. A global CLAUDE.md with behavioral
//! directives is also injected into `~/.claude/CLAUDE.md`.
//!
//! Set `SANDBOX_AGENT_SKIP_BUILTIN_SKILLS=1` to disable auto-injection.

use std::fs;
use std::path::PathBuf;

/// Embedded content of the sandbox-agent-processes skill.
const SANDBOX_AGENT_PROCESSES_SKILL: &str =
    include_str!("../builtin-skills/sandbox-agent-processes/SKILL.md");

/// Embedded CLAUDE.md with behavioral directives for the agent.
const BUILTIN_CLAUDE_MD: &str = include_str!("../builtin-skills/CLAUDE.md");

/// Marker used to identify the sandbox-agent-managed section in CLAUDE.md.
const CLAUDE_MD_MARKER_START: &str = "<!-- BEGIN SANDBOX-AGENT-MANAGED -->";
const CLAUDE_MD_MARKER_END: &str = "<!-- END SANDBOX-AGENT-MANAGED -->";

/// Returns `true` if built-in skill injection is disabled via environment variable.
fn is_disabled() -> bool {
    std::env::var("SANDBOX_AGENT_SKIP_BUILTIN_SKILLS")
        .ok()
        .is_some_and(|v| {
            let t = v.trim();
            t == "1" || t.eq_ignore_ascii_case("true") || t.eq_ignore_ascii_case("yes")
        })
}

/// Writes all built-in skills and the global CLAUDE.md to the agent's personal
/// config directory (`~/.claude/`). No-op if `SANDBOX_AGENT_SKIP_BUILTIN_SKILLS=1`.
///
/// The `server_url` is substituted into the content so the agent knows which
/// endpoint to call.
pub fn write_builtin_skills(server_url: Option<&str>) {
    if is_disabled() {
        tracing::debug!("builtin skills: injection disabled via SANDBOX_AGENT_SKIP_BUILTIN_SKILLS");
        return;
    }

    let Some(home) = dirs::home_dir() else {
        tracing::warn!("builtin skills: cannot determine home directory, skipping");
        return;
    };

    let claude_dir = home.join(".claude");

    // Write skills
    let skills_dir = claude_dir.join("skills");
    write_skill(
        &skills_dir,
        "sandbox-agent-processes",
        SANDBOX_AGENT_PROCESSES_SKILL,
        server_url,
    );

    // Write/update CLAUDE.md with behavioral directives
    write_claude_md(&claude_dir, server_url);
}

/// Writes a single skill's SKILL.md into `{skills_dir}/{name}/SKILL.md`,
/// creating directories as needed.
fn write_skill(skills_dir: &PathBuf, name: &str, content: &str, server_url: Option<&str>) {
    let dir = skills_dir.join(name);
    if let Err(err) = fs::create_dir_all(&dir) {
        tracing::warn!(
            skill = name,
            error = %err,
            "builtin skills: failed to create skill directory"
        );
        return;
    }

    let final_content = substitute_url(content, server_url);

    let path = dir.join("SKILL.md");
    match fs::write(&path, final_content) {
        Ok(()) => {
            tracing::info!(skill = name, path = %path.display(), "builtin skills: written");
        }
        Err(err) => {
            tracing::warn!(
                skill = name,
                error = %err,
                "builtin skills: failed to write SKILL.md"
            );
        }
    }
}

/// Writes or updates the sandbox-agent-managed section of `~/.claude/CLAUDE.md`.
///
/// If the file already exists, only the section between the marker comments is
/// replaced. If no markers exist, the section is appended. If the file does not
/// exist, it is created.
fn write_claude_md(claude_dir: &PathBuf, server_url: Option<&str>) {
    let path = claude_dir.join("CLAUDE.md");
    let managed_block = format!(
        "{}\n{}\n{}",
        CLAUDE_MD_MARKER_START,
        substitute_url(BUILTIN_CLAUDE_MD, server_url).trim(),
        CLAUDE_MD_MARKER_END,
    );

    let new_content = match fs::read_to_string(&path) {
        Ok(existing) => {
            if let (Some(start), Some(end)) = (
                existing.find(CLAUDE_MD_MARKER_START),
                existing.find(CLAUDE_MD_MARKER_END),
            ) {
                // Replace existing managed section
                let before = existing[..start].trim_end();
                let after = existing[end + CLAUDE_MD_MARKER_END.len()..].trim_start();
                if before.is_empty() && after.is_empty() {
                    format!("{}\n", managed_block)
                } else if before.is_empty() {
                    format!("{}\n\n{}", managed_block, after)
                } else if after.is_empty() {
                    format!("{}\n\n{}\n", before, managed_block)
                } else {
                    format!("{}\n\n{}\n\n{}", before, managed_block, after)
                }
            } else {
                // Append managed section
                if existing.trim().is_empty() {
                    managed_block
                } else {
                    format!("{}\n\n{}\n", existing.trim_end(), managed_block)
                }
            }
        }
        Err(_) => {
            // File doesn't exist, create it
            format!("{}\n", managed_block)
        }
    };

    match fs::write(&path, new_content) {
        Ok(()) => {
            tracing::info!(path = %path.display(), "builtin skills: CLAUDE.md written");
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                "builtin skills: failed to write CLAUDE.md"
            );
        }
    }
}

/// Replace `$SANDBOX_AGENT_URL` placeholder with the actual server URL.
fn substitute_url(content: &str, server_url: Option<&str>) -> String {
    if let Some(url) = server_url {
        content.replace("$SANDBOX_AGENT_URL", url)
    } else {
        content.to_string()
    }
}
