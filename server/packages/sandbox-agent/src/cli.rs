use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::Arc;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};

// Include the generated version constant
mod build_version {
    include!(concat!(env!("OUT_DIR"), "/version.rs"));
}
use reqwest::blocking::Client as HttpClient;
use reqwest::Method;
use crate::router::{build_router_with_state, shutdown_servers};
use crate::router::{
    AgentInstallRequest, AppState, AuthConfig, CreateSessionRequest, MessageRequest,
    PermissionReply, PermissionReplyRequest, QuestionReplyRequest,
};
use crate::router::{
    AgentListResponse, AgentModelsResponse, AgentModesResponse, CreateSessionResponse,
    EventsResponse, SessionListResponse,
};
use crate::server_logs::ServerLogs;
use crate::telemetry;
use crate::ui;
use sandbox_agent_agent_management::agents::{AgentId, AgentManager, InstallOptions};
use sandbox_agent_agent_management::credentials::{
    extract_all_credentials, AuthType, CredentialExtractionOptions, ExtractedCredentials,
    ProviderCredentials,
};
use serde::Serialize;
use serde_json::{json, Value};
use thiserror::Error;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const API_PREFIX: &str = "/v1";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 2468;
const LOGS_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Parser, Debug)]
#[command(name = "sandbox-agent", bin_name = "sandbox-agent")]
#[command(about = "https://sandboxagent.dev", version = build_version::VERSION)]
#[command(arg_required_else_help = true)]
pub struct SandboxAgentCli {
    #[command(subcommand)]
    command: Command,

    #[arg(long, short = 't', global = true)]
    token: Option<String>,

    #[arg(long, short = 'n', global = true)]
    no_token: bool,
}

#[derive(Parser, Debug)]
#[command(name = "gigacode", bin_name = "gigacode")]
#[command(about = "https://sandboxagent.dev", version = build_version::VERSION)]
pub struct GigacodeCli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[arg(long, short = 't', global = true)]
    pub token: Option<String>,

    #[arg(long, short = 'n', global = true)]
    pub no_token: bool,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the sandbox agent HTTP server.
    Server(ServerArgs),
    /// Call the HTTP API without writing client code.
    Api(ApiArgs),
    /// EXPERIMENTAL: Start a sandbox-agent server and attach an OpenCode session.
    Opencode(OpencodeArgs),
    /// Manage the sandbox-agent background daemon.
    Daemon(DaemonArgs),
    /// Install or reinstall an agent without running the server.
    InstallAgent(InstallAgentArgs),
    /// Inspect locally discovered credentials.
    Credentials(CredentialsArgs),
}

#[derive(Args, Debug)]
pub struct ServerArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,

    #[arg(long = "cors-allow-origin", short = 'O')]
    cors_allow_origin: Vec<String>,

    #[arg(long = "cors-allow-method", short = 'M')]
    cors_allow_method: Vec<String>,

    #[arg(long = "cors-allow-header", short = 'A')]
    cors_allow_header: Vec<String>,

    #[arg(long = "cors-allow-credentials", short = 'C')]
    cors_allow_credentials: bool,

    #[arg(long = "no-telemetry")]
    no_telemetry: bool,
}

#[derive(Args, Debug)]
pub struct ApiArgs {
    #[command(subcommand)]
    command: ApiCommand,
}

#[derive(Args, Debug)]
pub struct OpencodeArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,

    #[arg(long)]
    session_title: Option<String>,

    #[arg(long)]
    opencode_bin: Option<PathBuf>,
}

impl Default for OpencodeArgs {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            session_title: None,
            opencode_bin: None,
        }
    }
}

#[derive(Args, Debug)]
pub struct CredentialsArgs {
    #[command(subcommand)]
    command: CredentialsCommand,
}

#[derive(Args, Debug)]
pub struct DaemonArgs {
    #[command(subcommand)]
    command: DaemonCommand,
}

#[derive(Subcommand, Debug)]
pub enum DaemonCommand {
    /// Start the daemon in the background.
    Start(DaemonStartArgs),
    /// Stop a running daemon.
    Stop(DaemonStopArgs),
    /// Show daemon status.
    Status(DaemonStatusArgs),
}

#[derive(Args, Debug)]
pub struct DaemonStartArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Args, Debug)]
pub struct DaemonStopArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Args, Debug)]
pub struct DaemonStatusArgs {
    #[arg(long, short = 'H', default_value = DEFAULT_HOST)]
    host: String,

