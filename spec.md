i need to build a library that is a universal api to work with agents

## glossary

- agent = claude code, codex, and opencode -> the acutal binary/sdk that runs the coding agent
- agent mode = what the agent does, for example build/plan agent mode
- model = claude, codex, gemni, etc -> the model that's use din the agent
- variant = variant on the model if exists, eg low, mid, high, xhigh for codex

## concepts

### universal api types

we need to define a universal base type for input & output from agents that is a common denominator for all agent schemas

this also needs to support quesitons (ie human in the loop)

### working with the agents

these agents all have differnet ways of working with them.

- claude code uses headless mode
- codex uses a typescript sdk
- opencode uses a server

## component: daemon

this is what runs inside the sandbox to manage everything

this is a rust component that exposes an http server

**router**

use axum for routing and utoipa for the json schema and schemars for generating json schemas. see how this is done in:
- ~/rivet
	- engine/packages/config-schema-gen/build.rs
	- ~/rivet/engine/packages/api-public/src/router.rs (but use thiserror instead of anyhow)

we need a standard thiserror for error responses. return errors as RFC 7807 Problem Details

### cli

it's ran with a token like this using clap:

sandbox-daemon --token <token> --host xxxx --port xxxx

(you can specify --no-token too)

also expose a CLI endpoint for every http endpoint we have (specify this in claude.md to keep this to date) so we can do:

sandbox-daemon sessions get-messages --endpoint xxxx --token xxxx

### http api

POST /agents/{}/install (this will install the agent)
{}

POST /sessions/{} (will install agent if not already installed)
>
{
	agent:"claud"|"codex"|"opencode",
	model?:string,
	variant?:string,
    token?: string,
    validateToken?: boolean,
    dangerouslySkipPermissions?: boolean,
    agentVersion?: string
}
<
{
    healthy: boolean,
    error?: AgentError
}

POST /sessions/{}/messages
{
    message: string
}

GET /sessions/{}/events?offset=x&limit=x
<
{
	events: UniversalEvent[],
	hasMore: bool
}

GET /sessions/{}/events/sse?offset=x
- same as above but using sse

POST /sessions/{}/questions/{questionId}/reply
{ answers: string[][] }  // Array per question of selected option labels

POST /sessions/{}/questions/{questionId}/reject
{}

POST /sessions/{}/permissions/{permissionId}/reply
{ reply: "once" | "always" | "reject" }

types:

type UniversalEvent =
    | { message: UniversalMessage }
    | { started: Started }
    | { error: CrashInfo }
    | { questionAsked: QuestionRequest }
    | { permissionAsked: PermissionRequest };

// See research/human-in-the-loop.md for QuestionRequest/PermissionRequest details

type AgentError = { tokenError: ... } | { processExisted: ... } | { installFailed: ... } | etc

### schema converters

we need to have a 2 way conversion for both:

- universal agent input message <-> agent input message
- universal agent event <-> agent event

for messages, we need to have a sepcial universal message type for failed to parse with the raw json that we attempted to parse

### managing agents

> **Note:** We do NOT use JS SDKs for agent communication. All agents are spawned as subprocesses or accessed via a shared server. This keeps the daemon language-agnostic (Rust) and avoids Node.js dependencies.

#### agent comparison

| Agent | Provider | Binary | Install Method | Session ID | Streaming Format |
|-------|----------|--------|----------------|------------|------------------|
| Claude Code | Anthropic | `claude` | curl raw binary from GCS | `session_id` (string) | JSONL via stdout |
| Codex | OpenAI | `codex` | curl tarball from GitHub releases | `thread_id` (string) | JSONL via stdout |
| OpenCode | Multi-provider | `opencode` | curl tarball from GitHub releases | `session_id` (string) | SSE or JSONL |
| Amp | Sourcegraph | `amp` | curl raw binary from GCS | `session_id` (string) | JSONL via stdout |

#### spawning approaches

There are two ways to spawn agents:

##### 1. subprocess per session

Each session spawns a dedicated agent subprocess that lives for the duration of the session.

**How it works:**
- On session create, spawn the agent binary with appropriate flags
- Communicate via stdin/stdout using JSONL
- Process terminates when session ends or times out

**Agents that support this:**
- **Claude Code**: `claude --print --output-format stream-json --verbose --dangerously-skip-permissions [--resume SESSION_ID] "PROMPT"`
- **Codex**: `codex exec --json --dangerously-bypass-approvals-and-sandbox "PROMPT"` or `codex exec resume --last`
- **Amp**: `amp --print --output-format stream-json --dangerously-skip-permissions "PROMPT"`

