# Codex Research

Research notes on OpenAI Codex's configuration, credential discovery, and runtime behavior based on agent-jj implementation.

## Overview

- **Provider**: OpenAI
- **Execution Method (this repo)**: Codex App Server (JSON-RPC over stdio)
- **Execution Method (alternatives)**: SDK (`@openai/codex-sdk`) or CLI binary
- **Session Persistence**: Thread ID (string)
- **Import**: Dynamic import to avoid bundling issues
- **Binary Location**: `~/.nvm/versions/node/v24.3.0/bin/codex` (npm global install)

## SDK Architecture

**The SDK wraps a bundled binary** - it does NOT make direct API calls.

- The TypeScript SDK includes a pre-compiled Codex binary
- When you use the SDK, it spawns this binary as a child process
- Communication happens via stdin/stdout using JSONL (JSON Lines) format
- The binary itself handles the actual communication with OpenAI's backend services

Sources: [Codex SDK docs](https://developers.openai.com/codex/sdk/), [GitHub](https://github.com/openai/codex)

## CLI Usage (Alternative to App Server / SDK)

You can use the `codex` binary directly instead of the SDK:

### Interactive Mode
```bash
codex "your prompt here"
codex --model o3 "your prompt"
```

### Non-Interactive Mode (`codex exec`)
```bash
codex exec "your prompt here"
codex exec --json "your prompt"  # JSONL output
codex exec -m o3 "your prompt"
codex exec --dangerously-bypass-approvals-and-sandbox "prompt"
codex exec resume --last  # Resume previous session
```

### Key CLI Flags
| Flag | Description |
|------|-------------|
| `--json` | Print events to stdout as JSONL |
| `-m, --model MODEL` | Model to use |
| `-s, --sandbox MODE` | `read-only`, `workspace-write`, `danger-full-access` |
| `--full-auto` | Auto-approve with workspace-write sandbox |
| `--dangerously-bypass-approvals-and-sandbox` | Skip all prompts (dangerous) |
| `-C, --cd DIR` | Working directory |
| `-o, --output-last-message FILE` | Write final response to file |
| `--output-schema FILE` | JSON Schema for structured output |

### Session Management
```bash
codex resume          # Pick from previous sessions
codex resume --last   # Resume most recent
codex fork --last     # Fork most recent session
```

## Credential Discovery

### Priority Order

1. User-configured credentials (from `credentials` array)
2. Environment variable: `CODEX_API_KEY`
3. Environment variable: `OPENAI_API_KEY`
4. Bootstrap extraction from config files

### Config File Location

| Path | Description |
|------|-------------|
| `~/.codex/auth.json` | Primary auth config |

### Auth File Structure

```json
// API Key authentication
{
  "OPENAI_API_KEY": "sk-..."
}

// OAuth authentication
{
  "tokens": {
    "access_token": "..."
  }
}
```

## SDK Usage

### Client Initialization

```typescript
import { Codex } from "@openai/codex-sdk";

// With API key
const codex = new Codex({ apiKey: "sk-..." });

// Without API key (uses default auth)
const codex = new Codex();
```

Dynamic import is used to avoid bundling the SDK:
```typescript
const { Codex } = await import("@openai/codex-sdk");
```

### Thread Management

```typescript
// Start new thread
const thread = codex.startThread();

// Resume existing thread
const thread = codex.resumeThread(threadId);
```

### Running Prompts

```typescript
const { events } = await thread.runStreamed(prompt);

for await (const event of events) {
  // Process events
}
```

## App Server Protocol (JSON-RPC)

Codex App Server uses JSON-RPC 2.0 over JSONL/stdin/stdout (no port required).

### Key Requests

- `initialize` → returns server info
- `thread/start` → starts a new thread
- `turn/start` → sends user input for a thread

### Event Notifications (examples)

```json
{ "method": "thread/started", "params": { "thread": { "id": "thread_abc123" } } }
{ "method": "item/completed", "params": { "item": { "type": "agentMessage", "text": "..." } } }
{ "method": "turn/completed", "params": { "threadId": "thread_abc123", "turn": { "items": [] } } }
```

### Approval Requests (server → client)

The server can send JSON-RPC requests (with `id`) for approvals:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

These require JSON-RPC responses with a decision payload.

## Response Schema

```typescript
// CodexRunResultSchema
type CodexRunResult = string | {
  result?: string;
  output?: string;
  message?: string;
  // ...additional fields via passthrough
};
```

Content is extracted in priority order: `result` > `output` > `message`

## Thread ID Retrieval

Thread ID can be obtained from multiple sources:

1. `thread.started` event's `thread_id` property
2. Thread object's `id` getter (after first turn)
3. Thread object's `threadId` or `_id` properties (fallbacks)

```typescript
function getThreadId(thread: unknown): string | null {
  const value = thread as { id?: string; threadId?: string; _id?: string };
  return value.id ?? value.threadId ?? value._id ?? null;
}
```

## Agent Modes vs Permission Modes

Codex separates sandbox levels (permissions) from behavioral modes (prompt prefixes).

### Permission Modes (Sandbox Levels)

| Mode | CLI Flag | Behavior |
|------|----------|----------|
| `read-only` | `-s read-only` | No file modifications |
| `workspace-write` | `-s workspace-write` | Can modify workspace files |
| `danger-full-access` | `-s danger-full-access` | Full system access |
| `bypass` | `--dangerously-bypass-approvals-and-sandbox` | Skip all checks |

### Root Restrictions

**Codex has no root restrictions** - unlike Claude, Codex does not check if running as root (uid 0).

The `--dangerously-bypass-approvals-and-sandbox` flag works regardless of user privileges. This makes Codex more suitable for automated container environments that commonly run as root.

### Agent Modes (Prompt Prefixes)

Codex doesn't have true agent modes - behavior is controlled via prompt prefixing:

| Mode | Prompt Prefix |
|------|---------------|
| `build` | No prefix (default) |
| `plan` | `"Make a plan before acting.\n\n"` |
| `chat` | `"Answer conversationally.\n\n"` |

```typescript
function withModePrefix(prompt: string, mode: AgentMode): string {
  if (mode === "plan") {
    return `Make a plan before acting.\n\n${prompt}`;
  }
  if (mode === "chat") {
    return `Answer conversationally.\n\n${prompt}`;
  }
  return prompt;
}
```

### Human-in-the-Loop

Codex has no interactive HITL in SDK mode. All permissions must be configured upfront via sandbox level.

## Error Handling

- `turn.failed` events are captured but don't throw
- Thread ID is still returned on error for potential resumption
- Events iterator may throw after errors - caught and logged

```typescript
interface CodexPromptResult {
  result: unknown;
  threadId?: string | null;
  error?: string;  // Set if turn failed
}
```

## Conversion to Universal Format

Codex output is converted via `convertCodexOutput()`:

1. Parse with `CodexRunResultSchema`
2. If result is string, use directly
3. Otherwise extract from `result`, `output`, or `message` fields
4. Wrap as assistant message entry

## Session Continuity

- Thread ID persists across prompts
- Use `resumeThread(threadId)` to continue conversation
- Thread ID is captured from `thread.started` event or thread object

## Shared App-Server Architecture (Daemon Implementation)

The sandbox daemon uses a **single shared Codex app-server process** to handle multiple sessions, similar to OpenCode's server model. This differs from Claude/Amp which spawn a new process per turn.

### Architecture Comparison

| Agent | Model | Process Lifetime | Session ID |
|-------|-------|------------------|------------|
| Claude | Subprocess | Per-turn (killed on TurnCompleted) | `--resume` flag |
| Amp | Subprocess | Per-turn | `--continue` flag |
| OpenCode | HTTP Server | Daemon lifetime | Session ID via API |
| **Codex** | **Stdio Server** | **Daemon lifetime** | **Thread ID via JSON-RPC** |

### Daemon Flow

1. **First Codex session created**: Spawns `codex app-server` process, performs `initialize`/`initialized` handshake
2. **Session creation**: Sends `thread/start` request, captures `thread_id` as `native_session_id`
3. **Message sent**: Sends `turn/start` request with `thread_id`, streams notifications back to session
4. **Multi-turn**: Reuses same `thread_id`, process stays alive, no respawn needed
5. **Daemon shutdown**: Process terminated with daemon

### Why This Approach?

1. **Performance**: No process spawn overhead per message
2. **Multi-turn support**: Thread persists in server memory, no resume needed
3. **Consistent with OpenCode**: Similar server-based pattern reduces code complexity
4. **API alignment**: Matches Codex's intended app-server usage pattern

### Protocol Details

The shared server uses JSON-RPC 2.0 for request/response correlation:

```
Daemon                           Codex App-Server
   |                                   |
   |-- initialize {id: 1} ------------>|
   |<-- response {id: 1} --------------|
   |-- initialized (notification) ---->|
   |                                   |
   |-- thread/start {id: 2} ---------->|
   |<-- response {id: 2, thread.id} ---|
   |<-- thread/started (notification) -|
   |                                   |
   |-- turn/start {id: 3, threadId} -->|
   |<-- turn/started (notification) ---|
   |<-- item/* (notifications) --------|
   |<-- turn/completed (notification) -|
```

### Thread-to-Session Routing

Notifications are routed to the correct session by extracting `threadId` from each notification:

```rust
fn codex_thread_id_from_server_notification(notification) -> Option<String> {
    // All thread-scoped notifications include threadId field
    match notification {
        TurnStarted(params) => Some(params.thread_id),
        ItemCompleted(params) => Some(params.thread_id),
        // ... etc
    }
}
```

## Notes

- SDK is dynamically imported to reduce bundle size
- No explicit timeout (relies on SDK defaults)
- Thread ID may not be available until first event
- Error messages are preserved for debugging
- Working directory is not explicitly set (SDK handles internally)
