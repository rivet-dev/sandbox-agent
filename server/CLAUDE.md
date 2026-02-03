# Server

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation covering the daemon, agent schema pipeline, session management, agent execution patterns, and SDK modes.

# Server Testing

## Test placement

Place all new tests under `server/packages/**/tests/` (or a package-specific `tests/` folder). Avoid inline tests inside source files unless there is no viable alternative.

## Test locations (overview)

- Sandbox-agent integration tests live under `server/packages/sandbox-agent/tests/`:
  - Agent flow coverage in `agent-flows/`
  - Agent management coverage in `agent-management/`
  - Shared server manager coverage in `server-manager/`
  - HTTP endpoint snapshots in `http/` (snapshots in `http/snapshots/`)
- Session feature coverage snapshots in `sessions/` (one file per feature, e.g. `session_lifecycle.rs`, `permissions.rs`, `questions.rs`, `reasoning.rs`, `status.rs`; snapshots in `sessions/snapshots/`)
  - UI coverage in `ui/`
  - Shared helpers in `common/`
- Extracted agent schema roundtrip tests live under `server/packages/extracted-agent-schemas/tests/`

## Snapshot tests

HTTP endpoint snapshot entrypoint:
- `server/packages/sandbox-agent/tests/http_endpoints.rs`

Session snapshot entrypoint:
- `server/packages/sandbox-agent/tests/sessions.rs`

Snapshots are written to:
- `server/packages/sandbox-agent/tests/http/snapshots/` (HTTP endpoint snapshots)
- `server/packages/sandbox-agent/tests/sessions/snapshots/` (session/feature coverage snapshots)

## Agent selection

`SANDBOX_TEST_AGENTS` controls which agents run. It accepts a comma-separated list or `all`.
If it is **not set**, tests will auto-detect installed agents by checking:
- binaries on `PATH`, and
- the default install dir (`$XDG_DATA_HOME/sandbox-agent/bin` or `./.sandbox-agent/bin`)

If no agents are found, tests fail with a clear error.

## Credential handling

Credentials are pulled from the host by default via `extract_all_credentials`:
- environment variables (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
- local CLI configs (Claude/Codex/Amp/OpenCode)

You can override host credentials for tests with:
- `SANDBOX_TEST_ANTHROPIC_API_KEY`
- `SANDBOX_TEST_OPENAI_API_KEY`

If `SANDBOX_TEST_AGENTS` includes an agent that requires a provider credential and it is missing,
tests fail before starting.

## Credential health checks

Before running agent tests, credentials are validated with minimal API calls:
- Anthropic: `GET https://api.anthropic.com/v1/models`
  - `x-api-key` for API keys
  - `Authorization: Bearer` for OAuth tokens
  - `anthropic-version: 2023-06-01`
- OpenAI: `GET https://api.openai.com/v1/models` with `Authorization: Bearer`

401/403 yields a hard failure (`invalid credentials`). Other non-2xx responses or network
errors fail with a health-check error.

Health checks run in a blocking thread to avoid Tokio runtime drop errors inside async tests.

## Snapshot stability

To keep snapshots deterministic:
- Use the mock agent as the **master** event sequence; all other agents must match its behavior 1:1.
- Snapshots should compare a **canonical event skeleton** (event order matters) with strict ordering across:
  - `item.started` → `item.delta` → `item.completed`
  - presence/absence of `session.ended`
  - permission/question request and resolution flows
- Scrub non-deterministic fields from snapshots:
  - IDs, timestamps, native IDs
  - text content, tool inputs/outputs, provider-specific metadata
  - `source` and `synthetic` flags (these are implementation details)
- Scrub `reasoning` and `status` content from session-baseline snapshots to keep the core event skeleton consistent across agents; validate those content types separately in their feature-coverage-specific tests.
- The sandbox-agent is responsible for emitting **synthetic events** so that real agents match the mock sequence exactly.
- Event streams are truncated after the first assistant or error event.
- Permission flow snapshots are truncated after the permission request (or first assistant) event.
- Unknown events are preserved as `kind: unknown` (raw payload in universal schema).
- Prefer snapshot-based event skeleton assertions over manual event-order assertions in tests.
- **Never update snapshots based on any agent that is not the mock agent.** The mock agent is the source of truth for snapshots; other agents must be compared against the mock snapshots without regenerating them.
- Agent-specific endpoints keep per-agent snapshots; any session-related snapshots must use the mock baseline as the single source of truth.

## Typical commands

Run only Claude session snapshots:
```
SANDBOX_TEST_AGENTS=claude cargo test -p sandbox-agent --test sessions
```

Run all detected session snapshots:
```
cargo test -p sandbox-agent --test sessions
```

Run HTTP endpoint snapshots:
```
cargo test -p sandbox-agent --test http_endpoints
```

## Universal Schema

When modifying agent conversion code in `server/packages/universal-agent-schema/src/agents/` or adding/changing properties on the universal schema, update the feature matrix in `README.md` to reflect which agents support which features.

## Feature coverage sync

When updating agent feature coverage (flags or values), keep them in sync across:
- `README.md` (feature matrix / documented support)
- server Rust implementation (`AgentCapabilities` + `agent_capabilities_for`)
- frontend feature coverage views/badges (Inspector UI)