    #[arg(long, short = 'p', default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Subcommand, Debug)]
pub enum ApiCommand {
    /// Manage installed agents and their modes.
    Agents(AgentsArgs),
    /// Create sessions and interact with session events.
    Sessions(SessionsArgs),
}

#[derive(Subcommand, Debug)]
pub enum CredentialsCommand {
    /// Extract credentials using local discovery rules.
    Extract(CredentialsExtractArgs),
    /// Output credentials as environment variable assignments.
    #[command(name = "extract-env")]
    ExtractEnv(CredentialsExtractEnvArgs),
}

#[derive(Args, Debug)]
pub struct AgentsArgs {
    #[command(subcommand)]
    command: AgentsCommand,
}

#[derive(Args, Debug)]
pub struct SessionsArgs {
    #[command(subcommand)]
    command: SessionsCommand,
}

#[derive(Subcommand, Debug)]
pub enum AgentsCommand {
    /// List all agents and install status.
    List(ClientArgs),
    /// Install or reinstall an agent.
    Install(ApiInstallAgentArgs),
    /// Show available modes for an agent.
    Modes(AgentModesArgs),
    /// Show available models for an agent.
    Models(AgentModelsArgs),
}

#[derive(Subcommand, Debug)]
pub enum SessionsCommand {
    /// List active sessions.
    List(ClientArgs),
    /// Create a new session for an agent.
    Create(CreateSessionArgs),
    #[command(name = "send-message")]
    /// Send a message to an existing session.
    SendMessage(SessionMessageArgs),
    #[command(name = "send-message-stream")]
    /// Send a message and stream the response for one turn.
    SendMessageStream(SessionMessageStreamArgs),
    #[command(name = "terminate")]
    /// Terminate a session.
    Terminate(SessionTerminateArgs),
    #[command(name = "get-messages")]
    /// Alias for events; returns session events.
    GetMessages(SessionEventsArgs),
    #[command(name = "events")]
    /// Fetch session events with offset/limit.
    Events(SessionEventsArgs),
    #[command(name = "events-sse")]
    /// Stream session events over SSE.
    EventsSse(SessionEventsSseArgs),
    #[command(name = "reply-question")]
    /// Reply to a question event.
    ReplyQuestion(QuestionReplyArgs),
    #[command(name = "reject-question")]
    /// Reject a question event.
    RejectQuestion(QuestionRejectArgs),
    #[command(name = "reply-permission")]
    /// Reply to a permission request.
    ReplyPermission(PermissionReplyArgs),
}

#[derive(Args, Debug, Clone)]
pub struct ClientArgs {
    #[arg(long, short = 'e')]
    endpoint: Option<String>,
}

#[derive(Args, Debug)]
pub struct ApiInstallAgentArgs {
    agent: String,
    #[arg(long, short = 'r')]
    reinstall: bool,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct InstallAgentArgs {
    agent: String,
    #[arg(long, short = 'r')]
    reinstall: bool,
}

#[derive(Args, Debug)]
pub struct AgentModesArgs {
    agent: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct AgentModelsArgs {
    agent: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct CreateSessionArgs {
    session_id: String,
    #[arg(long, short = 'a')]
    agent: String,
    #[arg(long, short = 'g')]
    agent_mode: Option<String>,
    #[arg(long, short = 'p')]
    permission_mode: Option<String>,
    #[arg(long, short = 'm')]
    model: Option<String>,
    #[arg(long, short = 'v')]
    variant: Option<String>,
    #[arg(long, short = 'A')]
    agent_version: Option<String>,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct SessionMessageArgs {
    session_id: String,
    #[arg(long, short = 'm')]
    message: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct SessionMessageStreamArgs {
    session_id: String,
    #[arg(long, short = 'm')]
    message: String,
    #[arg(long)]
    include_raw: bool,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct SessionEventsArgs {
    session_id: String,
    #[arg(long, short = 'o')]
    offset: Option<u64>,
    #[arg(long, short = 'l')]
    limit: Option<u64>,
    #[arg(long)]
    include_raw: bool,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct SessionEventsSseArgs {
    session_id: String,
    #[arg(long, short = 'o')]
    offset: Option<u64>,
    #[arg(long)]
    include_raw: bool,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct SessionTerminateArgs {
    session_id: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct QuestionReplyArgs {
    session_id: String,
    question_id: String,
    #[arg(long, short = 'a')]
    answers: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct QuestionRejectArgs {
    session_id: String,
    question_id: String,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct PermissionReplyArgs {
    session_id: String,
    permission_id: String,
    #[arg(long, short = 'r')]
    reply: PermissionReply,
    #[command(flatten)]
    client: ClientArgs,
}

#[derive(Args, Debug)]
pub struct CredentialsExtractArgs {
    #[arg(long, short = 'a', value_enum)]
    agent: Option<CredentialAgent>,
    #[arg(long, short = 'p')]
    provider: Option<String>,
    #[arg(long, short = 'd')]
    home_dir: Option<PathBuf>,
    #[arg(long)]
    no_oauth: bool,
    #[arg(long, short = 'r')]
    reveal: bool,
}

#[derive(Args, Debug)]
pub struct CredentialsExtractEnvArgs {
    /// Prefix each line with "export " for shell sourcing.
    #[arg(long, short = 'e')]
    export: bool,
    #[arg(long, short = 'd')]
    home_dir: Option<PathBuf>,
    #[arg(long)]
    no_oauth: bool,
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("invalid cors origin: {0}")]
    InvalidCorsOrigin(String),
    #[error("invalid cors method: {0}")]
    InvalidCorsMethod(String),
    #[error("invalid cors header: {0}")]
    InvalidCorsHeader(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("server error: {0}")]
    Server(String),
    #[error("unexpected http status: {0}")]
    HttpStatus(reqwest::StatusCode),
}

pub struct CliConfig {
    pub token: Option<String>,
    pub no_token: bool,
    pub gigacode: bool,
}

pub fn run_sandbox_agent() -> Result<(), CliError> {
    let cli = SandboxAgentCli::parse();
    let SandboxAgentCli {
        command,
        token,
        no_token,
    } = cli;
    let config = CliConfig { token, no_token, gigacode: false };
    if let Err(err) = init_logging(&command) {
        eprintln!("failed to init logging: {err}");
        return Err(err);
    }
    run_command(&command, &config)
}

pub fn init_logging(command: &Command) -> Result<(), CliError> {
    if matches!(command, Command::Server(_)) {
        maybe_redirect_server_logs();
    }

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_logfmt::builder()
                .layer()
                .with_writer(std::io::stderr),
        )
        .init();
    Ok(())
}

pub fn run_command(command: &Command, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        Command::Server(args) => run_server(cli, args),
        Command::Api(subcommand) => run_api(&subcommand.command, cli),
        Command::Opencode(args) => run_opencode(cli, args),
        Command::Daemon(subcommand) => run_daemon(&subcommand.command, cli),
        Command::InstallAgent(args) => install_agent_local(args),
        Command::Credentials(subcommand) => run_credentials(&subcommand.command),
    }
}

fn run_server(cli: &CliConfig, server: &ServerArgs) -> Result<(), CliError> {
    let auth = if let Some(token) = cli.token.clone() {
        AuthConfig::with_token(token)
    } else {
        AuthConfig::disabled()
    };

    let agent_manager = AgentManager::new(default_install_dir())
        .map_err(|err| CliError::Server(err.to_string()))?;
    let state = Arc::new(AppState::new(auth, agent_manager));
    let (mut router, state) = build_router_with_state(state);

    let cors = build_cors_layer(server)?;
    router = router.layer(cors);

    let addr = format!("{}:{}", server.host, server.port);
    let display_host = match server.host.as_str() {
        "0.0.0.0" | "::" => "localhost",
        other => other,
    };
    let inspector_url = format!("http://{}:{}/ui", display_host, server.port);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| CliError::Server(err.to_string()))?;

    let telemetry_enabled = telemetry::telemetry_enabled(server.no_telemetry);

    runtime.block_on(async move {
        if telemetry_enabled {
            telemetry::log_enabled_message();
            telemetry::spawn_telemetry_task();
        }
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        tracing::info!(addr = %addr, "server listening");
        if ui::is_enabled() {
            tracing::info!(url = %inspector_url, "inspector ui available");
        } else {
            tracing::info!("inspector ui not embedded; set SANDBOX_AGENT_SKIP_INSPECTOR=1 to skip embedding during builds");
        }
        let shutdown_state = state.clone();
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = tokio::signal::ctrl_c().await;
                shutdown_servers(&shutdown_state).await;
            })
            .await
            .map_err(|err| CliError::Server(err.to_string()))
    })
}

fn default_install_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("bin"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("bin"))
}

fn default_server_log_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SANDBOX_AGENT_LOG_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .map(|dir| dir.join("sandbox-agent").join("logs"))
        .unwrap_or_else(|| PathBuf::from(".").join(".sandbox-agent").join("logs"))
}

fn maybe_redirect_server_logs() {
    if std::env::var("SANDBOX_AGENT_LOG_STDOUT").is_ok() {
        return;
    }

    let log_dir = default_server_log_dir();
    if let Err(err) = ServerLogs::new(log_dir, LOGS_RETENTION).start_sync() {
        eprintln!("failed to redirect logs: {err}");
    }
}

fn run_api(command: &ApiCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        ApiCommand::Agents(subcommand) => run_agents(&subcommand.command, cli),
        ApiCommand::Sessions(subcommand) => run_sessions(&subcommand.command, cli),
    }
}

fn run_opencode(cli: &CliConfig, args: &OpencodeArgs) -> Result<(), CliError> {
    let name = if cli.gigacode { "GigaCode" } else { "OpenCode command" };
    write_stderr_line(&format!("EXPERIMENTAL: Please report bugs to:\n- GitHub: https://github.com/rivet-dev/sandbox-agent/issues\n- Discord: https://rivet.dev/discord\n\n{name} is powered by:- OpenCode (TUI): https://opencode.ai/\n- Sandbox Agent SDK (multi-agent compatibility): https://sandboxagent.dev/\n\n"))?;

    let token = cli.token.clone();

    let base_url = format!("http://{}:{}", args.host, args.port);
    crate::daemon::ensure_running(cli, &args.host, args.port, token.as_deref())?;

    let session_id =
        create_opencode_session(&base_url, token.as_deref(), args.session_title.as_deref())?;
    write_stdout_line(&format!("OpenCode session: {session_id}"))?;

    let attach_url = format!("{base_url}/opencode");
    let opencode_bin = resolve_opencode_bin(args.opencode_bin.as_ref())?;
    let mut opencode_cmd = ProcessCommand::new(opencode_bin);
    opencode_cmd
        .arg("attach")
        .arg(&attach_url)
        .arg("--session")
        .arg(&session_id)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(token) = token.as_deref() {
        opencode_cmd.arg("--password").arg(token);
    }

    let status = opencode_cmd
        .status()
        .map_err(|err| CliError::Server(format!("failed to start opencode: {err}")))?;

    if !status.success() {
        return Err(CliError::Server(format!(
            "opencode exited with status {status}"
        )));
    }

    Ok(())
}

fn run_daemon(command: &DaemonCommand, cli: &CliConfig) -> Result<(), CliError> {
    let token = cli.token.as_deref();
    match command {
        DaemonCommand::Start(args) => {
            crate::daemon::start(cli, &args.host, args.port, token)
        }
        DaemonCommand::Stop(args) => {
            crate::daemon::stop(&args.host, args.port)
        }
        DaemonCommand::Status(args) => {
            let st = crate::daemon::status(&args.host, args.port, token)?;
            write_stderr_line(&st.to_string())?;
            Ok(())
        }
    }
}

fn run_agents(command: &AgentsCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        AgentsCommand::List(args) => {
            let ctx = ClientContext::new(cli, args)?;
            let response = ctx.get(&format!("{API_PREFIX}/agents"))?;
            print_json_response::<AgentListResponse>(response)
        }
        AgentsCommand::Install(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let body = AgentInstallRequest {
                reinstall: if args.reinstall { Some(true) } else { None },
            };
            let path = format!("{API_PREFIX}/agents/{}/install", args.agent);
            let response = ctx.post(&path, &body)?;
            print_empty_response(response)
        }
        AgentsCommand::Modes(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = format!("{API_PREFIX}/agents/{}/modes", args.agent);
            let response = ctx.get(&path)?;
            print_json_response::<AgentModesResponse>(response)
        }
        AgentsCommand::Models(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = format!("{API_PREFIX}/agents/{}/models", args.agent);
            let response = ctx.get(&path)?;
            print_json_response::<AgentModelsResponse>(response)
        }
    }
}

fn run_sessions(command: &SessionsCommand, cli: &CliConfig) -> Result<(), CliError> {
    match command {
        SessionsCommand::List(args) => {
            let ctx = ClientContext::new(cli, args)?;
            let response = ctx.get(&format!("{API_PREFIX}/sessions"))?;
            print_json_response::<SessionListResponse>(response)
        }
        SessionsCommand::Create(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let body = CreateSessionRequest {
                agent: args.agent.clone(),
                agent_mode: args.agent_mode.clone(),
                permission_mode: args.permission_mode.clone(),
                model: args.model.clone(),
                variant: args.variant.clone(),
                agent_version: args.agent_version.clone(),
            };
            let path = format!("{API_PREFIX}/sessions/{}", args.session_id);
            let response = ctx.post(&path, &body)?;
            print_json_response::<CreateSessionResponse>(response)
        }
        SessionsCommand::SendMessage(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let body = MessageRequest {
                message: args.message.clone(),
            };
            let path = format!("{API_PREFIX}/sessions/{}/messages", args.session_id);
            let response = ctx.post(&path, &body)?;
            print_empty_response(response)
        }
        SessionsCommand::SendMessageStream(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let body = MessageRequest {
                message: args.message.clone(),
            };
            let path = format!("{API_PREFIX}/sessions/{}/messages/stream", args.session_id);
            let response = ctx.post_with_query(
                &path,
                &body,
                &[(
                    "include_raw",
                    if args.include_raw {
                        Some("true".to_string())
                    } else {
                        None
                    },
                )],
            )?;
            print_text_response(response)
        }
        SessionsCommand::Terminate(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = format!("{API_PREFIX}/sessions/{}/terminate", args.session_id);
            let response = ctx.post_empty(&path)?;
            print_empty_response(response)
        }
        SessionsCommand::GetMessages(args) | SessionsCommand::Events(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = format!("{API_PREFIX}/sessions/{}/events", args.session_id);
            let response = ctx.get_with_query(
                &path,
                &[
                    ("offset", args.offset.map(|v| v.to_string())),
                    ("limit", args.limit.map(|v| v.to_string())),
                    (
                        "include_raw",
                        if args.include_raw {
                            Some("true".to_string())
                        } else {
                            None
                        },
                    ),
                ],
            )?;
            print_json_response::<EventsResponse>(response)
        }
        SessionsCommand::EventsSse(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = format!("{API_PREFIX}/sessions/{}/events/sse", args.session_id);
            let response = ctx.get_with_query(
                &path,
                &[
                    ("offset", args.offset.map(|v| v.to_string())),
                    (
                        "include_raw",
                        if args.include_raw {
                            Some("true".to_string())
                        } else {
                            None
                        },
                    ),
                ],
            )?;
            print_text_response(response)
        }
        SessionsCommand::ReplyQuestion(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let answers: Vec<Vec<String>> = serde_json::from_str(&args.answers)?;
            let body = QuestionReplyRequest { answers };
            let path = format!(
                "{API_PREFIX}/sessions/{}/questions/{}/reply",
                args.session_id, args.question_id
            );
            let response = ctx.post(&path, &body)?;
            print_empty_response(response)
        }
        SessionsCommand::RejectQuestion(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let path = format!(
                "{API_PREFIX}/sessions/{}/questions/{}/reject",
                args.session_id, args.question_id
            );
            let response = ctx.post_empty(&path)?;
            print_empty_response(response)
        }
        SessionsCommand::ReplyPermission(args) => {
            let ctx = ClientContext::new(cli, &args.client)?;
            let body = PermissionReplyRequest {
                reply: args.reply.clone(),
            };
            let path = format!(
                "{API_PREFIX}/sessions/{}/permissions/{}/reply",
                args.session_id, args.permission_id
            );
            let response = ctx.post(&path, &body)?;
            print_empty_response(response)
        }
    }
}

fn create_opencode_session(
    base_url: &str,
    token: Option<&str>,
    title: Option<&str>,
) -> Result<String, CliError> {
    let client = HttpClient::builder().build()?;
    let url = format!("{base_url}/opencode/session");
    let body = if let Some(title) = title {
        json!({ "title": title })
    } else {
        json!({})
    };
    let mut request = client.post(&url).json(&body);
    if let Ok(directory) = std::env::current_dir() {
        request = request.header(
            "x-opencode-directory",
            directory.to_string_lossy().to_string(),
        );
    }
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send()?;
    let status = response.status();
    let text = response.text()?;
    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }
    let body: Value = serde_json::from_str(&text)?;
    let session_id = body
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CliError::Server("opencode session missing id".to_string()))?;
    Ok(session_id.to_string())
}

