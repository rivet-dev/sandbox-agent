# Project Instructions

## Breaking Changes

Do not preserve legacy compatibility. Implement the best current architecture, even if breaking.

## Language Policy

Use TypeScript for all source code.

- Never add raw JavaScript source files (`.js`, `.mjs`, `.cjs`).
- Prefer `.ts`/`.tsx` for runtime code, scripts, tests, and tooling.
- If touching old JavaScript, migrate it to TypeScript instead of extending it.

## Monorepo + Tooling

Use `pnpm` workspaces and Turborepo.

- Workspace root uses `pnpm-workspace.yaml` and `turbo.json`.
- Packages live in `packages/*`.
- `core` is renamed to `shared`.
- Integrations and providers live under `packages/backend/src/{integrations,providers}`.

## Product Surface

- The old CLI package has been removed.
- Frontend is the primary product surface; prioritize `packages/frontend` + supporting `packages/client`/`packages/backend`.

## Dev Server Policy

**Always use Docker Compose to run dev servers.** Do not start the backend, frontend, or any other long-running service directly via `bun`, `pnpm dev`, Vite, or tmux. All dev services must run through the Compose stack so that networking, environment variables, and service dependencies are consistent.

- Start the full dev stack (real backend): `just foundry-dev`
- Stop the dev stack: `just foundry-dev-down`
- Tail dev logs: `just foundry-dev-logs`
- Start the mock dev stack (frontend-only, no backend): `just foundry-dev-mock`
- Stop the mock stack: `just foundry-dev-mock-down`
- Tail mock logs: `just foundry-dev-mock-logs`
- Start the production-build preview stack: `just foundry-preview`
- Stop the preview stack: `just foundry-preview-down`
- Tail preview logs: `just foundry-preview-logs`

The real dev server runs on port 4173 (frontend) + 7741 (backend). The mock dev server runs on port 4174 (frontend only). Both can run simultaneously.

When making code changes, restart or recreate the relevant Compose services so the running app reflects the latest code (e.g. `docker compose -f foundry/compose.dev.yaml up -d --build backend`).

## Mock vs Real Backend — UI Change Policy

**When a user asks to make a UI change, always ask whether they are testing against the real backend or the mock backend before proceeding.**

- **Mock backend** (`compose.mock.yaml`, port 4174):
  - Only modify `packages/frontend`, `packages/client/src/mock/` (mock client implementation), and `packages/shared` (shared types/contracts).
  - Ignore typecheck/build errors in the real client (`packages/client/src/remote/`) and backend (`packages/backend`).
  - The assumption is that the mock server is the only test target; real backend compatibility is out of scope for that change.
- **Real backend** (`compose.dev.yaml`, port 4173):
  - All layers must be kept in sync: `packages/frontend`, `packages/client` (both mock and remote), `packages/shared`, and `packages/backend`.
  - All typecheck, build, and test errors must be resolved across the full stack.

## Common Commands

- Install deps: `pnpm install`
- Full active-workspace validation: `pnpm -w typecheck`, `pnpm -w build`, `pnpm -w test`
- Start the frontend against the mock workbench client (no backend needed): `FOUNDRY_FRONTEND_CLIENT_MODE=mock pnpm --filter @sandbox-agent/foundry-frontend dev`

## Loading & Skeleton UI Policy

- Never show a blank or hanging screen while data loads. Every view transition must render an immediate skeleton placeholder.
- When the workspace loads for the first time (remote client starts with an empty snapshot), show a full-page skeleton: sidebar skeletons, transcript skeleton, and right sidebar skeleton.
- When switching handoffs, show skeleton placeholders in the transcript and right sidebar while the new handoff data resolves.
- When adding a new agent tab, show a skeleton message area immediately instead of an empty void.
- Use the shared `SkeletonLine` / `SkeletonBlock` / `SkeletonCircle` primitives from `components/mock-layout/skeleton.tsx`.
- Skeleton styles use CSS `@keyframes hf-shimmer` (a left-to-right gradient sweep) on a neutral background.
- Do not use spinner-only loading indicators for layout transitions. Spinners are reserved for inline status (e.g. "agent is thinking").

