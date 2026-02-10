# Instructions

## ACP v2 Baseline

- v2 is ACP-native.
- `/v1/*` is removed and returns `410 Gone` (`application/problem+json`).
- `/opencode/*` is disabled during ACP core phases and returns `503`.
- Prompt/session traffic is ACP JSON-RPC over streamable HTTP on `/v2/rpc`:
  - `POST /v2/rpc`
  - `GET /v2/rpc` (SSE)
  - `DELETE /v2/rpc`
- Control-plane endpoints:
  - `GET /v2/health`
  - `GET /v2/agents`
  - `POST /v2/agents/{agent}/install`
- Binary filesystem transfer endpoints (intentionally HTTP, not ACP extension methods):
  - `GET /v2/fs/file`
  - `PUT /v2/fs/file`
  - `POST /v2/fs/upload-batch`
- Sandbox Agent ACP extension method naming:
  - Custom ACP methods use `_sandboxagent/...` (not `_sandboxagent/v2/...`).
  - Session detach method is `_sandboxagent/session/detach`.

## API Scope

- ACP is the primary protocol for agent/session behavior and all functionality that talks directly to the agent.
- ACP extensions may be used for gaps (for example `skills`, `models`, and related metadata), but the default is that agent-facing behavior is implemented by the agent through ACP.
- Custom HTTP APIs are for non-agent/session platform services (for example filesystem, terminals, and other host/runtime capabilities).
- Filesystem and terminal APIs remain Sandbox Agent-specific HTTP contracts and are not ACP.
- Keep `GET /v2/fs/file`, `PUT /v2/fs/file`, and `POST /v2/fs/upload-batch` on HTTP:
  - These are Sandbox Agent host/runtime operations with cross-agent-consistent behavior.
  - They may involve very large binary transfers that ACP JSON-RPC envelopes are not suited to stream.
  - This is intentionally separate from ACP native `fs/read_text_file` and `fs/write_text_file`.
  - ACP extension variants may exist in parallel, but SDK defaults should prefer HTTP for these binary transfer operations.

## Naming and Ownership

- This repository/product is **Sandbox Agent**.
- **Gigacode** is a separate user-facing UI/client, not the server product name.
- Gigacode integrates with Sandbox Agent via the OpenCode-compatible surface (`/opencode/*`) when that compatibility layer is enabled.
- Canonical extension namespace/domain string is `sandboxagent.dev` (no hyphen).
- Canonical custom ACP extension method prefix is `_sandboxagent/...` (no hyphen).

## Architecture (Brief)

- HTTP contract and problem/error mapping: `server/packages/sandbox-agent/src/router.rs`
- ACP client runtime and agent process bridge: `server/packages/sandbox-agent/src/acp_runtime/mod.rs`
- Agent/native + ACP agent process install and lazy install: `server/packages/agent-management/`
- Inspector UI served at `/ui/` and bound to ACP over HTTP from `frontend/packages/inspector/`

## TypeScript SDK Architecture

- TypeScript clients are split into:
  - `acp-http-client`: protocol-pure ACP-over-HTTP (`/v2/rpc`) with no Sandbox-specific metadata/extensions.
  - `sandbox-agent`: `SandboxAgentClient` wrapper that adds Sandbox metadata/extension helpers and keeps non-ACP HTTP helpers.
- `SandboxAgentClient` constructor is `new SandboxAgentClient(...)`.
- `SandboxAgentClient` auto-connects by default; `autoConnect: false` requires explicit `.connect()`.
- ACP/session methods must throw when disconnected (`NotConnectedError`), and `.connect()` must throw when already connected (`AlreadyConnectedError`).
- A `SandboxAgentClient` instance may have at most one active ACP connection at a time.
- Stable ACP session method names should stay ACP-aligned in the Sandbox wrapper (`newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `setSessionConfigOption`).
- Sandbox extension methods are first-class wrapper helpers (`listModels`, `setMetadata`, `detachSession`, `terminateSession`).

## Source Documents

- `~/misc/acp-docs/schema/schema.json`
- `~/misc/acp-docs/schema/meta.json`
- `research/acp/spec.md`
- `research/acp/v1-schema-to-acp-mapping.md`
- `research/acp/friction.md`
- `research/acp/todo.md`

## Change Tracking

- Keep CLI subcommands and HTTP endpoints in sync.
- Update `docs/cli.mdx` when CLI behavior changes.
- Regenerate `docs/openapi.json` when HTTP contracts change.
- Keep `docs/inspector.mdx` and `docs/sdks/typescript.mdx` aligned with implementation.
- Append blockers/decisions to `research/acp/friction.md` during ACP work.
- TypeScript SDK tests should run against a real running server/runtime over real `/v2` HTTP APIs, typically using the real `mock` agent for deterministic behavior.
- Do not use Vitest fetch/transport mocks to simulate server functionality in TypeScript SDK tests.
