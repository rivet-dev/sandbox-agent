# Universal Schema (Single Version, Breaking)

This document defines the canonical universal session + event model. It replaces prior versions; there is no v2. The design prioritizes compatibility with native agent APIs and fills gaps with explicit synthetics.

Principles
- Most-compatible-first: choose semantics that map cleanly to native APIs (Codex/OpenCode/Amp/Claude).
- Uniform behavior: clients should not special-case agents; the daemon normalizes differences.
- Synthetics fill gaps: when a provider lacks a feature (session start/end, deltas, user messages), we synthesize events with `source=daemon`.
- Raw preservation: always keep native payloads in `raw` for agent-sourced events.
- UI coverage: update the inspector/UI to the new schema and ensure UI tests cover all session features (messages, deltas, tools, permissions, questions, errors, termination).

Identifiers
- session_id: daemon-generated session identifier.
- native_session_id: provider thread/session/run identifier (thread_id is merged here).
- item_id: daemon-generated identifier for any universal item.
- native_item_id: provider-native item/message identifier if available; otherwise null.

Event envelope
```json
{
  "event_id": "evt_...",
  "sequence": 42,
  "time": "2026-01-27T19:10:11Z",
  "session_id": "sess_...",
  "native_session_id": "provider_...",
  "synthetic": false,
  "source": "agent|daemon",
  "type": "session.started|session.ended|item.started|item.delta|item.completed|error|permission.requested|permission.resolved|question.requested|question.resolved|agent.unparsed",
  "data": { "..." : "..." },
  "raw": { "..." : "..." }
}
```

Notes:
- `source=agent` for native events; `source=daemon` for synthetics.
- `synthetic` is always present and mirrors whether the event is daemon-produced.
- `raw` is always present. It may be null unless the client opts in to raw payloads; when opt-in is enabled, raw is populated for all events.
- For synthetic events derived from native payloads, include the underlying payload in `raw` when possible.
- Parsing failures emit agent.unparsed (source=daemon, synthetic=true) and should be treated as test failures.

Raw payload opt-in
- Events endpoints accept `include_raw=true` to populate the `raw` field.
- When `include_raw` is not set or false, `raw` is still present but null.
- Applies to both HTTP and SSE event streams.

Item model
```json
{
  "item_id": "itm_...",
  "native_item_id": "provider_item_...",
  "parent_id": "itm_parent_or_null",
  "kind": "message|tool_call|tool_result|system|status|unknown",
  "role": "user|assistant|system|tool|null",
  "content": [ { "type": "...", "...": "..." } ],
  "status": "in_progress|completed|failed"
}
```

Content parts (non-exhaustive; extend as needed)
- text: `{ "type": "text", "text": "..." }`
- json: `{ "type": "json", "json": { ... } }`
- tool_call: `{ "type": "tool_call", "name": "...", "arguments": "...", "call_id": "..." }`
- tool_result: `{ "type": "tool_result", "call_id": "...", "output": "..." }`
- file_ref: `{ "type": "file_ref", "path": "...", "action": "read|write|patch", "diff": "..." }`
- reasoning: `{ "type": "reasoning", "text": "...", "visibility": "public|private" }`
- image: `{ "type": "image", "path": "...", "mime": "..." }`
- status: `{ "type": "status", "label": "...", "detail": "..." }`

Event types

session.started
```json
{ "metadata": { "...": "..." } }
```

session.ended
```json
{ "reason": "completed|error|terminated", "terminated_by": "agent|daemon" }
```

item.started
```json
{ "item": { ...Item } }
```

item.delta
```json
{ "item_id": "itm_...", "native_item_id": "provider_item_or_null", "delta": "text fragment" }
```

item.completed
```json
{ "item": { ...Item } }
```

error
```json
{ "message": "...", "code": "optional", "details": { "...": "..." } }
```

agent.unparsed
```json
{ "error": "parse failure message", "location": "agent parser name", "raw_hash": "optional" }
```

permission.requested / permission.resolved
```json
{ "permission_id": "...", "action": "...", "status": "requested|approved|denied", "metadata": { "...": "..." } }
```

question.requested / question.resolved
```json
{ "question_id": "...", "prompt": "...", "options": ["..."], "response": "...", "status": "requested|answered|rejected" }
```

Delta policy (uniform across agents)
- Always emit item.delta for messages.
- For agents without native deltas (Claude/Amp), emit a single synthetic delta containing the full final content immediately before item.completed.
- For Codex/OpenCode, forward native deltas as-is and still emit item.completed with the final content.

User messages
- If the provider emits user messages (Codex/OpenCode/Amp), map directly to message items with role=user.
- If the provider does not emit user messages (Claude), synthesize user message items from the input we send; mark source=daemon and set native_item_id=null.

Tool normalization
- Tool calls/results are always emitted as their own items (kind=tool_call/tool_result) with parent_id pointing to the originating message item.
- Codex: mcp tool call progress and tool items map directly.
- OpenCode: tool parts in message.part.updated are mapped into tool items with lifecycle states.
- Amp: tool_call/tool_result map directly.
- Claude: synthesize tool items from CLI tool usage where possible; if insufficient, omit tool items and preserve raw payloads.

OpenCode ordering rule
- OpenCode may emit message.part.updated before message.updated.
- When a part delta arrives first, create a stub item.started (source=daemon) for the parent message item, then emit item.delta.

Session lifecycle
- If an agent does not emit a session start/end, emit session.started/session.ended synthetically (source=daemon).
- session.ended uses terminated_by=daemon when our termination API is used; terminated_by=agent when the provider ends the session.

Native ID mapping
- native_session_id is the only provider session identifier.
- native_item_id preserves the provider item/message id when available; otherwise null.
- item_id is always daemon-generated.