**Pros:**
- Simple implementation
- Process isolation per session
- No shared state to manage

**Cons:**
- Higher latency (process startup per message)
- More resource usage (one process per active session)
- No connection reuse

##### 2. shared server (preferred for OpenCode)

A single long-running server handles multiple sessions. The daemon connects to this server via HTTP/SSE.

**How it works:**
- On daemon startup (or first session for an agent), start the server if not running
- Server listens on a port (e.g., 4200-4300 range for OpenCode)
- Sessions are created/managed via HTTP API
- Events streamed via SSE

**Agents that support this:**
- **OpenCode**: `opencode serve --port PORT` starts the server, then use HTTP API:
  - `POST /session` - create session
  - `POST /session/{id}/prompt` - send message
  - `GET /event/subscribe` - SSE event stream
  - Supports questions/permissions via `/question/reply`, `/permission/reply`

**Pros:**
- Lower latency (no process startup per message)
- Shared resources across sessions
- Better for high-throughput scenarios
- Native support for SSE streaming

**Cons:**
- More complex lifecycle management
- Need to handle server crashes/restarts
- Shared state between sessions

#### which approach to use

| Agent | Recommended Approach | Reason |
|-------|---------------------|--------|
| Claude Code | Subprocess per session | No server mode available |
| Codex | Subprocess per session | No server mode available |
| OpenCode | Shared server | Native server support, lower latency |
| Amp | Subprocess per session | No server mode available |

#### installation

Before spawning, agents must be installed. **We curl raw binaries directly** - no npm, brew, install scripts, or other package managers.

##### Claude Code

```bash
# Get latest version
VERSION=$(curl -s https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest)

# Linux x64
curl -fsSL "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${VERSION}/linux-x64/claude" -o /usr/local/bin/claude && chmod +x /usr/local/bin/claude

# Linux x64 (musl)
curl -fsSL "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${VERSION}/linux-x64-musl/claude" -o /usr/local/bin/claude && chmod +x /usr/local/bin/claude

# Linux ARM64
curl -fsSL "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${VERSION}/linux-arm64/claude" -o /usr/local/bin/claude && chmod +x /usr/local/bin/claude

# macOS ARM64 (Apple Silicon)
curl -fsSL "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${VERSION}/darwin-arm64/claude" -o /usr/local/bin/claude && chmod +x /usr/local/bin/claude

# macOS x64 (Intel)
curl -fsSL "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${VERSION}/darwin-x64/claude" -o /usr/local/bin/claude && chmod +x /usr/local/bin/claude
```

##### Codex

```bash
# Linux x64 (musl for max compatibility)
curl -fsSL https://github.com/openai/codex/releases/latest/download/codex-x86_64-unknown-linux-musl.tar.gz | tar -xz
mv codex-x86_64-unknown-linux-musl /usr/local/bin/codex

# Linux ARM64
curl -fsSL https://github.com/openai/codex/releases/latest/download/codex-aarch64-unknown-linux-musl.tar.gz | tar -xz
mv codex-aarch64-unknown-linux-musl /usr/local/bin/codex

# macOS ARM64 (Apple Silicon)
curl -fsSL https://github.com/openai/codex/releases/latest/download/codex-aarch64-apple-darwin.tar.gz | tar -xz
mv codex-aarch64-apple-darwin /usr/local/bin/codex

# macOS x64 (Intel)
curl -fsSL https://github.com/openai/codex/releases/latest/download/codex-x86_64-apple-darwin.tar.gz | tar -xz
mv codex-x86_64-apple-darwin /usr/local/bin/codex
```

##### OpenCode

```bash
# Linux x64
curl -fsSL https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x64.tar.gz | tar -xz
mv opencode /usr/local/bin/opencode

# Linux x64 (musl)
curl -fsSL https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x64-musl.tar.gz | tar -xz
mv opencode /usr/local/bin/opencode

# Linux ARM64
curl -fsSL https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-arm64.tar.gz | tar -xz
mv opencode /usr/local/bin/opencode

# macOS ARM64 (Apple Silicon)
curl -fsSL https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-arm64.zip -o opencode.zip && unzip -o opencode.zip && rm opencode.zip
mv opencode /usr/local/bin/opencode

# macOS x64 (Intel)
curl -fsSL https://github.com/anomalyco/opencode/releases/latest/download/opencode-darwin-x64.zip -o opencode.zip && unzip -o opencode.zip && rm opencode.zip
mv opencode /usr/local/bin/opencode
```

##### Amp

```bash
# Get latest version
VERSION=$(curl -s https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt)

# Linux x64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-linux-x64" -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# Linux ARM64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-linux-arm64" -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# macOS ARM64 (Apple Silicon)
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-darwin-arm64" -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# macOS x64 (Intel)
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-darwin-x64" -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp
```

