# Universal ↔ Agent Term Mapping

Source of truth: generated agent schemas in `resources/agent-schemas/artifacts/json-schema/`.

Identifiers

+----------------------+------------------------+------------------------------------------+-----------------------------+------------------------+
| Universal term       | Claude                 | Codex (app-server)                       | OpenCode                    | Amp                    |
+----------------------+------------------------+------------------------------------------+-----------------------------+------------------------+
| session_id           | n/a (daemon-only)      | n/a (daemon-only)                        | n/a (daemon-only)           | n/a (daemon-only)      |
| native_session_id    | none                   | threadId                                 | sessionID                   | none                   |
| item_id              | synthetic              | ThreadItem.id                            | Message.id                  | StreamJSONMessage.id   |
| native_item_id       | none                   | ThreadItem.id                            | Message.id                  | StreamJSONMessage.id   |
+----------------------+------------------------+------------------------------------------+-----------------------------+------------------------+

Notes:
- When a provider does not supply IDs (Claude), we synthesize item_id values and keep native_item_id null.
- native_session_id is the only provider session identifier. It is intentionally used for thread/session/run ids.
- native_item_id preserves the agent-native item/message id when present.
- source indicates who emitted the event: agent (native) or daemon (synthetic).
- raw is always present on events. When clients do not opt-in to raw payloads, raw is null.
- opt-in via `include_raw=true` on events endpoints (HTTP + SSE).
- If parsing fails, emit agent.unparsed (source=daemon, synthetic=true). Tests must assert zero unparsed events.

Events / Message Flow

+------------------------+------------------------------+--------------------------------------------+-----------------------------------------+----------------------------------+
| Universal term         | Claude                       | Codex (app-server)                         | OpenCode                                | Amp                              |
+------------------------+------------------------------+--------------------------------------------+-----------------------------------------+----------------------------------+
| session.started        | none                         | method=thread/started                      | type=session.created                    | none                             |
| session.ended          | SDKMessage.type=result       | no explicit session end (turn/completed)   | no explicit session end (session.deleted)| type=done                        |
| message (user)         | SDKMessage.type=user         | item/completed (ThreadItem.type=userMessage)| message.updated (Message.role=user)    | type=message                     |
| message (assistant)    | SDKMessage.type=assistant    | item/completed (ThreadItem.type=agentMessage)| message.updated (Message.role=assistant)| type=message                  |
| message.delta          | synthetic                   | method=item/agentMessage/delta             | type=message.part.updated (delta)       | synthetic                        |
| tool call              | synthetic from tool usage    | method=item/mcpToolCall/progress           | message.part.updated (part.type=tool)   | type=tool_call                   |
| tool result            | synthetic from tool usage    | item/completed (tool result ThreadItem variants) | message.part.updated (part.type=tool, state=completed) | type=tool_result     |
| permission.requested   | none                         | none                                       | type=permission.asked                   | none                             |
| permission.resolved    | none                         | none                                       | type=permission.replied                 | none                             |
| question.requested     | ExitPlanMode tool (synthetic)| experimental request_user_input (payload)  | type=question.asked                     | none                             |
| question.resolved      | ExitPlanMode reply (synthetic)| experimental request_user_input (payload) | type=question.replied / question.rejected | none                          |
| error                  | SDKResultMessage.error       | method=error                               | type=session.error (or message error)   | type=error                        |
+------------------------+------------------------------+--------------------------------------------+-----------------------------------------+----------------------------------+

Synthetics

+------------------------------+------------------------+--------------------------+--------------------------------------------------------------+
| Synthetic element            | When it appears        | Stored as               | Notes                                                        |
+------------------------------+------------------------+--------------------------+--------------------------------------------------------------+
| session.started              | When agent emits no explicit start | session.started event | Mark source=daemon                                            |
| session.ended                | When agent emits no explicit end   | session.ended event   | Mark source=daemon; reason may be inferred                    |
| item_id (Claude)             | Claude provides no item IDs        | item_id               | Maintain provider_item_id map when possible                   |
| user message (Claude)        | Claude emits only assistant output | item.completed        | Mark source=daemon; preserve raw input in event metadata       |
| question events (Claude)     | Plan mode ExitPlanMode tool usage  | question.requested/resolved | Synthetic mapping from tool call/result                       |
| native_session_id (Codex)    | Codex uses threadId                | native_session_id     | Intentionally merged threadId into native_session_id          |
+------------------------------+------------------------+--------------------------+--------------------------------------------------------------+
| message.delta (Claude/Amp)   | No native deltas               | item.delta             | Synthetic delta with full message content; source=daemon       |
+------------------------------+------------------------+--------------------------+--------------------------------------------------------------+
| message.delta (OpenCode)     | part delta before message       | item.delta             | If part arrives first, create item.started stub then delta     |
+------------------------------+------------------------+--------------------------+--------------------------------------------------------------+

Delta handling

- Codex emits agent message and other deltas (e.g., item/agentMessage/delta).
- OpenCode emits part deltas via message.part.updated with a delta string.
- Claude and Amp do not emit deltas in their schemas.

Policy:
- Always emit item.delta across all providers.
- For providers without native deltas, emit a single synthetic delta containing the full content prior to item.completed.
- For providers with native deltas, forward as-is; also emit item.completed when final content is known.

Message normalization notes

- user vs assistant: normalized via role in the universal item; provider role fields or item types determine role.
- file artifacts: always represented as content parts (type=file_ref) inside message/tool_result items, not a separate item kind.
- reasoning: represented as content parts (type=reasoning) inside message items, with visibility when available.
- subagents: OpenCode subtask parts and Claude Task tool usage are currently normalized into standard message/tool flow (no dedicated subagent fields).
- OpenCode unrolling: message.updated creates/updates the parent message item; tool-related parts emit separate tool item events (item.started/ item.completed) with parent_id pointing to the message item.
- If a message.part.updated arrives before message.updated, we create a stub item.started (source=daemon) so deltas have a parent.
- Tool calls/results are always emitted as separate tool items to keep behavior consistent across agents.
