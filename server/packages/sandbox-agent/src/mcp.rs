use std::collections::HashMap;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

#[derive(Debug, Clone)]
pub(crate) struct McpOAuthConfig {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum McpConfig {
    Local {
        command: Vec<String>,
        environment: HashMap<String, String>,
        enabled: bool,
        timeout_ms: Option<u64>,
    },
    Remote {
        url: String,
        headers: HashMap<String, String>,
        oauth: Option<McpOAuthConfig>,
        enabled: bool,
        timeout_ms: Option<u64>,
    },
}

impl McpConfig {
    pub(crate) fn from_value(value: &Value) -> Result<Self, String> {
        let config_type = value
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "config.type is required".to_string())?;
        match config_type {
            "local" => {
                let command = value
                    .get("command")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| "config.command is required".to_string())?
                    .iter()
                    .map(|item| {
                        item.as_str()
                            .map(|s| s.to_string())
                            .ok_or_else(|| "config.command must be an array of strings".to_string())
                    })
                    .collect::<Result<Vec<String>, String>>()?;
                if command.is_empty() {
                    return Err("config.command cannot be empty".to_string());
                }
                let environment = parse_string_map(value.get("environment"))?;
                let enabled = value
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let timeout_ms = value
                    .get("timeout")
                    .and_then(|v| v.as_u64());
                Ok(McpConfig::Local {
                    command,
                    environment,
                    enabled,
                    timeout_ms,
                })
            }
            "remote" => {
                let url = value
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "config.url is required".to_string())?
                    .to_string();
                let headers = parse_string_map(value.get("headers"))?;
                let enabled = value
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let timeout_ms = value
                    .get("timeout")
                    .and_then(|v| v.as_u64());
                let oauth = parse_oauth(value.get("oauth"))?;
                Ok(McpConfig::Remote {
                    url,
                    headers,
                    oauth,
                    enabled,
                    timeout_ms,
                })
            }
            other => Err(format!("unsupported config.type: {other}")),
        }
    }

    fn requires_auth(&self) -> bool {
        match self {
            McpConfig::Local { .. } => false,
            McpConfig::Remote { oauth, .. } => oauth.is_some(),
        }
    }

    fn enabled(&self) -> bool {
        match self {
            McpConfig::Local { enabled, .. } => *enabled,
            McpConfig::Remote { enabled, .. } => *enabled,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum McpStatus {
    Connected,
    Disabled,
    Failed { error: String },
    NeedsAuth,
    NeedsClientRegistration { error: String },
}

impl McpStatus {
    pub(crate) fn as_json(&self) -> Value {
        match self {
            McpStatus::Connected => json!({"status": "connected"}),
            McpStatus::Disabled => json!({"status": "disabled"}),
            McpStatus::Failed { error } => json!({"status": "failed", "error": error}),
            McpStatus::NeedsAuth => json!({"status": "needs_auth"}),
            McpStatus::NeedsClientRegistration { error } => {
                json!({"status": "needs_client_registration", "error": error})
            }
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug)]
struct McpStdioConnection {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpStdioConnection {
    async fn spawn(command: &[String], environment: &HashMap<String, String>) -> Result<Self, McpError> {
        let mut cmd = Command::new(&command[0]);
        if command.len() > 1 {
            cmd.args(&command[1..]);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        for (key, value) in environment {
            cmd.env(key, value);
        }
        let mut child = cmd
            .spawn()
            .map_err(|err| McpError::Failed(format!("failed to spawn MCP server: {err}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Failed("failed to capture MCP stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Failed("failed to capture MCP stdout".to_string()))?;
        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            next_id: 0,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, McpError> {
        self.next_id += 1;
        let id = self.next_id;
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&payload)
            .map_err(|err| McpError::Failed(format!("failed to encode MCP request: {err}")))?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|err| McpError::Failed(format!("failed to write MCP request: {err}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|err| McpError::Failed(format!("failed to flush MCP request: {err}")))?;

        loop {
            let mut buffer = String::new();
            let read = self
                .stdout
                .read_line(&mut buffer)
                .await
                .map_err(|err| McpError::Failed(format!("failed to read MCP response: {err}")))?;
            if read == 0 {
                return Err(McpError::Failed(
                    "MCP server closed stdout before responding".to_string(),
                ));
            }
            let value: Value = serde_json::from_str(buffer.trim())
                .map_err(|err| McpError::Failed(format!("invalid MCP response: {err}")))?;
            let response_id = value.get("id").and_then(|v| v.as_u64());
            if response_id != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(McpError::Failed(format!(
                    "MCP request failed: {error}"
                )));
            }
            if let Some(result) = value.get("result") {
                return Ok(result.clone());
            }
            return Err(McpError::Failed("MCP response missing result".to_string()));
        }
    }
}

#[derive(Debug)]
enum McpConnection {
    Stdio(McpStdioConnection),
}

#[derive(Debug)]
struct McpServerState {
    name: String,
    config: McpConfig,
    status: McpStatus,
    tools: Vec<McpTool>,
    auth_token: Option<String>,
    connection: Option<McpConnection>,
}

#[derive(Debug)]
pub(crate) struct McpRegistry {
    servers: HashMap<String, McpServerState>,
}

impl McpRegistry {
    pub(crate) fn new() -> Self {
        Self {
            servers: HashMap::new(),
        }
    }

    pub(crate) fn status_map(&self) -> Value {
        let mut map = serde_json::Map::new();
        for (name, server) in &self.servers {
            map.insert(name.clone(), server.status.as_json());
        }
        Value::Object(map)
    }

    pub(crate) async fn register(&mut self, name: String, config: McpConfig) -> Result<(), McpError> {
        if let Some(mut existing) = self.servers.remove(&name) {
            existing.disconnect().await;
        }
        let status = if !config.enabled() {
            McpStatus::Disabled
        } else if config.requires_auth() {
            McpStatus::NeedsAuth
        } else {
            McpStatus::Disabled
        };
        self.servers.insert(
            name.clone(),
            McpServerState {
                name,
                config,
                status,
                tools: Vec::new(),
                auth_token: None,
                connection: None,
            },
        );
        Ok(())
    }

    pub(crate) fn start_auth(&mut self, name: &str) -> Result<String, McpError> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or(McpError::NotFound)?;
        if !server.config.requires_auth() {
            return Err(McpError::Invalid("MCP server does not require auth".to_string()));
        }
        server.status = McpStatus::NeedsAuth;
        Ok(match &server.config {
            McpConfig::Remote { url, .. } => format!("{}/oauth/authorize", url.trim_end_matches('/')),
            McpConfig::Local { .. } => "http://localhost/oauth/authorize".to_string(),
        })
    }

    pub(crate) fn auth_callback(&mut self, name: &str, code: String) -> Result<McpStatus, McpError> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or(McpError::NotFound)?;
        if !server.config.requires_auth() {
            return Err(McpError::Invalid("MCP server does not require auth".to_string()));
        }
        if code.is_empty() {
            return Err(McpError::Invalid("code is required".to_string()));
        }
        server.auth_token = Some(code);
        server.status = McpStatus::Disabled;
        Ok(server.status.clone())
    }

    pub(crate) fn auth_authenticate(&mut self, name: &str) -> Result<McpStatus, McpError> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or(McpError::NotFound)?;
        if !server.config.requires_auth() {
            return Err(McpError::Invalid("MCP server does not require auth".to_string()));
        }
        server.auth_token = Some("authenticated".to_string());
        server.status = McpStatus::Disabled;
        Ok(server.status.clone())
    }

    pub(crate) fn auth_remove(&mut self, name: &str) -> Result<McpStatus, McpError> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or(McpError::NotFound)?;
        server.auth_token = None;
        server.status = if server.config.requires_auth() {
            McpStatus::NeedsAuth
        } else {
            McpStatus::Disabled
        };
        Ok(server.status.clone())
    }

    pub(crate) async fn connect(&mut self, name: &str) -> Result<bool, McpError> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or(McpError::NotFound)?;
        if server.config.requires_auth() && server.auth_token.is_none() {
            server.status = McpStatus::NeedsAuth;
            return Err(McpError::AuthRequired);
        }
        let tools = match &server.config {
            McpConfig::Local {
                command,
                environment,
                ..
            } => {
                let mut connection = McpStdioConnection::spawn(command, environment).await?;
                let _ = connection
                    .request(
                        "initialize",
                        json!({
                            "clientInfo": {"name": "sandbox-agent", "version": "0.1.0"},
                            "protocolVersion": "2024-11-05",
                        }),
                    )
                    .await?;
                let result = connection
                    .request("tools/list", json!({}))
                    .await?;
                let tools = parse_tools(&result)?;
                server.connection = Some(McpConnection::Stdio(connection));
                tools
            }
            McpConfig::Remote {
                url,
                headers,
                ..
            } => {
                let client = reqwest::Client::new();
                let auth_token = server.auth_token.clone();
                let _ = remote_request(&client, url, headers, auth_token.as_deref(), "initialize", json!({
                    "clientInfo": {"name": "sandbox-agent", "version": "0.1.0"},
                    "protocolVersion": "2024-11-05",
                }))
                .await?;
                let result = remote_request(
                    &client,
                    url,
                    headers,
                    auth_token.as_deref(),
                    "tools/list",
                    json!({}),
                )
                .await?;
                parse_tools(&result)?
            }
        };
        server.tools = tools;
        server.status = McpStatus::Connected;
        Ok(true)
    }

    pub(crate) async fn disconnect(&mut self, name: &str) -> Result<bool, McpError> {
        let server = self
            .servers
            .get_mut(name)
            .ok_or(McpError::NotFound)?;
        server.disconnect().await;
        server.status = McpStatus::Disabled;
        Ok(true)
    }

    pub(crate) fn tool_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for server in self.servers.values() {
            if matches!(server.status, McpStatus::Connected) {
                for tool in &server.tools {
                    ids.push(format!("mcp:{}:{}", server.name, tool.name));
                }
            }
        }
        ids
    }

    pub(crate) fn tool_list(&self) -> Vec<Value> {
        let mut list = Vec::new();
        for server in self.servers.values() {
            if matches!(server.status, McpStatus::Connected) {
                for tool in &server.tools {
                    list.push(json!({
                        "id": format!("mcp:{}:{}", server.name, tool.name),
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    }));
                }
            }
        }
        list
    }
}

impl McpServerState {
    async fn disconnect(&mut self) {
        if let Some(connection) = self.connection.as_mut() {
            match connection {
                McpConnection::Stdio(conn) => {
                    let _ = conn.child.kill().await;
                }
            }
        }
        self.connection = None;
    }
}

fn parse_string_map(value: Option<&Value>) -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();
    let Some(value) = value else {
        return Ok(map);
    };
    let obj = value
        .as_object()
        .ok_or_else(|| "expected object".to_string())?;
    for (key, value) in obj {
        let str_value = value
            .as_str()
            .ok_or_else(|| "expected string value".to_string())?;
        map.insert(key.clone(), str_value.to_string());
    }
    Ok(map)
}

fn parse_oauth(value: Option<&Value>) -> Result<Option<McpOAuthConfig>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if let Some(flag) = value.as_bool() {
        if flag {
            return Err("oauth must be an object or false".to_string());
        }
        return Ok(None);
    }
    let obj = value
        .as_object()
        .ok_or_else(|| "oauth must be an object or false".to_string())?;
    let client_id = obj.get("clientId").and_then(|v| v.as_str()).map(|v| v.to_string());
    let client_secret = obj
        .get("clientSecret")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let scope = obj.get("scope").and_then(|v| v.as_str()).map(|v| v.to_string());
    Ok(Some(McpOAuthConfig {
        client_id,
        client_secret,
        scope,
    }))
}

