# GigaCode

Use [OpenCode](https://opencode.ai)'s UI with any coding agent.

Supports Claude Code, Codex, and Amp.

This is __not__ a fork. It's powered by [Sandbox Agent SDK](https://sandboxagent.dev)'s wizardry.

> **Experimental**: This project is under active development. Please report bugs on [GitHub Issues](https://github.com/rivet-dev/sandbox-agent/issues) or join our [Discord](https://rivet.dev/discord).

## How It Works

```
┌─ GigaCode ────────────────────────────────────────────────────────┐
│ ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│ │  OpenCode TUI   │───▶│  Sandbox Agent  │───▶│  Claude Code /  │ │
│ │                 │    │                 │    │   Codex / Amp   │ │
│ └─────────────────┘    └─────────────────┘    └─────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

- [Sandbox Agent SDK](https://sandboxagent.dev) provides a universal HTTP API for controlling Claude Code, Codex, and Amp
- Sandbox Agent SDK exposes an [OpenCode-compatible endpoint](https://sandboxagent.dev/opencode-compatibility) so OpenCode can talk to any agent
- OpenCode connects to Sandbox Agent SDK via [`attach`](https://opencode.ai/docs/cli/#attach)

## Install

**macOS / Linux / WSL (Recommended)**

```bash
curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/gigacode-install.sh | sh
```

**npm i -g**

```bash
npm install -g gigacode
gigacode --help
```

**bun add -g**

```bash
bun add -g gigacode
# Allow Bun to run postinstall scripts for native binaries.
bun pm -g trust gigacode-linux-x64 gigacode-linux-arm64 gigacode-darwin-arm64 gigacode-darwin-x64 gigacode-win32-x64
gigacode --help
```

**npx**

```bash
npx gigacode --help
```

**bunx**

```bash
bunx gigacode --help
```

> **Note:** Windows is unsupported. Please use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

## Usage

**TUI**

Launch the OpenCode TUI with any coding agent:

```bash
gigacode
```

**Web UI**

Use the [OpenCode Web UI](https://sandboxagent.dev/opencode-compatibility) to control any coding agent from the browser.

**OpenCode SDK**

Use the [`@opencode-ai/sdk`](https://sandboxagent.dev/opencode-compatibility) to programmatically control any coding agent.
