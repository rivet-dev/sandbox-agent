use clap::Parser;
use sandbox_agent::cli::{
    CliConfig, CliError, Command, GigacodeCli, OpencodeArgs, init_logging, run_command,
};

fn main() {
    if let Err(err) = run() {
        tracing::error!(error = %err, "gigacode failed");
        std::process::exit(1);
    }
}

fn run() -> Result<(), CliError> {
    let cli = GigacodeCli::parse();
    let config = CliConfig {
        token: cli.token,
        no_token: cli.no_token,
        gigacode: true,
    };
    let command = cli
        .command
        .unwrap_or_else(|| Command::Opencode(OpencodeArgs::default()));
    if let Err(err) = init_logging(&command) {
        eprintln!("failed to init logging: {err}");
        return Err(err);
    }
    run_command(&command, &config)
}
