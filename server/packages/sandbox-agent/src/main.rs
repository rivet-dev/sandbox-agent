fn main() {
    if let Err(err) = sandbox_agent::cli::run_sandbox_agent() {
        tracing::error!(error = %err, "sandbox-agent failed");
        std::process::exit(1);
    }
}