## Frontend + Client Boundary

- Keep a browser-friendly GUI implementation aligned with the TUI interaction model wherever possible.
- Do not import `rivetkit` directly in UI packages. RivetKit client access must stay isolated inside `packages/client`.
- All backend interaction (actor calls, metadata/health checks, backend HTTP endpoint access) must go through the dedicated client library in `packages/client`.
- Outside `packages/client`, do not call backend endpoints directly (for example `fetch(.../api/rivet...)`), except in black-box E2E tests that intentionally exercise raw transport behavior.
- GUI state should update in realtime (no manual refresh buttons). Prefer RivetKit push reactivity and actor-driven events; do not add polling/refetch for normal product flows.
- Keep the mock workbench types and mock client in `packages/shared` + `packages/client` up to date with the frontend contract. The mock is the UI testing reference implementation while backend functionality catches up.
- Keep frontend route/state coverage current in code and tests; there is no separate page-inventory doc to maintain.
- When making UI changes, verify the live flow with `agent-browser`, take screenshots of the updated UI, and offer to open those screenshots in Preview when you finish.
- When asked for screenshots, capture all relevant affected screens and modal states, not just a single viewport. Include empty, populated, success, and blocked/error states when they are part of the changed flow.
- If a screenshot catches a transition frame, blank modal, or otherwise misleading state, retake it before reporting it.

## Runtime Policy

- Runtime is Bun-native.
- Use Bun for backend execution paths and process spawning.
- Do not add Node compatibility fallbacks for removed CLI/OpenTUI paths.

## Defensive Error Handling

- Write code defensively: validate assumptions at boundaries and state transitions.
- If the system reaches an unexpected state, raise an explicit error with actionable context.
- Do not fail silently, swallow errors, or auto-ignore inconsistent data.
- Prefer fail-fast behavior over hidden degradation when correctness is uncertain.

## RivetKit Dependency Policy

For all Rivet/RivetKit implementation:

1. Use SQLite + Drizzle for persistent state.
2. SQLite is **per actor instance** (per actor key), not a shared backend-global database:
   - Each actor instance gets its own SQLite DB.
   - Schema design should assume a single actor instance owns the entire DB.
   - Do not add `workspaceId`/`repoId`/`handoffId` columns just to "namespace" rows for a given actor instance; use actor state and/or the actor key instead.
   - Example: the `handoff` actor instance already represents `(workspaceId, repoId, handoffId)`, so its SQLite tables should not need those columns for primary keys.
3. Do not use backend-global SQLite singletons; database access must go through actor `db` providers (`c.db`).
4. Use RivetKit's actor-managed SQLite only. Do not implement custom SQLite providers or direct SQLite bindings for Foundry actor persistence.
   - Never use `bun:sqlite`, `node:sqlite`, `better-sqlite3`, `drizzle-orm/bun-sqlite`, or any custom file-backed SQLite adapter for actor state.
   - Foundry must not create host-visible actor DB files such as `.sandbox-agent-foundry/backend/sqlite/**/*.sqlite`.
   - If an actor needs relational persistence, wire it through RivetKit's `db`/`c.db` path only.
5. Use published RivetKit npm packages (`"rivetkit": "2.1.6"` by default). Do not use `link:` dependencies pointing outside the workspace unless you are doing a temporary local RivetKit debugging pass.
6. Temporary local relink is allowed only when actively debugging RivetKit against the local checkout at `/Users/nathan/conductor/workspaces/handoff/rivet-checkout`.
   - Preferred link target: `../rivet-checkout/rivetkit-typescript/packages/rivetkit`
   - Before using the local checkout, build RivetKit from that repo so the linked package has fresh output.
   - After the debugging pass, switch dependencies back to the published package version.

