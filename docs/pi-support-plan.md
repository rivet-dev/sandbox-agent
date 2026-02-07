# Pi Agent Support Plan (pi-mono)

## Implementation Status Update

- Runtime selection now supports two internal modes:
  - `PerSession` (default for unknown/non-allowlisted Pi capabilities)
  - `Shared` (allowlist-only compatibility path)
- Pi sessions now use per-session process isolation by default, enabling true concurrent Pi sessions in Inspector and API clients.
- Shared Pi server code remains available and is used only when capability checks allow multiplexing.
- Session termination for per-session Pi mode hard-kills the underlying Pi process and clears queued prompts/pending waiters.
- In-session concurrent sends are serialized with an unbounded daemon-side FIFO queue per session.

## Investigation Summary

### Pi CLI modes and RPC protocol
- Pi supports multiple modes including interactive, print/JSON output, RPC, and SDK usage. JSON mode outputs a stream of JSON events suitable for parsing, and RPC mode is intended for programmatic control over stdin/stdout.
- RPC mode is started with `pi --mode rpc` and supports options like `--provider`, `--model`, `--no-session`, and `--session-dir`.
- The RPC protocol is newline-delimited JSON over stdin/stdout:
  - Commands are JSON objects written to stdin.
  - Responses are JSON objects with `type: "response"` and optional `id`.
  - Events are JSON objects without `id`.
- `prompt` can include images using `ImageContent` (base64 or URL) alongside text.
- JSON/print mode (`pi -p` or `pi --print --mode json`) produces JSONL for non-interactive parsing and can resume sessions with a token.

### RPC commands
RPC commands listed in `rpc.md` include:
- `new_session`, `get_state`, `list_sessions`, `delete_session`, `rename_session`, `clear_session`
- `prompt`, `queue_message`, `abort`, `get_queued_messages`

