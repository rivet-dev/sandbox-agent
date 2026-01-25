use std::collections::HashMap;

use sandbox_daemon_agent_management::agents::{
    AgentError, AgentId, AgentManager, InstallOptions, SpawnOptions,
};
use sandbox_daemon_agent_management::credentials::{
    extract_all_credentials, CredentialExtractionOptions,
};

fn build_env() -> HashMap<String, String> {
    let options = CredentialExtractionOptions::new();
    let credentials = extract_all_credentials(&options);
    let mut env = HashMap::new();
    if let Some(anthropic) = credentials.anthropic {
        env.insert("ANTHROPIC_API_KEY".to_string(), anthropic.api_key);
    }
    if let Some(openai) = credentials.openai {
        env.insert("OPENAI_API_KEY".to_string(), openai.api_key);
    }
    env
}

fn amp_configured() -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".amp").join("config.json").exists()
}

fn prompt_ok(label: &str) -> String {
    format!("Respond with exactly the text {label} and nothing else.")
}

#[test]
fn test_agents_install_version_spawn() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = tempfile::tempdir()?;
    let manager = AgentManager::new(temp_dir.path().join("bin"))?;
    let env = build_env();
    assert!(!env.is_empty(), "expected credentials to be available");

    let agents = [AgentId::Claude, AgentId::Codex, AgentId::Opencode, AgentId::Amp];
    for agent in agents {
        let install = manager.install(agent, InstallOptions::default())?;
        assert!(install.path.exists(), "expected install for {agent}");
        assert!(manager.is_installed(agent), "expected is_installed for {agent}");
        manager.install(
            agent,
            InstallOptions {
                reinstall: true,
                version: None,
            },
        )?;
        let version = manager.version(agent)?;
        assert!(version.is_some(), "expected version for {agent}");

        if agent != AgentId::Amp || amp_configured() {
            let mut spawn = SpawnOptions::new(prompt_ok("OK"));
            spawn.env = env.clone();
            let result = manager.spawn(agent, spawn)?;
            assert!(
                result.status.success(),
                "spawn failed for {agent}: {}",
                result.stderr
            );
            assert!(
                !result.events.is_empty(),
                "expected events for {agent} but got none"
            );
            assert!(
                result.session_id.is_some(),
                "expected session id for {agent}"
            );
            let combined = format!("{}{}", result.stdout, result.stderr);
            let output = result.result.clone().unwrap_or(combined);
            assert!(output.contains("OK"), "expected OK for {agent}, got: {output}");

            if agent == AgentId::Claude || agent == AgentId::Opencode || (agent == AgentId::Amp && amp_configured()) {
                let mut resume = SpawnOptions::new(prompt_ok("OK2"));
                resume.env = env.clone();
                resume.session_id = result.session_id.clone();
                let resumed = manager.spawn(agent, resume)?;
                assert!(
                    resumed.status.success(),
                    "resume spawn failed for {agent}: {}",
                    resumed.stderr
                );
                let combined = format!("{}{}", resumed.stdout, resumed.stderr);
                let output = resumed.result.clone().unwrap_or(combined);
                assert!(output.contains("OK2"), "expected OK2 for {agent}, got: {output}");
            } else if agent == AgentId::Codex {
                let mut resume = SpawnOptions::new(prompt_ok("OK2"));
                resume.env = env.clone();
                resume.session_id = result.session_id.clone();
                let err = manager.spawn(agent, resume).expect_err("expected resume error for codex");
                assert!(matches!(err, AgentError::ResumeUnsupported { .. }));
            }

            if agent == AgentId::Claude || agent == AgentId::Codex {
                let mut plan = SpawnOptions::new(prompt_ok("OK3"));
                plan.env = env.clone();
                plan.permission_mode = Some("plan".to_string());
                let planned = manager.spawn(agent, plan)?;
                assert!(
                    planned.status.success(),
                    "plan spawn failed for {agent}: {}",
                    planned.stderr
                );
                let combined = format!("{}{}", planned.stdout, planned.stderr);
                let output = planned.result.clone().unwrap_or(combined);
                assert!(output.contains("OK3"), "expected OK3 for {agent}, got: {output}");
            }
        }
    }

    Ok(())
}