fn resolve_opencode_bin(explicit: Option<&PathBuf>) -> Result<PathBuf, CliError> {
    if let Some(path) = explicit {
        return Ok(path.clone());
    }
    if let Ok(path) = std::env::var("OPENCODE_BIN") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = find_in_path("opencode") {
        write_stderr_line(&format!("using opencode binary from PATH: {}", path.display()))?;
        return Ok(path);
    }

    let manager = AgentManager::new(default_install_dir())
        .map_err(|err| CliError::Server(err.to_string()))?;
    match manager.resolve_binary(AgentId::Opencode) {
        Ok(path) => Ok(path),
        Err(_) => {
            write_stderr_line("opencode not found; installing...")?;
            let result = manager
                .install(
                    AgentId::Opencode,
                    InstallOptions {
                        reinstall: false,
                        version: None,
                    },
                )
                .map_err(|err| CliError::Server(err.to_string()))?;
            Ok(result.path)
        }
    }
}

fn find_in_path(binary_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for path in std::env::split_paths(&path_var) {
        let candidate = path.join(binary_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn run_credentials(command: &CredentialsCommand) -> Result<(), CliError> {
    match command {
        CredentialsCommand::Extract(args) => {
            let mut options = CredentialExtractionOptions::new();
            if let Some(home_dir) = args.home_dir.clone() {
                options.home_dir = Some(home_dir);
            }
            if args.no_oauth {
                options.include_oauth = false;
            }

            let credentials = extract_all_credentials(&options);
            if let Some(agent) = args.agent.clone() {
                let token = select_token_for_agent(&credentials, agent, args.provider.as_deref())?;
                write_stdout_line(&token)?;
                return Ok(());
            }
            if let Some(provider) = args.provider.as_deref() {
                let token = select_token_for_provider(&credentials, provider)?;
                write_stdout_line(&token)?;
                return Ok(());
            }

            let output = credentials_to_output(credentials, args.reveal);
            let pretty = serde_json::to_string_pretty(&output)?;
            write_stdout_line(&pretty)?;
            Ok(())
        }
        CredentialsCommand::ExtractEnv(args) => {
            let mut options = CredentialExtractionOptions::new();
            if let Some(home_dir) = args.home_dir.clone() {
                options.home_dir = Some(home_dir);
            }
            if args.no_oauth {
                options.include_oauth = false;
            }

            let credentials = extract_all_credentials(&options);
            let prefix = if args.export { "export " } else { "" };

            if let Some(cred) = &credentials.anthropic {
                write_stdout_line(&format!("{}ANTHROPIC_API_KEY={}", prefix, cred.api_key))?;
                write_stdout_line(&format!("{}CLAUDE_API_KEY={}", prefix, cred.api_key))?;
            }
            if let Some(cred) = &credentials.openai {
                write_stdout_line(&format!("{}OPENAI_API_KEY={}", prefix, cred.api_key))?;
                write_stdout_line(&format!("{}CODEX_API_KEY={}", prefix, cred.api_key))?;
            }
            for (provider, cred) in &credentials.other {
                let var_name = format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"));
                write_stdout_line(&format!("{}{}={}", prefix, var_name, cred.api_key))?;
            }

            Ok(())
        }
    }
}

#[derive(Serialize)]
struct CredentialsOutput {
    anthropic: Option<CredentialSummary>,
    openai: Option<CredentialSummary>,
    other: HashMap<String, CredentialSummary>,
}

#[derive(Serialize)]
struct CredentialSummary {
    provider: String,
    source: String,
    auth_type: String,
    api_key: String,
    redacted: bool,
}

#[derive(clap::ValueEnum, Clone, Debug)]
enum CredentialAgent {
    Claude,
    Codex,
    Opencode,
    Amp,
}

fn credentials_to_output(credentials: ExtractedCredentials, reveal: bool) -> CredentialsOutput {
    CredentialsOutput {
        anthropic: credentials
            .anthropic
            .map(|cred| summarize_credential(&cred, reveal)),
        openai: credentials
            .openai
            .map(|cred| summarize_credential(&cred, reveal)),
        other: credentials
            .other
            .into_iter()
            .map(|(key, cred)| (key, summarize_credential(&cred, reveal)))
            .collect(),
    }
}

fn summarize_credential(credential: &ProviderCredentials, reveal: bool) -> CredentialSummary {
    let api_key = if reveal {
        credential.api_key.clone()
    } else {
        redact_key(&credential.api_key)
    };
    CredentialSummary {
        provider: credential.provider.clone(),
        source: credential.source.clone(),
        auth_type: match credential.auth_type {
            AuthType::ApiKey => "api_key".to_string(),
            AuthType::Oauth => "oauth".to_string(),
        },
        api_key,
        redacted: !reveal,
    }
}

fn redact_key(key: &str) -> String {
    let trimmed = key.trim();
    let len = trimmed.len();
    if len <= 8 {
        return "****".to_string();
    }
    let prefix = &trimmed[..4];
    let suffix = &trimmed[len - 4..];
    format!("{prefix}...{suffix}")
}

fn install_agent_local(args: &InstallAgentArgs) -> Result<(), CliError> {
    let agent_id = AgentId::parse(&args.agent)
        .ok_or_else(|| CliError::Server(format!("unsupported agent: {}", args.agent)))?;
    let manager = AgentManager::new(default_install_dir())
        .map_err(|err| CliError::Server(err.to_string()))?;
    manager
        .install(
            agent_id,
            InstallOptions {
                reinstall: args.reinstall,
                version: None,
            },
        )
        .map_err(|err| CliError::Server(err.to_string()))?;
    Ok(())
}

fn select_token_for_agent(
    credentials: &ExtractedCredentials,
    agent: CredentialAgent,
    provider: Option<&str>,
) -> Result<String, CliError> {
    match agent {
        CredentialAgent::Claude | CredentialAgent::Amp => {
            if let Some(provider) = provider {
                if provider != "anthropic" {
                    return Err(CliError::Server(format!(
                        "agent {:?} only supports provider anthropic",
                        agent
                    )));
                }
            }
            select_token_for_provider(credentials, "anthropic")
        }
        CredentialAgent::Codex => {
            if let Some(provider) = provider {
                if provider != "openai" {
                    return Err(CliError::Server(format!(
                        "agent {:?} only supports provider openai",
                        agent
                    )));
                }
            }
            select_token_for_provider(credentials, "openai")
        }
        CredentialAgent::Opencode => {
            if let Some(provider) = provider {
                return select_token_for_provider(credentials, provider);
            }
            if let Some(openai) = credentials.openai.as_ref() {
                return Ok(openai.api_key.clone());
            }
            if let Some(anthropic) = credentials.anthropic.as_ref() {
                return Ok(anthropic.api_key.clone());
            }
            if credentials.other.len() == 1 {
                if let Some((_, cred)) = credentials.other.iter().next() {
                    return Ok(cred.api_key.clone());
                }
            }
            let available = available_providers(credentials);
            if available.is_empty() {
                Err(CliError::Server(
                    "no credentials found for opencode".to_string(),
                ))
            } else {
                Err(CliError::Server(format!(
                    "multiple providers available for opencode: {} (use --provider)",
                    available.join(", ")
                )))
            }
        }
    }
}

fn select_token_for_provider(
    credentials: &ExtractedCredentials,
    provider: &str,
) -> Result<String, CliError> {
    if let Some(cred) = provider_credential(credentials, provider) {
        Ok(cred.api_key.clone())
    } else {
        Err(CliError::Server(format!(
            "no credentials found for provider {provider}"
        )))
    }
}

fn provider_credential<'a>(
    credentials: &'a ExtractedCredentials,
    provider: &str,
) -> Option<&'a ProviderCredentials> {
    match provider {
        "openai" => credentials.openai.as_ref(),
        "anthropic" => credentials.anthropic.as_ref(),
        _ => credentials.other.get(provider),
    }
}

fn available_providers(credentials: &ExtractedCredentials) -> Vec<String> {
    let mut providers = Vec::new();
    if credentials.openai.is_some() {
        providers.push("openai".to_string());
    }
    if credentials.anthropic.is_some() {
        providers.push("anthropic".to_string());
    }
    for key in credentials.other.keys() {
        providers.push(key.clone());
    }
    providers.sort();
    providers.dedup();
    providers
}

fn build_cors_layer(server: &ServerArgs) -> Result<CorsLayer, CliError> {
    let mut cors = CorsLayer::new();

    // Build origins list from provided origins
    let mut origins = Vec::new();
    for origin in &server.cors_allow_origin {
        let value = origin
            .parse()
            .map_err(|_| CliError::InvalidCorsOrigin(origin.clone()))?;
        origins.push(value);
    }
    if origins.is_empty() {
        // No origins allowed - use permissive CORS with no origins (effectively disabled)
        cors = cors.allow_origin(tower_http::cors::AllowOrigin::predicate(|_, _| false));
    } else {
        cors = cors.allow_origin(origins);
    }

    // Methods: allow any if not specified, otherwise use provided list
    if server.cors_allow_method.is_empty() {
        cors = cors.allow_methods(Any);
    } else {
        let mut methods = Vec::new();
        for method in &server.cors_allow_method {
            let parsed = method
                .parse()
                .map_err(|_| CliError::InvalidCorsMethod(method.clone()))?;
            methods.push(parsed);
        }
        cors = cors.allow_methods(methods);
    }

    // Headers: allow any if not specified, otherwise use provided list
    if server.cors_allow_header.is_empty() {
        cors = cors.allow_headers(Any);
    } else {
        let mut headers = Vec::new();
        for header in &server.cors_allow_header {
            let parsed = header
                .parse()
                .map_err(|_| CliError::InvalidCorsHeader(header.clone()))?;
            headers.push(parsed);
        }
        cors = cors.allow_headers(headers);
    }

    if server.cors_allow_credentials {
        cors = cors.allow_credentials(true);
    }

    Ok(cors)
}

struct ClientContext {
    endpoint: String,
    token: Option<String>,
    client: HttpClient,
}

impl ClientContext {
    fn new(cli: &CliConfig, args: &ClientArgs) -> Result<Self, CliError> {
        let endpoint = args
            .endpoint
            .clone()
            .unwrap_or_else(|| format!("http://{}:{}", DEFAULT_HOST, DEFAULT_PORT));
        let token = if cli.no_token {
            None
        } else {
            cli.token.clone()
        };
        let client = HttpClient::builder().build()?;
        Ok(Self {
            endpoint,
            token,
            client,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint.trim_end_matches('/'), path)
    }

    fn request(&self, method: Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let url = self.url(path);
        let mut builder = self.client.request(method, url);
        if let Some(token) = &self.token {
            builder = builder.bearer_auth(token);
        }
        builder
    }

    fn get(&self, path: &str) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::GET, path).send()?)
    }

    fn get_with_query(
        &self,
        path: &str,
        query: &[(&str, Option<String>)],
    ) -> Result<reqwest::blocking::Response, CliError> {
        let mut request = self.request(Method::GET, path);
        for (key, value) in query {
            if let Some(value) = value {
                request = request.query(&[(key, value)]);
            }
        }
        Ok(request.send()?)
    }

    fn post<T: Serialize>(
        &self,
        path: &str,
        body: &T,
    ) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::POST, path).json(body).send()?)
    }

    fn post_with_query<T: Serialize>(
        &self,
        path: &str,
        body: &T,
        query: &[(&str, Option<String>)],
    ) -> Result<reqwest::blocking::Response, CliError> {
        let mut request = self.request(Method::POST, path).json(body);
        for (key, value) in query {
            if let Some(value) = value {
                request = request.query(&[(key, value)]);
            }
        }
        Ok(request.send()?)
    }

    fn post_empty(&self, path: &str) -> Result<reqwest::blocking::Response, CliError> {
        Ok(self.request(Method::POST, path).send()?)
    }
}