### RPC event types
RPC events listed in `rpc.md` include:
- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction`, `auto_retry`, `hook_error`

`message_update` uses `assistantMessageEvent` deltas such as:
- `start`, `text_start`, `text_delta`, `text_end`
- `thinking_start`, `thinking_delta`, `thinking_end`
- `toolcall_start`, `toolcall_delta`, `toolcall_end`
- `toolcall_args_start`, `toolcall_args_delta`, `toolcall_args_end`
- `done`, `error`

`tool_execution_update` includes `partialResult`, which is described as accumulated output so far.

### Schema source locations (pi-mono)
RPC types are documented as living in:
- `packages/ai/src/types.ts` (Model types)
- `packages/agent/src/types.ts` (AgentResponse types)
- `packages/coding-agent/src/core/messages.ts` (message types)
- `packages/coding-agent/src/modes/rpc/rpc-types.ts` (RPC protocol types)

### Distribution assets
Pi releases provide platform-specific binaries such as:
- `pi-darwin-arm64`, `pi-darwin-x64`
- `pi-linux-arm64`, `pi-linux-x64`
- `pi-win-x64.zip`

## Integration Decisions
- Follow the OpenCode pattern: a shared long-running process (stdio RPC) with session multiplexing.
- Primary integration path is RPC streaming (`pi --mode rpc`).
- JSON/print mode is a fallback only (diagnostics or non-interactive runs).
- Create sessions via `new_session`; store the returned `sessionId` as `native_session_id`.
- Use `get_state` as a re-sync path after server restarts.
- Use `prompt` for send-message, with optional image content.
- Convert Pi events into universal events; emit daemon synthetic `session.started` on session creation and `session.ended` only on errors/termination.

## Implementation Plan

### 1) Agent Identity + Capabilities
Files:
- `server/packages/agent-management/src/agents.rs`
- `server/packages/sandbox-agent/src/router.rs`
- `docs/cli.mdx`, `docs/conversion.mdx`, `docs/session-transcript-schema.mdx`
- `README.md`, `frontend/packages/website/src/components/FAQ.tsx`

Tasks:
- Add `AgentId::Pi` with string/binary name `"pi"` and parsing rules.
- Add Pi to `all_agents()` and agent lists.
- Define `AgentCapabilities` for Pi:
  - `tool_calls=true`, `tool_results=true`
  - `text_messages=true`, `streaming_deltas=true`, `item_started=true`
  - `reasoning=true` (from `thinking_*` deltas)
  - `images=true` (ImageContent in `prompt`)
  - `permissions=false`, `questions=false`, `mcp_tools=false`
  - `shared_process=true`, `session_lifecycle=false` (no native session events)
  - `error_events=true` (hook_error)
  - `command_execution=false`, `file_changes=false`, `file_attachments=false`

### 2) Installer and Binary Resolution
Files:
- `server/packages/agent-management/src/agents.rs`

Tasks:
- Add `install_pi()` that:
  - Downloads the correct release asset per platform (`pi-<platform>`).
  - Handles `.zip` on Windows and raw binaries elsewhere.
  - Marks binary executable.
- Add Pi to `AgentManager::install`, `is_installed`, `version`.
- Version detection: try `--version`, `version`, `-V`.

### 3) Schema Extraction for Pi
Files:
- `resources/agent-schemas/src/pi.ts` (new)
- `resources/agent-schemas/src/index.ts`
- `resources/agent-schemas/artifacts/json-schema/pi.json`
- `server/packages/extracted-agent-schemas/build.rs`
- `server/packages/extracted-agent-schemas/src/lib.rs`

Tasks:
- Implement `extractPiSchema()`:
  - Download pi-mono sources (zip/tarball) into a temp dir.
  - Use `ts-json-schema-generator` against `packages/coding-agent/src/modes/rpc/rpc-types.ts`.
  - Include dependent files per `rpc.md` (ai/types, agent/types, core/messages).
  - Extract `RpcEvent`, `RpcResponse`, `RpcCommand` unions (exact type names from source).
- Add fallback schema if remote fetch fails (minimal union with event/response fields).
- Wire pi into extractor index and artifact generation.

### 4) Universal Schema Conversion (Pi -> Universal)
Files:
- `server/packages/universal-agent-schema/src/agents/pi.rs` (new)
- `server/packages/universal-agent-schema/src/agents/mod.rs`
- `server/packages/universal-agent-schema/src/lib.rs`
- `server/packages/sandbox-agent/src/router.rs`

Mapping rules:
- `message_start` -> `item.started` (kind=message, role=assistant, native_item_id=messageId)
- `message_update`:
  - `text_*` -> `item.delta` (assistant text delta)
  - `thinking_*` -> `item.delta` with `ContentPart::Reasoning` (visibility=Private)
  - `toolcall_*` and `toolcall_args_*` -> ignore for now (tool_execution_* is authoritative)
  - `error` -> `item.completed` with `ItemStatus::Failed` (if no later message_end)
- `message_end` -> `item.completed` (finalize assistant message)
- `tool_execution_start` -> `item.started` (kind=tool_call, ContentPart::ToolCall)
- `tool_execution_update` -> `item.delta` for a synthetic tool_result item:
  - Maintain a per-toolCallId buffer to compute delta from accumulated `partialResult`.
- `tool_execution_end` -> `item.completed` (kind=tool_result, output from `result.content`)
  - If `isError=true`, set item status to failed.
- `agent_start`, `turn_start`, `turn_end`, `agent_end`, `auto_compaction`, `auto_retry`, `hook_error`:
  - Map to `ItemKind::Status` with a label like `pi.agent_start`, `pi.auto_retry`, etc.
  - Do not emit `session.ended` for these events.
- If event parsing fails, emit `agent.unparsed` (source=daemon, synthetic=true) and fail tests.

### 5) Shared RPC Server Integration
Files:
- `server/packages/sandbox-agent/src/router.rs`

Tasks:
- Add a new managed stdio server type for Pi, similar to Codex:
  - Create `PiServer` struct with:
    - stdin sender
    - pending request map keyed by request id
    - per-session native session id mapping
  - Extend `ManagedServerKind` to include Pi.
  - Add `ensure_pi_server()` and `spawn_pi_server()` using `pi --mode rpc`.
  - Add a `handle_pi_server_output()` loop to parse stdout lines into events/responses.
- Session creation:
  - On `create_session`, ensure Pi server is running, send `new_session`, store sessionId.
  - Register session with `server_manager.register_session` for native mapping.
- Sending messages:
  - Use `prompt` command; include sessionId and optional images.
  - Emit synthetic `item.started` only if Pi does not emit `message_start`.

### 6) Router + Streaming Path Changes
Files:
- `server/packages/sandbox-agent/src/router.rs`

Tasks:
- Add Pi handling to:
  - `create_session` (new_session)
  - `send_message` (prompt)
  - `parse_agent_line` (Pi event conversion)
  - `agent_modes` (default to `default` unless Pi exposes a mode list)
  - `agent_supports_resume` (true if Pi supports session resume)

### 7) Tests
Files:
- `server/packages/sandbox-agent/tests/...`
- `server/packages/universal-agent-schema/tests/...` (if present)

Tasks:
- Unit tests for conversion:
  - `message_start/update/end` -> item.started/delta/completed
  - `tool_execution_*` -> tool call/result mapping with partialResult delta
  - failure -> agent.unparsed
- Integration tests:
  - Start Pi RPC server, create session, send prompt, stream events.
  - Validate `native_session_id` mapping and event ordering.
- Update HTTP/SSE test coverage to include Pi agent if relevant.

## Risk Areas / Edge Cases
- `tool_execution_update.partialResult` is cumulative; must compute deltas.
- `message_update` may emit `done`/`error` without `message_end`; handle both paths.
- No native session lifecycle events; rely on daemon synthetic events.
- Session recovery after RPC server restart requires `get_state` + re-register sessions.

## Acceptance Criteria
- Pi appears in `/v1/agents`, CLI list, and docs.
- `create_session` returns `native_session_id` from Pi `new_session`.
- Streaming prompt yields universal events with proper ordering:
  - message -> item.started/delta/completed
  - tool execution -> tool call + tool result
- Tests pass and no synthetic data is used in test fixtures.

## Sources
- https://upd.dev/badlogic/pi-mono/src/commit/d36e0ea07303d8a76d51b4a7bd5f0d6d3c490860/packages/coding-agent/docs/rpc.md
- https://buildwithpi.ai/pi-cli
- https://takopi.dev/docs/pi-cli/
- https://upd.dev/badlogic/pi-mono/releases
