# OpenCode Events: Native vs Sandbox-Agent Comparison

## Scenario

User asks Claude Code: "Read README.md and add a line at the end"

Claude does 2 tool calls (Read → Edit) then responds with final text.

---

## What We Have Now (Sandbox-Agent)

### Claude Code JSON events → Universal events → OpenCode events

```
CLAUDE CODE EVENT                   UNIVERSAL EVENT                        OPENCODE EVENT
─────────────────                   ───────────────                        ──────────────

                                                                     ┌─ 1. session.status {type: "busy"}
User sends prompt via /session/{id}/chat                             │  2. message.updated (user msg)
                                                                     └─ 3. message.part.updated (user text)

{"type":"assistant",                ItemStarted(Message, msg_1,       ─→ 4. message.updated (assistant msg, in-progress)
  content: [text, tool_use(Read)]}    status: InProgress)                5. message.part.updated (text part)
                                    ItemStarted(ToolCall, Read)       ─→ 6. message.updated (assistant msg)
                                                                        7. message.part.updated (tool part, status: "pending")
                                    ItemCompleted(ToolCall, Read)     ─→ 8. message.updated (assistant msg)
                                                                        9. message.part.updated (tool part, status: "running")

{"type":"tool_use", Read}           ItemStarted(ToolCall, Read)       ─→ (duplicate, updates existing tool part)
                                    ItemCompleted(ToolCall, Read)

{"type":"tool_result", Read}        ItemStarted(ToolResult, Read)     ─→ 10. message.updated (assistant msg)
                                                                         11. message.part.updated (tool part, status: "running")
                                    ItemCompleted(ToolResult, Read)   ─→ 12. message.updated (assistant msg)
                                                                         13. message.part.updated (tool part, status: "completed")
                                                                         14. message.part.updated (file parts, if any)

{"type":"assistant",                ItemStarted(Message, msg_2,       ─→ 15. message.updated (assistant msg)
  content: [text, tool_use(Edit)]}    status: InProgress)                 16. message.part.updated (text part)
                                    ItemStarted(ToolCall, Edit)       ─→ 17. message.updated (assistant msg)
                                                                         18. message.part.updated (tool part, status: "pending")
                                    ItemCompleted(ToolCall, Edit)     ─→ 19. message.updated (assistant msg)
                                                                         20. message.part.updated (tool part, status: "running")

{"type":"tool_use", Edit}           ItemStarted(ToolCall, Edit)       ─→ (duplicate, updates existing tool part)
                                    ItemCompleted(ToolCall, Edit)

{"type":"tool_result", Edit}        ItemStarted(ToolResult, Edit)     ─→ 21. message.updated (assistant msg)
                                                                         22. message.part.updated (tool part, status: "running")
                                    ItemCompleted(ToolResult, Edit)   ─→ 23. message.updated (assistant msg)
                                                                         24. message.part.updated (tool part, status: "completed")
                                                                         25. message.part.updated (file parts)

{"type":"assistant",                ItemStarted(Message, msg_3,       ─→ 26. message.updated (assistant msg)
  content: [text]}                    status: InProgress)                 27. message.part.updated (text part)

{"type":"result",                   ItemCompleted(Message, msg_3,     ─→ 28. message.updated (assistant msg, completed)
  result: "Done!"}                    status: Completed)              ─→ 29. session.status {type: "idle"}  ← IDLE #1
                                                                         30. session.idle                   ← IDLE #1

process exits                       SessionEnded                      ─→ 31. session.status {type: "idle"}  ← IDLE #2
                                                                         32. session.idle                   ← IDLE #2
```

**Problem**: 2 idle events. If Claude Code emits `result` per API round-trip
(not just at the end), there would be 4 idle events — one after each `result`.

The root cause is `opencode_compat.rs:1739-1751`:

```rust
// apply_item_event — fires for EVERY ItemCompleted(Message)
if event.event_type == UniversalEventType::ItemCompleted {
    state.opencode.emit_event(json!({
        "type": "session.status",
        "properties": {"sessionID": session_id, "status": {"type": "idle"}}
    }));
    state.opencode.emit_event(json!({
        "type": "session.idle",
        "properties": {"sessionID": session_id}
    }));
}
```

And `opencode_compat.rs:1318-1327`:

