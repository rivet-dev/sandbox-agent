# Instructions

## SDK Modes

There are two ways to work with the SDKs:

- **Embedded**: Spawns the `sandbox-agent` server as a subprocess on a unique port and communicates with it locally. Useful for local development or when running the SDK and agent in the same environment.
- **Server**: Connects to a remotely running `sandbox-agent` server. The server is typically running inside a sandbox (e.g., Docker, E2B, Daytona, Vercel Sandboxes) and the SDK connects to it over HTTP.

## Agent Schemas

Agent schemas (Claude Code, Codex, OpenCode, Amp) are available for reference in `resources/agent-schemas/dist/`.

Research on how different agents operate (CLI flags, streaming formats, HITL patterns, etc.) is in `research/agents/`. When adding or making changes to agent docs, follow the same structure as existing files.

Universal schema guidance:
- The universal schema should cover the full feature set of all agents.
- Conversions must be best-effort overlap without being lossy; preserve raw payloads when needed.

## Spec Tracking

- Update `todo.md` as work progresses; add new tasks as they arise.
- Keep CLI subcommands in sync with every HTTP endpoint.
- Update `CLAUDE.md` to keep CLI endpoints in sync with HTTP API changes.
- When changing the HTTP API, update the TypeScript SDK and CLI together.
- Do not make breaking changes to API endpoints.

### CLI ⇄ HTTP endpoint map (keep in sync)

- `sandbox-agent agents list` ↔ `GET /v1/agents`
- `sandbox-agent agents install` ↔ `POST /v1/agents/{agent}/install`
- `sandbox-agent agents modes` ↔ `GET /v1/agents/{agent}/modes`
- `sandbox-agent sessions list` ↔ `GET /v1/sessions`
- `sandbox-agent sessions create` ↔ `POST /v1/sessions/{sessionId}`
- `sandbox-agent sessions send-message` ↔ `POST /v1/sessions/{sessionId}/messages`
- `sandbox-agent sessions events` / `get-messages` ↔ `GET /v1/sessions/{sessionId}/events`
- `sandbox-agent sessions events-sse` ↔ `GET /v1/sessions/{sessionId}/events/sse`
- `sandbox-agent sessions reply-question` ↔ `POST /v1/sessions/{sessionId}/questions/{questionId}/reply`
- `sandbox-agent sessions reject-question` ↔ `POST /v1/sessions/{sessionId}/questions/{questionId}/reject`
- `sandbox-agent sessions reply-permission` ↔ `POST /v1/sessions/{sessionId}/permissions/{permissionId}/reply`

### Default port references (update when CLI default changes)

- `frontend/packages/web/src/App.tsx`
- `README.md`
- `docs/cli.mdx`
- `docs/frontend.mdx`
- `docs/index.mdx`
- `docs/quickstart.mdx`
- `docs/typescript-sdk.mdx`
- `docs/deployments/cloudflare-sandboxes.mdx`
- `docs/deployments/daytona.mdx`
- `docs/deployments/docker.mdx`
- `docs/deployments/e2b.mdx`
- `docs/deployments/vercel-sandboxes.mdx`

## Git Commits

- Do not include any co-authors in commit messages (no `Co-Authored-By` lines)
- Use conventional commits style (e.g., `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)
- Keep commit messages to a single line
