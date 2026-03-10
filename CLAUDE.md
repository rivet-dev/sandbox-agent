# Instructions

## ACP v1 Baseline

- v1 is ACP-native.
- `/v1/*` is removed and returns `410 Gone` (`application/problem+json`).
- `/opencode/*` is disabled during ACP core phases and returns `503`.
- Prompt/session traffic is ACP JSON-RPC over streamable HTTP on `/v1/rpc`:
  - `POST /v1/rpc`
  - `GET /v1/rpc` (SSE)
  - `DELETE /v1/rpc`
- Control-plane endpoints:
  - `GET /v1/health`
  - `GET /v1/agents`
  - `POST /v1/agents/{agent}/install`
- Binary filesystem transfer endpoints (intentionally HTTP, not ACP extension methods):
  - `GET /v1/fs/file`
  - `PUT /v1/fs/file`
  - `POST /v1/fs/upload-batch`
- Sandbox Agent ACP extension method naming:
  - Custom ACP methods use `_sandboxagent/...` (not `_sandboxagent/v1/...`).
  - Session detach method is `_sandboxagent/session/detach`.

## API Scope

- ACP is the primary protocol for agent/session behavior and all functionality that talks directly to the agent.
- ACP extensions may be used for gaps (for example `skills`, `models`, and related metadata), but the default is that agent-facing behavior is implemented by the agent through ACP.
- Custom HTTP APIs are for non-agent/session platform services (for example filesystem, terminals, and other host/runtime capabilities).
- Filesystem and terminal APIs remain Sandbox Agent-specific HTTP contracts and are not ACP.
- Keep `GET /v1/fs/file`, `PUT /v1/fs/file`, and `POST /v1/fs/upload-batch` on HTTP:
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
  - `acp-http-client`: protocol-pure ACP-over-HTTP (`/v1/acp`) with no Sandbox-specific HTTP helpers.
  - `sandbox-agent`: `SandboxAgent` SDK wrapper that combines ACP session operations with Sandbox control-plane and filesystem helpers.
- `SandboxAgent` entry points are `SandboxAgent.connect(...)` and `SandboxAgent.start(...)`.
- Stable Sandbox session methods are `createSession`, `resumeSession`, `resumeOrCreateSession`, `destroySession`, `sendSessionMethod`, and `onSessionEvent`.
- `Session` helpers are `prompt(...)`, `send(...)`, and `onEvent(...)`.
- Cleanup is `sdk.dispose()`.

### Docs Source Of Truth

- For TypeScript docs/examples, source of truth is implementation in:
  - `sdks/typescript/src/client.ts`
  - `sdks/typescript/src/index.ts`
  - `sdks/acp-http-client/src/index.ts`
- Do not document TypeScript APIs unless they are exported and implemented in those files.
- For HTTP/CLI docs/examples, source of truth is:
  - `server/packages/sandbox-agent/src/router.rs`
  - `server/packages/sandbox-agent/src/cli.rs`
- Keep docs aligned to implemented endpoints/commands only (for example ACP under `/v1/acp`, not legacy `/v1/sessions` APIs).

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
- TypeScript SDK tests should run against a real running server/runtime over real `/v1` HTTP APIs, typically using the real `mock` agent for deterministic behavior.
- Do not use Vitest fetch/transport mocks to simulate server functionality in TypeScript SDK tests.

## Docker Examples (Dev Testing)

- When manually testing bleeding-edge (unreleased) versions of sandbox-agent in `examples/`, use `SANDBOX_AGENT_DEV=1` with the Docker-based examples.
- This triggers `examples/shared/Dockerfile.dev` which builds the server binary from local source and packages it into the Docker image.
- Example: `SANDBOX_AGENT_DEV=1 pnpm --filter @sandbox-agent/example-mcp start`

## Install Version References

- Channel policy:
  - Sandbox Agent install/version references use a pinned minor channel `0.N.x` (for curl URLs and `sandbox-agent` / `@sandbox-agent/cli` npm/bun installs).
  - Gigacode install/version references use `latest` (for `@sandbox-agent/gigacode` install/run commands and `gigacode-install.*` release promotion).
  - Release promotion policy: `latest` releases must still update `latest`; when a release is `latest`, Sandbox Agent must also be promoted to the matching minor channel `0.N.x`.
- Keep every install-version reference below in sync whenever versions/channels change:
  - `README.md`
  - `docs/acp-http-client.mdx`
  - `docs/cli.mdx`
  - `docs/quickstart.mdx`
  - `docs/sdk-overview.mdx`
  - `docs/session-persistence.mdx`
  - `docs/deploy/local.mdx`
  - `docs/deploy/cloudflare.mdx`
  - `docs/deploy/vercel.mdx`
  - `docs/deploy/daytona.mdx`
  - `docs/deploy/e2b.mdx`
  - `docs/deploy/docker.mdx`
  - `frontend/packages/website/src/components/GetStarted.tsx`
  - `.claude/commands/post-release-testing.md`
  - `examples/cloudflare/Dockerfile`
  - `examples/daytona/src/index.ts`
  - `examples/daytona/src/daytona-with-snapshot.ts`
  - `examples/docker/src/index.ts`
  - `examples/e2b/src/index.ts`
  - `examples/vercel/src/index.ts`
  - `scripts/release/main.ts`
  - `scripts/release/promote-artifacts.ts`
  - `scripts/release/sdk.ts`
  - `scripts/sandbox-testing/test-sandbox.ts`
