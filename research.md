# Research: Subagents

Summary of subagent support across providers based on current agent schemas and docs.

OpenCode
- Schema includes `Part` variants with `type = "subtask"` and fields like `agent`, `prompt`, and `description`.
- These parts are emitted via `message.part.updated`, which can be used to render subagent activity.

Codex
- Schema includes `SessionSource` with a `subagent` variant (e.g., review/compact), attached to `Thread.source`.
- This indicates the origin of a thread, not active subagent status updates in the event stream.

Claude
- CLI schema does not expose subagent events.
- The Task tool supports `subagent_type`, but it is not represented as a structured event; it may be inferred only from tool usage output.

Amp
- Schema has no subagent event types.
- Permission rules include `context: "subagent"` and `delegate` actions, but no event stream for subagent status.

Current universal behavior
- Subagent activity is normalized into the standard message/tool flow; no dedicated subagent fields yet.
