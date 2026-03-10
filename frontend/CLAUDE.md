# Frontend Instructions

## Inspector Architecture

- Inspector source is `frontend/packages/inspector/`.
- `/ui/` must use ACP over HTTP (`/v2/rpc`) for session/prompt traffic.
- Primary flow:
  - `initialize`
  - `session/new`
  - `session/prompt`
  - `session/update` over SSE
- Keep backend/protocol changes in client bindings; avoid unnecessary full UI rewrites.

## Testing

Run inspector checks after transport or chat-flow changes:
```bash
pnpm --filter @sandbox-agent/inspector test
pnpm --filter @sandbox-agent/inspector test:agent-browser
```

## Docs Sync

- Update `docs/inspector.mdx` when `/ui/` behavior changes.
- Update `docs/sdks/typescript.mdx` when inspector SDK bindings or ACP transport behavior changes.