fn print_json_response<T: serde::de::DeserializeOwned + Serialize>(
    response: reqwest::blocking::Response,
) -> Result<(), CliError> {
    let status = response.status();
    let text = response.text()?;

    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    let parsed: T = serde_json::from_str(&text)?;
    let pretty = serde_json::to_string_pretty(&parsed)?;
    write_stdout_line(&pretty)?;
    Ok(())
}

fn print_text_response(response: reqwest::blocking::Response) -> Result<(), CliError> {
    let status = response.status();
    let text = response.text()?;

    if !status.is_success() {
        print_error_body(&text)?;
        return Err(CliError::HttpStatus(status));
    }

    write_stdout(&text)?;
    Ok(())
}

fn print_empty_response(response: reqwest::blocking::Response) -> Result<(), CliError> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text()?;
    print_error_body(&text)?;
    Err(CliError::HttpStatus(status))
}

fn print_error_body(text: &str) -> Result<(), CliError> {
    if let Ok(json) = serde_json::from_str::<Value>(text) {
        let pretty = serde_json::to_string_pretty(&json)?;
        write_stderr_line(&pretty)?;
    } else {
        write_stderr_line(text)?;
    }
    Ok(())
}

fn write_stdout(text: &str) -> Result<(), CliError> {
    let mut out = std::io::stdout();
    out.write_all(text.as_bytes())?;
    out.flush()?;
    Ok(())
}

fn write_stdout_line(text: &str) -> Result<(), CliError> {
    let mut out = std::io::stdout();
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

fn write_stderr_line(text: &str) -> Result<(), CliError> {
    let mut out = std::io::stderr();
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}
