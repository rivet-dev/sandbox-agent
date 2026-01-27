# Glossary (Universal Schema)

This glossary defines the universal schema terms used across the daemon, SDK, and tests.

Session terms
- session_id: daemon-generated identifier for a universal session.
- native_session_id: provider-native thread/session/run identifier (thread_id merged here).
- session.started: event emitted at session start (native or synthetic).
- session.ended: event emitted at session end (native or synthetic); includes reason and terminated_by.
- terminated_by: who ended the session: agent or daemon.
- reason: why the session ended: completed, error, or terminated.

Event terms
- UniversalEvent: envelope that wraps all events; includes source, type, data, raw.
- event_id: unique identifier for the event.
- sequence: monotonic event sequence number within a session.
- time: RFC3339 timestamp for the event.
- source: event origin: agent (native) or daemon (synthetic).
- raw: original provider payload for native events; optional for synthetic events.

Item terms
- item_id: daemon-generated identifier for a universal item.
- native_item_id: provider-native item/message identifier when available; null otherwise.
- parent_id: item_id of the parent item (e.g., tool call/result parented to a message).
- kind: item category: message, tool_call, tool_result, system, status, unknown.
- role: actor role for message items: user, assistant, system, tool (or null).
- status: item lifecycle status: in_progress, completed, failed (or null).

Item event terms
- item.started: item creation event (may be synthetic).
- item.delta: streaming delta event (native where supported; synthetic otherwise).
- item.completed: final item event with complete content.

Content terms
- content: ordered list of parts that make up an item payload.
- content part: a typed element inside content (text, json, tool_call, tool_result, file_ref, image, status, reasoning).
- text: plain text content part.
- json: structured JSON content part.
- tool_call: tool invocation content part (name, arguments, call_id).
- tool_result: tool result content part (call_id, output).
- file_ref: file reference content part (path, action, diff).
- image: image content part (path, mime).
- status: status content part (label, detail).
- reasoning: reasoning content part (text, visibility).
- visibility: reasoning visibility: public or private.

HITL terms
- permission.requested / permission.resolved: human-in-the-loop permission flow events.
- permission_id: identifier for the permission request.
- question.requested / question.resolved: human-in-the-loop question flow events.
- question_id: identifier for the question request.
- options: question answer options.
- response: selected answer for a question.

Synthetic terms
- synthetic event: a daemon-emitted event used to fill gaps in provider-native schemas.
- source=daemon: marks synthetic events.
- synthetic delta: a single full-content delta emitted for providers without native deltas.

Provider terms
- agent: the native provider (claude, codex, opencode, amp).
- native payload: the provider’s original event/message object stored in raw.
