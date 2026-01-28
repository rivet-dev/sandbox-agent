<p align="center">
  <img src=".github/media/banner.png" alt="Sandbox Agent SDK" />
</p>

<p align="center">
  Universal API for automatic coding agents in sandboxes. Supports Claude Code, Codex, OpenCode, and Amp.
</p>


- **Any coding agent**: Universal API to interact with all agents with full feature coverage
- **Server or SDK mode**: Run as an HTTP server or with the TypeScript SDK
- **Universal session schema**: Universal schema to store agent transcripts
- **Supports your sandbox provider**: Daytona, E2B, Vercel Sandboxes, and more
- **Lightweight, portable Rust binary**: Install anywhere with 1 curl command
- **Automatic agent installation**: Agents are installed on-demand when first used
- **OpenAPI spec**: Well documented and easy to integrate

[Documentation](https://sandboxagent.dev/docs) — [Discord](https://rivet.dev/discord)

## Agent Compatibility

| Feature | [Claude Code*](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) | [Codex](https://github.com/openai/codex) | [OpenCode](https://github.com/opencode-ai/opencode) | [Amp](https://ampcode.com) |
|---------|:-----------:|:-----:|:--------:|:---:|
| Stability | Stable | Stable | Experimental | Experimental |
| Text Messages | ✓ | ✓ | ✓ | ✓ |
| Tool Calls | —* | ✓ | ✓ | ✓ |
| Tool Results | —* | ✓ | ✓ | ✓ |
| Questions (HITL) | —* | | ✓ | |
| Permissions (HITL) | —* | | ✓ | |
| Images | | ✓ | ✓ | |
| File Attachments | | ✓ | ✓ | |
| Session Lifecycle | | ✓ | ✓ | |
| Error Events | | ✓ | ✓ | ✓ |
| Reasoning/Thinking | | ✓ | | |
| Command Execution | | ✓ | | |
| File Changes | | ✓ | | |
| MCP Tools | | ✓ | | |
| Streaming Deltas | | ✓ | ✓ | |

\* Coming imminently

Want support for another agent? [Open an issue](https://github.com/anthropics/sandbox-agent/issues/new) to request it.

## Architecture

![Agent Architecture Diagram](./.github/media/agent-diagram.gif)

The Sandbox Agent acts as a universal adapter between your client application and various coding agents (Claude Code, Codex, OpenCode, Amp). Each agent has its own adapter (e.g., `claude_adapter.rs`) that handles the translation between the universal API and the agent-specific interface.

- **Embedded Mode**: Runs agents locally as subprocesses
- **Server Mode**: Runs as HTTP server from any sandbox provider

[Documentation](https://sandboxagent.dev/docs/architecture)

## Components

- Server: Rust daemon (`sandbox-agent server`) exposing the HTTP + SSE API.
- SDK: TypeScript client with embedded and server modes.
- Inspector: `https://inspect.sandboxagent.dev` for browsing sessions and events.
- CLI: `sandbox-agent` (same binary, plus npm wrapper) mirrors the HTTP endpoints.

## Quickstart

### Skill

Install skill with:

```
npx skills add https://sandboxagent.dev/docs
```

### SDK

**Install**

```bash
npm install sandbox-agent
```

**Setup**

Local (embedded mode):

```ts
import { SandboxAgent } from "sandbox-agent";

const client = await SandboxAgent.start();
```

Remote (server mode):

```ts
import { SandboxAgent } from "sandbox-agent";

const client = await SandboxAgent.connect({
  baseUrl: "http://127.0.0.1:2468",
  token: process.env.SANDBOX_TOKEN,
});
```

**API Overview**

```ts
const agents = await client.listAgents();

await client.createSession("demo", {
  agent: "codex",
  agentMode: "default",
  permissionMode: "plan",
});

await client.postMessage("demo", { message: "Hello from the SDK." });

for await (const event of client.streamEvents("demo", { offset: 0 })) {
  console.log(event.type, event.data);
}
```

[Documentation](https://sandboxagent.dev/docs/sdks/typescript)

### Server

Install the binary (fastest installation, no Node.js required):

```bash
# Install it
curl -fsSL https://releases.sandboxagent.dev/sandbox-agent/latest/install.sh | sh
# Run it
sandbox-agent server --token "$SANDBOX_TOKEN" --host 127.0.0.1 --port 2468
```

Optional: preinstall agent binaries (no server required; they will be installed lazily on first use if you skip this):

```bash
sandbox-agent install-agent claude
sandbox-agent install-agent codex
sandbox-agent install-agent opencode
sandbox-agent install-agent amp
```

To disable auth locally:

```bash
sandbox-agent server --no-token --host 127.0.0.1 --port 2468
```

[Documentation](https://sandboxagent.dev/docs/quickstart) - [Integration guides](https://sandboxagent.dev/docs/deploy)

### CLI

Install the CLI wrapper (optional but convenient):

```bash
npm install -g @sandbox-agent/cli
```

Create a session and send a message:

```bash
sandbox-agent api sessions create my-session --agent codex --endpoint http://127.0.0.1:2468 --token "$SANDBOX_TOKEN"
sandbox-agent api sessions send-message my-session --message "Hello" --endpoint http://127.0.0.1:2468 --token "$SANDBOX_TOKEN"
sandbox-agent api sessions send-message-stream my-session --message "Hello" --endpoint http://127.0.0.1:2468 --token "$SANDBOX_TOKEN"
```

You can also use npx like:

```bash
npx sandbox-agent --help
```

[Documentation](https://rivet.dev/docs/cli)

### OpenAPI Specification

[Expore API](https://sandboxagent.dev/docs/http-api) - [View Specification](https://github.com/rivet-dev/sandbox-agent/blob/main/docs/openapi.json)

### Tip: Extract credentials

Often you need to use your personal API tokens to test agents on sandboxes:

```bash
sandbox-agent credentials extract-env --export
```

This prints environment variables for your OpenAI/Anthropic/etc API keys to test with Sandbox Agent SDK.

## FAQ

<details>
<summary><strong>Does this replace the Vercel AI SDK?</strong></summary>

No, they're complementary. AI SDK is for building chat interfaces and calling LLMs. This SDK is for controlling autonomous coding agents that write code and run commands. Use AI SDK for your UI, use this when you need an agent to actually code.
</details>

<details>
<summary><strong>Which coding agents are supported?</strong></summary>

Claude Code, Codex, OpenCode, and Amp. The SDK normalizes their APIs so you can swap between them without changing your code.
</details>

<details>
<summary><strong>How is session data persisted?</strong></summary>

This SDK does not handle persisting session data. Events stream in a universal JSON schema that you can persist anywhere. Consider using Postgres or [Rivet Actors](https://rivet.gg) for data persistence.
</details>

<details>
<summary><strong>Can I run this locally or does it require a sandbox provider?</strong></summary>

Both. Run locally for development, deploy to E2B, Daytona, or Vercel Sandboxes for production.
</details>

<details>
<summary><strong>Does it support [platform]?</strong></summary>

The server is a single Rust binary that runs anywhere with a curl install. If your platform can run Linux binaries (Docker, VMs, etc.), it works. See the deployment guides for E2B, Daytona, and Vercel Sandboxes.
</details>

<details>
<summary><strong>Can I use this with my personal API keys?</strong></summary>

Yes. Use `sandbox-agent credentials extract-env` to extract API keys from your local agent configs (Claude Code, Codex, OpenCode, Amp) and pass them to the sandbox environment.
</details>

<details>
<summary><strong>Why Rust and not [language]?</strong></summary>

Rust gives us a single static binary, fast startup, and predictable memory usage. That makes it easy to run inside sandboxes or in CI without shipping a large runtime, such as Node.js.
</details>

## Project Goals

This project aims to solve 3 problems with agents:

- **Universal Agent API**: Claude Code, Codex, Amp, and OpenCode all have put a lot of work in to the agent scaffold. Each have respective pros and cons and need to be easy to be swapped between.
- **Agent Transcript**: Maintaining agent transcripts is difficult since the agent manages its own sessions. This provides a simpler way to read and retrieve agent transcripts in your system.
- **Agents In Sandboxes**: There are many complications with running agents inside of sandbox providers. This lets you run a simple curl command to spawn an HTTP server for using any agent from within the sandbox.

Features out of scope:

- **Storage of sessions on disk**: Sessions are already stored by the respective coding agents on disk. It's assumed that the consumer is streaming data from this machine to an external storage, such as Postgres, ClickHouse, or Rivet.
- **Direct LLM wrappers**: Use the [Vercel AI SDK](https://ai-sdk.dev/docs/introduction) if you want to implement your own agent from scratch.
- **Git Repo Management**: Just use git commands or the features provided by your sandbox provider of choice.
- **Sandbox Provider API**: Sandbox providers have many nuanced differences in their API, it does not make sense for us to try to provide a custom layer. Instead, we opt to provide guides that let you integrate this project with sandbox providers.

## Roadmap

- [ ] Python SDK
- [ ] Automatic MCP & skill & hook configuration
- [ ] Todo lists