## Inspector HTTP API (Workflow Debugging)

- The Inspector HTTP routes come from RivetKit `feat: inspector http api (#4144)` and are served from the RivetKit manager endpoint (not `/api/rivet`).
- Resolve manager endpoint from backend metadata:
  ```bash
  curl -sS http://127.0.0.1:7741/api/rivet/metadata | jq -r '.clientEndpoint'
  ```
- List actors:
  - `GET {manager}/actors?name=handoff`
- Inspector endpoints (path prefix: `/gateway/{actorId}/inspector`):
  - `GET /state`
  - `PATCH /state`
  - `GET /connections`
  - `GET /rpcs`
  - `POST /action/{name}`
  - `GET /queue?limit=50`
  - `GET /traces?startMs=0&endMs=<ms>&limit=1000`
  - `GET /workflow-history`
  - `GET /summary`
- Auth:
  - Production: send `Authorization: Bearer $RIVET_INSPECTOR_TOKEN`.
  - Development: auth can be skipped when no inspector token is configured.
- Handoff workflow quick inspect:
  ```bash
  MGR="$(curl -sS http://127.0.0.1:7741/api/rivet/metadata | jq -r '.clientEndpoint')"
  HID="7df7656e-bbd2-4b8c-bf0f-30d4df2f619a"
  AID="$(curl -sS "$MGR/actors?name=handoff" \
    | jq -r --arg hid "$HID" '.actors[] | select(.key | endswith("/handoff/\($hid)")) | .actor_id' \
    | head -n1)"
  curl -sS "$MGR/gateway/$AID/inspector/workflow-history" | jq .
  curl -sS "$MGR/gateway/$AID/inspector/summary" | jq .
  ```
- If inspector routes return `404 Not Found (RivetKit)`, the running backend is on a RivetKit build that predates `#4144`; rebuild linked RivetKit and restart backend.

## Workspace + Actor Rules

- Everything is scoped to a workspace.
- All durable Foundry data must live inside actors.
- App-shell/auth/session/org/billing data is actor-owned data too; do not introduce backend-global stores for it.
- Do not add standalone SQLite files, JSON stores, in-memory singleton stores, or any other non-actor persistence for Foundry product state.
- Do not add custom Bun/Node SQLite storage layers for actor data. Actor SQL persistence must stay inside RivetKit-managed actor DBs only.
- If data needs durable persistence, store it in actor `c.state` or the owning actor's SQLite DB via `c.db`.
- Workspace resolution order: `--workspace` flag -> config default -> `"default"`.
- `ControlPlaneActor` is replaced by `WorkspaceActor` (workspace coordinator).
- Every actor key must be prefixed with workspace namespace (`["ws", workspaceId, ...]`).
- Product surfaces must use `@sandbox-agent/foundry-client` (`packages/client`) for backend access; `rivetkit/client` imports are only allowed inside `packages/client`.
- Do not add custom backend REST endpoints (no `/v1/*` shim layer).
- We own the sandbox-agent project; treat sandbox-agent defects as first-party bugs and fix them instead of working around them.
- Keep strict single-writer ownership: each table/row has exactly one actor writer.
- Parent actors (`workspace`, `project`, `handoff`, `history`, `sandbox-instance`) use command-only loops with no timeout.
- Periodic syncing lives in dedicated child actors with one timeout cadence each.
- Actor handle policy:
- Prefer explicit `get` or explicit `create` based on workflow intent; do not default to `getOrCreate`.
- Use `get`/`getForId` when the actor is expected to already exist; if missing, surface an explicit `Actor not found` error with recovery context.
- Use create semantics only on explicit provisioning/create paths where creating a new actor instance is intended.
- `getOrCreate` is a last resort for create paths when an explicit create API is unavailable; never use it in read/command paths.
- For long-lived cross-actor links (for example sandbox/session runtime access), persist actor identity (`actorId`) and keep a fallback lookup path by actor id.
- Docker dev: `compose.dev.yaml` mounts a named volume at `/root/.local/share/sandbox-agent-foundry/repos` to persist backend-managed git clones across restarts. Code must still work if this volume is not present (create directories as needed).
- RivetKit actor `c.state` is durable, but in Docker it is stored under `/root/.local/share/rivetkit`. If that path is not persisted, actor state-derived indexes (for example, in `project` actor state) can be lost after container recreation even when other data still exists.
- Workflow history divergence policy:
- Production: never auto-delete actor state to resolve `HistoryDivergedError`; ship explicit workflow migrations (`ctx.removed(...)`, step compatibility).
- Development: manual local state reset is allowed as an operator recovery path when migrations are not yet available.
- Storage rule of thumb:
- Put simple metadata in `c.state` (KV state): small scalars and identifiers like `{ handoffId }`, `{ repoId }`, booleans, counters, timestamps, status strings.
- If it grows beyond trivial (arrays, maps, histories, query/filter needs, relational consistency), use SQLite + Drizzle in `c.db`.

