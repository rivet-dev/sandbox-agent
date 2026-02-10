# Server Instructions

## ACP v2 Architecture

- Public API routes are defined in `server/packages/sandbox-agent/src/router.rs`.
- ACP runtime/process bridge is in `server/packages/sandbox-agent/src/acp_runtime.rs`.
- `/v2` is the only active API surface for sessions/prompts (`/v2/rpc`).
- Keep binary filesystem transfer endpoints as dedicated HTTP APIs:
  - `GET /v2/fs/file`
  - `PUT /v2/fs/file`
  - `POST /v2/fs/upload-batch`
  - Rationale: host-owned cross-agent-consistent behavior and large binary transfer needs that ACP JSON-RPC is not suited to stream efficiently.
  - Maintain ACP variants in parallel only when they share the same underlying filesystem implementation; SDK defaults should still prefer HTTP for large/binary transfers.
- `/v1/*` must remain hard-removed (`410`) and `/opencode/*` stays disabled (`503`) until Phase 7.
- Agent install logic (native + ACP agent process + lazy install) is handled by `server/packages/agent-management/`.

## API Contract Rules

- Every `#[utoipa::path(...)]` handler needs a summary line + description lines in its doc comment.
- Every `responses(...)` entry must include `description`.
- Regenerate `docs/openapi.json` after endpoint contract changes.
- Keep CLI and HTTP endpoint behavior aligned (`docs/cli.mdx`).

## Tests

Primary v2 integration coverage:
- `server/packages/sandbox-agent/tests/v2_api.rs`
- `server/packages/sandbox-agent/tests/v2_agent_process_matrix.rs`

Run:
```bash
cargo test -p sandbox-agent --test v2_api
cargo test -p sandbox-agent --test v2_agent_process_matrix
```

## Migration Docs Sync

- Keep `research/acp/spec.md` as the source spec.
- Update `research/acp/todo.md` when scope/status changes.
- Log blockers/decisions in `research/acp/friction.md`.
