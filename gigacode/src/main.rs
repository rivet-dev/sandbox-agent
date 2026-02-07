use clap::Parser;
use sandbox_agent::cli::{
    init_logging, run_command, CliConfig, CliError, Command, GigacodeCli, OpencodeArgs,
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
    let yolo = cli.yolo;
    let command = match cli.command {
        Some(Command::Opencode(mut args)) => {
            args.yolo = args.yolo || yolo;
            Command::Opencode(args)
        }
        Some(other) => other,
        None => {
            let mut args = OpencodeArgs::default();
            args.yolo = yolo;
            Command::Opencode(args)
        }
    };
    if let Err(err) = init_logging(&command) {
        eprintln!("failed to init logging: {err}");
        return Err(err);
    }
    run_command(&command, &config)
}