fn parse_tools(value: &Value) -> Result<Vec<McpTool>, McpError> {
    let tools_value = value
        .get("tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| McpError::Failed("MCP tools/list response missing tools".to_string()))?;
    let mut tools = Vec::new();
    for tool in tools_value {
        let name = tool
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::Failed("tool name missing".to_string()))?
            .to_string();
        let description = tool
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let input_schema = tool
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({}));
        tools.push(McpTool {
            name,
            description,
            input_schema,
        });
    }
    Ok(tools)
}

async fn remote_request(
    client: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    auth_token: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, McpError> {
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let mut request = client.post(url).json(&payload);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    if let Some(token) = auth_token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let response = request
        .send()
        .await
        .map_err(|err| McpError::Failed(format!("MCP request failed: {err}")))?;
    let text = response
        .text()
        .await
        .map_err(|err| McpError::Failed(format!("MCP response read failed: {err}")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| McpError::Failed(format!("MCP response invalid: {err}")))?;
    if let Some(error) = value.get("error") {
        return Err(McpError::Failed(format!("MCP request failed: {error}")));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| McpError::Failed("MCP response missing result".to_string()))
}

#[derive(Debug)]
pub(crate) enum McpError {
    NotFound,
    Invalid(String),
    AuthRequired,
    Failed(String),
}
