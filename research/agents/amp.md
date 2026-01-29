# Amp Research

Research notes on Sourcegraph Amp's configuration, credential discovery, and runtime behavior.

## Overview

- **Provider**: Anthropic (via Sourcegraph)
- **Execution Method**: CLI subprocess (`amp` command)
- **Session Persistence**: Session ID (string)
- **SDK**: `@sourcegraph/amp-sdk` (closed source)
- **Binary Location**: `/usr/local/bin/amp`

## CLI Usage

### Interactive Mode
```bash
amp "your prompt here"
amp --model claude-sonnet-4 "your prompt"
```

### Non-Interactive Mode
```bash
amp --print --output-format stream-json "your prompt"
amp --print --output-format stream-json --dangerously-skip-permissions "prompt"
amp --continue SESSION_ID "follow up"
```

### Key CLI Flags

| Flag | Description |
|------|-------------|
| `--print` | Output mode (non-interactive) |
| `--output-format stream-json` | JSONL streaming output |
| `--dangerously-skip-permissions` | Skip permission prompts |
| `--continue SESSION_ID` | Resume existing session |
| `--model MODEL` | Specify model |
| `--toolbox TOOLBOX` | Toolbox configuration |

## Credential Discovery

### Priority Order

1. Environment variable: `ANTHROPIC_API_KEY`
2. Sourcegraph authentication
3. Claude Code credentials (shared)

### Config File Locations

| Path | Description |
|------|-------------|
| `~/.amp/config.json` | Primary config |
| `~/.claude/.credentials.json` | Shared with Claude Code |

Amp can use Claude Code's OAuth credentials as fallback.

## Streaming Response Format

Amp outputs newline-delimited JSON events:

```json
{"type": "system", "subtype": "init", "session_id": "...", "tools": [...]}
{"type": "assistant", "message": {...}, "session_id": "..."}
{"type": "user", "message": {...}, "session_id": "..."}
{"type": "result", "subtype": "success", "result": "...", "session_id": "..."}
```

### Event Types

| Type | Description |
|------|-------------|
| `system` | System initialization with tools list |
| `assistant` | Assistant message with content blocks |
| `user` | User message (tool results) |
| `result` | Final result with session ID |

### Content Block Types

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; data: string };
```

## Response Schema

```typescript
interface AmpResultMessage {
  type: "result";
  subtype: "success";
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  session_id: string;
}
```

## Session Management

- Session ID captured from streaming events
- Use `--continue SESSION_ID` to resume
- Sessions stored internally by Amp CLI

## Agent Modes vs Permission Modes

### Permission Modes (Declarative Rules)

Amp uses declarative permission rules configured before execution:

```typescript
interface PermissionRule {
  tool: string;  // Glob pattern: "Bash", "mcp__playwright__*"
  matches?: { [argumentName: string]: string | string[] | boolean };
  action: "allow" | "reject" | "ask" | "delegate";
  context?: "thread" | "subagent";
}
```

| Action | Behavior |
|--------|----------|
| `allow` | Automatically permit |
| `reject` | Automatically deny |
| `ask` | Prompt user (CLI handles internally) |
| `delegate` | Delegate to subagent context |

### Example Rules

```typescript
const permissions: PermissionRule[] = [
  { tool: "Read", action: "allow" },
  { tool: "Bash", matches: { command: "git *" }, action: "allow" },
  { tool: "Write", action: "ask" },
  { tool: "mcp__*", action: "reject" }
];
```

### Agent Modes

No documented agent mode concept. Behavior controlled via:
- `--toolbox` flag for different tool configurations
- Permission rules for capability restrictions

### Bypass All Permissions

```bash
amp --dangerously-skip-permissions "prompt"
```

Or via SDK:
```typescript
execute(prompt, { dangerouslyAllowAll: true });
```

### Root Restrictions

**Amp has no known root restrictions** - the `--dangerously-skip-permissions` flag works regardless of user privileges. This makes Amp suitable for automated container environments that commonly run as root.

## Human-in-the-Loop

### No Interactive HITL API

While permission rules support `"ask"` action, Amp does not expose an SDK-level API for programmatically responding to permission requests. The CLI handles user interaction internally.

For universal API integration, Amp should be run with:
- Pre-configured permission rules, or
- `dangerouslyAllowAll: true` to bypass

## SDK Usage

```typescript
import { execute, type AmpOptions } from '@sourcegraph/amp-sdk';

interface AmpOptions {
  cwd?: string;
  dangerouslyAllowAll?: boolean;
  toolbox?: string;
  mcpConfig?: MCPConfig;
  permissions?: PermissionRule[];
  continue?: boolean | string;
}

const result = await execute(prompt, options);
```

## Installation

```bash
# Get latest version
VERSION=$(curl -s https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt)

# Linux x64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-linux-x64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# Linux ARM64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-linux-arm64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# macOS ARM64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-darwin-arm64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# macOS x64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-darwin-x64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp
```

## Timeout

- Default timeout: 5 minutes (300,000 ms)
- Process killed with `SIGTERM` on timeout

## Notes

- Amp is similar to Claude Code (same streaming format)
- Can share credentials with Claude Code
- No interactive HITL - must use pre-configured permissions
- SDK is closed source but types are documented
- MCP server integration supported via `mcpConfig`