## Testing Policy

- Never use vitest mocks (`vi.mock`, `vi.spyOn`, `vi.fn`). Instead, define driver interfaces for external I/O and pass test implementations via the actor runtime context.
- All external service calls (git CLI, GitHub CLI, sandbox-agent HTTP, tmux) must go through the `BackendDriver` interface on the runtime context.
- Integration tests use `setupTest()` from `rivetkit/test` and are gated behind `HF_ENABLE_ACTOR_INTEGRATION_TESTS=1`.
- End-to-end testing must run against the dev backend started via `docker compose -f compose.dev.yaml up` (host -> container). Do not run E2E against an in-process test runtime.
  - E2E tests should talk to the backend over HTTP (default `http://127.0.0.1:7741/api/rivet`) and use real GitHub repos/PRs.
  - Secrets (e.g. `OPENAI_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`) must be provided via environment variables, never hardcoded in the repo.
- Treat client E2E tests in `packages/client/test` as the primary end-to-end source of truth for product behavior.
- Keep backend tests small and targeted. Only retain backend-only tests for invariants or persistence rules that are not well-covered through client E2E.
- Do not keep large browser E2E suites around in a broken state. If a frontend browser E2E is not maintained and producing signal, remove it until it can be replaced with a reliable test.

## Config

- Keep config path at `~/.config/sandbox-agent-foundry/config.toml`.
- Evolve properties in place; do not move config location.

## Project Guidance

Project-specific guidance lives in `README.md`, `CONTRIBUTING.md`, and the relevant files under `research/`.

Keep those updated when:

- Commands change
- Configuration options change
- Architecture changes
- Plugins/providers change
- Actor ownership changes

## Friction Logs

Track friction at:

- `research/friction/rivet.mdx`
- `research/friction/sandbox-agent.mdx`
- `research/friction/sandboxes.mdx`
- `research/friction/general.mdx`

Category mapping:

- `rivet`: Rivet/RivetKit runtime, actor model, queues, keys
- `sandbox-agent`: sandbox-agent SDK/API behavior
- `sandboxes`: provider implementations (worktree/daytona/etc)
- `general`: everything else

Each entry must include:

- Date (`YYYY-MM-DD`)
- Commit SHA (or `uncommitted`)
- What you were implementing
- Friction/issue
- Attempted fix/workaround and outcome

## History Events

Log notable workflow changes to `events` so `hf history` remains complete:

- create
- attach
- push/sync/merge
- archive/kill
- status transitions
- PR state transitions

## Validation After Changes

Always run and fix failures:

```bash
pnpm -w typecheck
pnpm -w build
pnpm -w test
```

After making code changes, always update the dev server before declaring the work complete. Restart or recreate the relevant Docker Compose services so the running app reflects the latest code. Do not run dev servers outside of Docker Compose.
