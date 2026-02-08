# Proposal: UI Library (useChat-style)

## Summary
This proposes a component library modeled after Vercel AI SDK `useChat` and TanStack AI `useChat`, adapted to Sandbox Agent's universal event stream and HITL flows. The plan is headless-first, with React bindings and optional UI components.

## References Reviewed
- Vercel AI SDK `useChat` API docs (transport-based, UIMessage parts, tool outputs).
- TanStack AI `useChat` source (`packages/typescript/ai-react/src/use-chat.ts`) and types.

## Observations (Patterns to Copy)
- Headless core + framework bindings.
- Transport/connection abstraction; default transport with overrides.
- Hook owns message state, status, and error; returns imperative helpers.
- Message model is part-based (text, tool call/result, status, media, etc.).
- Tool/HITL outputs are first-class actions.

## Proposal

### Package Structure
1) `@sandbox-agent/ui-core`
   - Event to UI reducers.
   - Derive `UIMessage[]` with parts from universal events.
   - Shared types for message parts, permissions, questions, and status.

2) `@sandbox-agent/ui-react`
   - `useChat` hook on top of core store.
   - Stable API shape inspired by Vercel/TanStack.

3) `@sandbox-agent/ui-components` (optional)
   - Composable UI primitives that render content parts.
   - HITL UI components (permission and question prompts).

4) `@sandbox-agent/ui-transports`
   - `sdkTransport(client)` using the TypeScript SDK.
   - `sseTransport({ baseUrl, token })` for bare HTTP/SSE.
   - `turnTransport` for send + stream in one call.

### Message Model
`UIMessage { id, role, status, parts[] }`

`parts[]` includes:
- `text`
- `tool_call`
- `tool_result`
- `file_ref` (diffs, actions)
- `status`
- `reasoning`
- `image`

This aligns with `docs/building-chat-ui.mdx` and Vercel's `UIMessage.parts` concept.

### Headless Core API (Sketch)
```ts
type ChatTransport = {
  sendMessage: (sessionId: string, input: string) => Promise<void>
  streamEvents: (sessionId: string, opts: { offset: number }) => AsyncIterable<UniversalEvent>
  replyPermission: (sessionId: string, id: string, reply: "once" | "always" | "reject") => Promise<void>
  replyQuestion: (sessionId: string, id: string, answers: string[][]) => Promise<void>
  rejectQuestion: (sessionId: string, id: string) => Promise<void>
  terminate: (sessionId: string) => Promise<void>
}

type ChatStore = {
  state: ChatState
  applyEvent: (event: UniversalEvent) => void
  subscribe: (listener: () => void) => () => void
}

createChatStore({ transport, sessionId, initialEvents? })
```

### React Hook API (Sketch)
```ts
const {
  messages,
  status,
  error,
  isLoading,
  sendMessage,
  stop,
  resume,
  clear,
  reloadLast,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  addToolOutput,
} = useChat({ sessionId, transport, initialMessages })
```

Notes:
- Status should map to: `ready | submitted | streaming | error` (Vercel-style).
- `addToolOutput` is optional and only relevant when tools complete on the client.

### UI Components (Optional)
- `MessagePartRenderer` with render props.
- `ToolCall`, `ToolResult`, `FileDiff`, `StatusChip`, `Reasoning`, `ImagePart`.
- `PermissionRequest`, `QuestionPrompt`.

## Why This Fits Sandbox Agent
- Universal event stream already defines the canonical state.
- HITL flows (permissions/questions) map directly to hook actions and components.
- Inspector is a reference implementation; reducers can be extracted from it.

## Adoption Path
1) Extract event reducers from Inspector into `@sandbox-agent/ui-core`.
2) Implement `useChat` in `@sandbox-agent/ui-react` using a store and transport.
3) Add UI components for content parts + HITL.
4) Update `docs/building-chat-ui.mdx` with the new package usage.