```rust
// apply_universal_event — fires on SessionEnded
UniversalEventType::SessionEnded => {
    state.opencode.emit_event(json!({
        "type": "session.status",
        "properties": {"sessionID": session_id, "status": {"type": "idle"}}
    }));
    state.opencode.emit_event(json!({
        "type": "session.idle",
        "properties": {"sessionID": event.session_id}
    }));
}
```

---

## What We Expect (Native OpenCode Behavior)

Same scenario: User asks to read and edit a file, 2 tool calls.

```
 #  EVENT                                           NOTES
──  ─────                                           ─────
 1  session.status {type: "busy"}                   ← set once when prompt sent
 2  message.updated (user message)
 3  message.part.updated (user text part)

 4  message.updated (assistant message, in-progress)
 5  message.part.updated (text: "I'll read...")     ← streaming deltas
 6  message.part.updated (text: "I'll read the..")  ← more deltas
 7  message.part.updated (tool: Read, "pending")
 8  message.part.updated (tool: Read, "running")
 9  message.part.updated (tool: Read, "completed")  ← tool done, agent continues
10  message.part.updated (text: "Now I'll edit...")  ← more text
11  message.part.updated (tool: Edit, "pending")
12  message.part.updated (tool: Edit, "running")
13  message.part.updated (tool: Edit, "completed")  ← tool done, agent continues
14  message.part.updated (text: "Done!")             ← final text
15  message.updated (assistant message, completed)

16  session.status {type: "idle"}                   ← ONCE, only when truly done
17  session.idle                                    ← ONCE, only when truly done
```

**Key difference**: Status stays `busy` the entire time (events 1–15). Idle
fires exactly once (events 16–17) after ALL tool calls complete and the
final response is sent.

---

## Side-by-Side Diff

```
                    WHAT WE HAVE                          WHAT WE EXPECT
                    ────────────                          ──────────────
Prompt sent      →  session.status: busy                  session.status: busy
                    message.updated (user)                 message.updated (user)
                    message.part.updated (user text)       message.part.updated (user text)

Assistant start  →  message.updated (in-progress)         message.updated (in-progress)
                    message.part.updated (text)            message.part.updated (text, delta)

Tool 1 (Read)    →  message.part.updated (pending)        message.part.updated (pending)
                    message.part.updated (running)         message.part.updated (running)
                    message.part.updated (completed)       message.part.updated (completed)

                 →  ❌ session.status: idle                (nothing — still busy)
                    ❌ session.idle
                    ❌ session.status: busy (never re-emitted)

Tool 2 (Edit)    →  message.part.updated (pending)        message.part.updated (pending)
                    message.part.updated (running)         message.part.updated (running)
                    message.part.updated (completed)       message.part.updated (completed)

                 →  ❌ session.status: idle                (nothing — still busy)
                    ❌ session.idle

Final text       →  message.part.updated (text)           message.part.updated (text)
                    message.updated (completed)            message.updated (completed)

Turn done        →  session.status: idle                  session.status: idle    ← correct
                    session.idle                           session.idle            ← correct

Session end      →  ❌ session.status: idle (duplicate)   (nothing — or idle if
                    ❌ session.idle (duplicate)              session closes)
```

---

## Event Type Mapping

### Universal → OpenCode (how each universal event maps)

| Universal Event | OpenCode Event(s) | Emitted By | Issue |
|---|---|---|---|
| `ItemStarted(Message)` | `message.updated` + `message.part.updated` (text/reasoning) | `apply_item_event` | OK |
| `ItemDelta` | `message.updated` + `message.part.updated` (with delta) | `apply_item_delta` | OK |
| `ItemCompleted(Message)` | `message.updated` + **`session.status: idle`** + **`session.idle`** | `apply_item_event:1739` | **BUG: premature idle** |
| `ItemStarted(ToolCall)` | `message.updated` + `message.part.updated` (tool, pending) | `apply_tool_item_event` | OK |
| `ItemCompleted(ToolCall)` | `message.updated` + `message.part.updated` (tool, running) | `apply_tool_item_event` | OK |
| `ItemStarted(ToolResult)` | `message.updated` + `message.part.updated` (tool, running) | `apply_tool_item_event` | OK |
| `ItemCompleted(ToolResult)` | `message.updated` + `message.part.updated` (tool, completed/error) + file parts | `apply_tool_item_event` | OK |
| `SessionEnded` | **`session.status: idle`** + **`session.idle`** | `apply_universal_event:1318` | **Duplicate idle** |
| `PermissionRequested` | `permission.asked` | `apply_permission_event` | OK |
| `PermissionResolved` | `permission.replied` or `permission.rejected` | `apply_permission_event` | OK |
| `QuestionRequested` | `question.asked` | `apply_question_event` | OK |
| `QuestionResolved` | `question.replied` or `question.rejected` | `apply_question_event` | OK |
| `Error` | `session.error` | `apply_universal_event` | OK |

