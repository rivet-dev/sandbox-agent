# TODO (from spec.md)

## Universal API + Types
- [x] Define universal base types for agent input/output (common denominator across schemas)
- [x] Add universal question + permission types (HITL) and ensure they are supported end-to-end
- [x] Define `UniversalEvent` + `UniversalEventData` union and `AgentError` shape
- [x] Define a universal message type for "failed to parse" with raw JSON payload
- [x] Implement 2-way converters:
  - [x] Universal input message <-> agent-specific input
  - [x] Universal event <-> agent-specific event
- [x] Normalize Claude system/init events into universal started events
- [x] Support Codex CLI type-based event format in universal converter
- [x] Enforce agentMode vs permissionMode semantics + defaults at the API boundary
- [x] Ensure session id vs agentSessionId semantics are respected and surfaced consistently

## Daemon (Rust HTTP server)
- [x] Build axum router + utoipa + schemars integration
- [x] Implement RFC 7807 Problem Details error responses backed by a `thiserror` enum
- [x] Implement canonical error `type` values + required error variants from spec
- [x] Implement offset semantics for events (exclusive last-seen id, default offset 0)
- [x] Implement SSE endpoint for events with same semantics as JSON endpoint
- [x] Replace in-memory session store with sandbox session manager (questions/permissions routing, long-lived processes)
- [x] Remove legacy token header support
- [x] Embed inspector frontend and serve it at `/ui`
- [x] Log inspector URL when starting the HTTP server

## CLI
- [x] Implement clap CLI flags: `--token`, `--no-token`, `--host`, `--port`, CORS flags
- [x] Implement a CLI endpoint for every HTTP endpoint
- [x] Update `CLAUDE.md` to keep CLI endpoints in sync with HTTP API changes
- [x] Prefix CLI API requests with `/v1`
- [x] Add CLI credentials extractor subcommand
- [x] Move daemon startup to `server` subcommand
- [x] Add `sandbox-daemon` CLI alias

## HTTP API Endpoints
- [x] POST `/agents/{}/install` with `reinstall` handling
- [x] GET `/agents/{}/modes` (mode discovery or hardcoded)
- [x] GET `/agents` (installed/version/path; version checked at request time)
- [x] POST `/sessions/{}` (create session, install if needed, return health + agentSessionId)
- [x] POST `/sessions/{}/messages` (send prompt)
- [x] GET `/sessions/{}/events` (pagination with offset/limit)
- [x] GET `/sessions/{}/events/sse` (streaming)
- [x] POST `/sessions/{}/questions/{questionId}/reply`
- [x] POST `/sessions/{}/questions/{questionId}/reject`
- [x] POST `/sessions/{}/permissions/{permissionId}/reply`
- [x] Prefix all HTTP API endpoints with `/v1`

## Agent Management
- [x] Implement install/version/spawn basics for Claude/Codex/OpenCode/Amp
- [x] Implement agent install URL patterns + platform mappings for supported OS/arch
- [x] Parse JSONL output for subprocess agents and extract session/result metadata
- [x] Migrate Codex subprocess to App Server JSON-RPC protocol
- [x] Map permissionMode to agent CLI flags (Claude/Codex/Amp)
- [x] Implement session resume flags for Claude/OpenCode/Amp (Codex unsupported)
- [x] Replace sandbox-agent core agent modules with new agent-management crate (delete originals)
- [x] Stabilize agent-management crate API and fix build issues (sandbox-agent currently wired to WIP crate)
- [x] Implement OpenCode shared server lifecycle (`opencode serve`, health, restart)
- [x] Implement OpenCode HTTP session APIs + SSE event stream integration
- [x] Implement JSONL parsing for subprocess agents and map to `UniversalEvent`
- [x] Capture agent session id from events and expose as `agentSessionId`
- [x] Handle agent process exit and map to `agent_process_exited` error
- [x] Implement agentMode discovery rules (OpenCode API, hardcoded others)
- [x] Enforce permissionMode behavior (default/plan/bypass) for subprocesses

## Credentials
- [x] Implement credential extraction module (Claude/Codex/OpenCode)
- [x] Add Amp credential extraction (config-based)
- [x] Move credential extraction into `agent-credentials` crate
- [ ] Pass extracted credentials into subprocess env vars per agent
- [ ] Ensure OpenCode server reads credentials from config on startup

## Testing
- [ ] Build a universal agent test suite that exercises all features (messages, questions, permissions, etc.) using HTTP API
- [ ] Run the full suite against every agent (Claude/Codex/OpenCode/Amp) without mocks
- [x] Add real install/version/spawn tests for Claude/Codex/OpenCode (Amp conditional)
- [x] Expand agent lifecycle tests (reinstall, session id extraction, resume, plan mode)
- [x] Add OpenCode server-mode tests (session create, prompt, SSE)
- [ ] Add tests for question/permission flows using deterministic prompts
- [x] Add HTTP/SSE snapshot tests for real agents (env-configured)
- [x] Add snapshot coverage for auth, CORS, and concurrent sessions
- [x] Add inspector UI route test

## Frontend (frontend/packages/inspector)
- [x] Build Vite + React app with connect screen (endpoint + optional token)
- [x] Add instructions to run sandbox-agent (including CORS)
- [x] Implement full agent UI covering all features
- [x] Add HTTP request log with copyable curl command
- [x] Add Content-Type header to CORS callout command
- [x] Default inspector endpoint to current origin and auto-connect via health check
- [x] Update inspector to universal schema events (items, deltas, approvals, errors)

## TypeScript SDK
- [x] Generate OpenAPI from utoipa and run `openapi-typescript`
- [x] Implement a thin fetch-based client wrapper
- [x] Update `CLAUDE.md` to require SDK + CLI updates when API changes
- [x] Prefix SDK requests with `/v1`

## Examples + Tests
- [ ] Add examples for Docker, E2B, Daytona, Vercel Sandboxes, Cloudflare Sandboxes
- [ ] Add Vitest unit test for each example (Cloudflare requires special setup)

## Documentation
- [ ] Write README covering architecture, agent compatibility, and deployment guide
- [ ] Add universal API feature checklist (questions, approve plan, etc.)
- [ ] Document CLI, HTTP API, frontend app, and TypeScript SDK usage
- [ ] Use collapsible sections for endpoints and SDK methods
- [x] Integrate OpenAPI spec with Mintlify (docs/openapi.json + validation)

---

- [x] implement release pipeline
- implement e2b example
- implement typescript "start locally" by pulling form server using version
- [x] Move agent schema sources to src/agents
- [x] Add Vercel AI SDK UIMessage schema extractor
