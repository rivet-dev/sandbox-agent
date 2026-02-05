use sandbox_agent_agent_management::agents::{AgentId, AgentManager, InstallOptions, SpawnOptions};

/// Tests that raw_args are passed to CLI-based agents.
/// We use `--version` as a raw arg which causes agents to print version info and exit.
#[test]
fn test_raw_args_version_flag() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = tempfile::tempdir()?;
    let manager = AgentManager::new(temp_dir.path().join("bin"))?;

    // Test Claude with --version
    manager.install(AgentId::Claude, InstallOptions::default())?;
    let mut spawn = SpawnOptions::new("test");
    spawn.raw_args = vec!["--version".to_string()];
    let result = manager.spawn(AgentId::Claude, spawn)?;
    let output = format!("{}{}", result.stdout, result.stderr);
    assert!(
        output.to_lowercase().contains("version")
            || output.contains("claude")
            || result.status.code() == Some(0),
        "Claude --version failed: {output}"
    );

    // Test OpenCode with --version
    manager.install(AgentId::Opencode, InstallOptions::default())?;
    let mut spawn = SpawnOptions::new("test");
    spawn.raw_args = vec!["--version".to_string()];
    let result = manager.spawn(AgentId::Opencode, spawn)?;
    let output = format!("{}{}", result.stdout, result.stderr);
    assert!(
        output.to_lowercase().contains("version")
            || output.contains("opencode")
            || result.status.code() == Some(0),
        "OpenCode --version failed: {output}"
    );

    // Test Amp with --version
    manager.install(AgentId::Amp, InstallOptions::default())?;
    let mut spawn = SpawnOptions::new("test");
    spawn.raw_args = vec!["--version".to_string()];
    let result = manager.spawn(AgentId::Amp, spawn)?;
    let output = format!("{}{}", result.stdout, result.stderr);
    assert!(
        output.to_lowercase().contains("version")
            || output.contains("amp")
            || result.status.code() == Some(0),
        "Amp --version failed: {output}"
    );

    Ok(())
}