##### binary URL summary

| Agent | Version URL | Binary URL Pattern |
|-------|-------------|-------------------|
| Claude Code | `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest` | `.../{version}/{platform}/claude` |
| Codex | `https://api.github.com/repos/openai/codex/releases/latest` | `https://github.com/openai/codex/releases/latest/download/codex-{target}.tar.gz` |
| OpenCode | `https://api.github.com/repos/anomalyco/opencode/releases/latest` | `https://github.com/anomalyco/opencode/releases/latest/download/opencode-{platform}.tar.gz` |
| Amp | `https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt` | `.../{version}/amp-{platform}` |

##### platform mappings

| Platform | Claude Code | Codex | OpenCode | Amp |
|----------|-------------|-------|----------|-----|
| Linux x64 | `linux-x64` | `x86_64-unknown-linux-musl` | `linux-x64` | `linux-x64` |
| Linux x64 musl | `linux-x64-musl` | `x86_64-unknown-linux-musl` | `linux-x64-musl` | N/A |
| Linux ARM64 | `linux-arm64` | `aarch64-unknown-linux-musl` | `linux-arm64` | `linux-arm64` |
| macOS ARM64 | `darwin-arm64` | `aarch64-apple-darwin` | `darwin-arm64` | `darwin-arm64` |
| macOS x64 | `darwin-x64` | `x86_64-apple-darwin` | `darwin-x64` | `darwin-x64` |

##### versioning

| Agent | Get Latest Version | Specific Version |
|-------|-------------------|------------------|
| Claude Code | `curl -s https://storage.googleapis.com/claude-code-dist-.../latest` | Replace `${VERSION}` in URL |
| Codex | `curl -s https://api.github.com/repos/openai/codex/releases/latest \| jq -r .tag_name` | Replace `latest` with `download/{tag}` |
| OpenCode | `curl -s https://api.github.com/repos/anomalyco/opencode/releases/latest \| jq -r .tag_name` | Replace `latest` with `download/{tag}` |
| Amp | `curl -s https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt` | Replace `${VERSION}` in URL |

#### communication

**Subprocess mode (Claude Code, Codex, Amp):**
1. Spawn process with appropriate flags
2. Close stdin immediately after sending prompt (for single-turn) or keep open (for multi-turn)
3. Read JSONL events from stdout line-by-line
4. Parse each line as JSON and convert to `UniversalEvent`
5. Capture session/thread ID from events for resumption
6. Handle process exit/timeout

**Server mode (OpenCode):**
1. Ensure server is running (`opencode serve --port PORT`)
2. Create session via `POST /session`
3. Send prompts via `POST /session/{id}/prompt` (async version for streaming)
4. Subscribe to events via `GET /event/subscribe` (SSE)
5. Handle questions/permissions via dedicated endpoints
6. Session persists across multiple prompts

#### credential passing

| Agent | Env Var | Config File |
|-------|---------|-------------|
| Claude Code | `ANTHROPIC_API_KEY` | `~/.claude.json`, `~/.claude/.credentials.json` |
| Codex | `OPENAI_API_KEY` or `CODEX_API_KEY` | `~/.codex/auth.json` |
| OpenCode | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | `~/.local/share/opencode/auth.json` |
| Amp | `ANTHROPIC_API_KEY` | Uses Claude Code credentials |

When spawning subprocesses, pass the API key via environment variable. For OpenCode server mode, the server reads credentials from its config on startup.

### testing

TODO

## component: sdks

we need to auto-generate types from our json schema for these languages

- typescript sdk
	- also need to support standard schema
	- can run in inline mode that doesn't require this
- python sdk

## spec todo

- generate common denominator with conversion functions
- what else do we need, like todo, etc?
- how can we dump the spec for all of the agents somehow
- generate an example ui for this
- architecture document
- how should we handle the tokens for auth?

## future problems to visit

- api features
    - list agent modes available
    - list models available
    - handle planning mode
- api key gateway
- configuring mcp/skills/etc
- process management inside container
- otel
- better authentication systems
- s3-based file system
- ai sdk compatability for their ecosystem (useChat, etc)
- resumable messages
- todo lists
- all other features
- misc
    - bootstrap tool that extracts tokens from the current system
- management ui
- skill
- pre-package these as bun binaries instead of npm installations
- build & release pipeline with musl
- agent feature matrix for api features

## future work

- provide a pty to access the agent data
- other agent features like file system

## misc

comparison to agentapi:
- it does not use the pty since we need to get more information from the agent