### OpenCode → Universal (reverse: how native OpenCode events are parsed)

| OpenCode Event | Universal Event | Parsed By |
|---|---|---|
| `session.created` | `SessionStarted` | `opencode.rs:191` |
| `session.status` | `ItemCompleted(Status)` | `opencode.rs:205` |
| `session.idle` | `ItemCompleted(Status)` | `opencode.rs:221` |
| `session.error` | `ItemCompleted(Status)` | `opencode.rs:235` |
| `message.updated` | `ItemStarted` or `ItemCompleted(Message)` depending on `time.completed` | `opencode.rs:13` |
| `message.part.updated` | `ItemStarted` + `ItemDelta` (text) or `ItemStarted/Completed` (tool) | `opencode.rs:36` |
| `permission.asked` | `PermissionRequested` | (not shown in opencode.rs) |
| `question.asked` | `QuestionRequested` | (not shown in opencode.rs) |

---

## Claude Code Event → Universal Event Mapping

| Claude Code JSON Event | Universal Event(s) Produced | Triggers Idle? |
|---|---|---|
| `{"type":"assistant", message:{content:[text,tool_use]}}` | `ItemStarted(Message, InProgress)` + `ItemStarted(ToolCall)` + `ItemCompleted(ToolCall)` per tool_use | No (no ItemCompleted Message) |
| `{"type":"tool_use", tool_use:{...}}` | `ItemStarted(ToolCall)` + `ItemCompleted(ToolCall)` | No |
| `{"type":"tool_result", tool_result:{...}}` | `ItemStarted(ToolResult)` + `ItemCompleted(ToolResult)` | No |
| `{"type":"result", result:"..."}` | **`ItemCompleted(Message, Completed)`** | **YES** ← problem |
| `{"type":"stream", event:{type:"content_block_delta"}}` | `ItemDelta` | No |
| Process exit | `SessionEnded` | **YES** ← duplicate |

The `result` event uses the same `native_message_id` as the last `assistant`
event (via `claude_message_id`), linking the `ItemStarted` and `ItemCompleted`
to the same logical message. See `claude.rs:403-427`.

---

## Options to Fix

### Option 1: Only emit idle on SessionEnded

Remove idle from `apply_item_event:1739`. Keep only `SessionEnded` handler.

- **Pro**: Simple, single idle per session
- **Con**: Breaks multi-turn sessions (persistent process stays alive between user messages; idle should fire between turns)

### Option 2: Turn-level state tracking

Track pending tool calls. Only emit idle when `ItemCompleted(Message)` fires AND no tool calls are pending.

- **Pro**: Correct semantics
- **Con**: Event ordering matters — `result` may arrive before `tool_result`, making counter out of sync

### Option 3: Re-emit busy on new activity

Keep idle as-is, but also emit `session.status: busy` on any `ItemStarted` event after idle.

- **Pro**: Self-correcting, UI sees busy→idle→busy→idle
- **Con**: Noisy, depends on UI handling rapid transitions gracefully

### Option 4: Add TurnCompleted to universal schema

New event type that agents explicitly emit when a full turn is done.

- **Pro**: Correct by design, works for all agents
- **Con**: Schema change + update every agent conversion

### Option 5: Debounce idle

Buffer idle, cancel if new event arrives within N ms.

- **Pro**: No schema changes
- **Con**: Adds latency, fragile

### Option 6: Only emit idle for final ItemCompleted(Message) (Recommended)

Use heuristics to distinguish intermediate vs final messages:
- Don't emit idle from `apply_item_event` at all
- Emit idle only from `SessionEnded`
- For agents that support resume (process stays alive), emit idle after a
  short quiet period following the last event (e.g., 500ms with no new events)

- **Pro**: Works for both one-shot (mock) and persistent (Claude Code) sessions
- **Con**: Needs quiet-period heuristic for persistent agents
